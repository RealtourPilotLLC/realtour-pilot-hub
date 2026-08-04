import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { AdvisorChat } from "@/components/finance/AdvisorChat";
import { ReportBuilder } from "@/components/finance/ReportBuilder";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Owner-only AI CPA & Financial Advisor: a finance-scoped agent over the same
// audited engines the tabs render, plus formal statements exported to PDF.
export async function AdvisorTab({ show }: { show: FinanceTab[] }) {
  const reports = await prisma.financeReport.findMany({
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { id: true, title: true, startKey: true, endKey: true, createdAt: true },
  });
  return (
    <div>
      <PageHeader eyebrow="Finance" title="Advisor" subtitle="Your AI CPA — ask anything about the money, or generate a statement" />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="advisor" show={show} />
        <AdvisorChat />
        <ReportBuilder reports={reports.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))} />
      </div>
    </div>
  );
}
