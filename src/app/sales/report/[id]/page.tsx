import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { Markdown } from "@/components/ui/Markdown";
import { ReportToolbar } from "./PrintButton";

export const dynamic = "force-dynamic";

// A generated financial statement, laid out as a printable document. The
// "Download PDF" button prints just the statement (print CSS hides the app
// chrome), so the browser's Save-as-PDF produces a clean paginated file.
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser().catch(() => null);
  const isOwner = me ? me.role === "OWNER" : !authEnforced();
  if (!isOwner) redirect("/sales");

  const { id } = await params;
  const report = await prisma.financeReport.findUnique({ where: { id } });
  if (!report) notFound();

  const generated = report.createdAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <style
        // Print: show ONLY the statement, full-width, white background.
        dangerouslySetInnerHTML={{
          __html: `@media print {
            body * { visibility: hidden; }
            .print-report, .print-report * { visibility: visible; }
            .print-report { position: absolute; left: 0; top: 0; width: 100%; border: none !important; background: white !important; color: #111 !important; padding: 0 !important; }
            .print-report * { color: #111 !important; border-color: #ddd !important; background: transparent !important; }
            .print-hide { display: none !important; }
          }
          @page { margin: 1.6cm; }`,
        }}
      />
      <ReportToolbar />
      <article className="print-report rounded-2xl border border-border bg-surface p-6 sm:p-10">
        <header className="mb-6 border-b border-border pb-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand">RealTour Pilot LLC</p>
          <h1 className="mt-1 text-2xl font-bold">{report.title}</h1>
          <p className="mt-1 text-sm text-muted">
            Period: {report.startKey} through {report.endKey} · Generated {generated}
          </p>
        </header>
        <Markdown content={report.markdown} className="report-body text-[15px] leading-relaxed" />
        <footer className="mt-8 border-t border-border pt-3 text-[11px] text-muted-2">
          Prepared by the RealTour Pilot Operations Hub from the live audited ledger (bank, card, Venmo, Stripe, QuickBooks). Figures drift as new
          transactions post or categories are re-tagged. Not a substitute for review by a licensed CPA.
        </footer>
      </article>
    </div>
  );
}
