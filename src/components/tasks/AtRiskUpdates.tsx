import Link from "next/link";
import { Clock } from "lucide-react";
import { atRiskOutputs, groupAtRiskRows, promiseWords } from "@/lib/atRiskUpdates";
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
// ONE ROW PER JOB (Jordan, Oct 28 2026: John Collins's four late October
// videos were four rows and four drafts; "since this was for the same shoot -
// it could all be in one late promise message update"). A job's late things
// are listed inside its row, and its Draft update writes one message for all.
// ---------------------------------------------------------------------------

export async function AtRiskUpdates({ excludeClientIds }: { excludeClientIds?: string[] } = {}) {
  const rows = await atRiskOutputs(new Date(), { excludeClientIds }).catch(() => null);
  if (!rows || rows.length === 0) return null;
  const jobs = groupAtRiskRows(rows);
  return (
    <section className="panel-shadow mb-4 overflow-hidden rounded-2xl border border-warning/30 bg-surface" id="at-risk" data-late-promises>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warning/25 bg-warning-soft/40 px-4 py-2.5">
        <Clock className="size-4 shrink-0 text-warning" />
        <h2 className="text-[15px] font-semibold">Late promises</h2>
        <span className="text-xs text-muted">
          {rows.length} past what we told the client{jobs.length < rows.length ? `, on ${jobs.length} job${jobs.length === 1 ? "" : "s"}` : ""}. Tell them before they have to ask.
        </span>
      </div>
      <ul className="divide-y divide-border">
        {jobs.map((g) => {
          // The milestone lines, said once when every video shares it.
          const whys = [...new Set(g.rows.map((r) => r.why).filter((w): w is string => !!w))];
          const sameDue = g.rows.every((r) => r.promisedAt.getTime() === g.promisedAt.getTime());
          return (
            <li key={g.key} className="flex flex-wrap items-center gap-3 px-4 py-3" data-late-job={g.projectId} data-late-count={g.rows.length}>
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-sm font-medium">{g.street} <span className="font-normal text-muted">· {g.clientName}</span></p>
                {g.rows.length === 1 ? (
                  <p className={cn("text-xs", g.overdue ? "font-semibold text-danger" : "text-muted")}>
                    {g.owed}: was due {promiseWords(g.promisedAt)}
                  </p>
                ) : (
                  <>
                    <p className={cn("text-xs", g.overdue ? "font-semibold text-danger" : "text-muted")}>
                      {g.rows.length} late{sameDue ? `, all due ${promiseWords(g.promisedAt)}` : ""}:
                    </p>
                    <ul className="mt-0.5 list-disc pl-4 text-xs text-foreground/90">
                      {g.rows.map((r) => (
                        <li key={r.key} className="break-words">{r.owed.replace(/^the video /, "")}{sameDue ? "" : `, due ${promiseWords(r.promisedAt)}`}</li>
                      ))}
                    </ul>
                  </>
                )}
                {/* Oct 15 2026: a program video carries where it stands. */}
                {whys.map((w) => <p key={w} className="text-[11px] text-muted">{w}</p>)}
                {g.taskId && (
                  <Link href={`/tasks?tab=other&task=${g.taskId}`} className="text-[11px] text-brand underline">
                    An update is drafted on Kyle&rsquo;s list
                  </Link>
                )}
              </div>
              <DraftUpdateDialog
                projectId={g.projectId}
                outputId={g.rows.length === 1 ? g.rows[0].outputId : null}
                outputIds={g.rows.length > 1 ? g.rows.map((r) => r.outputId).filter((x): x is string => !!x) : null}
                label={`${g.rows.length > 1 ? `${g.rows.length} late` : g.owed}, ${g.street}`}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
