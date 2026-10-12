import "server-only";
import { prisma } from "@/lib/prisma";
import { canonicalInbox, isStaffControlledEmail } from "@/lib/testClients";

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
 *  was accepted. Best-effort: never throws, answers whether Gmail took it. */
export async function sendClientEmailCopy(plan: ClientEmailCopyPlan, opts: { subject: string; mailbox?: string }): Promise<boolean> {
  if (plan.mode !== "copy") return false;
  try {
    const { sendGmailNew } = await import("@/lib/integrations/google");
    const res = await sendGmailNew({ mailbox: opts.mailbox ?? DEFAULT_MONITOR_ADDRESS, to: plan.address, subject: opts.subject, body: plan.body, strict: true });
    if (!res.ok) console.warn(`[client-email-copy] the monitor copy did not send: ${res.error}`);
    return res.ok;
  } catch (e) {
    console.warn(`[client-email-copy] the monitor copy did not send: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    return false;
  }
}
