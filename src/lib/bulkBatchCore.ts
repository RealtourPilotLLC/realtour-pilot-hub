import { endOfBusinessDaysET } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// BULK PLANS ARE EDITED IN BATCHES OF 8 (Jordan, Oct 27 2026: "We should have
// 8 videos done every 7 - 10 business days"). Rick Schultz filmed 48 videos in
// two sessions (31 on Oct 20, 17 on Oct 27), so a single job-level deadline
// was wrong both ways: the office's Nov 4 date said all 31 were due at once,
// and the program watch would have flagged every one of them late that day.
//
// THE CLOCK. The plan's videos are counted in order (session by session, each
// session's videos by slot); video n is in batch ceil(n / 8). Batch k is due
// 10k business days after the plan's first session (the latest), with an aim
// of 7k business days (the target), at 5 PM ET. A video is never due sooner
// than 10 business days after the session that filmed it. Weekends are not
// business days; holidays are not modelled (the rest of the hub's clocks).
//
// Pure: lib/bulkBatches stamps these on each video's row
// (DeliverableOutput.promisedAt / targetAt, promiseSource "bulk-batch"), and
// every per-video reader (the brief, the PDF, the program watch) and the one
// video due (editorDue, source "batch") read them from there.
// ---------------------------------------------------------------------------

export const BULK_BATCH = { size: 8, aimBusinessDays: 7, dueBusinessDays: 10 } as const;
/** The promiseSource the batch dates are stamped with. */
export const BULK_BATCH_SOURCE = "bulk-batch";
/** The delivery board's tierLabel for a job dated by its batch. */
export const BATCH_TIER_LABEL = "batch of 8";

/** One video of the plan, in the order it is counted. */
export type BatchVideo = { key: string; sessionNo: number; slot: number; shootAt: Date | null };
export type BatchStamp = { key: string; index: number; batchNo: number; dueAt: Date; aimAt: Date; anchorAt: Date };

/** The batch dates for batch `k` counted from `startAt` (the plan's first session). Pure. */
export function batchDates(startAt: Date, k: number): { dueAt: Date; aimAt: Date } {
  return {
    dueAt: endOfBusinessDaysET(startAt, BULK_BATCH.dueBusinessDays * k),
    aimAt: endOfBusinessDaysET(startAt, BULK_BATCH.aimBusinessDays * k),
  };
}

const later = (a: Date, b: Date) => (a > b ? a : b);

/**
 * Every video's batch, due, aim and anchor (the start of its batch's window:
 * the previous batch's due, or the session that filmed it when that is later).
 * Videos are counted by session, then slot. Pure.
 */
export function batchStamps(videos: BatchVideo[], startAt: Date): BatchStamp[] {
  const ordered = [...videos].sort((a, b) => a.sessionNo - b.sessionNo || a.slot - b.slot);
  return ordered.map((v, i) => {
    const index = i + 1;
    const batchNo = Math.ceil(index / BULK_BATCH.size);
    const { dueAt, aimAt } = batchDates(startAt, batchNo);
    const shoot = v.shootAt ?? startAt;
    const floorDue = endOfBusinessDaysET(shoot, BULK_BATCH.dueBusinessDays);
    const floorAim = endOfBusinessDaysET(shoot, BULK_BATCH.aimBusinessDays);
    const windowStart = batchNo > 1 ? batchDates(startAt, batchNo - 1).dueAt : startAt;
    return { key: v.key, index, batchNo, dueAt: later(dueAt, floorDue), aimAt: later(aimAt, floorAim), anchorAt: later(windowStart, shoot) };
  });
}
