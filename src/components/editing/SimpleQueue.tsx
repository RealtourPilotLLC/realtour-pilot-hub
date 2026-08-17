"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderUp,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { setEditVideoEditor, setQueueStatus } from "@/app/editing/actions";

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
//
// On top of the Slack surface (Jordan, Aug 17): click a row and the whole
// project opens right there (full notes, every link labeled, shoot facts);
// the Editor cell is a live select so reassigning doesn't need the edit page.

export type QueueRow = {
  id: string;
  street: string;
  client: string;
  tier: "standard" | "premium" | "branding";
  typeDetail: string; // the actual video deliverable labels, like Slack's "video type details"
  status: string;
  editor: string | null;
  editorKey: string | null; // key behind the name, drives the reassign select
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

// The queue's assignable video editors (matches VIDEO_EDITOR_KEYS server-side).
const VIDEO_EDITORS = [
  { key: "john", name: "John Mark" },
  { key: "kim", name: "Kim" },
] as const;

const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "—";

// Height of the 6-option menu — used to flip it above the pill near the
// viewport bottom, since it renders position:fixed (see below).
const MENU_H = 212;

function StatusPill({ row }: { row: QueueRow }) {
  // The menu is position:fixed, NOT absolute: the table wrapper is an
  // overflow-x-auto scroll container, which clips absolutely-positioned
  // children — on the bottom row (and short queues are all bottom rows) the
  // menu was cut off below the table edge. Fixed positioning escapes the clip;
  // the invisible fixed backdrop gives outside-click dismissal for free.
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [status, setStatus] = useState(row.status);
  const [pending, start] = useTransition();
  const meta = STATUSES[status] ?? { color: "#94a3b8", selectable: false };

  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (menu) return setMenu(null);
    const r = e.currentTarget.getBoundingClientRect();
    const flipUp = window.innerHeight - r.bottom < MENU_H + 16;
    setMenu({ left: r.left, top: flipUp ? r.top - MENU_H - 4 : r.bottom + 4 });
  };

  const pick = (next: string) => {
    setMenu(null);
    if (next === status) return;
    const prev = status;
    setStatus(next);
    start(async () => {
      // .catch too: a rejected action (DB hiccup, deleted project) must snap
      // back like a refusal, not crash the whole queue view.
      const r = await setQueueStatus(row.id, next).catch(() => ({ ok: false }));
      if (!r.ok) setStatus(prev); // server refused — snap back, no silent lie
    });
  };

  return (
    <>
      <button
        onClick={toggle}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold"
        style={{ backgroundColor: `${meta.color}26`, color: meta.color }}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : null}
        {status}
        <ChevronDown className="size-3 opacity-70" />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
          <div className="fixed z-40 w-44 rounded-xl border border-border bg-surface p-1 shadow-xl" style={menu}>
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
        </>
      )}
    </>
  );
}

// The Editor cell IS the reassign control — pick a name and the job moves
// (open task repointed + bell, or pinned on the project for an upcoming shoot).
// Optimistic with snap-back, same contract as the status pill.
function EditorSelect({ row }: { row: QueueRow }) {
  const [key, setKey] = useState(row.editorKey ?? "");
  const [pending, start] = useTransition();
  const known = VIDEO_EDITORS.some((e) => e.key === key);

  const pick = (next: string) => {
    if (!next || next === key) return;
    const prev = key;
    setKey(next);
    start(async () => {
      const r = await setEditVideoEditor(row.id, next).catch(() => ({ ok: false }));
      if (!r.ok) setKey(prev); // server refused — snap back
    });
  };

  return (
    <span className="inline-flex items-center gap-1">
      {pending && <Loader2 className="size-3 animate-spin text-muted" />}
      <select
        aria-label="Assign editor"
        value={key}
        disabled={pending}
        onChange={(e) => pick(e.target.value)}
        className={cn(
          "cursor-pointer rounded-md border border-transparent bg-transparent py-0.5 pl-1 pr-5 text-xs font-medium",
          "hover:border-border hover:bg-surface-2 disabled:opacity-60",
          key ? "text-foreground" : "text-muted-2",
        )}
      >
        <option value="" disabled>
          Assign…
        </option>
        {/* A historical editor (Luma / Remar) still shows by name, but new work
            can only go to the current video editors. */}
        {!known && key && <option value={key} disabled>{row.editor ?? key}</option>}
        {VIDEO_EDITORS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.name}
          </option>
        ))}
      </select>
      {row.auto && key === (row.editorKey ?? "") && (
        <span className="text-[10px] text-muted-2" title="Assigned by the routing rules — pick a name to override">
          auto
        </span>
      )}
    </span>
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

