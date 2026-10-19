import "server-only";
import { prisma } from "@/lib/prisma";
import { type JobCounts } from "@/lib/opsCounts";
import { dueTodayRows, videoDeliveryBoard, videoSummary, type VideoRow } from "@/lib/videoDelivery";
import { schedulingBoard, specialRequestsBoard, type AskView } from "@/lib/clientAsks";
import { loadQueue } from "@/app/ops/photo-delivery/data";
import type { QueueColumnKey, QueueData } from "@/components/photoDelivery/types";
import { unansweredCommsBoard, type CommsGroup } from "@/lib/commsBoard";
import { canAccess } from "@/lib/auth/access";
import { reviewerChain } from "@/lib/reviewerAssignment";
import { photoQcWhere } from "@/lib/taskBoard";
import { scrubMoney } from "@/lib/text";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { pinnedPromise } from "@/lib/turnaround";
import { etDayKey, etDayStartUtc, etTime } from "@/lib/datetime";
import type { Assignee } from "@/lib/assignees";
import {
  checklistTasks, checklistTasksClosedToday, type ChecklistPerson, type OldItem,
} from "@/lib/taskAging";

// ---------------------------------------------------------------------------
// HOME, Oct 19 2026 (evening). Jordan: "The home screen should have the daily
// checklist, but with a box up top that summarizes the photo delivery, video
// delivery, and comms needing responses. … I think we should just keep it
// simplified. We just need Kyle to be able to keep track of what he got done
// and what's still outstanding at the end of the day." and "we need to be able
// to take quick action, stay organized, efficient, and effective and not miss
// any deliveries, special requests."
//
// This module builds, from ONE pass of reads:
//   · the SUMMARY BOX (three numbers, each its screen's own source):
//       photos   → loadQueue()                 (/ops/photo-delivery's loader)
//       videos   → videoSummary()              (the video delivery contract)
//       messages → unansweredCommsBoard()      (/ops/messages lists exactly these)
//   · KYLE'S DAILY CHECKLIST: one list for today in five groups (Deliveries,
//     Messages to answer, Special requests to check, Scheduling to handle,
//     Follow-ups due), then "From earlier days, still open", then what was
//     done today and what is still open;
//   · the owner's week (this week against last).
// Jordan's Home reads the same checklist for Kyle ("Kyle's day": done today,
// still open), so the two screens can never disagree.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

/** A client waiting this long for an answer counts as behind. */
export const MESSAGE_BEHIND_HOURS = 24;
/** On-time percentages stay hidden until the week has this many jobs to judge. */
export const ON_TIME_MIN_JOBS = 3;

