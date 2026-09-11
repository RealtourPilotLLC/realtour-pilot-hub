"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  FolderUp,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";
import { CopyButton } from "@/components/ui/CopyButton";
import { setEditVideoEditor, setQueueStatus } from "@/app/editing/actions";

// THE SLACK TRACKER, replicated — Jordan: "I want the editor queue to look
// just like our Slack. It's been working, so I don't want to fix what isn't
// broken." Same columns as the Slack List (task name, video type, due date,
// status pill, editor, deliverables, priority, RAW/Final/script links,
// comments), same views (Not Done | Upcoming | Done), same status ladder.
//
// What the hub fixes UNDER the familiar surface — the things that WERE broken
// in Slack: jobs add themselves (Aryeo booking → row appears), Waiting →
// Ready for editing flips on raw-upload evidence and Completed on delivery
// evidence (Kyle forgetting the tracker can't hide work any more), and
// revisions live on the job's own chat instead of channel dumps and
// screenshots.
//
// The ladder (Jordan, Sep 10 + 11): Waiting and Ready for editing set
// themselves from the raw folder; nothing lands on In editing by itself — the
// EDITOR sets it when they start. The OFFICE (owner/admin) can walk a job
// BACK: In editing → Ready for editing (Sep 10), and Ready for editing / In
// editing → Waiting (Sep 11: "I should also be able to change projects back
// to waiting but its blocked off"). A Waiting the office set is a HOLD — the
// server writes a marker the hourly recompute honours, so the same raws that
// flipped the job can't flip it straight back; it releases when the
// photographer submits the upload page or the office moves the job on (Ready
// for editing lights up on a Waiting row for exactly that). Both are undo
// moves and nothing else: a Revisions row has a client ask open that the next
// recompute would honour anyway, and a cut already handed in can't be
// un-handed. Greyed out on the editor's queue — and on a HELD Waiting row
// the editor's pill greys every option: the job is the office's to move, not
// theirs to start (Sep 11 review). The server (setQueueStatus) is the guard
// that actually enforces every one of these.
//
// Rows are DOORS, not drawers (Jordan, Aug 27): clicking a row opens the edit
// page — the full brief, customer + shoot notes included, lives on /edit/<id>.
// The old expand-in-place panel and the two note columns are gone; the row
// keeps only what you triage by (status, due, editor, links). In-row controls
// (status pill, editor select, link chips) swallow the click and never
// navigate.

