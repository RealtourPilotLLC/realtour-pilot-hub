import "server-only";
import { prisma } from "@/lib/prisma";
import { getSecret } from "./connections";
import { cleanText, clip, stripQuotedReply } from "@/lib/text";
import { originOrBase } from "@/lib/appUrl";
import { fetchWithTimeout } from "@/lib/http";
import { forwardedSenderAddress, isInternalNote, messageIdKey, sameSenderName, streetMatchAllowed } from "@/lib/mailMatch";
import { isHoldingReply } from "@/lib/holdingReply";
import { isSpamDismissal } from "@/lib/triage";

// ---------------------------------------------------------------------------
// Google / Gmail integration (OAuth2 with offline refresh tokens, read-only).
// Reads recent client emails and turns them into tasks — same listener model
// as OpenPhone/Slack. Never sends. App credentials come from env; the per-user
// refresh token is stored encrypted as the "gmail" connection.
// ---------------------------------------------------------------------------

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
// ONE consent grants all of these. gmail.send has been declared here for a
// while but was never actually approved — the live tokens carry only
// gmail.readonly + userinfo.email — so the reconnect that fixes sending is the
// same reconnect that turns on the day planner's calendar blocking and the
// meeting-transcript reader. Adding scopes here changes nothing until the owner
// re-consents; `prompt=consent` in googleAuthorizeUrl then returns a fresh
// refresh token carrying the whole set.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send", // lets the hub email Jordan (e.g. new feedback)
  "https://www.googleapis.com/auth/userinfo.email",
  // My Day: read what is already on the calendar (so shoots and meetings are
  // planned around, with travel time respected) and write the time blocks back
  // onto the MAIN calendar — Calendly reads that calendar for availability, so
  // a block has to live there to actually stop a double-booking.
  "https://www.googleapis.com/auth/calendar.events",
  // Google Meet transcripts land in Drive as Docs. Read-only, and only files
  // this app is pointed at.
  "https://www.googleapis.com/auth/drive.readonly",
];

/** Which of the extra scopes a stored token actually carries, per mailbox. */
export async function googleScopeHealth(): Promise<
  { email: string; canSend: boolean | null; canCalendar: boolean | null; canDrive: boolean | null }[]
