import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { StuckJob } from "@/lib/queries";

// The dashboard's fire panel — PROJECT-level lateness (past deliveryDue, stale
// revisions, shot-but-undelivered). It replaced the old "Blockers" list of
// overdue admin tasks, which headlined two unsent confirmation texts while
// five jobs sat days past their delivery promise with no signal anywhere.
// Rows deep-link to the project; overflow lands on the pipeline board where
// every late stage is visible at once.
export function StuckJobs({ jobs }: { jobs: StuckJob[] }) {
  if (jobs.length === 0) return null; // nothing stuck — no red panel, no noise
  const top = jobs.slice(0, 3); // cap 3 — the dashboard shows counts, not walls

  return (
    <div className="panel-shadow rounded-2xl border border-danger/30 bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-danger">
        <AlertTriangle className="size-3.5" /> Stuck jobs
        <span className="ml-auto rounded-full bg-danger/10 px-1.5 text-[10px] font-medium tabular-nums">{jobs.length}</span>
      </div>
      <div className="divide-y divide-border/60">
        {top.map((j) => (
          <Link key={j.id} href={`/projects/${j.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-surface-2">
            {/* Street only — the city/state repeats on every row and eats phone width */}
            <span className="min-w-0 flex-1 truncate">{j.title.split(",")[0]}</span>
            <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
              {j.stage.toLowerCase().replace(/_/g, " ")}
            </span>
            <span className="shrink-0 text-[11px] font-medium text-danger">{j.reason}</span>
          </Link>
        ))}
      </div>
      {jobs.length > 3 && (
        <Link href="/pipeline" className="block border-t border-border px-4 py-2 text-xs font-medium text-brand hover:underline">
          +{jobs.length - 3} more → Pipeline
        </Link>
      )}
    </div>
  );
}
