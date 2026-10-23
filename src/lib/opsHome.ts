import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { type JobCounts } from "@/lib/opsCounts";
import { dueTodayRows, videoDeliveryBoard, videoSummary, type VideoDeliveryBoard, type VideoRow } from "@/lib/videoDelivery";
import { HOLD_REASON_LABEL } from "@/components/photoDelivery/format";
import { schedulingBoard, specialRequestsBoard, type AskView } from "@/lib/clientAsks";
import { loadQueue } from "@/app/ops/photo-delivery/data";
import type { QueueColumnKey, QueueData } from "@/components/photoDelivery/types";
import { unansweredCommsBoards, type CommsGroup } from "@/lib/commsBoard";
import { waitingReplyHref } from "@/components/comms/messagesNav";
import { normalizeSubject } from "@/components/comms/emailThreads";
import { getReviewQueue, type ReviewQueue } from "@/lib/reviewRoom";
import { jobsBoard, type JobRow, type JobsBoard } from "@/lib/jobsBoard";
import { scrubMoney } from "@/lib/text";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { pinnedPromise } from "@/lib/turnaround";
import { etDayKey, etDayStartUtc, etTime } from "@/lib/datetime";
import { CHECKLIST_PATH } from "@/lib/homeAnchors";
import type { Assignee } from "@/lib/assignees";
import {
  checklistTasks, checklistTasksClosedToday, listOldItems, type ChecklistPerson, type OldItem, type OldItemsRead,
} from "@/lib/taskAging";

// ---------------------------------------------------------------------------
// THE DASHBOARD AND KYLE'S LIST, Oct 19 2026 (night). Jordan: "The home page
// should really be a dashboard to oversee everything going on, and then the
// other pages are for more in-depth adjustments and changes. The biggest
// things are making sure we are delivering on time, responding to clients
// quickly, keeping track of special requests, delegating them to the right
// people/departments, and ensuring QC and reviews are done well and catching
// issues. I don't want to overload the users of this hub with analysis
// paralysis."
//
// This module builds:
//   · THE DASHBOARD ("/", the owner and every office login): four health
//     tiles, each its screen's own source (buildDashboard says which), the
//     shoots in progress (lib/jobsBoard, the Shoots page's own rows), and
//     "Needs attention now": at most five things, each with who owns it and
//     one action;
//   · KYLE'S DAILY CHECKLIST, on its own page since that night
//     (CHECKLIST_PATH, "Your list" / "Kyle's list"): one list for today in
//     five groups (Deliveries, Messages to answer, Special requests to check,
//     Scheduling to handle, Follow-ups due), then "From earlier days, still
//     open", then what was done today and what is still open. The dashboard's
//     "Kyle's day" card reads its two numbers from the same list, so the two
//     screens can never disagree;
//   · the owner's week (this week against last).
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

// ---- WHERE THE RETIRED PAGES SEND A PERSON ------------------------------------------

/** Where a retired page (/ops/requests, /ops/scheduling, /ops/old) sends a
 *  person now: the matching group on the daily checklist (CHECKLIST_PATH: an
 *  office login's own list, Kyle's for the owner). The "pushed 3 times" bell
 *  (/ops/old?who=all) is about anyone's item, so it opens everyone's tasks. */
