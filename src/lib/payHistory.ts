import "server-only";
import { computePayroll, payPeriodFor, shiftPeriod, periodBounds, type PayrollPerson } from "@/lib/payroll";
import { etDayKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// A creative's own pay HISTORY — every closed period they can look back at, plus
// their year-to-date total.
//
// Built from ONE computePayroll pass over the whole year rather than one call
// per period. That is not just a speed trick, it is the only sane way to do it:
// computePayroll resolves mileage through the public OSRM router, so running it
// once per period would multiply a network-bound job by however many periods the
// page shows. One pass, scoped to the one member, is ~1.7s and yields both the
// history and the YTD figure.
//
// The decomposition is exact because pay is inherently per-day: shoot pay is
// per job, mileage is already shared out per job (jobTotal = shootPay +
// mileageShare), and adjustments carry their own date. So a period's total is
// just the jobs and adjustments whose day falls inside it — which is verified to
// reconcile against a direct per-period computePayroll.
// ---------------------------------------------------------------------------

export type PayPeriodSummary = {
  startKey: string;
  endKey: string;
  payoutKey: string;
  shootPay: number;
  mileage: number;
  adjustments: number;
  total: number;
  jobs: number;
  isCurrent: boolean;
  isFuture: boolean; // the period that hasn't started yet
  isPaid: boolean; // payday has passed
};

export type PayHistory = {
  person: PayrollPerson | null;
  periods: PayPeriodSummary[]; // newest first
  ytd: { total: number; shootPay: number; mileage: number; adjustments: number; jobs: number; periodsWorked: number };
  year: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The earliest period we will ever show — the anchor that contains June 1. */
export const HISTORY_FLOOR_KEY = "2026-05-31";

export async function payHistoryFor(memberId: string): Promise<PayHistory> {
  const todayKey = etDayKey(new Date());
  const year = Number(todayKey.slice(0, 4));
  const current = payPeriodFor();
  const next = shiftPeriod(current.startKey, 1);

  // Load from the START OF THE PERIOD CONTAINING Jan 1, not from Jan 1 itself.
  // A pay period straddles the new year (2025-12-28 → 2026-01-10), and windowing
  // at Jan 1 returned only part of it while the row still claimed to be the whole
  // period — it under-reported that period by the days sitting in December.
  const yearFirstKey = `${year}-01-01`;
  const { start: windowStart } = periodBounds(payPeriodFor(yearFirstKey));
  const { end: nextEnd } = periodBounds(next);
  const people = await computePayroll(windowStart, nextEnd, { memberId });
  const person = people.find((p) => p.member.id === memberId) ?? null;

  const jobs = person?.jobs ?? [];
  const adjustments = person?.adjustments ?? [];

  // Walk periods from the floor (or the member's first paid day, whichever is
  // earlier — so the browsable history always adds up to the YTD figure instead
  // of quietly starting after some of their money).
  const firstJobKey = jobs.reduce<string | null>((min, j) => (!min || j.dayKey < min ? j.dayKey : min), null);
  const firstAdjKey = adjustments.reduce<string | null>(
    (min, a) => {
      const k = etDayKey(new Date(a.dateISO));
      return !min || k < min ? k : min;
    },
    null as string | null,
  );
  const earliestActivity = [firstJobKey, firstAdjKey].filter(Boolean).sort()[0] ?? HISTORY_FLOOR_KEY;
  const startFrom = payPeriodFor(earliestActivity < HISTORY_FLOOR_KEY ? earliestActivity : HISTORY_FLOOR_KEY);

  const periods: PayPeriodSummary[] = [];
  let p = startFrom;
  // Hard stop well past the next period — a malformed key must never spin here.
  for (let guard = 0; guard < 60; guard++) {
    const inPeriod = jobs.filter((j) => j.dayKey >= p.startKey && j.dayKey <= p.endKey);
    const adj = adjustments.filter((a) => {
      const k = etDayKey(new Date(a.dateISO));
      return k >= p.startKey && k <= p.endKey;
    });
    const shootPay = r2(inPeriod.reduce((s, j) => s + j.shootPay, 0));
    const mileage = r2(inPeriod.reduce((s, j) => s + j.mileageShare, 0));
    const adjTotal = r2(adj.reduce((s, a) => s + a.amount, 0));
    periods.push({
      startKey: p.startKey,
      endKey: p.endKey,
      payoutKey: p.payoutKey,
      shootPay,
      mileage,
      adjustments: adjTotal,
      total: r2(shootPay + mileage + adjTotal),
      jobs: inPeriod.length,
      isCurrent: p.startKey === current.startKey,
      isFuture: p.startKey > current.startKey,
      isPaid: p.payoutKey < todayKey,
    });
    if (p.startKey === next.startKey) break;
    p = shiftPeriod(p.startKey, 1);
  }
  periods.reverse(); // newest first

  // YTD is counted from the JOBS, not by summing period rows. Two reasons the
  // sum would be wrong: the period straddling New Year carries December days
  // that are last year's money, and the not-yet-started period holds work that
  // hasn't happened. Filtering on the day itself is exact for both.
  const ytdJobs = jobs.filter((j) => j.dayKey >= yearFirstKey && j.dayKey <= todayKey);
  const ytdAdj = adjustments.filter((a) => {
    const k = etDayKey(new Date(a.dateISO));
    return k >= yearFirstKey && k <= todayKey;
  });
  const ytdShoot = r2(ytdJobs.reduce((s, j) => s + j.shootPay, 0));
  const ytdMiles = r2(ytdJobs.reduce((s, j) => s + j.mileageShare, 0));
  const ytdAdjTotal = r2(ytdAdj.reduce((s, a) => s + a.amount, 0));
  return {
    person,
    periods,
    ytd: {
      total: r2(ytdShoot + ytdMiles + ytdAdjTotal),
      shootPay: ytdShoot,
      mileage: ytdMiles,
      adjustments: ytdAdjTotal,
      jobs: ytdJobs.length,
      periodsWorked: periods.filter((x) => !x.isFuture && x.jobs > 0).length,
    },
    year,
  };
}
