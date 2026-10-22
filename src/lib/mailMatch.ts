// ---------------------------------------------------------------------------
// WHOSE EMAIL IS THIS (Oct 22 2026, comms audit H2 + H3 + M3). Pure: no prisma,
// no server-only. The Gmail sync (integrations/google.ts), the live repair
// scripts and the drill read the same rules.
//
// H2. info@ is Jordan's personal inbox. An unknown sender there was matched to
//     a client by any street or town name in the mail: in 30 days 57 of the
//     123 info@ rows filed to a client came from someone else (a family
//     memorial email, a Green Dot refund, Apple Cash, a line of credit, the
//     chamber's billing). Kyle could read them and they fed the AI's client
//     context. An unknown sender in info@ is never matched by a street or a
//     town: it stays unmatched and owner-only.
// H3. Jordan's own mail was logged as a client named "Jordan Spackman": a
//     HubSpot contact linked info@ and his gmail to a client row. A staff
//     address (every AppUser and TeamMember email, our domain, and Jordan's
//     two) is staff BEFORE any client lookup. A staff FORWARD of a client's
//     email is read as that client's, by the forwarded sender's address.
// M3. One email sent to both info@ and hello@ was logged twice (each inbox
//     has its own Gmail id). Its RFC Message-ID is the same in both: the
//     second copy is the same message.
// ---------------------------------------------------------------------------

/** Jordan's personal inbox: only known clients are surfaced from it. */
export const PERSONAL_MAILBOXES = ["info@realtourpilot.com"] as const;

/** Jordan's own addresses, staff whatever a contact row says (H3). Our domain is staff by rule. */
export const OWNER_PERSONAL_ADDRESSES = ["info@realtourpilot.com", "jspackman215@gmail.com"] as const;

export const isPersonalMailbox = (mailbox: string | null | undefined): boolean =>
  (PERSONAL_MAILBOXES as readonly string[]).includes((mailbox ?? "").trim().toLowerCase());

/**
 * May the global street / town match pick a client for this mail? Never for
 * a sender we do not know in Jordan's personal inbox (H2). A known sender's
 * mail may still be matched to one of their OWN jobs (the caller's rule), and
 * an unknown sender in the team inbox (hello@) is matched as before.
 */
export function streetMatchAllowed(o: { mailbox: string; senderKnown: boolean }): boolean {
  return o.senderKnown || !isPersonalMailbox(o.mailbox);
}

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Does this mail read as a forward? A "Fwd:" / "Fw:" subject, or a forwarded-message banner in the body. */
export function isForward(subject: string | null | undefined, body: string | null | undefined): boolean {
  if (/^\s*(?:fwd?|fw)\s*:/i.test(subject ?? "")) return true;
  return /-{3,}\s*Forwarded message\s*-{3,}|Begin forwarded message:/i.test(body ?? "");
}

/**
 * The original sender of a forward: the first "From:" line in the body whose
 * address is not staff. Null when this is not a forward or no such line
 * exists. `isStaff` is the caller's staff test (the address book).
 */
export function forwardedSenderAddress(
  subject: string | null | undefined,
  body: string | null | undefined,
  isStaff: (address: string) => boolean,
): string | null {
  if (!isForward(subject, body)) return null;
  for (const line of (body ?? "").split(/\r?\n/)) {
    const m = /^\s*>?\s*\*?From:\*?\s*(.+)$/i.exec(line);
    if (!m) continue;
    const addr = EMAIL_RE.exec(m[1])?.[0]?.toLowerCase();
    if (addr && !isStaff(addr)) return addr;
  }
  return null;
}

/** The RFC Message-ID as a stable key ("<abc@mail.gmail.com>" → "abc@mail.gmail.com"), or null. */
export function messageIdKey(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return t.length >= 6 && t.includes("@") ? t.slice(0, 300) : null;
}
