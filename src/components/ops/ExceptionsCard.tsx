import Link from "next/link";
import { TriangleAlert, ArrowRight } from "lucide-react";
import { EXCEPTION_LABEL, type ExceptionKind, type ExceptionTotal, type OpsException } from "@/lib/opsExceptions";

// ---------------------------------------------------------------------------
// Five things that go wrong quietly, each with a name on it and one sentence
// saying what to do (R08). Grouped by kind so a reader can skip a whole class
// at a glance, and NEVER rendered at all when there is nothing — an empty
// exceptions card trains people to ignore a full one.
//
// WHAT THE HEADER COUNTS (Sep 20). It used to count the rows it had been
// handed, which are capped at four per kind — so the day nine things qualified
// the card announced six, and the three it had dropped were invisible AND
// uncounted. The tally now comes from the board's per-kind totals, and any
// group the cap bit says "4 of 7" over the rows it could fit.
//
// BOTH numbers in that sentence come from the totals, including "N worth doing
// today". Counting the high rows on the visible page while announcing an honest
// grand total would have told a reader, in one breath, that nine things are
// wrong and four of them matter — on a day when seven of the nine were urgent
// and three had been dropped by the cap. One honest number beside one page
// count is the harder lie to spot, so neither is a page count now.
// ---------------------------------------------------------------------------

export function ExceptionsCard({
  rows,
  totals,
}: {
  rows: OpsException[];
  totals: Record<ExceptionKind, ExceptionTotal>;
}) {
  if (rows.length === 0) return null;
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const sum = (pick: (t: ExceptionTotal) => number) => Object.values(totals).reduce((n, t) => n + pick(t), 0);
  // The real pile, not the page of it below. Never smaller than what is shown:
  // a total that somehow undercounts its own rows would be a quieter lie than
  // the one this replaced.
  const total = Math.max(rows.length, sum((t) => t.all));
  const high = Math.max(rows.filter((r) => r.severity === "high").length, sum((t) => t.high));
  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-warning/30 bg-surface">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/25 bg-warning-soft/40 px-5 py-2.5">
        <TriangleAlert className="size-4 shrink-0 text-warning" />
        <h2 className="text-[15px] font-semibold text-foreground">Exceptions</h2>
        <span className="text-xs text-muted">
          {total} thing{total === 1 ? "" : "s"} with a name on {total === 1 ? "it" : "them"}
          {total > rows.length && ` · showing ${rows.length}`}
          {high > 0 && ` · ${high} worth doing today`}
        </span>
      </div>
      <div className="divide-y divide-border">
        {kinds.map((kind) => {
          const group = rows.filter((r) => r.kind === kind);
          const kindTotal = Math.max(group.length, totals[kind]?.all ?? group.length);
          return (
            <div key={kind}>
              <p className="bg-surface-2/60 px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                {EXCEPTION_LABEL[kind]}
                {kindTotal > group.length && (
                  <span className="ml-2 font-normal normal-case tracking-normal text-muted">
                    showing {group.length} of {kindTotal}
                  </span>
                )}
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
