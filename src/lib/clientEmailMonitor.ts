import "server-only";
import { prisma } from "@/lib/prisma";
import { canonicalInbox, isStaffControlledEmail, isSyntheticClientRow, isVerifiedTestDestinationEmail } from "@/lib/testClients";

// ---------------------------------------------------------------------------
// A COPY OF EVERY CLIENT EMAIL, TO JORDAN (Oct 12 2026).
//
// Jordan: "Anytime a client gets an email, I want to receive that email too so
// I can monitor what the emails look like."
//
// HOW. The copy rides on the client's OWN message as a blind copy (a `Bcc:`
// header in the raw MIME the hub hands to Gmail). Gmail's send endpoint reads
// To/Cc/Bcc to decide who receives the message and strips the Bcc header from
// what it delivers, so the client sees exactly what they saw before — same
// sender, same subject, same body, no extra name on the To line — and Jordan
// receives the identical message.
//
// THE ONE EXCEPTION: ONE-USE SIGN-IN LINKS. A portal sign-in email (and any
// reminder, script or strategy notice that carries one) holds a link that signs
// whoever presses it in AS THE CLIENT and is spent by that press. A blind copy
// is byte-for-byte the client's message, so it would hand Jordan a live key to
// the client's account: one stray click and he is signed in as them, their
// link is dead, and the portal records the client as having signed in. A Bcc
// cannot carry a different body, so for those messages Jordan gets a SEPARATE
// copy, sent only after the client's message was accepted, with each sign-in
// link replaced by SIGN_IN_LINK_REMOVED. Shared portal links (/portal/<token>)
// and the session-address form link are not sign-ins and are kept as they are.
//
// WHAT IS NEVER COPIED: staff-only and internal email (the owner's own
// notifications, anything addressed to a realtourpilot.com mailbox or to a
// person on the team), and a message whose recipient already IS the monitor
// inbox (a TEST client writing to Jordan's own address).
//
// FAILING SAFE. The setting is one AppSetting row. A missing row, a row that
// cannot be read or parsed, or a database error all mean the default — ON, to
// info@realtourpilot.com. Nothing in here throws into a send: a client's email
// never fails because of the copy, and a failed separate copy is logged and
// dropped.
// ---------------------------------------------------------------------------

export const CLIENT_EMAIL_MONITOR_KEY = "client-email-monitor";
export const DEFAULT_MONITOR_ADDRESS = "info@realtourpilot.com";
export const SIGN_IN_LINK_REMOVED = "[sign-in link removed from your copy]";

export type ClientEmailMonitor = {
  enabled: boolean;
  address: string;
  /** default = no row yet; saved = the stored row; unreadable = a row or read that failed (the default applies). */
  source: "default" | "saved" | "unreadable";
  updatedAt?: string | null;
  updatedBy?: string | null;
};

const EMAIL_RE = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;

/** A single, header-safe address, lower-cased — or null. No CR/LF can ever reach a MIME header through here. */
export function cleanMonitorAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v || v.length > 254 || /[\r\n]/.test(v) || !EMAIL_RE.test(v)) return null;
  return v;
}

/** The stored row's value, read defensively: anything short of a clear "enabled: false" is ON. */
export function parseClientEmailMonitor(value: string | null | undefined): ClientEmailMonitor {
  if (value === null || value === undefined) return { enabled: true, address: DEFAULT_MONITOR_ADDRESS, source: "default" };
  try {
    const v = JSON.parse(value) as { enabled?: unknown; address?: unknown } | null;
    if (!v || typeof v !== "object") return { enabled: true, address: DEFAULT_MONITOR_ADDRESS, source: "unreadable" };
    const address = cleanMonitorAddress(v.address);
    return { enabled: v.enabled !== false, address: address ?? DEFAULT_MONITOR_ADDRESS, source: address || v.address === undefined ? "saved" : "unreadable" };
  } catch {
    return { enabled: true, address: DEFAULT_MONITOR_ADDRESS, source: "unreadable" };
  }
}

/** The live setting. Read fresh on every client email (one indexed row) — so a change on Settings applies to the very next send. Never throws. */
export async function clientEmailMonitor(): Promise<ClientEmailMonitor> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: CLIENT_EMAIL_MONITOR_KEY } });
    const parsed = parseClientEmailMonitor(row?.value ?? null);
    return row ? { ...parsed, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy ?? null } : parsed;
  } catch {
    return { enabled: true, address: DEFAULT_MONITOR_ADDRESS, source: "unreadable" };
  }
}

