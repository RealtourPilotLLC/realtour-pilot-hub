import { etDateTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// "GOT IT" ON A COACHING NOTE (Jordan, Oct 27 2026: "I'm gonna make sure Kyle
// is acknowledging these, so I'd like to be able to see if Kyle acknowledges,
// like, give him an option to acknowledge, you know, whatever the coaching
// is").
//
// One evening's note (CoachingAudit, keyed by person and ET day) can be marked
// "Got it" by the person it is about, with an optional short note of their own.
// Jordan's report reads it back: whether, when (Eastern) and what they wrote.
//
// Stored beside the note in AppSetting under its own prefix, never inside the
// audit row (the engine owns that record and rewrites it): no schema change,
// and listCoachingAudits ("comms-coaching:") never reads these rows. Nothing
// here sends anything to anyone. Client-safe (the Got it control imports it);
// the one read lives on the page (app/coaching/page.tsx, readAcks).
// ---------------------------------------------------------------------------

export const COACHING_ACK_PREFIX = "coaching-ack:";
/** The longest note kept with a "Got it". */
export const ACK_NOTE_MAX = 500;

export type CoachingAck = {
  teamMemberId: string;
  dayKey: string;
  /** The name on the login that pressed it. */
  by: string;
  byEmail: string;
  /** When "Got it" was first pressed (ISO). */
  at: string;
  /** Their own words, optional. */
  note: string | null;
  /** When the note last changed, if it changed after the first press. */
  noteAt: string | null;
};

export const coachingAckKey = (teamMemberId: string, dayKey: string) => `${COACHING_ACK_PREFIX}${teamMemberId}:${dayKey}`;

const ID_RE = /^[a-z0-9_-]{6,40}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Ids and days as the engine writes them; anything else is refused before a read. */
export const validAckTarget = (teamMemberId: unknown, dayKey: unknown): boolean =>
  typeof teamMemberId === "string" && ID_RE.test(teamMemberId) && typeof dayKey === "string" && DAY_RE.test(dayKey);

/** A note as kept: trimmed, one space between words, at most ACK_NOTE_MAX, null when empty. */
export function cleanAckNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim().slice(0, ACK_NOTE_MAX).trim();
  return s ? s : null;
}

export function parseAck(value: string | null | undefined): CoachingAck | null {
  if (!value) return null;
  try {
    const a = JSON.parse(value) as Partial<CoachingAck>;
    if (!a || typeof a.at !== "string" || typeof a.teamMemberId !== "string" || typeof a.dayKey !== "string") return null;
    return {
      teamMemberId: a.teamMemberId,
      dayKey: a.dayKey,
      by: typeof a.by === "string" && a.by ? a.by : "Someone",
      byEmail: typeof a.byEmail === "string" ? a.byEmail : "",
      at: a.at,
      note: typeof a.note === "string" && a.note ? a.note : null,
      noteAt: typeof a.noteAt === "string" ? a.noteAt : null,
    };
  } catch {
    return null;
  }
}

/** The owner's line: "Kyle said Got it Mon, Oct 27, 4:12 PM ET." or "Kyle has not said Got it yet." */
export function ackWords(ack: CoachingAck | null, personName: string): string {
  const first = (personName || "They").trim().split(/\s+/)[0] || "They";
  if (!ack) return `${first} has not said Got it yet.`;
  return `${first} said Got it ${etDateTime(ack.at)} ET.`;
}
