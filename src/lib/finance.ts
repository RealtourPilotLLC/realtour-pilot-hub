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
  revenue: number; // the trusted top line, counted at all three processors
  revenueIsEstimate: boolean; // true = at least one rail is a guess, not a record
  /** Non-empty when a revenue rail is stale or estimated — print it beside the
   *  number. A rail that goes quiet without saying so is how August's P&L and
   *  the YTD P&L on the same screen came to disagree by $2,001.90. */
  revenueNote: string;
  invoiced: number; // Aryeo booked this month (a "booked vs collected" secondary line)
  photographerPay: number; // from the LEDGER — what actually left the accounts
  teamPay: number; // ditto (editors, Kim, Remar, Paul)
  accruedPhotographerPay: number; // what the payroll engine says they EARNED
  accruedTeamPay: number;
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
  const { categoryBreakdown } = await import("@/lib/financeCategories");
  const [rp, rev, photographerPay, teamPay, monthCats] = await Promise.all([
    revenueByProcessor(startKey, endKey),
    revenueForMonth(start, end), // kept only for the Aryeo "invoiced/delivered" line
    photographerCost(start, end),
    teamCost(start, end),
    // The audited bank-truth ledger — the SAME source as the Overview and
    // Categories tabs, so every finance page shows the same month profit.
    categoryBreakdown(startKey, endKey),
  ]);
  const revenue = round2(rp.total);
  // EVERY itemized row now comes from the SAME audited ledger that produces
  // profit, so the rows foot exactly and describe money that actually moved.
  //
  // They used to be sourced from the payroll ENGINE (what creatives were owed)
  // while profit came from the bank — two different worlds. The July 2026 audit
  // measured the damage: "Photographers" overstated by $48,316 YTD, "Editors &
  // team" printed $0.00 every month while $76,164 was genuinely paid, card fees
  // understated by $6,086, and the "Other expenses" plug silently absorbed a
  // $33,934 error — with the plug heading for a NEGATIVE number once payroll
  // plus fees exceeded the ledger total (July had $7,519 of headroom left).
  // Profit itself was always right; only the story it told was wrong.
  const catSum = (cats: string[]) =>
    round2(monthCats.business.filter((b) => cats.includes(b.category)).reduce((a, b) => a + b.sum, 0));
  const ledgerPhotographerPay = catSum(["Creative specialist pay"]);
  const ledgerTeamPay = catSum(["Video editing", "Photo editing", "Consulting (Paul)"]);
  const cardFees = catSum(["Stripe processing fees", "QuickBooks Payments fees"]);
  const allPayroll = round2(ledgerPhotographerPay + ledgerTeamPay);
  const profit = round2(revenue - monthCats.businessTotal);
  const expenses = round2(monthCats.businessTotal - allPayroll - cardFees);
  return {
    key, label, revenue,
    // Counted at the processor, so normally a record rather than an estimate —
    // but the Venmo rail is a manual statement import and CAN go stale or fall
    // back to a guess. revenueByProcessor now says which; pass it straight
    // through rather than hard-coding honesty we can't guarantee.
    revenueIsEstimate: rp.venmoIsEstimate,
    revenueNote: rp.venmoNote,
    invoiced: rev.aryeoDelivered,
    photographerPay: ledgerPhotographerPay,
    teamPay: ledgerTeamPay,
    // What the payroll engine says creatives EARNED this month — shown as
    // context, never mixed into the cost arithmetic above.
    accruedPhotographerPay: photographerPay,
    accruedTeamPay: teamPay,
    allPayroll, cardFees, expenses, profit,
    margin: revenue > 0 ? round4(profit / revenue) : null,
    payrollPctOfRevenue: revenue > 0 ? round4(allPayroll / revenue) : null,
  };
});