export function checklistDoor(group: "requests" | "scheduling" | "earlier", opts: { everyone?: boolean } = {}): string {
  if (group === "earlier" && opts.everyone) return "/tasks?tab=work&who=all";
  return `${CHECKLIST_PATH}#${group}`;
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

// ONE READ PER PAGE RENDER (Oct 20 2026, audit A3). The dashboard's tiles and
// its "Kyle's day" card (the whole checklist, for two numbers) read the same
// photo queue and the same waiting clients (two comms boards each), so every
// render, and the page refreshes itself every 90 seconds, did each of them
// twice. React's cache() shares one read within one render, keyed by the
// clock and the scope; outside a render (a drill, a cron) it reads each time.
const queueOnce = cache((nowMs: number) => loadQueue({ now: new Date(nowMs) }));
const photoQueue = (now: Date) => queueOnce(now.getTime());

const waitingOnce = cache(async (nowMs: number, ex: string): Promise<WaitingClient[]> => {
  const now = new Date(nowMs);
  const scope = { excludeClientIds: ex ? ex.split(",") : [] };
  // One slice of the request's one comms scan, both families (audit F4).
  const { phone, email } = await unansweredCommsBoards(now, scope);
  // A thread on a holding line ("I'll confirm soon", audit H4) is behind once
  // its answer is past due, however young the question; until then it is not.
  const behindOf = (g: CommsGroup) => (g.holding ? g.holding.overdue : g.oldestHours >= MESSAGE_BEHIND_HOURS);
  return [
    ...phone.map((g) => ({ family: "phone" as const, group: g, behind: behindOf(g) })),
    ...email.map((g) => ({ family: "email" as const, group: g, behind: behindOf(g) })),
  ].sort((a, b) => b.group.oldestHours - a.group.oldestHours);
});

/** The clients waiting on a reply, text and email together, longest wait first.
 *  The dashboard, the checklist's Messages group and the Messages screen all read this. */
async function waitingClients(now: Date, opts: { excludeClientIds?: string[] } = {}): Promise<WaitingClient[]> {
  return waitingOnce(now.getTime(), (opts.excludeClientIds ?? []).join(","));
}

/** Where a waiting client's Reply goes: that exact thread on Messages
 *  (/communications): a text opens the Texts view with that conversation
 *  open, an email the Email view with that thread open. The same address as
 *  Messages' own Waiting on us rows (components/comms/WaitingOnUs
 *  waitingRowReplyHref; the email key is its emailFocusKey). */
export function waitingClientReplyHref(w: WaitingClient, includeTest = false): string {
  const latest = w.group.items[w.group.items.length - 1];
  return waitingReplyHref(w.family, w.family === "email" ? `${normalizeSubject(latest?.subject)}::${w.group.clientId}` : w.group.groupKey, includeTest);
}

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
  /** Reply opens that client's thread on Messages (`href`); Handled closes the wait. */
  | { kind: "reply"; clientId: string; family: "phone" | "email"; groupKey: string; href: string }
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
        // In words, as the Photos screens say it (audit A18: "On hold: CREDITS").
        need: col.key === "hold" && c.holdReason ? `On hold: ${HOLD_REASON_LABEL[c.holdReason] ?? c.holdReason.toLowerCase()}` : n.need,
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
  if (r.lane === "finishing") return "In the Topaz pass";
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
 *  clientTextSweeps counts a shoot handled once a confirmation_text task is
 *  COMPLETED or CANCELLED, "Not needed"). One indexed read, with the open
 *  confirmation task, so the line can be closed from the list. */