export type QueueRow = {
  id: string;
  // The ABSOLUTE link to this job, built server-side from the hub's public
  // origin — what the row's Copy button puts on the clipboard so Jordan can
  // paste it straight to an editor (Jordan, Sep 7).
  url: string;
  street: string;
  client: string;
  clientAvatarUrl: string | null; // the agent's Aryeo headshot, when they have one
  tier: "standard" | "premium" | "branding";
  typeDetail: string; // the actual video deliverable labels, like Slack's "video type details"
  status: string;
  held: boolean; // the office put this job back to Waiting and is holding it there (Sep 11) — the editor's pill greys out
  editor: string | null;
  editorKey: string | null; // key behind the name, drives the reassign select
  auto: boolean;
  dueISO: string | null;
  late: boolean;
  priority: string; // LOW | NORMAL | HIGH | URGENT
  videos: number; // deliverable count
  hasScript: boolean;
  comments: number;
  rawUrl: string | null;
  finalUrl: string | null;
  rawCount: number; // video files seen in the RAW folder (evidence sweep, ~hourly)
  finalCount: number; // video files seen in the Final folder
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
// selectable: true = anyone with the pill; "office" = owner/admin only, and
// only as an undo — see OFFICE_FROM in the pill for which rows (the editor
// sees it greyed with the reason); false = evidence sets it.
const STATUSES: Record<string, { color: string; selectable: boolean | "office" }> = {
  Waiting: { color: "#94a3b8", selectable: "office" }, // raws flip it off; the office can put a Ready for editing / In editing job back here (Sep 11)
  "Ready for editing": { color: "#38bdf8", selectable: "office" }, // raws flip it on; the office can put an In editing job back here (Sep 10) or move a Waiting one on (Sep 11)
  "In editing": { color: "#a78bfa", selectable: true }, // the editor's own "I've started" (Sep 10)
  "Ready for review": { color: "#f59e0b", selectable: true },
  Revisions: { color: "#f87171", selectable: true },
  Completed: { color: "#34d399", selectable: true },
};

// The queue's assignable video editors (matches VIDEO_EDITOR_KEYS server-side).
const VIDEO_EDITORS = [
  { key: "john", name: "John Mark" },
  { key: "kim", name: "Kim" },
] as const;

// Jordan, Sep 7: "I want to be able to unassign projects from editors and
// reassign them to an external agency. That way, our editors don't see jobs
// that are not assigned to them." Both are real destinations, not blanks —
// picking either takes the job off John's and Kim's boards for good (the
// server pins it so no engine routes a name back on). UNASSIGN is the empty
// string because that's what an unset <select> already carries.
const UNASSIGN = "";
const EXTERNAL = "external_agency";

const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "—";

// Height of the 6-option menu — used to flip it above the pill near the
// viewport bottom, since it renders position:fixed (see below).
const MENU_H = 212;

// office: the viewer is owner/admin (not the editor's scoped view) — unlocks
// the two undo options, "Ready for editing" and "Waiting". The server rule is
// the real guard.
// onReceipt: where an ok:true sentence goes. The row it belongs to leaves
// this tab the moment the server revalidates (a Completed job moves to Done),
// so a note under the pill is never seen — the queue shows it above the tabs
// instead (Sep 11 review).
function StatusPill({ row, office, onReceipt }: { row: QueueRow; office: boolean; onReceipt?: (msg: string) => void }) {
  // The menu is position:fixed, NOT absolute: the table wrapper is an
  // overflow-x-auto scroll container, which clips absolutely-positioned
  // children — on the bottom row (and short queues are all bottom rows) the
  // menu was cut off below the table edge. Fixed positioning escapes the clip;
  // the invisible fixed backdrop gives outside-click dismissal for free.
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [status, setStatus] = useState(row.status);
  // The server's reason when it refused (Sep 8): "Completed" on a job with a
  // client revision open is turned away with the way forward — upload the
  // corrected cut, it reads Completed once Jordan approves it — and that
  // sentence has to reach the editor, not vanish into a snapped-back pill.
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const meta = STATUSES[status] ?? { color: "#94a3b8", selectable: false };
  // The office's two undo moves (Jordan, Sep 10 "put them back"; Sep 11 "change
  // projects back to waiting"), each only on the rows where it IS an undo:
  // "Ready for editing" on an In editing row (put it back) or a Waiting row
  // (move it on — that releases the hold); "Waiting" on a Ready for editing or
  // In editing row. On a Revisions row neither would stick: the client's ask
  // keeps the job in Revisions on the next recompute and the click would leave
  // nothing but a stray "Put back…" line on the timeline (Sep 10 review). A
  // cut already in the Review Room is refused by the server with the reason.
  const OFFICE_FROM: Record<string, string[]> = {
    Waiting: ["Ready for editing", "In editing"],
    "Ready for editing": ["In editing", "Waiting"],
  };
  // A job the office is HOLDING in Waiting is nobody else's to move (Sep 11
  // review): the editor's pill greys every option on it — In editing there
  // would have walked past the hold. The server refuses the same click.
  const heldFromEditor = !office && row.held && status === "Waiting";
  const canPick = (name: string, s: boolean | "office") =>
    !heldFromEditor && (s === true || (s === "office" && office && (OFFICE_FROM[name] ?? []).includes(status)));
  const whyNot = (name: string, s: boolean | "office") =>
    heldFromEditor
      ? "The office is holding this job in Waiting — it can't be started until the footage is in"
      : s !== "office"
        ? "Set automatically from upload/delivery evidence"
        : !office
          ? `Only the office can put a job back to ${name}`
          : name === "Waiting"
            ? "Only a job on Ready for editing or In editing can be put back to Waiting"
            : "Only a job In editing or Waiting can be put to Ready for editing";

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
    setNote(null);
    start(async () => {
      // .catch too: a rejected action (DB hiccup, deleted project) must snap
      // back like a refusal, not crash the whole queue view.
      const r = await setQueueStatus(row.id, next).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      if (!r.ok) {
        setStatus(prev); // server refused — snap back, no silent lie
        setNote(r.message || "That didn't save — try again.");
      } else if (r.message && r.message !== "Status updated.") {
        // The label stuck, but the server did something MORE than write it
        // (sent the cut to the Review Room, parked a client revision as
        // waiting on Jordan, closed a revision for the office) — that
        // sentence has to reach the person, above the tabs where it survives
        // the row moving to another view.
        if (onReceipt) onReceipt(r.message);
        else setNote(r.message);
      }
    });
  };

  return (
    <>
      <button
        onClick={toggle}
        title={note ?? undefined}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold"
        style={{ backgroundColor: `${meta.color}26`, color: meta.color }}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : null}
        {status}
        <ChevronDown className="size-3 opacity-70" />
      </button>
      {note && (
        <span className="mt-1 block max-w-64 whitespace-normal text-[11px] leading-snug text-warning">{note}</span>
      )}
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
          <div className="fixed z-40 w-44 rounded-xl border border-border bg-surface p-1 shadow-xl" style={menu}>
            {Object.entries(STATUSES).map(([name, m]) => (
              <button
                key={name}
                disabled={!canPick(name, m.selectable)}
                onClick={() => pick(name)}
                title={canPick(name, m.selectable) ? undefined : whyNot(name, m.selectable)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium",
                  canPick(name, m.selectable) ? "hover:bg-surface-2" : "cursor-not-allowed opacity-40",
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
// (open task repointed + bell, or pinned on the project for an upcoming shoot),
// or pick Unassigned / External agency and it leaves our editors' queues.
// Optimistic with snap-back, same contract as the status pill; a refusal keeps
// the server's reason on the control's tooltip instead of failing silently.
function EditorSelect({ row }: { row: QueueRow }) {
  const [key, setKey] = useState(row.editorKey ?? UNASSIGN);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const known = key === EXTERNAL || VIDEO_EDITORS.some((e) => e.key === key);

  const pick = (next: string) => {
    if (next === key) return;
    const prev = key;
    setKey(next);
    setErr(null);
    start(async () => {
      const r = await setEditVideoEditor(row.id, next).catch(() => ({ ok: false, message: "That didn't save." }));
      if (!r.ok) {
        setKey(prev); // server refused — snap back, and keep the reason on hover
        setErr(r.message);
      }
    });
  };

  return (
    <span className="inline-flex items-center gap-1" title={err ?? undefined}>
      {pending && <Loader2 className="size-3 animate-spin text-muted" />}
      <select
        aria-label="Assign editor"
        value={key}
        disabled={pending}
        onChange={(e) => pick(e.target.value)}
        className={cn(
          "cursor-pointer rounded-md border border-transparent bg-transparent py-0.5 pl-1 pr-5 text-xs font-medium",
          "hover:border-border hover:bg-surface-2 disabled:opacity-60",
          err ? "text-danger" : key ? "text-foreground" : "text-muted-2",
        )}
      >
        {/* Selectable, not a disabled placeholder: taking a job OFF an editor
            is the point of this control now. */}
        <option value={UNASSIGN}>Unassigned</option>
        {/* A historical editor (Luma / Remar) still shows by name, but new work
            can only go to the current video editors or the outside shop. */}
        {!known && key && <option value={key} disabled>{row.editor ?? key}</option>}
        <optgroup label="Our editors">
          {VIDEO_EDITORS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Outside">
          <option value={EXTERNAL}>External agency</option>
        </optgroup>
      </select>
      {row.auto && key === (row.editorKey ?? UNASSIGN) && (
        <span className="text-[10px] text-muted-2" title="Assigned by the routing rules — pick a name to override">
          auto
        </span>
      )}
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
  dot,
}: {
  href: string;
  icon: typeof FolderOpen;
  label: string;
  title: string;
  brand?: boolean;
  // Uploaded-or-not (Jordan, Aug 27): green = files are in the folder, hollow
  // grey = still empty. Fed by the evidence sweep, so it refreshes ~hourly.
  dot?: boolean;
}) {
  const external = href.startsWith("http");
  const classes = cn(
    "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
    brand
      ? "border-brand/30 bg-brand-soft text-brand hover:bg-brand/15"
      : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
  );
  const body = (
    <>
      {dot != null && (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", dot ? "bg-success" : "border border-muted-2/70 bg-transparent")}
        />
      )}
      <Icon className="size-3" />
      {label}
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={classes}>
      {body}
    </a>
  ) : (
    <Link href={href} title={title} className={classes}>
      {body}
    </Link>
  );
}

export function SimpleQueue({
  notDone, upcoming, done, hideEditor = false,
}: {
  notDone: QueueRow[]; upcoming: QueueRow[]; done: QueueRow[];
  // The editor's own view (Jordan, Aug 27: "the same queue I do, just with the
  // jobs assigned to them and no editor section") — every row is already
  // theirs, so the Editor column is dead weight and the reassign control is
  // admin-only anyway.
  hideEditor?: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState<"notdone" | "upcoming" | "done">("notdone");
  // The last thing a status click did beyond writing the label (see StatusPill).
  const [receipt, setReceipt] = useState<string | null>(null);
  const rows = view === "notdone" ? notDone : view === "upcoming" ? upcoming : done;
  const VIEWS = [
    { key: "notdone" as const, label: "Not Done", n: notDone.length },
    { key: "upcoming" as const, label: "Upcoming", n: upcoming.length },
    { key: "done" as const, label: "Done", n: done.length },
  ];
  // Keeps click-to-open from firing when the click was really for a control
  // inside the row (status pill, editor select, a link).
  const swallow = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div>
      {receipt && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-sm text-foreground/90">
          <span className="min-w-0 flex-1">{receipt}</span>
          <button onClick={() => setReceipt(null)} aria-label="Dismiss" className="rounded-md px-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">Dismiss</button>
        </div>
      )}
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
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                <th className="px-3 py-2">Task</th>
                <th className="px-3 py-2">Video type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Due</th>
                {!hideEditor && <th className="px-3 py-2">Editor</th>}
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
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/edit/${r.id}`)}
                    // No row-wide tooltip: it followed the cursor across every
                    // cell and sat on top of the controls underneath it.
                    className="cursor-pointer align-top hover:bg-surface-2/50"
                  >
                    {/* min-w-52, up from 44: the copy glyph took the width the
                        address used to have, and streets like "2051 Old
                        Sumneytown Pike" started wrapping onto a second line —
                        every row a little taller, which is the opposite of
                        what Jordan asked for. */}
                    <td className="min-w-52 px-3 py-2.5">
                      <span className="flex items-start gap-1.5">
                        {/* A real link under the row click, so cmd/middle-click
                            opens the edit page in a new tab. */}
                        <Link href={`/edit/${r.id}`} onClick={swallow} title="Open the edit page" className="block min-w-0 flex-1">
                          <span className="font-semibold">{r.street}</span>
                          {/* Headshot beside the agent's name (Jordan, Sep 2). Inline
                              and shrink-0, so the cell stays the height of the
                              Video-type cell beside it — the row doesn't grow. */}
                          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                            <Avatar name={r.client} src={r.clientAvatarUrl} size={20} />
                            <span className="truncate">{r.client}</span>
                          </span>
                          {/* One line for both chips, not two stacked blocks —
                              a job that is both URGENT and in revisions used to
                              grow the row by an extra line. */}
                          {(r.priority !== "NORMAL" && r.priority !== "LOW") || r.openRevisions > 0 ? (
                            <span className="mt-0.5 flex flex-wrap items-center gap-1">
                              {r.priority !== "NORMAL" && r.priority !== "LOW" && (
                                <span className="rounded bg-danger-soft px-1.5 text-[10px] font-semibold text-danger">{r.priority}</span>
                              )}
                              {r.openRevisions > 0 && (
                                <span className="rounded bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">
                                  {r.openRevisions} revision ask{r.openRevisions === 1 ? "" : "s"}
                                </span>
                              )}
                            </span>
                          ) : null}
                        </Link>
                        {/* COPY LINK (Jordan, Sep 7): "I want to be able to copy
                            the project link from the editing room table and
                            send it to an editor, and they can click it, and it
                            opens if they are already logged in on that
                            browser." The absolute URL is built on the server
                            (row.url) from the hub's public origin — copying
                            window.location here would hand Manila a localhost
                            link off Jordan's laptop. A bare glyph, muted until
                            you reach for it: Jordan has to be able to FIND it,
                            so it is not hidden behind a row hover (and there is
                            no hover at all on his phone). Outside the <Link>
                            because a button inside an anchor is invalid HTML —
                            and it swallows the click so the row doesn't
                            navigate out from under the copy. */}
                        <span onClick={swallow} className="shrink-0 pt-0.5">
                          <CopyButton
                            value={r.url}
                            title={`Copy this job's link to send to an editor — ${r.url}`}
                            className="text-muted-2 hover:text-brand"
                          />
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
                        // hideEditor is the editor's scoped view — everyone
                        // else looking at this table is the office.
                        <StatusPill key={r.status} row={r} office={!hideEditor} onReceipt={setReceipt} />
                      )}
                    </td>
                    <td className={cn("whitespace-nowrap px-3 py-2.5 text-xs font-medium", r.late ? "text-danger" : "")}>
                      {view === "upcoming" ? `Shoots ${fmtDay(r.shootISO)}` : fmtDay(r.dueISO)}{r.late ? " · late" : ""}
                      {view === "upcoming" && r.photographer && <span className="block text-muted">📷 {r.photographer}</span>}
                    </td>
                    {!hideEditor && (
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
                    )}
                    <td className="px-3 py-2.5 text-center text-xs">{r.videos}</td>
                    <td className="whitespace-nowrap px-3 py-2.5" onClick={swallow}>
                      <span className="inline-flex items-center gap-1">
                        {r.rawUrl && (
                          <LinkChip
                            href={r.rawUrl}
                            icon={FolderOpen}
                            label="RAW"
                            dot={r.rawCount > 0}
                            title={r.rawCount > 0 ? `RAW footage folder — ${r.rawCount} file${r.rawCount === 1 ? "" : "s"} uploaded` : "RAW footage folder — nothing uploaded yet (checked hourly)"}
                          />
                        )}
                        {r.finalUrl && (
                          <LinkChip
                            href={r.finalUrl}
                            icon={FolderUp}
                            label="Final"
                            dot={r.finalCount > 0}
                            title={r.finalCount > 0 ? `Final footage folder — ${r.finalCount} file${r.finalCount === 1 ? "" : "s"} in` : "Final footage folder — no finished cut yet (checked hourly)"}
                          />
                        )}
                        {r.hasScript && <LinkChip href={`/edit/${r.id}`} icon={FileText} label="Script" title="A script is on file — view it on the edit page" brand />}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center" onClick={swallow}>
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