export async function saveClientEmailMonitor(input: { enabled: boolean; address: string }, updatedBy: string | null): Promise<ClientEmailMonitor> {
  const address = cleanMonitorAddress(input.address);
  if (!address) throw new Error("That doesn't look like an email address.");
  const value = JSON.stringify({ enabled: input.enabled !== false, address });
  await prisma.appSetting.upsert({
    where: { key: CLIENT_EMAIL_MONITOR_KEY },
    create: { key: CLIENT_EMAIL_MONITOR_KEY, value, updatedBy },
    update: { value, updatedBy },
  });
  return clientEmailMonitor();
}

// ---- one-use sign-in links ---------------------------------------------------

/** A portal sign-in link (`/portal/auth/<token>`, with any `?next=` riding on
 *  it). Only these are one-use credentials; `/portal/<token>` is a shared link
 *  and `/portal/address/<token>` opens one session's address form. */
const ONE_USE_SIGN_IN_LINK = /(?:https?:\/\/[^\s<>"']*)?\/portal\/auth\/[A-Za-z0-9_-]+[^\s<>"')\]]*/gi;

export function hasOneUseSignInLink(body: string): boolean {
  ONE_USE_SIGN_IN_LINK.lastIndex = 0;
  const hit = ONE_USE_SIGN_IN_LINK.test(body);
  ONE_USE_SIGN_IN_LINK.lastIndex = 0;
  return hit;
}

export function redactOneUseSignInLinks(body: string): { body: string; removed: number } {
  let removed = 0;
  const out = body.replace(ONE_USE_SIGN_IN_LINK, () => {
    removed++;
    return SIGN_IN_LINK_REMOVED;
  });
  return { body: out, removed };
}

// ---- the decision --------------------------------------------------------------

export type ClientEmailCopyPlan =
  /** Nothing goes to the monitor — why, in words (for drills and logs; never the recipient). */
  | { mode: "none"; why: "internal" | "off" | "recipient_is_monitor" | "staff_recipient" | "no_recipient" }
  /** Blind copy on the client's own message. */
  | { mode: "bcc"; address: string }
  /** A separate message to the monitor, sent after the client's was accepted, sign-in links removed. */
  | { mode: "copy"; address: string; body: string };

/** The pure half: given the setting and what is known about the recipient. */
export function planClientEmailCopyWith(
  monitor: Pick<ClientEmailMonitor, "enabled" | "address">,
  input: { to: string; body: string; internal?: boolean; staffRecipient?: boolean },
): ClientEmailCopyPlan {
  if (input.internal) return { mode: "none", why: "internal" };
  if (!monitor.enabled) return { mode: "none", why: "off" };
  const to = (input.to ?? "").trim();
  if (!to) return { mode: "none", why: "no_recipient" };
  const address = cleanMonitorAddress(monitor.address) ?? DEFAULT_MONITOR_ADDRESS;
  if (canonicalInbox(to) === canonicalInbox(address)) return { mode: "none", why: "recipient_is_monitor" };
  if (input.staffRecipient || isStaffControlledEmail(to)) return { mode: "none", why: "staff_recipient" };
  if (hasOneUseSignInLink(input.body)) {
    const { body } = redactOneUseSignInLinks(input.body);
    const note = `Your copy of the email sent to ${to}. Its one-time sign-in link is removed, so opening this copy can't sign you in as them.`;
    return { mode: "copy", address, body: `${note}\n\n${body}` };
  }
  return { mode: "bcc", address };
}

/** Is this address someone on the team (a TeamMember or a hub login)? Our own
 *  domain is caught without a read. A failed read answers false: the cost of
 *  being wrong is one extra copy in Jordan's inbox, never a missed one. */
export async function isStaffRecipient(email: string): Promise<boolean> {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return false;
  if (isStaffControlledEmail(e)) return true;
  try {
    const [tm, user] = await Promise.all([
      prisma.teamMember.findFirst({ where: { email: { equals: e, mode: "insensitive" } }, select: { id: true } }),
      prisma.appUser.findFirst({ where: { email: { equals: e, mode: "insensitive" } }, select: { id: true } }),
    ]);
    return !!(tm || user);
  } catch {
    return false;
  }
}

/** The whole decision for one outgoing email. Never throws. */
export async function planClientEmailCopy(input: { to: string; body: string; internal?: boolean }): Promise<ClientEmailCopyPlan> {
  if (input.internal) return { mode: "none", why: "internal" };
  try {
    const monitor = await clientEmailMonitor();
    if (!monitor.enabled) return { mode: "none", why: "off" };
    const staffRecipient = await isStaffRecipient(input.to);
    return planClientEmailCopyWith(monitor, { ...input, staffRecipient });
  } catch {
    // Unreachable in practice (both reads catch their own failures); the
    // default is ON, to the default inbox.
    return planClientEmailCopyWith({ enabled: true, address: DEFAULT_MONITOR_ADDRESS }, input);
  }
}

/** The Bcc address a plan puts on the client's own message, if any. */
export const bccOf = (plan: ClientEmailCopyPlan | null | undefined): string | null => (plan?.mode === "bcc" ? plan.address : null);

/** Send the separate (redacted) copy. Call it only AFTER the client's message
 *  was accepted. Best-effort: never throws, answers whether Gmail took it.
 *  `html` (Oct 21 2026): the branded version of the copy, so the owner sees
 *  what the client saw. */
export async function sendClientEmailCopy(plan: ClientEmailCopyPlan, opts: { subject: string; mailbox?: string; html?: string | null }): Promise<boolean> {
  if (plan.mode !== "copy") return false;
  try {
    const { sendGmailNew } = await import("@/lib/integrations/google");
    const res = await sendGmailNew({ mailbox: opts.mailbox ?? DEFAULT_MONITOR_ADDRESS, to: plan.address, subject: opts.subject, body: plan.body, strict: true, ...(opts.html ? { html: opts.html } : {}) });
    if (!res.ok) console.warn(`[client-email-copy] the monitor copy did not send: ${res.error}`);
    return res.ok;
  } catch (e) {
    console.warn(`[client-email-copy] the monitor copy did not send: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// "ALSO EMAIL" (Oct 21 2026). Jordan, about Arielle Roemer: "add a second email
// to her content program account so we can email her on both emails". A
// client's program can list extra addresses (ContentEnrollment.overridesJson
// `alsoEmails`, set on the content Settings tab) that get a copy of every
// email the hub sends that client.
//
// HOW THE COPY TRAVELS.
//   · An ordinary message: a visible `Cc:` on the client's own message, so
//     everyone sees who else has it and a reply-all reaches everyone.
//   · A message carrying a ONE-USE SIGN-IN LINK (the same predicate the owner's
//     copy uses, hasOneUseSignInLink): NEVER a Cc. That link signs whoever
//     presses it in AS the seat and is spent by the press, so it must reach
//     that one address only. Each extra address gets a SEPARATE copy after the
//     client's message was accepted, with every sign-in link swapped for the
//     durable sign-in page (/portal/login) and one line saying which address
//     signs in. Program reminders and "your scripts are ready" carry such a
//     link for a seat holder, so without this copy the extra address would
//     miss most of the program.
//   · The sign-in link email itself (`portal_login`) is the seat's alone: no
//     Cc and no copy. Internal mail (`staff`) never gets one either.
//   · A TEST client's extra addresses are kept only when they are one of
//     Jordan's verified test inboxes, the same floor as the To address.
// Nothing here throws into a send: an unreadable list means no copy.
// ---------------------------------------------------------------------------

export const ALSO_EMAILS_KEY = "alsoEmails";
export const ALSO_EMAILS_MAX = 10;

/** The clean, de-duplicated list stored on a program (string or parsed bag). Pure. */
export function alsoEmailsFromOverrides(bag: string | Record<string, unknown> | null | undefined): string[] {
  let v: unknown = bag;
  if (typeof bag === "string") {
    try { v = JSON.parse(bag); } catch { return []; }
  }
  const list = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[ALSO_EMAILS_KEY] : null;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const a = cleanMonitorAddress(raw);
    if (!a || seen.has(canonicalInbox(a))) continue;
    seen.add(canonicalInbox(a));
    out.push(a);
    if (out.length >= ALSO_EMAILS_MAX) break;
  }
  return out;
}

export type AlsoEmailPlan = {
  /** Visible copies on the client's own message. */
  cc: string[];
  /** Separate copies, sent after acceptance (the message carried a sign-in link). */
  copy: { to: string[]; body: string } | null;
  /** For drills and logs, never a recipient. */
  why: "none" | "internal" | "sign_in_email" | "cc" | "separate_copy";
};

const NO_ALSO: AlsoEmailPlan = { cc: [], copy: null, why: "none" };

/** Each sign-in link, swapped for the durable sign-in page on the same host. */
export function withSignInPageInstead(body: string, signInPage: string): string {
  return body.replace(ONE_USE_SIGN_IN_LINK, (m) => {
    const origin = /^https?:\/\/[^/\s]+/i.exec(m)?.[0];
    return origin ? `${origin}/portal/login` : signInPage;
  });
}

/** The pure half: who gets a copy of this one message, and how. */
export function planAlsoEmailWith(input: {
  kind: string | null;
  to: string;
  body: string;
  alsoEmails: readonly string[];
  /** The client is a synthetic TEST row: only Jordan's verified inboxes. */
  synthetic: boolean;
  /** Where a swapped sign-in link points when it carried no host. */
  signInPage?: string;
}): AlsoEmailPlan {
  if (input.kind === "staff") return { ...NO_ALSO, why: "internal" };
  if (input.kind === "portal_login") return { ...NO_ALSO, why: "sign_in_email" };
  const seen = new Set<string>([canonicalInbox(input.to)]);
  const list: string[] = [];
  for (const raw of input.alsoEmails) {
    const a = cleanMonitorAddress(raw);
    if (!a || seen.has(canonicalInbox(a))) continue;
    if (input.synthetic && !isVerifiedTestDestinationEmail(a)) continue;
    seen.add(canonicalInbox(a));
    list.push(a);
    if (list.length >= ALSO_EMAILS_MAX) break;
  }
  if (!list.length) return NO_ALSO;
  if (hasOneUseSignInLink(input.body)) {
    const note = `A copy of the email we sent to ${input.to.trim()}. To sign in to your portal, use that address.`;
    return { cc: [], copy: { to: list, body: `${note}\n\n${withSignInPageInstead(input.body, input.signInPage ?? "/portal/login")}` }, why: "separate_copy" };
  }
  return { cc: list, copy: null, why: "cc" };
}

/** The whole decision for one outgoing email: reads the client's list. Never throws. */
export async function planAlsoEmail(input: { clientId: string | null; kind: string | null; to: string; body: string }): Promise<AlsoEmailPlan> {
  if (!input.clientId || input.kind === "staff" || input.kind === "portal_login") return NO_ALSO;
  try {
    const [e, client] = await Promise.all([
      prisma.contentEnrollment.findUnique({ where: { clientId: input.clientId }, select: { overridesJson: true } }),
      prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, name: true } }),
    ]);
    const alsoEmails = alsoEmailsFromOverrides(e?.overridesJson ?? null);
    if (!alsoEmails.length || !client) return NO_ALSO;
    const { appBase } = await import("@/lib/appUrl");
    return planAlsoEmailWith({ ...input, alsoEmails, synthetic: isSyntheticClientRow(client), signInPage: `${appBase()}/portal/login` });
  } catch (e) {
    console.warn(`[also-email] the client's extra addresses could not be read, so no copy: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    return NO_ALSO;
  }
}

/** Send the separate copies (a message with a sign-in link). Call it only
 *  AFTER the client's message was accepted. Best-effort: never throws,
 *  answers how many Gmail took. */
export async function sendAlsoEmailCopies(copy: { to: string[]; body: string }, opts: { subject: string; mailbox?: string; html?: string | null }): Promise<number> {
  let sent = 0;
  try {
    const { sendGmailNew } = await import("@/lib/integrations/google");
    for (const to of copy.to) {
      const res = await sendGmailNew({ mailbox: opts.mailbox ?? DEFAULT_MONITOR_ADDRESS, to, subject: opts.subject, body: copy.body, strict: true, ...(opts.html ? { html: opts.html } : {}) })
        .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
      if (res.ok) sent++;
      else console.warn(`[also-email] a copy did not send: ${res.error}`);
    }
  } catch (e) {
    console.warn(`[also-email] the copies did not send: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  return sent;
}
