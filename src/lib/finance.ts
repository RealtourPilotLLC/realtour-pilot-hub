import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { computePayroll, payPeriodFor, shiftPeriod, periodBounds } from "@/lib/payroll";
import { etDayStartUtc, etDayKey } from "@/lib/datetime";
import { getBillingRows } from "@/lib/queries";

// ---------------------------------------------------------------------------
// The real MONEY engine — the P&L Jordan never had: revenue in, minus EVERYONE
// he pays (photographers via computePayroll + editors/ops via PayrollEntry) and
// every cost, = actual profit. CASH BASIS throughout — "what left / entered my
// account this month" — because that's the number a cash-strapped owner watches.
// Every figure reads from the same trusted sources as the drill-down tabs so
// nothing can contradict.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

// ET month boundaries [start, end] in UTC for a month `back` months before now.
// Anchor the "current" month on the ET calendar day, not UTC — otherwise late on
// the last of the month (ET) it would already read as next month.
export function monthBounds(back = 0): { start: Date; end: Date; label: string; key: string } {
  const [ey, em] = etDayKey(new Date()).split("-").map(Number); // ET year, month (1-based)
  const y = ey;
  const m = em - 1 - back; // 0-based month index, shifted back
  const start = etDayStartUtc(new Date(Date.UTC(y, m, 1, 12)));
  const end = new Date(etDayStartUtc(new Date(Date.UTC(y, m + 1, 1, 12))).getTime() - 1);
  const label = new Date(Date.UTC(y, m, 1, 12)).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", year: "numeric" });
  const key = etDayKey(new Date(Date.UTC(y, m, 1, 12))).slice(0, 7);
  return { start, end, label, key };
}

// The bi-weekly pay periods whose PAYOUT (period end + 6 days) lands in [start,end]
// — i.e. the periods whose cash actually left the account during this month.
function periodsPayingIn(start: Date, end: Date): string[] {
  const out: string[] = [];
  let p = payPeriodFor(etDayKey(start));
  p = shiftPeriod(p.startKey, -2); // back up so we can't miss an early-month payout
  for (let i = 0; i < 8; i++) {
    const payout = new Date(p.payoutKey + "T12:00:00Z");
    if (payout >= start && payout <= end) out.push(p.startKey);
    if (payout > end) break;
    p = shiftPeriod(p.startKey, 1);
  }
  return out;
}

// Photographer cost paid out during the month (the % engine, summed over periods).
async function photographerCost(start: Date, end: Date): Promise<number> {
  let total = 0;
  for (const startKey of periodsPayingIn(start, end)) {
    const b = periodBounds(payPeriodFor(startKey));
    const people = await computePayroll(b.start, b.end);
    total += people.reduce((s, x) => s + x.total, 0);
  }
  return round2(total);
}

// Editor/ops cost paid during the month (Kim, Remar, Kyle — the invisible half).
async function teamCost(start: Date, end: Date): Promise<number> {
  const agg = await prisma.payrollEntry.aggregate({
    where: { payDate: { gte: start, lte: end } },
    _sum: { amount: true },
  });
  return round2(agg._sum.amount ?? 0);
}