// A labeled link chip — the fix for "the links section is confusing": words
// instead of bare icons, so RAW vs Final vs script is legible at a glance.
function LinkChip({
  href,
  icon: Icon,
  label,
  title,
  brand = false,
}: {
  href: string;
  icon: typeof FolderOpen;
  label: string;
  title: string;
  brand?: boolean;
}) {
  const external = href.startsWith("http");
  const classes = cn(
    "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
    brand
      ? "border-brand/30 bg-brand-soft text-brand hover:bg-brand/15"
      : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={classes}>
      <Icon className="size-3" />
      {label}
    </a>
  ) : (
    <Link href={href} title={title} className={classes}>
      <Icon className="size-3" />
      {label}
    </Link>
  );
}

// The expanded project panel — Jordan: "open the project details by clicking
// it but having it all right there." Full notes, every link labeled, shoot
// facts, and the door to the full edit workspace.
function DetailPanel({ row, upcoming }: { row: QueueRow; upcoming: boolean }) {
  const t = TIER[row.tier];
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{row.street}</span>
        <span className="text-sm text-muted">· {row.client}</span>
        <span className="inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: `${t.color}26`, color: t.color }}>
          {t.label}
        </span>
        {row.priority !== "NORMAL" && row.priority !== "LOW" && (
          <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-semibold text-danger">{row.priority}</span>
        )}
        {row.openRevisions > 0 && (
          <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning">
            {row.openRevisions} open revision ask{row.openRevisions === 1 ? "" : "s"}
          </span>
        )}
        <Link
          href={`/edit/${row.id}`}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
        >
          Open edit page
          <ExternalLink className="size-3.5" />
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Job</div>
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Shoot</dt>
              <dd className="text-right font-medium">
                {fmtDay(row.shootISO)}
                {row.photographer ? ` · ${row.photographer}` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">{upcoming ? "Shoots" : "Due"}</dt>
              <dd className={cn("text-right font-medium", row.late && "text-danger")}>
                {fmtDay(upcoming ? row.shootISO : row.dueISO)}
                {row.late ? " · late" : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Videos</dt>
              <dd className="text-right font-medium">{row.videos}</dd>
            </div>
            {row.typeDetail && (
              <div className="pt-1">
                <dt className="text-muted">Deliverables</dt>
                <dd className="mt-1 space-y-0.5">
                  {row.typeDetail.split(" · ").map((d, i) => (
                    <div key={i} className="text-foreground/85">{d}</div>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Customer notes</div>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">
            {row.customerNotes || <span className="text-muted-2">None on file — cut it to the Style Guide.</span>}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Shoot notes</div>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">
            {row.photographerNotes || <span className="text-muted-2">None from the photographer.</span>}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {row.rawUrl && <LinkChip href={row.rawUrl} icon={FolderOpen} label="RAW footage" title="Open the RAW footage folder in Dropbox" />}
        {row.finalUrl && <LinkChip href={row.finalUrl} icon={FolderUp} label="Final footage — upload here" title="The finished cut goes in this Dropbox folder" />}
        {row.hasScript && <LinkChip href={`/edit/${row.id}`} icon={FileText} label="View script" title="A script is on file — view it on the edit page" brand />}
        <LinkChip
          href={`/edit/${row.id}`}
          icon={MessageSquare}
          label={`Project chat${row.comments > 0 ? ` (${row.comments})` : ""}`}
          title="Revisions and questions live on the job's own chat"
          brand={row.comments > 0}
        />
      </div>
    </div>
  );
}

export function SimpleQueue({ notDone, upcoming, done }: { notDone: QueueRow[]; upcoming: QueueRow[]; done: QueueRow[] }) {
  const [view, setView] = useState<"notdone" | "upcoming" | "done">("notdone");
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = view === "notdone" ? notDone : view === "upcoming" ? upcoming : done;
  const VIEWS = [
    { key: "notdone" as const, label: "Not Done", n: notDone.length },
    { key: "upcoming" as const, label: "Upcoming", n: upcoming.length },
    { key: "done" as const, label: "Done", n: done.length },
  ];
  // Keeps click-to-expand from firing when the click was really for a control
  // inside the row (status pill, editor select, a link).
  const swallow = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div>
      {/* Slack's saved views, as pills. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {VIEWS.map((v) => (
          <button key={v.key} onClick={() => { setView(v.key); setOpenId(null); }}
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
                const open = openId === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => setOpenId(open ? null : r.id)}
                      title={open ? undefined : "Click for the full project"}
                      className={cn("cursor-pointer align-top", open ? "bg-surface-2/60" : "hover:bg-surface-2/50")}
                    >
                      <td className="min-w-44 px-3 py-2.5">
                        <span className="flex items-start gap-1">
                          <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-2 transition-transform", open && "rotate-90")} />
                          <span>
                            <span className="font-semibold">{r.street}</span>
                            <span className="block text-xs text-muted">{r.client}</span>
                            {r.priority !== "NORMAL" && r.priority !== "LOW" && (
                              <span className="mt-0.5 inline-block rounded bg-danger-soft px-1.5 text-[10px] font-semibold text-danger">{r.priority}</span>
                            )}
                            {r.openRevisions > 0 && (
                              <span className="mt-0.5 ml-1 inline-block rounded bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">
                                {r.openRevisions} revision ask{r.openRevisions === 1 ? "" : "s"}
                              </span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold" style={{ backgroundColor: `${t.color}26`, color: t.color }}>
                          {t.label}
                        </span>
                        {r.typeDetail && <span title={r.typeDetail} className="mt-0.5 block max-w-40 truncate text-[11px] text-muted">{r.typeDetail}</span>}
                      </td>
                      <td className="px-3 py-2.5" onClick={swallow}>
                        {view === "upcoming" ? (
                          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold" style={{ backgroundColor: "#94a3b826", color: "#94a3b8" }}>
                            Waiting
                          </span>
                        ) : (
                          // key = server truth: when a revalidation streams a
                          // status this component didn't set (evidence flip,
                          // another admin), remount so the pill can't go stale.
                          <StatusPill key={r.status} row={r} />
                        )}
                      </td>
                      <td className={cn("whitespace-nowrap px-3 py-2.5 text-xs font-medium", r.late ? "text-danger" : "")}>
                        {view === "upcoming" ? `Shoots ${fmtDay(r.shootISO)}` : fmtDay(r.dueISO)}{r.late ? " · late" : ""}
                        {view === "upcoming" && r.photographer && <span className="block text-muted">📷 {r.photographer}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5" onClick={swallow}>
                        {view === "done" ? (
                          // Delivered = credit, not live work — no reassign here
                          // (the server refuses too). A new cut on a finished
                          // job goes through "Add a job to the queue".
                          <span className="text-xs font-medium">{r.editor ?? "—"}</span>
                        ) : (
                          // key = server truth, same deal as the status pill.
                          <EditorSelect key={r.editorKey ?? "none"} row={r} />
                        )}
                      </td>
                      <td className="px-3 py-2.5"><NoteCell text={r.customerNotes} title="Customer notes" /></td>
                      <td className="px-3 py-2.5"><NoteCell text={r.photographerNotes} title="Shoot notes" /></td>
                      <td className="px-3 py-2.5 text-center text-xs">{r.videos}</td>
                      <td className="whitespace-nowrap px-3 py-2.5" onClick={swallow}>
                        <span className="inline-flex items-center gap-1">
                          {r.rawUrl && <LinkChip href={r.rawUrl} icon={FolderOpen} label="RAW" title="Open the RAW footage folder in Dropbox" />}
                          {r.finalUrl && <LinkChip href={r.finalUrl} icon={FolderUp} label="Final" title="Upload the finished cut to this Dropbox folder" />}
                          {r.hasScript && <LinkChip href={`/edit/${r.id}`} icon={FileText} label="Script" title="A script is on file — view it on the edit page" brand />}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-center" onClick={swallow}>
                        <Link href={`/edit/${r.id}`} title="Project chat — revisions and questions live HERE, not in the Slack channel" className={cn("text-xs font-semibold", r.comments > 0 ? "text-brand" : "text-muted-2")}>
                          {r.comments}
                        </Link>
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-surface-2/30">
                        <td colSpan={10} className="p-0">
                          <DetailPanel row={r} upcoming={view === "upcoming"} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
