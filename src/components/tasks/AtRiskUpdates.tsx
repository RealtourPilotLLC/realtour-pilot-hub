import Link from "next/link";
import { Clock } from "lucide-react";
import { atRiskOutputs, promiseWords } from "@/lib/atRiskUpdates";
import { DraftUpdateDialog } from "@/components/tasks/DraftUpdateDialog";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// PROMISES AT RISK, on the Comms tab (AU-24 / F5, Sep 26 2026) — the page
// where Kyle already answers clients. Every owed thing whose recorded promise
// is inside a day or just past, with the one action that gets ahead of the
// client's "where is it?": Draft update. A database read only; the model runs
// when the button is pressed. Nothing on this strip sends anything.
// Renders nothing when nothing is at risk (an empty warning trains people to
// ignore a full one).
// ---------------------------------------------------------------------------

export async function AtRiskUpdates({ excludeClientIds }: { excludeClientIds?: string[] } = {}) {
  const rows = await atRiskOutputs(new Date(), { excludeClientIds }).catch(() => null);
  if (!rows || rows.length === 0) return null;
  return (
    <section className="panel-shadow mb-4 overflow-hidden rounded-2xl border border-warning/30 bg-surface" id="at-risk">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/25 bg-warning-soft/40 px-4 py-2.5">
        <Clock className="size-4 shrink-0 text-warning" />
        <h2 className="text-[15px] font-semibold">Promises at risk</h2>
        <span className="text-xs text-muted">{rows.length} — tell the client before they have to ask</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{r.street} <span className="font-normal text-muted">· {r.clientName}</span></p>
              <p className={cn("text-xs", r.overdue ? "font-semibold text-danger" : "text-muted")}>
                {r.owed} — {r.overdue ? "was due" : "due"} {promiseWords(r.promisedAt)}
              </p>
              {r.taskId && (
                <Link href={`/tasks?tab=other&task=${r.taskId}`} className="text-[11px] text-brand underline">
                  An update is drafted on Kyle&rsquo;s list
                </Link>
              )}
            </div>
            <DraftUpdateDialog projectId={r.projectId} outputId={r.outputId} label={`${r.owed} — ${r.street}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}
