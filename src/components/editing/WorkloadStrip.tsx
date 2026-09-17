import { AlertTriangle, Clapperboard, Clock, Inbox, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EditorWorkload } from "@/lib/editorQueue";

// ---------------------------------------------------------------------------
// WHO IS CARRYING WHAT — the strip above the Editing Room queue.
//
// The queue answers "what is in the shop". It cannot answer "is Kim buried and
// John idle", because that means reading 40 rows and holding a tally in your
// head. One line per person, busiest first, and an unassigned pile at the top
// because a job nobody owns is the one that gets missed.
//
// The numbers are the SAME ones the editor's own header shows them (see
// editorWorkloads): what they owe, what is late, what is sitting with the
// office, what has no footage yet. A count here that disagreed with the count
// Kim sees would be worse than no count at all.
//
// Video count, not job count, is the size of the pile: one job can be a single
// reel or sixteen. Both are shown — "6 jobs · 11 videos" — because the job
// count is what you reassign and the video count is what it costs.
//
// Owner and admin only. An editor sees their own queue, never a board of who
// is behind.
// ---------------------------------------------------------------------------

function Num({ n, label, tone, icon: Icon }: { n: number; label: string; tone?: "danger" | "warn" | "muted"; icon?: typeof Clock }) {
  if (!n) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
        tone === "danger" ? "bg-danger/15 text-danger" : tone === "warn" ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted",
      )}
      title={label}
    >
      {Icon ? <Icon className="size-3" /> : null}
      {n} {label}
    </span>
  );
}

export function WorkloadStrip({ rows }: { rows: EditorWorkload[] }) {
  const busy = rows.filter((r) => r.toEdit || r.inReview || r.waiting || r.upcoming);
  if (busy.length === 0) return null;
  const totalToEdit = busy.reduce((n, r) => n + r.toEdit, 0);
  const totalVideos = busy.reduce((n, r) => n + r.videos, 0);

  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2.5 sm:px-5">
        <UserRound className="size-4 shrink-0 text-muted-2" />
        <h2 className="text-[13px] font-semibold">Who&rsquo;s carrying what</h2>
        <span className="text-xs text-muted">
          {totalToEdit} job{totalToEdit === 1 ? "" : "s"} to edit · {totalVideos} video{totalVideos === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {busy.map((r) => (
          <li key={r.key ?? "unassigned"} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 sm:px-5">
            <span className={cn("min-w-0 flex-1 truncate text-sm", r.key === null ? "font-semibold text-warning" : "font-medium")}>
              {r.key === null ? "Nobody assigned" : r.name}
            </span>
            {/* The pile, stated the way you would say it out loud. */}
            <span className="text-sm tabular-nums">
              {r.toEdit ? (
                <>
                  <strong>{r.toEdit}</strong> to edit
                  <span className="text-muted"> · {r.videos} video{r.videos === 1 ? "" : "s"}</span>
                </>
              ) : (
                <span className="text-success">nothing to edit</span>
              )}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <Num n={r.overdue} label="overdue" tone="danger" icon={AlertTriangle} />
              <Num n={r.dueToday} label="due today" tone="warn" icon={Clock} />
              <Num n={r.inReview} label="in review" tone="muted" icon={Clapperboard} />
              <Num n={r.waiting} label="awaiting footage" tone="muted" icon={Inbox} />
              <Num n={r.upcoming} label="upcoming" tone="muted" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
