import Link from "next/link";
import { Clock } from "lucide-react";
import { atRiskOutputs, promiseWords } from "@/lib/atRiskUpdates";
import { DraftUpdateDialog } from "@/components/tasks/DraftUpdateDialog";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// LATE PROMISES, on Messages (AU-24 / F5, Sep 26 2026; was "Promises at
// risk"). Every owed thing whose recorded promise has PASSED and is still not
// delivered, with the one action that gets ahead of the client's "where is
// it?": Draft update. Since Jordan's Oct 27 2026 Loom (40:34: "They should
// only be at risk if they're late, not if you think they're going to be
// late") nothing due later today or tomorrow is listed (William Hannum's
// photos, due the next day, were). A database read only; the model runs when
// the button is pressed. Nothing on this strip sends anything.
// Renders nothing when nothing is late (an empty warning trains people to
// ignore a full one).
// ---------------------------------------------------------------------------

export async function AtRiskUpdates({ excludeClientIds }: { excludeClientIds?: string[] } = {}) {
  const rows = await atRiskOutputs(new Date(), { excludeClientIds }).catch(() => null);
  if (!rows || rows.length === 0) return null;
  return (
    <section className="panel-shadow mb-4 overflow-hidden rounded-2xl border border-warning/30 bg-surface" id="at-risk" data-late-promises>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/25 bg-warning-soft/40 px-4 py-2.5">
        <Clock className="size-4 shrink-0 text-warning" />
        <h2 className="text-[15px] font-semibold">Late promises</h2>
        <span className="text-xs text-muted">{rows.length} past what we told the client. Tell them before they have to ask.</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{r.street} <span className="font-normal text-muted">· {r.clientName}</span></p>
              <p className={cn("text-xs", r.overdue ? "font-semibold text-danger" : "text-muted")}>
                {r.owed}: was due {promiseWords(r.promisedAt)}
              </p>
              {/* Oct 15 2026: a program video carries where it stands. */}
              {r.why && <p className="text-[11px] text-muted">{r.why}</p>}
              {r.taskId && (
                <Link href={`/tasks?tab=other&task=${r.taskId}`} className="text-[11px] text-brand underline">
                  An update is drafted on Kyle&rsquo;s list
                </Link>
              )}
            </div>
            <DraftUpdateDialog projectId={r.projectId} outputId={r.outputId} label={`${r.owed}, ${r.street}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}
