import "server-only";
import { prisma } from "@/lib/prisma";
import { OWNER_PERSONAL_ADDRESSES } from "@/lib/mailMatch";

// ---------------------------------------------------------------------------
// WHO ON OUR SIDE ANSWERED AN EMAIL (Oct 14 2026).
//
// Jordan: "Sometimes both Kyle and I get emailed. If Kyle responds on his end,
// close it out on my end."
//
// The hub reads two inboxes: info@ (Jordan) and hello@ (Kyle's login). Until
// now our side of an email conversation reached the comms log only one way:
// when the Gmail sync processed a CLIENT message and that mailbox's own copy of
// the thread already ended with a message from us. That missed the common case
// behind the request — a client writes to info@ AND hello@, Kyle answers from
// hello@ without reply-all, and info@'s copy of the thread never hears about
// it. Jordan's card kept saying the client was waiting, and the reply task
// filed on info@'s thread stayed open.
//
// Two readers now log our replies as outbound CommLog rows, so the one
// unanswered walk (replyQueue.ts) clears the thread whichever inbox it sits in:
//   · the SENT FOLDER of every connected mailbox (google.ts syncSentReplies) —
//     Kyle's reply from hello@ is visible even when info@ was never copied;
//   · a STAFF message that lands in one of our inboxes (a teammate whose own
//     mailbox is not connected — james@ answering with info@ on cc).
// Both decide "is this a reply from us to a client?" here, in one pure
// function the drill can run without Gmail.
// ---------------------------------------------------------------------------

/** Every address @ this domain is ours (info@, hello@, james@, aliases). */
export const OUR_EMAIL_DOMAIN = "realtourpilot.com";

export type StaffAddressBook = {
  /** lower-cased staff addresses (team roster + active logins) */
  addresses: Set<string>;
  /** address → the TeamMember who uses it, when the roster can say */
  memberByAddress: Map<string, { id: string; name: string }>;
};

export function emptyAddressBook(): StaffAddressBook {
  return { addresses: new Set(), memberByAddress: new Map() };
}

/** The staff address book: every roster email and every login's email (a
 *  login carries its TeamMember link when there is one), plus Jordan's own
 *  addresses (lib/mailMatch). One read per sync; never throws.
 *  Oct 22 2026 (comms audit H3): every row, not only the active ones, and
 *  Jordan's personal gmail: a staff address is staff before any client
 *  lookup, so an old contact row can never file our own mail to a client. */
export async function staffAddressBook(): Promise<StaffAddressBook> {
  const book = emptyAddressBook();
  for (const a of OWNER_PERSONAL_ADDRESSES) book.addresses.add(a);
  try {
    const [members, logins] = await Promise.all([
      prisma.teamMember.findMany({ select: { id: true, name: true, email: true } }),
      prisma.appUser.findMany({ select: { email: true, teamMemberId: true } }),
    ]);
    const byId = new Map(members.map((m) => [m.id, m]));
    for (const m of members) {
      const a = m.email?.trim().toLowerCase();
      if (!a || !a.includes("@")) continue;
      book.addresses.add(a);
      book.memberByAddress.set(a, { id: m.id, name: m.name });
    }
    for (const u of logins) {
      const a = u.email?.trim().toLowerCase();
      if (!a || !a.includes("@")) continue;
      book.addresses.add(a);
      const m = u.teamMemberId ? byId.get(u.teamMemberId) : undefined;
      if (m && !book.memberByAddress.has(a)) book.memberByAddress.set(a, { id: m.id, name: m.name });
    }
  } catch (e) {
    console.warn("staff address book unavailable (domain rule still applies)", e);
  }
  return book;
}

export function isStaffAddress(address: string | null | undefined, book: StaffAddressBook): boolean {
  const a = (address ?? "").trim().toLowerCase();
  if (!a.includes("@")) return false;
  return a.endsWith("@" + OUR_EMAIL_DOMAIN) || book.addresses.has(a);
}

