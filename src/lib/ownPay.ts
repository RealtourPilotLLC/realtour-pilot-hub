import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey } from "@/lib/datetime";
import { payPeriodFor, periodBounds, shiftPeriod, type PayPeriod } from "@/lib/payroll";
import { FIXED_PAY_FROM, PAY_PERIOD_DAYS, fixedPayment, type FixedPayTerms } from "@/lib/payStructure";

// ---------------------------------------------------------------------------
// A FIXED-PAY PERSON'S OWN PAY, AS THEY SEE IT ON MY PAY (Jordan, Oct 27 2026:
// "Harrison and James should see their own pay schedule and amount and
// bonuses").
//
// Built from the terms (lib/payStructure, the figures Payroll pays) and their
// own PayoutAdjustment rows, never from the payroll engine: there is no
// mileage on fixed pay, so nothing here routes a day or reads anyone else.
//   · schedule: every two weeks, paid the Friday after the period closes;
//   · amount: one paycheck (the yearly amounts ÷ 26) and the year;
//   · paychecks: every pay period from Sep 20 2026 (the first on fixed pay)
//     through the current one, each the regular payment plus whatever was
//     added to it (a bonus, a weekend premium, a correction);
//   · bonuses paid: every "Quarterly bonus" line ever written for them.
// The old per-shoot model and the old-vs-new comparison are not here: those
// are the owner's (lib/paySavings). The bonus being tracked now is the KPI
// scorecard's (lib/kpi), shown beside this on the page.
// ---------------------------------------------------------------------------

export type OwnAdjustment = { id: string; label: string; amount: number; dayKey: string };

export type OwnPaycheck = PayPeriod & {
  regular: number;
  adjustments: OwnAdjustment[];
  total: number;
  /** paid = payday has passed; today = pays today; upcoming = closed, waiting for payday; accruing = the current period */
  state: "paid" | "today" | "upcoming" | "accruing";
};

export type OwnFixedPay = {
  annual: { serviceFee: number; vehicle: number; total: number };
  perPaycheck: { serviceFee: number; vehicle: number; total: number };
  bonusMax: number;
  periodDays: number;
  /** the next paycheck to land, and the period it pays */
  nextPayday: PayPeriod;
  paychecks: OwnPaycheck[];
  bonusesPaid: (OwnAdjustment & { payoutKey: string })[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const BONUS_LABEL = /^Quarterly bonus /;

/** Pure: the page's figures from the terms, their adjustment rows and today's ET day. */
export function buildOwnFixedPay(terms: Pick<FixedPayTerms, "serviceFee" | "vehicle" | "bonusMax">, adjustments: OwnAdjustment[], todayKey: string): OwnFixedPay {
  const pay = fixedPayment(terms);
  const current = payPeriodFor(todayKey);
  const prev = shiftPeriod(current.startKey, -1);
  // The paycheck still waiting for its Friday, else the current period's.
  const nextPayday = prev.payoutKey >= todayKey && prev.startKey >= FIXED_PAY_FROM ? prev : current;

  const paychecks: OwnPaycheck[] = [];
  // Guarded walk: 27 periods a year, so this stops however long it has run.
  for (let p = payPeriodFor(FIXED_PAY_FROM), guard = 0; p.startKey <= current.startKey && guard < 600; p = shiftPeriod(p.startKey, 1), guard++) {
    const adj = adjustments.filter((a) => a.dayKey >= p.startKey && a.dayKey <= p.endKey);
    const state: OwnPaycheck["state"] =
      p.payoutKey < todayKey ? "paid" : p.payoutKey === todayKey ? "today" : p.endKey < todayKey ? "upcoming" : "accruing";
    paychecks.push({ ...p, regular: pay.total, adjustments: adj, total: r2(pay.total + adj.reduce((s, a) => s + a.amount, 0)), state });
  }
  paychecks.reverse(); // newest first

  const bonusesPaid = adjustments
    .filter((a) => BONUS_LABEL.test(a.label))
    .map((a) => ({ ...a, payoutKey: payPeriodFor(a.dayKey).payoutKey }))
    .sort((a, b) => b.dayKey.localeCompare(a.dayKey));

  return {
    annual: { serviceFee: terms.serviceFee, vehicle: terms.vehicle, total: terms.serviceFee + terms.vehicle },
    perPaycheck: pay,
    bonusMax: terms.bonusMax,
    periodDays: PAY_PERIOD_DAYS,
    nextPayday,
    paychecks,
    bonusesPaid,
  };
}

/** The person's own fixed pay: their terms and their own adjustment rows only. */
export async function ownFixedPayFor(memberId: string, terms: FixedPayTerms, now: Date = new Date()): Promise<OwnFixedPay> {
  const todayKey = etDayKey(now);
  // Every adjustment since the first fixed-pay period (paychecks), and every
  // bonus line ever (a bonus for a quarter before the terms is still theirs).
  const { start } = periodBounds(payPeriodFor(FIXED_PAY_FROM));
  const rows = await prisma.payoutAdjustment.findMany({
    where: { teamMemberId: memberId, OR: [{ date: { gte: start } }, { label: { startsWith: "Quarterly bonus " } }] },
    select: { id: true, label: true, amount: true, date: true },
    orderBy: { date: "asc" },
  });
  const adjustments = rows.map((r) => ({ id: r.id, label: r.label, amount: r2(r.amount), dayKey: etDayKey(r.date) }));
  return buildOwnFixedPay(terms, adjustments, todayKey);
}
