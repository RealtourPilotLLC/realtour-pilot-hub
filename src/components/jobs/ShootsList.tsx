import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ShootRow } from "@/lib/jobsBoard";
import { RequestsChip, StageChip } from "./StageChip";

// ---------------------------------------------------------------------------
// THE SHOOTS LIST (Oct 19 2026, /jobs). One row per shoot: the street and the
// client, when it is due, where the photos and the video stand, and the
// client's open requests. Every row opens the job's own page. On a phone the
// columns stack into a card per shoot. Monthly content sits under its own
// heading after the listing shoots, as on Jordan's approved plan.
// ---------------------------------------------------------------------------

const COLS = "sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,1.2fr)_1rem]";

function Row({ r }: { r: ShootRow }) {
  return (
    <li>
      <Link
        href={r.href}
        data-shoot-row={r.projectId}
        className={`grid grid-cols-1 gap-x-4 gap-y-1.5 px-4 py-3 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand sm:items-center ${COLS} ${r.delivered ? "opacity-70" : ""}`}
      >
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-semibold text-foreground">{r.street}</span>
            <span className={`shrink-0 text-sm tabular-nums sm:hidden ${r.late ? "font-semibold text-danger" : "text-muted"}`}>{r.dueWords}</span>
          </div>
          {r.client && <div className="truncate text-xs text-muted">{r.client}</div>}
          {r.holding && <div className="truncate text-xs text-warning" title={r.holding}>{r.holding}</div>}
        </div>
        <div className={`hidden text-sm tabular-nums sm:block ${r.late ? "font-semibold text-danger" : "text-foreground/80"}`}>{r.dueWords}</div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-12 shrink-0 text-xs text-muted sm:hidden">Photos</span>
          <StageChip stage={r.photos} empty={r.monthly ? "n/a" : "Not ordered"} />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-12 shrink-0 text-xs text-muted sm:hidden">Video</span>
          <StageChip stage={r.video} />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-12 shrink-0 text-xs text-muted sm:hidden">Asks</span>
          <RequestsChip requests={r.requests} />
        </div>
        <ChevronRight aria-hidden className="hidden size-4 text-muted-2 sm:block" />
      </Link>
    </li>
  );
}

export function ShootsList({ rows, empty }: { rows: ShootRow[]; empty: string }) {
  if (!rows.length) {
    return <p className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-muted">{empty}</p>;
  }
  const listing = rows.filter((r) => !r.monthly);
  const monthly = rows.filter((r) => r.monthly);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface" data-shoots-list>
      <div className={`hidden gap-x-4 border-b border-border px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted sm:grid ${COLS}`} aria-hidden>
        <span>Shoot</span>
        <span>Due</span>
        <span>Photos</span>
        <span>Video</span>
        <span>Requests</span>
        <span />
      </div>
      {listing.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Shoots">
          {listing.map((r) => <Row key={r.projectId} r={r} />)}
        </ul>
      )}
      {monthly.length > 0 && (
        <>
          <p data-monthly-heading className={`bg-surface-2 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted ${listing.length ? "border-t border-border" : ""}`}>
            Monthly content
          </p>
          <ul className="divide-y divide-border" aria-label="Monthly content">
            {monthly.map((r) => <Row key={r.projectId} r={r} />)}
          </ul>
        </>
      )}
    </div>
  );
}