export type CashPosition = {
  bankBalance: number | null;
  bankAsOf: string | null;
  bankLive: boolean; // true = read straight from the connected bank (Plaid), not hand-typed
  stripeAvailable: number | null;
  stripePending: number | null;
  arOutstanding: number; // delivered + unpaid (money owed to us)
  comingIn30: number; // typical monthly money IN (trailing 3-mo audited ledger)
  goingOut30: number; // typical monthly money OUT (trailing 3-mo audited ledger)
  projected: number | null; // bank + comingIn30 − goingOut30, or NULL when we can't tell
  // --- how much to trust the three numbers above -------------------------
  /** "ledger" = measured off the audited bank/card ledger. "unknown" = we could
   *  not measure it, `projected` is null, and `reason` says why. */
  basis: "ledger" | "unknown";
  /** Why `projected` is null. Written for the owner; safe to print verbatim. */
  reason: string | null;
  /** Honest qualifiers on a number we DID show (stale rails, thin data). */
  caveats: string[];
  monthsSampled: number;
  sampledFrom: string; // ET day key of the sampled window's first day
  sampledTo: string;   // ET day key of its last day
};

// Trailing three FULL months — a stable read of the real monthly rhythm.
const CASH_MONTHS = 3;
// Above this share of unclassified money-out we stop pretending to know the
// burn. A fifth of the spend being "we don't know what this was" is enough to
// move the answer across zero, and a blank beats a confident wrong number.
const UNCLASSIFIED_CEILING = 0.2;

