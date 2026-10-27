import { prisma } from "@/lib/prisma";
import { monthLabel } from "@/lib/contentProgram";

// ---------------------------------------------------------------------------
// PLAN › CALLS, the list's read (Oct 27 2026). Jordan: "it should be analyzed
// and assigned automatically." The sync files a call by every signal it has
// (callAutoMatch.ts), so the list is a calm read: one plain line per call
// (booked / held / cancelled; whether its notes are analyzed) and how it was
// matched, for the Details fold (tabs/CallsView.tsx).
// ---------------------------------------------------------------------------

const CALL_WORDS: Record<string, string> = { MONTHLY_STRATEGY: "Monthly strategy call", BRAND_DISCOVERY: "Brand discovery call" };
const STATUS_WORDS: Record<string, string> = { SCHEDULED: "Booked", COMPLETED: "Held", CANCELLED: "Cancelled", RESCHEDULED: "Moved", NO_SHOW: "Missed" };
const NOTES_WORDS: Record<string, string> = {
  ANALYZED: "notes analyzed", CONFIRMED: "notes in, being analyzed", FAILED: "the notes could not be read", NEEDS_REVIEW: "the notes need a look",
};
const UNSETTLED: Record<string, string> = {
  UNMATCHED_INVITEE: "not matched to a client yet", AMBIGUOUS_CLIENT: "two clients fit, not filed yet", AMBIGUOUS_MONTH: "month not settled yet",
  CANDIDATE: "not matched to a client yet", PENDING: "being matched",
};

const fmtWhen = (d: Date | null) =>
  d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "no time";

export type CallListRow = {
  id: string; title: string; when: string; monthName: string | null; line: string; warn: boolean; matchNote: string | null; lastError: string | null;
};

/** The client's calls, newest first, each with its one status line. */
export async function loadCallList(enrollmentId: string, now = new Date()): Promise<CallListRow[]> {
  const [calls, months] = await Promise.all([
    prisma.programCallRecord.findMany({
      where: { enrollmentId }, orderBy: { scheduledStart: "desc" }, take: 40,
      select: { id: true, callType: true, status: true, scheduledStart: true, scheduledEnd: true, transcriptState: true, matchState: true, matchNote: true, lastError: true, monthId: true, targetMonthKey: true, bookingSource: true },
    }),
    prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true } }),
  ]);
  const keyOf = new Map(months.map((m) => [m.id, m.monthKey]));
  return calls.map((c) => {
    const monthKey = (c.monthId ? keyOf.get(c.monthId) : null) ?? c.targetMonthKey ?? null;
    const over = (c.scheduledEnd ?? c.scheduledStart)?.getTime() ?? 0;
    const held = c.status === "COMPLETED" || (c.status === "SCHEDULED" && over > 0 && over < now.getTime());
    const parts: string[] = [held ? "Held" : STATUS_WORDS[c.status] ?? c.status.toLowerCase()];
    if (held) parts.push(NOTES_WORDS[c.transcriptState] ?? "waiting for the notes");
    if (UNSETTLED[c.matchState]) parts.push(UNSETTLED[c.matchState]);
    if (c.bookingSource === "CALENDAR") parts.push("found on the calendar");
    return {
      id: c.id,
      title: CALL_WORDS[c.callType] ?? (c.callType === "UNCLASSIFIED" ? "Call" : c.callType.toLowerCase().replace(/_/g, " ")),
      when: fmtWhen(c.scheduledStart),
      monthName: monthKey ? monthLabel(monthKey) : null,
      line: parts.join(" · "),
      warn: c.transcriptState === "FAILED" || !!UNSETTLED[c.matchState],
      matchNote: c.matchNote, lastError: c.lastError,
    };
  });
}
