import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { BudgetScreen, type BudgetRow } from "@/components/finance/BudgetScreen";
import { personalTruth, categoryBreakdown } from "@/lib/financeCategories";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Personal budget: monthly targets per category vs live actuals from the same
// audited ledger as everything else. The AI Advisor can set and rebalance the
// targets (set_budget tool); the owner can edit any number inline.
export async function BudgetTab({ show }: { show: FinanceTab[] }) {
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const monthKey = todayKey.slice(0, 7);
  const threeBack = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0, 10);

  const [targets, monthData, trailing, breakdown] = await Promise.all([
    prisma.budgetTarget.findMany({ orderBy: { monthlyTarget: "desc" } }),
    personalTruth(`${monthKey}-01`, todayKey),
    personalTruth(threeBack, `${monthKey}-01`),
    // The full category roster (business + personal) for the drill-in's
    // recategorize dropdowns — a mis-tagged business charge gets moved OUT of
    // the personal budget from right here.
    categoryBreakdown(`${now.getUTCFullYear()}-01-01`, `${now.getUTCFullYear()}-12-31`),
  ]);
  const allCategories = [
    ...breakdown.business.map((r) => ({ category: r.category, kind: "BUSINESS" })),
    ...breakdown.personal.map((r) => ({ category: r.category, kind: "PERSONAL" })),
  ];
  const actualBy = Object.fromEntries(monthData.byBucket.map((b) => [b.bucket, b.amount]));
  const avgBy = Object.fromEntries(trailing.byBucket.map((b) => [b.bucket, b.amount / 3]));

  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  const rows: BudgetRow[] = targets.map((t) => ({
    category: t.category,
    target: t.monthlyTarget,
    note: t.note,
    spent: actualBy[t.category] ?? 0,
    avg3mo: avgBy[t.category] ?? 0,
  }));
  const unbudgeted = monthData.byBucket
    .filter((b) => !targets.some((t) => t.category === b.bucket))
    .map((b) => ({ category: b.bucket, spent: b.amount, avg3mo: avgBy[b.bucket] ?? 0 }));

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Budget" subtitle="Your personal budget — targets vs reality, managed with your Advisor" />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="budget" show={show} />
        <BudgetScreen
          rows={rows}
          unbudgeted={unbudgeted}
          monthKey={monthKey}
          dayOfMonth={dayOfMonth}
          daysInMonth={daysInMonth}
          totalSpent={monthData.total}
          allCategories={allCategories}
          startKey={`${monthKey}-01`}
          endKey={todayKey}
        />
      </div>
    </div>
  );
}
