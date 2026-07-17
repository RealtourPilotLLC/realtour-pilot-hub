import "server-only";
import { prisma } from "@/lib/prisma";
import { getSecret } from "./connections";
import { cleanText, clip, stripQuotedReply } from "@/lib/text";

// ---------------------------------------------------------------------------
// Google / Gmail integration (OAuth2 with offline refresh tokens, read-only).
// Reads recent client emails and turns them into tasks — same listener model
// as OpenPhone/Slack. Never sends. App credentials come from env; the per-user
// refresh token is stored encrypted as the "gmail" connection.
// ---------------------------------------------------------------------------

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send", // lets the hub email Jordan (e.g. new feedback)
  "https://www.googleapis.com/auth/userinfo.email",
];

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
      const res = await fetch(
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

// Send a real threaded REPLY from one of our mailboxes — the human-reviewed
// draft behind the task "Send email" button. Loads the thread, replies to the
// latest message that isn't ours (proper In-Reply-To/References + Re: subject,
// same threadId) so it lands inside the conversation in everyone's inbox.
async function gmailReplyTarget(
  mailbox: string,
  threadId: string,
): Promise<
  | { ok: true; token: string; acctEmail: string; to: string; subject: string; msgId: string }
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
      `/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=Reply-To`,
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
  return { ok: true, token, acctEmail: acct.email, to, subject, msgId: header(target, "Message-ID") };
}

// Who a reply to this thread would go to — the UI shows it before Send.
export async function resolveGmailReplyTarget(
  mailbox: string,
  threadId: string,
): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const t = await gmailReplyTarget(mailbox, threadId);
  return t.ok ? { ok: true, to: t.to } : { ok: false, error: t.error };
}

export async function sendGmailReply(opts: {
  mailbox: string;
  threadId: string;
  body: string;
  /** The recipient the human confirmed — abort if the thread changed under them. */
  expectedTo?: string;
}): Promise<{ ok: true; to: string; subject: string } | { ok: false; error: string; needsReconnect?: boolean }> {
  const t = await gmailReplyTarget(opts.mailbox, opts.threadId);
  if (!t.ok) return t;
  const { token, acctEmail, to, subject, msgId } = t;
  if (opts.expectedTo && opts.expectedTo.toLowerCase() !== to.toLowerCase()) {
    return { ok: false, error: `The thread changed — the reply would now go to ${to}, not ${opts.expectedTo}. Re-open and confirm.` };
  }

  const mime = [
    `To: ${to}`,
    `From: ${acctEmail}`,
    // RFC 2047-encode so names/subjects with non-ASCII survive.
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    ...(msgId ? [`In-Reply-To: ${msgId}`, `References: ${msgId}`] : []),
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
  return { ok: true, to, subject };
}

export function googleConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function appBase() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}
export function googleRedirectUri() {
  return `${appBase()}/api/google/callback`;
}

export function googleAuthorizeUrl(): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", googleRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("scope", SCOPES.join(" "));
  return u.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error_description as string) || (json.error as string) || `Google token ${res.status}`);
  return json;
}

export async function exchangeGoogleCode(code: string): Promise<{ refreshToken: string }> {
  const json = await tokenRequest({
    code: code.trim(),
    grant_type: "authorization_code",
    redirect_uri: googleRedirectUri(),
  });
  const refreshToken = json.refresh_token as string | undefined;
  if (!refreshToken) throw new Error("Google did not return a refresh token. Remove the app's access and re-authorize.");
  return { refreshToken };
}