const nextEtDayStart = (d: Date) => etDayStartUtc(new Date(etDayStartUtc(d).getTime() + 36 * HOUR));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2.7 days" / "9 hours": how late, in the unit a person would say. */
export function lateWords(hours: number | null): string {
  if (hours == null) return "an unknown time";
  if (hours < 24) {
    const h = Math.max(1, Math.round(hours));
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round((hours / 24) * 10) / 10;
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** "5h" / "2d 3h": how long a client has waited. */
export const waitedWords = (h: number) => (h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.max(0, h)}h`);

// ---- WHOSE HOME --------------------------------------------------------------------

export type HomeRole = "owner" | "review" | "operations";

/** One rule for which Home a person gets: the owner's, the creative review
 *  seat's (the saved primary reviewer, James), or operations (Kyle). */
export async function homeRoleOf(me: { role: string; permissions?: string | null; teamMemberId: string | null } | null): Promise<HomeRole> {
  if (!me || me.role === "OWNER") return "owner";
  if (!canAccess(me, "review") || !me.teamMemberId) return "operations";
  const chain = await reviewerChain().catch(() => null);
  return chain?.primary?.teamMemberId === me.teamMemberId ? "review" : "operations";
}

/** Where a retired page (/ops/requests, /ops/scheduling, /ops/old) sends a
 *  person now: Kyle to the group on his checklist; Jordan to Kyle's day (or,
 *  for old items, What we're behind on); the review seat to the screen that
 *  holds that work on his side. */
export function checklistDoor(role: HomeRole, group: "requests" | "scheduling" | "earlier"): string {
  if (role === "operations") return `/#${group}`;
  if (role === "owner") return group === "earlier" ? "/#behind" : "/#kyles-day";
  return group === "requests" ? "/review" : group === "scheduling" ? "/schedule" : "/tasks?tab=work";
}

/** Kyle, for the owner's "Kyle's day": the office's ops lead, found the way his
 *  morning digest finds him, keyed against the roster. */
export async function kylePerson(roster: Assignee[]): Promise<(ChecklistPerson & { name: string }) | null> {
  const { kyleDigestRecipient } = await import("@/lib/notify");
  const to = await kyleDigestRecipient().catch(() => ({ teamMemberId: null as string | null }));
  if (!to.teamMemberId) return null;
  const hit = roster.find((a) => a.teamMemberId === to.teamMemberId);
  const tm = await prisma.teamMember.findUnique({ where: { id: to.teamMemberId }, select: { name: true } }).catch(() => null);
  return { key: hit?.key ?? "kyle", teamMemberId: to.teamMemberId, name: (tm?.name ?? "Kyle").split(" ")[0] };
}

// ---- PHOTOS: the photo delivery queue's own cards ----------------------------------

export type PhotoCounts = JobCounts & { readyForReview: number; needsDecision: number };

/** Counted off loadQueue()'s cards, exactly as /ops/photo-delivery renders them.
 *  `behind` = past its due time; `dueToday` = due later today, not behind yet. */
export function photoCountsFromQueue(q: QueueData, now: Date = new Date()): PhotoCounts {
  const today = etDayKey(now);
  const open = q.columns.filter((c) => c.key !== "delivered").flatMap((c) => c.cards);
  let behind = 0, dueToday = 0, oldest: number | null = null;
  for (const c of open) {
    const due = c.slaDueAt ? Date.parse(c.slaDueAt) : null;
    if (due != null && due < now.getTime()) behind++;
    else if (due != null && etDayKey(new Date(due)) === today) dueToday++;
    const since = c.shootDate ? Date.parse(c.shootDate) : null;
    if (since != null && since < now.getTime()) {
      const h = (now.getTime() - since) / HOUR;
      oldest = oldest == null ? h : Math.max(oldest, h);
    }
  }
  return {
    open: open.length,
    dueToday,
    behind,
    oldestHours: oldest == null ? null : Math.round(oldest),
    readyForReview: q.columns.find((c) => c.key === "ready")?.cards.length ?? 0,
    needsDecision: q.columns.find((c) => c.key === "decision")?.cards.length ?? 0,
  };
}

// ---- MESSAGES: clients waiting on a reply, and new leads ---------------------------

export type WaitingClient = { family: "phone" | "email"; group: CommsGroup; behind: boolean };
export type MessageLead = { id: string; title: string; createdAt: Date; dueAt: Date | null; assignedKey: string | null; behind: boolean; dueToday: boolean };

export type MessagesBoard = {
  /** clients still owed an answer, text and email together, longest wait first */
  waiting: WaitingClient[];
  /** open leads waiting on a call or text back, oldest first */
  leads: MessageLead[];
  /** client texts drafted and ready in the Outbox (a send, not a reply owed) */
  outbox: number;
  counts: JobCounts;
};

/** The clients waiting on a reply, text and email together, longest wait first.
 *  The summary box, the checklist's Messages group and /ops/messages all read this. */
async function waitingClients(now: Date, opts: { excludeClientIds?: string[] } = {}): Promise<WaitingClient[]> {
  const scope = { excludeClientIds: opts.excludeClientIds };
  const [phone, email] = await Promise.all([unansweredCommsBoard("phone", now, scope), unansweredCommsBoard("email", now, scope)]);
  return [
    ...phone.map((g) => ({ family: "phone" as const, group: g, behind: g.oldestHours >= MESSAGE_BEHIND_HOURS })),
    ...email.map((g) => ({ family: "email" as const, group: g, behind: g.oldestHours >= MESSAGE_BEHIND_HOURS })),
  ].sort((a, b) => b.group.oldestHours - a.group.oldestHours);
}

/** Where a waiting client is answered: the email board, or the text reply queue. */
export const replyHref = (family: "phone" | "email") => (family === "email" ? "/tasks?tab=comms&via=email" : "/communications?tab=replies");

/** Leads for a viewer: the owner (or the team view) sees every one; anyone
 *  else the leads filed to them plus the ones nobody holds (leadDesk's rule). */
async function leadsFor(opts: { team: boolean; key: string | null; teamMemberId: string | null; excludeClientIds?: string[] }) {
  const mine = [
    { assignedKey: null },
    ...(opts.key ? [{ assignedKey: opts.key }] : []),
    ...(opts.teamMemberId ? [{ ownerId: opts.teamMemberId }] : []),
  ];
  const ex = opts.excludeClientIds ?? [];
  return prisma.smartTask.findMany({
    where: {
      taskType: "lead",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      ...(opts.team ? {} : { OR: mine }),
      ...(ex.length ? { AND: [{ OR: [{ clientId: null }, { clientId: { notIn: ex } }] }] } : {}),
    },
    select: { id: true, title: true, createdAt: true, dueAt: true, assignedKey: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
}

/**
 * /ops/messages, as ONE object: the clients waiting on a reply (text and
 * email) and the new leads. Internal follow-ups are not messages (Jordan, Oct
 * 19): they are on the daily checklist. A lead that IS a waiting client's open
 * reply task is listed once, as the waiting client.
 */
export async function messagesBoard(opts: {
  now?: Date;
  excludeClientIds?: string[];
  viewer?: { key: string | null; role: string; teamMemberId: string | null } | null;
  team?: boolean;
} = {}): Promise<MessagesBoard> {
  const now = opts.now ?? new Date();
  const team = !!opts.team || !opts.viewer || opts.viewer.role === "OWNER";
  const [waiting, leadRows, outbox] = await Promise.all([
    waitingClients(now, opts),
    leadsFor({ team, key: opts.viewer?.key ?? null, teamMemberId: opts.viewer?.teamMemberId ?? null, excludeClientIds: opts.excludeClientIds }),
    import("@/lib/clientTexts").then((m) => prisma.smartTask.count({ where: m.clientTextWhere(now, { excludeClientIds: opts.excludeClientIds }) })),
  ]);
  const onBoard = new Set(waiting.map((w) => w.group.openTaskId).filter((x): x is string => !!x));
  const today = etDayKey(now);
  const leads: MessageLead[] = leadRows
    .filter((l) => !onBoard.has(l.id))
    .map((l) => ({ ...l, behind: !!l.dueAt && l.dueAt < now, dueToday: !!l.dueAt && l.dueAt >= now && etDayKey(l.dueAt) === today }));
  let behind = 0, dueToday = 0, oldest: number | null = null;
  const age = (h: number) => { oldest = oldest == null ? h : Math.max(oldest, h); };
  for (const w of waiting) {
    if (w.behind) behind++;
    else dueToday++;
    age(w.group.oldestHours);
  }
  for (const l of leads) {
    if (l.behind) behind++;
    else if (l.dueToday) dueToday++;
    age((now.getTime() - l.createdAt.getTime()) / HOUR);
  }
  const open = waiting.length + leads.length;
  return { waiting, leads, outbox, counts: { open, dueToday, behind, oldestHours: open === 0 || oldest == null ? null : Math.round(oldest) } };
}

// ---- THE SUMMARY BOX ----------------------------------------------------------------

export type HomeSummary = {
  /** null = the source could not be read; the box says so instead of a 0 */
  photos: { dueToday: number; late: number; olderQc: number } | null;
  videos: { readyToSend: number; late: number; dueToday: number } | null;
  messages: { waiting: number; behind: number; oldestHours: number | null } | null;
};

export const SUMMARY_HREF = { photos: "/ops/photo-delivery", videos: "/review", messages: "/ops/messages" } as const;

// ---- THE DAILY CHECKLIST ----------------------------------------------------------

export type ChecklistGroupKey = "deliveries" | "messages" | "requests" | "scheduling" | "followups";

const CHECKLIST_GROUPS: { key: ChecklistGroupKey; title: string; empty: string }[] = [
  { key: "deliveries", title: "Deliveries", empty: "Nothing due to go out today." },
  { key: "messages", title: "Messages to answer", empty: "Every client has an answer." },
  { key: "requests", title: "Special requests to check", empty: "No open requests on jobs going out soon." },
  { key: "scheduling", title: "Scheduling to handle", empty: "Nothing to book, move or confirm." },
  { key: "followups", title: "Follow-ups due", empty: "No follow-ups due today." },
];

/** The one-tap move on a line, beside "open it". */
export type LineAction =
  /** The screen is the action (a delivery goes out from its own page). */
  | { kind: "open"; label: string }
  /** Reply opens the reply screen; Handled closes the wait. */
  | { kind: "reply"; clientId: string; family: "phone" | "email"; groupKey: string }
  /** A client ask: Checked (special request) or Done (scheduling), or Not needed. */
  | { kind: "ask"; id: string; askKind: "SPECIAL_REQUEST" | "SCHEDULING" }
  /** A task: Done or Not needed. */
  | { kind: "task"; id: string };

export type ChecklistLine = {
  key: string;
  title: string;
  /** what is needed, in a few words ("Ready to send", "Waiting on editor") */
  need: string;
  /** the job, the client, the last thing they said */
  detail: string | null;
  /** late by / due when / waited how long */
  when: string | null;
  late: boolean;
  href: string;
  action: LineAction;
};

export type ChecklistGroup = {
  key: ChecklistGroupKey;
  title: string;
  empty: string;
  lines: ChecklistLine[];
  /** open, but not due soon (special requests on jobs going out later): folded */
  later: ChecklistLine[];
  /** the source could not be read: the group says so instead of "nothing" */
  unavailable: boolean;
};

export type DoneLine = {
  key: string;
  title: string;
  /** "Photos delivered", "Video sent", "Client answered", "Request checked", "Done", "Not needed" */
  what: string;
  atISO: string | null;
  by: string | null;
  href: string | null;
  /** a client ask closed today can be put back on the list */
  reopenAskId: string | null;
};

export type KyleChecklist = {
  nowISO: string;
  summary: HomeSummary;
  groups: ChecklistGroup[];
  earlier: { items: OldItem[]; unavailable: boolean };
  done: DoneLine[];
  doneUnavailable: boolean;
  stillOpen: { total: number; parts: { key: ChecklistGroupKey | "earlier"; title: string; count: number }[] };
  /** jobs a request can be added to by hand (Kyle's own Home only; null otherwise) */
  requestJobs: { id: string; label: string }[] | null;
};

// ---- the video screen's rows: THE ONE PLACE this module reads them ------------------
// (lib/videoDelivery, the Video Review Room's board). "due" is every listing
// video due by tonight, late first (dueTodayRows); "sending" is every approved
// video ready to send, whatever its date; "delivered" feeds Done today.

type VideoLines = { due: VideoRow[]; sending: VideoRow[]; delivered: VideoRow[] };
async function videoRows(now: Date): Promise<VideoLines> {
  const current = Math.abs(now.getTime() - Date.now()) < 60_000;
  const b = await videoDeliveryBoard(current ? {} : { now });
  return { due: dueTodayRows(b), sending: b.lanes.sending, delivered: b.lanes.delivered };
}

// ---- deliveries -----------------------------------------------------------------------

const PHOTO_NEED: Record<QueueColumnKey, { need: string; label: string }> = {
  editing: { need: "Waiting on edits", label: "Open" },
  qc: { need: "Being checked", label: "Open" },
  decision: { need: "Needs your decision", label: "Decide" },
  fixing: { need: "Fixes running", label: "Open" },
  hold: { need: "On hold", label: "Open" },
  ready: { need: "Ready to review and send", label: "Review" },
  delivering: { need: "Waiting on Aryeo", label: "Open" },
  delivered: { need: "Delivered", label: "Open" },
};

function dueWords(dueMs: number, now: Date): string {
  if (dueMs < now.getTime()) return `Late by ${lateWords((now.getTime() - dueMs) / HOUR)}`;
  return `Due ${etTime(new Date(dueMs))} ET`;
}

function photoLines(q: QueueData, now: Date): ChecklistLine[] {
  const endToday = nextEtDayStart(now).getTime();
  const out: { line: ChecklistLine; dueMs: number }[] = [];
  for (const col of q.columns) {
    if (col.key === "delivered") continue;
    for (const c of col.cards) {
      const due = c.slaDueAt ? Date.parse(c.slaDueAt) : null;
      if (due == null || due >= endToday) continue;
      const n = PHOTO_NEED[col.key];
      out.push({ dueMs: due, line: {
        key: `photo:${c.id}`,
        title: `${c.street} · photos`,
        need: col.key === "hold" && c.holdReason ? `On hold: ${c.holdReason}` : n.need,
        detail: c.clientName,
        when: dueWords(due, now),
        late: due < now.getTime(),
        href: `/ops/photo-delivery/${c.id}`,
        action: { kind: "open", label: n.label },
      } });
    }
  }
  return out.sort((a, b) => a.dueMs - b.dueMs).map((x) => x.line);
}

/** What a listing video needs, in a few words, from where the video screen says it stands. */
function videoNeed(r: VideoRow): string {
  if (r.lane === "sending") return "Ready to send";
  if (r.lane === "finishing") return "In the 1080p pass";
  if (r.lane === "held") return "Held";
  if (r.cutStatus === "PENDING") return "Waiting on review";
  if (/^Not shot/.test(r.stage)) return "Not shot yet";
  return "Waiting on editor";
}

function videoLines(v: VideoLines, words: (s: string) => string): ChecklistLine[] {
  const seen = new Set<string>();
  const lines: { line: ChecklistLine; rank: number; promise: string }[] = [];
  for (const r of [...v.due, ...v.sending]) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    const need = videoNeed(r);
    const asks = r.send?.openAsks.length ?? 0;
    const why = r.lane === "held" && r.heldWhy ? words(r.heldWhy)
      : asks > 0 ? `${asks} client request${asks === 1 ? "" : "s"} to check first`
      : need === "Ready to send" ? null
      : r.stage;
    lines.push({ rank: r.late ? 0 : r.lane === "sending" ? 2 : 1, promise: r.promiseISO ?? "9999", line: {
      key: `video:${r.key}`,
      title: `${r.street} · ${r.label}`,
      need,
      detail: [r.clientName, why].filter(Boolean).join(" · ") || null,
      when: r.late && r.lateHours != null ? `Late by ${lateWords(r.lateHours)}` : r.promiseISO && r.dueToday ? `Due ${etTime(new Date(r.promiseISO))} ET` : r.promiseWords,
      late: r.late,
      href: r.reviewHref ?? `/review/${r.projectId}`,
      action: { kind: "open", label: need === "Ready to send" ? "Send" : "Open" },
    } });
  }
  return lines.sort((a, b) => a.rank - b.rank || a.promise.localeCompare(b.promise)).map((x) => x.line);
}

// ---- asks ------------------------------------------------------------------------------

const MEDIUM_WORDS: Record<string, string> = { photo: "on the photos", video: "on the video", both: "on the photos and video", unclear: "before delivery" };

function askHref(a: AskView): string {
  if (!a.projectId) return `/clients/${a.clientId}`;
  return a.medium === "video" || a.medium === "both" ? `/review/${a.projectId}` : `/projects/${a.projectId}`;
}

function requestLine(a: AskView, clean: (s: string) => string): ChecklistLine {
  return {
    key: `ask:${a.id}`,
    title: clean(a.summary),
    need: `Check ${MEDIUM_WORDS[a.medium] ?? "before delivery"}`,
    detail: [a.street, a.clientName, a.holdsDelivery ? "holds delivery" : null].filter(Boolean).join(" · ") || null,
    when: a.dueWords ? `${a.behind ? "Was due" : "Due"} ${a.dueWords}` : null,
    late: a.behind,
    href: askHref(a),
    action: { kind: "ask", id: a.id, askKind: "SPECIAL_REQUEST" },
  };
}

function schedulingLine(a: AskView, clean: (s: string) => string): ChecklistLine {
  return {
    key: `ask:${a.id}`,
    title: clean(a.summary),
    need: "Book, move or cancel",
    detail: [a.street, a.clientName, a.sourceWords].filter(Boolean).join(" · ") || null,
    when: `Asked ${a.whenWords}`,
    late: a.behind,
    href: a.projectId ? `/projects/${a.projectId}` : `/clients/${a.clientId}`,
    action: { kind: "ask", id: a.id, askKind: "SCHEDULING" },
  };
}

/** Tomorrow's shoots with no confirmation text sent (the hub's own test:
 *  clientTextSweeps counts a shoot confirmed once a confirmation_text task is
 *  COMPLETED). One indexed read. */
async function tomorrowUnconfirmed(now: Date, excludeClientIds: string[]) {
  const start = nextEtDayStart(now);
  const end = nextEtDayStart(start);
  return prisma.project.findMany({
    where: {
      shootDate: { gte: start, lt: end },
      status: { notIn: ["CANCELLED", "ON_HOLD"] },
      aryeoMissingAt: null,
      ...(excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {}),
      smartTasks: { none: { taskType: "confirmation_text", status: "COMPLETED" } },
    },
    select: { id: true, title: true, shootDate: true, client: { select: { name: true } } },
    orderBy: { shootDate: "asc" },
  });
}

// ---- done today ----------------------------------------------------------------------

async function asksClosedToday(now: Date, excludeClientIds: string[]) {
  const start = etDayStartUtc(now);
  const rows = await prisma.clientAsk.findMany({
    where: {
      state: { in: ["DONE", "CONFIRMED", "NOT_NEEDED"] },
      OR: [{ doneAt: { gte: start } }, { confirmedAt: { gte: start } }],
      ...(excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {}),
    },
    select: { id: true, kind: true, state: true, summary: true, text: true, doneAt: true, doneBy: true, confirmedAt: true, confirmedBy: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return rows;
}

async function repliesToday(now: Date, excludeClientIds: string[]) {
  return prisma.smartTask.findMany({
    where: {
      taskType: "client_reply",
      status: "COMPLETED",
      completedAt: { gte: etDayStartUtc(now) },
      ...(excludeClientIds.length ? { OR: [{ clientId: null }, { clientId: { notIn: excludeClientIds } }] } : {}),
    },
    select: { id: true, title: true, completedAt: true, clientId: true, client: { select: { name: true } } },
    orderBy: { completedAt: "desc" },
    take: 100,
  });
}

const isToday = (iso: string | null | undefined, now: Date) => !!iso && etDayKey(new Date(iso)) === etDayKey(now);

// ---- the checklist ---------------------------------------------------------------------

/**
 * Kyle's daily checklist, and the summary box above it. `person` is whose
 * follow-ups and earlier items these are (the signed-in person on their own
 * Home; Kyle on Jordan's). Deliveries, messages, requests and scheduling are
 * the office's, so everybody's list holds the same ones. Each source fails on
 * its own: one unreadable source greys one group (or one number), never the
 * whole list.
 */
export async function kyleChecklist(opts: {
  now?: Date;
  excludeClientIds?: string[];
  person: ChecklistPerson;
  /** take figures out of what people typed (everyone but the owner) */
  scrub?: boolean;
  roster?: Assignee[];
  /** the reader's first name: other screens' words about them ("Waiting on
   *  Kyle to confirm") read "you" on their own Home */
  you?: string | null;
  /** also read the jobs a request can be added to by hand (Kyle's own Home) */
  withRequestJobs?: boolean;
}): Promise<KyleChecklist> {
  const now = opts.now ?? new Date();
  const ex = opts.excludeClientIds ?? [];
  const scope = { excludeClientIds: ex };
  const clean = (s: string) => (opts.scrub ? scrubMoney(s) : s);
  // Only the hub's own words about the reader (a held video's reason) turn to
  // "you"; what a client or a teammate wrote is never rewritten.
  const name = opts.you && /^[A-Za-z]{2,30}$/.test(opts.you) ? opts.you : null;
  const hubWords = (s: string) => {
    const t = clean(s);
    if (!name) return t;
    return t
      .replace(new RegExp(`\\b${name} has\\b`, "g"), "you have")
      .replace(new RegExp(`\\b${name} is\\b`, "g"), "you are")
      .replace(new RegExp(`\\b${name}['’]s\\b`, "g"), "your")
      .replace(new RegExp(`\\b${name}\\b`, "g"), "you");
  };
  const warn = (what: string) => (e: unknown) => {
    console.warn(`opsHome: ${what} failed`, (e as Error)?.message);
    return null;
  };
  const [queue, video, vrows, waiting, special, sched, unconfirmed, olderQc, tasks, closedTasks, closedAsks, replies] = await Promise.all([
    loadQueue({ now }).catch(warn("photo queue")),
    videoSummary(now).catch(warn("video summary")),
    videoRows(now).catch(warn("video rows")),
    waitingClients(now, scope).catch(warn("waiting clients")),
    // The full board when the hand-add form needs its job list (it also reads
    // the week's closed requests); the open requests alone otherwise.
    specialRequestsBoard(now, { countsOnly: !opts.withRequestJobs }).catch(warn("special requests")),
    schedulingBoard(now, { countsOnly: true }).catch(warn("scheduling")),
    tomorrowUnconfirmed(now, ex).catch(warn("tomorrow's confirmations")),
    prisma.smartTask.count({ where: photoQcWhere(scope) }).catch(() => 0),
    checklistTasks(now, { person: opts.person, excludeClientIds: ex, scrub: opts.scrub, roster: opts.roster }).catch(warn("tasks")),
    checklistTasksClosedToday(now, { person: opts.person, excludeClientIds: ex, scrub: opts.scrub }).catch(warn("tasks closed today")),
    asksClosedToday(now, ex).catch(warn("asks closed today")),
    repliesToday(now, ex).catch(warn("replies today")),
  ]);

  // ---- the summary box ----
  const pc = queue ? photoCountsFromQueue(queue, now) : null;
  const summary: HomeSummary = {
    photos: pc ? { dueToday: pc.dueToday, late: pc.behind, olderQc } : null,
    videos: video ? { readyToSend: video.readyToSend, late: video.late, dueToday: video.dueToday } : null,
    messages: waiting
      ? { waiting: waiting.length, behind: waiting.filter((w) => w.behind).length, oldestHours: waiting[0]?.group.oldestHours ?? null }
      : null,
  };

  // ---- the five groups ----
  const group = (key: ChecklistGroupKey, lines: ChecklistLine[], unavailable: boolean, later: ChecklistLine[] = []): ChecklistGroup => {
    const def = CHECKLIST_GROUPS.find((g) => g.key === key)!;
    return { key, title: def.title, empty: def.empty, lines, later, unavailable };
  };
  const deliveries = [...(queue ? photoLines(queue, now) : []), ...(vrows ? videoLines(vrows, hubWords) : [])]
    // late first, across photos and videos
    .sort((a, b) => Number(b.late) - Number(a.late));

  const messages: ChecklistLine[] = (waiting ?? []).map((w) => {
    const latest = w.group.items[w.group.items.length - 1];
    return {
      key: `msg:${w.family}:${w.group.groupKey}`,
      title: w.group.clientName,
      need: w.family === "email" ? "Answer the email" : "Answer the text",
      detail: latest ? `"${clean(latest.subject ? `${latest.subject}: ${latest.snippet}` : latest.snippet).slice(0, 120)}"` : null,
      when: `Waiting ${waitedWords(w.group.oldestHours)}`,
      late: w.behind,
      href: replyHref(w.family),
      action: { kind: "reply", clientId: w.group.clientId, family: w.family, groupKey: w.group.groupKey },
    };
  });

  // Special requests on jobs going out soon (behind, due today or tomorrow);
  // the rest fold under the group.
  const soonCut = nextEtDayStart(nextEtDayStart(now)).getTime();
  const asks = (special?.groups ?? []).flatMap((g) => g.asks);
  const soon = (a: AskView) => a.behind || a.dueToday || (!!a.dueAtISO && Date.parse(a.dueAtISO) < soonCut);
  const requestsNow = asks.filter(soon).map((a) => requestLine(a, clean));
  const requestsLater = asks.filter((a) => !soon(a)).map((a) => requestLine(a, clean));

  const scheduling: ChecklistLine[] = [
    // The client's own scheduling asks (a move seen in Aryeo is not an ask:
    // the appointment bell covers it; clientAsks.schedulingBoard).
    ...(sched?.asks ?? []).map((a) => schedulingLine(a, clean)),
    ...(unconfirmed ?? []).map((p) => ({
      key: `confirm:${p.id}`,
      title: p.title.split(",")[0].trim(),
      need: "Confirmation text not sent",
      detail: [p.client?.name ?? null, p.shootDate ? `shoot tomorrow ${etTime(p.shootDate)} ET` : "shoot tomorrow"].filter(Boolean).join(" · "),
      when: null,
      late: false,
      href: `/projects/${p.id}`,
      action: { kind: "open" as const, label: "Open" },
    })),
  ];

  // A waiting client's open reply task is that client's line under Messages.
  const onBoard = new Set((waiting ?? []).map((w) => w.group.openTaskId).filter((x): x is string => !!x));
  const followups: ChecklistLine[] = (tasks?.dueToday ?? []).filter((t) => !onBoard.has(t.id)).map((t) => ({
    key: `task:${t.id}`,
    title: t.title,
    need: t.kind,
    detail: t.projectTitle,
    when: t.dueISO && etDayKey(new Date(t.dueISO)) === etDayKey(now) ? `Due ${etTime(new Date(t.dueISO))} ET` : t.pushedToISO ? "Moved to today" : "Due today",
    late: false,
    href: t.href,
    action: { kind: "task", id: t.id },
  }));
  const earlier = (tasks?.earlier ?? []).filter((t) => !onBoard.has(t.id));

  const groups = [
    group("deliveries", deliveries, !queue || !vrows),
    group("messages", messages, !waiting),
    group("requests", requestsNow, !special, requestsLater),
    group("scheduling", scheduling, !sched || !unconfirmed),
    group("followups", followups, !tasks),
  ];

  // ---- done today, by anyone ----
  const done: DoneLine[] = [];
  for (const c of queue?.columns.find((x) => x.key === "delivered")?.cards ?? []) {
    if (isToday(c.deliveredAt, now)) done.push({ key: `photo:${c.id}`, title: `${c.street} · photos`, what: "Photos delivered", atISO: c.deliveredAt, by: null, href: `/ops/photo-delivery/${c.id}`, reopenAskId: null });
  }
  for (const r of vrows?.delivered ?? []) {
    if (isToday(r.deliveredAtISO, now)) done.push({ key: `video:${r.key}`, title: `${r.street} · ${r.label}`, what: "Video sent", atISO: r.deliveredAtISO, by: r.deliveredBy, href: r.reviewHref ?? `/review/${r.projectId}`, reopenAskId: null });
  }
  for (const t of replies ?? []) {
    done.push({ key: `reply:${t.id}`, title: t.client?.name ?? clean(t.title), what: "Client answered", atISO: t.completedAt?.toISOString() ?? null, by: null, href: t.clientId ? `/clients/${t.clientId}` : null, reopenAskId: null });
  }
  for (const a of closedAsks ?? []) {
    const at = a.state === "CONFIRMED" ? a.confirmedAt : a.doneAt;
    const what = a.state === "NOT_NEEDED" ? "Not needed" : a.kind === "SCHEDULING" ? "Scheduling handled" : a.state === "CONFIRMED" ? "Request checked" : "Request done";
    done.push({
      key: `ask:${a.id}`, title: clean(a.summary?.trim() || a.text.replace(/\s+/g, " ").slice(0, 140)), what,
      atISO: at?.toISOString() ?? null, by: (a.state === "CONFIRMED" ? a.confirmedBy : a.doneBy) ?? null, href: null, reopenAskId: a.id,
    });
  }
  for (const t of closedTasks ?? []) {
    done.push({ key: `task:${t.id}`, title: t.title, what: t.how === "done" ? `${t.kind} done` : `${t.kind}: not needed`, atISO: t.atISO, by: null, href: t.href, reopenAskId: null });
  }
  done.sort((a, b) => (b.atISO ?? "").localeCompare(a.atISO ?? ""));

  // ---- still open ----
  const parts = [
    ...groups.map((g) => ({ key: g.key as ChecklistGroupKey | "earlier", title: g.title, count: g.lines.length })),
    { key: "earlier" as const, title: "From earlier days", count: earlier.length },
  ];
  return {
    nowISO: now.toISOString(),
    summary,
    groups,
    earlier: { items: earlier, unavailable: !tasks },
    done,
    doneUnavailable: !closedTasks || !closedAsks || !replies || !queue || !vrows,
    stillOpen: { total: parts.reduce((n, p) => n + p.count, 0), parts: parts.filter((p) => p.count > 0) },
    requestJobs: opts.withRequestJobs && special ? special.jobs.map((j) => ({ id: j.id, label: clean(j.label) })) : null,
  };
}

/** "3 deliveries, 2 messages, 1 follow-up": the still-open line in words. */
export function stillOpenWords(parts: KyleChecklist["stillOpen"]["parts"]): string {
  const NOUN: Record<string, [string, string]> = {
    deliveries: ["delivery", "deliveries"], messages: ["message", "messages"], requests: ["request", "requests"],
    scheduling: ["scheduling item", "scheduling items"], followups: ["follow-up", "follow-ups"], earlier: ["item from earlier days", "items from earlier days"],
  };
  return parts.map((p) => plural(p.count, NOUN[p.key][0], NOUN[p.key][1])).join(", ");
}

// ---- THE OWNER'S WEEK (Jordan: "I want a way to see on my side how we're doing
// this week, what we're behind on") --------------------------------------------------

export type WeekStats = {
  /** shoots on the calendar from Monday to now (cancelled ones out) */
  shoots: number;
  photos: { delivered: number; judged: number; onTime: number; onTimePct: number | null };
  listingVideos: { delivered: number; judged: number; onTime: number; onTimePct: number | null };
  monthlyVideos: number;
  replies: { inbound: number; fast: number; fastPct: number | null };
  revisions: number;
};

export type OwnerWeek = {
  startISO: string;
  nowISO: string;
  thisWeek: WeekStats;
  /** last week from its Monday to the same point in the week */
  lastWeek: WeekStats;
};

/** An on-time figure in words: hidden until ON_TIME_MIN_JOBS jobs had a promise
 *  to judge (Jordan, Oct 19: one late job of two read as "50% on time"). */
export function onTimeWords(s: { judged: number; onTimePct: number | null }): string {
  if (s.judged < ON_TIME_MIN_JOBS || s.onTimePct == null) return "too few to judge";
  return `${s.onTimePct}% on time`;
}

/** Monday 00:00 ET of the week holding `now`. */
export function etWeekStart(now: Date): Date {
  const dow = new Date(`${etDayKey(now)}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7;
  const noon = new Date(etDayStartUtc(now).getTime() + 12 * HOUR);
  return etDayStartUtc(new Date(noon.getTime() - back * 24 * HOUR));
}

const pct = (ok: number, total: number) => (total ? Math.round((ok / total) * 100) : null);

async function weekStats(start: Date, end: Date, excludeClientIds: string[]): Promise<WeekStats> {
  const clientScope = excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {};
  const excludedProjectIds = excludeClientIds.length
    ? (await prisma.project.findMany({ where: { clientId: { in: excludeClientIds } }, select: { id: true } })).map((p) => p.id)
    : [];
  const projectScope = excludedProjectIds.length ? { projectId: { notIn: excludedProjectIds } } : {};
  const [shoots, photoJobs, outputs, texts, revisions] = await Promise.all([
    prisma.project.count({ where: { shootDate: { gte: start, lt: end }, status: { not: "CANCELLED" }, ...clientScope } }),
    prisma.photoJob.findMany({ where: { deliveredAt: { gte: start, lt: end }, ...projectScope }, select: { deliveredAt: true, slaDueAt: true } }),
    prisma.deliverableOutput.findMany({ where: { deliveredAt: { gte: start, lt: end }, category: "VIDEO", ...projectScope }, select: { projectId: true, deliveredAt: true } }),
    // Texts only, paired per client: the 30-day reply dial's own rule
    // (queries.getOwnerPulse), on this window. An hour past the end is read so
    // an answer to the window's last message can still pair.
    prisma.commLog.findMany({
      where: {
        channel: "text", occurredAt: { gte: start, lt: new Date(end.getTime() + HOUR) },
        clientId: { not: null, ...(excludeClientIds.length ? { notIn: excludeClientIds } : {}) },
        ...(excludedProjectIds.length ? { OR: [{ projectId: null }, { projectId: { notIn: excludedProjectIds } }] } : {}),
      },
      select: { direction: true, clientId: true, occurredAt: true },
      orderBy: { occurredAt: "asc" },
    }),
    // A revision ASKED FOR: one RevisionBrief per client ask. The office's
    // own notes and system rows are not asks.
    prisma.revisionBrief.count({
      where: {
        createdAt: { gte: start, lt: end },
        OR: [{ requestedByKind: null }, { requestedByKind: { notIn: ["OFFICE", "SYSTEM"] } }],
        ...(excludeClientIds.length ? { project: { clientId: { notIn: excludeClientIds } } } : {}),
      },
    }),
  ]);
  const photosJudged = photoJobs.filter((p) => p.slaDueAt);
  const photosOnTime = photosJudged.filter((p) => p.deliveredAt! <= p.slaDueAt!).length;

  const projects = outputs.length
    ? await prisma.project.findMany({
        where: { id: { in: [...new Set(outputs.map((o) => o.projectId))] } },
        select: { id: true, contentMonthId: true, packageName: true, deliveryDue: true, promisedDueAt: true, shootDate: true, deliverables: { select: { type: true, label: true } } },
      })
    : [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const monthly = (p: (typeof projects)[number] | undefined) => !!p && (!!p.contentMonthId || isMonthlyContentJob(p.deliverables, p.packageName));
  const listing = outputs.filter((o) => !monthly(byId.get(o.projectId)));
  // The promise the job was sold under, else the live due: the 30-day
  // on-time dial's rule (getOwnerPulse promiseOf).
  const promiseOf = (id: string) => {
    const p = byId.get(id);
    return p ? pinnedPromise(p) ?? p.deliveryDue : null;
  };
  const listingJudged = listing.filter((o) => promiseOf(o.projectId));
  const listingOnTime = listingJudged.filter((o) => o.deliveredAt! <= promiseOf(o.projectId)!).length;

  const byClient = new Map<string, { dir: string; at: number }[]>();
  for (const t of texts) {
    const arr = byClient.get(t.clientId!) ?? [];
    arr.push({ dir: t.direction, at: t.occurredAt.getTime() });
    byClient.set(t.clientId!, arr);
  }
  let inbound = 0, fast = 0;
  for (const events of byClient.values()) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].dir !== "in" || events[i].at >= end.getTime()) continue;
      inbound++;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].dir !== "out") continue;
        if (events[j].at - events[i].at <= HOUR) fast++;
        break;
      }
    }
  }
  return {
    shoots,
    photos: { delivered: photoJobs.length, judged: photosJudged.length, onTime: photosOnTime, onTimePct: pct(photosOnTime, photosJudged.length) },
    listingVideos: { delivered: listing.length, judged: listingJudged.length, onTime: listingOnTime, onTimePct: pct(listingOnTime, listingJudged.length) },
    monthlyVideos: outputs.length - listing.length,
    replies: { inbound, fast, fastPct: pct(fast, inbound) },
    revisions,
  };
}

/** This week (Monday to now, ET) beside last week to the same point. */
export async function ownerWeek(now: Date = new Date(), opts: { excludeClientIds?: string[] } = {}): Promise<OwnerWeek> {
  const start = etWeekStart(now);
  const lastStart = etWeekStart(new Date(start.getTime() - 3 * 24 * HOUR));
  const lastEnd = new Date(lastStart.getTime() + (now.getTime() - start.getTime()));
  const ex = opts.excludeClientIds ?? [];
  const [thisWeek, lastWeek] = await Promise.all([weekStats(start, now, ex), weekStats(lastStart, lastEnd, ex)]);
  return { startISO: start.toISOString(), nowISO: now.toISOString(), thisWeek, lastWeek };
}

