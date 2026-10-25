import "server-only";
import { prisma } from "@/lib/prisma";
import { cashBalanceOf } from "@/lib/bankBalance";
import { revenueByProcessor } from "@/lib/bookkeeping";
import { categoryBreakdown } from "@/lib/financeCategories";
import { etDayKey, etDayStartUtc } from "@/lib/datetime";
import { taskClientScopeWhere, type TaskClientScope } from "@/lib/taskClientScope";

// ---------------------------------------------------------------------------
// "WHERE IS THE BUSINESS AT" — the glance panel.
//
// EVERY figure here is a cheap indexed read. Nothing in this file may reach
// computePayroll (which resolves mileage over the public OSRM router) or make an
// external HTTP call — that combination already took /trends down in production
// with a 60-second timeout. So: no getMonthlyPnl, no getCashPosition, no
// jobProfitability, no live Stripe balance. Margin and the growth plan are read
// from their precomputed rows or not shown at all.
//
// Profit is computed exactly the way Finance → Overview computes it (processor
// revenue minus the categorised business spend), so the two screens can never
// quote different numbers at each other.
// ---------------------------------------------------------------------------

const money = (n: number) => Math.round(n);

export type OwnerPulseSnapshot = {
  monthLabel: string;
  revenueMonth: number;
  spendMonth: number;
  profitMonth: number;
  marginPct: number | null;
  revenueYtd: number;
  bankBalance: number | null;
  bankAsOf: Date | null;
  /** Which accounts that figure is — never let it read as "all the cash". */
  bankLabel: string | null;
  owedToYou: number;
  owedCount: number;
  shootsThisWeek: number;
  deliveredThisMonth: number;
  openTasks: number;
  overdueTasks: number;
  /** Oct 21 2026 (audit H3/G): the QuickBooks rail is capped at its last
   *  sync (bookkeeping.revenueByProcessor), so the revenue figures leave out
   *  QuickBooks payments since then. This says so in words; null when the
   *  rail is current. Owner screens only (Kyle never sees money). */
  revenueNote: string | null;
};

export async function ownerPulse(opts: TaskClientScope = {}): Promise<OwnerPulseSnapshot> {
  // Scope workload only. Ledger/bank/AR figures retain Finance's definition.
  const clientScope = opts.excludeClientIds?.length ? { clientId: { notIn: opts.excludeClientIds } } : {};
  const now = new Date();
  const todayKey = etDayKey(now);
  const monthStartKey = `${todayKey.slice(0, 7)}-01`;
  const yearStartKey = `${todayKey.slice(0, 4)}-01-01`;

  // THIS WEEK AND THIS MONTH IN EASTERN TIME (Oct 20 2026, audit A11). The
  // week was today 00:00 UTC (8 PM ET yesterday) plus seven days, neither ET
  // nor Monday-based, and counted cancelled visits; the month began at UTC
  // midnight on the 1st, so a delivery on the last evening of a month counted
  // in the next one, unlike the dashboard's getOwnerStats. Now: Monday 00:00
  // ET to the next Monday (opsHome.etWeekStart's rule), visits not cancelled
  // on jobs not cancelled; the month from 00:00 ET on the 1st.
  const noonToday = new Date(etDayStartUtc(now).getTime() + 12 * 3_600_000);
  const dow = new Date(`${todayKey}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const weekStart = etDayStartUtc(new Date(noonToday.getTime() - ((dow + 6) % 7) * 86_400_000));
  const weekEnd = etDayStartUtc(new Date(weekStart.getTime() + 7 * 86_400_000 + 12 * 3_600_000));
  const monthStart = etDayStartUtc(new Date(`${monthStartKey}T12:00:00Z`));

  const [revMonth, revYtd, spend, banks, ar, shoots, delivered, tasks] = await Promise.all([
    revenueByProcessor(monthStartKey, todayKey).catch(() => null),
    revenueByProcessor(yearStartKey, todayKey).catch(() => null),
    categoryBreakdown(monthStartKey, todayKey).catch(() => null),
    // Read the stored balance directly — getCashPosition would call Stripe live.
    prisma.plaidAccount
      .findMany({
        where: { isBusiness: true, type: "depository" },
        select: { name: true, type: true, currentBalance: true, availableBalance: true, updatedAt: true },
      })
      .catch(() => []),
    prisma.project
      .aggregate({
        _sum: { balanceAmount: true },
        _count: { _all: true },
        // Same definition of "owed" as getBillingRows / Finance → Unpaid:
        // delivered, still has a balance, and NOT taken off the AR list by the
        // owner (cancelled appointment / test order). /day links straight to
        // Finance, so these two must never disagree (review HIGH).
        where: {
          AND: [
            { OR: [{ status: "DELIVERED" }, { deliveredAt: { not: null } }] },
            { balanceAmount: { gt: 0 } },
            { arRemovedAt: null },
            { paidMarkedAt: null },
            { aryeoMissingAt: null },
          ],
        },
      })
      .catch(() => null),
    prisma.appointment
      // A visit with no status is not cancelled: `not` alone would drop it (a NULL never matches).
      .count({ where: { OR: [{ status: null }, { status: { not: "CANCELED" } }], project: { ...clientScope, status: { not: "CANCELLED" } }, startAt: { gte: weekStart, lt: weekEnd } } })
      .catch(() => 0),
    prisma.project
      .count({ where: { ...clientScope, deliveredAt: { gte: monthStart }, status: { not: "CANCELLED" } } })
      .catch(() => 0),
    prisma.smartTask
      .findMany({ where: { AND: [taskClientScopeWhere(opts)], status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { dueAt: true } })
      .catch(() => []),
  ]);

  const revenueMonth = money(revMonth?.total ?? 0);
  const spendMonth = money(spend?.businessTotal ?? 0);
  const profitMonth = revenueMonth - spendMonth;
  const bankBalance = banks.length ? money(banks.reduce((s, b) => s + (cashBalanceOf(b) ?? 0), 0)) : null;
  const bankAsOf = banks.length ? banks.reduce<Date | null>((m, b) => (!m || b.updatedAt > m ? b.updatedAt : m), null) : null;
  // Name the accounts. Only the ones tagged Business on /connections/banks are
  // counted, and today that is a single overdrawn payroll account — a bare
  // "in the bank" figure would read as ALL the cash and quietly be wrong.
  const bankLabel = banks.length
    ? banks.map((b) => b.name).filter(Boolean).join(" + ") || `${banks.length} account${banks.length === 1 ? "" : "s"}`
    : null;

  return {
    monthLabel: new Date(`${monthStartKey}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }),
    revenueMonth,
    spendMonth,
    profitMonth,
    marginPct: revenueMonth > 0 ? (profitMonth / revenueMonth) * 100 : null,
    revenueYtd: money(revYtd?.total ?? 0),
    bankBalance,
    bankAsOf,
    bankLabel,
    owedToYou: money((ar?._sum.balanceAmount ?? 0) / 100),
    owedCount: ar?._count._all ?? 0,
    shootsThisWeek: shoots,
    deliveredThisMonth: delivered,
    openTasks: tasks.length,
    overdueTasks: tasks.filter((t) => t.dueAt && etDayKey(t.dueAt) < todayKey).length,
    // The year's note names where the gap really starts (the month's starts
    // on the 1st at the latest); either one means both figures are short.
    revenueNote: revYtd?.quickbooksNote || revMonth?.quickbooksNote || null,
  };
}