// Money IN. Stripe is the truth once its data covers the month; older months fall
// back to Aryeo delivered revenue, flagged as an estimate. We sum GROSS for the
// top line and fees SEPARATELY, so the P&L subtracts the card fee exactly once
// (revenue = gross; profit = gross − fees − payroll − expenses). Refunds carry a
// negative gross, so summing gross nets them out automatically.
async function revenueForMonth(start: Date, end: Date) {
  // A month is "Stripe-covered" once the synced window reaches it — so a real $0
  // collected month reads as $0, but months BEFORE Stripe was ever synced fall
  // back to the Aryeo estimate instead of a false authoritative $0.
  const earliest = await prisma.stripeTransaction.aggregate({ _min: { createdAt: true } });
  const firstTxn = earliest._min.createdAt;
  const stripeConnected = firstTxn != null && end >= firstTxn;

  const txns = await prisma.stripeTransaction.findMany({
    where: {
      createdAt: { gte: start, lte: end },
      // Money in + its reversals (charge/payment) and refunds for both integration
      // styles; payouts/transfers/fees are excluded so we never double-count.
      type: { in: ["charge", "payment", "refund", "payment_refund", "adjustment"] },
    },
    select: { gross: true, fee: true },
  });
  const stripeGross = round2(txns.reduce((s, t) => s + t.gross, 0));
  const stripeFees = round2(txns.reduce((s, t) => s + t.fee, 0));

  const delivered = await prisma.project.findMany({
    where: { status: "DELIVERED", deliveredAt: { gte: start, lte: end } },
    select: { payableInvoice: true, price: true },
  });
  const aryeoDelivered = round2(delivered.reduce((s, p) => s + (p.payableInvoice ?? p.price ?? 0), 0));

  return { stripeConnected, stripeGross, stripeFees, aryeoDelivered };
}

export type MonthlyPnl = {
  key: string;
  label: string;
  revenue: number; // the trusted top line (Stripe net if connected, else Aryeo delivered)
  revenueIsEstimate: boolean; // true = Aryeo fallback (connect Stripe for actual)
  invoiced: number; // Aryeo booked this month (a "booked vs collected" secondary line)
  photographerPay: number;
  teamPay: number;
  allPayroll: number;
  cardFees: number;
  expenses: number; // business expenses (personal excluded)
  profit: number;
  margin: number | null; // profit / revenue
  payrollPctOfRevenue: number | null;
};

// Request-memoized: MoneyTab + getCashPosition + getPayrollTrend all ask for the
// same months in one render, so cache() collapses the repeated (heavy) computes.
export const getMonthlyPnl = cache(async (back = 0): Promise<MonthlyPnl> => {
  const { start, end, label, key } = monthBounds(back);
  // Revenue at the PROCESSOR across all three rails — same canonical source as
  // the YTD P&L. The old code counted Stripe alone, which dropped every
  // QuickBooks Payments sale and Venmo shoot and could flip a profitable month
  // into a shown loss with an impossible >100% payroll ratio.
  const { revenueByProcessor } = await import("@/lib/bookkeeping");
  const startKey = `${key}-01`;
  const endKey = etDayKey(new Date(end.getTime() - 1000));
  const [rp, rev, photographerPay, teamPay, ledgerExp] = await Promise.all([
    revenueByProcessor(startKey, endKey),
    revenueForMonth(start, end), // kept only for the Aryeo "invoiced/delivered" line
    photographerCost(start, end),
    teamCost(start, end),
    // Operating + vehicle spend from the CLASSIFIED ledger (not the empty manual
    // Expense table). COST_OF_SALES is deliberately excluded — that's the
    // contractor pay the payroll engine (photographerCost/teamCost) already counts.
    prisma.qboTransaction.aggregate({
      where: { type: "Purchase", category: { in: ["OPERATING", "VEHICLE"] }, txnDate: { gte: start, lte: end } },
      _sum: { amount: true },
    }),
  ]);
  const revenue = round2(rp.total);
  const allPayroll = round2(photographerPay + teamPay);
  const expenses = round2(ledgerExp._sum.amount ?? 0);
  const cardFees = round2(rp.stripeFees);
  const profit = round2(revenue - allPayroll - cardFees - expenses);
  return {
    key, label, revenue,
    revenueIsEstimate: false, // counted at the processor, no longer an estimate
    invoiced: rev.aryeoDelivered,
    photographerPay, teamPay, allPayroll, cardFees, expenses, profit,
    margin: revenue > 0 ? round4(profit / revenue) : null,
    payrollPctOfRevenue: revenue > 0 ? round4(allPayroll / revenue) : null,
  };
});

