"use client";

import { ArrowLeft, Download } from "lucide-react";
import Link from "next/link";

// window.print() with the report's print CSS = a clean, paginated PDF via the
// browser's "Save as PDF" — no server-side PDF stack to maintain.
export function ReportToolbar() {
  return (
    <div className="print-hide mb-4 flex items-center justify-between gap-3">
      <Link href="/sales?tab=advisor" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to Advisor
      </Link>
      <button
        onClick={() => window.print()}
        className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white"
      >
        <Download className="size-4" /> Download PDF
      </button>
    </div>
  );
}
