import Link from "next/link";
import { Radar, DollarSign, UserMinus, RefreshCw, ChevronRight } from "lucide-react";
import type { ProactiveFlag } from "@/lib/queries";
import { ink } from "@/components/ui/Badge";

const KIND_ICON = { ar: DollarSign, "vip-quiet": UserMinus, revision: RefreshCw } as const;
const SEV = {
  high: { dot: "#f87171", chip: "bg-danger/10 text-danger", label: "High" },
  medium: { dot: "#fbbf24", chip: "bg-warning/10 text-warning", label: "Watch" },
  low: { dot: "#34d399", chip: "bg-success/10 text-success", label: "Low" },
} as const;

// "On your radar" — strategic risks (aging AR, quiet VIPs, stale revisions) that
// the tactical task list doesn't surface. Shown near the top of the dashboard.
export function ProactiveFlags({ flags }: { flags: ProactiveFlag[] }) {
  const highCount = flags.filter((f) => f.severity === "high").length;
  return (
    <div className="panel-shadow rounded-2xl border bg-surface">
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Radar className="size-4 text-brand" />
          <h2 className="text-sm font-semibold">On your radar</h2>
          {highCount > 0 && (
            <span className="rounded-full bg-danger/10 px-1.5 text-xs font-medium text-danger">
              {highCount} need{highCount === 1 ? "s" : ""} you
            </span>
          )}
        </div>
        <span className="text-xs text-muted">Aging AR · quiet VIPs · revisions</span>
      </div>

      {flags.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted">
          Nothing on the radar — receivables, VIPs, and revisions all look healthy.
        </div>
      ) : (
        <div className="grid gap-px bg-border sm:grid-cols-2">
          {flags.map((f) => {
            const Icon = KIND_ICON[f.kind];
            const sev = SEV[f.severity];
            return (
              <Link
                key={f.id}
                href={f.href}
                className="group flex items-center gap-3 bg-surface px-5 py-3 hover:bg-surface-2"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${sev.dot}1a`, color: ink(sev.dot) }}>
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{f.title}</div>
                  <div className="truncate text-xs text-muted">{f.detail}</div>
                </div>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${sev.chip}`}>{sev.label}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-2 group-hover:text-foreground" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
