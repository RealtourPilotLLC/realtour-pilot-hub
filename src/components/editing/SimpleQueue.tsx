"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink, FileText, FolderOpen, FolderUp, Loader2, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { setQueueStatus } from "@/app/editing/actions";

// THE SLACK TRACKER, replicated — Jordan: "I want the editor queue to look
// just like our Slack. It's been working, so I don't want to fix what isn't
// broken." Same columns as the Slack List (task name, video type, due date,
// status pill, editor, notes, deliverables, priority, RAW/Final/script links,
// comments), same views (Not Done | Upcoming | Done), same status ladder.
//
// What the hub fixes UNDER the familiar surface — the things that WERE broken
// in Slack: jobs add themselves (Aryeo booking → row appears), Waiting →
// Ready for editing flips on raw-upload evidence and Completed on delivery
// evidence (Kyle forgetting the tracker can't hide work any more),
// photographer notes + customer notes + script fill their columns from the
// job itself, and revisions live on the job's own chat instead of channel
// dumps and screenshots.

export type QueueRow = {
  id: string;
  street: string;
  client: string;
  tier: "standard" | "premium" | "branding";
  typeDetail: string; // the actual video deliverable labels, like Slack's "video type details"
  status: string;
  editor: string | null;
  auto: boolean;
  dueISO: string | null;
  late: boolean;
  priority: string; // LOW | NORMAL | HIGH | URGENT
  customerNotes: string | null; // client style prefs (fonts/colors/style)
  photographerNotes: string | null; // editor brief from the shoot
  videos: number; // deliverable count
  hasScript: boolean;
  comments: number;
  rawUrl: string | null;
  finalUrl: string | null;
  shootISO: string | null;
  photographer: string | null;
  openRevisions: number;
};

const TIER = {
  standard: { label: "Standard", color: "#38bdf8" },
  premium: { label: "Premium", color: "#a78bfa" },
  branding: { label: "Personal Branding", color: "#f59e0b" },
} as const;

// The Slack status ladder, colors matched to how a Slack List reads.
const STATUSES: Record<string, { color: string; selectable: boolean }> = {
  Waiting: { color: "#94a3b8", selectable: false }, // photographer hasn't uploaded — evidence flips this
  "Ready for editing": { color: "#38bdf8", selectable: false }, // raws detected — evidence flips this
  "In editing": { color: "#a78bfa", selectable: true },
  "Ready for review": { color: "#f59e0b", selectable: true },
  Revisions: { color: "#f87171", selectable: true },
  Completed: { color: "#34d399", selectable: true },
};

const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "—";

function StatusPill({ row }: { row: QueueRow }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(row.status);
  const [pending, start] = useTransition();
  const meta = STATUSES[status] ?? { color: "#94a3b8", selectable: false };

  const pick = (next: string) => {
    setOpen(false);
    if (next === status) return;
    const prev = status;
    setStatus(next);
    start(async () => {
      const r = await setQueueStatus(row.id, next);
      if (!r.ok) setStatus(prev); // server refused — snap back, no silent lie
    });
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold"
        style={{ backgroundColor: `${meta.color}26`, color: meta.color }}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : null}
        {status}
        <ChevronDown className="size-3 opacity-70" />
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-20 w-44 rounded-xl border border-border bg-surface p-1 shadow-xl">
          {Object.entries(STATUSES).map(([name, m]) => (
            <button
              key={name}
              disabled={!m.selectable}
              onClick={() => pick(name)}
              title={m.selectable ? undefined : "Set automatically from upload/delivery evidence"}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium",
                m.selectable ? "hover:bg-surface-2" : "cursor-not-allowed opacity-40",
              )}
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: m.color }} />
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NoteCell({ text, title }: { text: string | null; title: string }) {
  if (!text) return <span className="text-muted-2">—</span>;
  return (
    <span title={`${title}:\n${text}`} className="block max-w-44 cursor-help truncate text-xs text-foreground/80">
      {text}
    </span>
  );
}

