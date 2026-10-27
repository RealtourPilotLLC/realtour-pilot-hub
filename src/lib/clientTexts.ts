import type { Prisma } from "@prisma/client";
import { etDayStartUtc } from "@/lib/datetime";
import { recentProjectWhere } from "@/lib/recency";

// ---------------------------------------------------------------------------
// THE membership rule for drafted client texts (confirmation + delivery).
// Four surfaces show "today's client texts" — the Outbox panel, the /today
// rollup card, the Tasks-hub badge, and the send-all batch — and each used to
// carry its own inline copy of the filter, which is how they drifted apart
// (audit finding #44: the badge advertised texts the panel didn't show, and
// the batch could send what the panel had already filtered out). Every one of
// them now calls clientTextWhere(); if the rule ever needs to change, it
// changes HERE and nowhere else.
// ---------------------------------------------------------------------------

export const CLIENT_TEXT_TYPES = ["confirmation_text", "delivery_text"] as const;

// Last millisecond of TODAY in ET, as a UTC Date for DB range queries.
// Derived as "start of tomorrow − 1ms" via the DST-aware etDayStartUtc, not
// "start of today + 24h − 1ms": on the 23/25-hour days around a DST switch
// that arithmetic lands an hour inside tomorrow or before midnight.
export function etEndOfTodayUtc(now = new Date()): Date {
  // Two-step on purpose: start-of-today first, then re-derive the NEXT
  // midnight from an instant safely inside tomorrow (+30h clears both DST
  // shifts). Feeding `now + 24h` straight to etDayStartUtc sampled the UTC
  // offset at tomorrow-afternoon, which is the NEW offset on a transition
  // day — the boundary came out an hour short (or long) on every DST eve.
  const todayStart = etDayStartUtc(now);
  const tomorrowStart = etDayStartUtc(new Date(todayStart.getTime() + 30 * 3600_000));
  return new Date(tomorrowStart.getTime() - 1);
}

/** Last millisecond of TOMORROW in ET: a confirmation's window closes with
 *  the shoot, and opens the day before (Oct 27 2026). Same DST-safe steps. */
export function etEndOfTomorrowUtc(now = new Date()): Date {
  return etEndOfTodayUtc(new Date(etEndOfTodayUtc(now).getTime() + 6 * 3600_000));
}

/** Pure, for a row already read: is this confirmation's shoot in its Outbox
 *  window (ahead of us, no later than tomorrow ET)? */
export function confirmationInWindow(shootDate: Date | null | undefined, now = new Date()): boolean {
  return !!shootDate && shootDate.getTime() > now.getTime() && shootDate.getTime() <= etEndOfTomorrowUtc(now).getTime();
}

// Canonical filter. The shape encodes hard-won rules — don't "tidy" them away:
// · NO assignee filter, ever. Assigning a text to someone must not hide it
//   from the review surfaces — scoping to kyle+delegates made assigned texts
//   vanish from every screen (the finding-1 regression).
// · A CONFIRMATION FOLLOWS THE LIVE SHOOT, not its own dueAt (Jordan, Oct 27
//   2026 Loom, 39:18: "Hi Georgiana, confirming your upcoming shoot at 2031
//   Ruth ... This confirmation may be out of date. The appointment was
//   rescheduled, so this notification should be rescheduled for whenever her
//   new appointment was scheduled for, or at least a day before, two days
//   before the appointment"). It is in the Outbox only while the job's shoot
//   is still ahead and no later than tomorrow (ET): the day before, as the
//   SOP says, whatever the task row's dueAt still reads. A shoot moved later
//   takes its confirmation off until the new day before; a shoot with NO date
//   (postponed) holds it (the rebook task chases the date; lib/tasks also
//   marks the row held); a shoot already past is no confirmation at all.
//   This replaces "null dueAt COUNTS" (a dateless confirmation in the Outbox
//   was a text with no time to confirm, which is what Jordan saw).
// · A delivery text keeps its dueAt rule (due by end of today, or no date).
// · projectId is REQUIRED. Both text types always mint with a project, and the
//   drafts re-render from the project's live data — a projectless row can't
//   even produce a message.
// · recency filter EVERYWHERE. A month-late "your content is ready" must never
//   batch-send; stale delivery texts are retired by closeStaleDeliveryTexts,
//   and until that sweep runs the recency window keeps them off every surface.
// · due by END OF TODAY (ET). Confirmation texts exist from booking day with
//   dueAt = shoot−1d; surfacing one for a shoot weeks out invites an insane
//   early send.
export function clientTextWhere(now = new Date(), opts: { excludeClientIds?: string[] } = {}): Prisma.SmartTaskWhereInput {
  return {
    taskType: { in: [...CLIENT_TEXT_TYPES] },
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    projectId: { not: null },
    AND: [
      {
        OR: [
          { taskType: "confirmation_text", project: { shootDate: { gt: now, lte: etEndOfTomorrowUtc(now) } } },
          { taskType: { not: "confirmation_text" }, OR: [{ dueAt: { lte: etEndOfTodayUtc(now) } }, { dueAt: null }] },
        ],
      },
      { project: recentProjectWhere() },
      ...(opts.excludeClientIds?.length ? [
        { OR: [{ clientId: null }, { clientId: { notIn: opts.excludeClientIds } }] },
        { project: { clientId: { notIn: opts.excludeClientIds } } },
      ] : []),
    ],
  };
}
