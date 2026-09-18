import Link from "next/link";
import { TriangleAlert, ArrowRight } from "lucide-react";
import { EXCEPTION_LABEL, type OpsException } from "@/lib/opsExceptions";

// ---------------------------------------------------------------------------
// Five things that go wrong quietly, each with a name on it and one sentence
// saying what to do (R08). Grouped by kind so a reader can skip a whole class
// at a glance, and NEVER rendered at all when there is nothing — an empty
// exceptions card trains people to ignore a full one.
// ---------------------------------------------------------------------------

export function ExceptionsCard({ rows }: { rows: OpsException[] }) {
  if (rows.length === 0) return null;
  const high = rows.filter((r) => r.severity === "high").length;
  const kinds = [...new Set(rows.map((r) => r.kind))];
  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-warning/30 bg-surface">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/25 bg-warning-soft/40 px-5 py-2.5">
        <TriangleAlert className="size-4 shrink-0 text-warning" />
        <h2 className="text-[15px] font-semibold text-foreground">Exceptions</h2>
        <span className="text-xs text-muted">
          {rows.length} thing{rows.length === 1 ? "" : "s"} with a name on {rows.length === 1 ? "it" : "them"}
          {high > 0 && ` · ${high} worth doing today`}
        </span>
      </div>
      <div className="divide-y divide-border">
        {kinds.map((kind) => {
          const group = rows.filter((r) => r.kind === kind);
          return (
            <div key={kind}>
              <p className="bg-surface-2/60 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                {EXCEPTION_LABEL[kind]}
              </p>
              <ul className="divide-y divide-border">
                {group.map((r) => (
                  <li key={r.id}>
                    <Link href={r.href} className="flex items-start gap-3 px-5 py-3 hover:bg-surface-2/60">
                      <span
                        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${r.severity === "high" ? "bg-danger" : "bg-warning"}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{r.title}</span>
                        <span className="mt-0.5 block text-xs text-muted">{r.why}</span>
                        <span className="mt-1 block text-[11px] text-muted-2">
                          <span className="font-medium text-muted">{r.owner}</span>
                          {" — "}
                          {r.nextAction}
                        </span>
                      </span>
                      <ArrowRight className="mt-1 size-4 shrink-0 text-muted-2" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="border-t border-border px-5 py-2 text-[11px] text-muted-2">
        Reporting only — nothing on this card changes a status, sends a file or contacts a client.
      </p>
    </section>
  );
}
