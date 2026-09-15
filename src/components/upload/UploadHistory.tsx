"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Search, ArrowRight, CheckCircle2, XCircle, Circle, Flag, Paperclip, Loader2, History, ChevronDown } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { stageMeta } from "@/lib/pipeline";
import type { ProjectStatus } from "@prisma/client";
import { etDate, etDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { searchUploadHistory } from "@/app/upload/historyActions";
import type { UploadHistoryPage, UploadHistoryPhotographer, UploadHistoryRow } from "@/lib/uploadSummary";

// ---------------------------------------------------------------------------
// "Past uploads" — the history under the day buckets on /upload (Jordan, Sep
// 15 2026: "I just want to be able to go in and be able to view them and also
// make adjustments to them"). The server page renders the first 50; this
// component owns search, the office's photographer chips and "Show 50 more",
// all through one server action that re-derives the viewer's scope itself.
// ---------------------------------------------------------------------------

export function UploadHistory({
  initial,
  photographers,
  officeView,
}: {
  initial: UploadHistoryPage;
  /** office only — who has history, with counts (empty for photographers) */
  photographers: UploadHistoryPhotographer[];
  officeView: boolean;
}) {
  const [q, setQ] = useState("");
  const [photographerId, setPhotographerId] = useState<string | null>(null);
  const [page, setPage] = useState<UploadHistoryPage>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  // Stale-response guard: a slow search must not overwrite a newer one.
  const seq = useRef(0);
  // What the rows on screen were fetched for — the debounce below only
  // re-queries when the search or the chip actually changed (StrictMode's
  // double-run of the mount effect must not refetch the server-rendered page).
  const applied = useRef<{ q: string; photographerId: string | null }>({ q: "", photographerId: null });

  function run(next: { q: string; photographerId: string | null; offset: number }, append: boolean) {
    const mine = ++seq.current;
    applied.current = { q: next.q, photographerId: next.photographerId };
    setErr(null);
    start(async () => {
      try {
        const res = await searchUploadHistory(next);
        if (mine !== seq.current) return;
        setPage((prev) => (append ? { ...res, rows: [...prev.rows, ...res.rows] } : res));
      } catch {
        if (mine === seq.current) setErr("Couldn't load past uploads — check your connection and try again.");
      }
    });
  }

  // Debounced search: typing re-runs from the top after a short pause.
  useEffect(() => {
    if (q === applied.current.q && photographerId === applied.current.photographerId) return;
    const t = setTimeout(() => run({ q, photographerId, offset: 0 }, false), 300);
    return () => clearTimeout(t);
  }, [q, photographerId]);

  const filtering = !!q.trim() || !!photographerId;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <History className="size-4 text-muted" />
        <h2 className="text-sm font-semibold">Past uploads</h2>
        <span className="rounded-full bg-surface-2 px-2 text-xs font-medium text-muted">{page.total}</span>
        <span className="text-xs text-muted-2">older than the last 7 days · newest shoot first</span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by street or client…"
            className="w-full rounded-lg border border-border bg-surface py-1.5 pl-8 pr-8 text-sm outline-none focus:border-brand"
          />
          {busy && <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-2" />}
        </label>
        {officeView && photographers.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <Chip active={photographerId === null} onClick={() => setPhotographerId(null)}>Everyone</Chip>
            {photographers.map((p) => (
              <Chip key={p.id} active={photographerId === p.id} onClick={() => setPhotographerId(photographerId === p.id ? null : p.id)}>
                <Avatar name={p.name} color={p.avatarColor} size={14} /> {p.name}
                <span className="text-muted-2">{p.count}</span>
              </Chip>
            ))}
          </div>
        )}
      </div>

      {err && <p className="mb-2 text-sm text-danger">{err}</p>}

      {page.rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-muted">
          {filtering ? "Nothing matches that search." : "No past uploads yet — submitted jobs land here once they're older than a week."}
        </p>
      ) : (
        <div className="space-y-2">
          {page.rows.map((r) => <HistoryRow key={r.id} r={r} showPhotographer={officeView} />)}
        </div>
      )}

      {page.hasMore && (
        <button
          onClick={() => run({ q, photographerId, offset: page.rows.length }, true)}
          disabled={busy}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-surface py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
          Show 50 more
          <span className="text-xs text-muted-2">· {page.rows.length} of {page.total}</span>
        </button>
      )}
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        active ? "border-brand bg-brand/10 text-brand" : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// One past upload: the job, when it was shot and submitted, what was uploaded
// (per-category marks + the raw counts when known) and a notes preview. The
// whole row opens the job page, where the full submission reads back and can
// be edited.
export function HistoryRow({ r, showPhotographer }: { r: UploadHistoryRow; showPhotographer: boolean }) {
  const stage = stageMeta(r.status as ProjectStatus);
  // Counts when known and non-zero: "0 raw photos" on a video-only job is
  // noise, and the marks above already say whether a category landed.
  const counts: string[] = [];
  if (r.counts.photos) counts.push(`${r.counts.photos} raw photo${r.counts.photos === 1 ? "" : "s"}`);
  if (r.counts.drone) counts.push(`${r.counts.drone} drone`);
  if (r.counts.video) counts.push(`${r.counts.video} video clip${r.counts.video === 1 ? "" : "s"}`);
  return (
    <Link href={`/upload/${r.id}`} className="block rounded-2xl border bg-surface p-4 transition-shadow hover:shadow-md">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-semibold">{r.street}</span>
            <Badge color={stage.color} soft={stage.soft}>{stage.short}</Badge>
            {r.submittedISO ? (
              <Badge color="#34d399" soft="rgba(52,211,153,0.14)">Submitted ✓ {etDateTime(r.submittedISO)}</Badge>
            ) : (
              <Badge color="#fbbf24" soft="rgba(251,191,36,0.14)">uploaded, page never submitted</Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
            <Avatar name={r.clientName} src={r.clientAvatarUrl} size={16} />
            <span>{r.clientName}</span>
            {r.shootISO && <span>· shot {etDate(r.shootISO)}</span>}
            {showPhotographer && r.photographer && <span>· {r.photographer.name}</span>}
          </div>

          {/* What was uploaded */}
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            {r.marks.map((m, i) => (
              <span
                key={i}
                className={cn(
                  "inline-flex items-center gap-1",
                  m.state === "uploaded" ? "text-success" : m.state === "not_completed" ? "text-warning" : "text-muted-2",
                )}
              >
                {m.state === "uploaded" ? <CheckCircle2 className="size-3.5" /> : m.state === "not_completed" ? <XCircle className="size-3.5" /> : <Circle className="size-3.5" />}
                {m.label}
                {m.state === "not_completed" && m.reason && <span className="text-foreground/70">— couldn&rsquo;t complete: {m.reason}</span>}
              </span>
            ))}
            {counts.length > 0 && <span className="text-muted">· {counts.join(" · ")}</span>}
            {r.files > 0 && (
              <span className="inline-flex items-center gap-1 text-muted"><Paperclip className="size-3" /> {r.files} file{r.files === 1 ? "" : "s"}</span>
            )}
            {r.flags > 0 && (
              <span className="inline-flex items-center gap-1 text-danger"><Flag className="size-3" /> {r.flags} flag{r.flags === 1 ? "" : "s"}</span>
            )}
          </div>

          {/* Notes preview */}
          {(r.notes.lead || r.notes.shotOrder || r.notes.remove) && (
            <p className="mt-1.5 text-[13px] leading-snug text-foreground/80">
              {r.notes.lead && (
                <>
                  <span className="font-medium text-foreground/90">{r.notes.lead.title}:</span> {r.notes.lead.text}
                </>
              )}
              {r.notes.shotOrder && (
                <span className="text-muted">{r.notes.lead ? " · " : ""}shot order: {r.notes.shotOrder}</span>
              )}
              {r.notes.remove && (
                <span className="text-muted">{r.notes.lead || r.notes.shotOrder ? " · " : ""}remove: {r.notes.remove}</span>
              )}
            </p>
          )}
        </div>
        {showPhotographer && r.photographer && <Avatar name={r.photographer.name} color={r.photographer.avatarColor} size={28} />}
        <span className="flex shrink-0 items-center gap-1 self-center text-sm font-medium text-brand">
          View <ArrowRight className="size-4" />
        </span>
      </div>
    </Link>
  );
}