/** Every address in a To/Cc/From header, lower-cased, in order, deduped. */
export function parseAddressList(header: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (header ?? "").matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const a = m[0].toLowerCase();
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** A REPLY, not a fresh mail: Gmail stamps In-Reply-To/References on a reply,
 *  and a "Re:" subject is the fallback for clients that strip them. A cold
 *  email we send ("Your October content plan") answers nothing. */
export function isReplyShaped(m: { subject?: string | null; inReplyTo?: string | null; references?: string | null }): boolean {
  if ((m.inReplyTo ?? "").trim() || (m.references ?? "").trim()) return true;
  return /^\s*(re|aw|sv)\s*:/i.test(m.subject ?? "");
}

export type GmailStaffMessage = {
  /** the connected mailbox the message was read from */
  mailbox: string;
  messageId: string;
  threadId: string;
  from: string; // raw header
  to: string; // raw header
  cc: string; // raw header
  subject: string;
  inReplyTo?: string | null;
  references?: string | null;
  at: Date;
  /** our own words, quoted history already stripped */
  body: string;
  /** true when read from the mailbox's SENT folder (it is the mailbox's own
   *  send); false when it landed in one of our INBOXES from a teammate */
  fromSentFolder: boolean;
};

export type ResolvedClient = { clientId: string; clientName: string | null };

export type StaffReplyRow = {
  channel: "email";
  direction: "out";
  clientId: string;
  clientName: string | null;
  contactName: "Us";
  subject: string | null;
  body: string;
  occurredAt: Date;
  source: string;
  externalId: string;
  senderTeamMemberId: string | null;
  /** the client address it went to (for the log line, never stored) */
  to: string;
};

/**
 * Is this message one of OUR replies to a client? Returns the CommLog row to
 * write, or null. Pure: the caller hands in the address book and a resolver
 * from an address to a client account (the sync's own email → contact →
 * agent-fold lookup).
 *
 *   · the sender must be staff (our domain, the roster, an active login);
 *   · it must be a reply (see isReplyShaped);
 *   · the first non-staff recipient that resolves to a client decides whose
 *     conversation it answered. No client → null (a vendor, a photographer).
 *
 * The externalId matches logSentReply's (`gmail-sent-<threadId>-<messageId>`)
 * for a sent-folder read, so the same reply caught by the old thread check and
 * by this reader lands once. A teammate's message seen in an inbox is keyed on
 * the inbox copy instead.
 */
export function staffReplyRow(
  m: GmailStaffMessage,
  book: StaffAddressBook,
  resolve: (address: string) => ResolvedClient | null,
  sentSource: string,
): StaffReplyRow | null {
  const from = parseAddressList(m.from)[0] ?? "";
  if (!isStaffAddress(from, book)) return null;
  if (!isReplyShaped(m)) return null;
  const recipients = [...parseAddressList(m.to), ...parseAddressList(m.cc)].filter((a) => !isStaffAddress(a, book));
  let hit: { address: string; client: ResolvedClient } | null = null;
  for (const a of recipients) {
    const c = resolve(a);
    if (c) { hit = { address: a, client: c }; break; }
  }
  if (!hit) return null;
  const body = (m.body ?? "").trim() || `Replied to ${hit.address} from ${from}.`;
  return {
    channel: "email",
    direction: "out",
    clientId: hit.client.clientId,
    clientName: hit.client.clientName,
    // "Us" — the label the walk reads as our side (replyQueue OUR_LABELS);
    // WHO wrote it rides on senderTeamMemberId, the column built for exactly
    // that (Sep 21: "make sure we track Kyle's responses").
    contactName: "Us",
    subject: m.subject || null,
    body: body.slice(0, 5_500),
    occurredAt: m.at,
    source: sentSource,
    externalId: m.fromSentFolder ? `gmail-sent-${m.threadId}-${m.messageId}` : `gmail-staff-${m.mailbox}:${m.messageId}`,
    senderTeamMemberId: book.memberByAddress.get(from)?.id ?? null,
    to: hit.address,
  };
}
