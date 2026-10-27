// ---------------------------------------------------------------------------
// A BOOKING ANSWERS A BOOKING QUESTION (Jordan, Oct 27 2026 Loom, 36:30: "Can
// we schedule ahead of time for November?" sat on Messages after Mike Ciunci
// had already booked November. "He already scheduled ahead of time for
// November, so this should be dismissed automatically ... the appointments,
// if they get scheduled, they need to be pulled off of here, automatically.")
//
// A client's question about BOOKING a shoot or a session is answered once a
// booking for that client exists that was made after they asked: a content
// session request (portal or desk) or a job in Aryeo. The Messages walk
// (lib/replyQueue), the obligation ledger, the open scheduling asks and the
// asks sweep (lib/clientAsks closeBookedSchedulingAsks) all read this one rule.
//
// Conservative where a booking cannot be the answer:
//   · a reschedule, a cancel or a move is about a booking that already exists,
//     and a new one does not answer it;
//   · a question that names a street address is answered only by a job at
//     that address (the Oct 25 audit's rule, unchanged);
//   · a message that also asks about the work itself (when the photos are
//     ready, an edit) is not only a booking question, so it stays.
// Pure: no database, no server imports (a drill holds every rule).
// ---------------------------------------------------------------------------

const BOOKING_RE = /\bschedul\w*|\bbook(?:ing)?\b|\bset up (?:a|the|our|my|another|next)\b|\block in\b|\bon the calendar\b|\bnext (?:session|shoot|filming)\b/i;
const MOVE_RE = /\bre-?schedul\w*|\bcancel\w*|\bpostpon\w*|\bpush (?:it|the|back|us)\b|\bmove (?:it|the|our|my)\b|\bchange (?:the )?(?:time|date|day)\b|\bearlier\b|\blater time\b/i;
// A second question about the work, not the calendar.
const WORK_RE = /\b(?:photos?|pictures?|pics|videos?|reels?|edits?|editing|revision\w*|script\w*|floor ?plans?|gallery|invoice|payment|ready|deliver\w*|download|link)\b/i;
// "123 Main St", "3828 N Percy St": a house number, a street word, a suffix.
const STREET_RE = /\b\d+[a-z]?\s+(?:[nsew]\.?\s+)?[a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,3}\s+(?:st|street|rd|road|ave|avenue|ln|lane|dr|drive|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pike|hwy|highway|pkwy|parkway|trl|trail|run|sq|square)\b/i;

/** "Can we schedule ahead of time for November?", "Can I book my next session?". */
export function isBookingQuestion(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 400) return false;
  if (!BOOKING_RE.test(t) || MOVE_RE.test(t)) return false;
  // "Can we book the shoot? Also when will the photos be ready" asks two things.
  const sentences = t.split(/(?<=[?.!])\s+/);
  return !sentences.some((s) => WORK_RE.test(s) && !BOOKING_RE.test(s));
}

/** Does the message name a street address? */
export function namesStreetAddress(text: string | null | undefined): boolean {
  return STREET_RE.test(text ?? "");
}

export type Booking = {
  clientId: string;
  /** when the booking was made (the row's createdAt) */
  at: Date;
  kind: "session" | "job";
  /** for a job: its title and address line (what an address question is matched against) */
  title?: string | null;
  addressLine?: string | null;
  /** in words, for a closing note: "content session Nov 12" or "265 Mill Rd" */
  words: string;
};

/** How long before the message a booking may be and still be its answer: the
 *  ask is filed a moment after the text lands, and a client sometimes asks
 *  the second after the portal booked them. */
const SLACK_MS = 10 * 60_000;

/**
 * The booking that answers this message, or null. `addressKey` is
 * lib/teamRouting jobAddressKey (passed in so this file stays pure).
 */
export function bookingAnswering(
  m: { text: string; at: Date },
  bookings: Booking[],
  addressKey: (j: { title: string; addressLine: string | null }) => { re: RegExp } | null,
): Booking | null {
  if (!isBookingQuestion(m.text)) return null;
  const after = m.at.getTime() - SLACK_MS;
  const named = namesStreetAddress(m.text);
  const newestFirst = [...bookings].filter((b) => b.at.getTime() >= after).sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const b of newestFirst) {
    if (!named) return b;
    if (b.kind !== "job") continue;
    const k = addressKey({ title: b.title ?? "", addressLine: b.addressLine ?? null });
    if (k && k.re.test(m.text)) return b;
  }
  return null;
}