async function accessTokenFor(refreshToken: string): Promise<string> {
  const json = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return json.access_token as string;
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

async function gmail<T = unknown>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
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

type GmailPart = { mimeType?: string; body?: { data?: string; size?: number }; parts?: GmailPart[]; headers?: { name: string; value: string }[] };
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

// True if the most recent message in the thread was sent by us — i.e. we've
// already replied, so there's nothing for Kyle to action.
async function threadAlreadyAnswered(threadId: string, token: string): Promise<boolean> {
  try {
    const thread = await gmail<GmailThread>(
      `/threads/${threadId}?format=metadata&metadataHeaders=From`,
      token,
    );
    const msgs = thread.messages ?? [];
    if (msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    const from = header(last, "From").toLowerCase();
    return from.includes("@" + OUR_DOMAIN);
  } catch {
    return false; // if we can't tell, don't suppress
  }
}

// ---------------------------------------------------------------------------
// Reading email threads (for the "see the conversation" view on a client page).
// Read-only; we only ever display, never send.
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
export async function syncGmail(): Promise<{ scanned: number; tasks: number }> {
  const { recordClientCommunication } = await import("@/lib/comms");
  const { logComm } = await import("@/lib/commLog");
  const accounts = await gmailAccounts();
  if (accounts.length === 0) throw new Error("Gmail is not connected.");

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
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });

  let scanned = 0;
  let tasks = 0;
  const tokens = new Map<string, string>(); // mailbox email -> access token (for the reply sweep)

  for (const account of accounts) {
    let token: string;
    try {
      token = await accessTokenFor(account.refreshToken);
    } catch {
      continue; // token revoked / expired — skip this mailbox
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

        // Luma Visuals = our premium-reel video editor. Only TWO of their emails
        // are work for us: the edit is FINISHED (go download/QC/deliver) or the
        // EDITOR wrote us something (answer them). Everything else — "revision
        // request received", "order received", status pings — is an echo of
        // something WE did; it gets logged to comms memory and creates nothing.
        // (The old handler even raised a REVISION off Luma's revision-received
        // ack — us asking Luma for a fix boomeranged into an urgent task at us.)
        if (domain && LUMA_DOMAINS.includes(domain)) {
          const subj = subject || "";
          // 1) Acks of our own submissions → do nothing.
          if (/\b(request|order)\s+(received|submitted)\b/i.test(subj) || /^thank(s| you)/i.test(subj)) return 0;

          const isDone = /\b(ready|complete|completed|delivered|approved|final(ized)?)\b/i.test(subj);
          const local = (email.split("@")[0] || "").toLowerCase();
          const editorMsg =
            /\b(message from your editor|question|comment|note from)\b/i.test(subj) ||
            // A real person at Luma (not status@/no-reply@ automation) emailed us.
            (!AUTOMATED_LOCAL.test(local) && !/^(status|updates?)$/.test(local));
          // 2) Neither finished nor a human message → status ping; log only.
          if (!isDone && !editorMsg) return 0;

          const matchedClient = clients.find((c) => c.name && subj.toLowerCase().includes(c.name.toLowerCase()));
          // Which JOB is this about? Match the street named in the subject within
          // the client's orders so two reels in flight get separate tasks.
          let lumaProject: { id: string; title: string } | null = null;
          if (matchedClient) {
            const subjLower = subj.toLowerCase();
            const projs = await prisma.project.findMany({
              where: { clientId: matchedClient.id },
              orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { shootDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
              select: { id: true, title: true },
            });
            lumaProject = projs.find((p) => { const c = streetCore(p.title); return c.length >= 4 && subjLower.includes(c); }) ?? null;
          }
          const street = lumaProject ? lumaProject.title.split(",")[0] : matchedClient?.name ?? "see tracker";
          const subjectKey = subj.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
          const kind = isDone ? "done" : "msg";
          const key = matchedClient
            ? `luma-client-${matchedClient.id}-${lumaProject?.id ?? (subjectKey || threadId)}-${kind}`
            : `luma-${threadId}`;

          // The finished edit is positive evidence — close any open chase/update
          // tasks for this job before minting the "go get it" task.
          if (isDone && lumaProject) {
            await prisma.smartTask.updateMany({
              where: {
                projectId: lumaProject.id,
                status: { notIn: ["COMPLETED", "CANCELLED"] },
                OR: [{ taskType: "vendor_update" }, { dedupeKey: { startsWith: `vendor-chase-${lumaProject.id}` } }, { dedupeKey: { startsWith: `luma-dispatch-${lumaProject.id}` } }],
              },
              data: { status: "COMPLETED", completedAt: new Date() },
            }).catch(() => {});
          }

          const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
          if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") return 0;
          const data = {
            taskType: "vendor_update",
            title: isDone
              ? `Download + QC the finished Luma reel — ${street}`
              : `Answer Luma's editor — ${street}`,
            summary: isDone
              ? `Luma says the edit is finished: “${clip(text, 180)}”. Download it from the tracker, QC it, deliver to the client, and update the job.`.slice(0, 500)
              : `Luma's editor wrote us: “${clip(text, 200)}”. Read it in the tracker and answer so the edit keeps moving.`.slice(0, 500),
            description: clip(text, 1200),
            reasonCreated: isDone ? "Luma Visuals: edit finished" : "Luma Visuals: message from the editor",
            checklist: JSON.stringify(
              isDone
                ? ["Open the Luma tracker: https://portal.lumavisuals.co/", "Download the finished reel", "QC it (per the QC SOP)", "Deliver to the client + update the project"]
                : ["Open the Luma tracker: https://portal.lumavisuals.co/", "Read the editor's message", "Answer them so the edit keeps moving"],
            ),
            source: "gmail",
            sourceDetail: threadRef,
            priority: "HIGH" as const,
            dueAt: new Date(Date.now() + 4 * 3600_000),
            ownerId: kyle?.id ?? null,
            // KYLE's job (unassigned = his by default) — the vendor is named in
            // the title; assigning to "luma" hid it from every human surface.
            assignedKey: null,
            clientId: matchedClient?.id ?? null,
            // A finished edit is definitionally about an ALREADY-SHOT job —
            // never the client's upcoming shoot, so no mostRelevantProject
            // here: most-recent-overall is the job whose edit was in flight.
            projectId: lumaProject?.id ?? matchedClient?.projects[0]?.id ?? null,
            dedupeKey: key,
          };
          if (existing) await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
          else await prisma.smartTask.create({ data });
          return 1;
        }

        // Resolve the sender to a client account FIRST (email → synced contact →
        // agent), so a KNOWN client who emails from a brokerage role address
        // (info@/team@/hello@) is never dropped by the human/lead filter below.
        let senderClient = clientByEmail.get(email);
        if (!senderClient) {
          const cid = contactClientByEmail.get(email);
          if (cid) senderClient = clients.find((c) => c.id === cid);
        }
        if (senderClient) senderClient = toAgent(senderClient); // fold assistant → agent

        // Drop marketing / invoices / automated / vendor mail — but ONLY for senders
        // we don't already know. A known client always gets logged + a reply task,
        // even from a role address the lead filter would otherwise reject.
        if (!senderClient && !isLikelyHuman(email, listUnsub, subject, name)) return 0;

        // Already replied to (latest thread message is from us)? Still logged to
        // comms memory below, but it won't create a task.
        const answered = await threadAlreadyAnswered(threadId, token);

        // Which listing is this about? Prefer a property named in the subject/body
        // within the sender's OWN orders; otherwise match it GLOBALLY (a coordinator
        // or executive assistant emailing about another agent's property) and route
        // to THAT property's order + owner, not the sender's most-recent job.
        const { findClientProjectByText, findProjectByText, mostRelevantProject } = await import("@/lib/contacts");
        let resolvedClientId: string | null = senderClient?.id ?? null;
        let resolvedClientName: string | null = senderClient?.name ?? null;
        let project: { id: string; title: string; status: string } | null = null;
        if (senderClient) {
          const named = await findClientProjectByText(senderClient.id, `${subject ?? ""} ${text}`);
          if (named) project = named;
        }
        // Fall back to a GLOBAL listing match only when we DON'T already know the
        // sender (a coordinator/assistant emailing about an agent's property), or
        // when the match is the sender's OWN listing. Never let it REASSIGN a known
        // client's email to a DIFFERENT client: a fuzzy street match — e.g. the town
        // "West Chester" inside the street "1244 West Chester Pike" — must not hijack
        // a known sender's mail onto someone else's job. Keep it on the real sender.
        if (!project) {
          const gp = await findProjectByText(`${subject ?? ""} ${text}`);
          if (gp && (!senderClient || gp.clientId === senderClient.id)) {
            project = { id: gp.id, title: gp.title, status: gp.status };
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
        await logComm({
          channel: "email",
          direction: "in",
          minRole: unknownOnPersonal ? "OWNER" : undefined,
          clientId: resolvedClientId,
          clientName: resolvedClientName,
          projectId: project?.id ?? null,
          contactName: name || resolvedClientName || null,
          subject,
          // Full body (logComm caps at 6000) so the Hub + the task full-view
          // recall what was actually said, not a preview of it.
          body: fullBody || snippet || text,
          source: "gmail",
          externalId: `gmail-${dedupe}`,
        });

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
              });
              return raised ? 1 : 0;
            }
          }
          return 0; // logged above; don't create a task for handled mail
        }

        if (resolvedClientId) {
          await recordClientCommunication({
            clientId: resolvedClientId,
            clientName: resolvedClientName || name,
            // The real person who wrote in. When their email folded to an agent's
            // account (assistant → agent), this keeps the human on the task instead
            // of showing the agent who never sent anything.
            contactName: name || null,
            projectId: project?.id,
            projectStatus: project?.status ?? null,
            propertyAddress: project?.title ?? null,
            text,
            kind: "email",
            source: "gmail",
            threadRef,
          });
          return 1;
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
            ownerId: kyle?.id ?? null,
            dedupeKey: key,
          };
          if (existing) await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
          else await prisma.smartTask.create({ data });
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
    },
    select: { id: true, sourceDetail: true },
  });
  for (const t of openEmailTasks) {
    const [, mailbox, threadId] = (t.sourceDetail ?? "").split(":");
    const tk = mailbox ? tokens.get(mailbox) : undefined;
    if (!tk || !threadId) continue;
    if (await threadAlreadyAnswered(threadId, tk)) {
      await prisma.smartTask.update({ where: { id: t.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      closed++;
    }
  }
  void closed;

  return { scanned, tasks };
}
