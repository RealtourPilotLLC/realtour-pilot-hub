import { etAt, etDayKey } from "@/lib/datetime";

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
// than 10 business days after the session that filmed it. Weekends and six US
// holidays (below) are not business days (Jordan, Oct 27 2026, "OK" to the
// batch clock skipping holidays). Only this clock skips them: the rest of the
// hub's clocks still count weekdays (datetime.ts keeps no holiday calendar).
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

const key = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12)).toISOString().slice(0, 10);
const dowOf = (k: string) => new Date(`${k}T12:00:00Z`).getUTCDay();
/** The nth (1-based) `dow` of a month, or the last one when n is -1. */
function nthWeekday(y: number, m: number, dow: number, n: number): string {
  if (n > 0) {
    const first = dowOf(key(y, m, 1));
    return key(y, m, 1 + ((dow - first + 7) % 7) + 7 * (n - 1));
  }
  const lastDay = new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
  const last = dowOf(key(y, m, lastDay));
  return key(y, m, lastDay - ((last - dow + 7) % 7));
}
/** A fixed-date holiday on a weekend is taken on the Friday before or the Monday after. */
function observed(k: string): string {
  const d = dowOf(k);
  if (d === 6) return new Date(Date.parse(`${k}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (d === 0) return new Date(Date.parse(`${k}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return k;
}

/** The days the batch clock skips in `year`: New Year's Day, Memorial Day, July 4, Labor Day, Thanksgiving and Christmas (as observed). Pure. */
export function batchHolidayKeys(year: number): string[] {
  return [
    observed(key(year, 1, 1)),
    nthWeekday(year, 5, 1, -1),
    observed(key(year, 7, 4)),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observed(key(year, 12, 25)),
  ];
}

const holidayCache = new Map<number, Set<string>>();
function isHoliday(k: string): boolean {
  const y = Number(k.slice(0, 4));
  let set = holidayCache.get(y);
  // New Year's Day on a Saturday is taken on Dec 31 of the year before.
  if (!set) holidayCache.set(y, (set = new Set([...batchHolidayKeys(y), ...batchHolidayKeys(y + 1)])));
  return set.has(k);
}

/** `days` batch-clock business days after `from` (weekends and holidays skipped), at `hour` ET. Pure. */
export function endOfBatchDaysET(from: Date, days: number, hour = 17): Date {
  let k = etDayKey(from);
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    const [y, m, d] = k.split("-").map(Number);
    k = key(y, m, d + 1);
    const dow = dowOf(k);
    if (dow !== 0 && dow !== 6 && !isHoliday(k)) left--;
  }
  return etAt(k, hour);
}

/** The batch dates for batch `k` counted from `startAt` (the plan's first session). Pure. */
export function batchDates(startAt: Date, k: number): { dueAt: Date; aimAt: Date } {
  return {
    dueAt: endOfBatchDaysET(startAt, BULK_BATCH.dueBusinessDays * k),
    aimAt: endOfBatchDaysET(startAt, BULK_BATCH.aimBusinessDays * k),
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
    const floorDue = endOfBatchDaysET(shoot, BULK_BATCH.dueBusinessDays);
    const floorAim = endOfBatchDaysET(shoot, BULK_BATCH.aimBusinessDays);
    const windowStart = batchNo > 1 ? batchDates(startAt, batchNo - 1).dueAt : startAt;
    return { key: v.key, index, batchNo, dueAt: later(dueAt, floorDue), aimAt: later(aimAt, floorAim), anchorAt: later(windowStart, shoot) };
  });
}
