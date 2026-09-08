import Link from "next/link";
import { AlertTriangle, ChevronDown } from "lucide-react";
import type { StuckJob } from "@/lib/queries";

// The dashboard's fire panel — PROJECT-level lateness (past deliveryDue, stale
// revisions, shot-but-undelivered). It replaced the old "Blockers" list of
// overdue admin tasks, which headlined two unsent confirmation texts while
// five jobs sat days past their delivery promise with no signal anywhere.
// Rows deep-link to the project; the overflow folds in place (below).
const SHOWN = 3; // the dashboard shows counts, not walls

function Row({ j }: { j: StuckJob }) {
  return (
    <Link href={`/projects/${j.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-surface-2">
      {/* Street only — the city/state repeats on every row and eats phone width */}
      <span className="min-w-0 flex-1 truncate">{j.title.split(",")[0]}</span>
      <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
        {j.stage.toLowerCase().replace(/_/g, " ")}
      </span>
      <span className="shrink-0 text-[11px] font-medium text-danger">{j.reason}</span>
    </Link>
  );
}

export function StuckJobs({ jobs }: { jobs: StuckJob[] }) {
  if (jobs.length === 0) return null; // nothing stuck — no red panel, no noise
  const top = jobs.slice(0, SHOWN);
  const rest = jobs.slice(SHOWN);

  return (
    <div className="panel-shadow rounded-2xl border border-danger/30 bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-danger">
        <AlertTriangle className="size-3.5" /> Stuck jobs
        <span className="ml-auto rounded-full bg-danger/10 px-1.5 text-[10px] font-medium tabular-nums">{jobs.length}</span>
      </div>
      <div className="divide-y divide-border/60">
        {top.map((j) => (
          <Row key={j.id} j={j} />
        ))}
      </div>
      {/* The rest fold in place, the same way Open Loops does. This used to be
          "+N more → Pipeline": the home's rule is that a number IS the length
          of the list it links to, and /pipeline — retired from the nav — is a
          different list (the delivery board), where no list of the N stuck
          jobs exists. A plain <details> so it works with no JS and on a phone. */}
      {rest.length > 0 && (
        <details className="group/stuck border-t border-border">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2 text-xs font-medium text-brand hover:underline">
            <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-open/stuck:rotate-0" />
            Show {rest.length} more
          </summary>
          <div className="divide-y divide-border/60 border-t border-border">
            {rest.map((j) => (
              <Row key={j.id} j={j} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