export async function getCashPosition(): Promise<CashPosition> {
  const m1 = monthBounds(1);
  const m3 = monthBounds(CASH_MONTHS);

  // ---------------------------------------------------------------------------
  // WHY THIS NO LONGER READS QUICKBOOKS (Sep 2 2026 audit).
  //
  // "Money out" used to be the sum of QuickBooks Purchases. Purchases only exist
  // once a human enters them, and entry stopped: August held $2,963 against the
  // $24,496 that really left the accounts (12%), September $189 against $4,244.
  // The bank feed on the other side of the subtraction is automatic and complete,
  // so the page was pairing a full inflow against a twelfth of the outflow and
  // telling the owner a typical month would leave him +$11,537. Measured off the
  // ledger it already trusts everywhere else, the same month is −$676. The error
  // was $12,656/month, all of it flattering.
  //
  // Both sides now come from ONE source — the audited Plaid ledger that
  // categoryBreakdown() already uses for profit — so the runway can no longer
  // drift away from the P&L on the same screen.
  //
  // What counts as money OUT: every BUSINESS, PERSONAL and still-unclassified
  // dollar, counted once. Owner draws are in deliberately — a draw is cash
  // genuinely gone from the account this projection starts at. EXCLUDE rows are
  // out: self-transfers, credit-card paydowns and Stripe top-ups only move money
  // that is already counted elsewhere (the card PURCHASES are the cost, not the
  // paydown). Refunds net against the cost they reverse, exactly as in
  // categoryBreakdown, so the two engines describe the same dollars.
  //
  // What counts as money IN: INCOME credits only. Not "every deposit" — a
  // self-transfer, an ACH reversal and a Venmo cash-out all land looking like
  // sales, and a Stripe Capital drawdown is borrowed money, not revenue (one
  // $15,533.56 advance once made a typical month read $5,178 richer). The
  // categorizer already sorts those into EXCLUDE, which is why this can be a
  // single clause instead of a growing list of memo exclusions.
  //
  // Stripe-side costs (Connect transfers to James/Harrison, Stripe fees,
  // Capital paydowns) are deliberately NOT added to money-out here, even though
  // categoryBreakdown does add them: Stripe deducts all of them BEFORE it pays
  // out, so the payout that lands as an INCOME credit is already net of them.
  // Verified Jun–Aug: $94,119 charged − $3,810 fees − $22,231 transferred =
  // $68,078, against $66,415 of payout credits in the bank. Counting them again
  // would double-charge the business roughly $8.6k a month.
  // ---------------------------------------------------------------------------
  const window = { gte: m3.start, lte: m1.end };
  // Sampled month-by-month as well as in total. A whole silent month inside the
  // window drags the average down by up to a third and looks exactly like a
  // cheap month — which is the failure this whole fix exists to stop, just
  // moved one ledger to the left. So check for it explicitly.
  const sampledMonths = Array.from({ length: CASH_MONTHS }, (_, i) => monthBounds(CASH_MONTHS - i));
  const [snap, ar, outAgg, inAgg, plaidBiz, monthCounts] = await Promise.all([
    // Latest reading; createdAt breaks ties so a same-day correction wins.
    prisma.cashSnapshot.findFirst({ orderBy: [{ asOf: "desc" }, { createdAt: "desc" }], select: { balance: true, asOf: true } }),
    getBillingRows().then((b) => b.totalOutstanding).catch(() => 0),
    prisma.plaidTransaction.groupBy({ by: ["financeKind"], where: { date: window, amount: { gt: 0 } }, _sum: { amount: true }, _count: true }),
    prisma.plaidTransaction.groupBy({ by: ["financeKind"], where: { date: window, amount: { lt: 0 } }, _sum: { amount: true }, _count: true }),
    // LIVE business-bank balance straight from Plaid (checking/savings tagged
    // Business on /connections/banks) — refreshed by the daily sync, so the
    // owner never has to hand-type a number the hub already knows.
    prisma.plaidAccount.findMany({
      where: { isBusiness: true, type: "depository", currentBalance: { not: null } },
      select: { currentBalance: true, item: { select: { lastSyncedAt: true } } },
    }),
    Promise.all(sampledMonths.map((m) =>
      prisma.plaidTransaction.count({ where: { date: { gte: m.start, lte: m.end }, amount: { gt: 0 } } }),
    )),
  ]);
  let stripeAvailable: number | null = null;
  let stripePending: number | null = null;
  try {
    const { stripeBalance } = await import("@/lib/integrations/stripe");
    const bal = await stripeBalance();
    if (bal) { stripeAvailable = bal.available; stripePending = bal.pending; }
  } catch { /* not connected — degrade */ }

  // null financeKind = synced but never classified. It still left the account,
  // so it counts as spend — and it counts toward the "can we even tell?" test.
  const debit = (k: string | null) => outAgg.find((g) => g.financeKind === k)?._sum.amount ?? 0;
  const debitN = (k: string | null) => outAgg.find((g) => g.financeKind === k)?._count ?? 0;
  const credit = (k: string | null) => Math.abs(inAgg.find((g) => g.financeKind === k)?._sum.amount ?? 0);

  const spendGross = debit("BUSINESS") + debit("PERSONAL") + debit("REVIEW") + debit(null);
  const refunds = credit("BUSINESS") + credit("PERSONAL"); // net against the cost they reverse
  const spend3 = spendGross - refunds;
  const income3 = credit("INCOME");
  const unclassified3 = debit("REVIEW") + debit(null);
  const spendRows = debitN("BUSINESS") + debitN("PERSONAL") + debitN("REVIEW") + debitN(null);

  const goingOut30 = round2(spend3 / CASH_MONTHS);
  const comingIn30 = round2(income3 / CASH_MONTHS);

  // Live Plaid balance wins over the hand-typed snapshot; the manual entry
  // remains the fallback for accounts that aren't connected.
  const liveBank = plaidBiz.length > 0 ? round2(plaidBiz.reduce((s, a) => s + (a.currentBalance ?? 0), 0)) : null;
  const liveAsOf = plaidBiz.reduce<Date | null>(
    (m, a) => (a.item.lastSyncedAt && (!m || a.item.lastSyncedAt > m) ? a.item.lastSyncedAt : m),
    null,
  );
  const bankLive = liveBank != null;
  const bankBalance = liveBank ?? snap?.balance ?? null;

  const sampledFrom = etDayKey(m3.start);
  const sampledTo = etDayKey(m1.end);

  // --- Can we honestly answer at all? A blank beats a flattering guess. ------
  // The old code answered YES no matter what: an empty ledger silently fell back
  // to "last month's payroll plus the recurring-expense table", which is a
  // fraction of the real burn and reads as a comfortable month every time.
  let basis: CashPosition["basis"] = "ledger";
  let reason: string | null = null;
  const silentMonths = sampledMonths.filter((_, i) => monthCounts[i] === 0);
  if (spendRows === 0 || spend3 <= 0) {
    basis = "unknown";
    reason = `No categorized bank or card activity between ${sampledFrom} and ${sampledTo}, so there is nothing to measure a typical month against. Reconnect your accounts on /connections/banks and this fills in by itself.`;
  } else if (silentMonths.length > 0) {
    basis = "unknown";
    reason = `${silentMonths.map((m) => m.label).join(" and ")} ${silentMonths.length === 1 ? "has" : "have"} no bank activity at all, so a "typical month" averaged over ${sampledFrom}–${sampledTo} would read far cheaper than the real one. Re-sync your accounts on /connections/banks and the projection comes back.`;
  } else if (unclassified3 / spendGross > UNCLASSIFIED_CEILING) {
    basis = "unknown";
    reason = `${Math.round((unclassified3 / spendGross) * 100)}% of the money that left your accounts between ${sampledFrom} and ${sampledTo} hasn't been classified yet ($${Math.round(unclassified3).toLocaleString("en-US")}). That is too much unknown spend to project a balance from — sort those rows and the number comes back.`;
  } else if (bankBalance == null) {
    reason = "No bank balance yet — connect an account on /connections/banks, or enter one on the Money tab, and this projects forward.";
  }

  const projected = basis === "ledger" && bankBalance != null
    ? round2(bankBalance + comingIn30 - goingOut30)
    : null;

  // --- Qualifiers on a number we DID show -----------------------------------
  const caveats: string[] = [];
  if (basis === "ledger" && unclassified3 > 0) {
    caveats.push(`$${Math.round(unclassified3).toLocaleString("en-US")} of the sampled spend is still unclassified and is counted as money out.`);
  }
  // The Venmo and Tilt "accounts" only move when Jordan uploads a statement. A
  // stale one silently REMOVES spend from the sampled window, which biases the
  // runway optimistic — the exact direction this whole fix is about. One
  // sentence for all of them: three near-identical warnings read as noise and
  // get skipped, which defeats the point of warning at all.
  try {
    const { railFreshness } = await import("@/lib/financeCategories");
    const fresh = await railFreshness();
    // Row dates are stored at noon UTC so their ET day is unambiguous; compare
    // day KEYS rather than subtracting a noon from an ET-midnight boundary.
    const lastSampledMs = Date.parse(`${sampledTo}T00:00:00Z`);
    const stale = fresh.manual
      .map((rail) => {
        if (!rail.newest) return null;
        const key = etDayKey(rail.newest);
        const missedDays = Math.round((lastSampledMs - Date.parse(`${key}T00:00:00Z`)) / 864e5);
        return missedDays >= 7 ? { label: rail.label, key, missedDays } : null; // a few days' lag isn't worth the noise
      })
      .filter((x): x is { label: string; key: string; missedDays: number } => x != null);
    if (stale.length > 0) {
      const worst = stale.reduce((a, b) => (b.missedDays > a.missedDays ? b : a));
      const list = stale.map((s) => `${s.label} (${s.key})`).join(", ");
      caveats.push(`${stale.length === 1 ? "One rail is" : `${stale.length} rails are`} statement-imported and have gone stale — ${list}. Up to ${worst.missedDays} days of the sampled period carry no spend from ${stale.length === 1 ? "it" : "them"} at all, so the real money-out is HIGHER than the $${Math.round(goingOut30).toLocaleString("en-US")} shown.`);
    }
  } catch { /* freshness is a nicety — never fail the cash card over it */ }
  if (bankLive && liveAsOf) {
    const staleDays = Math.floor((Date.now() - liveAsOf.getTime()) / 864e5);
    if (staleDays >= 3) caveats.push(`The bank balance was last refreshed ${staleDays} days ago (${etDayKey(liveAsOf)}).`);
  }

  return {
    bankBalance,
    bankAsOf: bankLive ? (liveAsOf ? etDayKey(liveAsOf) : null) : snap?.asOf ? etDayKey(snap.asOf) : null,
    bankLive,
    stripeAvailable, stripePending,
    arOutstanding: round2(ar),
    comingIn30,
    goingOut30,
    projected,
    basis, reason, caveats,
    monthsSampled: CASH_MONTHS,
    sampledFrom, sampledTo,
  };
}

// Payroll-as-%-of-revenue trend — the "am I overpaying?" answer, a few months back.
export async function getPayrollTrend(months = 4): Promise<{ key: string; label: string; revenue: number; allPayroll: number; pct: number | null }[]> {
  // The four month computations are independent — run them together (was a
  // serial loop on the Overview render path — audit).
  const pnls = await Promise.all(Array.from({ length: months }, (_, i) => getMonthlyPnl(months - 1 - i)));
  return pnls.map((p) => ({ key: p.key, label: p.label, revenue: p.revenue, allPayroll: p.allPayroll, pct: p.payrollPctOfRevenue }));
}