export function SimpleQueue({ notDone, upcoming, done }: { notDone: QueueRow[]; upcoming: QueueRow[]; done: QueueRow[] }) {
  const [view, setView] = useState<"notdone" | "upcoming" | "done">("notdone");
  const rows = view === "notdone" ? notDone : view === "upcoming" ? upcoming : done;
  const VIEWS = [
    { key: "notdone" as const, label: "Not Done", n: notDone.length },
    { key: "upcoming" as const, label: "Upcoming", n: upcoming.length },
    { key: "done" as const, label: "Done", n: done.length },
  ];

  return (
    <div>
      {/* Slack's saved views, as pills. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {VIEWS.map((v) => (
          <button key={v.key} onClick={() => setView(v.key)}
            className={cn("rounded-lg px-3 py-1.5 text-sm font-medium",
              view === v.key ? "bg-brand text-white" : "border border-border text-muted hover:bg-surface-2")}>
            {v.label}
            {v.n > 0 && <span className={cn("ml-1.5 rounded-full px-1.5 text-xs font-semibold", view === v.key ? "bg-white/20" : "bg-surface-2")}>{v.n}</span>}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
          {view === "upcoming" ? "No upcoming video shoots on the schedule." : view === "done" ? "Nothing completed in the last 60 days." : "Nothing open — new jobs add themselves when a video shoot is booked."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                <th className="px-3 py-2">Task</th>
                <th className="px-3 py-2">Video type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Editor</th>
                <th className="px-3 py-2">Customer notes</th>
                <th className="px-3 py-2">Shoot notes</th>
                <th className="px-3 py-2 text-center">Videos</th>
                <th className="px-3 py-2">Links</th>
                <th className="px-3 py-2 text-center">
                  <MessageSquare className="inline size-3.5" />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const t = TIER[r.tier];
                return (
                  <tr key={r.id} className="align-top hover:bg-surface-2/50">
                    <td className="px-3 py-2.5">
                      <Link href={`/edit/${r.id}`} className="font-semibold hover:underline">{r.street}</Link>
                      <span className="block text-xs text-muted">{r.client}</span>
                      {r.priority !== "NORMAL" && r.priority !== "LOW" && (
                        <span className="mt-0.5 inline-block rounded bg-danger-soft px-1.5 text-[10px] font-semibold text-danger">{r.priority}</span>
                      )}
                      {r.openRevisions > 0 && (
                        <span className="mt-0.5 ml-1 inline-block rounded bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">
                          {r.openRevisions} revision ask{r.openRevisions === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold" style={{ backgroundColor: `${t.color}26`, color: t.color }}>
                        {t.label}
                      </span>
                      {r.typeDetail && <span title={r.typeDetail} className="mt-0.5 block max-w-40 truncate text-[11px] text-muted">{r.typeDetail}</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {view === "upcoming" ? (
                        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold" style={{ backgroundColor: "#94a3b826", color: "#94a3b8" }}>
                          Waiting
                        </span>
                      ) : (
                        <StatusPill row={r} />
                      )}
                    </td>
                    <td className={cn("whitespace-nowrap px-3 py-2.5 text-xs font-medium", r.late ? "text-danger" : "")}>
                      {view === "upcoming" ? `Shoots ${fmtDay(r.shootISO)}` : fmtDay(r.dueISO)}{r.late ? " · late" : ""}
                      {view === "upcoming" && r.photographer && <span className="block text-muted">📷 {r.photographer}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs">{r.editor ? `${r.editor}${r.auto ? " (auto)" : ""}` : "—"}</td>
                    <td className="px-3 py-2.5"><NoteCell text={r.customerNotes} title="Customer notes" /></td>
                    <td className="px-3 py-2.5"><NoteCell text={r.photographerNotes} title="Shoot notes" /></td>
                    <td className="px-3 py-2.5 text-center text-xs">{r.videos}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span className="inline-flex items-center gap-1">
                        {r.rawUrl && <a href={r.rawUrl} target="_blank" rel="noopener noreferrer" title="RAW footage" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-foreground"><FolderOpen className="size-4" /></a>}
                        {r.finalUrl && <a href={r.finalUrl} target="_blank" rel="noopener noreferrer" title="Final footage (upload here)" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-foreground"><FolderUp className="size-4" /></a>}
                        {r.hasScript && <Link href={`/edit/${r.id}`} title="Script on file — view on the edit page" className="rounded p-1 text-brand hover:bg-surface-2"><FileText className="size-4" /></Link>}
                        <Link href={`/edit/${r.id}`} title="Open the edit workspace" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-foreground"><ExternalLink className="size-4" /></Link>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <Link href={`/edit/${r.id}`} title="Project chat — revisions and questions live HERE, not in the Slack channel" className={cn("text-xs font-semibold", r.comments > 0 ? "text-brand" : "text-muted-2")}>
                        {r.comments}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