export type CashPosition = {
  bankBalance: number | null;
  bankAsOf: string | null;
  stripeAvailable: number | null;
  stripePending: number | null;
  arOutstanding: number; // delivered + unpaid (money owed to us)
  comingIn30: number; // typical monthly money IN (trailing 3-mo actual bank deposits)
  goingOut30: number; // typical monthly money OUT (trailing 3-mo actual bank outflow)
  projected: number | null; // bank + comingIn30 − goingOut30 (a typical month from here)
};

export async function getCashPosition(): Promise<CashPosition> {
  // Trailing three FULL months — a stable read of the real monthly rhythm.
  const m1 = monthBounds(1);
  const m3 = monthBounds(3);
  const [snap, ar, prevPnl, recurring, outflow, inflowAgg] = await Promise.all([
    // Latest reading; createdAt breaks ties so a same-day correction wins.
    prisma.cashSnapshot.findFirst({ orderBy: [{ asOf: "desc" }, { createdAt: "desc" }], select: { balance: true, asOf: true } }),
    getBillingRows().then((b) => b.totalOutstanding).catch(() => 0),
    getMonthlyPnl(1), // fallback only, if the ledger is empty
    prisma.expense.aggregate({ where: { personal: false, recurring: true }, _sum: { amount: true } }),
    // Real money OUT of the bank: EVERY Purchase posted over the last 3 full
    // months — contractors, software, vehicle, financing, rent, owner draws —
    // the actual burn, not just payroll. This is the fix for a "going out" that
    // read an (empty) manual-expense table and so wildly under-counted.
    prisma.qboTransaction.aggregate({ where: { type: "Purchase", txnDate: { gte: m3.start, lte: m1.end } }, _sum: { amount: true } }),
    // Real money IN to the bank: every Deposit over the same 3 full months —
    // the cash that actually LANDS in checking. Deliberately NOT revenue, which
    // counts Venmo (lands in a personal account) and is gross of processor fees,
    // so revenue overstates what the business bank truly receives. For this
    // business the gap is large (~$56k earned vs ~$42k banked) because of Venmo +
    // Stripe detours through the personal ...0942 account.
    prisma.qboTransaction.aggregate({ where: { type: "Deposit", txnDate: { gte: m3.start, lte: m1.end } }, _sum: { amount: true } }),
  ]);
  let stripeAvailable: number | null = null;
  let stripePending: number | null = null;
  try {
    const { stripeBalance } = await import("@/lib/integrations/stripe");
    const bal = await stripeBalance();
    if (bal) { stripeAvailable = bal.available; stripePending = bal.pending; }
  } catch { /* not connected — degrade */ }

  const burn = (outflow._sum.amount ?? 0) / 3;
  const inflow = (inflowAgg._sum.amount ?? 0) / 3;
  const goingOut30 = round2(burn > 0 ? burn : prevPnl.allPayroll + (recurring._sum.amount ?? 0));
  const comingIn30 = round2(inflow > 0 ? inflow : prevPnl.revenue);
  const bankBalance = snap?.balance ?? null;
  // A typical month starting from today's bank: what comes in, less what goes out.
  const projected = bankBalance != null ? round2(bankBalance + comingIn30 - goingOut30) : null;
  return {
    bankBalance,
    bankAsOf: snap?.asOf ? etDayKey(snap.asOf) : null,
    stripeAvailable, stripePending,
    arOutstanding: round2(ar),
    comingIn30,
    goingOut30,
    projected,
  };
}

// Payroll-as-%-of-revenue trend — the "am I overpaying?" answer, a few months back.
export async function getPayrollTrend(months = 4): Promise<{ key: string; label: string; revenue: number; allPayroll: number; pct: number | null }[]> {
  const out: { key: string; label: string; revenue: number; allPayroll: number; pct: number | null }[] = [];
  for (let b = months - 1; b >= 0; b--) {
    const p = await getMonthlyPnl(b);
    out.push({ key: p.key, label: p.label, revenue: p.revenue, allPayroll: p.allPayroll, pct: p.payrollPctOfRevenue });
  }
  return out;
}