async function tomorrowUnconfirmed(now: Date, excludeClientIds: string[]) {
  const start = nextEtDayStart(now);
  const end = nextEtDayStart(start);
  return prisma.project.findMany({
    where: {
      shootDate: { gte: start, lt: end },
      status: { notIn: ["CANCELLED", "ON_HOLD"] },
      aryeoMissingAt: null,
      ...(excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {}),
      // Oct 20 2026 (audit A7): "Not needed" (Kyle confirmed by phone) is
      // handled too, as the sweep reads it; COMPLETED alone nagged until the
      // shoot day passed with nothing on the line to clear it.
      smartTasks: { none: { taskType: "confirmation_text", status: { in: ["COMPLETED", "CANCELLED"] } } },
    },
    select: {
      id: true, title: true, shootDate: true, client: { select: { name: true } },
      smartTasks: { where: { taskType: "confirmation_text", status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
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
 * Kyle's daily checklist (and the old summary box's numbers). `person` is whose
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
  const [queue, vrows, waiting, special, sched, unconfirmed, tasks, closedTasks, closedAsks, replies] = await Promise.all([
    photoQueue(now).catch(warn("photo queue")),
    videoRows(now).catch(warn("video rows")),
    waitingClients(now, scope).catch(warn("waiting clients")),
    // The full board when the hand-add form needs its job list (it also reads
    // the week's closed requests); the open requests alone otherwise.
    specialRequestsBoard(now, { countsOnly: !opts.withRequestJobs }).catch(warn("special requests")),
    schedulingBoard(now, { countsOnly: true }).catch(warn("scheduling")),
    tomorrowUnconfirmed(now, ex).catch(warn("tomorrow's confirmations")),
    checklistTasks(now, { person: opts.person, excludeClientIds: ex, scrub: opts.scrub, roster: opts.roster }).catch(warn("tasks")),
    checklistTasksClosedToday(now, { person: opts.person, excludeClientIds: ex, scrub: opts.scrub }).catch(warn("tasks closed today")),
    asksClosedToday(now, ex).catch(warn("asks closed today")),
    repliesToday(now, ex).catch(warn("replies today")),
  ]);

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
      href: waitingClientReplyHref(w),
      action: { kind: "reply", clientId: w.group.clientId, family: w.family, groupKey: w.group.groupKey, href: waitingClientReplyHref(w) },
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
      // Done or Not needed on its confirmation task; Open when none was made.
      action: p.smartTasks[0] ? { kind: "task" as const, id: p.smartTasks[0].id } : { kind: "open" as const, label: "Open" },
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


// ---- THE DASHBOARD ("/", Oct 19 2026, night) ----------------------------------------
//
// THE RULE FOR EVERY NUMBER (audit fault #9, Sep 2 2026) still holds: each
// figure is computed by the function that builds the screen it opens.
//   On time          → jobsBoard().counts            (/jobs, "Shoots")
//   Clients waiting  → messagesBoard().waiting       (Messages)
//   Special requests → jobsBoard rows' open requests  (/jobs?f=requests); the
//                      asks on no job are their own line under Needs attention
//   QC & review      → getReviewQueue().pending      ("To review" on /review)
//                      videoSummary().readyToSend    ("Ready to send" on /review)
//                      loadQueue() QC columns        (/ops/photo-delivery)
// Each source fails on its own: one unreadable source greys its own tile
// ("Couldn't load"), never the page, and never reads as a reassuring 0.

/** At most this many lines in "Needs attention now" (Jordan: no analysis paralysis). */
export const ATTENTION_MAX = 5;
/** Shoots in progress shown on the dashboard; the rest are one tap away on /jobs. */
export const DASHBOARD_ROWS = 10;
/** Late jobs: this many, or one this many days late, is red; fewer is amber.
 *  The same line the team's "very behind" alert draws (lib/behindAlert). */
export const VERY_LATE_COUNT = 3;
export const VERY_LATE_DAYS = 2;
/** Photo delivery columns that are "in QC": landed and checked, a decision
 *  owed, or checked and waiting for Kyle's review (photo-delivery/data). */
export const PHOTO_QC_COLUMNS: readonly QueueColumnKey[] = ["qc", "decision", "ready"];

export type Tone = "ok" | "warn" | "bad";

export type DashboardHealth = {
  /** null = the source could not be read */
  onTime: (JobsBoard["counts"] & { tone: Tone }) | null;
  clients: { waiting: number; behind: number; oldestHours: number | null; email: number; text: number; tone: Tone } | null;
  /** counted off the Shoots board's rows (the Requests filter it opens); `notOnJob` = open asks no job holds yet */
  requests: { open: number; behind: number; shoots: number; needOwner: number; notOnJob: number | null; tone: Tone } | null;
  qc: {
    /** cuts waiting on a verdict (the Video Review Room's "To review"); null = could not be read */
    toReview: number | null;
    /** listing videos approved and ready to send */
    readyToSend: number | null;
    /** photo sets checked or being checked, not yet delivered */
    photosInQc: number | null;
    /** of the above, past their promise */
    late: number;
    tone: Tone;
    href: string;
  } | null;
};

export type AttentionItem = {
  key: string;
  tone: "bad" | "warn";
  /** the bold start ("Barry Rd video:") */
  lead: string;
  text: string;
  /** who owns it, and a few words ("Kyle · 2 client requests") */
  owner: string;
  action: { label: string; href: string };
};

export type Dashboard = {
  nowISO: string;
  health: DashboardHealth;
  jobs: { rows: JobRow[]; total: number; unavailable: boolean };
  attention: { items: AttentionItem[]; more: number; unavailable: string[] };
};

const plural0 = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** On time: red when three or more are late or one is two days late; amber
 *  for one or two; green when nothing is late. */
export function onTimeTone(c: { late: number; oldestLateDays: number | null }): Tone {
  if (c.late <= 0) return "ok";
  return c.late >= VERY_LATE_COUNT || (c.oldestLateDays ?? 0) >= VERY_LATE_DAYS ? "bad" : "warn";
}

/** "John" from a stage chip like "Changes · John" (the Shoots board names who
 *  holds a video after the dot); null when the chip names nobody. */
export function chipPerson(label: string | null | undefined): string | null {
  const m = (label ?? "").match(/·\s*([A-Z][A-Za-z'’-]{1,20}(?: [A-Z][A-Za-z'’-]{1,20})?)\s*$/);
  return m ? m[1] : null;
}

/** Late first, then the nearest promise; a job with no date last. */
export function jobOrder(a: JobRow, b: JobRow): number {
  return Number(b.late) - Number(a.late) || (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999");
}

type DashboardOpts = {
  now?: Date;
  includeTest?: boolean;
  excludeClientIds: string[];
  /** who is reading: their own items and assigned cuts lead with "you" */
  viewer: { role: string; key: string | null; teamMemberId: string | null };
  /** the office's ops lead (Kyle), who owns sending, replies and routing */
  ops: { key: string | null; teamMemberId: string | null; name: string };
  roster?: Assignee[];
  /** take figures out of what people typed (everyone but the owner) */
  scrub?: boolean;
  /** "creative" (Oct 21 2026): the creative manager's dashboard. No client
   *  inbox read (Clients waiting is Kyle's), and Needs attention keeps the
   *  creative lines only: late videos, cuts to review, the reader's own old
   *  items. Sending, client replies and giving requests an owner stay on the
   *  office's dashboard. */
  focus?: "office" | "creative";
};

/**
 * The dashboard, from one pass of reads. Every read starts at once; each one
 * that fails is listed in `attention.unavailable` and greys its own tile.
 */
export async function buildDashboard(opts: DashboardOpts): Promise<Dashboard> {
  const now = opts.now ?? new Date();
  const ex = opts.excludeClientIds;
  const clean = (s: string) => (opts.scrub ? scrubMoney(s) : s);
  const warn = (what: string) => (e: unknown) => {
    console.warn(`dashboard: ${what} failed`, (e as Error)?.message);
    return null;
  };
  const current = Math.abs(now.getTime() - Date.now()) < 60_000;
  // The video board first, so the summary reads the same (memoised) board
  // instead of building it twice.
  const boardP: Promise<VideoDeliveryBoard | null> = videoDeliveryBoard(current ? {} : { now }).catch(warn("video board"));
  const isOwner = opts.viewer.role === "OWNER";
  const creative = opts.focus === "creative";
  const [jobs, messages, special, review, video, board, queue, old, todos] = await Promise.all([
    jobsBoard(now, { includeTest: !!opts.includeTest }).catch(warn("shoots board")),
    creative ? Promise.resolve(null) : messagesBoard({ now, excludeClientIds: ex, team: true }).catch(warn("messages")),
    specialRequestsBoard(now, { countsOnly: true }).catch(warn("special requests")),
    getReviewQueue({ includeTest: !!opts.includeTest }).catch(warn("review queue")) as Promise<ReviewQueue | null>,
    boardP.then(() => videoSummary(now)).catch(warn("video summary")),
    boardP,
    photoQueue(now).catch(warn("photo queue")),
    listOldItems(now, { excludeClientIds: ex, roster: opts.roster }).catch(warn("old items")) as Promise<OldItemsRead | null>,
    isOwner ? import("@/lib/ownerDay").then((m) => m.ownerTodoLists()).catch(warn("owner list")) : Promise.resolve(null),
  ]);

  const rows = (jobs?.rows ?? []).map((r) => (opts.scrub ? { ...r, street: clean(r.street), client: r.client ? clean(r.client) : r.client } : r));

  // ---- the four tiles ----
  const withRequests = rows.filter((r) => r.requests.open > 0);
  const needOwnerRows = rows.filter((r) => r.requests.needsOwner > 0);
  // Oct 20 2026 (audit A10): the tile counted every open ask (asks on no job,
  // test clients whatever the view) and opened /jobs with no requests filter,
  // so its number was on no page. It counts the Shoots rows it opens now
  // (/jobs?f=requests); "past due" is those rows' asks; the asks on no job are
  // a line of their own under Needs attention, opening Kyle's list.
  const rowIds = new Set(rows.map((r) => r.projectId));
  const openAsks = special ? special.groups.flatMap((g) => g.asks) : null;
  const requestsBehind = (openAsks ?? []).filter((a) => !!a.projectId && rowIds.has(a.projectId) && a.behind).length;
  const notOnJob = openAsks ? openAsks.filter((a) => !a.projectId).length : null;
  const qcCards = queue ? queue.columns.filter((c) => PHOTO_QC_COLUMNS.includes(c.key)).flatMap((c) => c.cards) : null;
  const photosLate = (qcCards ?? []).filter((c) => c.slaDueAt && Date.parse(c.slaDueAt) < now.getTime()).length;
  const sendingLate = (board?.lanes.sending ?? []).filter((r) => r.late).length;
  const toReview = review ? review.pending.length : null;
  const readyToSend = video ? video.readyToSend : null;
  const qcLate = photosLate + sendingLate;
  const waiting = messages?.waiting ?? null;
  const health: DashboardHealth = {
    onTime: jobs ? { ...jobs.counts, tone: onTimeTone(jobs.counts) } : null,
    clients: waiting
      ? {
          waiting: waiting.length,
          behind: waiting.filter((w) => w.behind).length,
          oldestHours: waiting[0]?.group.oldestHours ?? null,
          email: waiting.filter((w) => w.family === "email").length,
          text: waiting.filter((w) => w.family === "phone").length,
          tone: waiting.some((w) => w.behind) ? "bad" : waiting.length > 0 ? "warn" : "ok",
        }
      : null,
    requests: jobs
      ? {
          open: withRequests.reduce((n, r) => n + r.requests.open, 0),
          behind: requestsBehind,
          shoots: withRequests.length,
          needOwner: needOwnerRows.reduce((n, r) => n + r.requests.needsOwner, 0),
          notOnJob,
          tone: requestsBehind > 0 ? "bad" : withRequests.length > 0 ? "warn" : "ok",
        }
      : null,
    qc: toReview == null && readyToSend == null && qcCards == null
      ? null
      : {
          toReview,
          readyToSend,
          photosInQc: qcCards ? qcCards.length : null,
          late: qcLate,
          tone: qcLate > 0 ? "bad" : (toReview ?? 0) + (readyToSend ?? 0) > 0 ? "warn" : "ok",
          // Videos first while any wait (or could not be checked); else the photos.
          href: toReview == null || readyToSend == null || toReview + readyToSend > 0 || qcCards == null ? "/review" : "/ops/photo-delivery",
        },
  };

  // ---- shoots in progress: late first, the first DASHBOARD_ROWS ----
  const shown = [...rows].sort(jobOrder).slice(0, DASHBOARD_ROWS);

  // ---- needs attention now ----
  const viewerIsOps = (!!opts.ops.teamMemberId && opts.ops.teamMemberId === opts.viewer.teamMemberId) || (!!opts.ops.key && opts.ops.key === opts.viewer.key);
  const opsName = viewerIsOps ? "You" : opts.ops.name;
  const cand: (AttentionItem & { rank: number })[] = [];
  const add = (rank: number, item: AttentionItem) => cand.push({ ...item, rank });
  const lateText = (h: number | null) => (h == null ? "late" : `${lateWords(h)} late`);

  // 1. A video ready to send that has client requests to check, or is late.
  const sendRows = (board?.lanes.sending ?? [])
    .filter((r) => r.late || (r.send?.openAsks.length ?? 0) > 0)
    .sort((a, b) => Number(b.late) - Number(a.late) || (b.lateHours ?? 0) - (a.lateHours ?? 0) || (b.send?.openAsks.length ?? 0) - (a.send?.openAsks.length ?? 0));
  if (!creative && sendRows.length) {
    const r = sendRows[0];
    const n = r.send?.openAsks.length ?? 0;
    const more = sendRows.length - 1;
    add(0, {
      key: `send:${r.key}`,
      tone: r.late ? "bad" : "warn",
      lead: `${clean(r.street)} video:`,
      text: [
        n > 0 ? `check the client's ${n === 1 ? "request" : `${n} requests`}, then send it` : "ready to send",
        r.late ? lateText(r.lateHours) : null,
        more > 0 ? `${more} more like it` : null,
      ].filter(Boolean).join(" · "),
      owner: [opsName, n > 0 ? `${n} client ${plural0(n, "request")}` : "sending"].join(" · "),
      action: more > 0 ? { label: "Open Videos", href: "/review" } : { label: "Check & send", href: r.reviewHref ?? `/review/${r.projectId}` },
    });
  }

  // 2. The latest video that is late, with who holds it.
  const late = [...(board?.lanes.late ?? [])].sort((a, b) => (b.lateHours ?? 0) - (a.lateHours ?? 0));
  if (late.length) {
    const r = late[0];
    const more = late.length - 1;
    const inReview = r.cutStatus === "PENDING";
    const version = r.round ? `version ${r.round}` : "the video";
    const editor = chipPerson(rows.find((j) => j.projectId === r.projectId)?.video?.label);
    add(1, {
      key: `late:${r.key}`,
      tone: "bad",
      lead: `${clean(r.street)}:`,
      text: [
        inReview ? `${version} is ${lateText(r.lateHours)} and waiting on review` : `${version} is ${lateText(r.lateHours)}`,
        more > 0 ? `${more} more late` : null,
      ].filter(Boolean).join(" · "),
      owner: inReview ? "Review · the Video Review Room" : `${editor ?? "The editor"} · video editing`,
      // "Open in Videos", not "Remind John" (audit A6): the button only ever
      // opened the room; nothing was sent to anyone.
      action: inReview
        ? { label: "Review it", href: r.reviewHref ?? `/review/${r.projectId}` }
        : { label: "Open in Videos", href: "/review" },
    });
  }

  // 3. Cuts assigned to the reader to review (the review seat's own work).
  const mine = review && opts.viewer.teamMemberId
    ? review.pending.filter((c) => c.reviewer?.id === opts.viewer.teamMemberId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  if (mine.length) {
    const c = mine[0];
    const waitedH = Math.max(0, Math.round((now.getTime() - Date.parse(c.createdAt)) / HOUR));
    add(2, {
      key: "review-mine",
      tone: waitedH >= 24 ? "bad" : "warn",
      lead: `${mine.length} ${plural0(mine.length, "cut")}`,
      text: "assigned to you to review",
      owner: `You · oldest ${waitedWords(waitedH)}`,
      action: { label: "Review", href: `/review/${c.projectId}?cut=${c.id}` },
    });
  }

  // 3b. The creative manager's desk (Oct 21 2026): every cut waiting on a
  //     verdict, not only the ones assigned to them, oldest first.
  const othersWaiting = creative && review ? review.pending.filter((c) => !mine.some((m) => m.id === c.id)) : [];
  if (othersWaiting.length) {
    const oldest = [...othersWaiting].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const waitedH = Math.max(0, Math.round((now.getTime() - Date.parse(oldest.createdAt)) / HOUR));
    add(2, {
      key: "review-waiting",
      tone: waitedH >= 24 ? "bad" : "warn",
      lead: `${othersWaiting.length} ${plural0(othersWaiting.length, "cut")}`,
      text: mine.length ? "more waiting on review" : "waiting on review",
      owner: `The Video Review Room · oldest ${waitedWords(waitedH)}`,
      action: othersWaiting.length === 1 ? { label: "Review", href: `/review/${oldest.projectId}?cut=${oldest.id}` } : { label: "Open Videos", href: "/review" },
    });
  }

  // 4. Clients waiting on a reply.
  if (health.clients && health.clients.waiting > 0) {
    const c = health.clients;
    add(3, {
      key: "clients",
      tone: c.behind > 0 ? "bad" : "warn",
      lead: `${c.waiting} ${plural0(c.waiting, "client")}`,
      text: c.text === 0 ? "waiting on an email reply" : c.email === 0 ? "waiting on a text back" : "waiting on a reply",
      owner: `${opsName}${c.oldestHours != null ? ` · oldest ${waitedWords(c.oldestHours)}` : ""}`,
      action: { label: "Open", href: "/communications" },
    });
  }

  // 5. Client requests nobody owns yet.
  if (!creative && needOwnerRows.length) {
    const total = needOwnerRows.reduce((n, r) => n + r.requests.needsOwner, 0);
    const one = needOwnerRows.length === 1 ? [...needOwnerRows].sort(jobOrder)[0] : null;
    add(4, {
      key: "needs-owner",
      tone: needOwnerRows.some((r) => r.late) ? "bad" : "warn",
      lead: one ? `${one.street}:` : `${total} client ${plural0(total, "request")}`,
      text: one ? `${total} client ${plural0(total, "request")} with no owner yet` : `on ${needOwnerRows.length} shoots have no owner yet`,
      owner: `${opsName} · give each one an owner`,
      action: one ? { label: "Open shoot", href: one.href || `/projects/${one.projectId}` } : { label: "Open Shoots", href: "/jobs?f=requests" },
    });
  }

  // 5b. Client requests on no job yet: Kyle's list puts each on its job.
  if (!creative && notOnJob) {
    add(4, {
      key: "requests-no-job",
      tone: "warn",
      lead: `${notOnJob} client ${plural0(notOnJob, "request")}`,
      text: notOnJob === 1 ? "is not on a job yet" : "are not on a job yet",
      owner: `${opsName} · pick the job for each`,
      action: { label: "Open", href: `${CHECKLIST_PATH}#requests` },
    });
  }

  // 6. The reader's own items over a week old; for the owner, Kyle's too
  //    (and his own to-dos past their date).
  const person = (key: string | null) => (key ? old?.people.find((p) => p.key === key) ?? null : null);
  const me = person(opts.viewer.key);
  if (me && me.weekOld > 0) {
    add(5, {
      key: "old-mine",
      tone: "warn",
      lead: `${me.weekOld} of your items`,
      text: "are over a week old",
      owner: "You · your list",
      // The owner's own list on the checklist (Oct 21 2026, audit A9: one
      // home for earlier items, not /tasks); everyone else's is the default.
      // The creative manager has no checklist (Kyle's page): their own tasks.
      action: { label: "Open", href: creative ? "/tasks" : isOwner ? `${CHECKLIST_PATH}?who=me#earlier` : `${CHECKLIST_PATH}#earlier` },
    });
  }
  const opsOld = isOwner && !viewerIsOps ? person(opts.ops.key) : null;
  if (opsOld && opsOld.weekOld > 0) {
    add(6, {
      key: "old-ops",
      tone: "warn",
      lead: `${opsOld.weekOld} of ${opts.ops.name}'s items`,
      text: "are over a week old",
      owner: `${opts.ops.name} · their list`,
      action: { label: "Open", href: `${CHECKLIST_PATH}#earlier` },
    });
  }
  const pastDate = todos?.overdue.length ?? 0;
  if (pastDate > 0) {
    add(7, {
      key: "todos",
      tone: "warn",
      lead: `${pastDate} of your to-dos`,
      text: "are past their date",
      owner: "You · My Day",
      action: { label: "Open", href: "/day" },
    });
  }

  const ranked = cand.sort((a, b) => Number(b.tone === "bad") - Number(a.tone === "bad") || a.rank - b.rank);
  const items: AttentionItem[] = ranked.slice(0, ATTENTION_MAX).map((i) => ({ key: i.key, tone: i.tone, lead: i.lead, text: i.text, owner: i.owner, action: i.action }));
  const unavailable = [
    !board ? "videos" : null,
    !messages && !creative ? "client messages" : null,
    !jobs ? "shoots" : null,
    !review ? "the review queue" : null,
    !old ? "old items" : null,
  ].filter((x): x is string => !!x);

  return {
    nowISO: now.toISOString(),
    health,
    jobs: { rows: shown, total: jobs?.counts.total ?? 0, unavailable: !jobs },
    attention: { items, more: Math.max(0, ranked.length - ATTENTION_MAX), unavailable },
  };
}

export type KyleDay = { name: string; you: boolean; done: number; open: number; href: string };

/** "Kyle's day" on the dashboard (for Kyle himself, "Your list"): done today and
 *  still open, read from his own checklist, so the card and his list agree. */
export async function kyleDay(opts: {
  now?: Date;
  excludeClientIds: string[];
  ops: ChecklistPerson & { name: string };
  viewer: { key: string | null; teamMemberId: string | null };
  roster?: Assignee[];
  scrub?: boolean;
}): Promise<KyleDay> {
  const you = (!!opts.ops.teamMemberId && opts.ops.teamMemberId === opts.viewer.teamMemberId) || (!!opts.ops.key && opts.ops.key === opts.viewer.key);
  const list = await kyleChecklist({ now: opts.now, excludeClientIds: opts.excludeClientIds, person: opts.ops, roster: opts.roster, scrub: opts.scrub });
  return { name: opts.ops.name, you, done: list.done.length, open: list.stillOpen.total, href: you ? CHECKLIST_PATH : `${CHECKLIST_PATH}?who=kyle` };
}
