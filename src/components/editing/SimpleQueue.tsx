"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  FolderUp,
  Loader2,
  MessageSquare,
  Pin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { etDayKey, etMonthDay } from "@/lib/datetime";
import { Avatar } from "@/components/ui/Avatar";
import { CopyButton } from "@/components/ui/CopyButton";
import { setEditVideoEditor, setQueueStatus } from "@/app/editing/actions";
import { EditOverridesButton, OverrideChip, hasOverride } from "@/components/editing/EditOverridesDialog";
import { RemoveFromQueueButton } from "@/components/editing/RemoveFromQueue";
import type { EditComputedView, EditOverrideView } from "@/lib/editOverrideDefaults";

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
// EDITOR sets it when they start. Since Sep 25 (§7.1) "In editing" and
// "Paused" are the editor's own Start / Pause (lib/editorWork): one active job
// per editor, and starting another pauses the one they were on. A row reads
// "In editing" only while somebody has pressed Start; an old EDITING nobody
// confirmed says "In editing — not confirmed", and a job in review or in
// revisions keeps its word and wears a chip naming who is on it. The OFFICE (owner/admin) can walk a job
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
//
// THE OVERRIDE (Jordan, Sep 13: "I want to be able to change the status,
// amount of deliverables, the due date and all other information for the
// edits in the editing room. I want to be able to override anything."): the
// sliders glyph beside the status pill (office only) opens a dialog that sets
// any of it — status past the pill's guardrails (and PINS it so the sweeps
// stop moving it), editor, videos owed, due, priority, tier, video type — on
// top of what the hub works out. Every row value below is AFTER overrides;
// `computed` keeps what the hub would have said, so the dialog can show both
// and hand a field back. A row wearing any override shows the Override chip
// (hover = who, when, note) and a pinned status wears a pin on its pill. The
// pill and the editor select keep working exactly as before.

/** One editor's declared work on a row (§7.1, lib/editorWork). */
export type WorkPersonView = { key: string; name: string; sinceISO: string | null; outputTitle: string | null; onBehalfBy: string | null };

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
  /** The per-video arithmetic under the pill on a multi-video job (Sep 18):
   *  "1 ready for review · 3 more in editing". Null when the job owes one
   *  video, where the pill already says everything. */
  videoBreakdown: string | null;
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
  // What the office set on this job (Sep 13) — null on a field = no override.
  // statusPinned = the row's status label is the pinned Project.status, not
  // the cut-derived reading, and the pill wears a pin.
  overrides: EditOverrideView;
  // What the hub would say on its own — the row's values BEFORE overrides.
  computed: EditComputedView;
  /** Who has pressed Start (active) or Pause on this job — never derived from
   *  the status (§7.1). */
  work: { active: WorkPersonView[]; paused: WorkPersonView[] };
  /** "Active — Kim since 10:02am" / "Paused — Kim 3:10pm"; null when nobody. */
  workChip: string | null;
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
// "working" = Pause: only on a row somebody has actually started (§7.1).
const STATUSES: Record<string, { color: string; selectable: boolean | "office" | "working" }> = {
  Waiting: { color: "#94a3b8", selectable: "office" }, // raws flip it off; the office can put a Ready for editing / In editing job back here (Sep 11)
  "Ready for editing": { color: "#38bdf8", selectable: "office" }, // raws flip it on; the office can put an In editing job back here (Sep 10) or move a Waiting one on (Sep 11)
  "In editing": { color: "#a78bfa", selectable: true }, // Start / Resume — the editor's own (Sep 10), or the office's correction, logged as the office (§7.1)
  Paused: { color: "#8b5cf6", selectable: "working" }, // Pause — the job stays theirs, due date and asks untouched (§7.1)
  "Ready for review": { color: "#f59e0b", selectable: true },
  Revisions: { color: "#f87171", selectable: true },
  Completed: { color: "#34d399", selectable: true },
};
// Words a row can WEAR but nobody can pick: an EDITING nobody has confirmed
// since the Start button existed (a pre-Sep-25 click, an office pin, a board
// move). Picking "In editing" on it is how the editor confirms it.
const WORN_ONLY: Record<string, { color: string }> = {
  "In editing — not confirmed": { color: "#a78bfa" },
  // A cut is in but held for the editor's send-for-review check (§8.2) —
  // finished on the job's page, not picked here (editorQueue.CHECK_NEEDED_STATUS).
  "Check needed": { color: "#fb923c" },
};
// The two work moves: they change who is on the job, not the job's stage, so
// the pill does not pretend the label changed — the row comes back from the
// server with the truth (and its chip) instead.
const WORK_MOVES = new Set(["In editing", "Paused"]);

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

