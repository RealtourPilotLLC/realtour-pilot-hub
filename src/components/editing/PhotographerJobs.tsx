"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronDown, Loader2, PenLine, PlayCircle, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";
import { saveShootBriefFields } from "@/app/editing/actions";
import type { PhotographerJob } from "@/lib/photographerEditing";

// ---------------------------------------------------------------------------
// The photographer's board in the Editing Room — READ-ONLY except for the
// brief they wrote themselves (Jordan, Sep 18: "be able to make changes to
// their notes or instructions, but not full control like I do or Kyle does").
//
// This is a separate component from SimpleQueue on purpose. SimpleQueue's row
// IS the office's controls — the status pill, the editor select, the override
// dialog — and its one existing narrowing (`hideEditor`, the editor's view)
// still hands out a selectable status pill, because an editor is supposed to
// set "In editing". A photographer is supposed to set nothing. Passing a third
// flag through that row would have left every one of those controls one
// missed condition away from rendering for somebody the server refuses, which
// is the bug an earlier audit found on the Review Room's verdict bar.
//
// So the rule here is structural rather than conditional: the only <button>
// that writes anything on this screen is Save on the brief, and the only
// action imported is the one guarded by requireShootAccess.
//
// The status word comes from the same ladder the office reads (see
// photographerEditing.ts) — it is shown, never offered.
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<string, string> = {
  Waiting: "#94a3b8",
  "Ready for editing": "#38bdf8",
  "In editing": "#f59e0b",
  "Ready for review": "#a78bfa",
  Revisions: "#f87171",
  Approved: "#34d399",
  Completed: "#22c55e",
};

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  // ET everywhere (the hub's date rule) — a due date that shifts by timezone
  // is a due date two people argue about.
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
}

function JobCard({ job }: { job: PhotographerJob }) {
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState(job.shootBrief ?? "");
  const [instructions, setInstructions] = useState(job.videoInstructions ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const dirty = (brief.trim() || "") !== (job.shootBrief ?? "") || (instructions.trim() || "") !== (job.videoInstructions ?? "");

  function save() {
    start(async () => {
      setErr(null);
      setMsg(null);
      const r = await saveShootBriefFields(job.id, { shootBrief: brief, videoInstructions: instructions });
      if (!r.ok) setErr(r.message);
      else {
        setMsg(r.message);
        router.refresh();
      }
    });
  }

  return (
    <li className="rounded-xl border bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{job.street}</span>
            <span
              className="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
              style={{ backgroundColor: `${STATUS_COLOR[job.status] ?? "#94a3b8"}1a`, color: STATUS_COLOR[job.status] ?? "#94a3b8" }}
            >
              {job.status}
            </span>
            {job.late && <span className="rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] font-medium text-danger">Overdue</span>}
            {job.openRevisions > 0 && (
              <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                {job.openRevisions} revision{job.openRevisions === 1 ? "" : "s"} open
              </span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted">
            {job.client && <Avatar name={job.client} src={job.clientAvatarUrl} size={18} />}
            <span className="truncate">{job.client}</span>
            {job.typeDetail && (
              <>
                <span className="text-muted-2">·</span>
                <span className="truncate">{job.typeDetail}</span>
              </>
            )}
            {job.editor && (
              <>
                <span className="text-muted-2">·</span>
                {/* Named, not selectable: who has it is worth knowing when you
                    are about to answer their question. Reassigning is Kyle's. */}
                <span className="truncate">with {job.editor}</span>
              </>
            )}
            <span className="text-muted-2">·</span>
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="size-3" />
              {job.rail === "upcoming" ? `shoot ${fmtDay(job.shootISO)}` : `due ${fmtDay(job.dueISO)}`}
            </span>
          </div>
        </div>
        {job.cutsInReview > 0 && (
          <Link
            href={`/review/${job.id}`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-brand/40 bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand/10"
          >
            <PlayCircle className="size-3.5" /> Watch {job.cutsInReview === 1 ? "the cut" : `${job.cutsInReview} cuts`}
          </Link>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <PenLine className="size-3.5" /> Your notes
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border p-3.5">
          <p className="text-xs text-muted">
            What you told the editor about this shoot. Fix or add to it any time — they read it on the job, so an
            answer here is faster than a message.
          </p>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-2" htmlFor={`vi-${job.id}`}>
              Video — instructions from the shoot
            </label>
            <textarea
              id={`vi-${job.id}`}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={4}
              placeholder="Flow, vision, the order the clips go in…"
              className="mt-1 w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-2" htmlFor={`sb-${job.id}`}>
              Anything else for the editor
            </label>
            <textarea
              id={`sb-${job.id}`}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={3}
              placeholder="Access notes, what to avoid, what the agent asked for on site…"
              className="mt-1 w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={save}
              disabled={pending || !dirty}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
            </button>
            {msg && <span className="text-xs text-success">{msg}</span>}
            {err && <span className="text-xs text-danger">{err}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

type Rail = PhotographerJob["rail"];

const RAILS: { id: Rail; label: string }[] = [
  { id: "open", label: "In the edit" },
  { id: "upcoming", label: "Upcoming shoots" },
  { id: "done", label: "Delivered" },
];

export function PhotographerJobs({ jobs }: { jobs: PhotographerJob[] }) {
  const [tab, setTab] = useState<Rail>("open");
  const rows = jobs.filter((j) => j.rail === tab);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {RAILS.map((r) => (
          <button
            key={r.id}
            onClick={() => setTab(r.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium",
              tab === r.id ? "bg-brand text-white" : "bg-surface-2 text-muted hover:text-foreground",
            )}
          >
            {r.label}{" "}
            <span className="tabular-nums opacity-70">{jobs.filter((j) => j.rail === r.id).length}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
          Nothing on this list.
        </p>
      ) : (
        <ul className="space-y-2.5">{rows.map((j) => <JobCard key={j.id} job={j} />)}</ul>
      )}
    </div>
  );
}
