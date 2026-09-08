import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import {
  AlarmClock, AlertTriangle, ArrowRight, Camera, CheckCircle2, ChevronDown, Clapperboard,
  ClipboardCheck, Clock, CloudSun, Coffee, ExternalLink, Hourglass, Inbox,
  ListChecks, MessageSquare, Moon, Plane, PlayCircle, RefreshCw, Route, Sun, Sunrise, Wrench, Zap,
  Flag,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier, homeFor } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { cn, formatMoney } from "@/lib/utils";
import { etDate, etDayKey, etDayStartUtc, etFullDate, etTime , etDateTime } from "@/lib/datetime";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { QcComplete } from "@/components/ops/QcComplete";
import { LoopActions } from "@/components/ops/LoopActions";
import { ProactiveFlags } from "@/components/dashboard/ProactiveFlags";
import { StuckJobs } from "@/components/dashboard/StuckJobs";
import { WeekStrip } from "@/components/dashboard/WeekStrip";
import { PulseStrip } from "@/components/dashboard/PulseStrip";
import { QualityDials } from "@/components/dashboard/QualityDials";
import { DeliveryBoardView } from "@/components/tracker/DeliveryBoardView";
import { QuickAdd } from "@/components/day/QuickAdd";
import { TodoRow } from "@/components/day/TodoRow";
import { FinishedList } from "@/components/day/FinishedList";
import {
  buildOpsDay, loopsZeroState, tallyLoops,
  type OpsDay, type OpsLoop, type OpsQcRow, type OpsShoot,
} from "@/lib/opsDay";
import { deliveryBoard, type DeliveryBoard } from "@/lib/deliveryBoard";
import { ownerTodoLists } from "@/lib/ownerDay";
import { ownerPulse } from "@/lib/ownerPulse";
import {
  MESSAGE_TASK_TYPES, getStuckJobs, getShootWindow,
  getProactiveFlags, getHandledToday, getOwnerStats, getOwnerPulse, getOwnerDials,
  getFlaggedForMe } from "@/lib/queries";
import { recentProjectWhere } from "@/lib/recency";
import { boardVisibleWhere, isNeedsAssigning } from "@/lib/triage";
import { clientTextWhere } from "@/lib/clientTexts";
import { unansweredCommsBoard } from "@/lib/commsBoard";
import type { VideoCutState } from "@/lib/reviewCuts";
import { aryeoListingUrl } from "@/lib/aryeoUrl";
import { NewClientCard } from "@/components/clients/NewClientCard";
import { newClientsForDashboard } from "@/lib/newClients";
import { listAssignees, slugForName, viewerAssigneeKey } from "@/lib/assignees";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// HOME — one screen per role (Jordan, Sep 2: "I want the ops day screen
// essentially combined with my dashboard").
//
// This page is the merge of four surfaces that all tried to be the morning
// screen: the old Dashboard (counts + money), Ops Day (the guided operating
// day), My Day (the owner's personal list + business money) and the Project
// Tracker (the delivery board). /ops, /day and /pipeline keep their routes —
// /ops now redirects here, the other two are simply off the nav.
//
// THE ORDER IS THE PRODUCT. Jordan: "Action before information."
//   1. What needs you today — decisions and blockers, nothing else
//   2. Your day — the time blocks and what is live in each one
//   3. Today's shoots — the day's hard commitments, in full
//   4. Your list (owner) — his own to-dos, captured and closed here
//   5. Money + pulse + quality (OWNER ONLY — an admin's page ends at 4)
//
// EXCEPT FOR AN ADMIN (Jordan, Sep 7: "I don't want Kyle to see my screen at
// the beginning. I think his should start with the morning control tower").
// Kyle's day IS the tower, so a non-owner gets today's shoots and the guided
// blocks first, and the decisions list underneath. Same sections, same
// numbers, an order that matches whose day it is.
//
// THE RULE FOR EVERY NUMBER (audit fault #9, Sep 2 2026): a count is computed
// with THE QUERY OF THE LIST IT LINKS TO. Where a number links to a section on
// this page, it is literally the length of the array that section renders, so
// the two cannot drift. Where it links off-page, it is the destination's own
// query, restated here with a comment saying which.
//
// Deliberately NOT on this page any more:
//   · Ops Day's six stat tiles — every one of them is now either a row in
//     "What needs you today" or a badge on its own block. The same number
//     twice on one screen is how dashboards start lying.
//   · The old dashboard's "texts unanswered" chip — it counted phone threads
//     including unmatched numbers while the comms blocks counted CLIENTS, so
//     the merged page would have carried two different "people waiting"
//     numbers. The reply queue keeps its own count next to its own name,
//     inside the comms block.
// ---------------------------------------------------------------------------

const ET = "America/New_York";

function etMinutes(d: Date): number {
  const [h, m] = d
    .toLocaleTimeString("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false })
    .split(":")
    .map(Number);
  return h * 60 + m;
}
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" });
// "Tue 9:00 AM" — a turnaround promise needs the hour, not just the day.
const fmtDayTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: ET, weekday: "short", hour: "numeric", minute: "2-digit" });
// "3h" / "2 days" — how long something has sat, in the unit a person would use.
function ageText(iso: string, now: Date): string {
  const h = Math.floor((now.getTime() - Date.parse(iso)) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}
function loopKind(kind: string): string {
  return kind === "comms_followup" ? "Follow-up"
    : kind === "internal_instruction" ? "Instruction"
    : kind === "callback" ? "Callback"
    : kind === "client_reply" ? "Reply owed"
    : "Follow-up";
}

// How many open loops render before the rest fold into "Show N more". The
// block's job is what needs a move TODAY (Jordan, Sep 2: "it's also too many
// things there") — the tail is one tap away in the same card, never dropped.
const LOOPS_SHOWN = 6;

/** Split the viewer's loops into: act now · not due yet · with someone else. */
function splitLoops(loops: OpsLoop[]): { act: OpsLoop[]; later: OpsLoop[]; elsewhere: OpsLoop[] } {
  const mine = loops.filter((l) => l.mine);
  return {
    act: mine.filter((l) => l.actNow),
    later: mine.filter((l) => !l.actNow),
    elsewhere: loops.filter((l) => !l.mine),
  };
}

// Listing QC only. Monthly personal-branding content runs on its own rhythm (a
// BATCH of videos on a 7-10 business-day window) and has its own card.
const listingQc = (d: OpsDay) => d.qc.filter((q) => !q.monthly);

// ---------------------------------------------------------------------------
// The off-page numbers, each one its destination's own query.
// ---------------------------------------------------------------------------

// The Tasks hub's "Other" tab, exactly as BoardView builds it for a non-editor
// (`boardWhere` in src/components/tasks/BoardView.tsx). Editors are redirected
// off this page, so there is no editor scope to mirror.
// TODO(cross-file): `boardWhere` belongs beside `boardVisibleWhere` in
// src/lib/triage.ts so this can be imported instead of restated. Until it is,
// any change there must be mirrored here or the rows start lying again.
const BOARD_ACTIVE = [
  "OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER",
  "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED",
];
function otherTabWhere(): Prisma.SmartTaskWhereInput {
  return {
    status: { in: BOARD_ACTIVE },
    AND: [
      boardVisibleWhere(),
      { OR: [{ projectId: null }, { project: recentProjectWhere() }, { taskType: { in: MESSAGE_TASK_TYPES } }] },
    ],
  };
}

// The Review Room's "Photo sets in QC" list, exactly as getReviewQueue reads it
// (src/lib/reviewRoom.ts): open media_qa cards on a job that isn't cancelled or
// on hold. It is NOT a row in "What needs you today" — the QC blocks below
// render the same pile bucketed (overdue / due today / not due yet / monthly),
// and a seventh QC number on the same screen would be one too many. It lives on
// the QC block as the door into the Review Room, which is the one list that
// also holds orphan cards (a QC task whose project row is gone).
function photoQcWhere(): Prisma.SmartTaskWhereInput {
  return {
    taskType: "media_qa",
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    OR: [{ projectId: null }, { project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } } }],
  };
}

async function offPageNumbers() {
  const [board, qc, textsToSend, emailsWaiting] = await Promise.all([
    // The Other tab's rows themselves (a dozen or so) — "running late" and
    // "to assign" are then counted off that set with the tab's OWN arithmetic,
    // so a row can never disagree with the header it lands on.
    prisma.smartTask.findMany({
      where: otherTabWhere(),
      select: { assignedKey: true, taskType: true, dueAt: true },
    }),
    prisma.smartTask.count({ where: photoQcWhere() }),
    // The comms Outbox lists exactly clientTextWhere() (ClientTextsPanel), and
    // its tab badge is this same count.
    prisma.smartTask.count({ where: clientTextWhere() }),
    // The Comms tab's Email sub-tab renders one card per sender-group; its own
    // "Email N" pill is this number.
    unansweredCommsBoard("email").then((g) => g.length).catch(() => 0),
  ]);
  // BoardView's overdue rule verbatim: due before the START of today in ET, so
  // something due later today is not "late".
  const startToday = etDayStartUtc(new Date()).getTime();
  return {
    boardOpen: board.length,
    late: board.filter((t) => t.dueAt !== null && t.dueAt.getTime() < startToday).length,
    toAssign: board.filter(isNeedsAssigning).length,
    qc,
    textsToSend,
    emailsWaiting,
  };
}

// ---------------------------------------------------------------------------
// The operating day — Jordan's "Daily Operations & Client Experience Structure"
// as time blocks with live contents. Lifted here from /ops unchanged except for
// the Morning Control Tower, whose shoot cards now live in their own section
// below (they were the one thing this page would otherwise render twice).
// ---------------------------------------------------------------------------

