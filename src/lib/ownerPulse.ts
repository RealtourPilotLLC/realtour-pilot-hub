import "server-only";
import { prisma } from "@/lib/prisma";
import { revenueByProcessor } from "@/lib/bookkeeping";
import { categoryBreakdown } from "@/lib/financeCategories";
import { etDayKey } from "@/lib/datetime";

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
};

export async function ownerPulse(): Promise<OwnerPulseSnapshot> {
  const now = new Date();
  const todayKey = etDayKey(now);
  const monthStartKey = `${todayKey.slice(0, 7)}-01`;
  const yearStartKey = `${todayKey.slice(0, 4)}-01-01`;

  const weekStart = new Date(now.getTime() - 0);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  const [revMonth, revYtd, spend, banks, ar, shoots, delivered, tasks] = await Promise.all([
    revenueByProcessor(monthStartKey, todayKey).catch(() => null),
    revenueByProcessor(yearStartKey, todayKey).catch(() => null),
    categoryBreakdown(monthStartKey, todayKey).catch(() => null),
    // Read the stored balance directly — getCashPosition would call Stripe live.
    prisma.plaidAccount
      .findMany({
        where: { isBusiness: true, type: "depository" },
        select: { name: true, currentBalance: true, updatedAt: true },
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
          ],
        },
      })
      .catch(() => null),
    prisma.appointment.count({ where: { startAt: { gte: weekStart, lt: weekEnd } } }).catch(() => 0),
    prisma.project
      .count({ where: { deliveredAt: { gte: new Date(`${monthStartKey}T00:00:00Z`) } } })
      .catch(() => 0),
    prisma.smartTask
      .findMany({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { dueAt: true } })
      .catch(() => []),
  ]);

  const revenueMonth = money(revMonth?.total ?? 0);
  const spendMonth = money(spend?.businessTotal ?? 0);
  const profitMonth = revenueMonth - spendMonth;
  const bankBalance = banks.length ? money(banks.reduce((s, b) => s + (b.currentBalance ?? 0), 0)) : null;
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
  };
}