> {
  const accounts = await gmailAccounts();
  return Promise.all(
    accounts.map(async ({ email, refreshToken }) => {
      try {
        const token = await accessTokenFor(refreshToken);
        const res = await fetchWithTimeout(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`, {
          cache: "no-store",
        });
        const info = (await res.json().catch(() => ({}))) as { scope?: string };
        const s = typeof info.scope === "string" ? info.scope : null;
        return {
          email,
          canSend: s === null ? null : s.includes("gmail.send"),
          canCalendar: s === null ? null : s.includes("calendar"),
          canDrive: s === null ? null : s.includes("drive"),
        };
      } catch {
        return { email, canSend: null, canCalendar: null, canDrive: null };
      }
    }),
  );
}

// Owner's address — where platform notifications (new feedback, etc.) go.
const OWNER_EMAIL = "info@realtourpilot.com";

// Send a plain-text email from one of our connected mailboxes to the owner.
// Best-effort: returns false (never throws) if Gmail isn't connected or the
// token lacks the send scope (readonly-only until the owner reconnects Google).
export async function notifyOwnerEmail(subject: string, body: string): Promise<boolean> {
  try {
    const accounts = await gmailAccounts();
    const acct = accounts.find((a) => a.email === OWNER_EMAIL) ?? accounts[0];
    if (!acct) return false;
    const token = await accessTokenFor(acct.refreshToken);
    const mime = [
      `To: ${OWNER_EMAIL}`,
      `From: ${acct.email}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      body,
    ].join("\r\n");
    const raw = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    // 403 = the token can read but not send (scope missing) — silently
    // returning false here left every owner notification vanishing with no
    // trace (finding #41). Route it to the one person who can reconnect.
    // AWAITED (still never-throws): a floating write dies with the serverless
    // freeze right after the caller returns, silently losing the ping.
    if (res.status === 403) {
      await import("@/lib/gmailHealth")
        .then(({ reportGmailSendBroken }) => reportGmailSendBroken("owner notification: " + subject.slice(0, 60), acct.email))
        .catch(() => {});
    } else if (res.ok) {
      await import("@/lib/gmailHealth")
        .then(({ reportGmailSendWorking }) => reportGmailSendWorking(acct.email))
        .catch(() => {});
    }
    return res.ok;
  } catch {
    return false;
  }
}

// Can each connected mailbox SEND (not just read)? Checks the live token's
// granted scopes via Google's read-only tokeninfo endpoint — the stored scope
// list can lie (the user can untick send on the consent screen), the token
// can't. null = couldn't check (network/refresh failure), distinct from "no".
// Never logs or returns token values.
export async function gmailSendHealth(): Promise<Array<{ email: string; canSend: boolean | null }>> {
  const accounts = await gmailAccounts();
  const out: Array<{ email: string; canSend: boolean | null }> = [];
  for (const acct of accounts) {
    try {
      const token = await accessTokenFor(acct.refreshToken);
      const res = await fetchWithTimeout(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        out.push({ email: acct.email, canSend: null });
        continue;
      }
      const info = (await res.json().catch(() => ({}))) as { scope?: string };
      out.push({
        email: acct.email,
        canSend: typeof info.scope === "string" ? info.scope.includes("gmail.send") : null,
      });
    } catch {
      out.push({ email: acct.email, canSend: null });
    }
  }
  return out;
}

/** What happened to the owner's copy of a client email (Oct 12 2026). */
export type ClientEmailCopyMode = "bcc" | "copy" | "copy_failed" | "none";

/** One clean address for a `Bcc:` header, or null. Refuses anything that could
 *  smuggle a header (CR/LF), a list, or the recipient themself. */
function bccHeader(bcc: string | null, to: string): string | null {
  const v = (bcc ?? "").trim().toLowerCase();
  if (!v || /[\r\n,;<>"\s]/.test(v) || !/^[^@]+@[^@]+\.[^@]+$/.test(v)) return null;
  if (v === to.trim().toLowerCase()) return null;
  return v;
}

// Send a real threaded REPLY from one of our mailboxes — the human-reviewed
// draft behind the task "Send email" button. Loads the thread, replies to the
// latest message that isn't ours (proper In-Reply-To/References + Re: subject,
// same threadId) so it lands inside the conversation in everyone's inbox.
// Oct 27 2026: `References` carries the message's own References chain plus its
// Message-ID (RFC 5322), not the Message-ID alone, so Outlook and Apple Mail
// thread the reply as well as Gmail does.
async function gmailReplyTarget(
  mailbox: string,
  threadId: string,
): Promise<
  | { ok: true; token: string; acctEmail: string; to: string; subject: string; msgId: string; references: string }
  | { ok: false; error: string; needsReconnect?: boolean }
> {
  const accounts = await gmailAccounts();
  const acct = accounts.find((a) => a.email === mailbox);
  if (!acct) return { ok: false, error: `Mailbox ${mailbox} isn't connected.` };
  let token: string;
  try {
    token = await accessTokenFor(acct.refreshToken);
  } catch {
    return { ok: false, error: "Google token expired — reconnect Gmail in Connections.", needsReconnect: true };
  }
  let thread: GmailThread;
  try {
    thread = await gmail<GmailThread>(
      `/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=Reply-To&metadataHeaders=References`,
      token,
    );
  } catch {
    return { ok: false, error: "Couldn't load the email thread." };
  }
  const msgs = thread.messages ?? [];
  // Reply to the newest message from THEM (fall back to the newest at all).
  const target =
    [...msgs].reverse().find((m) => !parseFrom(header(m, "From")).email.endsWith("@" + OUR_DOMAIN)) ??
    msgs[msgs.length - 1];
  if (!target) return { ok: false, error: "The thread has no messages to reply to." };
  const replyTo = header(target, "Reply-To") || header(target, "From");
  const to = parseFrom(replyTo).email;
  if (!to) return { ok: false, error: "Couldn't work out who to reply to." };
  const origSubject = header(target, "Subject");
  const subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
  const msgId = header(target, "Message-ID").replace(/[\r\n]+/g, " ").trim();
  const prior = header(target, "References").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const references = msgId ? (prior.split(" ").includes(msgId) ? prior : `${prior} ${msgId}`.trim()) : prior;
  return { ok: true, token, acctEmail: acct.email, to, subject, msgId, references };
}

// Who a reply to this thread would go to — the UI shows it before Send.
export async function resolveGmailReplyTarget(
  mailbox: string,
  threadId: string,
): Promise<{ ok: true; to: string; subject: string; from: string } | { ok: false; error: string; needsReconnect?: boolean }> {
  const t = await gmailReplyTarget(mailbox, threadId);
  return t.ok ? { ok: true, to: t.to, subject: t.subject, from: t.acctEmail } : { ok: false, error: t.error, needsReconnect: t.needsReconnect };
}

export async function sendGmailReply(opts: {
  mailbox: string;
  threadId: string;
  body: string;
  /** The recipient the human confirmed — abort if the thread changed under them. */
  expectedTo?: string;
  /** Oct 12 2026: a reply to a CLIENT — the owner gets his copy (lib/clientEmailMonitor.ts):
   *  a blind copy on this very message, or, if it carries a one-use sign-in
   *  link, a separate redacted copy once this one was accepted. */
  clientCopy?: boolean;
}): Promise<
  // Oct 27 2026: also Gmail's own id for the sent message (null when its answer
  // can't be read), so the hub's log row is the one the Sent-folder reader
  // would write (`gmail-sent-<threadId>-<id>`) and never doubles it.
  | { ok: true; to: string; subject: string; copy?: ClientEmailCopyMode; id: string | null; mailbox: string }
  | { ok: false; error: string; needsReconnect?: boolean }
> {
  const t = await gmailReplyTarget(opts.mailbox, opts.threadId);
  if (!t.ok) return t;
  const { token, acctEmail, to, subject, msgId, references } = t;
  if (opts.expectedTo && opts.expectedTo.toLowerCase() !== to.toLowerCase()) {
    return { ok: false, error: `The thread changed — the reply would now go to ${to}, not ${opts.expectedTo}. Re-open and confirm.` };
  }
  // Decided AFTER the recipient is known (the thread names it). Never throws:
  // an unreadable setting means the default — on, to info@.
  const monitor = opts.clientCopy ? await import("@/lib/clientEmailMonitor") : null;
  const plan = monitor ? await monitor.planClientEmailCopy({ to, body: opts.body }) : null;
  const bcc = bccHeader(monitor?.bccOf(plan) ?? null, to);

  const mime = [
    `To: ${to}`,
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `From: ${acctEmail}`,
    // RFC 2047-encode so names/subjects with non-ASCII survive.
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    ...(msgId ? [`In-Reply-To: ${msgId}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    opts.body,
  ].join("\r\n");
  const raw = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw, threadId: opts.threadId }),
  });
  if (res.status === 403) {
    return { ok: false, error: "Gmail can read but not send yet — reconnect Google in Connections to grant sending.", needsReconnect: true };
  }
  if (!res.ok) return { ok: false, error: `Gmail send failed (${res.status}).` };
  const id = await res
    .json()
    .then((j: unknown) => (typeof (j as { id?: unknown })?.id === "string" ? (j as { id: string }).id : null))
    .catch(() => null);
  // The client has it. Only now the separate, redacted copy (sign-in links).
  const copied = monitor && plan?.mode === "copy" ? await monitor.sendClientEmailCopy(plan, { subject, mailbox: acctEmail }) : false;
  return { ok: true, to, subject, id, mailbox: acctEmail, copy: !plan || plan.mode === "none" ? "none" : plan.mode === "copy" ? (copied ? "copy" : "copy_failed") : bcc ? "bcc" : "none" };
}

/** The Gmail thread a message belongs to, read from the mailbox it is in
 *  (Oct 27 2026: the hub's email threads are grouped from the comms log, which
 *  keeps each message's Gmail id but not its thread). One metadata read. */
export async function gmailThreadOfMessage(
  mailbox: string,
  messageId: string,
): Promise<{ ok: true; threadId: string } | { ok: false; error: string; needsReconnect?: boolean }> {
  const acct = (await gmailAccounts()).find((a) => a.email.toLowerCase() === mailbox.toLowerCase());
  if (!acct) return { ok: false, error: `The ${mailbox} mailbox isn't connected.`, needsReconnect: true };
  let token: string;
  try {
    token = await accessTokenFor(acct.refreshToken);
  } catch {
    return { ok: false, error: "Google token expired. Reconnect Gmail in Connections.", needsReconnect: true };
  }
  try {
    const msg = await gmail<GmailMsg>(`/messages/${encodeURIComponent(messageId)}?format=minimal`, token);
    return msg.threadId ? { ok: true, threadId: msg.threadId } : { ok: false, error: "Gmail didn't say which thread that email is in." };
  } catch {
    return { ok: false, error: "Couldn't find that email in Gmail any more." };
  }
}

/** Can this one mailbox SEND? The live token's granted scopes (tokeninfo, as
 *  gmailSendHealth). null = couldn't check, distinct from "no". */
export async function gmailCanSend(mailbox: string): Promise<boolean | null> {
  const acct = (await gmailAccounts()).find((a) => a.email.toLowerCase() === mailbox.toLowerCase());
  if (!acct) return false;
  try {
    const token = await accessTokenFor(acct.refreshToken);
    const res = await fetchWithTimeout(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const info = (await res.json().catch(() => ({}))) as { scope?: string };
    return typeof info.scope === "string" ? info.scope.includes("gmail.send") : null;
  } catch {
    return null;
  }
}

// Send a NEW email (not a reply into an existing thread). Client feedback
// arrives through the public form, so there is no thread to reply into — but
// the agent who filled it in still deserves an answer (Jordan, Sep 7: "add the
// ability to write an email response to the agent, thanking them for their
// feedback and addressing their feedback"). Same account, same scope, same
// 403-means-reconnect contract as sendGmailReply.
// RTP-08 (Sep 16): it now answers with Gmail's OWN message id on success and
// the HTTP status on failure. The outbox (lib/outbox.ts) records the provider's
// id as proof a message really left, and it has to be able to tell a refusal
// (4xx — nothing was sent, offer it again) from a 5xx or a transport failure
// (it may have gone — hold it and ask a person). `ok`/`error`/`needsReconnect`
// are unchanged, so every existing caller reads exactly as before.
//
// CP-15 (Sep 24 2026): `strict`. Without it a missing mailbox quietly falls back
// to whichever account happens to be first in the map — so a program email the
// outbox addressed as info@ would go out from hello@ (or any mailbox connected
// later), under the wrong sender, with nothing saying so. With `strict` the
// mailbox asked for is the only one that may send: absent, the answer is "not
// connected" (needsReconnect, 401) and no token is even requested, so the
// outbox records a clean refusal it can offer again once info@ is reconnected.
// Callers that do not pass it keep the old fallback.
export async function sendGmailNew(opts: {
  mailbox: string;
  to: string;
  subject: string;
  body: string;
  strict?: boolean;
  /** Oct 12 2026: a blind copy on this message (the owner's monitoring copy of a
   *  client email — lib/clientEmailMonitor.ts decides it). A true `Bcc:` header:
   *  Gmail delivers to it and strips it from what the To recipient receives. An
   *  address that is not one clean address, or is the recipient, is ignored. */
  bcc?: string | null;
  /** Oct 21 2026: the branded HTML version of `body` (lib/emailHtml). With it
   *  the message is multipart/alternative: `body` first as text/plain, then
   *  this as text/html, both UTF-8 and base64. Without it the message is
   *  byte-for-byte the plain one it always was. */
  html?: string | null;
  /** Oct 21 2026: visible copies (a client's "Also email" addresses). Each must
   *  be one clean address; the recipient, a duplicate or anything carrying a
   *  header break is dropped, and at most ten are kept. */
  cc?: readonly string[] | null;
}): Promise<
  | { ok: true; to: string; id: string | null }
  | { ok: false; error: string; needsReconnect?: boolean; status?: number }
> {
  const to = opts.to.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: "That doesn't look like an email address.", status: 400 };
  const accounts = await gmailAccounts();
  const wanted = opts.mailbox.trim().toLowerCase();
  const exact = accounts.find((a) => a.email.trim().toLowerCase() === wanted);
  if (opts.strict && !exact) {
    return { ok: false, error: `The ${opts.mailbox} mailbox isn't connected — reconnect it in Connections. Nothing was sent from another account.`, needsReconnect: true, status: 401 };
  }
  const acct = exact ?? accounts[0];
  if (!acct) return { ok: false, error: "No Gmail account is connected.", status: 401 };
  let token: string;
  try {
    token = await accessTokenFor(acct.refreshToken);
  } catch {
    return { ok: false, error: "Google token expired — reconnect Gmail in Connections.", needsReconnect: true, status: 401 };
  }
  const bcc = bccHeader(opts.bcc ?? null, to);
  // Oct 21 2026: Cc after the Bcc line, so a message without copies keeps its
  // headers exactly as before (and the Bcc stays right under To).
  const cc: string[] = [];
  for (const addr of opts.cc ?? []) {
    const v = (addr ?? "").trim().toLowerCase();
    if (!v || /[\r\n,;<>"\s]/.test(v) || !/^[^@]+@[^@]+\.[^@]+$/.test(v) || v === to.toLowerCase() || cc.includes(v)) continue;
    if (cc.push(v) >= 10) break;
  }
  const head = [
    `To: ${to}`,
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `From: ${acct.email}`,
    `Subject: =?UTF-8?B?${Buffer.from(opts.subject).toString("base64")}?=`,
  ];
  const alt = opts.html ? (await import("@/lib/emailHtml")).multipartAlternative({ text: opts.body, html: opts.html }) : null;
  const mime = (
    alt
      ? [...head, "MIME-Version: 1.0", `Content-Type: ${alt.contentType}`, "", alt.body]
      : [...head, "Content-Type: text/plain; charset=UTF-8", "MIME-Version: 1.0", "", opts.body]
  ).join("\r\n");
  const raw = Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (res.status === 403) {
    return { ok: false, error: "Gmail can read but not send yet — reconnect Google in Connections to grant sending.", needsReconnect: true, status: 403 };
  }
  if (!res.ok) return { ok: false, error: `Gmail send failed (${res.status}).`, status: res.status };
  // Gmail names what it accepted. Read it defensively — a body we can't parse
  // is still an accepted send, it just leaves the outbox without an id.
  const id = await res
    .json()
    .then((j: unknown) => (typeof (j as { id?: unknown })?.id === "string" ? ((j as { id: string }).id) : null))
    .catch(() => null);
  return { ok: true, to, id };
}

export function googleConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// `origin` = the host the browser is on (hub.realtourpilot.com or the old
// vercel.app host). Both are registered on the Google client, same as the login
// flow. This has to follow the request rather than pin to appBase(): the
// anti-forgery cookie planted by /api/google/connect is HOST-ONLY, so sending a
// browser that started on one host back to the other would fail the state check
// every time. Falls back to appBase() for a non-https origin.
export function googleRedirectUri(origin?: string | null): string {
  return `${originOrBase(origin)}/api/google/callback`;
}

/**
 * One-shot anti-forgery cookie for the mailbox connect flow: minted by
 * /api/google/connect, matched and cleared by /api/google/callback. Named apart
 * from the login flow's `rtp_oauth_state` so the two round trips can never
 * satisfy each other's check.
 */
export const GOOGLE_STATE_COOKIE = "rtp_gmail_state";

/**
 * Where the "Connect Gmail" button points. NOT Google's URL any more: the flow
 * now starts at our OWN route so it can check the caller is a signed-in
 * owner/admin and plant the state cookie before handing off to Google.
 * Returning Google's URL directly (what this used to do) meant the callback had
 * nothing to verify — it accepted any authorization code from anyone, and every
 * connected mailbox is polled into the company's comms and the AI's memory
 * every 5 minutes.
 */
export function googleAuthorizeUrl(): string {
  return "/api/google/connect";
}

/**
 * Google's real consent screen. Only /api/google/connect builds this, and only
 * after it has authenticated the caller and minted `state`.
 */
export function googleConsentUrl(state: string, origin?: string | null): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", googleRedirectUri(origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error_description as string) || (json.error as string) || `Google token ${res.status}`);
  return json;
}

// `origin` must be the SAME host the consent step used — Google rejects a token
// exchange whose redirect_uri doesn't echo the authorize request exactly. The
// callback runs on whatever host Google redirected to, so passing its own origin
// through is what keeps both hosts working.
export async function exchangeGoogleCode(code: string, origin?: string | null): Promise<{ refreshToken: string }> {
  const json = await tokenRequest({
    code: code.trim(),
    grant_type: "authorization_code",
    redirect_uri: googleRedirectUri(origin),
  });
  const refreshToken = json.refresh_token as string | undefined;
  if (!refreshToken) throw new Error("Google did not return a refresh token. Remove the app's access and re-authorize.");
  return { refreshToken };
}

// Access tokens last an hour, so minting a fresh one for every single API call
// spends a network round trip to Google before every network round trip to
// Google. One page that reads the calendar twice paid for four. Cached per
// refresh token, in-process only (a serverless instance holds it for as long as
// it lives, and nothing sensitive is written down), retired early so a token can
// never expire mid-flight.
const TOKEN_TTL_MS = 45 * 60_000;
const tokenCache = new Map<string, { token: string; expires: number }>();

async function accessTokenFor(refreshToken: string): Promise<string> {
  const hit = tokenCache.get(refreshToken);
  if (hit && hit.expires > Date.now()) return hit.token;
  const json = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  const token = json.access_token as string;
  // Honour Google's own expiry when it gives one, minus a safety margin.
  const ttl = typeof json.expires_in === "number" ? Math.max(60, json.expires_in - 300) * 1000 : TOKEN_TTL_MS;
  tokenCache.set(refreshToken, { token, expires: Date.now() + Math.min(ttl, TOKEN_TTL_MS) });
  return token;
}

/** Drop a cached token — call when a request comes back 401 so the retry re-mints. */
export function forgetGoogleToken(refreshToken: string): void {
  tokenCache.delete(refreshToken);
}

// We support multiple mailboxes (hello@ + info@). The "gmail" secret holds an
// encrypted JSON map of { email: refreshToken }.
async function gmailAccounts(): Promise<{ email: string; refreshToken: string }[]> {
  const raw = await getSecret("gmail");
  if (!raw) return [];
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    return Object.entries(map).map(([email, refreshToken]) => ({ email, refreshToken }));
  } catch {
    return [{ email: "account", refreshToken: raw }]; // legacy single-token
  }
}

/**
 * READ ONLY (Oct 22 2026, comms audit H2 repair): the sender address of each
 * message in one connected mailbox, by its Gmail id (null when it cannot be
 * read). One metadata read per message; nothing is changed in Gmail.
 */
export async function gmailSenderAddresses(mailbox: string, messageIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const acct = (await gmailAccounts()).find((a) => a.email.toLowerCase() === mailbox.toLowerCase());
  if (!acct) return out;
  const token = await accessTokenFor(acct.refreshToken);
  for (const id of messageIds) {
    try {
      const msg = await gmail<GmailMsg>(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From`, token);
      out.set(id, parseFrom(header(msg, "From")).email || null);
    } catch {
      out.set(id, null);
    }
  }
  return out;
}

/** The connected mailboxes' addresses — no tokens leave this file (§9 mailbox
 *  health: "connected" is its own line, separate from "reading"). */
export async function connectedGmailMailboxes(): Promise<string[]> {
  return (await gmailAccounts()).map((a) => a.email.toLowerCase());
}

/**
 * A live access token for the OWNER's Google account (info@) — the identity
 * whose calendar and Drive the hub acts on. Returns null when that mailbox
 * isn't connected, so callers degrade to "not connected" instead of throwing.
 *
 * Deliberately does NOT fall back to another mailbox: writing a block onto the
 * wrong calendar is worse than writing none.
 */
export async function ownerGoogleToken(): Promise<string | null> {
  const acct = (await gmailAccounts()).find((a) => a.email === OWNER_EMAIL);
  if (!acct) return null;
  try {
    return await accessTokenFor(acct.refreshToken);
  } catch {
    return null;
  }
}

export const GOOGLE_OWNER_EMAIL = OWNER_EMAIL;

// Add (or refresh) a mailbox after the user authorizes it.
export async function addGmailAccount(refreshToken: string): Promise<string> {
  const { saveSecret } = await import("./connections");
  const token = await accessTokenFor(refreshToken);
  const profile = await gmail<{ emailAddress?: string }>("/profile", token);
  const email = (profile.emailAddress || "account").toLowerCase();
  const existing = await gmailAccounts();
  const map: Record<string, string> = {};
  for (const a of existing) map[a.email] = a.refreshToken;
  map[email] = refreshToken;
  await saveSecret("gmail", JSON.stringify(map), {
    accountLabel: `Gmail · ${Object.keys(map).join(", ")}`,
  });
  return email;
}

// Every Gmail read (Oct 20 2026, audit H7): 30 s, so one mailbox that stops
// answering cannot hold the 5-minute comms cron to its 100 s budget.
async function gmail<T = unknown>(path: string, token: string): Promise<T> {
  const res = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Gmail ${path} ${res.status}`);
  return (await res.json()) as T;
}

export async function testGmailToken(
  refreshToken: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    const json = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
    const token = json.access_token as string;
    const profile = await gmail<{ emailAddress?: string }>("/profile", token);
    return { ok: true, label: `Gmail · ${profile.emailAddress || "connected"}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type GmailPart = { mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: GmailPart[]; headers?: { name: string; value: string }[] };

// ---------------------------------------------------------------------------
// GOOGLE CALENDAR NOTICES ARE NOT CLIENT MAIL (Oct 27 2026). Kristen Pavillard
// accepted her Oct 29 brand discovery call; Google Calendar mailed the
// acceptance "from" her address, the inbox read it as her writing to us, and
// Kyle got a to-do "Prepare for Brand Discovery Call on Oct 29". The call is
// Jordan's and already has his own meeting_prep task from Calendly, so the
// notice was a duplicate on the wrong desk (Jordan: "Kyle should not have to
// do anything with Kristen Pavillard"). Accepted / Declined / Tentative /
// Invitation / Updated / Canceled notices now create nothing and are not
// logged as the client's words (the reply walk would read them as waiting on
// us). A client's own reply on such a thread ("Re: Invitation: ...") is a
// human email and is handled as before.
// ---------------------------------------------------------------------------
const CALENDAR_SUBJECT_RE =
  /^(?:accepted|declined|tentatively accepted|invitation|updated invitation(?: with note)?|new event|canceled event|cancelled event|event canceled|event cancelled|updated event|proposed new time|invitation from google calendar)(?:\s*\(with note\))?\s*:/i;
const CALENDAR_SENDER_RE = /calendar-notification@google\.com/i;

function hasCalendarPart(p?: GmailPart): boolean {
  if (!p) return false;
  const mime = (p.mimeType ?? "").toLowerCase();
  if (mime.startsWith("text/calendar") || mime === "application/ics" || /\.ics$/i.test(p.filename ?? "")) return true;
  return (p.parts ?? []).some(hasCalendarPart);
}

/** True when an inbound email is an automated calendar notice (an invitation,
 *  or a guest's accept / decline / tentative reply), not something a person
 *  wrote. Needs the notice-shaped subject AND proof it came from a calendar:
 *  Google Calendar's sender address, an attached invite, or Google's own
 *  footer. A subject alone is never enough ("Invitation: come see the house"). */
export function isCalendarNotice(m: { subject: string; from?: string; sender?: string; body?: string; calendarPart?: boolean }): boolean {
  const subject = (m.subject ?? "").trim();
  const fromCalendar = CALENDAR_SENDER_RE.test(m.from ?? "") || CALENDAR_SENDER_RE.test(m.sender ?? "");
  if (fromCalendar && !/^(?:re|fwd?)\s*:/i.test(subject)) return true;
  if (!CALENDAR_SUBJECT_RE.test(subject)) return false;
  return !!m.calendarPart || /invitation from google calendar|google calendar|invite\.ics|reply for .+@|has (?:accepted|declined|tentatively accepted) this invitation/i.test(m.body ?? "");
}
type GmailMsg = { id: string; threadId?: string; snippet?: string; internalDate?: string; payload?: GmailPart };
type GmailThread = { messages?: GmailMsg[] };

function header(m: GmailMsg, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}
function parseFrom(from: string): { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*)"?\s*<?([^>]*)>?\s*$/);
  let name = (m?.[1] ?? "").trim();
  let email = (m?.[2] ?? "").trim().toLowerCase();
  // Bare address with no display name / angle brackets (e.g. "status@luma.co"):
  // the regex captures it as the name and leaves email empty. Recover it.
  if (!email) {
    email = name.toLowerCase();
    name = "";
  }
  return { name: name || email, email };
}

// Mailboxes that should ONLY surface emails from people already in the client
// list (no "new lead" tasks from unknown senders). info@ is Jordan's personal
// account, so unknown senders there are usually personal mail, not leads.
const CLIENTS_ONLY_MAILBOXES = ["info@realtourpilot.com"];
/** The WebhookEvent provider that claims an email's RFC Message-ID across our inboxes (comms audit M3). */
export const GMAIL_MID_PROVIDER = "gmail-mid";

// THE MAILBOXES THE HUB IS SUPPOSED TO BE READING (§9, Sep 26 2026). info@ is
// Jordan's (known clients only); hello@ is Kyle's login and the ONLY path an
// email lead comes in on. A healthy info@ says nothing about hello@, so each is
// checked on its own every scan (gmailHealth.ts), and one missing from the
// connected map is reported as not connected — never quietly retired.
export const EXPECTED_MAILBOXES = ["info@realtourpilot.com", "hello@realtourpilot.com"] as const;
/** How often a good mail scan may refresh the gmail row's lastSyncedAt (syncGmail, audit G11). */
export const GMAIL_SYNC_STAMP_MS = 10 * 60_000;

// Jordan's personal mailbox — its comms are OWNER-tier (logComm stamps unknown
// senders minRole OWNER). The task full-view must not live-fetch its threads
// for ADMIN viewers; exported so the action can apply the same boundary.
export function isPersonalMailbox(email: string): boolean {
  return CLIENTS_ONLY_MAILBOXES.includes(email.toLowerCase());
}

// Automated / non-human sender local-parts (the part before @).
const AUTOMATED_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|notify|notification|notifications|mailer|mailer-daemon|bounce|bounces|postmaster|news|newsletter|marketing|promo|promotions|billing|invoice|invoices|invoicing|receipt|receipts|payments?|orders?|alerts?|updates?|system|automated|auto|do_not_reply|noticed|team|hello|info|support|help|account|accounts|email|mail|members?|notices?|reply)$/i;

// Vendor / tooling domains whose mail is transactional, never a client.
const VENDOR_DOMAINS = [
  "aryeo.com", "dropbox.com", "dropboxmail.com", "stripe.com", "intuit.com", "quickbooks.com",
  "docusign.net", "docusign.com", "calendly.com", "google.com", "accounts.google.com",
  "squarespace.com", "wix.com", "openphone.com", "openphone.co", "slack.com", "anthropic.com",
  "vercel.com", "hubspot.com", "mail.hubspot.com", "zoom.us", "canva.com", "venmo.com",
  "paypal.com", "facebookmail.com", "mailchimp.com", "sendgrid.net", "amazonses.com",
  "matterport.com", "cubicasa.com", "autohdr.com", "frame.io",
];

// Our own addresses. Any mail whose latest thread message is from one of these
// means WE'VE already replied — so the thread shouldn't generate a "to reply" task.
const OUR_DOMAIN = "realtourpilot.com";

// Luma Visuals = our premium-reel VIDEO EDITOR (a vendor, not a lead). Their
// status@ / Zapier mails mean "edit done" or "editor has a question" → route to
// a "check the Luma Visuals reel tracker" task instead of a lead.
const LUMA_DOMAINS = ["lumavisuals.co", "lumavisuals.com"];
// Match a project to a Luma subject by its street (house number + suffix dropped,
// so "3752 Old Post Cir" matches "3725 Old Post Circle").
const STREET_SUFFIX_RE = /\b(dr|drive|st|street|rd|road|ave|avenue|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|hwy|sq|square|run|trl|trail|loop|pike|row)\.?$/i;
function streetCore(title: string): string {
  let s = (title.split(",")[0] || "").trim().replace(/^\d+\s+/, "");
  s = s.replace(STREET_SUFFIX_RE, "").trim();
  return s.toLowerCase();
}
// Other production-tool senders that should never be leads (drop them).
const VENDOR_NAME_RE = /\b(autohdr|auto\s?hdr|cubicasa|matterport|aryeo)\b/i;

function isLikelyHuman(fromEmail: string, listUnsubscribe: string, subject: string, fromName = ""): boolean {
  if (!fromEmail || !fromEmail.includes("@")) return false;
  if (listUnsubscribe) return false; // bulk / marketing / newsletters
  const [local, domain] = fromEmail.split("@");
  if (AUTOMATED_LOCAL.test(local)) return false;
  if (domain === OUR_DOMAIN) return false; // our own / forwarded mail
  if (VENDOR_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return false;
  if (domain === "zapiermail.com") return false; // Zapier-relayed automation
  if (VENDOR_NAME_RE.test(fromName) || VENDOR_NAME_RE.test(local)) return false; // vendor brands
  // Obvious receipts/invoices/marketing by subject.
  if (/\b(invoice|receipt|payment received|your order|statement|unsubscribe|newsletter|webinar|sale ends|% off)\b/i.test(subject)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// "WE ALREADY ANSWERED THIS" — and, since Sep 16, the RECEIPT for it.
//
// The sync has always known when a thread's last message is ours; it just
// threw the fact away ("still logged to comms memory below, but it won't
// create a task"). And because the inbox query is `-from:me`, our own replies
// were never logged either — 0 outbound email rows in 30 days. So the one walk
// (replyQueue.ts) saw an inbound email, no outbound row, no completed task and
// no ack, and put it back on the board. That is exactly what happened to Rick
// Schultz on Sep 15: Jordan had answered him in Gmail, the hub still said he
// was waiting, and the only way out was a manual Handled tick.
//
// `lastFromUs` now returns the message ITSELF so the caller can log it as an
// outbound CommLog row. Rule 4 of the walk ("our side answering closes it")
// then clears the thread with no new mechanism at all.
// ---------------------------------------------------------------------------
type SentMessage = { id: string; at: Date; to: string; subject: string; from?: string };

/** One read of a thread's tail: whether WE spoke last (the reply, when so) and,
 *  when the counterparty did, when and under what subject. Null on a read
 *  failure — never suppress on ignorance. */
type ThreadTail = { reply: SentMessage | null; lastInbound: { at: Date; subject: string } | null };

/** The thread as the client sees it: our internal notes (a forward to Kyle, a
 *  reply-to-teammate) left out, so neither reader below mistakes one for our
 *  answer (lib/mailMatch isInternalNote, audit Oct 25 2026). */
const THREAD_HEADERS = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date";
function clientFacing(msgs: GmailMsg[]): GmailMsg[] {
  return msgs.filter((m) => !isInternalNote({ from: header(m, "From"), to: header(m, "To"), cc: header(m, "Cc"), subject: header(m, "Subject") }, OUR_DOMAIN));
}

async function threadTail(threadId: string, token: string): Promise<ThreadTail | null> {
  try {
    const thread = await gmail<GmailThread>(`/threads/${threadId}?${THREAD_HEADERS}`, token);
    const msgs = clientFacing(thread.messages ?? []);
    if (msgs.length === 0) return { reply: null, lastInbound: null };
    const last = msgs[msgs.length - 1];
    const from = header(last, "From").toLowerCase();
    const when = Number(last.internalDate);
    const at0 = Number.isFinite(when) && when > 0 ? new Date(when) : new Date(header(last, "Date"));
    const at = isNaN(at0.getTime()) ? new Date() : at0;
    if (from.includes("@" + OUR_DOMAIN)) {
      // A one-message thread from us is an outgoing mail, not a reply.
      if (msgs.length < 2) return { reply: null, lastInbound: null };
      return { reply: { id: last.id, at, to: header(last, "To"), subject: header(last, "Subject"), from: header(last, "From") }, lastInbound: null };
    }
    return { reply: null, lastInbound: { at, subject: header(last, "Subject") } };
  } catch {
    return null;
  }
}

/** The newest message in this thread that WE sent, when it is also the LAST
 *  message — i.e. the thread is answered. Null when the counterparty spoke
 *  last, when the thread is a single message we sent (a fresh mail answers
 *  nothing), or when Gmail can't be read (never suppress on ignorance). */
async function lastFromUs(threadId: string, token: string): Promise<SentMessage | null> {
  try {
    const thread = await gmail<GmailThread>(`/threads/${threadId}?${THREAD_HEADERS}`, token);
    const msgs = clientFacing(thread.messages ?? []);
    // A one-message thread from us is an outgoing mail, not a reply. Keying on
    // "the last message is from our domain" alone would log a cold forward as
    // an answer to a conversation that never happened.
    if (msgs.length < 2) return null;
    const last = msgs[msgs.length - 1];
    const from = header(last, "From").toLowerCase();
    if (!from.includes("@" + OUR_DOMAIN)) return null;
    const when = Number(last.internalDate);
    const at = Number.isFinite(when) && when > 0 ? new Date(when) : new Date(header(last, "Date"));
    return {
      id: last.id,
      at: isNaN(at.getTime()) ? new Date() : at,
      to: header(last, "To"),
      subject: header(last, "Subject"),
      from: header(last, "From"),
    };
  } catch {
    return null; // if we can't tell, don't suppress
  }
}

/** Gmail's internalDate as a Date — only when it is a sane past instant
 *  (never trust a future clock); undefined lets logComm stamp now. */
function receivedAt(internalDate: string | undefined): Date | undefined {
  const n = Number(internalDate);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n <= Date.now() + 60_000 ? new Date(n) : undefined;
}

/** The TeamMember who sent a message, by its From address (Kyle = hello@).
 *  Null when the roster cannot say — unknown, never "nobody". */
async function senderMemberId(fromHeader: string | undefined): Promise<string | null> {
  const { parseAddressList, staffAddressBook } = await import("@/lib/staffEmail");
  const addr = parseAddressList(fromHeader)[0];
  if (!addr) return null;
  return (await staffAddressBook()).memberByAddress.get(addr)?.id ?? null;
}

/** Log one of OUR replies into comms memory as an outbound row, so the
 *  unanswered walk clears the thread on the next pass (and Ask the Hub can
 *  recall what we actually said). Idempotent on externalId; best-effort.
 *  Returns true when a new row landed. */
async function logSentReply(opts: {
  threadId: string;
  msg: SentMessage;
  mailbox: string;
  token: string;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
}): Promise<boolean> {
  try {
    const { logComm } = await import("@/lib/commLog");
    const { GMAIL_SENT_SOURCE } = await import("@/lib/replyQueue");
    const externalId = `gmail-sent-${opts.threadId}-${opts.msg.id}`;
    // Already logged? Then don't spend a second Gmail call on the body. This
    // is the common case on every pass after the first.
    if (await prisma.commLog.findUnique({ where: { externalId }, select: { id: true } })) return false;
    // Our OWN WORDS, not a note that we replied — Ask the Hub, the client
    // page's thread and the reply drafter all read this back.
    let body = "";
    try {
      const full = await gmail<GmailMsg>(`/messages/${opts.msg.id}?format=full`, opts.token);
      body = stripQuotedReply(extractBody(full.payload)) || cleanText(full.snippet ?? "");
    } catch { /* fall back to the one-line receipt below */ }
    if (!body.trim()) body = `Replied${opts.msg.to ? ` to ${opts.msg.to}` : ""} from ${opts.mailbox}.`;
    return await logComm({
      channel: "email",
      direction: "out",
      // info@ is Jordan's personal mailbox; its rows stay owner-tier for a
      // sender we can't place, exactly as the inbound side files them.
      minRole: isPersonalMailbox(opts.mailbox) && !opts.clientId ? "OWNER" : undefined,
      clientId: opts.clientId,
      clientName: opts.clientName,
      projectId: opts.projectId,
      // "Us" is the label every receiver stamps on our own sends, and the walk
      // reads it as ours (replyQueue.ts OUR_LABELS) whichever way `direction`
      // was written.
      contactName: "Us",
      subject: opts.msg.subject || null,
      body: clip(body, 5_500),
      occurredAt: opts.msg.at,
      source: GMAIL_SENT_SOURCE,
      externalId,
      senderTeamMemberId: await senderMemberId(opts.msg.from),
    });
  } catch {
    return false; // comms memory is a courtesy here — never fail the scan
  }
}

// ---------------------------------------------------------------------------
// Reading email threads (for the "see the conversation" view on a client page).
// These readers only read. A reply goes out through sendGmailReply, and only
// when a person presses Send (app/emailActions, Oct 27 2026).
// ---------------------------------------------------------------------------

export type GmailEmail = {
  id: string;
  threadId: string;
  mailbox: string; // which of our mailboxes surfaced it
  from: string; // display name (or address)
  fromEmail: string;
  date: string; // ISO
  subject: string;
  snippet: string;
  body: string; // plain-text body
  fromUs: boolean; // sent by us (one of our addresses)
};

function decodeB64Url(data?: string): string {
  if (!data) return "";
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

// Pull a readable plain-text body out of a (possibly multipart) Gmail payload.
// Prefers text/plain; falls back to a crude HTML strip.
function extractBody(payload?: GmailPart): string {
  if (!payload) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: GmailPart) => {
    if (p.parts?.length) { p.parts.forEach(walk); return; }
    const mime = p.mimeType ?? "";
    if (mime.startsWith("text/plain")) plain.push(decodeB64Url(p.body?.data));
    else if (mime.startsWith("text/html")) html.push(decodeB64Url(p.body?.data));
  };
  walk(payload);
  let text = plain.join("\n").trim();
  if (!text) {
    text = html.join("\n").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  }
  // Entities decoded + zero-widths stripped + blank lines collapsed (cleanText)
  // so what lands in tasks/comms reads like the email, not like its source.
  return cleanText(text);
}

// Load recent email messages involving any of a client's addresses, across all
// connected mailboxes, newest-last (chronological, like a thread).
export async function clientEmailThreads(
  emails: string[],
  maxMessages = 15,
): Promise<GmailEmail[]> {
  const accounts = await gmailAccounts();
  if (accounts.length === 0) return [];
  const addrs = Array.from(new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"))));
  if (addrs.length === 0) return [];

  // Gmail OR-group query: {from:a to:a from:b to:b} matches mail to OR from them.
  const terms = addrs.flatMap((a) => [`from:${a}`, `to:${a}`]);
  const q = `{${terms.join(" ")}} newer_than:1y`;

  const out: GmailEmail[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    let token: string;
    try { token = await accessTokenFor(account.refreshToken); } catch { continue; }
    let list: { messages?: { id: string }[] };
    try {
      list = await gmail(`/messages?q=${encodeURIComponent(q)}&maxResults=${maxMessages}`, token);
    } catch { continue; }
    for (const { id } of list.messages ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      let msg: GmailMsg;
      try { msg = await gmail<GmailMsg>(`/messages/${id}?format=full`, token); } catch { continue; }
      const { name, email } = parseFrom(header(msg, "From"));
      const dateHdr = header(msg, "Date");
      const ts = dateHdr ? new Date(dateHdr) : new Date(Number(msg.internalDate ?? 0));
      out.push({
        id,
        threadId: msg.threadId ?? id,
        mailbox: account.email,
        from: name || email,
        fromEmail: email,
        date: (isNaN(ts.getTime()) ? new Date() : ts).toISOString(),
        subject: header(msg, "Subject"),
        snippet: cleanText(msg.snippet ?? ""),
        body: extractBody(msg.payload).slice(0, 4000),
        fromUs: email.endsWith("@" + OUR_DOMAIN),
      });
    }
  }
  return out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// Fetch ONE Gmail thread in full — the task full-view's "original conversation"
// panel. sourceDetail on email tasks is "gmail-thread:<mailbox>:<threadId>";
// this turns it back into the actual messages, chronological.
export async function fetchGmailThread(
  mailbox: string,
  threadId: string,
): Promise<{ from: string; fromUs: boolean; date: string; body: string }[]> {
  const accounts = await gmailAccounts();
  const account = accounts.find((a) => a.email === mailbox) ?? accounts[0];
  if (!account) return [];
  const token = await accessTokenFor(account.refreshToken);
  const thread = await gmail<GmailThread>(`/threads/${threadId}?format=full`, token);
  return (thread.messages ?? []).map((m) => {
    const { name, email } = parseFrom(header(m, "From"));
    const dateHdr = header(m, "Date");
    const ts = dateHdr ? new Date(dateHdr) : new Date(Number(m.internalDate ?? 0));
    return {
      from: name || email,
      fromUs: email.endsWith("@" + OUR_DOMAIN),
      date: (isNaN(ts.getTime()) ? new Date() : ts).toISOString(),
      // Own words only — each message in the thread already shows its history.
      body: clip(stripQuotedReply(extractBody(m.payload)), 4000),
    };
  });
}

// Scan recent inbound emails across all connected mailboxes (hello@ + info@),
// keep only genuine client/lead messages (no marketing, invoices, automated),
// and turn them into tasks. Matched clients → reply task; unknown humans → lead.
// ---------------------------------------------------------------------------
// The email Handled tick and the gmail-born client_reply task.
//
// Sep 8 audit: the Comms board's tick wrote its ack marker (the unanswered walk
// in replyQueue honours it) and stopped — the silent client_reply task this
// sync minted for the thread stayed OPEN, and only the reply sweep's "latest
// message in the thread is ours" check could ever close it. "Update Kimberly's
// portal access" on Marcee McMullen's record sat open 54 days that way: it
// gagged her automated texts (clientTextSweeps clientHasOpenQuestion) and sat
// in Kyle's Open Loops while every "waiting" number on screen said seven days.
// Two closers, one rule:
//   · completeEmailReplyTasks — for the tick itself (src/app/actions.ts
//     markCommsHandled, email branch), so the task closes on the spot;
//   · closeAckedEmailReplyTasks — run by syncGmail's reply sweep, closes any
//     task whose sender was ticked AFTER their last email arrived. It is the
//     backstop for acks written before this existed and for a tick the action
//     never reached.
// Scope is the SENDER GROUP, exactly as the ack is: a task filed under the
// same client record for a different human (an assistant folded to the agent)
// is left alone — the reviewed rule for the ack was that two senders mis-filed
// under one client record never share a tick, and the task must not become the
// back door that breaks it.
// ---------------------------------------------------------------------------

const OPEN_REPLY: { notIn: string[] } = { notIn: ["COMPLETED", "CANCELLED"] };

/** `<last>|<first>` for a sender name — the same reduction replyQueue's
 *  emailKeyOf applies when it builds the ack key, so a task's contactName can
 *  be held against an ack and answer "was this tick aimed at this person?". */
function senderKeyOf(name: string | null | undefined): string | null {
  const raw = (name ?? "").split(/,|\s[-–—|]\s/)[0];
  if (raw.includes("@")) return raw.trim().toLowerCase();
  const clean = raw.trim().toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const parts = clean.split(" ");
  return parts.length < 2 ? clean : `${parts[parts.length - 1]}|${parts[0]}`;
}

/** Does an ack written for `groupKey` cover the person behind a task? No group
 *  (the legacy per-client key) covers everyone on the record. Otherwise the
 *  sender's key must match: same surname, first names a prefix of each other —
 *  the walk's own "S Mercer" ⇄ "Sharra Mercer" merge rule, so a group keyed on
 *  the fuller name still covers a task filed under the shorter one. */
export function emailAckCoversSender(groupKey: string | null | undefined, senderName: string | null | undefined, clientId: string | null): boolean {
  if (!groupKey) return true;
  const want = senderKeyOf(senderName) ?? (clientId ? `client:${clientId}` : null);
  if (!want) return false;
  if (want === groupKey) return true;
  const wb = want.lastIndexOf("|"), gb = groupKey.lastIndexOf("|");
  if (wb < 0 || gb < 0) return false;
  const wl = want.slice(0, wb), wf = want.slice(wb + 1);
  const gl = groupKey.slice(0, gb), gf = groupKey.slice(gb + 1);
  return wl === gl && !!wf && !!gf && (wf.startsWith(gf) || gf.startsWith(wf));
}

/** The tick: complete the gmail-born client_reply task(s) for the sender group
 *  just marked Handled. A task with no contactName was written in by the
 *  client themself, so the client's own name is the sender it is held against.
 *  Returns how many closed. */
export async function completeEmailReplyTasks(clientId: string, groupKey?: string | null): Promise<number> {
  const open = await prisma.smartTask.findMany({
    where: { clientId, taskType: "client_reply", source: "gmail", status: OPEN_REPLY },
    select: { id: true, contactName: true, client: { select: { name: true } } },
  });
  const ids = open.filter((t) => emailAckCoversSender(groupKey, t.contactName ?? t.client?.name, clientId)).map((t) => t.id);
  if (ids.length === 0) return 0;
  const r = await prisma.smartTask.updateMany({
    where: { id: { in: ids }, status: OPEN_REPLY },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return r.count;
}

/** The backstop (syncGmail's reply sweep): an open gmail-born client_reply
 *  whose sender was ticked Handled at-or-after the client's latest inbound
 *  email is answered as far as the humans are concerned — close it. An ack
 *  OLDER than the latest email leaves the task alone: they wrote again since.
 *  The reference is the client record's last inbound (not just this sender's),
 *  so the safe direction — leaving a task open — wins whenever two people
 *  share one record. Returns how many closed. */
export async function closeAckedEmailReplyTasks(): Promise<number> {
  const open = await prisma.smartTask.findMany({
    where: { taskType: "client_reply", source: "gmail", status: OPEN_REPLY, clientId: { not: null } },
    select: { id: true, clientId: true, contactName: true, createdAt: true, client: { select: { name: true } } },
  });
  if (open.length === 0) return 0;
  const clientIds = [...new Set(open.map((t) => t.clientId as string))];
  const acks = await prisma.appSetting.findMany({
    where: { OR: clientIds.map((id) => ({ key: { startsWith: `comms-ack-email-${id}` } })) },
    select: { key: true, value: true },
  });
  let closed = 0;
  for (const t of open) {
    const cid = t.clientId as string;
    const prefix = `comms-ack-email-${cid}`;
    const covering = acks
      .filter((a) => a.key === prefix || a.key.startsWith(`${prefix}:`))
      .map((a) => {
        let group: string | null = a.key === prefix ? null : a.key.slice(prefix.length + 1);
        try { group = group === null ? null : decodeURIComponent(group); } catch { /* keep the raw key */ }
        return { group, at: new Date(a.value) };
      })
      .filter((a) => !isNaN(a.at.getTime()) && emailAckCoversSender(a.group, t.contactName ?? t.client?.name, cid));
    if (covering.length === 0) continue;
    const ackAt = new Date(Math.max(...covering.map((a) => a.at.getTime())));
    const lastIn = await prisma.commLog.findFirst({
      where: { clientId: cid, channel: "email", direction: "in" },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    });
    if (ackAt.getTime() < (lastIn?.occurredAt ?? t.createdAt).getTime()) continue;
    const r = await prisma.smartTask.updateMany({
      where: { id: t.id, status: OPEN_REPLY },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    closed += r.count;
  }
  return closed;
}

/** One mailbox's read on one scan (§9 mailbox health, Sep 26 2026). */
export type MailboxRead = { email: string; ok: boolean; scanned: number; error?: string };

export async function syncGmail(): Promise<{ degraded: boolean; scanned: number; tasks: number; mailboxes: MailboxRead[] }> {
  const { recordClientCommunication } = await import("@/lib/comms");
  const { logComm } = await import("@/lib/commLog");
  const accounts = await gmailAccounts();
  // CONNECTED IS NOT READING (§9, Sep 26 2026). A mailbox whose token Google
  // refused used to be skipped with no record at all, and the cron step stayed
  // green: the only symptom of hello@ going dark was email that never appeared.
  // hello@ is the only path an email LEAD comes in on, and client mail sent
  // only there vanishes too, so each mailbox's read is now recorded and the
  // owner is told the moment an expected one stops being read.
  const mailboxes: MailboxRead[] = [];
  const reportReads = async () => {
    const { reportGmailReadBroken, reportGmailReadWorking } = await import("@/lib/gmailHealth");
    for (const m of mailboxes) {
      if (m.ok) await reportGmailReadWorking(m.email);
      else await reportGmailReadBroken(m.email, m.error ?? "not read");
    }
  };
  for (const mb of EXPECTED_MAILBOXES) {
    if (!accounts.some((a) => a.email.toLowerCase() === mb)) {
      mailboxes.push({ email: mb, ok: false, scanned: 0, error: "not connected" });
    }
  }
  if (accounts.length === 0) {
    await reportReads().catch(() => {});
    throw new Error("Gmail is not connected.");
  }

  // Preload clients + contacts for email matching (shared across mailboxes).
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({
      where: { email: { not: null } },
      select: {
        id: true,
        name: true,
        email: true,
        parentClientId: true, // fold team assistants → the agent who holds the orders
        // Most-recent REAL order (orderedAt), not import order (createdAt is ≈same for all).
        projects: {
          orderBy: [
            { orderedAt: { sort: "desc", nulls: "last" } },
            { shootDate: { sort: "desc", nulls: "last" } },
            { createdAt: "desc" },
          ],
          take: 1,
          select: { id: true, title: true, status: true },
        },
      },
    }),
    prisma.contact.findMany({ where: { email: { not: null }, clientId: { not: null } }, select: { email: true, clientId: true } }),
  ]);
  const clientByEmail = new Map(clients.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  // An assistant's email folds to their agent (where the orders live).
  const toAgent = (c: (typeof clients)[number]) => (c.parentClientId && clientById.get(c.parentClientId)) || c;
  const contactClientByEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c.clientId!]));
  // A team assistant's mail and our replies to her (lib/teamRouting, Oct 23
  // 2026). The directory is read once per scan, and only when a folded
  // assistant or a team member is on the mail.
  const { routeTeamMessage, routeTeamReply, loadTeamDirectory } = await import("@/lib/teamRouting");
  let teamDir: ReturnType<typeof loadTeamDirectory> | null = null;
  const teamDirectory = () => (teamDir ??= loadTeamDirectory());
  /** The sender's own client row for an address (before the fold): a client's email, else a synced contact's client. */
  const ownClientIdOf = (address: string): string | null => clientByEmail.get(address)?.id ?? contactClientByEmail.get(address) ?? null;

  // OUR SIDE OF THE CONVERSATION, FROM EVERY INBOX (Oct 14 2026 — see
  // src/lib/staffEmail.ts). Who counts as staff, and which client an address
  // we wrote to belongs to: the same email → contact → agent fold the inbound
  // path uses below.
  const { staffAddressBook, staffReplyRow, isStaffAddress } = await import("@/lib/staffEmail");
  const { GMAIL_SENT_SOURCE, threadSubject, outboundIsAnswer } = await import("@/lib/replyQueue");
  const book = await staffAddressBook();
  const connectedMailboxes = new Set(accounts.map((a) => a.email.toLowerCase()));
  const resolveAddress = (address: string): { clientId: string; clientName: string | null } | null => {
    let c = clientByEmail.get(address);
    if (!c) {
      const cid = contactClientByEmail.get(address);
      if (cid) c = clientById.get(cid);
    }
    if (!c) return null;
    const agent = toAgent(c);
    return { clientId: agent.id, clientName: agent.name };
  };
  /** The project a reply belongs to: the client's latest inbound email on the
   *  same subject, else none (a reply is filed to the client, never guessed). */
  const projectForReply = async (clientId: string, subject: string): Promise<string | null> => {
    const want = threadSubject(subject);
    if (!want) return null;
    const rows = await prisma.commLog.findMany({
      where: { channel: "email", direction: "in", clientId, projectId: { not: null } },
      orderBy: { occurredAt: "desc" },
      take: 10,
      select: { subject: true, projectId: true },
    });
    return rows.find((r) => threadSubject(r.subject) === want)?.projectId ?? null;
  };
  /** Write one staff reply (see staffReplyRow). True when a new row landed. */
  const logStaffReply = async (row: NonNullable<ReturnType<typeof staffReplyRow>>): Promise<boolean> => {
    const { to, ...data } = row;
    // OUR REPLY TO A TEAM ASSISTANT (Oct 23 2026) stays in her conversation:
    // the team agent our words name, else the one her mail on this thread
    // was filed on. Without it Kyle's answer to Olivia about Sharra's job
    // landed on Mike Flatley and Sharra's thread read as still waiting.
    const team = await routeTeamReply({ recipientClientId: ownClientIdOf(to), channel: "email", subject: row.subject, body: row.body, threadKey: threadSubject(row.subject ?? ""), directory: teamDirectory });
    if (team) return logComm({ ...data, clientId: team.clientId, clientName: team.clientName, projectId: team.projectId ?? (await projectForReply(team.clientId, row.subject ?? "")) });
    return logComm({ ...data, projectId: await projectForReply(row.clientId, row.subject ?? "") });
  };

  let scanned = 0;
  let tasks = 0;
  const tokens = new Map<string, string>(); // mailbox email -> access token (for the reply sweep)

  for (const account of accounts) {
    let token: string;
    try {
      token = await accessTokenFor(account.refreshToken);
    } catch {
      // Token revoked / expired — skip this mailbox, and SAY so (§9, Sep 26).
      mailboxes.push({ email: account.email, ok: false, scanned: 0, error: "token refresh failed — reconnect this mailbox" });
      continue;
    }
    tokens.set(account.email, token);
    // NOTE: do NOT add `category:primary` — these are Workspace mailboxes that
    // don't use Gmail's tabbed-inbox categories, so that operator matches zero
    // messages and silently drops everything. We rely on isLikelyHuman() below
    // to filter out marketing/automated/vendor mail instead.
    // Page through the inbox so a busy day (>50 human emails between runs) doesn't
    // silently drop the surplus past the first page. Bounded (~300/run) so a
    // flooded mailbox can't run away.
    const ids: string[] = [];
    let pageToken: string | undefined;
    // A failed LIST used to throw out of syncGmail altogether, so one broken
    // mailbox stopped the other one being read as well. Now it is this
    // mailbox's failure, recorded, and the loop moves on (§9, Sep 26).
    try {
      for (let page = 0; page < 6; page++) {
        const list = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(
          "/messages?q=" + encodeURIComponent("in:inbox newer_than:3d -from:me") + "&maxResults=50" +
            (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""),
          token,
        );
        for (const m of list.messages ?? []) ids.push(m.id);
        if (!list.nextPageToken) break;
        pageToken = list.nextPageToken;
      }
    } catch (e) {
      mailboxes.push({ email: account.email, ok: false, scanned: 0, error: `inbox read failed — ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
      tokens.delete(account.email); // nothing below may lean on a mailbox we could not read
      continue;
    }
    mailboxes.push({ email: account.email, ok: true, scanned: ids.length });
    scanned += ids.length;

    // One query for everything already seen, instead of a read per message.
    // Includes non-PROCESSED rows so a message that ERRORed last run reuses its
    // row and gets retried here, instead of minting a duplicate row per attempt.
    const seenRows = await prisma.webhookEvent.findMany({
      where: { provider: "gmail", externalId: { in: ids.map((id) => `${account.email}:${id}`) } },
      select: { id: true, externalId: true, status: true },
    });
    const seenByExt = new Map(seenRows.map((r) => [r.externalId, r]));

    for (const id of ids) {
      const dedupe = `${account.email}:${id}`;
      const prior = seenByExt.get(dedupe);
      if (prior?.status === "PROCESSED") continue;
      // format=full so we read the MESSAGE, not the ~200-char HTML-encoded
      // preview. The old metadata fetch fed the raw snippet to the classifier,
      // the AI triage, and the task text itself — tasks showed "&#39;" artifacts,
      // quotes cut mid-word, and the brain literally couldn't see what the
      // client asked for past the first two sentences.
      const msg = await gmail<GmailMsg>(`/messages/${id}?format=full`, token);
      const { name, email } = parseFrom(header(msg, "From"));
      const subject = header(msg, "Subject");
      const listUnsub = header(msg, "List-Unsubscribe");
      const snippet = cleanText(msg.snippet ?? "");
      const fullBody = extractBody(msg.payload);
      // The sender's own words (quoted thread history stripped) — what the
      // classifier/brain/task text should reason over. Snippet is the fallback
      // for bodies we couldn't parse.
      const ownWords = stripQuotedReply(fullBody) || snippet;
      const text = `${subject ? subject + " — " : ""}${clip(ownWords, 2000)}`.trim();
      const threadId = msg.threadId ?? id;
      const threadRef = `gmail-thread:${account.email}:${threadId}`;
      const domain = email.includes("@") ? email.split("@")[1] : "";

      // Durability: the dedupe row starts RECEIVED and is stamped PROCESSED only
      // AFTER the message is actually handled (below). The old order — stamp
      // first, handle second — meant a crash or timeout mid-message permanently
      // ate that email; now it's marked ERROR and the next scan retries it.
      const evt = prior
        ? await prisma.webhookEvent.update({ where: { id: prior.id }, data: { status: "RECEIVED", error: null } })
        : await prisma.webhookEvent.create({
            data: { provider: "gmail", eventType: "email", externalId: dedupe, payload: text.slice(0, 1000) },
          });

      // Handle ONE inbound email end-to-end (vendor routing → client reply task
      // → lead); returns how many tasks it created.
      const handleMessage = async (): Promise<number> => {
        if (!text) return 0;

        // A Google Calendar notice (an accepted / declined invitation) is not
        // the client writing: no task, no client log (Oct 27 2026, see
        // isCalendarNotice). Meeting prep comes from Calendly's meeting_prep.
        if (isCalendarNotice({ subject, from: header(msg, "From"), sender: header(msg, "Sender"), body: fullBody || snippet, calendarPart: hasCalendarPart(msg.payload) })) return 0;

        // Luma Visuals = our premium-reel video editor. Only TWO of their emails
        // are work for us: the edit is FINISHED (go download/QC/deliver) or the
        // EDITOR wrote us something (answer them). Everything else — "revision
        // request received", "order received", status pings — is an echo of
        // something WE did; it gets logged to comms memory and creates nothing.
        // (The old handler even raised a REVISION off Luma's revision-received
        // ack — us asking Luma for a fix boomeranged into an urgent task at us.)
        if (domain && LUMA_DOMAINS.includes(domain)) {
          // RETIRED (Jordan, Sep 1 2026: "stop doing these Download + QC the
          // finished Luma reel"): the Luma engagement ended Aug 14 — editing is
          // in-house/Review Room now, so a stray Luma email must never mint
          // work again. The email still logs to comms memory above.
          return 0;
        }

        // AutoHDR (§10 AU-20/A53, Sep 26): its mail used to fall into the
        // vendor drop below unlogged, so a low-credit warning reached nobody.
        // Now it is logged owner-only, a credit/payment warning becomes one
        // task a day for Jordan, and a "batch complete" notice is attached to
        // the batch whose street it names. Never a lead, never a client task.
        if (domain) {
          const vb = await import("@/lib/vendorBalance");
          if (vb.isAutohdrDomain(domain)) {
            const r = await vb.handleAutohdrMail({
              externalId: `gmail-${dedupe}`,
              gmailId: id,
              subject,
              body: fullBody || snippet || text,
              fromEmail: email,
              occurredAt: msg.internalDate ? new Date(Number(msg.internalDate)) : undefined,
              // A newsletter carries List-Unsubscribe; "" = read and absent (Oct 14 2026).
              listUnsubscribe: header(msg, "List-Unsubscribe") ?? "",
            });
            return r.tasksCreated;
          }
        }

        // A TEAMMATE'S REPLY seen in this inbox (Oct 14 2026): james@ answering
        // a client with info@ on cc. Logged as OUR outbound so the walk clears
        // the thread. A connected mailbox's own sends are read from its Sent
        // folder below (Kyle on hello@), so they are left to that reader and
        // never logged twice. Anything else from a staff address — a note to
        // the office, a forward — falls through to the old handling untouched.
        if (!connectedMailboxes.has(email)) {
          const staffRow = staffReplyRow(
            {
              mailbox: account.email,
              messageId: id,
              threadId,
              from: header(msg, "From"),
              to: header(msg, "To"),
              cc: header(msg, "Cc"),
              subject,
              inReplyTo: header(msg, "In-Reply-To"),
              references: header(msg, "References"),
              at: msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(),
              body: clip(ownWords, 5_500),
              fromSentFolder: false,
            },
            book,
            resolveAddress,
            GMAIL_SENT_SOURCE,
          );
          if (staffRow) {
            await logStaffReply(staffRow);
            return 0;
          }
        }

        // ONE OF US WROTE IT (Oct 22 2026, comms audit H3): a staff address
        // (every login and roster email, our domain, Jordan's own gmail) is
        // staff BEFORE any client lookup. A HubSpot contact had linked info@
        // and Jordan's gmail to a client named "Jordan Spackman", and 62 of
        // our own emails (forwards to hello@, notes to Kyle) were logged as
        // that client's, with tasks on it that belonged to Alex, Bernadette
        // and Jeff Scott. A staff FORWARD of a client's email is that
        // client's, read by the forwarded sender's address; anything else
        // from staff is matched by the street it names (hello@ only), else
        // logged unmatched. Staff never become a lead.
        const fromStaff = isStaffAddress(email, book);
        const forwardedFrom = fromStaff ? forwardedSenderAddress(subject, fullBody || snippet, (a) => isStaffAddress(a, book)) : null;
        const lookupAddress = fromStaff ? forwardedFrom : email;
        // Resolve the sender to a client account FIRST (email → synced contact →
        // agent), so a KNOWN client who emails from a brokerage role address
        // (info@/team@/hello@) is never dropped by the human/lead filter below.
        let senderClient = lookupAddress ? clientByEmail.get(lookupAddress) : undefined;
        if (!senderClient && lookupAddress) {
          const cid = contactClientByEmail.get(lookupAddress);
          if (cid) senderClient = clients.find((c) => c.id === cid);
        }
        // WHO WROTE, by name (Sep 28): the From display name when there is one
        // — parseFrom hands a bare address back AS the name, and an address is
        // not a name — else the client row that owns this exact address, BEFORE
        // the assistant→agent fold (she is still herself), and the address
        // itself only when no name exists. A client's own "sarah@x.com" read
        // "Asked by sarah@x.com" to editors while her name sat on the row. (A
        // synced contact's address is not proof of whose row it is, so it
        // doesn't lend a name.)
        const displayName = name && name.toLowerCase() !== email && !name.includes("@") ? name : null;
        // A forward is written by the client it forwards (H3); a staff note by the staff member.
        const writerName = forwardedFrom && senderClient
          ? clientByEmail.get(forwardedFrom)?.name ?? senderClient.name ?? forwardedFrom
          : displayName ?? (fromStaff ? null : clientByEmail.get(email)?.name) ?? (email || null);
        // The sender's OWN row, before the fold: a team assistant's mail goes
        // to the team agent whose job it names (lib/teamRouting, Oct 23 2026).
        const senderOwnId = senderClient?.id ?? null;
        if (senderClient) senderClient = toAgent(senderClient); // fold assistant → agent

        // Drop marketing / invoices / automated / vendor mail — but ONLY for senders
        // we don't already know. A known client always gets logged + a reply task,
        // even from a role address the lead filter would otherwise reject.
        if (!senderClient && !fromStaff && !isLikelyHuman(email, listUnsub, subject, name)) return 0;

        // Already replied to (latest thread message is from us)? Still logged to
        // comms memory below, but it won't create a task — and since Sep 16 our
        // reply is logged too (see `sentReply` at the end of this handler), so
        // the unanswered walk clears the thread on its own next pass instead of
        // waiting for a manual tick.
        const sentReply = await lastFromUs(threadId, token);
        const answered = sentReply !== null;

        // Which listing is this about? Prefer a property named in the subject/body
        // within the sender's OWN orders; otherwise match it GLOBALLY (a coordinator
        // or executive assistant emailing about another agent's property) and route
        // to THAT property's order + owner, not the sender's most-recent job.
        const { findClientProjectByText, findProjectByText, mostRelevantProject } = await import("@/lib/contacts");
        let resolvedClientId: string | null = senderClient?.id ?? null;
        let resolvedClientName: string | null = senderClient?.name ?? null;
        let project: { id: string; title: string; status: string } | null = null;
        // Track HOW the project resolves: a street named in the mail is a real
        // filing; the fallbacks below are guesses, and project-scoped surfaces
        // (the /ops shoot-card comms chip) must know the difference.
        let projectNamed = false;
        // A FOLDED ASSISTANT OR TEAM MEMBER (Oct 23 2026, lib/teamRouting):
        // Olivia Vecere folds onto Mike Flatley, but her mail about Sharra
        // Mercer's 1337 Carolannes Way is Sharra's. The team agent whose own
        // job the mail names (house number and street, or its listing link;
        // subject, then her words, then the quoted thread) takes it, job and
        // all. Nothing named: the fold below decides, as before.
        const team = senderClient
          ? await routeTeamMessage({ senderClientId: senderOwnId, subject, body: fullBody || snippet, directory: teamDirectory })
          : null;
        if (team) {
          resolvedClientId = team.clientId;
          resolvedClientName = team.clientName;
          project = team.project;
          projectNamed = true;
        } else if (senderClient) {
          const named = await findClientProjectByText(senderClient.id, `${subject ?? ""} ${text}`);
          if (named) { project = named; projectNamed = true; }
        }
        // Fall back to a GLOBAL listing match only when we DON'T already know the
        // sender (a coordinator/assistant emailing about an agent's property), or
        // when the match is the sender's OWN listing. Never let it REASSIGN a known
        // client's email to a DIFFERENT client: a fuzzy street match — e.g. the town
        // "West Chester" inside the street "1244 West Chester Pike" — must not hijack
        // a known sender's mail onto someone else's job. Keep it on the real sender.
        // H2 (Oct 22 2026, lib/mailMatch): never for a sender we do not know
        // in Jordan's personal inbox. A memorial email or a refund notice that
        // names a town is not a client's mail. The one exception is the client
        // themself writing from an address the hub does not have yet: the
        // name on the mail is the name of the client whose job it names.
        const streetOk = streetMatchAllowed({ mailbox: account.email, senderKnown: !!senderClient });
        if (!project && (streetOk || (!fromStaff && displayName))) {
          const gp = await findProjectByText(`${subject ?? ""} ${text}`);
          const gpName = gp ? clients.find((c) => c.id === gp.clientId)?.name ?? null : null;
          if (gp && (!senderClient || gp.clientId === senderClient.id) && (streetOk || sameSenderName(displayName, gpName))) {
            project = { id: gp.id, title: gp.title, status: gp.status };
            projectNamed = true; // global match = the street was in the mail
            resolvedClientId = gp.clientId;
            resolvedClientName = clients.find((c) => c.id === gp.clientId)?.name ?? null;
          }
        }
        // No street named anywhere → the sender's most RELEVANT job (next
        // upcoming shoot, else newest active, else newest overall) — not the
        // most recent overall, which pinned new asks to months-old deliveries.
        // EXCEPT a revision-shaped message: "brighten the kitchen photos" is
        // about the newest delivered/in-review job, and the DELIVERED_ISH
        // gates downstream silently drop the revision if we hand them the
        // client's upcoming shoot instead.
        if (!project && senderClient) {
          const { classifyComm } = await import("@/lib/comms");
          const { mostRecentDeliveredIsh } = await import("@/lib/contacts");
          project = classifyComm(text).isRevision ? await mostRecentDeliveredIsh(senderClient.id) : null;
          if (!project) project = await mostRelevantProject(senderClient.id);
        }

        // Comms memory: log EVERY inbound human email so the Hub can recall it —
        // even answered ones and leads. Unknown senders on info@ (Jordan's
        // personal inbox) don't create tasks below, but they're logged owner-only
        // so a missed lead is at least auditable instead of leaving zero trace.
        // The SENDER is the contact; the client is the account it's about.
        const unknownOnPersonal = !resolvedClientId && CLIENTS_ONLY_MAILBOXES.includes(account.email);
        // THE SAME EMAIL IN BOTH INBOXES (Oct 22 2026, comms audit M3). A
        // client who writes to info@ and hello@ sends ONE message with one
        // RFC Message-ID; each inbox gives it its own Gmail id, so it was
        // logged twice (and read twice by the AI). The first inbox to read it
        // claims the Message-ID; a later copy that the first one filed to a
        // client is not logged or read again (our reply in this inbox's thread
        // is still recorded, below). A first copy that found no client
        // (info@ never makes a lead) lets the team inbox read its own copy.
        const midKey = messageIdKey(header(msg, "Message-ID") || header(msg, "Message-Id"));
        if (midKey) {
          const claim = await prisma.webhookEvent.findFirst({ where: { provider: GMAIL_MID_PROVIDER, externalId: `mid:${midKey}` }, select: { payload: true } }).catch(() => null);
          const first = (() => { try { return claim ? (JSON.parse(claim.payload) as { mailbox?: string; clientId?: string | null }) : null; } catch { return null; } })();
          if (first && first.mailbox !== account.email && first.clientId) {
            if (sentReply) await logSentReply({ threadId, msg: sentReply, mailbox: account.email, token, clientId: resolvedClientId, clientName: resolvedClientName, projectId: project?.id ?? null });
            return 0;
          }
          if (!claim) {
            await prisma.webhookEvent.create({
              data: { provider: GMAIL_MID_PROVIDER, eventType: "email", externalId: `mid:${midKey}`, payload: JSON.stringify({ mailbox: account.email, clientId: resolvedClientId, dedupe }), status: "PROCESSED", processedAt: new Date() },
            }).catch(() => null);
          }
        }
        // A staff note that is not a forward (H3) is our own words: it is never
        // logged as the client's message (the reply queue would read the client
        // as waiting on us), only the to-do below goes on the client it names.
        const staffNote = fromStaff && !forwardedFrom;
        await logComm({
          channel: "email",
          direction: "in",
          minRole: unknownOnPersonal ? "OWNER" : undefined,
          clientId: staffNote ? null : resolvedClientId,
          clientName: staffNote ? null : resolvedClientName,
          projectId: staffNote ? null : project?.id ?? null,
          contactName: name || resolvedClientName || null,
          subject,
          // Full body (logComm caps at 6000) so the Hub + the task full-view
          // recall what was actually said, not a preview of it.
          body: fullBody || snippet || text,
          source: "gmail",
          externalId: `gmail-${dedupe}`,
          projectGuess: !!project && !projectNamed,
          // WHEN THEY WROTE, not when this scan got to it (Oct 14 2026). Our
          // replies are stamped with Gmail's own send time, so an inbound row
          // stamped up to five minutes late sorted AFTER a fast answer and
          // the walk kept the client "waiting" over a reply Kyle had already
          // sent. The Handled tick is protected separately: it cuts on when a
          // message reached the hub (replyQueue `loggedAt`), so a message that
          // arrived just before a tick but was logged after it still shows.
          occurredAt: receivedAt(msg.internalDate),
        });

        if (sentReply) {
          // THE RECEIPT (Sep 16). One outbound row, keyed on the message id, so
          // it lands once however many times this thread is re-scanned. Without
          // it the walk has no way to know we answered: the inbox query is
          // `-from:me`, so our side of every email conversation was invisible.
          await logSentReply({
            threadId,
            msg: sentReply,
            mailbox: account.email,
            token,
            clientId: resolvedClientId,
            clientName: resolvedClientName,
            projectId: project?.id ?? null,
          });
        }

        if (answered) {
          // Skip only the reply-task creation for handled mail — still run
          // revision detection: a client's "can you brighten the kitchen" that
          // Kyle answered "on it!" from his phone before this scan used to skip
          // classification entirely, so the project never flipped to REVISION and
          // no editor task existed (audit crack #33). Lands on exactly the mail
          // Kyle answers fastest: unhappy clients.
          if (resolvedClientId && project && ["DELIVERED", "REVISION", "REVIEW"].includes(project.status)) {
            const { classifyComm, raiseRevision } = await import("@/lib/comms");
            if (classifyComm(text).isRevision) {
              const raised = await raiseRevision({
                projectId: project.id,
                clientId: resolvedClientId,
                clientName: resolvedClientName,
                propertyAddress: project.title,
                note: text,
                source: "gmail",
                // Carry the thread so the revision's email-ack path can reply
                // in-thread (a NULL sourceDetail makes sendEmailReply reject).
                threadRef,
                // The person who wrote, not the account it folded to (an
                // assistant, or a coordinator on another agent's listing).
                requestedBy: { name: writerName, kind: "EMAIL" },
              });
              return raised ? 1 : 0;
            }
          }
          // ITS ASKS ARE FILED ANYWAY (Oct 22 2026, comms audit M6). Kyle
          // answering inside the 5-minute scan used to skip ask filing
          // altogether, so "can we move the shoot to Friday" answered "let me
          // check" from his phone never reached the Scheduling screen. The
          // asks are filed and marked as answered by our reply (lib/answeredAsks):
          // a holding reply leaves them open.
          if (resolvedClientId) {
            const { fileAnsweredEmailAsks } = await import("@/lib/answeredAsks");
            await fileAnsweredEmailAsks({
              clientId: resolvedClientId, clientName: resolvedClientName, contactName: writerName,
              message: text, projectId: project?.id ?? null, replyAt: sentReply?.at ?? null, mailbox: account.email, threadId, sentReplyId: sentReply?.id ?? null, inboundExternalId: `gmail-${dedupe}`,
              senderClientId: senderOwnId,
            }).catch((e) => console.error("[gmail] filing an answered email's asks failed", e));
          }
          return 0; // logged above; don't create a task for handled mail
        }

        if (resolvedClientId) {
          await recordClientCommunication({
            clientId: resolvedClientId,
            clientName: resolvedClientName || name,
            // The real person who wrote in. When their email folded to an agent's
            // account (assistant → agent), this keeps the human on the task instead
            // of showing the agent who never sent anything. By NAME — see writerName.
            contactName: writerName,
            projectId: project?.id,
            projectStatus: project?.status ?? null,
            propertyAddress: project?.title ?? null,
            text,
            kind: "email",
            source: "gmail",
            threadRef,
            // Her own row: an ask naming another team agent's job goes there (lib/teamRouting).
            senderClientId: senderOwnId,
          });
          return 1;
        } else if (fromStaff) {
          // Our own mail that names no client (H3): logged above, never a lead.
          return 0;
        } else if (CLIENTS_ONLY_MAILBOXES.includes(account.email)) {
          // info@ is Jordan's personal account — only surface known clients,
          // never manufacture "leads" from his personal mail. hello@ still does.
          // (Logged owner-only above so the skip is auditable.)
          return 0;
        } else {
          // Unknown human → a lead. One open lead task per sender.
          const key = `lead-${email}`;
          const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
          if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") return 0;
          // Disregarded as spam on the lead row (Kyle, Oct 26 2026): that sender
          // opens no new lead. The mail is still logged above.
          if (existing?.status === "CANCELLED" && isSpamDismissal(existing.summary)) return 0;
          // Kyle by the delivery duty (leadDesk.leadAssignee, never a name
          // search); nobody when it does not resolve, as before (Oct 14 2026).
          const { leadAssignee, startLeadEpisode } = await import("@/lib/leadDesk");
          const desk = await leadAssignee();
          const data = {
            taskType: "lead",
            title: `New lead: ${name || email}`.slice(0, 120),
            summary: `New inbound inquiry to ${account.email} from ${name || email}: “${clip(text, 200)}”. Qualify (listing, timeline, budget) and reply / book a strategy call.`.slice(0, 500),
            description: clip(text, 1200),
            reasonCreated: `New inbound email to ${account.email}`,
            checklist: JSON.stringify(["Read the email", "Qualify (listing, timeline, budget)", "Reply / book a strategy call", "Add to CRM"]),
            source: "gmail",
            sourceDetail: threadRef,
            priority: "HIGH" as const,
            dueAt: new Date(Date.now() + 4 * 3600_000),
            ownerId: desk.ownerId,
            dedupeKey: key,
          };
          const leadId = existing
            ? (await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null }, select: { id: true } })).id
            : (await prisma.smartTask.create({ data: { ...data, assignedKey: desk.assignedKey }, select: { id: true } })).id;
          // On Kyle's list, and the 15/60-minute pings count from now.
          await startLeadEpisode(leadId);
          // A new lead shouldn't wait for someone to open the hub — Slack ping +
          // in-app bell mirror, deduped per sender per day (best-effort).
          try {
            const { notifyUrgent, notifyInApp } = await import("@/lib/notify");
            await notifyUrgent(data.title);
            await notifyInApp({
              kind: "new_lead",
              title: `New lead — ${name || email}`,
              href: "/queue",
              targets: [{ roles: ["OWNER", "ADMIN"] }],
              dedupeKey: `lead-em-${email}-${new Date().toISOString().slice(0, 10)}`,
            });
          } catch { /* never break the scan on a notify failure */ }
          return 1;
        }
      };

      try {
        tasks += await handleMessage();
        await prisma.webhookEvent.update({ where: { id: evt.id }, data: { status: "PROCESSED", processedAt: new Date() } });
      } catch (e) {
        // One bad message must not eat the rest of the scan (or itself, forever):
        // mark ITS row ERROR — it stays retryable on the next run — and move on.
        await prisma.webhookEvent
          .update({ where: { id: evt.id }, data: { status: "ERROR", error: (e instanceof Error ? e.message : String(e)).slice(0, 500) } })
          .catch(() => {});
      }
    }

    // ---- THIS MAILBOX'S SENT FOLDER (Oct 14 2026) ----------------------------
    // The inbox query is `-from:me`, so a reply Kyle sends from hello@ was only
    // ever seen when the CLIENT's next message got processed — and never at all
    // by info@ when he didn't reply-all. Read the replies this mailbox sent in
    // the last two days and log each one to a client as our outbound; the walk
    // then clears the thread in every inbox it landed in. One Gmail read per
    // NEW sent message (the WebhookEvent ledger remembers the rest), capped per
    // run, best-effort: a failure here never costs the scan above.
    try {
      const sent = await gmail<{ messages?: { id: string; threadId?: string }[] }>(
        "/messages?q=" + encodeURIComponent("in:sent newer_than:2d") + "&maxResults=50",
        token,
      );
      const list = sent.messages ?? [];
      const sentKeys = list.map((m) => `${account.email}:${m.id}`);
      const done = new Set(
        sentKeys.length
          ? (await prisma.webhookEvent.findMany({ where: { provider: "gmail-sent", externalId: { in: sentKeys } }, select: { externalId: true } })).map((r) => r.externalId)
          : [],
      );
      let reads = 0;
      for (const m of list) {
        const key = `${account.email}:${m.id}`;
        if (done.has(key)) continue;
        if (reads++ >= 25) break; // the rest catch the next tick
        try {
          const full = await gmail<GmailMsg>(`/messages/${m.id}?format=full`, token);
          const subject = header(full, "Subject");
          const row = staffReplyRow(
            {
              mailbox: account.email,
              messageId: m.id,
              threadId: full.threadId ?? m.threadId ?? m.id,
              from: header(full, "From"),
              to: header(full, "To"),
              cc: header(full, "Cc"),
              subject,
              inReplyTo: header(full, "In-Reply-To"),
              references: header(full, "References"),
              at: full.internalDate ? new Date(Number(full.internalDate)) : new Date(),
              body: clip(stripQuotedReply(extractBody(full.payload)) || cleanText(full.snippet ?? ""), 5_500),
              fromSentFolder: true,
            },
            book,
            resolveAddress,
            GMAIL_SENT_SOURCE,
          );
          if (row) await logStaffReply(row);
          await prisma.webhookEvent.create({
            data: { provider: "gmail-sent", eventType: "email_sent", externalId: key, payload: (subject || "").slice(0, 300), status: "PROCESSED", processedAt: new Date() },
          });
        } catch { /* unrecorded → retried next tick */ }
      }
    } catch { /* the sent read is a courtesy to the walk — never fail the scan */ }
  }

  // Reply sweep: close any open email-driven task whose thread we've since
  // answered (latest message is from us). This keeps "Check your messages" to
  // only the messages that still need a response.
  let closed = 0;
  const openEmailTasks = await prisma.smartTask.findMany({
    where: {
      source: "gmail",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      sourceDetail: { startsWith: "gmail-thread:" },
      // A REVISION (or edit) raised from an email is a WORK ORDER, not a
      // "reply to this thread" card — replying "we're on it" must not mark
      // the re-edit done and strand the project in REVISION (Aug 18 audit:
      // resolveRevision was bypassed, projects stuck in REVISION forever).
      taskType: { notIn: ["revision", "edit_video"] },
    },
    select: { id: true, sourceDetail: true, clientId: true },
  });
  for (const t of openEmailTasks) {
    const [, mailbox, threadId] = (t.sourceDetail ?? "").split(":");
    const tk = mailbox ? tokens.get(mailbox) : undefined;
    if (!tk || !threadId) continue;
    const tail = await threadTail(threadId, tk);
    if (!tail) continue; // unreadable — never close on ignorance
    if (tail.reply) {
      // A HOLDING REPLY IS NOT AN ANSWER (Oct 22 2026, comms audit H4): "let
      // me check and I'll get back to you" leaves the task open. Our reply's
      // words are on its logged row (logSentReply's key); unread words close
      // as before.
      const said = await prisma.commLog.findUnique({ where: { externalId: `gmail-sent-${threadId}-${tail.reply.id}` }, select: { body: true } }).catch(() => null);
      if (said && isHoldingReply(said.body)) continue;
      await prisma.smartTask.update({ where: { id: t.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      closed++;
      continue;
    }
    // ANSWERED FROM THE OTHER INBOX (Oct 14 2026). The task sits on info@'s
    // copy of the thread; Kyle answered from hello@ without copying info@, so
    // this thread's tail is still the client. Our reply is on record all the
    // same (the sent-folder read above), on the same subject and after the
    // client's last message — that is the same conversation answered. The
    // close is dated to the REPLY, not to now: a completed gmail task is a
    // cut point on the client's email lane (replyQueue handledByClient), and
    // anything the client wrote after the reply must stay waiting.
    if (!t.clientId || !tail.lastInbound) continue;
    const want = threadSubject(tail.lastInbound.subject);
    if (!want) continue;
    const replies = await prisma.commLog.findMany({
      where: { channel: "email", direction: "out", clientId: t.clientId, occurredAt: { gt: tail.lastInbound.at } },
      orderBy: { occurredAt: "asc" },
      select: { channel: true, subject: true, source: true, body: true, occurredAt: true },
    });
    const answer = replies.find((r) => threadSubject(r.subject) === want && outboundIsAnswer(r));
    if (answer) {
      await prisma.smartTask.update({ where: { id: t.id }, data: { status: "COMPLETED", completedAt: answer.occurredAt } });
      closed++;
    }
  }
  // The human's word counts too. A sender ticked "Handled" on the Comms board
  // after their last email is answered as far as this hub is concerned — they
  // were phoned, or replied to from a handset Gmail never saw — yet the check
  // above only trusts the thread, so "Update Kimberly's portal access" stayed
  // open 54 days past its tick (Sep 8 audit). The tick now completes the task
  // itself; this is the backstop for acks written before that and for a tick
  // the action never reached. Best-effort: it must never fail the scan.
  try {
    closed += await closeAckedEmailReplyTasks();
  } catch { /* the reply sweep above already did its job */ }
  void closed;

  // ---- the UNTASKED sweep (Sep 16) ----------------------------------------
  // The two sweeps above both ride on a TASK. Rick Schultz never had one: he
  // wrote on Sep 15, `threadAlreadyAnswered` was already true at scan time, so
  // no client_reply was minted — and with our reply unlogged, the walk kept
  // him on the board with no way out but a manual tick. So: take the inbound
  // client emails of the last week that carry NO reply task and NO logged
  // answer, ask Gmail once per thread whether we've since replied, and log the
  // receipt when we have. Capped and cached — one threads.get per thread, and
  // only for threads that are actually still showing as waiting.
  try {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const inbound = await prisma.commLog.findMany({
      where: { channel: "email", direction: "in", source: "gmail", clientId: { not: null }, occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
      select: { clientId: true, clientName: true, projectId: true, externalId: true, occurredAt: true },
      take: 120,
    });
    // Clients whose thread we already know we answered, and clients whose open
    // reply task the sweeps above handle — neither needs a Gmail call.
    const clientIds = [...new Set(inbound.map((r) => r.clientId as string))];
    const [answeredRows, taskRows] = await Promise.all([
      clientIds.length
        ? prisma.commLog.findMany({
            where: { channel: "email", direction: "out", clientId: { in: clientIds }, occurredAt: { gte: since } },
            select: { clientId: true, occurredAt: true },
          })
        : Promise.resolve([] as { clientId: string | null; occurredAt: Date }[]),
      clientIds.length
        ? prisma.smartTask.findMany({
            where: { clientId: { in: clientIds }, taskType: "client_reply", source: "gmail", status: OPEN_REPLY },
            select: { clientId: true },
          })
        : Promise.resolve([] as { clientId: string | null }[]),
    ]);
    const answeredAt = new Map<string, number>();
    for (const a of answeredRows) {
      if (!a.clientId) continue;
      answeredAt.set(a.clientId, Math.max(answeredAt.get(a.clientId) ?? 0, a.occurredAt.getTime()));
    }
    const hasTask = new Set(taskRows.map((t) => t.clientId).filter((x): x is string => !!x));
    const threadSeen = new Set<string>();
    let checks = 0;
    for (const r of inbound) {
      if (checks >= 15) break; // one run's budget — the rest catch the next tick
      const cid = r.clientId as string;
      if (hasTask.has(cid)) continue; // the task sweeps above own this one
      if ((answeredAt.get(cid) ?? 0) >= r.occurredAt.getTime()) continue; // already on record
      // externalId is `gmail-<mailbox>:<messageId>` (logComm, above).
      const raw = (r.externalId ?? "").replace(/^gmail-/, "");
      const at = raw.lastIndexOf(":");
      if (at <= 0) continue;
      const mailbox = raw.slice(0, at);
      const msgId = raw.slice(at + 1);
      const tk = tokens.get(mailbox);
      if (!tk || !msgId) continue;
      checks++;
      let threadId: string | null = null;
      try {
        const m = await gmail<GmailMsg>(`/messages/${msgId}?format=minimal`, tk);
        threadId = m.threadId ?? null;
      } catch { continue; }
      if (!threadId || threadSeen.has(threadId)) continue;
      threadSeen.add(threadId);
      const sent = await lastFromUs(threadId, tk);
      if (!sent) continue;
      await logSentReply({
        threadId,
        msg: sent,
        mailbox,
        token: tk,
        clientId: cid,
        clientName: r.clientName,
        projectId: r.projectId,
      });
    }
  } catch { /* best-effort: the boards are no worse off than before */ }

  // Health last, so a slow report can never cost a message its scan.
  await reportReads().catch((e) => console.warn("gmail read-health report failed", e));
  // CONNECTIONS' "LAST SYNC" (audit Oct 25 2026, G11): the Google card read
  // Oct 21 while this scan ran every 5 minutes, because only the Drive
  // call-record sweep stamped the gmail row. A scan that read at least one
  // inbox stamps it now, in one conditional write that lands at most every
  // 10 minutes. Only the time: the status and the error stay with the code
  // that owns them (an unread inbox has its own row and task on that page).
  if (mailboxes.some((m) => m.ok)) {
    await prisma.connection
      .updateMany({ where: { provider: "gmail", OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(Date.now() - GMAIL_SYNC_STAMP_MS) } }] }, data: { lastSyncedAt: new Date() } })
      .catch(() => {});
  }
  // `degraded` FIRST: the cron summary clips each step's result at 300
  // characters, and /connections reads this flag off the stored run.
  return { degraded: mailboxes.some((m) => !m.ok), scanned, tasks, mailboxes };
}