type BlockDef = { key: string; from: number; to: number; time: string; title: string; short: string; icon: LucideIcon; goal: string };
const BLOCKS: BlockDef[] = [
  { key: "tower", from: 9 * 60, to: 9 * 60 + 30, time: "9:00 – 9:30", title: "Morning Control Tower", short: "Tower", icon: Sunrise, goal: "Know what's happening today, what needs attention, and what could go wrong — before the day gets moving." },
  { key: "qc-am", from: 9 * 60 + 30, to: 10 * 60 + 15, time: "9:30 – 10:15", title: "QC + Morning Deliveries", short: "QC", icon: ClipboardCheck, goal: "Catch mistakes before the client does; get finished work delivered early. Only what's due today lives here — the backlog has its own card." },
  { key: "overdue", from: 10 * 60 + 15, to: 10 * 60 + 30, time: "10:15 – 10:30", title: "Overdue Check", short: "Overdue", icon: AlarmClock, goal: "Everything past its promised date gets a decision today: chase it, close it, or tell the client. Nothing sits late in silence." },
  { key: "comms-1", from: 10 * 60 + 30, to: 11 * 60, time: "10:30 – 11:00", title: "Client Communication Sweep #1", short: "Comms 1", icon: MessageSquare, goal: "Nobody waits wondering if we got their message." },
  { key: "prep", from: 11 * 60, to: 11 * 60 + 30, time: "11:00 – 11:30", title: "Tomorrow + Upcoming Prep", short: "Tomorrow", icon: Route, goal: "Tomorrow is operationally ready before today ends — problems get solved the day before, not 30 minutes before the shoot." },
  { key: "loops", from: 11 * 60 + 30, to: 12 * 60, time: "11:30 – 12:00", title: "Open Loops + Follow-Ups", short: "Loops", icon: RefreshCw, goal: "Nothing stays stuck because someone forgot to follow up. Ask: what am I waiting on that could become a problem?" },
  { key: "lunch", from: 12 * 60, to: 13 * 60, time: "12:00 – 1:00", title: "Lunch", short: "Lunch", icon: Coffee, goal: "Protected — unless there's a genuine operational or client emergency." },
  // Video Review (Jordan, Sep 1): "a card for videos in revision and videos
  // waiting on review." Every uploaded cut gets a verdict here; the pipeline
  // check moves to 1:30 so nothing overlaps.
  { key: "video-review", from: 13 * 60, to: 13 * 60 + 30, time: "1:00 – 1:30", title: "Video Review", short: "Video", icon: PlayCircle, goal: "Every cut the editors uploaded gets a verdict today — approve it, or send it back with notes. Cuts in revisions stay listed until the next version lands." },
  { key: "pipeline", from: 13 * 60 + 30, to: 14 * 60, time: "1:30 – 2:00", title: "Production Pipeline Check", short: "Pipeline", icon: ListChecks, goal: "Know what's due today, what's holding each job up, and what's coming — before the client asks." },
  { key: "comms-2", from: 14 * 60, to: 14 * 60 + 30, time: "2:00 – 2:30", title: "Client Communication Sweep #2", short: "Comms 2", icon: MessageSquare, goal: "Proactive, not reactive — if something changed, the client hears it from us first." },
  { key: "systems", from: 14 * 60 + 30, to: 15 * 60 + 10, time: "2:30 – 3:10", title: "Systems + Admin Work", short: "Admin", icon: Wrench, goal: "Keep the backend organized — without letting admin work interfere with active client needs." },
  { key: "monthly", from: 15 * 60 + 10, to: 15 * 60 + 30, time: "3:10 – 3:30", title: "Monthly Content Check", short: "Monthly", icon: Clapperboard, goal: "Personal-branding retainers run on their own rhythm — a batch of videos on a 7–10 business-day window, delivered as a set. Never mixed into listing QC." },
  // "Final QC + Deliveries" (4:15-5:00) was dropped Sep 1 — Jordan: it duplicated
  // the morning QC + Deliveries block and the Production Pipeline Check. Its
  // slot folds into Next-Day Finalization so the timeline has no dead gap
  // (currentKey falls back to the LAST block inside a gap, which would have
  // lit up Daily Closeout at 4:15).
  { key: "final-prep", from: 15 * 60 + 30, to: 17 * 60, time: "3:30 – 5:00", title: "Next-Day Finalization", short: "Finalize", icon: Route, goal: "By the end of this block, tomorrow is locked in and ready to go." },
  { key: "comms-3", from: 17 * 60, to: 17 * 60 + 30, time: "5:00 – 5:30", title: "Client Communication Sweep #3", short: "Comms 3", icon: MessageSquare, goal: "Don't carry simple client questions into the next business day." },
  { key: "closeout", from: 17 * 60 + 30, to: 18 * 60, time: "5:30 – 6:00", title: "Daily Closeout", short: "Closeout", icon: Moon, goal: "Review the whole operation before ending the day — escalate anything that needs Jordan." },
];

/** The closeout checklist, computed once so the badge and the rows agree. */
function closeoutRows(d: OpsDay): { ok: boolean; label: string }[] {
  const c = d.closeout;
  return [
    { ok: c.todayShootsDone, label: c.todayShootsDone ? "Today's shoots all happened" : "Some of today's shoots haven't happened yet" },
    { ok: c.todayDebriefsMissing === 0, label: c.todayDebriefsMissing === 0 ? "Every shot job's upload page is submitted" : `${c.todayDebriefsMissing} upload page${c.todayDebriefsMissing === 1 ? "" : "s"} still not submitted (10 PM text will chase)` },
    { ok: c.unanswered === 0, label: c.unanswered === 0 ? "No unanswered client messages" : `${c.unanswered} client message${c.unanswered === 1 ? "" : "s"} still waiting` },
    { ok: c.openQc === 0, label: c.openQc === 0 ? "QC queue is clear" : `${c.openQc} QC card${c.openQc === 1 ? "" : "s"} still open` },
    { ok: c.tomorrowGaps === 0, label: c.tomorrowGaps === 0 ? "Tomorrow is locked in" : `Tomorrow has ${c.tomorrowGaps} gap${c.tomorrowGaps === 1 ? "" : "s"} to close` },
    { ok: c.openRevisions === 0, label: c.openRevisions === 0 ? "No revisions outstanding" : `${c.openRevisions} revision${c.openRevisions === 1 ? "" : "s"} in flight — confirm they're assigned` },
  ];
}

// "120+" when a capped list is full — never present a truncated count as exact.
const plusFor = (key: string, d: OpsDay) => (key === "loops" && d.openLoopsTally.capped ? "+" : "");

// ---- Same-day rush (Jordan, Sep 2: "notify the morning tower about shoots
// with same-day delivery photos or floor plans") ------------------------------
// The flag is decided ONCE, in opsDay.ts (OpsShoot.sameDay, off the order's
// line items, dated by the SLA engine). Everything here is the length of the
// list it points at, per this page's number rule — the chip on the Tower is
// the count of flagged cards in "Today's shoots", and nothing else.
const rushShoots = (shoots: OpsShoot[]) => shoots.filter((s) => s.sameDay);
/** "photos + floor plan" — the same words on the card, the chip and the tower row. */
const rushWhat = (s: OpsShoot) =>
  [s.sameDay?.photos ? "photos" : null, s.sameDay?.floorPlan ? "floor plan" : null].filter(Boolean).join(" + ");
/** Which blocks carry a rush count beside their badge: the Tower (today's
 *  cards) and the two tomorrow-prep blocks (tomorrow's), so the day before is
 *  warned as loudly as the morning of. */
function rushFor(key: string, d: OpsDay): number {
  switch (key) {
    case "tower": return rushShoots(d.todayShoots).length;
    case "prep": case "final-prep": return rushShoots(d.tomorrowShoots).length;
    default: return 0;
  }
}
/** The red "⚡ N same-day" chip — one component so the header, the jump bar
 *  and the shoots section can never phrase it three ways. */
function RushChip({ n, small, onBrand }: { n: number; small?: boolean; onBrand?: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full font-bold tabular-nums",
        small ? "px-1.5 text-[10px]" : "px-2.5 py-0.5 text-xs",
        onBrand ? "bg-white text-danger" : "bg-danger text-white",
      )}
      title={`${n} shoot${n === 1 ? "" : "s"} promised same-day delivery — photos or floor plan due by end of business`}
    >
      <Zap className={small ? "size-2.5" : "size-3"} /> {n} same-day
    </span>
  );
}

