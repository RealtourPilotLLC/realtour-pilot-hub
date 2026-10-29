import Link from "next/link";
import { ChevronRight, CircleAlert, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import { projectPiecesOf, type DeliverExtra, type ProjectPiece, type ShootRow, type StageTone } from "@/lib/jobsBoard";
import type { RequestCardView, SavedRequestView } from "@/lib/requestPlacement";
import { RequestQuickActions, SavedRequestList } from "@/components/requests/RequestPlacement";
import { RequestOwnerPicker } from "./RequestOwnerPicker";

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
//
// THE REQUESTS TAB SHOWS THE REQUESTS (Kyle, Oct 28 2026: "It would be nice
// to have the client's requests included in this page rather than having to
// open the project page to view it"). With `requests` (the page passes them on
// that tab), each job lists its open requests under its count: the request in
// plain words, who has it, who asked, how and when, the client's words
// folded, and the job page's own presses (Checked, Not for this project, the
// owner picker when it needs one). A request kept for the client's next
// project is offered on a job booked after it (`offers`).
// ---------------------------------------------------------------------------

/** The Requests tab's extras, by project id. */
export type ShootsListRequests = { cards: Record<string, RequestCardView[]>; offers: Record<string, SavedRequestView[]>; canAct: boolean };

function RequestCards({ cards, canAct }: { cards: RequestCardView[]; canAct: boolean }) {
  return (
    <ul className="mt-2 space-y-2" data-request-cards>
      {cards.map((c) => (
        <li key={c.id} data-request-card={c.id} className="min-w-0 space-y-1.5 rounded-lg bg-surface-2 px-3 py-2">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <p className="min-w-0 flex-1 basis-48 text-sm font-medium text-foreground [overflow-wrap:anywhere]">{c.summary}</p>
            <span data-request-for className={cn("inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium [overflow-wrap:anywhere]", c.needsOwner ? "bg-warning/15 text-warning ring-1 ring-warning/30" : "bg-surface text-foreground ring-1 ring-border")}>
              {c.forLine}
            </span>
          </div>
          <p className="text-xs text-muted [overflow-wrap:anywhere]">{c.fromLine}</p>
          {c.text.trim() && c.text.trim() !== c.summary.trim() && (
            <details className="text-xs">
              <summary className="cursor-pointer py-1 font-medium text-brand">The client&rsquo;s words</summary>
              <p className="mt-1 whitespace-pre-wrap rounded-lg bg-surface px-2 py-1.5 text-[13px] text-foreground/85 [overflow-wrap:anywhere]">{c.text}</p>
            </details>
          )}
          {canAct && c.needsOwner && <RequestOwnerPicker askId={c.id} />}
          {canAct && <RequestQuickActions askId={c.id} />}
        </li>
      ))}
    </ul>
  );
}

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

function Row({ r, extra, requests }: { r: ShootRow; extra?: DeliverExtra | null; requests?: ShootsListRequests | null }) {
  const pieces = r.pieces ?? projectPiecesOf(r, { extra });
  const each = pieces.flatMap((p) => p.each ?? []);
  const asks = requestsLine(r.requests);
  return (
    <li className={cn("px-4 py-4 sm:px-5", r.delivered && "opacity-70")} data-shoot-row={r.projectId}>
      {/* Phone layout (Jordan, Oct 28 2026): the due date wraps under a long street instead of squeezing it. */}
      <Link
        href={r.href}
        className="-mx-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-lg px-2 py-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <span className="min-w-0">
          <span className="block font-semibold text-foreground [overflow-wrap:anywhere]">{r.street}</span>
          {r.client && <span className="block text-sm text-muted">{r.client}</span>}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
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
      {requests && (requests.cards[r.projectId]?.length ?? 0) > 0 && <RequestCards cards={requests.cards[r.projectId]} canAct={requests.canAct} />}
      {requests && (requests.offers[r.projectId]?.length ?? 0) > 0 && (
        <div className="mt-2 space-y-1.5" data-saved-offers>
          <p className="flex items-start gap-2 text-sm text-foreground/80">
            <MessageSquareText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            <span>Saved for {r.client ?? "this client"}&rsquo;s next project: is it for this one?</span>
          </p>
          <SavedRequestList items={requests.offers[r.projectId]} projectId={r.projectId} street={r.street.split(",")[0].trim()} canAct={requests.canAct} />
        </div>
      )}
    </li>
  );
}

export function ShootsList({ rows, empty, extras = null, requests = null }: { rows: ShootRow[]; empty: string; extras?: Record<string, DeliverExtra> | null; requests?: ShootsListRequests | null }) {
  if (!rows.length) {
    return <p className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-muted">{empty}</p>;
  }
  const listing = rows.filter((r) => !r.monthly);
  const monthly = rows.filter((r) => r.monthly);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface" data-shoots-list>
      {listing.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Projects">
          {listing.map((r) => <Row key={r.projectId} r={r} extra={extras?.[r.projectId]} requests={requests} />)}
        </ul>
      )}
      {monthly.length > 0 && (
        <>
          <p data-monthly-heading className={`bg-surface-2 px-4 py-2 text-sm font-semibold text-foreground sm:px-5 ${listing.length ? "border-t border-border" : ""}`}>
            Monthly content
          </p>
          <ul className="divide-y divide-border" aria-label="Monthly content">
            {monthly.map((r) => <Row key={r.projectId} r={r} extra={extras?.[r.projectId]} requests={requests} />)}
          </ul>
        </>
      )}
    </div>
  );
}
