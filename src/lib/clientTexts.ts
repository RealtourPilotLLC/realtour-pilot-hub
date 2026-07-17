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

// Canonical filter. The shape encodes hard-won rules — don't "tidy" them away:
// · NO assignee filter, ever. Assigning a text to someone must not hide it
//   from the review surfaces — scoping to kyle+delegates made assigned texts
//   vanish from every screen (the finding-1 regression).
// · null dueAt COUNTS. A confirmation on a job with no shoot date yet is real
//   work (someone has to chase the date), not something to hide until a date
//   appears.
// · projectId is REQUIRED. Both text types always mint with a project, and the
//   drafts re-render from the project's live data — a projectless row can't
//   even produce a message.
// · recency filter EVERYWHERE. A month-late "your content is ready" must never
//   batch-send; stale delivery texts are retired by closeStaleDeliveryTexts,
//   and until that sweep runs the recency window keeps them off every surface.
// · due by END OF TODAY (ET). Confirmation texts exist from booking day with
//   dueAt = shoot−1d; surfacing one for a shoot weeks out invites an insane
//   early send.
export function clientTextWhere(now = new Date()): Prisma.SmartTaskWhereInput {
  return {
    taskType: { in: [...CLIENT_TEXT_TYPES] },
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    projectId: { not: null },
    AND: [
      { OR: [{ dueAt: { lte: etEndOfTodayUtc(now) } }, { dueAt: null }] },
      { project: recentProjectWhere() },
    ],
  };
}