// What each block has waiting — the number on its header and jump-bar chip.
// null = the block is guidance, not a list (lunch, admin).
function countFor(key: string, d: OpsDay, board: { today: unknown[] }): number | null {
  switch (key) {
    // The Tower's shoots render in their own section now, so its badge is the
    // one number the block itself is about: today's shoot count.
    case "tower": return d.todayShoots.length;
    case "qc-am": return listingQc(d).filter((q) => q.bucket === "today").length;
    case "overdue": return listingQc(d).filter((q) => q.bucket === "overdue").length;
    case "comms-1": case "comms-2": case "comms-3": return d.unanswered.count;
    case "prep": case "final-prep": return d.tomorrowShoots.length;
    // The badge counts what the block RENDERS by default: this viewer's loops
    // that are overdue or promised today. The rest are stated and reachable in
    // the block itself, so the number never points at a list that hides rows.
    case "loops": return d.openLoopsTally.actNow;
    case "video-review": return d.videoReview.waiting.length + d.videoReview.revising.length;
    // The Tracker's own "Due today" tab, which is the tab this block opens on.
    case "pipeline": return board.today.length;
    case "monthly": return d.qc.filter((q) => q.monthly).length;
    // Not a queue — the number of closeout checks that are NOT yet green. It
    // makes the block open itself the moment something is off, instead of
    // waiting for 5:30 PM.
    case "closeout": return closeoutRows(d).filter((r) => !r.ok).length;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// What needs you today — the top of the page, and the only thing on it that
// claims to be a to-do list. Rows are built from the SAME arrays the sections
// below render, so a row can never point at an empty list.
// ---------------------------------------------------------------------------

type NeedGroup = "decide" | "waiting" | "risk";
type Need = {
  key: string;
  group: NeedGroup;
  count: number;
  label: string;
  detail?: string;
  href: string;
  tone: "brand" | "danger" | "warning" | "muted";
};

const GROUP_LABEL: Record<NeedGroup, string> = {
  decide: "Decisions only you can make",
  waiting: "People waiting on us",
  risk: "At risk today",
};

function NeedsToday({ needs }: { needs: Need[] }) {
  const groups: NeedGroup[] = ["decide", "waiting", "risk"];
  return (
    <section id="needs-you" className="panel-shadow scroll-mt-32 rounded-2xl border border-border bg-surface md:scroll-mt-28">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white">
          <AlertTriangle className="size-4" />
        </span>
        <h2 className="text-[15px] font-semibold">What needs you today</h2>
        <span className="ml-auto rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold tabular-nums">
          {needs.length}
        </span>
      </div>
      <div className="divide-y divide-border/60">
        {groups.map((g) => {
          const rows = needs.filter((n) => n.group === g);
          if (rows.length === 0) return null;
          return (
            <div key={g} className="px-5 py-3">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-2">{GROUP_LABEL[g]}</h3>
              <div className="mt-1.5 space-y-1">
                {rows.map((n) => <NeedRow key={n.key} n={n} />)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function NeedRow({ n }: { n: Need }) {
  const tone =
    n.tone === "danger" ? "text-danger" : n.tone === "warning" ? "text-warning" : n.tone === "brand" ? "text-brand" : "text-foreground";
  return (
    <Link
      href={n.href}
      className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2/70"
    >
      <span className={cn("w-8 shrink-0 text-right text-lg font-semibold tabular-nums", tone)}>{n.count}</span>
      <span className="min-w-0 flex-1">
        <span className="text-sm font-medium leading-snug">{n.label}</span>
        {n.detail && <span className="block text-[11px] text-muted">{n.detail}</span>}
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-muted-2" />
    </Link>
  );
}

// ---------------------------------------------------------------------------

export default async function HomePage() {
  const me = await getCurrentUser().catch(() => null);
  // Creatives never see the ops overview (middleware already bounces the roles;
  // this covers per-user "dashboard" permission overrides). Sessionless local
  // dev renders the full owner view.
  if (me && contentTier(me.role) === "CREATIVE") redirect(homeFor(me.role));
  // A revoked account keeps a valid JWT for up to 7 days, and "/" has no PAGES
  // entry so middleware only checks that the token verifies — fail closed here
  // rather than letting a null viewer read as owner (Sep 2 review).
  if (!me && authEnforced()) redirect("/login");
  const isOwner = !me || me.role === "OWNER";

  const [d, counts, stuck, shoots, radar, handledToday, board, flagged, ownerStats, pulse, dials, money, todos, newClients] =
    await Promise.all([
      // The operating day: shoots, QC, loops, comms, pipeline, video review,
      // closeout. It already resolves the viewer's own loop lane, so this page
      // no longer calls openLoopsList() a second time.
      buildOpsDay(),
      offPageNumbers(),
      getStuckJobs(),
      getShootWindow(), // only for the week-ahead strip; today's shoots come from buildOpsDay
      getProactiveFlags(),
      getHandledToday(),
      // The Project Tracker's delivery board, merged into the Pipeline block.
      deliveryBoard().catch((): DeliveryBoard => ({ today: [], tomorrow: [], upcoming: [], delivered: [], overdueCount: 0 })),
      // WHO the flags are for: the viewer's own assignee key, resolved the way
      // openLoopsList resolves it (roster match by TeamMember → email → first
      // name, else the first-name slug). It used to be the literal "kyle" for
      // every ADMIN, so a flag Jordan raised for Kyle would have opened on
      // James's home as "for immediate review" (audit5 F11). An editor's
      // explicit editorKey still wins when there is one.
      listAssignees().catch(() => []).then((roster) =>
        getFlaggedForMe({
          assignedKey: me ? me.editorKey ?? viewerAssigneeKey(me, roster) ?? (me.name ? slugForName(me.name) : null) : null,
          memberId: me?.teamMemberId ?? null,
          role: me?.role ?? "OWNER",
        }),
      ),
      isOwner ? getOwnerStats() : Promise.resolve(null),
      isOwner ? getOwnerPulse() : Promise.resolve(null),
      // Owner-only quality dials (video-SLA roll-up + QC health) — same gate.
      isOwner ? getOwnerDials() : Promise.resolve(null),
      // My Day's money glance (bank / profit / owed). Every figure in it is a
      // cheap indexed read by contract — see the header of ownerPulse.ts.
      isOwner ? ownerPulse().catch(() => null) : Promise.resolve(null),
      // My Day's personal list. Owner-only: it is one person's private list,
      // exactly as /day was ownerOnly in PAGES.
      isOwner ? ownerTodoLists().catch(() => null) : Promise.resolve(null),
      // Clients the Aryeo webhook met in the last 10 days — for Jordan AND Kyle.
      newClientsForDashboard().catch(() => []),
    ]);

  const now = new Date(d.nowISO);
  const nowMin = etMinutes(now);
  // Radar minus money. getProactiveFlags' AR branch composes "X owes $Y" with
  // a /billing link an ADMIN can't open, and the panel sat outside the isOwner
  // gate. Jordan's rule (access.ts): "Kyle should not have access to any money
  // related info" — so the AR kind never reaches a non-owner (audit5 F9).
  const radarFlags = radar.flags.filter((f) => isOwner || f.kind !== "ar");
  const currentKey =
    BLOCKS.find((b) => nowMin >= b.from && nowMin < b.to)?.key ??
    (nowMin < BLOCKS[0].from ? BLOCKS[0].key : BLOCKS[BLOCKS.length - 1].key);

  const qcOverdue = listingQc(d).filter((q) => q.bucket === "overdue").length;
  const qcToday = listingQc(d).filter((q) => q.bucket === "today").length;
  const loops = tallyLoops(d.openLoops);
  const firstName = me?.name?.split(" ")[0] ?? (isOwner ? "Jordan" : "there");
  const todayKey = etDayKey(now);

  // ---- What needs you today -------------------------------------------------
  // Every row's count is the length of the list it opens. Rows only exist while
  // their pile does, so an empty day produces an empty array and the calm card.
  const needs: Need[] = [];
  const add = (n: Need) => { if (n.count > 0) needs.push(n); };

  add({
    key: "cuts", group: "decide", count: d.videoReview.waiting.length,
    label: `cut${d.videoReview.waiting.length === 1 ? "" : "s"} waiting on your verdict`,
    detail: d.videoReview.waiting[0] ? `oldest: ${d.videoReview.waiting[0].street} · ${ageText(d.videoReview.waiting[0].sinceISO, now)}` : undefined,
    href: "#video-review", tone: "brand",
  });
  if (isOwner && todos) {
    add({
      key: "mytodos", group: "decide", count: todos.overdue.length,
      label: `of your own to-dos ${todos.overdue.length === 1 ? "is" : "are"} past their date`,
      href: "#my-list", tone: "danger",
    });
  }
  add({
    key: "clients", group: "waiting", count: d.unanswered.count,
    label: `client${d.unanswered.count === 1 ? "" : "s"} waiting on a reply`,
    detail: d.unanswered.oldestHours != null
      ? d.unanswered.oldestHours >= 24
        ? `oldest has waited ${Math.round(d.unanswered.oldestHours / 24)} day${Math.round(d.unanswered.oldestHours / 24) === 1 ? "" : "s"}`
        : `oldest has waited ${d.unanswered.oldestHours}h`
      : undefined,
    href: "#comms-1", tone: d.unanswered.oldestHours != null && d.unanswered.oldestHours >= 24 ? "danger" : "brand",
  });
  add({
    key: "texts", group: "waiting", count: counts.textsToSend,
    label: `client text${counts.textsToSend === 1 ? "" : "s"} drafted and ready to send`,
    href: "/communications?tab=outbox", tone: "brand",
  });
  add({
    key: "emails", group: "waiting", count: counts.emailsWaiting,
    label: `email sender${counts.emailsWaiting === 1 ? "" : "s"} on the board with no answer`,
    href: "/tasks?tab=comms&via=email", tone: "muted",
  });
  add({
    key: "past-due", group: "risk", count: board.overdueCount,
    label: `job${board.overdueCount === 1 ? "" : "s"} past their promised date`,
    detail: "at the top of the tracker's Due-today tab",
    href: "#pipeline", tone: "danger",
  });
  add({
    key: "qc-overdue", group: "risk", count: qcOverdue,
    label: `QC card${qcOverdue === 1 ? "" : "s"} past due`,
    href: "#overdue", tone: "danger",
  });
  add({
    key: "stuck", group: "risk", count: stuck.length,
    label: `job${stuck.length === 1 ? "" : "s"} stuck in production`,
    // Says why this is a different pile from "past their promised date" above:
    // that one is the delivery clock, this one is the job not moving at all.
    detail: "late vs promise, a revision going stale, or shot but never delivered",
    href: "#stuck", tone: "danger",
  });
  add({
    key: "loops", group: "risk", count: loops.actNow,
    label: `follow-up${loops.actNow === 1 ? "" : "s"} owed today`,
    detail: loops.elsewhere > 0 ? `${loops.elsewhere} more sit with someone else` : undefined,
    href: "#loops", tone: "warning",
  });
  add({
    key: "qc-today", group: "risk", count: qcToday,
    label: `QC card${qcToday === 1 ? "" : "s"} due today`,
    href: "#qc-am", tone: "warning",
  });
  add({
    key: "debriefs", group: "risk", count: d.closeout.todayDebriefsMissing,
    label: `shot job${d.closeout.todayDebriefsMissing === 1 ? "" : "s"} with no upload page submitted`,
    href: "#shoots", tone: "warning",
  });
  add({
    key: "tomorrow", group: "risk", count: d.closeout.tomorrowGaps,
    label: `gap${d.closeout.tomorrowGaps === 1 ? "" : "s"} on tomorrow's shoots`,
    detail: "no street address, unassigned, or no access notes on file",
    href: "#prep", tone: "warning",
  });
  add({
    key: "late", group: "risk", count: counts.late,
    label: `task${counts.late === 1 ? "" : "s"} running late on the board`,
    href: "/tasks?tab=other", tone: "warning",
  });
  add({
    key: "assign", group: "risk", count: counts.toAssign,
    label: `to-do${counts.toAssign === 1 ? "" : "s"} with nobody's name on ${counts.toAssign === 1 ? "it" : "them"}`,
    href: "/tasks?tab=other&who=needs-assigning", tone: "muted",
  });

  const nextShoot = shoots.week[0] ?? null;

  // Flags a PERSON raised for this viewer — above everything, in both orders.
  const flaggedSection = flagged.length > 0 ? (
    <section className="panel-shadow overflow-hidden rounded-2xl border-2 border-danger/45 bg-danger-soft/40">
      <div className="flex items-center gap-2 border-b border-danger/25 px-5 py-2.5">
        <Flag className="size-4 text-danger" />
        <h2 className="text-[15px] font-semibold text-danger">
          Flagged by {[...new Set(flagged.map((f) => f.flaggedBy.split(" ")[0]))].join(" & ")} — for immediate review
        </h2>
        <span className="ml-auto rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-danger">{flagged.length}</span>
      </div>
      <ul className="divide-y divide-danger/15">
        {flagged.map((f) => (
          <li key={f.taskId}>
            <Link href={f.href} className="block px-5 py-3 hover:bg-danger/[0.06]">
              <p className="text-sm font-semibold leading-snug">{f.title}</p>
              {f.note && <p className="mt-0.5 whitespace-pre-line text-[13px] leading-relaxed text-foreground/80">{f.note}</p>}
              <p className="mt-1 text-[11px] text-muted">
                {f.flaggedBy} · {etDateTime(f.flaggedAtISO)}
                {f.projectTitle ? ` · ${f.projectTitle}` : ""} — open it
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  ) : null;

  // ---- THE SECTIONS, declared once and ORDERED BY WHOSE DAY IT IS ----------
  // Jordan reads decisions first; Kyle's whole job starts at the tower. Same
  // sections, same numbers — only the order changes (Jordan, Sep 7).
  const needsSection = (
    <>
          {/* 2 · WHAT NEEDS YOU TODAY — decisions and blockers, above everything */}
          {needs.length === 0 ? (
            <div className="panel-shadow rounded-2xl border border-border bg-surface p-6 text-center">
              <CheckCircle2 className="mx-auto size-8 text-success" />
              <p className="mt-2 text-sm font-semibold">Nothing needs you — {handledToday} handled today.</p>
              <p className="mt-1 text-xs text-muted">
                Next shoot: {nextShoot ? `${etDate(nextShoot.shootDate)} ${etTime(nextShoot.shootDate)} — ${nextShoot.title.split(",")[0]} · ${nextShoot.photographer?.name ?? "unassigned"}` : "none scheduled"}
              </p>
            </div>
          ) : (
            <NeedsToday needs={needs} />
          )}
    </>
  );
  const buttonSection = (
    <>
          {/* THE button — the page's single primary action, and just a door. It
              carries no total: the Tasks hub's tabs share rows (a Slack to-do
              with no owner is on BOTH the Slack tab and the Other tab's "Needs
              assigning" pile), so any sum would count real work twice. */}
          <Link
            href="/tasks"
            className="flex w-full items-center justify-between rounded-2xl bg-brand px-5 py-4 text-white shadow-lg transition-opacity hover:opacity-90"
          >
            <span className="text-base font-semibold">Start your day</span>
            <span className="flex items-center gap-2 text-sm font-medium opacity-90">
              Your tasks <ArrowRight className="size-4" />
            </span>
          </Link>
    </>
  );
  const stuckSection = (
    <>
          {/* Stuck jobs — PROJECT-level fires (late vs promise, stale revision,
              shot-but-undelivered), not overdue admin tasks. Anchored so the
              "stuck in production" row above lands on it. */}
          {stuck.length > 0 && (
            <div id="stuck" className="scroll-mt-32 md:scroll-mt-28">
              <StuckJobs jobs={stuck} />
            </div>
          )}
    </>
  );
  const daySection = (
    <>
          {/* 3 · YOUR DAY — the time blocks. Blocks with something waiting (and
              the block you're in right now) render open; the rest are one tap.
              Nothing is hidden: every block header carries its own count, and a
              zero says "clear" rather than disappearing. */}
          <div className="pt-1">
            <h2 className="px-1 text-[11px] font-bold uppercase tracking-widest text-muted-2">Your day</h2>
            {/* Jump bar — the day at a glance, with what's waiting in each block.
                (Not sticky: the page header already is, and two sticky bars fought
                for the same 60px.) */}
            <nav className="-mx-4 mt-1.5 flex gap-1.5 overflow-x-auto px-4 py-1 sm:-mx-6 sm:flex-wrap sm:px-6 [&::-webkit-scrollbar]:hidden" aria-label="Blocks">
              {BLOCKS.map((b) => {
                const n = countFor(b.key, d, board);
                const cur = b.key === currentKey;
                return (
                  <a
                    key={b.key}
                    href={`#${b.key}`}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                      cur ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:bg-surface-2 hover:text-foreground",
                    )}
                  >
                    <span className="tabular-nums opacity-70">{b.time.split(" – ")[0]}</span>
                    {b.short}
                    {n != null && n > 0 && (
                      <span className={cn("rounded-full px-1.5 text-[10px] font-semibold tabular-nums", cur ? "bg-white/20" : "bg-surface-2 text-foreground")}>{n}{plusFor(b.key, d)}</span>
                    )}
                    <RushChip n={rushFor(b.key, d)} small onBrand={cur} />
                  </a>
                );
              })}
            </nav>
            <div className="mt-2 space-y-2.5">
              {BLOCKS.map((b) => (
                <Block key={b.key} def={b} current={b.key === currentKey} d={d} board={board} counts={counts} needsBelow={!isOwner} />
              ))}
            </div>
          </div>
    </>
  );
  const shootsSection = (
    <>
          {/* 4 · TODAY'S SHOOTS — the day's hard commitments, in full: access,
              door code, weather, airspace, the last thing the client said. This
              is the Morning Control Tower's list, hoisted out of the block so the
              page renders it exactly once. */}
          <section id="shoots" className="panel-shadow scroll-mt-32 rounded-2xl border border-border bg-surface md:scroll-mt-28">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted">
              <Camera className="size-3.5" /> Today&apos;s shoots
              <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-[10px] font-medium tabular-nums">{d.todayShoots.length}</span>
              <RushChip n={rushShoots(d.todayShoots).length} small />
            </div>
            <div className="px-4 py-3.5">
              <ShootList shoots={d.todayShoots} empty="No shoots on today's calendar." showDebrief />
            </div>
            <WeekStrip week={shoots.week} />
          </section>
    </>
  );

  return (
    <div>
      {/* Kyle keeps this open all day; 90s rather than Ops Day's 45s because the
          merged page does the work of four screens on every refresh. */}
      <AutoRefresh seconds={90} />
      <PageHeader
        eyebrow="Eastern time"
        title="Home"
        subtitle={`${etFullDate(now)} · nothing surprises the client · nothing gets missed`}
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
        {/* 1 · Orientation */}
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand/15 text-brand"><Sun className="size-5" /></span>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Good morning, {firstName}</h2>
            <p className="text-xs text-muted">{handledToday} thing{handledToday === 1 ? "" : "s"} handled today</p>
          </div>
        </div>

        {flaggedSection}
        {isOwner ? (
          <>
            {needsSection}
            {buttonSection}
            {stuckSection}
            {daySection}
            {shootsSection}
          </>
        ) : (
          <>
            {/* KYLE'S ORDER — the tower first: today's shoots, then the guided
                blocks, and only then the decisions list and his task door. */}
            {shootsSection}
            {daySection}
            {needsSection}
            {buttonSection}
            {stuckSection}
          </>
        )}
        {/* 5 · YOUR LIST — My Day's personal to-dos, merged in. Owner-only: it
            is one person's private list (the /day page was ownerOnly), and an
            admin's home ends before it. Capture, plan, close and undo all still
            ride the /day server actions — nothing about the data moved. */}
        {isOwner && todos && (
          <section id="my-list" className="panel-shadow scroll-mt-32 rounded-2xl border border-border bg-surface md:scroll-mt-28">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted">
              <Inbox className="size-3.5" /> Your list
              <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-[10px] font-medium tabular-nums">{todos.open.length}</span>
            </div>
            <div className="space-y-3 px-4 py-3.5">
              <QuickAdd />
              {todos.overdue.length > 0 && (
                <div className="rounded-xl border border-danger/40 bg-danger/[0.04]">
                  <p className="border-b border-danger/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-danger">
                    Past their date · {todos.overdue.length}
                  </p>
                  <div className="divide-y divide-border/60">
                    {todos.overdue.map((t) => <TodoRow key={t.id} t={t} todayKey={todayKey} overdue />)}
                  </div>
                </div>
              )}
              {todos.today.length > 0 && (
                <div className="rounded-xl border border-border">
                  <p className="border-b border-border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-2">
                    Planned for today · {todos.today.length}
                  </p>
                  <div className="divide-y divide-border/60">
                    {todos.today.map((t) => <TodoRow key={t.id} t={t} todayKey={todayKey} />)}
                  </div>
                </div>
              )}
              {todos.unscheduled.length > 0 && (
                <div className="rounded-xl border border-border">
                  <p className="border-b border-border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-2">
                    Not scheduled yet · {todos.unscheduled.length}
                  </p>
                  <div className="divide-y divide-border/60">
                    {/* Twenty, exactly as /day rendered them, with the rest
                        stated below rather than silently dropped. */}
                    {todos.unscheduled.slice(0, 20).map((t) => <TodoRow key={t.id} t={t} todayKey={todayKey} />)}
                  </div>
                  {todos.unscheduled.length > 20 && (
                    <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-2">
                      {todos.unscheduled.length - 20} more captured — plan a few onto a day to bring them up.
                    </p>
                  )}
                </div>
              )}
              {todos.open.length === 0 && (
                <p className="py-2 text-center text-sm text-muted">Nothing on your list. Capture something above.</p>
              )}
              <FinishedList rows={todos.finished} />
            </div>
          </section>
        )}

        {/* 6 · Radar — fresh risk only (≤3; creatives never reach this page) */}
        {/* New clients — say hello. Renders nothing when there are none. */}
        <NewClientCard clients={newClients} />
        {radarFlags.length > 0 && <ProactiveFlags flags={radarFlags} />}

        {/* 7 · MONEY — owner only, and last on purpose. Jordan: money after
            action. The strip merges the old dashboard line (delivered, pipeline,
            top AR) with My Day's glance (bank, profit, owed), so there is one
            money answer on this page instead of two. */}
        {isOwner && ownerStats && (
          <section className="panel-shadow rounded-2xl border border-border bg-surface">
            <Link href="/sales" className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border px-5 py-3.5 text-sm hover:bg-surface-2/60">
              <span><span className="text-muted">Delivered this month</span> <b>{formatMoney(ownerStats.revenueThisMonth)}</b> <span className="text-muted-2">({ownerStats.deliveredThisMonth})</span></span>
              <span><span className="text-muted">Pipeline</span> <b>{formatMoney(ownerStats.pipelineRevenue)}</b> <span className="text-muted-2">({ownerStats.activeCount} active)</span></span>
              {radar.topAr && <span><span className="text-muted">Top AR</span> <b>{radar.topAr.name} {formatMoney(radar.topAr.total)}</b></span>}
              <ArrowRight className="ml-auto size-4 text-muted-2" />
            </Link>
            {money && (
              <div className="px-5 py-4">
                {/* TWO CLOCKS, SAID OUT LOUD. The line above is the delivery
                    ledger — jobs delivered this month × what they were sold
                    for. These four are the BOOKS — money that actually landed
                    through a processor, minus categorised spend. They are
                    different numbers for the same month on purpose, and a
                    reader who isn't told that reads one of them as wrong. */}
                <p className="text-[11px] text-muted-2">
                  From the books — money that landed, not jobs delivered.{" "}
                  <Link href="/sales" className="hover:text-foreground">Finance →</Link>
                </p>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <MoneyStat label="Profit this month" value={usd0(money.profitMonth)} sub={money.marginPct != null ? `${Math.round(money.marginPct)}% margin · provisional` : "provisional"} tone={money.profitMonth >= 0 ? "good" : "bad"} />
                  <MoneyStat label="In the bank" value={money.bankBalance == null ? "—" : usd0(money.bankBalance)} sub={money.bankLabel ?? "not connected"} tone={money.bankBalance != null && money.bankBalance < 0 ? "bad" : undefined} />
                  <MoneyStat label="Owed to you" value={usd0(money.owedToYou)} sub={`${money.owedCount} unpaid`} tone={money.owedToYou > 0 ? "bad" : undefined} />
                  <MoneyStat label="Money in this year" value={usd0(money.revenueYtd)} sub={`through ${money.monthLabel}`} />
                </div>
              </div>
            )}
          </section>
        )}

        {/* 8 · Owner pulse — health trends (30d vs prior 30d). */}
        {isOwner && pulse && <PulseStrip pulse={pulse} />}

        {/* 9 · Quality dials — a compact video-SLA roll-up (links to the Editor
            Queue; NOT a re-list of the stuck jobs above) + the QC quality dial.
            Self-hides when there's no video in flight AND no QC history yet. */}
        {isOwner && dials && <QualityDials dials={dials} />}

        {/* How the day is meant to run — the standing rules, not a queue. */}
        <section className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold">Priority order — the inbox is not the task list</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            1. Active client issue happening right now · 2. Today&rsquo;s shoot · 3. Today&rsquo;s delivery ·
            4. Tomorrow&rsquo;s shoot · 5. Overdue project or revision · 6. Client communication ·
            7. Production follow-up · 8. Routine admin · 9. Long-term internal projects
          </p>
          <h2 className="mt-4 text-sm font-semibold">Escalate exceptions, not routine</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Jordan doesn&rsquo;t need &ldquo;a project was delivered.&rdquo; Bring him in when: a client is seriously unhappy,
            wants something outside scope or against policy, an important relationship is at risk, a major
            production mistake happened, tomorrow can&rsquo;t be staffed, or the decision is above your authority.
            Everything else — handle it.
          </p>
        </section>

        {/* Quiet secondary links — everything else lives in the sidebar. */}
        <div className="flex flex-wrap items-center gap-4 px-1 text-xs text-muted-2">
          <Link href="/tasks" className="hover:text-foreground">All tasks</Link>
          <Link href="/review" className="hover:text-foreground">Review Room</Link>
          <Link href="/schedule" className="hover:text-foreground">Schedule</Link>
        </div>
      </div>
    </div>
  );
}

// "-$1,995", never "$-1,995" — an overdrawn balance is the one figure on this
// page a person reads at a glance and must not have to parse.
const usd0 = (n: number) => {
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US")}`;
};

function MoneyStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</div>
      <div className={cn("mt-0.5 text-xl font-semibold tabular-nums", tone === "good" && "text-success", tone === "bad" && "text-danger")}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One time block. Open when you're in it, or when it has something waiting —
// otherwise collapsed to its header, which still carries the count. A block
// with nothing in it is not hidden, it is answered.
// ---------------------------------------------------------------------------

type OffPageCounts = Awaited<ReturnType<typeof offPageNumbers>>;

function Block({ def, current, d, board, counts, needsBelow }: {
  def: BlockDef; current: boolean; d: OpsDay; board: DeliveryBoard; counts: OffPageCounts;
  /** "What needs you" renders UNDER the blocks in Kyle's order (page order
   *  is by whose day it is) — the tower's jump link has to point that way. */
  needsBelow: boolean;
}) {
  const Icon = def.icon;
  const n = countFor(def.key, d, board);
  // A green "clear" must mean the block is empty. Open Loops counts what needs
  // a move TODAY, so with a tail still open it says what the tail actually is
  // instead — the rows are one tap away inside the card and must not look like
  // zero. (loopsZeroState also covers "14 open, none of them yours".)
  const loopZero = def.key === "loops" ? loopsZeroState(d.openLoops) : null;
  const zeroLabel = loopZero?.label ?? "clear";
  const zeroTitle = loopZero?.title ?? "Nothing waiting in this block";
  // scroll-mt clears the sticky PageHeader (~104px with a one-line subtitle,
  // ~124px when it wraps on a phone) so a jump never tucks the block's title
  // under the header.
  // Open when you're in this hour, or when the block has something in it. Open
  // Loops is the one block whose badge can read 0 with real work inside it (its
  // badge counts what's due TODAY, and on the owner's screen most loops sit
  // with Kyle), so it opens on the whole pile — its collapsed body is two lines
  // either way.
  const open = current || (n != null && n > 0) || (def.key === "loops" && d.openLoops.length > 0);
  return (
    <details
      id={def.key}
      open={open}
      className={cn(
        "panel-shadow group scroll-mt-32 rounded-2xl border bg-surface md:scroll-mt-28",
        current ? "border-brand/50 ring-1 ring-brand/30" : "border-border",
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", current ? "bg-brand text-white" : "bg-surface-2 text-muted")}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[15px] font-semibold">{def.title}</h3>
            {current && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand">Now</span>}
          </div>
          <p className="text-xs text-muted-2"><Clock className="mr-1 inline size-3 -translate-y-px" />{def.time}</p>
        </div>
        {n != null && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums",
              n > 0 ? "bg-surface-2 text-foreground" : zeroLabel === "clear" ? "bg-success/10 text-success" : "bg-surface-2 text-muted",
            )}
            title={n > 0 ? `${n} in this block` : zeroTitle}
          >
            {n > 0 ? `${n}${plusFor(def.key, d)}` : zeroLabel}
          </span>
        )}
        {/* Same-day rush beside the count, not inside it: the badge stays the
            shoot count (the list it links to), and the rush is its own red
            number so it cannot hide inside a "3". */}
        <RushChip n={rushFor(def.key, d)} />
        <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
      </summary>
      <div className="border-t border-border px-5 py-3.5">
        <p className="text-[13px] italic leading-relaxed text-muted">{def.goal}</p>
        <div className="mt-3">
          <BlockBody blockKey={def.key} d={d} board={board} counts={counts} needsBelow={needsBelow} />
        </div>
      </div>
    </details>
  );
}

function BlockBody({ blockKey, d, board, counts, needsBelow }: {
  blockKey: string; d: OpsDay; board: DeliveryBoard; counts: OffPageCounts; needsBelow: boolean;
}) {
  switch (blockKey) {
    case "tower":
      // The shoot cards live in "Today's shoots" below — rendering them here as
      // well would put the same list on one screen twice, which is the fault
      // this page's number rule exists to prevent. What stays is the tower's
      // real job: the day's opening numbers, each linked to its own list.
      return (
        <div className="space-y-3">
          <a href="#shoots" className="flex items-center gap-2 rounded-xl border border-border px-3.5 py-2.5 text-sm hover:bg-surface-2/60">
            <Camera className="size-4 shrink-0 text-muted-2" />
            <span className="min-w-0 flex-1">
              {d.todayShoots.length === 0 ? (
                "No shoots on today's calendar."
              ) : (
                <>
                  <span className="font-semibold">{d.todayShoots.length} shoot{d.todayShoots.length === 1 ? "" : "s"} today</span>
                  <span className="text-muted"> — {d.todayShoots.map((s) => `${s.timeISO ? fmtTime(s.timeISO) : "time TBD"} ${s.photographer ?? "unassigned"}`).join(" · ")}</span>
                </>
              )}
            </span>
            <ArrowRight className="size-3.5 shrink-0 text-muted-2" />
          </a>
          {/* Same-day rush — the one order detail that changes what today IS
              for the whole team: those photos / that floor plan ship before
              close of business, not tomorrow morning. Red, first, unmissable
              (Jordan, Sep 2). Each address links to its own card below. */}
          {rushShoots(d.todayShoots).length > 0 && (
            <a href="#shoots" className="flex items-start gap-2 rounded-xl border border-danger/50 bg-danger/10 px-3.5 py-2.5 text-sm hover:bg-danger/15">
              <Zap className="mt-0.5 size-4 shrink-0 text-danger" />
              <span className="min-w-0 flex-1">
                <span className="font-bold text-danger">
                  {rushShoots(d.todayShoots).length} same-day deliver{rushShoots(d.todayShoots).length === 1 ? "y" : "ies"} today
                </span>
                <span className="text-foreground/80">
                  {" — "}
                  {rushShoots(d.todayShoots)
                    .map((s) => `${s.title} (${rushWhat(s)}${s.sameDay?.dueISO ? `, by ${fmtTime(s.sameDay.dueISO)}` : ""})`)
                    .join(" · ")}
                </span>
              </span>
              <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-danger" />
            </a>
          )}
          {/* The tower used to carry five pills: unanswered clients, overdue
              tasks, due today, open revisions, need assigning. Four of them are
              now rows in "What needs you today" — and two were computed with a
              DIFFERENT predicate than the row above them while pointing at the
              SAME tab (11 overdue here vs 7 running late there, both landing on
              /tasks?tab=other). One page, one number. What's left is the two
              figures nothing else on this screen states. */}
          <div className="flex flex-wrap gap-2 text-[13px]">
            <Pill warn={d.pipeline.revision > 0} label={`${d.pipeline.revision} open revision${d.pipeline.revision === 1 ? "" : "s"}`} href="/tasks?tab=revisions" />
            <Pill warn={false} label={`${counts.boardOpen} on the task board`} href="/tasks?tab=other" />
          </div>
          {/* The arrow follows the page order: the decisions list is above
              the blocks for Jordan and below them for Kyle (audit5 F19). */}
          <a href="#needs-you" className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-2 hover:text-foreground">
            {needsBelow ? "↓" : "↑"} Everything that needs a decision today
          </a>
        </div>
      );

    case "qc-am":
      return <QcDueToday d={d} totalInReviewRoom={counts.qc} />;

    case "overdue":
      return <OverdueCard d={d} />;

    case "monthly":
      return <MonthlyCard d={d} />;

    case "comms-1":
    case "comms-2":
    case "comms-3":
      return (
        <div className="space-y-2">
          {d.unanswered.count === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="size-4" /> Every client message has an answer.</p>
          ) : (
            <>
              {d.unanswered.preview.map((u, i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-2 text-sm">
                  <p className="min-w-0 flex-1">
                    <span className="font-semibold"><ClientName name={u.name} src={u.avatarUrl} size={16} /></span>
                    <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", u.hours >= 24 ? "bg-danger/15 text-danger" : "bg-surface-2 text-muted")}>waiting {u.hours}h</span>
                    <span className="block truncate text-[13px] text-muted">&ldquo;{u.snippet}&rdquo;</span>
                  </p>
                  {/* By channel. The Replies tab is built from PHONE threads
                      only (replyQueue → unansweredComms families: ["phone"]),
                      so an email row sent there landed on a list without it —
                      five of five rows on Sep 8 (audit5 F3). Email rows open
                      the Email board, which does hold them. */}
                  <Link
                    href={u.family === "email" ? "/tasks?tab=comms&via=email" : "/communications?tab=replies"}
                    className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
                  >
                    Reply
                  </Link>
                </div>
              ))}
              {/* The badge counts every waiting client; only the five oldest
                  are previewed. Say so rather than letting a 9 sit over five
                  rows (audit fault #9). */}
              {d.unanswered.count > d.unanswered.preview.length && (
                <p className="text-[11px] text-muted-2">
                  Showing the {d.unanswered.preview.length} oldest of {d.unanswered.count}.
                </p>
              )}
              <Link href="/tasks?tab=comms" className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                Clear the queue — {d.unanswered.count} waiting <ArrowRight className="size-4" />
              </Link>
            </>
          )}
          {/* Two neighbouring lists, each next to its OWN name and its OWN
              count. The reply queue counts TEXT threads (including numbers we
              never matched to a client, which is why it can exceed the client
              count above); the email board counts sender groups. */}
          <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[11px] text-muted-2">
            <Link href="/communications?tab=replies" className="hover:text-foreground">Reply queue — every unanswered text, incl. unknown numbers →</Link>
            {counts.emailsWaiting > 0 && (
              <Link href="/tasks?tab=comms&via=email" className="hover:text-foreground">Email board — {counts.emailsWaiting} sender{counts.emailsWaiting === 1 ? "" : "s"} →</Link>
            )}
          </p>
        </div>
      );

    case "prep":
    case "final-prep":
      return (
        <div className="space-y-3">
          <ShootList shoots={d.tomorrowShoots} empty="Nothing on tomorrow's calendar yet." showGaps />
          {d.tomorrowShoots.length > 0 && d.closeout.tomorrowGaps === 0 && (
            <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="size-4" /> Tomorrow looks ready — every shoot has a street address, a photographer and access notes on file.</p>
          )}
        </div>
      );

    case "loops":
      return <LoopsCard d={d} />;

    case "video-review":
      return <VideoReviewCard d={d} />;

    case "lunch":
      return <p className="text-sm text-muted">Eat. The hub holds the fort.</p>;

    case "pipeline":
      // The Project Tracker, merged in whole (Jordan, Sep 2). Its three tabs
      // ARE the three questions this block asks — what's due today, what's
      // holding it up, what's coming — so it replaces the flat list that used
      // to live here. The per-job editing detail (who has it, what evidence
      // landed, the revision asks) follows underneath, because the tracker
      // card doesn't carry it.
      return (
        <div className="space-y-4">
          <DeliveryBoardView board={board} />
          {d.pipeline.rows.length > 0 && (
            <div>
              <h4 className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-muted-2">
                In production right now
                <span className="flex flex-wrap gap-1.5 text-[11px] font-medium normal-case tracking-normal">
                  <Pill warn={false} label={`${d.pipeline.editing} editing`} href="/editing" />
                  <Pill warn={d.pipeline.review > 0} label={`${d.pipeline.review} in review`} href="/review" />
                  <Pill warn={d.pipeline.revision > 0} label={`${d.pipeline.revision} in revision`} href="/tasks?tab=revisions" />
                </span>
              </h4>
              <div className="mt-2 space-y-2">
                {d.pipeline.rows.map((r) => (
                  <Link key={r.projectId} href={`/edit/${r.projectId}`} className="block rounded-xl border border-border px-3.5 py-2.5 transition-colors hover:bg-surface-2/60">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{r.title}</span>
                      <span className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                        r.status === "REVISION" ? "bg-warning/15 text-warning" : r.status === "REVIEW" ? "bg-brand/15 text-brand" : "bg-surface-2 text-muted",
                      )}>
                        {r.status === "REVISION" ? "revision" : r.status === "REVIEW" ? "in review" : "editing"}
                      </span>
                      {r.editor && <span className="shrink-0 text-xs text-muted">→ {r.editor}</span>}
                    </div>
                    {/* Who it's for + what was ordered (Jordan: "more details on
                        who it is, what it's for"). */}
                    {(r.clientName || r.services.length > 0) && (
                      <p className="mt-0.5 text-xs text-muted">
                        {r.clientName && <ClientName name={r.clientName} src={r.clientAvatarUrl} />}
                        {r.clientName && r.services.length > 0 && " · "}
                        {r.services.join(", ")}
                      </p>
                    )}
                    <p className="mt-1 text-[13px]">
                      {r.sent.length > 0 && <span className="text-success">Sent: {r.sent.join(", ")}</span>}
                      {r.sent.length > 0 && r.waitingOn.length > 0 && <span className="text-muted-2"> · </span>}
                      {r.waitingOn.length > 0 && <span className="font-medium text-warning">Still needs: {r.waitingOn.join(", ")}</span>}
                      {r.sent.length === 0 && r.waitingOn.length === 0 && <span className="text-muted">No delivery evidence yet.</span>}
                      {r.videoDueISO && (
                        <span className={cn("ml-1", r.videoOverdue ? "font-semibold text-danger" : "text-muted-2")}>
                          · video due {fmtDay(r.videoDueISO)}{r.videoOverdue ? " — LATE" : ""}
                        </span>
                      )}
                    </p>
                    {r.revision && (r.revision.headline || r.revision.items.length > 0) && (
                      <div className="mt-1.5 rounded-lg bg-warning/[0.07] px-2.5 py-1.5 text-[13px]">
                        {r.revision.headline && <p className="font-medium text-foreground/85">Revising: {r.revision.headline}</p>}
                        {r.revision.items.map((it, i) => (
                          <p key={i} className="text-foreground/75">· {it.slice(0, 110)}</p>
                        ))}
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      );

    case "systems":
      return (
        <p className="text-[13px] leading-relaxed text-muted">
          Lower-priority block: Aryeo cleanup · client record updates · Dropbox organization · SOP maintenance ·
          review requests · process improvements. Drop it instantly if a client needs something.
        </p>
      );

    case "closeout":
      return (
        <div className="space-y-1.5">
          {closeoutRows(d).map((r, i) => (
            <p key={i} className={cn("flex items-start gap-2 text-sm", r.ok ? "text-success" : "text-warning")}>
              {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
              {r.label}
            </p>
          ))}
        </div>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shoot cards — parsed and glanceable: bold labels, weather, airspace, comms.
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed">
      <span className="font-semibold text-foreground/90">{label}: </span>
      <span className="text-foreground/75">{children}</span>
    </p>
  );
}

// A client's name with their Aryeo headshot in front of it, sized for a
// one-line row. Jordan (Sep 2): "if the agent has a profile photo in aryeo that
// should be shown … in other places the clients are mentioned." Inline-flex so
// it sits inside the existing text runs (" · shot Aug 21 · Harrison") without
// reflowing them; <Avatar> draws the initials disc when Aryeo has no photo, so
// callers pass the row's clientAvatarUrl straight through.
function ClientName({ name, src, size = 18 }: { name: string; src: string | null; size?: number }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <Avatar name={name} src={src} size={size} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function ShootList({ shoots, empty, showGaps, showDebrief }: { shoots: OpsShoot[]; empty: string; showGaps?: boolean; showDebrief?: boolean }) {
  if (shoots.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="space-y-2.5">
      {shoots.map((s) => (
        <div key={s.id} className="rounded-xl border border-border px-4 py-3">
          {/* Header: time · address · quick links */}
          <div className="flex items-center gap-2">
            <Camera className="size-4 shrink-0 text-muted-2" />
            <Link href={`/projects/${s.id}`} className="min-w-0 flex-1 truncate text-[15px] font-semibold hover:text-brand">{s.title}</Link>
            {s.timeISO && <span className="shrink-0 text-sm font-semibold tabular-nums text-brand">{fmtTime(s.timeISO)}</span>}
            {s.aryeoListingId && (
              <a
                href={aryeoListingUrl(s.aryeoListingId)}
                target="_blank" rel="noopener noreferrer"
                title="Open the listing in Aryeo"
                className="shrink-0 rounded-lg border border-border p-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>

          {/* Same-day rush strip — the client paid to have this media TODAY.
              Full-width, red, above every other field, so nobody reads the
              door code and misses that the gallery is due by 5. The hour is
              the SLA engine's (opsDay → tasks.ts sameDayDue), the same one on
              the QC card. Tomorrow's cards carry it too, with the day. */}
          {s.sameDay && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-[13px] text-danger">
              <span className="inline-flex items-center gap-1.5 font-bold uppercase tracking-wide">
                <Zap className="size-4 shrink-0" /> Same-day {rushWhat(s)}
              </span>
              {s.sameDay.dueISO && (
                <span className="ml-auto font-semibold tabular-nums">due {fmtDayTime(s.sameDay.dueISO)}</span>
              )}
            </div>
          )}

          <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Field label="Client"><ClientName name={s.clientName} src={s.clientAvatarUrl} size={16} /></Field>
            <Field label="Creative">{s.photographer ?? <span className="font-semibold text-danger">unassigned</span>}</Field>
            <Field label="Services">{s.services.join(", ") || "—"}</Field>
            {s.access.name && <Field label="Contact">{s.access.name}{s.access.phone ? ` · ${s.access.phone}` : ""}</Field>}
            {/* The door code is the single most operational thing on this card —
                give it its own emphasised row, not a buried note (audit HIGH). */}
            {s.access.lockbox && (
              <div className="sm:col-span-2">
                <Field label="Lockbox / door code">
                  <span className="font-semibold text-brand">{s.access.lockbox}</span>
                </Field>
              </div>
            )}
            {s.access.access && <div className="sm:col-span-2"><Field label="Getting in">{s.access.access}</Field></div>}
            {s.access.presence && <Field label="Who's there">{s.access.presence}</Field>}
            {s.access.special && (
              <div className="sm:col-span-2">
                <Field label="Special instructions"><span className="text-warning">{s.access.special}</span></Field>
              </div>
            )}
            {s.access.orderNotes && <div className="sm:col-span-2"><Field label="Order notes">{s.access.orderNotes}</Field></div>}
            {s.access.notes && <div className="sm:col-span-2"><Field label="Client preferences">{s.access.notes}</Field></div>}
            {s.specialRequests.length > 0 && (
              <div className="sm:col-span-2">
                <p className="text-[13px] leading-relaxed">
                  <span className="font-semibold text-warning">Special requests: </span>
                  <span className="text-foreground/75">{s.specialRequests.join(" · ").slice(0, 200)}</span>
                </p>
              </div>
            )}
          </div>

          {/* Conditions + comms strip */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-[13px]">
            {s.weather && (
              <span className={cn("inline-flex items-center gap-1", s.weather.precipPct >= 40 || s.weather.windMph >= 20 ? "font-semibold text-warning" : "text-muted")}>
                <CloudSun className="size-3.5" />
                {s.weather.tempF}° · {s.weather.precipPct}% rain · wind {s.weather.windMph} mph
              </span>
            )}
            {s.droneOrdered && s.airspace && (
              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  !s.airspace.available ? "text-muted" : s.airspace.warning ? "font-semibold text-warning" : "text-success",
                )}
                title={s.airspace.airport ? `Controlling airport: ${s.airspace.airport}` : undefined}
              >
                <Plane className="size-3.5" />
                {!s.airspace.available ? (
                  <>
                    Airspace check unavailable —{" "}
                    <a href="https://b4ufly.aloft.ai/" target="_blank" rel="noopener noreferrer" className="underline">
                      verify on B4UFLY
                    </a>
                  </>
                ) : s.airspace.status === "clear" ? (
                  "Airspace clear — OK to 400 ft"
                ) : s.airspace.status === "restricted" ? (
                  `No-fly without FAA authorization${s.airspace.airport ? ` (${s.airspace.airport})` : ""} — 0 ft grid`
                ) : (
                  `LAANC required — auto-auth to ${s.airspace.ceilingFt} ft${s.airspace.airport ? ` near ${s.airspace.airport}` : ""}`
                )}
              </span>
            )}
            {s.comms && (
              <Link href={`/communications`} className={cn("inline-flex items-center gap-1 hover:underline", s.comms.count > 0 && s.comms.latestInbound ? "font-semibold text-brand" : "text-muted")}>
                <MessageSquare className="size-3.5" />
                {s.comms.count > 0 && (
                  <>
                    {s.comms.count} msg{s.comms.count === 1 ? "" : "s"} (72h)
                    {s.comms.latestSnippet && <> · {s.comms.latestInbound ? "them" : "us"}: &ldquo;{s.comms.latestSnippet.slice(0, 60)}&rdquo;</>}
                  </>
                )}
                {s.comms.otherCount > 0 && (
                  <span className="text-muted-2">{s.comms.count > 0 ? "· " : ""}+{s.comms.otherCount} on other job{s.comms.otherCount === 1 ? "" : "s"}</span>
                )}
              </Link>
            )}
            {/* "Shot" is the appointment's END (OpsShoot.endISO), not its start:
                at 12:04 PM both cards read "upload page not submitted" for
                photographers still on site until 1:45 and 2:30 (audit5 F8).
                While the shoot is running, say that instead — and only print
                the hour when Aryeo booked one, not the 2h assumption. */}
            {showDebrief && s.timeISO && s.endISO && !s.debriefSubmitted &&
              new Date(s.timeISO) < new Date() && new Date(s.endISO) >= new Date() && (
              <span className="text-muted">On site now{s.endAssumed ? "" : ` — until ${fmtTime(s.endISO)}`}</span>
            )}
            {showDebrief && s.endISO && (s.debriefSubmitted || new Date(s.endISO) < new Date()) && (
              <span className={cn(s.debriefSubmitted ? "text-success" : "font-semibold text-warning")}>
                {s.debriefSubmitted ? "Upload page submitted ✓" : "Shot — upload page not submitted"}
              </span>
            )}
            {showGaps && s.gaps.length > 0 && (
              <span className="font-semibold text-danger">Missing: {s.gaps.join(" · ")}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QC — grouped Overdue · Due today · Waiting, with evidence and quick links.
// ---------------------------------------------------------------------------

// The 9:30 block is for TODAY's work. The backlog (overdue + not-yet-due) was
// burying it: on Sep 1 the card held 8 stale rows and nothing actually due, so
// Kyle couldn't tell what this hour was for (Jordan: "too clogged up with
// overdue and waiting — that should be a separate card to check").
function QcDueToday({ d, totalInReviewRoom }: { d: OpsDay; totalInReviewRoom: number }) {
  const qc = listingQc(d);
  const rows = qc.filter((q) => q.bucket === "today");
  // Each number must match the card it links to — monthly rows are counted
  // once, under monthly, even when they are also late.
  const overdue = qc.filter((q) => q.bucket === "overdue").length;
  const waiting = qc.filter((q) => q.bucket === "waiting").length;
  const monthly = d.qc.filter((q) => q.monthly).length;
  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4" /> Nothing due for QC today.
        </p>
      ) : (
        <div className="space-y-2">
          {/* All rows inline — the Other tab hides media_qa for non-editors,
              so an "All N →" link there would land on an empty list. */}
          {rows.map((q) => <QcRow key={q.taskId} q={q} />)}
        </div>
      )}
      {(overdue > 0 || waiting > 0 || monthly > 0) && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted">
          Not in this block:
          {overdue > 0 && <a href="#overdue" className="font-semibold text-danger hover:underline">{overdue} overdue →</a>}
          {waiting > 0 && <a href="#overdue" className="hover:underline">{waiting} not due yet →</a>}
          {monthly > 0 && <a href="#monthly" className="font-semibold text-brand hover:underline">{monthly} monthly content →</a>}
        </p>
      )}
      {/* The Review Room's own count, next to its own name. It is the only list
          that also holds orphan QC cards (the job row is gone), so it can read
          a little higher than the buckets above — which are per-job. */}
      <p className="text-[11px] text-muted-2">
        <Link href="/review" className="hover:text-foreground">
          Review Room holds all {totalInReviewRoom} photo set{totalInReviewRoom === 1 ? "" : "s"} in QC →
        </Link>
      </p>
    </div>
  );
}

// Everything past its promised date, oldest first, plus what is not due yet.
// Monthly batches are deliberately absent — they have their own card and their
// own turnaround (Jordan: monthly content shouldn't sit in the QC pile).
function OverdueCard({ d }: { d: OpsDay }) {
  const now = new Date(d.nowISO);
  const qc = listingQc(d);
  const byDueAsc = (a: OpsQcRow, b: OpsQcRow) =>
    (a.dueISO ? Date.parse(a.dueISO) : Infinity) - (b.dueISO ? Date.parse(b.dueISO) : Infinity);
  const overdue = qc.filter((q) => q.bucket === "overdue").sort(byDueAsc);
  const waiting = qc.filter((q) => q.bucket === "waiting").sort(byDueAsc);
  const monthlyLate = d.qc.filter((q) => q.monthly && q.bucket === "overdue").length;
  return (
    <div className="space-y-4">
      {overdue.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4" /> Nothing is past its promised date.
        </p>
      ) : (
        <div>
          <h4 className="mb-1.5 text-xs font-bold uppercase tracking-widest text-danger">Overdue · {overdue.length}</h4>
          <div className="space-y-2">
            {overdue.map((q) => <QcRow key={q.taskId} q={q} now={now} />)}
          </div>
        </div>
      )}
      {waiting.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-bold uppercase tracking-widest text-muted-2">Not due yet · {waiting.length}</h4>
          <p className="mb-2 text-[13px] text-muted">Nothing to do today — listed so none of it creeps up on you.</p>
          <div className="space-y-2">
            {waiting.map((q) => <QcRow key={q.taskId} q={q} now={now} />)}
          </div>
        </div>
      )}
      {monthlyLate > 0 && (
        <p className="text-[13px] text-muted">
          {monthlyLate} monthly content batch{monthlyLate === 1 ? " is" : "es are"} also past due —{" "}
          <a href="#monthly" className="font-semibold text-brand hover:underline">Monthly Content Check →</a>
        </p>
      )}
    </div>
  );
}

function MonthlyCard({ d }: { d: OpsDay }) {
  const now = new Date(d.nowISO);
  const monthly = d.qc.filter((q) => q.monthly);
  if (monthly.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-success">
        <CheckCircle2 className="size-4" /> No monthly batches open right now.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {monthly.map((q) => <QcRow key={q.taskId} q={q} now={now} />)}
    </div>
  );
}

// One open loop — the row Kyle acts on. View + Handled on every row (Jordan,
// Sep 1) rather than one big link; the Other tab hides comm-type tasks, so the
// only honest "view" for an unanchored loop is the task deep-link.
function LoopRow({ l, now, muted }: { l: OpsLoop; now: Date; muted?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border px-3.5 py-2", muted && "bg-surface-2/40")}>
      <div className="min-w-0 flex-1 basis-56">
        <p className={cn("text-sm font-medium leading-snug", muted && "text-foreground/80")}>{l.title}</p>
        <p className="mt-0.5 text-[11px] text-muted">
          {loopKind(l.kind)}
          {l.projectTitle ? ` · ${l.projectTitle}` : ""}
          {l.dueISO ? (l.overdue ? ` · ${ageText(l.dueISO, now)} overdue` : ` · due ${fmtDay(l.dueISO)}`) : " · no date"}
          {l.withWhom ? ` · with ${l.withWhom}` : ""}
        </p>
      </div>
      {l.overdue && <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">overdue</span>}
      <LoopActions taskId={l.taskId} viewHref={l.projectId ? `/projects/${l.projectId}` : `/tasks?tab=other&task=${l.taskId}`} />
    </div>
  );
}

/**
 * Open Loops + Follow-Ups. Two problems Jordan named on Sep 2: the list showed
 * every loop in the business to everyone ("it's showing Kyle things that are
 * for me") and showed all of them at once ("it's also too many things there").
 *
 * Audience is settled in openLoopsList() — this card only ever receives the
 * viewer's own lane plus the shared ops pile. Volume is settled here: overdue
 * and due-today lead, the first {LOOPS_SHOWN} render open, and everything else
 * is COUNTED in the summary and expands in place. Nothing is truncated away —
 * the /tasks board hides these task types (BOARD_HIDDEN_TYPES), so an overflow
 * link there would land on an empty page.
 */
function LoopsCard({ d }: { d: OpsDay }) {
  const now = new Date(d.nowISO);
  const { act, later, elsewhere } = splitLoops(d.openLoops);
  if (act.length + later.length + elsewhere.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-success">
        <CheckCircle2 className="size-4" /> No follow-ups waiting on someone else.
      </p>
    );
  }
  const shown = act.slice(0, LOOPS_SHOWN);
  const restOfAct = act.slice(LOOPS_SHOWN);
  const moreCount = restOfAct.length + later.length + elsewhere.length;
  // Says what the tail actually IS, so "show N more" is never a mystery pile.
  // The overdue-with-someone-else figure is called out WITHOUT expanding: on
  // the owner's screen most loops sit with Kyle, and "12 overdue" is the whole
  // point of this block ("what am I waiting on that could become a problem?").
  const elsewhereLate = elsewhere.filter((l) => l.overdue).length;
  const moreParts = [
    restOfAct.length > 0 ? `${restOfAct.length} more due now` : null,
    later.length > 0 ? `${later.length} not due yet` : null,
    elsewhere.length > 0 ? `${elsewhere.length} with someone else` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-2">
      {act.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4" /> Nothing of yours is overdue or promised today.
        </p>
      ) : (
        shown.map((l) => <LoopRow key={l.taskId} l={l} now={now} />)
      )}

      {moreCount > 0 && (
        <details className="group/loops rounded-xl border border-border bg-surface-2/30">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2 text-[13px] font-medium text-muted hover:text-foreground">
            <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-open/loops:rotate-0" />
            Show {moreCount} more
            <span className="text-[11px] font-normal text-muted-2">— {moreParts.join(" · ")}</span>
            {elsewhereLate > 0 && (
              <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">{elsewhereLate} overdue</span>
            )}
          </summary>
          <div className="space-y-2 border-t border-border p-2.5">
            {restOfAct.map((l) => <LoopRow key={l.taskId} l={l} now={now} />)}
            {later.length > 0 && (
              <>
                <p className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Not due yet</p>
                {later.map((l) => <LoopRow key={l.taskId} l={l} now={now} muted />)}
              </>
            )}
            {elsewhere.length > 0 && (
              <>
                <p className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                  With someone else — chase, don&rsquo;t do
                </p>
                {elsewhere.map((l) => <LoopRow key={l.taskId} l={l} now={now} muted />)}
              </>
            )}
          </div>
        </details>
      )}

      {d.openLoopsTally.capped && (
        <p className="text-[11px] text-muted-2">
          Showing the first {d.openLoops.length} — there are more open than this block can load.
        </p>
      )}
    </div>
  );
}

// One labelled line of the QC status grid — the same shape as the shoot
// card's Field, so both cards read the same way.
function StatusLine({ label, tone, children }: { label: string; tone: "success" | "warning" | "brand" | "muted" | "danger"; children: React.ReactNode }) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "brand" ? "text-brand" : tone === "danger" ? "text-danger" : "text-foreground/90";
  return (
    <p className="text-[13px] leading-relaxed">
      <span className={cn("font-semibold", toneClass)}>{label}: </span>
      <span className="text-foreground/80">{children}</span>
    </p>
  );
}

const actionBtn = "inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground";

function QcRow({ q, now }: { q: OpsQcRow; now?: Date }) {
  const db = q.evidence.dropbox;
  // How late, in plain days — "due Aug 21" makes Kyle do the subtraction.
  const lateDays =
    now && q.dueISO && Date.parse(q.dueISO) < now.getTime()
      ? Math.floor((now.getTime() - Date.parse(q.dueISO)) / 86_400_000)
      : null;
  const v = q.video;
  const videoTone =
    !v ? "muted" :
    v.stage === "waiting_review" ? "brand" :
    v.stage === "in_revisions" ? "warning" :
    v.stage === "approved" || v.stage === "delivered" ? "success" :
    "muted";
  const videoHref = !v ? null : v.stage === "waiting_review" ? `/review/${q.projectId}` : `/edit/${q.projectId}`;
  return (
    <div className="rounded-xl border border-border">
      {/* Header: address + who, chips on the right (wrap under on a phone) */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3.5 pt-2.5">
        <div className="min-w-0 flex-1 basis-52">
          <Link href={`/projects/${q.projectId}`} className="text-sm font-semibold leading-snug hover:text-brand">{q.title}</Link>
          <p className="mt-0.5 text-[12px] text-muted">
            {q.clientName && <ClientName name={q.clientName} src={q.clientAvatarUrl} />}
            {q.shootISO ? ` · shot ${fmtDay(q.shootISO)}` : ""}
            {q.photographer ? ` · ${q.photographer}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {lateDays != null && (
            <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">
              {lateDays === 0 ? "late today" : `${lateDays} day${lateDays === 1 ? "" : "s"} late`}
            </span>
          )}
          {q.videosOwed != null && (
            <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand" title="Videos this monthly session owes — the photographer's count, else the plan quota">
              {q.videosOwed} video{q.videosOwed === 1 ? "" : "s"}
            </span>
          )}
          {/* "Ready now" is the number that matters: checks whose media is
              already live. The rest of itemsLeft is the card waiting on media,
              not work — showing only the total made a job with photos live and
              six checks waiting look identical to one where nothing had landed. */}
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold",
              q.actionable > 0 ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted",
            )}
            title={
              q.actionable > 0
                ? `${q.actionable} of ${q.itemsLeft} unticked boxes can be done right now — that media is live on Aryeo. The rest tick themselves as each remaining category lands.`
                : "Unticked boxes on this job's QC task. They tick themselves as each deliverable goes live on Aryeo — nothing to check until then."
            }
          >
            {q.actionable > 0
              ? `${q.actionable} ready now`
              : `${q.itemsLeft} check${q.itemsLeft === 1 ? "" : "s"} left`}
          </span>
        </div>
      </div>

      {/* Status grid — what's live, what's owed, where the video is, what
          Dropbox holds. Labelled lines instead of two run-on sentences. */}
      <div className="mt-2 grid gap-x-6 gap-y-0.5 px-3.5 sm:grid-cols-2">
        <StatusLine label="Ordered" tone="muted">{q.services.join(", ") || "—"}</StatusLine>
        {q.evidence.present.length > 0 ? (
          <StatusLine label="Live on Aryeo" tone="success">
            {q.evidence.present.join(", ")}
            {q.actionable > 0 && <> — <span className="font-semibold text-warning">{q.actionable} check{q.actionable === 1 ? "" : "s"} ready for you</span></>}
          </StatusLine>
        ) : (
          <StatusLine label="Live on Aryeo" tone="muted">nothing yet</StatusLine>
        )}
        {/* WHY it's still open, in words — "missing: Floor plan" alone didn't
            say whether we're waiting on the editor, on Aryeo, or on nothing at
            all (Jordan, Sep 1: 195 Woodhill's floor plan was removed). */}
        {q.evidence.missing.length > 0 ? (
          <StatusLine label="Still owed" tone="warning">
            {q.evidence.missing.join(", ")}
            {q.nextDueISO ? ` — ${q.nextDueCategories.join(" + ").toLowerCase()} due ${fmtDayTime(q.nextDueISO)}` : ""}
          </StatusLine>
        ) : q.itemsLeft > 0 ? (
          <StatusLine label="Still owed" tone="muted">nothing — everything ordered is live, finish the checks</StatusLine>
        ) : (
          <StatusLine label="Status" tone="success">Everything is live and checked — safe to close.</StatusLine>
        )}
        {/* Video status for shoots that have one (Jordan, Sep 1). */}
        {v && (
          <StatusLine label="Video" tone={videoTone}>
            {v.detail}
            {videoHref && (v.stage === "waiting_review" || v.stage === "in_revisions") && (
              <> · <Link href={videoHref} className="font-medium text-brand hover:underline">{v.stage === "waiting_review" ? "review it" : "open edit"}</Link></>
            )}
          </StatusLine>
        )}
        <StatusLine label="Dropbox" tone="muted">
          {db ? (
            <>
              Raw {db.rawPhotos + db.rawVideo} · Final {db.finalPhotos + db.finalVideo}
              {db.stale && <span className="text-muted-2"> (last read {db.at ? fmtDay(db.at) : "earlier"})</span>}
            </>
          ) : (
            // Not consulted ≠ empty. Hiding the line read as "no files".
            <span title="The last status check didn't read Dropbox for this job (Aryeo already accounted for everything ordered, or the read failed with nothing to carry forward).">not read this pass</span>
          )}
        </StatusLine>
      </div>

      {/* Actions — one row, same buttons on every card */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border/60 px-3.5 py-2">
        <QcComplete taskId={q.taskId} waitingOn={q.evidence.missing} />
        {q.aryeoListingId && (
          <a href={aryeoListingUrl(q.aryeoListingId)} target="_blank" rel="noopener noreferrer" title="Open the listing in Aryeo" className={actionBtn}>
            <ExternalLink className="size-3" /> Aryeo
          </a>
        )}
        <Link href={`/projects/${q.projectId}`} className={actionBtn}>Project</Link>
        {v?.stage === "waiting_review" && (
          <Link href={`/review/${q.projectId}`} className={cn(actionBtn, "border-brand/40 text-brand hover:text-brand")}>
            <PlayCircle className="size-3" /> Review video
          </Link>
        )}
        {q.evidence.missing.length > 0 && (
          <span className="ml-auto text-[11px] text-muted-2">Removed from the order or handled elsewhere? Mark complete.</span>
        )}
      </div>
      <ShootNotes q={q} />
    </div>
  );
}

// Everything the photographer wrote on the upload portal, verbatim and in full
// — except the video editing brief, which belongs to the editor on /edit
// (Jordan, Sep 1). These notes were previously either missing (shot order,
// flags, per-item notes, "anything else for the editor") or clipped mid-sentence
// at 140 characters, which is where the useful half usually was.
function ShootNotes({ q }: { q: OpsQcRow }) {
  const b = q.debrief;
  const has =
    b.unsubmitted || q.notCompleted.length > 0 || b.flags.length > 0 || !!b.removals ||
    b.nothingToRemove || !!b.shotOrder || !!b.editorBrief || b.itemNotes.length > 0 ||
    b.culled || b.videosFilmed != null;
  if (!has) return null;
  return (
    <div className="mx-3.5 mb-3 rounded-lg bg-surface-2/60 px-3 py-2">
      <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted-2">From the shoot</h4>
      <div className="mt-1 space-y-1 text-[13px]">
        {b.unsubmitted && (
          <p className="font-medium text-danger">Upload page never submitted — treat the gallery as unculled.</p>
        )}
        {q.notCompleted.map((nc, i) => (
          <p key={i} className="font-medium text-warning">
            Couldn&rsquo;t complete {nc.label}: <span className="font-normal text-foreground/80">{nc.reason}</span>
          </p>
        ))}
        {b.flags.map((f, i) => (
          <p key={i} className="font-medium text-danger">Flagged: <span className="font-normal text-foreground/80">{f}</span></p>
        ))}
        {b.shotOrder && <NoteLine label="Shot order" body={b.shotOrder} />}
        {b.removals && <NoteLine label="Remove in editing" body={b.removals} />}
        {b.editorBrief && <NoteLine label="Anything else" body={b.editorBrief} />}
        {b.itemNotes.map((n, i) => <NoteLine key={i} label={n.label} body={n.note} />)}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-muted">
          {b.videosFilmed != null && <span>{b.videosFilmed} video{b.videosFilmed === 1 ? "" : "s"} filmed</span>}
          {b.culled && <span className="text-success">Culled to standard ✓</span>}
          {b.nothingToRemove && !b.removals && <span>Nothing to remove ✓</span>}
        </div>
      </div>
    </div>
  );
}

// whitespace-pre-wrap: multi-line wrap-up notes keep the photographer's line
// breaks instead of collapsing into one run-on paragraph.
function NoteLine({ label, body }: { label: string; body: string }) {
  return (
    <p className="whitespace-pre-wrap text-foreground/80">
      <span className="font-semibold text-foreground/90">{label}:</span> {body}
    </p>
  );
}

function Pill({ warn, label, href }: { warn: boolean; label: string; href: string }) {
  const classes = cn(
    "rounded-full border px-3 py-1 font-medium transition-colors hover:bg-surface-2",
    warn ? "border-warning/40 bg-warning/10 text-warning" : "border-border text-muted",
  );
  // In-page anchors must be a plain <a> — next/link would push a route.
  return href.startsWith("#") ? (
    <a href={href} className={classes}>{label}</a>
  ) : (
    <Link href={href} className={classes}>{label}</Link>
  );
}

// ---------------------------------------------------------------------------
// Video Review — every uploaded cut waiting on a verdict, and every cut that
// went back to an editor (Jordan, Sep 1). Rows are per CUT, not per job: a
// monthly package with four videos shows four rows, each with its own button.
// ---------------------------------------------------------------------------

function VideoReviewCard({ d }: { d: OpsDay }) {
  const now = new Date(d.nowISO);
  const { waiting, revising } = d.videoReview;
  return (
    <div className="space-y-4">
      <VideoGroup
        icon={PlayCircle}
        title="Waiting on your review"
        tone="brand"
        cuts={waiting}
        now={now}
        empty="Nothing waiting — every uploaded cut has a verdict."
        action="Review"
        hrefFor={(c) => `/review/${c.projectId}?cut=${c.submissionId}`}
      />
      <VideoGroup
        icon={Hourglass}
        title="In revisions"
        tone="warning"
        cuts={revising}
        now={now}
        empty="No cuts are back with an editor."
        action="Open edit"
        hrefFor={(c) => `/edit/${c.projectId}?cut=${c.submissionId}`}
      />
    </div>
  );
}

function VideoGroup({ icon: Icon, title, tone, cuts, now, empty, action, hrefFor }: {
  icon: LucideIcon;
  title: string;
  tone: "brand" | "warning";
  cuts: VideoCutState[];
  now: Date;
  empty: string;
  action: string;
  hrefFor: (c: VideoCutState) => string;
}) {
  const toneText = tone === "brand" ? "text-brand" : "text-warning";
  const toneChip = tone === "brand" ? "bg-brand/15 text-brand" : "bg-warning/15 text-warning";
  return (
    <div>
      <h4 className={cn("flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest", toneText)}>
        <Icon className="size-3.5" /> {title}
        <span className={cn("rounded-full px-1.5 text-[10px] tabular-nums", toneChip)}>{cuts.length}</span>
      </h4>
      {cuts.length === 0 ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="size-4" /> {empty}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {cuts.map((c) => {
            const age = ageText(c.sinceISO, now);
            const stale = now.getTime() - Date.parse(c.sinceISO) > 48 * 3_600_000;
            return (
              <div key={c.submissionId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border px-3.5 py-2">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm leading-snug">
                    <Link href={`/projects/${c.projectId}`} className="font-semibold hover:text-brand">{c.street}</Link>
                    <span className="text-muted">· {c.cutLabel}</span>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">v{c.round}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    <ClientName name={c.clientName} src={c.clientAvatarUrl} size={16} />
                    {c.submittedByName?.startsWith("Auto") ? " · found in the Final folder" : c.submittedByName || c.editorKey ? ` · ${c.submittedByName ?? c.editorKey}` : ""}
                    {" · "}
                    <span className={cn(stale && "font-semibold text-danger")}>
                      {c.status === "PENDING" ? `waiting ${age}` : age === "just now" ? "sent back just now" : `sent back ${age} ago`}
                    </span>
                    {c.status === "CHANGES_REQUESTED" && c.openNotes > 0 && ` · ${c.openNotes} note${c.openNotes === 1 ? "" : "s"} to fix`}
                  </p>
                </div>
                <Link
                  href={hrefFor(c)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold",
                    tone === "brand" ? "border-brand/40 bg-brand/10 text-brand hover:bg-brand/20" : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
                  )}
                >
                  {action} <ArrowRight className="size-3" />
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
