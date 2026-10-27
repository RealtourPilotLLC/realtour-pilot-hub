import Link from "next/link";
import { ChevronRight, CircleAlert, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import { projectPiecesOf, type DeliverExtra, type ProjectPiece, type ShootRow, type StageTone } from "@/lib/jobsBoard";

// ---------------------------------------------------------------------------
// THE PROJECTS LIST (/jobs; "Shoots" until Oct 27 2026). Jordan's Loom, Oct 27
// 2026: "we need to know what each job is waiting on and what has been sent
// ... you can't even read it. 34 Oakland, video 4, premium social media reel
// 2, waiting on second shoot, half shot, needs second appointment, like you
// have to mouse over it, I don't like that. This is kind of overwhelming."
//
// One card per job: the street (it opens the job), the client and when it is
// due, then ONE LINE PER PIECE: the photos, each video, the floor plan, the
// 3D tour and anything else ordered, each saying what it is waiting on or
// "Sent <date>". Words wrap; nothing is cut off or kept in a tooltip. More
// than a few videos read as one counted line with each under Details. What
// holds the job and the client's open requests follow as plain sentences,
// only when there are any. Monthly content sits under its own heading after
// the listing jobs, as on Jordan's approved plan.
// ---------------------------------------------------------------------------

const DOT: Record<StageTone, string> = {
  done: "bg-success",
  active: "bg-brand",
  waiting: "bg-warning",
  late: "bg-danger",
  none: "bg-muted-2",
};
const WORDS: Record<StageTone, string> = {
  done: "text-success",
  active: "text-foreground",
  waiting: "text-foreground",
  late: "font-medium text-danger",
  none: "text-muted",
};

function PieceLine({ p }: { p: ProjectPiece }) {
  return (
    <div className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-3 py-0.5 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]" data-piece={p.label} {...(p.key.startsWith("waiting-") ? { "data-waiting-on-shoot": "" } : {})}>
      <dt className="text-sm text-muted [overflow-wrap:anywhere]">{p.label}</dt>
      <dd className={cn("flex min-w-0 items-start gap-2 text-sm", WORDS[p.tone])}>
        <i aria-hidden className={cn("mt-[0.45rem] size-2 shrink-0 rounded-full", DOT[p.tone])} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{p.status}</span>
      </dd>
    </div>
  );
}

/** "4 open client requests, 1 needs an owner". */
function requestsLine(q: ShootRow["requests"]): string | null {
  if (!q.open) return null;
  const owner = q.needsOwner ? `, ${q.needsOwner} ${q.needsOwner === 1 ? "needs" : "need"} an owner` : "";
  return `Client requests: ${q.open} open${owner}`;
}

/** "Due Tue 5 PM", "2 days late", "Delivered Oct 24", "No date yet". */
function dueLine(r: ShootRow): string {
  if (r.delivered || r.late || !r.dueISO) return r.dueWords;
  return `Due ${r.dueWords}`;
}

function Row({ r, extra }: { r: ShootRow; extra?: DeliverExtra | null }) {
  const pieces = r.pieces ?? projectPiecesOf(r, { extra });
  const each = pieces.flatMap((p) => p.each ?? []);
  const asks = requestsLine(r.requests);
  return (
    <li className={cn("px-4 py-4 sm:px-5", r.delivered && "opacity-70")} data-shoot-row={r.projectId}>
      <Link
        href={r.href}
        className="-mx-2 flex items-start justify-between gap-3 rounded-lg px-2 py-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <span className="min-w-0">
          <span className="block font-semibold text-foreground [overflow-wrap:anywhere]">{r.street}</span>
          {r.client && <span className="block text-sm text-muted">{r.client}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={cn("text-sm tabular-nums", r.late ? "font-semibold text-danger" : "text-muted")}>{dueLine(r)}</span>
          <ChevronRight aria-hidden className="size-4 text-muted-2" />
        </span>
      </Link>
      {pieces.length > 0 && (
        <dl className="mt-2 space-y-0.5" data-pieces aria-label={`What ${r.street} is waiting on`}>
          {pieces.map((p) => <PieceLine key={p.key} p={p} />)}
        </dl>
      )}
      {each.length > 0 && (
        <details className="mt-1.5">
          <summary className="min-h-9 cursor-pointer py-1.5 text-sm font-medium text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Details: each video</summary>
          <dl className="mt-1 space-y-0.5 border-l-2 border-border pl-3">
            {each.map((p) => <PieceLine key={p.key} p={p} />)}
          </dl>
        </details>
      )}
      {/* Oct 22 2026: the order sells more videos than the job has set up. */}
      {r.videoSetup && <div className="mt-2 flex items-start gap-2 text-sm font-medium text-danger" data-video-setup><CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /><span>{r.videoSetup}. Open the job to set up the missing video.</span></div>}
      {r.holding && (
        <p className="mt-2 flex items-start gap-2 text-sm text-warning" data-holding>
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="[overflow-wrap:anywhere]">Holding it: {r.holding.replace(/ · /g, ", ")}</span>
        </p>
      )}
      {asks && (
        <p className="mt-2 flex items-start gap-2 text-sm text-foreground/80" data-requests>
          <MessageSquareText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
          <span>{asks}</span>
        </p>
      )}
    </li>
  );
}

export function ShootsList({ rows, empty, extras = null }: { rows: ShootRow[]; empty: string; extras?: Record<string, DeliverExtra> | null }) {
  if (!rows.length) {
    return <p className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-muted">{empty}</p>;
  }
  const listing = rows.filter((r) => !r.monthly);
  const monthly = rows.filter((r) => r.monthly);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface" data-shoots-list>
      {listing.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Projects">
          {listing.map((r) => <Row key={r.projectId} r={r} extra={extras?.[r.projectId]} />)}
        </ul>
      )}
      {monthly.length > 0 && (
        <>
          <p data-monthly-heading className={`bg-surface-2 px-4 py-2 text-sm font-semibold text-foreground sm:px-5 ${listing.length ? "border-t border-border" : ""}`}>
            Monthly content
          </p>
          <ul className="divide-y divide-border" aria-label="Monthly content">
            {monthly.map((r) => <Row key={r.projectId} r={r} extra={extras?.[r.projectId]} />)}
          </ul>
        </>
      )}
    </div>
  );
}