// Height of the 7-option menu — used to flip it above the pill near the
// viewport bottom, since it renders position:fixed (see below).
const MENU_H = 244;

// One id per status click (§7.1) — the server's idempotency key.
const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
  const meta = STATUSES[status] ?? { ...(WORN_ONLY[status] ?? { color: "#94a3b8" }), selectable: false };
  // The office's two undo moves (Jordan, Sep 10 "put them back"; Sep 11 "change
  // projects back to waiting"), each only on the rows where it IS an undo:
  // "Ready for editing" on an In editing row (put it back) or a Waiting row
  // (move it on — that releases the hold); "Waiting" on a Ready for editing or
  // In editing row. On a Revisions row neither would stick: the client's ask
  // keeps the job in Revisions on the next recompute and the click would leave
  // nothing but a stray "Put back…" line on the timeline (Sep 10 review). A
  // cut already in the Review Room is refused by the server with the reason.
  const OFFICE_FROM: Record<string, string[]> = {
    Waiting: ["Ready for editing", "In editing", "Paused", "In editing — not confirmed"],
    "Ready for editing": ["In editing", "Waiting", "Paused", "In editing — not confirmed"],
  };
  // A job the office is HOLDING in Waiting is nobody else's to move (Sep 11
  // review): the editor's pill greys every option on it — In editing there
  // would have walked past the hold. The server refuses the same click.
  const heldFromEditor = !office && row.held && status === "Waiting";
  const working = row.work.active.length > 0;
  const canPick = (name: string, s: boolean | "office" | "working") =>
    !heldFromEditor &&
    (s === true || (s === "working" && working) || (s === "office" && office && (OFFICE_FROM[name] ?? []).includes(status)));
  const whyNot = (name: string, s: boolean | "office" | "working") =>
    heldFromEditor
      ? "The office is holding this job in Waiting — it can't be started until the footage is in"
      : s === "working"
        ? status === "Paused" ? "It's already paused — In editing resumes it" : "Nobody has started this one — there is nothing to pause"
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
    if (next === status && !WORK_MOVES.has(next)) return;
    const prev = status;
    if (!WORK_MOVES.has(next)) setStatus(next);
    setNote(null);
    // One id per click (§7.1): the server logs a retried or doubled request
    // once, and a replay comes back as "Already recorded".
    const requestId = newRequestId();
    start(async () => {
      // .catch too: a rejected action (DB hiccup, deleted project) must snap
      // back like a refusal, not crash the whole queue view.
      const r = await setQueueStatus(row.id, next, requestId).catch(() => ({ ok: false, message: "That didn't save — try again." }));
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

  // A PINNED status (the office set it in the override dialog, Sep 13): the
  // label is Project.status held in place, not the cut-derived reading — the
  // pin says so, and hover says who. The pill itself still works: a pick here
  // is a human status write, which the server treats as the human's newer
  // word (it clears or renews the pin).
  const pinned = row.overrides.statusPinned;
  const pinTitle = pinned
    ? `Pinned by the office — the hub won't move it${row.overrides.by ? ` (override by ${row.overrides.by})` : ""}`
    : null;

  return (
    <>
      <button
        onClick={toggle}
        title={note ?? pinTitle ?? undefined}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold"
        style={{ backgroundColor: `${meta.color}26`, color: meta.color }}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : null}
        {pinned && <Pin className="size-3" aria-label="Pinned by the office" />}
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

// ---------------------------------------------------------------------------
// THE DUE FILTER (Jordan, Sep 18: "Also another filter in the editing room like
// Due Today would be nice.")
//
// Same design rule as the Editor select: it filters the view you are ON. No
// fourth tab and no separate screen, so the view pills, their counts and every
// in-row control keep working exactly as they did.
//
// DATES ARE THE JOB HERE and all of them are Eastern. "Today" is the ET
// CALENDAR DAY via etDayKey — not a rolling 24 hours, and not the browser's
// day: John Mark and Kim edit from Manila, twelve hours ahead, and "due today"
// has to name the same square on their screen as on Jordan's. It is also not
// `dueISO.slice(0, 10)`, which is the UTC date: 24 of the 540 jobs carrying a
// deliveryDue on the live board sit on a different UTC date than ET one (probe,
// Sep 18), because the hour-quoted tiers (video_48h and friends) land at
// shoot-time + N hours and an evening deadline crosses midnight in UTC first.
// ---------------------------------------------------------------------------
export type DueFilter = "any" | "overdue" | "today" | "week" | "undated";

// Day-KEY arithmetic, the shape src/lib/datetime.ts settled on (its
// addBusinessDayKeysET and businessDaysBetweenET walk keys, never milliseconds):
// "YYYY-MM-DD" strings order exactly as the dates do, and stepping through UTC
// NOON keeps a clock change from moving the answer by a day.
const shiftDayKey = (key: string, days: number) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
};

// The ET week today sits in, Monday through Sunday. Monday-start, not the US
// Sunday-start calendar: the promise this whole queue is measured against is
// quoted in BUSINESS days (datetime.ts — weekends are not business days), so
// the week the shop plans is the one that starts when the work does.
export function etWeekBounds(todayKey: string): { start: string; end: string } {
  const dow = new Date(`${todayKey}T12:00:00Z`).getUTCDay(); // 0 = Sunday, read the way isWeekdayET reads it
  const start = shiftDayKey(todayKey, dow === 0 ? -6 : 1 - dow);
  return { start, end: shiftDayKey(start, 6) };
}

// ONE predicate, used both to COUNT an option and to FILTER the rows, so an
// option's number can never drift away from what picking it actually shows.
// Exported with etWeekBounds above so scripts/_drill can run the real function
// against the real board rather than a copy of it — the date arithmetic here is
// the part most likely to be quietly wrong.
export function matchesDue(f: DueFilter, late: boolean, key: string | null, today: string, week: { start: string; end: string }) {
  if (f === "any") return true;
  // OVERDUE is the row's own `late` flag — the server's instant comparison, the
  // same one the Due cell already prints in red. Deriving a second answer here
  // ("day key before today") would disagree with that red text on a job due 5pm
  // today and read at 6pm, and on the Done tab it would brand all 32 delivered
  // jobs overdue, since every delivered job's deadline is behind us by now.
  if (f === "overdue") return late;
  if (f === "undated") return key === null;
  if (key === null) return false;
  if (f === "today") return key === today;
  // "This week" is the calendar week the deadline FALLS IN, not "between now
  // and Sunday" — a job that was due Monday is still a thing due this week, and
  // it is the one you most want to see.
  return key >= week.start && key <= week.end;
}

// The Upcoming tab's dueISO is the SHOOT date, not a delivery date
// (editorQueue.toRow: `due = upcoming ? p.shootDate : effectiveDue(...)`) — the
// Due column there already says "Shoots Sep 21" for that reason. So the control
// RENAMES itself on that tab rather than quietly answering a different question
// under the word "Due". Overdue is not offered there at all: that tab is built
// from `shootDate >= now`, so nothing on it can be late. Dropped because the
// question is wrong, not because today's count happens to be zero.
const DUE_LABEL: Record<DueFilter, { due: string; shoot: string }> = {
  any: { due: "Any due date", shoot: "Any shoot date" },
  overdue: { due: "Overdue", shoot: "Overdue" },
  today: { due: "Due today", shoot: "Shoots today" },
  // "Shoots this week" named Monday–Sunday while the Upcoming tab only ever
  // holds shoots still ahead of now — on a Friday it advertised four days that
  // cannot appear on it. The rest of the week is what it actually shows.
  week: { due: "Due this week", shoot: "Shoots rest of this week" },
  undated: { due: "No due date", shoot: "No shoot date" },
};

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
  // WHOSE WORK AM I LOOKING AT (Jordan, Sep 17). The queue is every job in the
  // shop; most questions about it are about one person's share of it. Null is
  // everyone. It filters the view you are on rather than switching you to a
  // different screen, so the tabs, the counts and the row controls all keep
  // working exactly as they did.
  const [who, setWho] = useState<string | null>(null);
  // WHEN IS IT DUE (Jordan, Sep 18) — see the DueFilter block above. Remembered
  // across tab switches, but the TAB decides what can be applied: `when` below
  // is what is actually in force and what the select shows, so carrying an
  // Overdue off Not Done onto Upcoming (where nothing can be late) can't leave
  // the table empty under a control claiming otherwise.
  const [dueWanted, setDueWanted] = useState<DueFilter>("any");
  // The last thing a status click did beyond writing the label (see StatusPill).
  const [receipt, setReceipt] = useState<string | null>(null);
  const all = view === "notdone" ? notDone : view === "upcoming" ? upcoming : done;
  const upcomingTab = view === "upcoming";
  const word = upcomingTab ? ("shoot" as const) : ("due" as const);
  // Which due options a TAB can answer — Overdue is not one of Upcoming's (see
  // DUE_LABEL). Taken as a function because the view pills below have to ask it
  // about the tab you are NOT on, to count what clicking would really show.
  const choicesFor = (tab: typeof view): DueFilter[] =>
    tab === "upcoming" ? ["today", "week", "undated"] : ["overdue", "today", "week", "undated"];
  const DUE_CHOICES = choicesFor(view);
  const when: DueFilter = DUE_CHOICES.includes(dueWanted) ? dueWanted : "any";

  // Read at render, like every other "today" in the app (MyShootsView does the
  // same): the page revalidates on every server action, so a tab left open
  // across ET midnight picks the new day up on its next render. It is read on
  // the server too (this client component is SSR'd), so a render that straddles
  // ET midnight can hydrate against the next day's key — the only thing that
  // would differ is an option count, React re-renders it on the spot, and
  // pinning the value at mount would leave a tab open all day on a stale one.
  const todayKey = etDayKey(new Date());
  const week = useMemo(() => etWeekBounds(todayKey), [todayKey]);
  // One etDayKey per ROW, not one per option per row: each call builds an
  // Intl.DateTimeFormat, and the four option counts alone would ask for the
  // same answer four times over on every render of a 65-row board.
  const dueKeys = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of [...notDone, ...upcoming, ...done]) m.set(r.id, r.dueISO ? etDayKey(new Date(r.dueISO)) : null);
    return m;
  }, [notDone, upcoming, done]);

  const byWho = (r: QueueRow) => who === null || (r.editorKey ?? "__none__") === who;
  const byWhen = (r: QueueRow) => matchesDue(when, r.late, dueKeys.get(r.id) ?? null, todayKey, week);
  const rows = all.filter((r) => byWho(r) && byWhen(r));

  // CROSS-FILTERED, both ways: each select counts inside what the OTHER one has
  // already narrowed to, so every number on offer is exactly the number of rows
  // that picking it shows — in either order, and with both on. Counting either
  // control over the whole tab would hand out dead ends: on the real board this
  // morning Kim had 7 open jobs and not one of them due today, due this week or
  // late, so a tab-wide "Due today (3)" sitting on her view would have emptied
  // the table (probe, Sep 18).
  const forEditors = all.filter(byWhen);
  const forDue = all.filter(byWho);

  // Built from the rows ON THIS TAB, so a name never offers itself and then
  // shows nothing. "Nobody assigned" earns a place the moment a row has no
  // editor — that is the pile worth finding.
  const people = (() => {
    const seen = new Map<string, { key: string; label: string; n: number }>();
    for (const r of forEditors) {
      const key = r.editorKey ?? "__none__";
      const found = seen.get(key);
      if (found) found.n++;
      else seen.set(key, { key, label: r.editorKey ? (r.editor ?? r.editorKey) : "Nobody assigned", n: 1 });
    }
    // The name actually SELECTED stays on the list even at zero. A <select>
    // whose value matches no option renders blank, which reads as "no filter"
    // while a filter is very much on — the one way a tab switch could still
    // strand you on an editor this tab has never heard of.
    if (who !== null && !seen.has(who)) {
      const known = [...notDone, ...upcoming, ...done].find((r) => r.editorKey === who);
      seen.set(who, { key: who, label: who === "__none__" ? "Nobody assigned" : known?.editor ?? who, n: 0 });
    }
    return [...seen.values()].sort((a, b) =>
      (a.key === "__none__" ? -1 : b.key === "__none__" ? 1 : 0) || b.n - a.n || a.label.localeCompare(b.label));
  })();
  // Same rule for the due options, and the same escape hatch for the one in
  // force. An option with nothing behind it is simply not offered.
  const dueOptions = DUE_CHOICES.map((f) => ({
    f,
    n: forDue.filter((r) => matchesDue(f, r.late, dueKeys.get(r.id) ?? null, todayKey, week)).length,
  })).filter((o) => o.n > 0 || o.f === when);
  const dueTitle = (f: DueFilter) => {
    if (f === "overdue") return "Past its deadline — the same rows the Due column prints in red";
    if (f === "today") return `${upcomingTab ? "Shooting" : "Due"} today, Eastern — the whole ET calendar day, whatever hour the date carries`;
    // The Upcoming tab is built from `shootDate >= now`, so the first half of
    // the ET week is already behind it: a title reading "Sep 14–Sep 20" on a
    // Friday named four days the tab cannot hold, and the count beside it was
    // only ever the days still ahead. It now names the window it can actually
    // show. Not Done keeps the whole week, where a missed deadline dated this
    // week is exactly the row you are looking for.
    if (f === "week")
      return upcomingTab
        ? `Shooting between today and Sunday, Eastern — ${etMonthDay(todayKey)}–${etMonthDay(week.end)}. Earlier days of this week have already been shot, so this tab cannot hold them`
        : `Due in this Eastern week, ${etMonthDay(week.start)}–${etMonthDay(week.end)} — a deadline already missed but dated this week counts`;
    if (f === "undated") return upcomingTab ? "No shoot date on the job" : "No delivery date on the job — the pile no date filter would otherwise show you";
    return "No date filter";
  };

  // The Editor select's own visibility stays keyed to the TAB, not to the
  // cross-filtered list above: a due filter that narrows the board to one
  // person must not take away the control you'd use to widen it again.
  const editorKeysOnTab = new Set(all.map((r) => r.editorKey ?? "__none__"));
  // …and the DUE select's visibility is keyed to the tab for the same reason in
  // the other direction. Hiding it on `dueOptions.length > 0` took the control
  // away whenever the chosen editor had nothing in any bucket — on the live
  // board this morning that was three real selections on the Done tab (Kim's 4
  // rows, the outside agency's 2, Remar's 2: dated, not late, not this week, so
  // no option matched). A control that disappears is one you cannot use to
  // widen the board again. The OPTIONS stay cross-filtered; only the control
  // itself now survives an editor pick.
  const dueOnTab = DUE_CHOICES.some((f) => all.some((r) => matchesDue(f, r.late, dueKeys.get(r.id) ?? null, todayKey, week)));
  const filtering = who !== null || when !== "any";
  // THE PILLS COUNT WHAT CLICKING THEM SHOWS (review, Sep 18). They were the
  // one number on this screen that ignored the filters, so with Kim picked and
  // Overdue on, the live board offered "Not Done 19" and "Done 32" and handed
  // over an empty table both times — the same dead end the option counts above
  // were cross-filtered to stop. Each tab is counted under the filter IT would
  // apply: Upcoming cannot answer Overdue, so a carried-over Overdue counts as
  // no due filter there, exactly as `when` does once you are on it.
  const countOn = (tab: typeof view, rows: QueueRow[]) => {
    const w: DueFilter = choicesFor(tab).includes(dueWanted) ? dueWanted : "any";
    return rows.filter((r) => byWho(r) && matchesDue(w, r.late, dueKeys.get(r.id) ?? null, todayKey, week)).length;
  };
  const VIEWS = [
    { key: "notdone" as const, label: "Not Done", n: countOn("notdone", notDone) },
    { key: "upcoming" as const, label: "Upcoming", n: countOn("upcoming", upcoming) },
    { key: "done" as const, label: "Done", n: countOn("done", done) },
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
            {/* A zero is worth printing while a filter is on: "Done 0" is the
                answer to "is there any of Kim's in there", and a bare pill
                would read as a tab nobody has counted. */}
            {(v.n > 0 || filtering) && <span className={cn("ml-1.5 rounded-full px-1.5 text-xs font-semibold", view === v.key ? "bg-white/20" : "bg-surface-2")}>{v.n}</span>}
          </button>
        ))}
        {/* Not pills: the editor list grows, the due list is four words long,
            and either as a row of buttons would compete with the views for the
            eye. Both sit right-aligned together; the Editor one is hidden on an
            editor's own queue, where every row is already theirs, but the due
            one stays — "what's due today" is exactly the question an editor
            opens this page with. */}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {!hideEditor && (editorKeysOnTab.size > 1 || who !== null) && (
            <label className="flex items-center gap-1.5 text-xs text-muted">
              Editor
              <select
                value={who ?? ""}
                onChange={(e) => setWho(e.target.value || null)}
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              >
                <option value="">Everyone ({forEditors.length})</option>
                {people.map((p) => (
                  <option key={p.key} value={p.key}>{p.label} ({p.n})</option>
                ))}
              </select>
            </label>
          )}
          {(dueOnTab || when !== "any") && (
            <label className="flex items-center gap-1.5 text-xs text-muted">
              {upcomingTab ? "Shoot" : "Due"}
              <select
                value={when}
                title={dueTitle(when)}
                onChange={(e) => setDueWanted(e.target.value as DueFilter)}
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              >
                <option value="any">{DUE_LABEL.any[word]} ({forDue.length})</option>
                {dueOptions.map((o) => (
                  <option key={o.f} value={o.f} title={dueTitle(o.f)}>{DUE_LABEL[o.f][word]} ({o.n})</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
          {/* A filtered-empty table is not an empty queue, and saying "nothing
              open" over a filter that is hiding 19 jobs is a lie the filters
              themselves would have to answer for. The counts above make this
              nearly unreachable — it is the landing spot for a selection that
              went stale on a tab switch, so it comes with the way out. */}
          {filtering ? (
            <>
              Nothing on this tab matches the filters above.{" "}
              <button
                onClick={() => { setWho(null); setDueWanted("any"); }}
                className="font-medium text-brand underline underline-offset-2"
              >
                Clear filters
              </button>
            </>
          ) : view === "upcoming" ? "No upcoming video shoots on the schedule." : view === "done" ? "Nothing completed in the last 60 days." : "Nothing open — new jobs add themselves when a video shoot is booked."}
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
                          {/* One line for all the chips, not stacked blocks —
                              a job that is both URGENT and in revisions used to
                              grow the row by an extra line. The Override chip
                              (Sep 13) rides the same line: only a row the
                              office actually touched grows by it. */}
                          {(r.priority !== "NORMAL" && r.priority !== "LOW") || r.openRevisions > 0 || hasOverride(r.overrides) ? (
                            <span className="mt-0.5 flex flex-wrap items-center gap-1">
                              {r.priority !== "NORMAL" && r.priority !== "LOW" && (
                                <span className="rounded bg-danger-soft px-1.5 text-[10px] font-semibold text-danger">{r.priority}</span>
                              )}
                              {r.openRevisions > 0 && (
                                <span className="rounded bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">
                                  {r.openRevisions} revision ask{r.openRevisions === 1 ? "" : "s"}
                                </span>
                              )}
                              {/* Who set it, when, and the note — on hover. */}
                              <OverrideChip overrides={r.overrides} />
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
                      <span className="inline-flex items-center gap-1">
                        {view === "upcoming" ? (
                          // An Upcoming row reads Waiting — unless the office
                          // PINNED it somewhere (Sep 13): editorQueue then puts
                          // the pinned label on r.status, and the row shows it
                          // with the pin the same way the live pill does.
                          <span
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold"
                            style={{ backgroundColor: "#94a3b826", color: "#94a3b8" }}
                            title={r.overrides.statusPinned ? `Pinned by the office — the hub won't move it${r.overrides.by ? ` (override by ${r.overrides.by})` : ""}` : undefined}
                          >
                            {r.overrides.statusPinned && <Pin className="size-3" aria-label="Pinned by the office" />}
                            {r.overrides.statusPinned ? r.status : "Waiting"}
                          </span>
                        ) : (
                          // key = server truth: when a revalidation streams a
                          // status this component didn't set (evidence flip,
                          // another admin), remount so the pill can't go stale.
                          // hideEditor is the editor's scoped view — everyone
                          // else looking at this table is the office.
                          // The chip is in the key too: Start / Pause change who
                          // is on a job without always changing its word.
                          <StatusPill key={`${r.status}|${r.workChip ?? ""}`} row={r} office={!hideEditor} onReceipt={setReceipt} />
                        )}
                        {/* THE OVERRIDE (Sep 13) — office only. A bare glyph
                            beside the pill, muted until you reach for it, and
                            always there (no row hover: Jordan has to be able
                            to FIND it, and there is no hover on his phone).
                            Its receipt goes above the tabs like the pill's.
                            The dialog it opens is a child of this cell, so
                            the cell's swallow keeps clicks inside it from
                            opening the edit page. key = server truth again:
                            a fresh row from a revalidation remounts it with
                            the values the server now holds. */}
                        {!hideEditor && (
                          <EditOverridesButton
                            key={`${r.status}|${r.editorKey ?? ""}|${r.overrides.at ?? ""}`}
                            job={{
                              projectId: r.id,
                              street: r.street,
                              status: r.status,
                              editorKey: r.editorKey,
                              editorName: r.editor,
                              editorAuto: r.auto,
                              overrides: r.overrides,
                              computed: r.computed,
                            }}
                            onReceipt={setReceipt}
                          />
                        )}
                        {/* OFF THIS BOARD (Jordan, Sep 18). Office only, beside
                            the override for the same reason: this cell is where
                            the per-row office controls live, and the cell's
                            swallow keeps a click inside it from opening the
                            edit page. It is not a delete — see the dialog's own
                            words and lib/queueRemoved. */}
                        {!hideEditor && <RemoveFromQueueButton projectId={r.id} street={r.street} onReceipt={setReceipt} />}
                      </span>
                      {/* FOUR VIDEOS, ONE WORD (Jordan, Sep 18). The pill names
                          the loudest state, which on a batch is true of ONE
                          video and reads as true of the job — 5642 Limeport
                          says "Ready for review" with three videos not yet cut.
                          The pill stays because it is the action; this is the
                          arithmetic under it. Never rendered on a one-video
                          job (editorQueue leaves it null there). */}
                      {r.videoBreakdown && (
                        <span className="mt-1 block text-[11px] text-muted-2">{r.videoBreakdown}</span>
                      )}
                      {/* WHO IS ON IT (§7.1) — the editor's own Start/Pause,
                          with the time they said so. A declared status, not a
                          timer: nothing here counts hours. */}
                      {r.workChip && (
                        <span
                          className={cn(
                            "mt-1 flex items-center gap-1 text-[11px]",
                            r.work.active.length ? "font-medium text-[#8b5cf6]" : "text-muted-2",
                          )}
                          title={r.work.active.concat(r.work.paused).some((x) => x.onBehalfBy)
                            ? `Last change made by the office (${r.work.active.concat(r.work.paused).find((x) => x.onBehalfBy)?.onBehalfBy}) on the editor's behalf`
                            : undefined}
                        >
                          <span className={cn("size-1.5 shrink-0 rounded-full", r.work.active.length ? "bg-[#8b5cf6]" : "border border-muted-2/70")} />
                          {r.workChip}
                        </span>
                      )}
                    </td>
                    <td
                      className={cn("whitespace-nowrap px-3 py-2.5 text-xs font-medium", r.late ? "text-danger" : "")}
                      // An office-set due says so on hover, with what the hub
                      // would have said.
                      title={view !== "upcoming" && r.overrides.dueAt ? `Due set by the office (the hub would say ${fmtDay(r.computed.dueAt)})` : undefined}
                    >
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
                    <td
                      className="px-3 py-2.5 text-center text-xs"
                      title={r.overrides.videosOwed != null ? `Videos owed set by the office (the hub would say ${r.computed.videosOwed})` : undefined}
                    >
                      {r.videos}
                    </td>
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
