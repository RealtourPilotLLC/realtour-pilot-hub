import "server-only";
import { prisma } from "@/lib/prisma";
import { loadQueue } from "@/app/ops/photo-delivery/data";
import type { QueueCard, QueueColumnKey, QueueData } from "@/components/photoDelivery/types";
import { HOLD_REASON_LABEL } from "@/components/photoDelivery/format";
import { videoDeliveryBoard, type VideoDeliveryBoard, type VideoRow } from "@/lib/videoDelivery";
import { clientNotToldYet, type NotTold } from "@/lib/readyToSend";
import { deliveryNoticeIncidents, type DeliveryNoticeIncident } from "@/lib/deliveryNoticeIncidents";
import { unansweredCommsBoards, type CommsGroup } from "@/lib/commsBoard";
import { checklistTasks, checklistTasksClosedToday, personTaskWhere, type ChecklistPerson, type ClosedTask, type OldItem } from "@/lib/taskAging";
import { jobsBoard, type JobsBoard } from "@/lib/jobsBoard";
import { chipPerson, kylePerson, MESSAGE_BEHIND_HOURS, waitingClientReplyHref, waitedWords, lateWords } from "@/lib/opsHome";
import { remindViewsFor, REMIND_GAP_MS, type RemindView } from "@/lib/remindPhotographer";
import { parseAccessBrief, type AccessInfo } from "@/lib/opsDay";
import { parseEvidence } from "@/lib/statusEvidence";
import { briefStatusForAppointments, type BriefState } from "@/lib/photographerBrief";
import { expectedCrons, staleAfterMs, type CronJobHealth } from "@/lib/cronHealth";
import { scrubMoney } from "@/lib/text";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { listAssignees, viewerAssigneeKey, type Assignee } from "@/lib/assignees";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { etAt, etDate, etDateTime, etDayBoundsUtc, etDayKey, etDayStartUtc, etFullDate, etTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// KYLE'S DESK, Oct 23 2026: the office dashboard at "/" for Kyle (and any
// office login), built to Jordan's spec of that day. It answers three
// questions at once: what needs me, what do I do next, what counts as
// finished.
//
//   · the top: the date, how fresh the data is (a stale or failed sync says
//     so; it is never read as zero), one status line, and "Do next": at most
//     five items across every area, each with a plain reason, a due time and
//     one primary action;
//   · five tabs, each with an actionable count: QC & Delivery (grouped by
//     job, a status per asset), Client Replies, Shoot Prep (today through the
//     next business day), Follow-Ups (waiting on someone, each with a named
//     person and a follow-up time) and Closeout (a short checklist and the
//     day's summary).
//
// THE RULES (the spec's, in code):
//   · ONE ITEM PER UNDERLYING ACTION. Every item has a canonical id; Do next
//     holds the same objects the tabs hold, and a tab's count IS the length of
//     its "now" list (deskCounts says so, and the drill holds it).
//   · "now" needs Kyle; "waiting" is someone else's move with a named person
//     and a time it comes back (and it comes back into "now" and Do next when
//     that time passes); "ok" is ready (a shoot all set) and counted nowhere.
//   · Approved is not delivered, replied is not resolved, assigned is not
//     completed, waiting is not forgotten: the words on each asset and item
//     say which.
//   · Kyle never sees a figure (scrubMoney on everything people typed), does
//     not approve videos (James or Jordan do; Kyle sends what is approved),
//     and product setup is Jordan's (not on this desk at all).
// Every source fails on its own: a source that could not be read greys its
// own tab ("?") and is named in the freshness line, never shown as zero.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const DESK_TABS = [
  { key: "delivery", label: "QC & Delivery" },
  { key: "replies", label: "Client Replies" },
  { key: "prep", label: "Shoot Prep" },
  { key: "followups", label: "Follow-Ups" },
  { key: "closeout", label: "Closeout" },
] as const;
export type DeskTabKey = (typeof DESK_TABS)[number]["key"];

/** At most this many items in Do next (the spec: "up to five"). */
export const DO_NEXT_MAX = 5;
/** The order of the work (the spec): shoot blockers and urgent client issues,
 *  then overdue commitments, upcoming deadlines, routine work, housekeeping. */
export const RANK = { blocker: 0, overdue: 1, today: 2, routine: 3, housekeeping: 4 } as const;
/** Sync health is read for these jobs (vercel.json names). */
export const FRESH_JOBS = [
  { job: "aryeo", label: "Aryeo orders" },
  { job: "gmail", label: "Email and texts" },
  { job: "photo-delivery", label: "Photo delivery" },
] as const;

export const CLOSEOUT_ITEMS = [
  { key: "comms", label: "Communications reviewed" },
  { key: "deliveries", label: "Due deliveries done, or exceptions noted" },
  { key: "promises", label: "Every promise has an owner and a follow-up" },
  { key: "nextday", label: "Next business day prepared" },
  { key: "blockers", label: "Blockers escalated" },
] as const;
export type CloseoutKey = (typeof CLOSEOUT_ITEMS)[number]["key"];

/** The AppSetting row that holds one ET day's closeout ticks. */
export const closeoutSettingKey = (dayKey: string) => `office_closeout:${dayKey}`;
/** The AppSetting row naming who a task waits on (set with "Waiting on"). */
export const waitingSettingKey = (taskId: string) => `office_waiting:${taskId}`;
export const WAITING_PREFIX = "office_waiting:";

export type CloseoutRecord = { ticks: Partial<Record<CloseoutKey, { at: string; by: string }>>; finished?: { at: string; by: string } | null };
export type WaitingRecord = { who: string; role: "creative" | "owner" | "other"; note: string | null; at: string; by: string; followUpAt: string };

// ---- types ----------------------------------------------------------------------------

export type DeskState = "now" | "waiting" | "ok";

/** What a button does. Every kind is an EXISTING action (the server actions
 *  the screens already use); the side panel renders the matching control. */
export type DeskAction =
  | { kind: "photo-approve"; jobId: string; street: string }
  | { kind: "video-send"; submissionId: string; street: string; label: "Upload to Aryeo and send" | "Send" | "Try again"; openAsks: { summary: string; askedBy: string | null }[]; asksUnknown: boolean; listingWarning: string | null }
  | { kind: "video-push"; submissionId: string; canDeliverNow: boolean; canRelease: boolean }
  | { kind: "video-notice"; row: NotTold }
  | { kind: "reply"; threadKey: string; family: "phone" | "email"; clientId: string | null; groupKey: string; phone: string | null; href: string }
  | { kind: "task"; taskId: string; allowNewDate: boolean; canWait: boolean }
  | { kind: "ask"; askId: string; askKind: "SPECIAL_REQUEST" | "SCHEDULING" }
  | { kind: "remind"; projectId: string; street: string; view: RemindView }
  | { kind: "confirm"; taskId: string; outboxHref: string }
  /** the photographer brief's own "Send brief now" (one photographer, one ET day) */
  | { kind: "brief-send"; teamMemberId: string; day: string; name: string }
  | { kind: "link"; label: string; href: string };

export type AssetLine = {
  id: string;
  kind: "photos" | "floorplan" | "tour" | "video" | "notice";
  label: string;
  /** what is true right now, in words ("Approved by James, not sent yet") */
  status: string;
  tone: "now" | "waiting" | "done" | "failed";
  late: boolean;
  dueISO: string | null;
  /** whose move it is when it is not Kyle's */
  who: string | null;
  /** context, never a checklist: what the free photo check found, who approved */
  note: string | null;
  action: DeskAction | null;
};

export type PrepVisit = {
  apptId: string | null;
  projectId: string;
  street: string;
  client: string | null;
  dayKey: string;
  timeISO: string | null;
  endISO: string | null;
  over: boolean;
  photographer: string | null;
  photographerId: string | null;
  confirmation: { state: "sent" | "other" | "open" | "none" | "na"; words: string; taskId: string | null };
  access: { lockbox: string | null; access: string | null; presence: string | null; contactName: string | null; contactPhone: string | null };
  /** the services THIS visit covers (the appointment's own order items) */
  services: string[];
  servicesFrom: "visit" | "order" | "none";
  /** requests made before this visit, for it */
  requests: { text: string; whenISO: string }[];
  /** this visit's instructions from the order (special instructions, notes) */
  instructions: string[];
  /** folded: notes for the job's other visits, and order notes shared by every visit */
  earlier: { text: string; whenISO: string | null }[];
  /** changes asked after delivery: revisions, never this visit's requests */
  revisionsAfterDelivery: string[];
  conflicts: string[];
  gaps: string[];
  brief: { state: BriefState; words: string; why: string | null; href: string | null };
  otherVisits: { whenISO: string | null; services: string[] }[];
};

export type DeskPanel =
  | { kind: "job"; projectId: string; street: string; client: string | null; assets: AssetLine[]; findings: string[]; aryeoUrl: string | null }
  | { kind: "thread"; client: string; family: "phone" | "email"; messages: { atISO: string; text: string }[]; holding: string | null; revisionNote: string | null }
  | { kind: "visit"; visit: PrepVisit }
  | { kind: "task"; lines: { label: string; value: string }[] };

export type DeskItem = {
  /** canonical: one per underlying action ("job:<projectId>", "reply:phone:<key>", "task:<id>", "visit:<apptId>") */
  id: string;
  tab: DeskTabKey;
  state: DeskState;
  /** an instruction ("Review and deliver photos for 12 Oak St") */
  title: string;
  /** why, in one plain line */
  reason: string;
  /** whose move it is */
  who: string | null;
  dueISO: string | null;
  dueWords: string | null;
  late: boolean;
  rank: number;
  /** the one primary action (null on an "ok" item) */
  primary: { label: string; action: DeskAction } | null;
  /** every control the side panel offers, the primary first */
  actions: DeskAction[];
  /** the full screen, for when the panel is not enough */
  href: string | null;
  panel: DeskPanel;
  /** when it came onto the list, when known (for "new since you finished") */
  sinceISO: string | null;
  /** a waiting item that still lacks a named person or a follow-up time */
  needsFollowUp?: boolean;
};

export type DeskTab = {
  key: DeskTabKey;
  label: string;
  /** the actionable count: ALWAYS now.length, or null when the source could not be read */
  count: number | null;
  now: DeskItem[];
  waiting: DeskItem[];
  ok: DeskItem[];
  unavailable: string[];
};

export type Freshness = { key: string; label: string; state: "ok" | "stale" | "failed" | "unknown"; atISO: string | null; words: string };

export type CloseoutLine = {
  key: CloseoutKey;
  label: string;
  /** derived from the system: true done, false not yet, null not derivable */
  auto: boolean | null;
  autoWords: string;
  tick: { atISO: string; by: string } | null;
  done: boolean;
};

export type DaySummary = {
  completed: { what: string; count: number; examples: string[] }[];
  completedTotal: number;
  pending: { tab: string; now: number | null; waiting: number }[];
  blockers: string[];
  tomorrow: { dayWords: string; lines: string[] };
};

export type Closeout = {
  dayKey: string;
  lines: CloseoutLine[];
  allDone: boolean;
  finished: { atISO: string; by: string } | null;
  /** items that came onto the list after the day was finished (finishing never hides them) */
  newSinceFinish: number;
  summary: DaySummary;
};

export type OfficeDesk = {
  nowISO: string;
  dayKey: string;
  dateWords: string;
  person: string;
  /** who a creative question and a business question go to (first names) */
  people: { creative: string; owner: string };
  readOnly: boolean;
  freshness: Freshness[];
  unavailable: string[];
  status: { line: string; tone: "ok" | "warn" | "bad"; now: number; late: number; waiting: number };
  doNext: DeskItem[];
  tabs: DeskTab[];
  closeout: Closeout;
};

// ---- pure rules -----------------------------------------------------------------------

const dowOf = (dayKey: string) => new Date(`${dayKey}T12:00:00Z`).getUTCDay();
const nextKey = (dayKey: string) => new Date(Date.parse(`${dayKey}T12:00:00Z`) + DAY).toISOString().slice(0, 10);

/** Today, then every day up to and including the next business day (a
 *  weekday that is not a company holiday). On a Friday that is Saturday,
 *  Sunday and Monday: Monday's shoots are prepared on Friday, and a weekend
 *  shoot is never skipped on the way. */
export function prepDayKeys(now: Date, isHoliday: (dayKey: string) => boolean = () => false): string[] {
  const today = etDayKey(now);
  const out = [today];
  let k = today;
  for (let i = 0; i < 10; i++) {
    k = nextKey(k);
    out.push(k);
    const dow = dowOf(k);
    if (dow !== 0 && dow !== 6 && !isHoliday(k)) break;
  }
  return out;
}

/** The next business day's key (the last of prepDayKeys). */
export const nextBusinessDayKey = (now: Date, isHoliday?: (dayKey: string) => boolean) => prepDayKeys(now, isHoliday).at(-1)!;

/** Do next: every "now" item across the tabs, the most urgent first. */
export function rankDoNext(items: DeskItem[], max = DO_NEXT_MAX): DeskItem[] {
  return items
    .filter((i) => i.state === "now")
    .sort((a, b) => a.rank - b.rank || Number(b.late) - Number(a.late) || (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999") || a.id.localeCompare(b.id))
    .slice(0, max);
}

/** "Due 3:00 PM", "Late by 2 hours", "Due Mon 10:00 AM". */
export function dueWordsFor(dueISO: string | null, now: Date): string | null {
  if (!dueISO) return null;
  const at = Date.parse(dueISO);
  if (at < now.getTime()) return `Late by ${lateWords((now.getTime() - at) / HOUR)}`;
  return etDayKey(new Date(at)) === etDayKey(now) ? `Due ${etTime(dueISO)}` : `Due ${etDate(dueISO)} ${etTime(dueISO)}`;
}

/** "4 min ago", "2 h ago", "3 days ago". */
export function agoWords(atISO: string | null, now: Date): string {
  if (!atISO) return "never";
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(atISO)) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** A sync job's health in words. A failed or late sync is said, never read as zero. */
export function freshnessOf(j: Pick<CronJobHealth, "lastRunAt" | "lastOk" | "stale" | "neverRecorded"> | null, label: string, key: string, now: Date): Freshness {
  if (!j || j.neverRecorded || !j.lastRunAt) return { key, label, state: "unknown", atISO: null, words: "no sync recorded" };
  if (j.lastOk === false) return { key, label, state: "failed", atISO: j.lastRunAt, words: `last sync failed ${agoWords(j.lastRunAt, now)}` };
  if (j.stale) return { key, label, state: "stale", atISO: j.lastRunAt, words: `last synced ${agoWords(j.lastRunAt, now)}, late` };
  return { key, label, state: "ok", atISO: j.lastRunAt, words: `synced ${agoWords(j.lastRunAt, now)}` };
}

/** The tab counts, from the lists themselves: a count can never disagree with what it opens. */
export function deskCounts(tabs: DeskTab[]): Record<DeskTabKey, number | null> {
  return Object.fromEntries(tabs.map((t) => [t.key, t.count])) as Record<DeskTabKey, number | null>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "a job";
const short = (s: string, n = 110) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// ---- conflicts in a visit's instructions ----------------------------------------------

const SCOPE_WORDS = /\b(exteriors? only|interiors? only|split appointment|appointment\s*[12]\b|second visit|first visit)\b/i;
const NO_DRONE = /\b(no drone|don'?t fly|do not fly|no aerials?)\b/i;
const CODE = /\b(?:lock ?box|code|gate)\b[^0-9]{0,20}(\d{3,8})/i;

/** Instructions that disagree for THIS visit, in words. Pure, so the drill
 *  can hold each rule. */
export function visitConflicts(v: { services: string[]; requests: string[]; orderNotes: string[]; lockbox: string | null; liveVisits: number }): string[] {
  const out: string[] = [];
  if (v.liveVisits > 1) {
    const scoped = v.orderNotes.find((n) => SCOPE_WORDS.test(n));
    if (scoped) out.push(`The order notes cover all ${v.liveVisits} visits ("${short(scoped.match(SCOPE_WORDS)?.[0] ?? scoped, 40)}"). Confirm what this visit is for.`);
  }
  const drone = v.services.some((s) => /drone|aerial/i.test(s));
  const noDrone = [...v.requests, ...(v.liveVisits > 1 ? [] : v.orderNotes)].find((t) => NO_DRONE.test(t));
  if (drone && noDrone) out.push("Drone is on this visit, but a request says no drone.");
  const briefCode = v.lockbox?.match(/\d{3,8}/)?.[0] ?? null;
  for (const r of v.requests) {
    const c = r.match(CODE)?.[1];
    if (c && briefCode && c !== briefCode) {
      out.push(`Two different codes: the appointment says ${briefCode}, a request says ${c}.`);
      break;
    }
  }
  return out;
}

// ---- the reads ---------------------------------------------------------------------------

type BuildOpts = {
  now?: Date;
  includeTest?: boolean;
  excludeClientIds: string[];
  /** whose desk this is (Kyle): his tasks, his completed work */
  person: ChecklistPerson & { name: string };
  roster?: Assignee[];
  readOnly?: boolean;
};

const warn = (what: string) => (e: unknown) => {
  console.warn(`officeDesk: ${what} failed`, (e as Error)?.message);
  return null;
};

type PrepRow = {
  apptId: string | null;
  startAt: Date | null;
  endAt: Date | null;
  description: string | null;
  rawJson: string | null;
  assignedTo: string | null;
  assignedToId: string | null;
  project: {
    id: string; title: string; addressLine: string | null; status: string; deliveredAt: Date | null; shootDate: Date | null; clientId: string | null;
    photographerId: string | null;
    client: { name: string } | null;
    photographer: { name: string } | null;
    deliverables: { type: string; label: string | null }[];
    activities: { body: string; createdAt: Date }[];
    appointments: { id: string; startAt: Date | null; status: string | null; rawJson: string | null; description: string | null }[];
    smartTasks: { id: string; status: string; dueAt: Date | null; completedAt: Date | null; createdAt: Date }[];
  };
};

const PREP_PROJECT_SELECT = {
  id: true, title: true, addressLine: true, status: true, deliveredAt: true, shootDate: true, clientId: true, photographerId: true,
  client: { select: { name: true } },
  photographer: { select: { name: true } },
  deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true } },
  activities: { where: { type: "SPECIAL_REQUEST" as const }, select: { body: true, createdAt: true } },
  appointments: { select: { id: true, startAt: true, status: true, rawJson: true, description: true } },
  smartTasks: { where: { taskType: "confirmation_text" }, select: { id: true, status: true, dueAt: true, completedAt: true, createdAt: true }, orderBy: { createdAt: "desc" as const }, take: 3 },
} as const;

const liveAppt = (a: { status: string | null; startAt: Date | null }) => !!a.startAt && (a.status ?? "").toUpperCase() !== "CANCELED";

function apptItems(rawJson: string | null): string[] {
  try {
    const j = JSON.parse(rawJson ?? "{}") as { items?: { title?: string; is_canceled?: boolean }[] };
    return (j.items ?? []).filter((i) => i && i.title && !i.is_canceled).map((i) => String(i.title));
  } catch {
    return [];
  }
}

async function prepRows(dayKeys: string[], excludeClientIds: string[]): Promise<PrepRow[]> {
  const start = etDayBoundsUtc(dayKeys[0]).start;
  const end = etDayBoundsUtc(dayKeys.at(-1)!).end;
  const clientScope = excludeClientIds.length ? { clientId: { notIn: excludeClientIds } } : {};
  const projectWhere = { status: { notIn: ["CANCELLED" as const, "ON_HOLD" as const] }, aryeoMissingAt: null, ...clientScope };
  const [appts, bare] = await Promise.all([
    prisma.appointment.findMany({
      where: { startAt: { gte: start, lt: end }, NOT: { status: "CANCELED" }, project: projectWhere },
      select: { id: true, startAt: true, endAt: true, description: true, rawJson: true, assignedToId: true, assignedTo: { select: { name: true } }, project: { select: PREP_PROJECT_SELECT } },
      orderBy: { startAt: "asc" },
      take: 80,
    }),
    // A job on the calendar with no appointment row (an order-only booking):
    // still a visit to prepare, read off the job.
    prisma.project.findMany({
      where: { ...projectWhere, shootDate: { gte: start, lt: end }, appointments: { none: { startAt: { gte: start, lt: end }, NOT: { status: "CANCELED" } } } },
      select: PREP_PROJECT_SELECT,
      take: 40,
    }),
  ]);
  return [
    ...appts.map((a) => ({ apptId: a.id, startAt: a.startAt, endAt: a.endAt, description: a.description, rawJson: a.rawJson, assignedTo: a.assignedTo?.name ?? null, assignedToId: a.assignedToId, project: a.project as PrepRow["project"] })),
    ...bare.map((p) => ({ apptId: null, startAt: p.shootDate, endAt: null, description: p.appointments.map((a) => a.description).find((d) => !!d?.trim()) ?? null, rawJson: null, assignedTo: null, assignedToId: null, project: p as PrepRow["project"] })),
  ];
}

/** The newest run of each job the freshness line names: one indexed read per
 *  job (not the whole CronRun table, every 90 seconds), judged by the same
 *  rules as /connections (cronHealth: twice the cadence is late). */
async function syncHealth(now: Date): Promise<(Pick<CronJobHealth, "lastRunAt" | "lastOk" | "stale" | "neverRecorded"> & { job: string })[]> {
  const expected = expectedCrons();
  return Promise.all(FRESH_JOBS.map(async ({ job }) => {
    const r = await prisma.cronRun.findFirst({ where: { job }, orderBy: { startedAt: "desc" }, select: { startedAt: true, finishedAt: true, ok: true, summary: true } });
    const cadence = expected.find((e) => e.job === job)?.cadenceMs ?? null;
    if (!r) return { job, lastRunAt: null, lastOk: null, stale: false, neverRecorded: true };
    // A mail scan that could not read one of the mailboxes is not a good run (cronHealth's rule).
    const degraded = job === "gmail" && /\\?"degraded\\?":true/.test(r.summary ?? "");
    return {
      job,
      lastRunAt: r.startedAt.toISOString(),
      lastOk: r.finishedAt ? r.ok && !degraded : null,
      stale: cadence != null && now.getTime() - r.startedAt.getTime() > staleAfterMs(cadence),
      neverRecorded: false,
    };
  }));
}

// ---- the build ----------------------------------------------------------------------------

/**
 * Kyle's desk, from one pass of reads. Reads only: nothing here writes.
 */
export async function buildOfficeDesk(opts: BuildOpts): Promise<OfficeDesk> {
  const now = opts.now ?? new Date();
  const ex = opts.excludeClientIds;
  const scope = { excludeClientIds: ex };
  // Kyle never sees a figure. A line another reader already scrubbed
  // (checklistTasks with scrub) is not scrubbed twice: a second pass reads
  // "[amount] credit for 12 Oak St" as money too.
  const clean = (s: string) => (s.includes("[amount]") ? s : scrubMoney(s));
  const dayKey = etDayKey(now);
  const startToday = etDayStartUtc(now);
  const endToday = etDayBoundsUtc(dayKey).end;
  const current = Math.abs(now.getTime() - Date.now()) < 60_000;
  const { companyHolidayName } = await import("@/lib/paySavings").catch(() => ({ companyHolidayName: (_: string) => null as string | null }));
  const days = prepDayKeys(now, (k) => !!companyHolidayName(k));
  const nextDay = days.at(-1)!;

  const me = opts.person.teamMemberId
    ? await prisma.teamMember.findUnique({ where: { id: opts.person.teamMemberId }, select: { name: true, email: true } }).catch(() => null)
    : null;
  const myNames = [me?.name, opts.person.name, me?.email].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const isMe = (s: string | null | undefined) => !!s && myNames.some((n) => s.toLowerCase() === n || s.toLowerCase().startsWith(`${n} `) || s.toLowerCase().includes(`<${n}>`));

  const [queue, board, notTold, incidents, comms, tasks, laterTasks, revisions, photoAsks, visits, jobs, cron, closeRec, waitingRecs, creative, owner, leads] = await Promise.all([
    loadQueue({ now }).catch(warn("photo queue")) as Promise<QueueData | null>,
    videoDeliveryBoard(current ? {} : { now }).catch(warn("video board")) as Promise<VideoDeliveryBoard | null>,
    clientNotToldYet({ excludeClientIds: ex }).catch(warn("client not told")) as Promise<NotTold[] | null>,
    deliveryNoticeIncidents(undefined, scope).catch(warn("delivery texts")) as Promise<DeliveryNoticeIncident[] | null>,
    unansweredCommsBoards(now, scope).catch(warn("client messages")),
    checklistTasks(now, { person: opts.person, excludeClientIds: ex, scrub: true, roster: opts.roster }).catch(warn("tasks")),
    prisma.smartTask.findMany({
      where: {
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        taskType: { notIn: ["lead", "revision", "client_reply", "confirmation_text", "delivery_text"] },
        AND: [personTaskWhere(opts.person, scope), { OR: [{ dueAt: null, followUpAt: null }, { followUpAt: { gte: etDayBoundsUtc(nextKey(dayKey)).start } }, { followUpAt: null, dueAt: { gte: etDayBoundsUtc(nextKey(dayKey)).start } }] }],
      },
      select: { id: true, title: true, taskType: true, dueAt: true, followUpAt: true, createdAt: true, projectId: true, project: { select: { title: true } } },
      orderBy: { createdAt: "asc" },
      take: 200,
    }).catch(warn("later tasks")),
    prisma.smartTask.findMany({
      where: { taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] }, ...(ex.length ? { OR: [{ clientId: null }, { clientId: { notIn: ex } }] } : {}) },
      select: {
        id: true, title: true, assignedKey: true, dueAt: true, followUpAt: true, createdAt: true, dedupeKey: true, projectId: true, clientId: true,
        project: { select: { title: true, promisedDueAt: true, deliveryDue: true, client: { select: { name: true } } } },
      },
      orderBy: { createdAt: "asc" },
      take: 60,
    }).catch(warn("revisions")),
    prisma.clientAsk.findMany({
      where: { kind: "SPECIAL_REQUEST", state: "OPEN", medium: { in: ["photo", "both"] }, projectId: { not: null }, ...(ex.length ? { clientId: { notIn: ex } } : {}) },
      select: { id: true, projectId: true, summary: true, text: true, askedAt: true, clientId: true },
      take: 80,
    }).catch(warn("photo asks")),
    prepRows(days, ex).catch(warn("shoot prep")),
    jobsBoard(now, { includeTest: !!opts.includeTest }).catch(warn("shoots board")) as Promise<JobsBoard | null>,
    syncHealth(now).catch(warn("sync health")),
    prisma.appSetting.findUnique({ where: { key: closeoutSettingKey(dayKey) } }).catch(warn("closeout")),
    prisma.appSetting.findMany({ where: { key: { startsWith: WAITING_PREFIX } }, take: 300 }).catch(warn("waiting notes")),
    prisma.teamMember.findFirst({ where: { creativeManager: true }, select: { id: true, name: true } }).catch(() => null),
    prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE" }, select: { name: true } }).catch(() => null),
    prisma.smartTask.findMany({
      where: {
        taskType: "lead", status: { notIn: ["COMPLETED", "CANCELLED"] },
        OR: [{ assignedKey: null }, ...(opts.person.key ? [{ assignedKey: opts.person.key }] : []), ...(opts.person.teamMemberId ? [{ ownerId: opts.person.teamMemberId }] : [])],
        ...(ex.length ? { AND: [{ OR: [{ clientId: null }, { clientId: { notIn: ex } }] }] } : {}),
      },
      select: { id: true, title: true, createdAt: true, dueAt: true, summary: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    }).catch(warn("leads")),
  ]);
  const creativeName = (creative?.name ?? "James").split(" ")[0];
  const ownerName = (owner?.name ?? "Jordan").split(" ")[0];
  const excludedProjects = new Set(
    ex.length ? (await prisma.project.findMany({ where: { clientId: { in: ex } }, select: { id: true } }).catch(() => [])).map((p) => p.id) : [],
  );
  const waitingNotes = new Map<string, WaitingRecord>();
  for (const r of waitingRecs ?? []) {
    try { waitingNotes.set(r.key.slice(WAITING_PREFIX.length), JSON.parse(r.value) as WaitingRecord); } catch { /* unreadable: ignored */ }
  }

  const items: DeskItem[] = [];
  const push = (i: DeskItem) => items.push(i);
  const nowMs = now.getTime();

  // =====================================================================
  // QC & DELIVERY: one item per JOB, a status per asset.
  // =====================================================================
  type Group = { projectId: string; street: string; client: string | null; assets: AssetLine[]; aryeoUrl: string | null; photoJobId: string | null };
  const groups = new Map<string, Group>();
  const groupOf = (projectId: string, street: string, client: string | null): Group => {
    let g = groups.get(projectId);
    if (!g) { g = { projectId, street: clean(street), client: client ? clean(client) : null, assets: [], aryeoUrl: null, photoJobId: null }; groups.set(projectId, g); }
    return g;
  };
  const photoCards: { col: QueueColumnKey; c: QueueCard }[] = [];
  for (const col of queue?.columns ?? []) for (const c of col.cards) {
    if (c.clientId && ex.includes(c.clientId)) continue;
    photoCards.push({ col: col.key, c });
  }
  const findingsFor = new Map<string, string[]>();
  const decisionJobs = photoCards.filter((x) => x.col === "decision" || x.col === "ready").map((x) => x.c.id);
  if (decisionJobs.length) {
    const rows = await prisma.photoQcFinding.findMany({
      where: { jobId: { in: decisionJobs.slice(0, 60) }, status: "OPEN" },
      select: { jobId: true, specificIssue: true, severity: true },
      orderBy: { severity: "asc" },
      take: 400,
    }).catch(() => []);
    for (const r of rows) {
      const list = findingsFor.get(r.jobId) ?? [];
      if (list.length < 4) list.push(`${r.severity.toLowerCase()}: ${clean(r.specificIssue)}`);
      findingsFor.set(r.jobId, list);
    }
  }
  for (const { col, c } of photoCards) {
    const due = c.slaDueAt ? Date.parse(c.slaDueAt) : null;
    const late = due != null && due < nowMs && col !== "delivered";
    const issues = c.issues.CRITICAL + c.issues.MAJOR + c.issues.MINOR;
    const found = issues ? `The free check found ${plural(c.issues.CRITICAL, "critical")} · ${c.issues.MAJOR} major · ${c.issues.MINOR} minor` : "The free check found nothing to decide";
    const open = (label: string): DeskAction => ({ kind: "link", label, href: `/ops/photo-delivery/${c.id}` });
    const a: AssetLine = { id: `photo:${c.id}`, kind: "photos", label: "Photos", status: "", tone: "waiting", late, dueISO: c.slaDueAt, who: null, note: null, action: null };
    switch (col) {
      case "editing":
        if (c.stage === "EDIT_FAILED") Object.assign(a, { tone: "failed", status: "Editing failed", action: open("Open photos") });
        else Object.assign(a, { tone: late ? "now" : "waiting", status: late ? "Edits are late, not back from AutoHDR" : "Being edited", who: "AutoHDR", action: late ? open("Open photos") : null });
        break;
      case "qc":
        Object.assign(a, { tone: late ? "now" : "waiting", status: late ? "Late, still in the free check" : "Edited photos received, free check running", who: "the hub", action: late ? open("Open photos") : null });
        break;
      case "decision":
        Object.assign(a, { tone: "now", status: c.stage === "REVISION_REQUESTED" ? "The client asked for changes: decide the fix" : "The free check found issues to decide", note: found, action: open("Decide") });
        break;
      case "fixing":
        Object.assign(a, { tone: late ? "now" : "waiting", status: late ? "Corrections are late in AutoHDR" : "Corrections running in AutoHDR", who: "AutoHDR", action: late ? open("Open photos") : null });
        break;
      case "hold":
        Object.assign(a, { tone: "now", status: `On hold: ${(c.holdReason && HOLD_REASON_LABEL[c.holdReason]) || "held"}`, action: open("Open photos") });
        break;
      case "ready":
        Object.assign(a, { tone: "now", status: "Ready for your review", note: issues ? found : "The free check passed", action: { kind: "photo-approve", jobId: c.id, street: clean(c.street) } });
        break;
      case "delivering":
        if (c.stage === "DELIVERY_MISMATCH") Object.assign(a, { tone: "failed", status: "Not confirmed: Aryeo shows a different set", action: open("Check delivery") });
        else Object.assign(a, { tone: "waiting", status: "Approved, not delivered yet: waiting on Aryeo to confirm", who: "Aryeo", late: false });
        break;
      case "delivered":
        Object.assign(a, { tone: "done", status: `Delivered ${c.deliveredAt ? etDateTime(c.deliveredAt) : ""}`.trim(), late: false });
        break;
    }
    const g = groupOf(c.projectId, c.street, c.clientName);
    g.photoJobId = c.id;
    g.assets.push(a);
  }
  // Approved videos only: the edits and the reviews are not Kyle's (Follow-Ups chases them).
  const videoRows = [...(board?.lanes.sending ?? []), ...(board?.lanes.held ?? []), ...(board?.lanes.finishing ?? [])].filter((r) => !excludedProjects.has(r.projectId));
  for (const r of videoRows) {
    const s = r.send;
    const p = r.push;
    const approvedBy = s?.approvedBy ? clean(s.approvedBy) : null;
    const approved = approvedBy ? `Approved by ${approvedBy}` : "Approved";
    const a: AssetLine = { id: `video:${r.key}`, kind: "video", label: clean(r.label), status: "", tone: "now", late: r.late, dueISO: r.promiseISO, who: null, note: approvedBy ? `${approved} (creative review). You send it.` : null, action: null };
    if (r.lane === "finishing") {
      Object.assign(a, { tone: r.late ? "now" : "waiting", status: `${approved}, not sent: the 1080p pass is still running`, who: "the 1080p pass", action: r.late ? { kind: "link", label: "Open in Videos", href: "/review" } : null });
    } else if (r.lane === "held") {
      const canSend = !!(p?.canStart && s && !s.byHandWhy);
      Object.assign(a, {
        tone: "now",
        status: `${approved}, held: ${clean(r.heldWhy ?? r.stage)}`,
        action: canSend && r.submissionId
          ? { kind: "video-send", submissionId: r.submissionId, street: clean(r.street), label: "Try again", openAsks: (s?.openAsks ?? []).map((x) => ({ summary: clean(x.summary), askedBy: x.askedBy ?? null })), asksUnknown: !!s?.asksUnknown, listingWarning: null }
          : p && r.submissionId && (p.canDeliverNow || p.canRelease)
            ? { kind: "video-push", submissionId: r.submissionId, canDeliverNow: p.canDeliverNow, canRelease: p.canRelease }
            : { kind: "link", label: "Open in Videos", href: r.reviewHref ?? "/review" },
      });
    } else {
      const running = !!p?.state && !(p.tone === "failed" || p.tone === "held") && p.tone !== "done";
      const asks = s?.openAsks.length ?? 0;
      if (p?.tone === "failed") {
        Object.assign(a, { tone: "failed", status: `Upload to Aryeo stopped: ${clean(p.says)}` });
      } else if (running && !p?.waitingForKyle) {
        Object.assign(a, { tone: "waiting", status: `${approved}, not delivered yet: ${clean(p!.says)}`, who: "Aryeo" });
      } else {
        Object.assign(a, { tone: "now", status: `${approved}, ready to send${asks ? ` · check ${plural(asks, "client request")} first` : ""}` });
      }
      if (a.tone !== "waiting" && r.submissionId) {
        const canPress = !!s && !s.byHandWhy && (p ? p.canStart : false);
        a.action = p && p.waitingForKyle && (p.canDeliverNow || p.canRelease)
          ? { kind: "video-push", submissionId: r.submissionId, canDeliverNow: p.canDeliverNow, canRelease: p.canRelease }
          : canPress && s
            ? { kind: "video-send", submissionId: r.submissionId, street: clean(r.street), label: p?.canRetry ? "Try again" : s.uploaded ? "Send" : "Upload to Aryeo and send", openAsks: s.openAsks.map((x) => ({ summary: clean(x.summary), askedBy: x.askedBy ?? null })), asksUnknown: s.asksUnknown, listingWarning: s.listingWarning }
            : { kind: "link", label: "Open in Videos", href: r.reviewHref ?? "/review" };
        if (s?.byHandWhy) a.status = `${approved}: ${clean(s.byHandWhy)}`;
      }
    }
    const g = groupOf(r.projectId, r.street, r.clientName);
    g.aryeoUrl = g.aryeoUrl ?? r.aryeoUrl;
    g.assets.push(a);
  }
  // Published but the client was never told: NOT delivered (the spec: delivered = accessible AND notified).
  for (const n of notTold ?? []) {
    if (excludedProjects.has(n.projectId)) continue;
    groupOf(n.projectId, n.street, null).assets.push({
      id: `notice:${n.submissionId}`, kind: "notice", label: "Client notice", tone: "now", late: false, dueISO: null, who: null,
      status: `Published ${etDateTime(n.sentAtISO)}, client not notified yet`, note: n.sentBy ? `Sent by ${clean(n.sentBy)}` : null,
      action: { kind: "video-notice", row: { ...n, street: clean(n.street) } },
    });
  }
  for (const i of incidents ?? []) {
    if (!i.projectId || excludedProjects.has(i.projectId)) continue;
    const failed = i.state === "failed" || i.state === "unknown";
    groupOf(i.projectId, i.street, null).assets.push({
      id: `text:${i.outboxId}`, kind: "notice", label: "Delivery text", tone: failed ? "failed" : "waiting", late: false, dueISO: null,
      who: failed ? null : "the text service",
      status: i.state === "failed" ? "The client's delivery text failed" : i.state === "unknown" ? "Not known whether the client's delivery text went out" : "The client's delivery text is still sending",
      note: null, action: failed ? { kind: "link", label: "Open the job", href: `/projects/${i.projectId}` } : null,
    });
  }
  // Floor plans and 3D tours: a status each, from the order and the Aryeo listing read.
  const groupIds = [...groups.keys()];
  if (groupIds.length) {
    const projs = await prisma.project.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, statusEvidence: true, promisedDueAt: true, deliveryDue: true, deliverables: { where: { ...OWED_DELIVERABLE_WHERE, type: { in: ["FLOORPLAN", "MATTERPORT_3D", "ZILLOW_3D"] } }, select: { type: true, label: true, status: true } } },
    }).catch(() => []);
    for (const p of projs) {
      const g = groups.get(p.id)!;
      const ev = parseEvidence(p.statusEvidence)?.aryeo ?? null;
      for (const d of p.deliverables) {
        const plan = d.type === "FLOORPLAN";
        const onListing = plan ? (ev?.floorPlans ?? 0) > 0 : (ev?.interactive ?? 0) > 0;
        const base: AssetLine = { id: `${plan ? "floorplan" : "tour"}:${p.id}`, kind: plan ? "floorplan" : "tour", label: plan ? "Floor plan" : "3D tour", status: "", tone: "waiting", late: false, dueISO: null, who: null, note: null, action: null };
        if (d.status === "DONE") Object.assign(base, { tone: "done", status: onListing ? "Done, on the Aryeo listing" : "Done" });
        else if (onListing) Object.assign(base, { tone: "done", status: "On the Aryeo listing" });
        else if (d.status === "FLAGGED") Object.assign(base, { tone: "now", status: "Flagged: check it before it goes out", action: { kind: "link", label: "Open the job", href: `/projects/${p.id}` } });
        else {
          // Still owed: waiting on its maker until the job's promise (the
          // client deadline, else the photos' own), then back to Kyle to chase.
          const promise = (p.promisedDueAt ?? p.deliveryDue)?.toISOString() ?? g.assets.find((a) => a.kind === "photos")?.dueISO ?? null;
          const lateNow = !!promise && Date.parse(promise) < nowMs;
          Object.assign(base, {
            status: d.status === "UPLOADED" || d.status === "IN_PROGRESS" ? "Uploaded, not on the listing yet" : promise ? "Not in yet" : "Not in yet, and the job has no date",
            who: plan ? "CubiCasa" : "the photographer",
            dueISO: promise, late: lateNow,
            tone: lateNow || !promise ? "now" : "waiting",
            action: lateNow || !promise ? { kind: "link", label: "Open the job", href: `/projects/${p.id}` } : null,
          });
        }
        g.assets.push(base);
      }
    }
  }
  for (const g of groups.values()) {
    const open = g.assets.filter((a) => a.tone !== "done");
    if (open.length === 0) continue;
    // A job whose only open asset is a floor plan or tour stays listed only when
    // something else of it went out (partial delivery): otherwise it is not in
    // delivery yet at all.
    if (open.every((a) => a.kind === "floorplan" || a.kind === "tour") && !g.assets.some((a) => a.tone === "done" && (a.kind === "photos" || a.kind === "video"))) continue;
    const order = { failed: 0, now: 1, waiting: 2, done: 3 } as const;
    g.assets.sort((a, b) => order[a.tone] - order[b.tone] || Number(b.late) - Number(a.late));
    const lead = g.assets[0];
    const nowish = lead.tone === "now" || lead.tone === "failed";
    const late = open.some((a) => a.late);
    const dueISO = open.map((a) => a.dueISO).filter((x): x is string => !!x).sort()[0] ?? null;
    const title = !nowish ? `${g.street}: ${open.length === 1 ? open[0].label.toLowerCase() : "assets"} in progress`
      : lead.kind === "photos" && lead.action?.kind === "photo-approve" ? `Review and deliver photos for ${g.street}`
      : lead.kind === "photos" && lead.status.startsWith("The client asked") ? `Decide the photo changes for ${g.street}`
      : lead.kind === "photos" && lead.action?.kind === "link" && lead.action.label === "Decide" ? `Decide the photo check for ${g.street}`
      : lead.kind === "photos" && lead.late ? `Chase the late photos for ${g.street}`
      : lead.kind === "photos" ? `Sort out the photos for ${g.street}`
      : lead.kind === "video" && lead.action?.kind === "video-send" ? `Send the approved video for ${g.street}`
      : lead.kind === "video" ? `Check the approved video for ${g.street}`
      : lead.kind === "notice" && lead.action?.kind === "video-notice" ? `Tell the client the video is up for ${g.street}`
      : lead.kind === "notice" ? `Fix the delivery text for ${g.street}`
      : (lead.kind === "floorplan" || lead.kind === "tour") && lead.late ? `Chase the ${lead.label.toLowerCase()} for ${g.street}`
      : `Check the ${lead.label.toLowerCase()} for ${g.street}`;
    const reason = g.assets.map((a) => `${a.label}: ${a.status}`).slice(0, 4).join(" · ");
    const actions = g.assets.map((a) => a.action).filter((x): x is DeskAction => !!x);
    const failed = g.assets.some((a) => a.tone === "failed");
    const dueToday = !!dueISO && Date.parse(dueISO) < endToday.getTime();
    push({
      id: `job:${g.projectId}`, tab: "delivery", state: nowish ? "now" : "waiting",
      title, reason, who: nowish ? "You" : open.map((a) => a.who).find((w) => !!w) ?? null,
      dueISO, dueWords: dueWordsFor(dueISO, now), late,
      rank: failed ? RANK.blocker : late ? RANK.overdue : dueToday ? RANK.today : RANK.routine,
      primary: nowish && lead.action ? { label: actionLabel(lead.action), action: lead.action } : null,
      actions, href: g.photoJobId ? `/ops/photo-delivery/${g.photoJobId}` : `/projects/${g.projectId}`,
      panel: { kind: "job", projectId: g.projectId, street: g.street, client: g.client, assets: g.assets, findings: g.photoJobId ? findingsFor.get(g.photoJobId) ?? [] : [], aryeoUrl: g.aryeoUrl },
      sinceISO: null,
    });
  }

  // =====================================================================
  // CLIENT REPLIES: genuinely waiting on us (the comms scan already counts a
  // draft or an automatic acknowledgement as NOT answered).
  // =====================================================================
  const openRevisionClients = new Set((revisions ?? []).map((r) => r.clientId).filter((x): x is string => !!x));
  const phoneGroups = [...(comms?.phone ?? []), ...(comms?.email ?? [])];
  const clientIds = [...new Set(phoneGroups.map((g) => g.clientId).filter(Boolean))];
  const phones = new Map(
    clientIds.length ? (await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, phone: true } }).catch(() => [])).map((c) => [c.id, c.phone] as const) : [],
  );
  const replyItem = (family: "phone" | "email", g: CommsGroup) => {
    const latest = g.items[g.items.length - 1];
    const behind = g.holding ? g.holding.overdue : g.oldestHours >= MESSAGE_BEHIND_HOURS;
    const firstAt = g.items[0] ? Date.parse(g.items[0].atISO) : nowMs - g.oldestHours * HOUR;
    const dueISO = g.holding?.dueISO ?? new Date(firstAt + MESSAGE_BEHIND_HOURS * HOUR).toISOString();
    const w = { family, group: g, behind };
    const href = waitingClientReplyHref(w);
    const phone = family === "phone" ? (g.clientId ? phones.get(g.clientId) ?? null : null) ?? (/^\+?\d{10,11}$/.test(g.groupKey) ? g.groupKey : null) : null;
    const said = latest ? clean(latest.subject ? `${latest.subject}: ${latest.snippet}` : latest.snippet) : "";
    push({
      id: `reply:${family}:${g.groupKey}`, tab: "replies", state: "now",
      title: `Reply to ${clean(g.clientName)}`,
      reason: [said ? `"${short(said, 90)}"` : null, g.holding ? `you promised an answer ${g.holding.overdue ? "and it is overdue" : `by ${etTime(g.holding.dueISO)}`}` : `waiting ${waitedWords(g.oldestHours)}`].filter(Boolean).join(" · "),
      who: "You", dueISO, dueWords: dueWordsFor(dueISO, now), late: behind,
      rank: behind ? RANK.blocker : RANK.today,
      primary: { label: "Reply", action: { kind: "reply", threadKey: g.key, family, clientId: g.clientId || null, groupKey: g.groupKey, phone, href } },
      actions: [{ kind: "reply", threadKey: g.key, family, clientId: g.clientId || null, groupKey: g.groupKey, phone, href }],
      href,
      panel: {
        kind: "thread", client: clean(g.clientName), family,
        messages: g.items.map((m) => ({ atISO: m.atISO, text: clean(m.subject ? `${m.subject}: ${m.snippet}` : m.snippet) })),
        holding: g.holding ? clean(g.holding.text) : null,
        revisionNote: g.clientId && openRevisionClients.has(g.clientId) ? "This client also has an open change request. Replying does not close it: it stays in Follow-Ups until the change is verified." : null,
      },
      sinceISO: g.items[0]?.atISO ?? null,
    });
  };
  for (const g of comms?.phone ?? []) replyItem("phone", g);
  for (const g of comms?.email ?? []) replyItem("email", g);
  const onBoard = new Set(phoneGroups.map((g) => g.openTaskId).filter((x): x is string => !!x));
  for (const l of leads ?? []) {
    if (onBoard.has(l.id)) continue;
    const behind = !!l.dueAt && l.dueAt < now;
    const dueISO = (l.dueAt ?? new Date(l.createdAt.getTime() + MESSAGE_BEHIND_HOURS * HOUR)).toISOString();
    push({
      id: `lead:${l.id}`, tab: "replies", state: "now", title: clean(l.title),
      reason: `New lead, waiting since ${etDateTime(l.createdAt)}`, who: "You",
      dueISO, dueWords: dueWordsFor(dueISO, now), late: behind || Date.parse(dueISO) < nowMs,
      rank: behind ? RANK.overdue : RANK.today,
      primary: { label: "Handle lead", action: { kind: "task", taskId: l.id, allowNewDate: true, canWait: false } },
      actions: [{ kind: "task", taskId: l.id, allowNewDate: true, canWait: false }],
      href: "/communications",
      panel: { kind: "task", lines: [{ label: "Lead", value: clean(l.title) }, ...(l.summary ? [{ label: "Notes", value: clean(short(l.summary, 300)) }] : [])] },
      sinceISO: l.createdAt.toISOString(),
    });
  }

  // =====================================================================
  // SHOOT PREP: today through the next business day, one item per VISIT.
  // =====================================================================
  const prep = visits ?? [];
  const briefs = await briefStatusForAppointments(prep.map((v) => v.apptId).filter((x): x is string => !!x)).catch(() => new Map());
  const photoDelivered = new Map<string, Date>();
  const prepProjectIds = [...new Set([...prep.map((v) => v.project.id), ...(photoAsks ?? []).map((a) => a.projectId!).filter(Boolean)])];
  if (prepProjectIds.length) {
    for (const j of await prisma.photoJob.findMany({ where: { projectId: { in: prepProjectIds }, deliveredAt: { not: null } }, select: { projectId: true, deliveredAt: true } }).catch(() => [])) {
      photoDelivered.set(j.projectId, j.deliveredAt!);
    }
  }
  const prepAsks = prep.length
    ? await prisma.clientAsk.findMany({ where: { projectId: { in: prep.map((v) => v.project.id) }, kind: "SPECIAL_REQUEST", state: { in: ["OPEN", "CONFIRMED"] } }, select: { projectId: true, summary: true, text: true, askedAt: true } }).catch(() => [])
    : [];
  for (const v of prep) {
    const p = v.project;
    const start = v.startAt;
    const visitDay = start ? etDayKey(start) : dayKey;
    const live = p.appointments.filter(liveAppt).sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime());
    const idx = v.apptId ? live.findIndex((a) => a.id === v.apptId) : -1;
    const prevStart = idx > 0 ? live[idx - 1].startAt! : null;
    const delivered = photoDelivered.get(p.id) ?? p.deliveredAt ?? null;
    // Each note belongs to the first visit that starts after it was made. One
    // made after the photos went out is a REVISION, never this visit's request.
    type Note = { text: string; at: Date };
    const notes: Note[] = [
      ...prepAsks.filter((a) => a.projectId === p.id).map((a) => ({ text: clean(a.summary?.trim() || a.text), at: a.askedAt })),
      ...p.activities
        .filter((act) => !prepAsks.some((a) => a.projectId === p.id && Math.abs(a.askedAt.getTime() - act.createdAt.getTime()) < 5 * 60_000))
        .map((act) => ({ text: clean(act.body.replace(/^Client request \([^)]*\):\s*/i, "")), at: act.createdAt })),
    ];
    const revisionsAfter = notes.filter((n) => !!delivered && n.at > delivered).map((n) => short(n.text, 120));
    const forThis = notes.filter((n) => !(delivered && n.at > delivered) && (!prevStart || n.at > prevStart));
    const forEarlier = notes.filter((n) => !(delivered && n.at > delivered) && !!prevStart && n.at <= prevStart);
    const acc: AccessInfo = parseAccessBrief(v.description);
    const orderNotes = [acc.special, acc.orderNotes, acc.notes && !/^n\/?a$/i.test(acc.notes) ? acc.notes : null].filter((x): x is string => !!x && !!x.trim()).map((x) => clean(x));
    const multi = live.length > 1;
    const own = apptItems(v.rawJson);
    const services = own.length ? own : multi ? [] : [...new Set(p.deliverables.map((d) => d.label ?? d.type))];
    const servicesFrom: PrepVisit["servicesFrom"] = own.length ? "visit" : services.length ? "order" : "none";
    const over = !!start && (v.endAt ?? new Date(start.getTime() + 2 * HOUR)) < now;
    const conf = p.smartTasks.find((t) => !start || !t.dueAt || (t.dueAt.getTime() <= start.getTime() && t.dueAt.getTime() >= start.getTime() - 3 * DAY)) ?? null;
    const confirmation: PrepVisit["confirmation"] = over ? { state: "na", words: "Shot", taskId: null }
      : !conf ? { state: "none", words: "No confirmation on file for this visit", taskId: null }
      : conf.status === "COMPLETED" ? { state: "sent", words: `Confirmation text sent ${conf.completedAt ? etDateTime(conf.completedAt) : ""}`.trim(), taskId: conf.id }
      : conf.status === "CANCELLED" ? { state: "other", words: "Confirmed another way", taskId: conf.id }
      : { state: "open", words: "Not confirmed yet", taskId: conf.id };
    const b = (v.apptId ? briefs.get(v.apptId) : null) ?? { state: "off" as BriefState, sentAt: null, ackAt: null, why: null };
    const briefWords: Record<BriefState, string> = {
      off: "Photographer brief switched off",
      pending: `Brief not sent yet${b.why ? `: ${b.why}` : ""}`,
      sent: `Brief sent${b.sentAt ? ` ${etTime(b.sentAt)}` : ""}, no Got it yet`,
      failed: `Brief not sent${b.why ? `: ${b.why.replace(/^(Update )?not sent:\s*/i, "")}` : ""}`,
      acknowledged: `Photographer tapped Got it${b.ackAt ? ` ${etTime(b.ackAt)}` : ""}`,
      changed: "Instructions changed: waiting for a new Got it",
    };
    const gaps: string[] = [];
    if (!p.addressLine?.trim() || /^\[No address/i.test(p.addressLine)) gaps.push("No street address on the listing");
    const photographer = v.assignedTo ?? p.photographer?.name ?? null;
    if (!photographer) gaps.push("No photographer assigned");
    if (!acc.lockbox && !acc.access && !acc.presence) gaps.push("No access answer (lockbox, door code or who is there)");
    if (!acc.phone) gaps.push("No on-site contact phone");
    if (servicesFrom === "none") gaps.push(multi ? "No services listed for this visit (a split order)" : "No services on the order");
    const conflicts = visitConflicts({ services, requests: forThis.map((n) => n.text), orderNotes, lockbox: acc.lockbox, liveVisits: live.length });
    const unconfirmed = confirmation.state === "open" || confirmation.state === "none";
    // Failed sends surface at once; a brief still without its Got it surfaces
    // once the briefing build says it needs a person (the first shoot is near),
    // until then it waits on the photographer.
    const photographerId = v.assignedToId ?? p.photographerId ?? null;
    const briefProblem = b.state === "failed" || ((b.state === "sent" || b.state === "changed") && !!b.why && /First shoot|needs|not acknowledged/i.test(b.why)) || (b.state === "pending" && /before the day's first shoot/i.test(b.why ?? ""));
    const briefWaiting = !briefProblem && (b.state === "sent" || b.state === "changed");
    const problems = over ? [] : [...(unconfirmed ? [confirmation.words] : []), ...gaps, ...conflicts, ...(briefProblem ? [briefWords[b.state as BriefState]] : [])];
    const street = clean(streetOf(p.title));
    const when = start ? `${visitDay === dayKey ? "today" : etDate(start)} ${etTime(start)}` : visitDay === dayKey ? "today" : etDate(etAt(visitDay, 12));
    const visit: PrepVisit = {
      apptId: v.apptId, projectId: p.id, street, client: p.client ? clean(p.client.name) : null, dayKey: visitDay,
      timeISO: start?.toISOString() ?? null, endISO: v.endAt?.toISOString() ?? null, over, photographer: photographer ? clean(photographer) : null, photographerId,
      confirmation,
      access: { lockbox: acc.lockbox ? clean(acc.lockbox) : null, access: acc.access ? clean(acc.access) : null, presence: acc.presence ? clean(acc.presence) : null, contactName: acc.name, contactPhone: acc.phone },
      services, servicesFrom,
      requests: forThis.map((n) => ({ text: short(n.text, 200), whenISO: n.at.toISOString() })),
      instructions: multi ? [] : orderNotes.map((n) => short(n, 300)),
      earlier: [
        ...(multi ? orderNotes.map((n) => ({ text: `Order note (all ${live.length} visits): ${short(n, 240)}`, whenISO: null })) : []),
        ...forEarlier.map((n) => ({ text: short(n.text, 200), whenISO: n.at.toISOString() })),
      ],
      revisionsAfterDelivery: revisionsAfter,
      conflicts, gaps,
      brief: { state: b.state, words: briefWords[b.state as BriefState], why: b.why, href: photographerId ? `/shoot/brief/${visitDay}?as=${photographerId}` : null },
      otherVisits: live.filter((a) => a.id !== v.apptId).map((a) => ({ whenISO: a.startAt?.toISOString() ?? null, services: apptItems(a.rawJson) })),
    };
    const soon = !!start && start.getTime() - nowMs < DAY;
    const firstProblem = problems[0] ?? null;
    const title = over ? `${street}: shot ${start ? etTime(start) : "today"}`
      : !firstProblem ? `${street}: ready for ${when}`
      : unconfirmed && firstProblem === confirmation.words ? `Confirm ${street} for ${when}`
      : conflicts.includes(firstProblem) ? `Check the instructions for ${street} (${when})`
      : gaps.includes(firstProblem) ? `Fill in the shoot details for ${street} (${when})`
      : `Re-send the brief for ${street} (${when})`;
    const confirmAction: DeskAction | null = confirmation.state === "open" && confirmation.taskId ? { kind: "confirm", taskId: confirmation.taskId, outboxHref: "/communications?view=outbox" } : null;
    const openJob: DeskAction = { kind: "link", label: "Open the job", href: `/projects/${p.id}` };
    const briefSend: DeskAction | null = photographerId && b.state !== "off" && !over ? { kind: "brief-send", teamMemberId: photographerId, day: visitDay, name: photographer ? clean(photographer).split(" ")[0] : "the photographer" } : null;
    const briefFirst = !!firstProblem && briefProblem && firstProblem === briefWords[b.state as BriefState];
    const primary = problems.length ? (confirmAction && firstProblem === confirmation.words ? confirmAction : briefFirst && briefSend ? briefSend : openJob) : null;
    // Waiting on the photographer's Got it: their move, back to Kyle two hours before the shoot.
    const ackBy = start ? new Date(start.getTime() - 2 * HOUR) : null;
    const waitingAck = !problems.length && !over && briefWaiting;
    push({
      id: v.apptId ? `visit:${v.apptId}` : `visit:p:${p.id}`, tab: "prep",
      state: problems.length ? "now" : waitingAck ? "waiting" : "ok",
      title: waitingAck ? `${street}: waiting for ${photographer ? clean(photographer).split(" ")[0] : "the photographer"}'s Got it` : title,
      reason: problems.length ? problems.slice(0, 3).join(" · ") : waitingAck ? `${briefWords[b.state as BriefState]} · shoot ${when}` : [photographer ? clean(photographer) : null, confirmation.words, services.slice(0, 3).join(", ")].filter(Boolean).join(" · "),
      who: problems.length ? "You" : waitingAck ? (photographer ? clean(photographer) : "the photographer") : null,
      dueISO: waitingAck && ackBy ? ackBy.toISOString() : start?.toISOString() ?? null,
      dueWords: waitingAck && ackBy ? `Back ${etTime(ackBy)}` : start ? `${visitDay === dayKey ? "Today" : etDate(start)} ${etTime(start)}` : null,
      late: false,
      rank: problems.length ? (soon || visitDay === dayKey ? RANK.blocker : RANK.routine) : RANK.housekeeping,
      primary: primary ? { label: primary.kind === "confirm" ? "Confirm" : actionLabel(primary), action: primary } : null,
      actions: [...(confirmAction ? [confirmAction] : []), ...(briefSend ? [briefSend] : []), openJob],
      href: `/projects/${p.id}`,
      panel: { kind: "visit", visit },
      sinceISO: null,
    });
  }

  // =====================================================================
  // FOLLOW-UPS: Kyle's own commitments, and work waiting on someone else,
  // each with a named person and a time it comes back.
  // =====================================================================
  const skipTypes = new Set(["lead", "revision", "client_reply", "confirmation_text", "delivery_text"]);
  const taskAction = (id: string): DeskAction => ({ kind: "task", taskId: id, allowNewDate: true, canWait: true });
  const nameOfKey = (key: string | null) => (key ? opts.roster?.find((a) => a.key === key)?.name ?? key : null);
  const waitingWords = (w: WaitingRecord) => (w.role === "creative" ? `${w.who} (creative question)` : w.role === "owner" ? `${w.who} (business or policy)` : w.who);
  const dueTaskItem = (t: OldItem, earlier: boolean) => {
    if (skipTypes.has(t.taskType)) return;
    const w = waitingNotes.get(t.id);
    // Waiting on someone until later today: still waiting, not Kyle's yet.
    if (w && Date.parse(w.followUpAt) > nowMs && Date.parse(t.chaseISO) > nowMs) {
      push({
        id: `task:${t.id}`, tab: "followups", state: "waiting", title: clean(t.title),
        reason: `Waiting on ${waitingWords(w)}${w.note ? `: ${clean(w.note)}` : ""}`, who: w.who,
        dueISO: w.followUpAt, dueWords: `Back ${etTime(w.followUpAt)}`, late: false, rank: RANK.routine,
        primary: null, actions: [taskAction(t.id)], href: t.href,
        panel: { kind: "task", lines: [{ label: "Task", value: clean(t.title) }, { label: "Waiting on", value: waitingWords(w) }, { label: "Comes back", value: etDateTime(w.followUpAt) }] },
        sinceISO: null,
      });
      return;
    }
    const back = !!w && Date.parse(w.followUpAt) <= nowMs;
    push({
      id: `task:${t.id}`, tab: "followups", state: "now",
      title: back ? `Follow up with ${w!.who}: ${clean(t.title)}` : clean(t.title),
      reason: back ? `You were waiting on ${waitingWords(w!)} until ${etDateTime(w!.followUpAt)}${w!.note ? `: ${clean(w!.note)}` : ""}` : [t.kind, t.projectTitle ? clean(t.projectTitle) : null, earlier ? `${plural(t.daysPast, "day")} past its date` : "due today", t.pushes ? `pushed ${plural(t.pushes, "time")}` : null].filter(Boolean).join(" · "),
      who: back ? w!.who : "You", dueISO: t.chaseISO, dueWords: dueWordsFor(t.chaseISO, now), late: earlier || Date.parse(t.chaseISO) < nowMs,
      rank: earlier || back ? RANK.overdue : RANK.today,
      primary: { label: back ? "Follow up" : "Handle", action: taskAction(t.id) },
      actions: [taskAction(t.id)], href: t.href,
      panel: { kind: "task", lines: [{ label: "Task", value: clean(t.title) }, { label: "Kind", value: t.kind }, ...(t.projectTitle ? [{ label: "Job", value: clean(t.projectTitle) }] : []), ...(w ? [{ label: "Waiting on", value: waitingWords(w) }] : [])] },
      sinceISO: null,
    });
  };
  for (const t of tasks?.earlier ?? []) dueTaskItem(t, true);
  for (const t of tasks?.dueToday ?? []) dueTaskItem(t, false);
  for (const t of laterTasks ?? []) {
    const chase = [t.dueAt, t.followUpAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const w = waitingNotes.get(t.id);
    const base = { tab: "followups" as const, href: t.projectId ? `/projects/${t.projectId}` : "/tasks", sinceISO: t.createdAt.toISOString() };
    const lines = [{ label: "Task", value: clean(t.title) }, ...(t.project ? [{ label: "Job", value: clean(t.project.title) }] : [])];
    if (!chase) {
      // No date at all: nobody would ever come back to it. It needs a time.
      push({
        ...base, id: `task:${t.id}`, state: "now", title: clean(t.title),
        reason: "No date or follow-up time yet. Give it one, or close it.", who: "You",
        dueISO: null, dueWords: null, late: false, rank: RANK.housekeeping,
        primary: { label: "Set a time", action: taskAction(t.id) }, actions: [taskAction(t.id)],
        panel: { kind: "task", lines }, needsFollowUp: true,
      });
      continue;
    }
    push({
      ...base, id: `task:${t.id}`, state: "waiting", title: clean(t.title),
      reason: w ? `Waiting on ${waitingWords(w)}${w.note ? `: ${clean(w.note)}` : ""}` : t.followUpAt ? "You set a follow-up time" : "Due later",
      who: w ? w.who : "You", dueISO: chase.toISOString(), dueWords: `Back ${etDate(chase)} ${etTime(chase)}`, late: false, rank: RANK.routine,
      primary: null, actions: [taskAction(t.id)],
      panel: { kind: "task", lines: [...lines, ...(w ? [{ label: "Waiting on", value: waitingWords(w) }] : []), { label: "Comes back", value: etDateTime(chase) }] },
    });
  }

  // Revisions: a reply or an assignment is not the end. The change is open
  // until the corrected work is back, reviewed, sent, and checked.
  const revProjects = [...new Set((revisions ?? []).map((r) => r.projectId).filter((x): x is string => !!x))];
  const cuts = revProjects.length
    ? await prisma.reviewSubmission.findMany({ where: { projectId: { in: revProjects } }, select: { projectId: true, status: true, createdAt: true, sentToClientAt: true }, orderBy: { createdAt: "desc" }, take: 300 }).catch(() => [])
    : [];
  const photoJobsRev = revProjects.length
    ? await prisma.photoJob.findMany({ where: { projectId: { in: revProjects } }, select: { projectId: true, stage: true, deliveredAt: true, id: true } }).catch(() => [])
    : [];
  const revisionProjects = new Set<string>();
  for (const r of revisions ?? []) {
    const street = clean(streetOf(r.project?.title));
    const photoLane = (r.dedupeKey ?? "").includes("photo");
    const latest = cuts.find((c) => c.projectId === r.projectId && c.createdAt > r.createdAt) ?? null;
    const pj = photoJobsRev.find((j) => j.projectId === r.projectId) ?? null;
    const promise = r.project?.promisedDueAt ?? r.project?.deliveryDue ?? null;
    const follow = r.followUpAt ?? r.dueAt ?? null;
    const editor = r.assignedKey && r.assignedKey !== opts.person.key ? nameOfKey(r.assignedKey) : null;
    if (r.projectId) revisionProjects.add(r.projectId);
    const lines = [{ label: "Change asked", value: clean(r.title) }, ...(r.project?.client ? [{ label: "Client", value: clean(r.project.client.name) }] : []), { label: "Opened", value: etDateTime(r.createdAt) }];
    const base = { id: `rev:${r.id}`, tab: "followups" as const, href: r.projectId ? (photoLane ? `/projects/${r.projectId}` : `/review/${r.projectId}`) : null, sinceISO: r.createdAt.toISOString() };
    let state: DeskState; let title: string; let reason: string; let who: string | null; let due: Date | null; let primary: DeskAction | null; let needs = false;
    if (photoLane && pj && pj.deliveredAt && pj.deliveredAt > r.createdAt) {
      [state, title, reason, who, due, primary] = ["now", `Check the corrected photos for ${street}, then close the change`, `Corrected photos delivered ${etDateTime(pj.deliveredAt)}. Confirm with the client it is what they asked for.`, "You", null, taskAction(r.id)];
    } else if (photoLane && pj && ["REVISION_REQUESTED", "FIXING", "READY", "DELIVERING", "QC_REVIEW"].includes(pj.stage)) {
      [state, title, reason, who, due, primary] = ["waiting", `Photo change for ${street}`, "The corrected photos are in Photo Delivery (QC & Delivery). Assigned is not completed: it stays open until they are delivered and checked.", "Photo Delivery", follow ?? promise, null];
    } else if (latest?.sentToClientAt) {
      [state, title, reason, who, due, primary] = ["now", `Check the corrected video for ${street} with the client, then close the change`, `Corrected version sent ${etDateTime(latest.sentToClientAt)}. Replied or sent is not resolved: confirm it is what they asked for.`, "You", null, taskAction(r.id)];
    } else if (latest?.status === "APPROVED") {
      [state, title, reason, who, due, primary] = ["waiting", `Corrected video for ${street}`, `Approved in review, not sent yet: it is in QC & Delivery to send.`, "You (in QC & Delivery)", follow ?? promise, null];
    } else if (latest?.status === "PENDING") {
      [state, title, reason, who, due, primary] = ["waiting", `Corrected video for ${street} is in review`, `Corrected work returns to review, not done: waiting on ${creativeName}.`, creativeName, follow ?? promise, null];
    } else if (editor) {
      [state, title, reason, who, due, primary] = ["waiting", `Change for ${street} with ${editor}`, `Assigned to ${editor}, not done yet.`, editor, follow ?? promise, null];
    } else {
      [state, title, reason, who, due, primary] = ["now", `Route the client's change for ${street}`, "Nobody has this change yet. Give it to the editor, then set when to check back.", "You", null, { kind: "link", label: "Open the job", href: base.href ?? "/review" }];
    }
    if (state === "waiting" && !due) { state = "now"; needs = true; reason = `${reason} No follow-up time is set.`; primary = taskAction(r.id); }
    if (state === "waiting" && due && due.getTime() <= nowMs) { state = "now"; reason = `${reason} The follow-up time has passed.`; title = `Follow up: ${title}`; primary = primary ?? taskAction(r.id); }
    push({
      ...base, state, title, reason, who,
      dueISO: due?.toISOString() ?? null, dueWords: due ? (due.getTime() <= nowMs ? dueWordsFor(due.toISOString(), now) : `Back ${etDate(due)} ${etTime(due)}`) : null,
      late: !!due && due.getTime() <= nowMs,
      rank: state === "now" ? (due && due.getTime() <= nowMs ? RANK.overdue : RANK.today) : RANK.routine,
      primary: state === "now" && primary ? { label: actionLabel(primary), action: primary } : null,
      actions: [...(primary ? [primary] : []), ...(primary?.kind === "task" ? [] : [taskAction(r.id)])],
      panel: { kind: "task", lines: [...lines, { label: "Where it stands", value: reason }] },
      needsFollowUp: needs,
    });
  }
  // A photo change asked AFTER the photos went out (Alex's lamp): a revision
  // with a link back to its job, never that job's shoot request.
  for (const a of photoAsks ?? []) {
    const delivered = photoDelivered.get(a.projectId!);
    if (!delivered || a.askedAt <= delivered) continue;
    const proj = await prisma.project.findUnique({ where: { id: a.projectId! }, select: { title: true } }).catch(() => null);
    const street = clean(streetOf(proj?.title));
    const ageH = (nowMs - a.askedAt.getTime()) / HOUR;
    push({
      id: `ask:${a.id}`, tab: "followups", state: "now",
      title: `Route the photo change for ${street}`,
      reason: `Asked after delivery: "${short(clean(a.summary?.trim() || a.text), 90)}"`,
      who: "You", dueISO: new Date(a.askedAt.getTime() + DAY).toISOString(), dueWords: dueWordsFor(new Date(a.askedAt.getTime() + DAY).toISOString(), now), late: ageH >= 24,
      rank: ageH >= 24 ? RANK.overdue : RANK.today,
      primary: { label: "Open photos", action: { kind: "link", label: "Open photos", href: `/projects/${a.projectId}` } },
      actions: [{ kind: "link", label: "Open photos", href: `/projects/${a.projectId}` }, { kind: "ask", askId: a.id, askKind: "SPECIAL_REQUEST" }],
      href: `/projects/${a.projectId}`,
      panel: { kind: "task", lines: [{ label: "The client asked", value: clean(a.text) }, { label: "Asked", value: etDateTime(a.askedAt) }, { label: "Photos delivered", value: etDateTime(delivered) }] },
      sinceISO: a.askedAt.toISOString(),
    });
  }
  // Video edits and reviews not yet approved: the editor's or the creative
  // manager's move, chased by Kyle once the promise is near or past.
  const jobRows = jobs?.rows ?? [];
  for (const r of [...(board?.lanes.late ?? []), ...(board?.lanes.today ?? [])]) {
    if (excludedProjects.has(r.projectId) || revisionProjects.has(r.projectId)) continue;
    const inReview = r.cutStatus === "PENDING";
    const editor = chipPerson(jobRows.find((j) => j.projectId === r.projectId)?.video?.label) ?? "the editor";
    const who = inReview ? creativeName : editor;
    const street = clean(r.street);
    const due = r.promiseISO;
    const late = r.late;
    push({
      id: `edit:${r.key}`, tab: "followups", state: late ? "now" : "waiting",
      title: late ? (inReview ? `Ask ${creativeName} to review the late video for ${street}` : `Chase ${editor} on the late video for ${street}`) : `${street}: ${clean(r.label).toLowerCase()} due today`,
      reason: `${inReview ? `Waiting on ${creativeName}'s review` : `Waiting on ${editor}`}: ${clean(r.stage)}`,
      who, dueISO: due, dueWords: late && r.lateHours != null ? `Late by ${lateWords(r.lateHours)}` : dueWordsFor(due, now), late,
      rank: late ? RANK.overdue : RANK.today,
      primary: late ? { label: "Open in Videos", action: { kind: "link", label: "Open in Videos", href: r.reviewHref ?? "/review" } } : null,
      actions: [{ kind: "link", label: "Open in Videos", href: r.reviewHref ?? "/review" }],
      href: r.reviewHref ?? "/review",
      panel: { kind: "task", lines: [{ label: "Video", value: `${street} · ${clean(r.label)}` }, { label: "Where it stands", value: clean(r.stage) }, { label: "Waiting on", value: who }, ...(due ? [{ label: "Promised", value: etDateTime(due) }] : [])] },
      sinceISO: null,
    });
  }
  // Missing upload details from a photographer (the 10 AM nudge's own read).
  const recentShoots = await prisma.project.findMany({
    where: { shootDate: { gte: new Date(nowMs - 4 * DAY), lt: now }, status: { notIn: ["CANCELLED", "ON_HOLD", "DELIVERED"] }, ...(ex.length ? { clientId: { notIn: ex } } : {}) },
    select: { id: true, title: true },
    take: 60,
  }).catch(() => null);
  const reminds = recentShoots?.length ? await remindViewsFor(recentShoots.map((p) => p.id), now).catch(warn("photographer reminders")) : new Map<string, RemindView>();
  for (const [projectId, view] of reminds ?? []) {
    const proj = recentShoots!.find((p) => p.id === projectId);
    const street = clean(streetOf(proj?.title));
    const who = view.photographer ? clean(view.photographer) : "the photographer";
    const backAt = view.last ? Date.parse(view.last.atISO) + REMIND_GAP_MS : null;
    const waiting = backAt != null && backAt > nowMs;
    const action: DeskAction = { kind: "remind", projectId, street, view };
    push({
      id: `remind:${projectId}`, tab: "followups", state: waiting ? "waiting" : "now",
      title: waiting ? `${street}: waiting on ${who} for the upload details` : `Get the upload details from ${who} for ${street}`,
      reason: `Missing: ${view.missing.join(", ")}${view.last ? ` · last reminded ${view.last.words}` : ""}`,
      who, dueISO: waiting ? new Date(backAt!).toISOString() : null, dueWords: waiting ? `Back ${etTime(new Date(backAt!))}` : null, late: false,
      rank: RANK.today,
      primary: waiting ? null : { label: "Remind", action }, actions: [action], href: `/projects/${projectId}`,
      panel: { kind: "task", lines: [{ label: "Job", value: street }, { label: "Missing", value: view.missing.join(", ") }, { label: "Photographer", value: who }] },
      sinceISO: null,
    });
  }

  // =====================================================================
  // THE TABS, DO NEXT, THE STATUS LINE
  // =====================================================================
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  const unavailableBy: Record<DeskTabKey, string[]> = {
    delivery: [!queue ? "photo delivery" : null, !board ? "videos" : null, !notTold ? "client notices" : null].filter((x): x is string => !!x),
    replies: [!comms ? "client messages" : null, !leads ? "leads" : null].filter((x): x is string => !!x),
    prep: [!visits ? "the shoot calendar" : null].filter((x): x is string => !!x),
    followups: [!tasks || !laterTasks ? "your tasks" : null, !revisions ? "revisions" : null, !board ? "videos" : null].filter((x): x is string => !!x),
    closeout: [],
  };
  const byDue = (a: DeskItem, b: DeskItem) => a.rank - b.rank || Number(b.late) - Number(a.late) || (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999") || a.title.localeCompare(b.title);
  const prepOrder = (a: DeskItem, b: DeskItem) => {
    const v = (i: DeskItem) => (i.panel.kind === "visit" ? i.panel.visit : null);
    const firstWeight = (i: DeskItem) => (v(i) && (v(i)!.confirmation.state === "open" || v(i)!.confirmation.state === "none" || v(i)!.gaps.length || v(i)!.conflicts.length) ? 0 : 1);
    return firstWeight(a) - firstWeight(b) || (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999");
  };
  const tabs: DeskTab[] = DESK_TABS.filter((t) => t.key !== "closeout").map((t) => {
    const mine = unique.filter((i) => i.tab === t.key);
    const sort = t.key === "prep" ? prepOrder : t.key === "replies" ? (a: DeskItem, b: DeskItem) => Number(b.late) - Number(a.late) || (a.sinceISO ?? "").localeCompare(b.sinceISO ?? "") : byDue;
    const nowList = mine.filter((i) => i.state === "now").sort(sort);
    const unavailable = unavailableBy[t.key];
    return {
      key: t.key, label: t.label,
      count: unavailable.length && nowList.length === 0 ? null : nowList.length,
      now: nowList,
      waiting: mine.filter((i) => i.state === "waiting").sort((a, b) => (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999")),
      ok: mine.filter((i) => i.state === "ok").sort((a, b) => (a.dueISO ?? "").localeCompare(b.dueISO ?? "")),
      unavailable,
    };
  });

  const allNow = tabs.flatMap((t) => t.now);
  const doNext = rankDoNext(allNow);
  const late = allNow.filter((i) => i.late).length;
  const waitingCount = tabs.reduce((n, t) => n + t.waiting.length, 0);

  // ---- freshness ----
  const freshness: Freshness[] = FRESH_JOBS.map((f) => freshnessOf(cron ? cron.find((j) => j.job === f.job) ?? null : null, f.label, f.job, now));
  if (!cron) freshness.forEach((f) => Object.assign(f, { state: "unknown", words: "sync health couldn't be read" }));
  const unavailable = [...new Set(Object.values(unavailableBy).flat())];
  for (const what of unavailable) freshness.push({ key: `read:${what}`, label: what[0].toUpperCase() + what.slice(1), state: "failed", atISO: null, words: "couldn't be read just now" });

  // ---- closeout ----
  let record: CloseoutRecord = { ticks: {} };
  try {
    if (closeRec?.value) {
      const parsed = JSON.parse(closeRec.value) as Partial<CloseoutRecord>;
      record = { ticks: parsed.ticks ?? {}, finished: parsed.finished ?? null };
    }
  } catch { /* unreadable: no ticks */ }
  const tab = (k: DeskTabKey) => tabs.find((t) => t.key === k)!;
  const dueOpen = tab("delivery").now.concat(tab("delivery").waiting).filter((i) => !!i.dueISO && Date.parse(i.dueISO) < endToday.getTime());
  const nextDayOpen = tab("prep").now.filter((i) => i.panel.kind === "visit" && i.panel.visit.dayKey !== dayKey);
  const nextDayAll = [...tab("prep").now, ...tab("prep").ok].filter((i) => i.panel.kind === "visit" && i.panel.visit.dayKey !== dayKey);
  const promisesOpen = tab("followups").now.filter((i) => i.needsFollowUp || i.late);
  const derived: Record<CloseoutKey, { auto: boolean | null; words: string }> = {
    comms: tab("replies").count == null ? { auto: null, words: "Messages couldn't be read" }
      : tab("replies").count === 0 ? { auto: true, words: "Every client has an answer" }
      : { auto: false, words: `${plural(tab("replies").count!, "conversation")} still waiting on you` },
    deliveries: tab("delivery").unavailable.length ? { auto: null, words: "Deliveries couldn't be read" }
      : dueOpen.length === 0 ? { auto: true, words: "Everything due today is out" }
      : { auto: false, words: `${plural(dueOpen.length, "job")} due today still open` },
    promises: promisesOpen.length === 0 ? { auto: true, words: "Every follow-up has a person and a time" }
      : { auto: false, words: `${plural(promisesOpen.length, "follow-up")} overdue or missing a time` },
    nextday: tab("prep").count == null ? { auto: null, words: "The calendar couldn't be read" }
      : nextDayOpen.length === 0 ? { auto: true, words: nextDayAll.length ? `${plural(nextDayAll.length, "visit")} ready through ${etDate(etAt(nextDay, 12))}` : `No shoots through ${etDate(etAt(nextDay, 12))}` }
      : { auto: false, words: `${plural(nextDayOpen.length, "visit")} through ${etDate(etAt(nextDay, 12))} not ready` },
    blockers: late === 0 ? { auto: true, words: "Nothing late or blocked" } : { auto: null, words: `${plural(late, "item")} late: escalate each, then tick` },
  };
  const lines: CloseoutLine[] = CLOSEOUT_ITEMS.map((c) => {
    const tick = record.ticks[c.key] ?? null;
    const d = derived[c.key];
    return { key: c.key, label: c.label, auto: d.auto, autoWords: d.words, tick: tick ? { atISO: tick.at, by: tick.by } : null, done: d.auto === true || !!tick };
  });
  const finished = record.finished ? { atISO: record.finished.at, by: record.finished.by } : null;
  const newSinceFinish = finished ? allNow.filter((i) => !!i.sinceISO && i.sinceISO > finished.atISO).length : 0;

  // ---- the day's summary, from what actually happened ----
  const [approvals, sent, notices, closed, asksDone, texts] = await Promise.all([
    prisma.photoJobEvent.findMany({ where: { at: { gte: startToday }, action: { startsWith: "approved:" } }, select: { actor: true, job: { select: { projectId: true } } }, take: 200 }).catch(() => []),
    prisma.reviewSubmission.findMany({ where: { sentToClientAt: { gte: startToday } }, select: { sentToClientBy: true, project: { select: { title: true } } }, take: 200 }).catch(() => []),
    prisma.reviewSubmission.findMany({ where: { clientNoticeAt: { gte: startToday } }, select: { clientNoticeBy: true, project: { select: { title: true } } }, take: 200 }).catch(() => []),
    checklistTasksClosedToday(now, { person: opts.person, excludeClientIds: ex, scrub: true }).catch(() => [] as ClosedTask[]),
    prisma.clientAsk.findMany({ where: { OR: [{ confirmedAt: { gte: startToday } }, { doneAt: { gte: startToday } }] }, select: { summary: true, text: true, confirmedBy: true, doneBy: true }, take: 200 }).catch(() => []),
    opts.person.teamMemberId
      ? prisma.commLog.findMany({ where: { direction: "out", occurredAt: { gte: startToday }, senderTeamMemberId: opts.person.teamMemberId }, select: { clientName: true }, take: 300 }).catch(() => [])
      : Promise.resolve([] as { clientName: string | null }[]),
  ]);
  const approvalTitles = new Map(
    approvals.length ? (await prisma.project.findMany({ where: { id: { in: [...new Set(approvals.map((a) => a.job.projectId))] } }, select: { id: true, title: true } }).catch(() => [])).map((p) => [p.id, p.title] as const) : [],
  );
  const completed: DaySummary["completed"] = [];
  const addDone = (what: string, examples: string[]) => { if (examples.length) completed.push({ what, count: examples.length, examples: examples.slice(0, 4).map((e) => clean(e)) }); };
  addDone("Photo sets approved for delivery", approvals.filter((a) => isMe(a.actor)).map((a) => streetOf(approvalTitles.get(a.job.projectId))));
  addDone("Videos sent", sent.filter((s) => isMe(s.sentToClientBy)).map((s) => streetOf(s.project?.title)));
  addDone("Clients told their video is up", notices.filter((s) => isMe(s.clientNoticeBy)).map((s) => streetOf(s.project?.title)));
  addDone("Client messages sent", [...new Set(texts.map((t) => t.clientName ?? "a client"))]);
  addDone("Requests checked", asksDone.filter((a) => isMe(a.confirmedBy) || isMe(a.doneBy)).map((a) => short(a.summary?.trim() || a.text, 60)));
  addDone("Tasks closed", closed.map((t) => `${t.title} (${t.how})`));
  const summary: DaySummary = {
    completed,
    completedTotal: completed.reduce((n, c) => n + c.count, 0),
    pending: tabs.map((t) => ({ tab: t.label, now: t.count, waiting: t.waiting.length })),
    blockers: [...allNow.filter((i) => i.late || i.rank === RANK.blocker).slice(0, 5).map((i) => i.title), ...freshness.filter((f) => f.state === "failed" || f.state === "stale").map((f) => `${f.label}: ${f.words}`)],
    tomorrow: {
      dayWords: etFullDate(etAt(nextDay, 12)),
      lines: [
        `${plural(nextDayAll.length, "visit")} on the calendar${nextDayOpen.length ? `, ${nextDayOpen.length} not ready yet` : ""}`,
        ...(() => {
          const b = etDayBoundsUtc(nextDay);
          const dueThen = unique.filter((i) => i.tab === "delivery" && !!i.dueISO && Date.parse(i.dueISO) >= b.start.getTime() && Date.parse(i.dueISO) < b.end.getTime()).length;
          const back = unique.filter((i) => i.state === "waiting" && !!i.dueISO && Date.parse(i.dueISO) < b.end.getTime()).length;
          return [`${plural(dueThen, "job")} due to go out`, `${plural(back, "follow-up")} coming back`];
        })(),
      ],
    },
  };
  const closeout: Closeout = { dayKey, lines, allDone: lines.every((l) => l.done), finished, newSinceFinish, summary };

  // ---- the status line ----
  const total = allNow.length;
  const blockers = allNow.filter((i) => i.rank === RANK.blocker).length;
  const parts = [
    total === 0 ? "Nothing needs you right now." : `${plural(total, "item")} ${total === 1 ? "needs" : "need"} you${late ? `, ${late} late` : ""}.`,
    waitingCount ? `${waitingCount} waiting on others, each with a person and a time.` : null,
    unavailable.length ? `Couldn't read ${unavailable.join(", ")}: those counts may be missing items.` : null,
  ].filter(Boolean);
  const status = { line: parts.join(" "), tone: (blockers > 0 || late > 0 ? "bad" : total > 0 || unavailable.length ? "warn" : "ok") as "ok" | "warn" | "bad", now: total, late, waiting: waitingCount };

  return {
    nowISO: now.toISOString(), dayKey, dateWords: etFullDate(now), person: opts.person.name, people: { creative: creativeName, owner: ownerName }, readOnly: !!opts.readOnly,
    freshness, unavailable, status, doNext, tabs: [...tabs, { key: "closeout", label: "Closeout", count: lines.filter((l) => !l.done).length, now: [], waiting: [], ok: [], unavailable: [] }],
    closeout,
  };
}

/** Whose desk: the signed-in office login's own (Kyle on his), else Kyle's. */
export async function deskPerson(
  me: { name?: string | null; email?: string | null; teamMemberId?: string | null } | null,
  roster: Assignee[],
): Promise<ChecklistPerson & { name: string }> {
  if (me?.teamMemberId) return { key: viewerAssigneeKey(me, roster), teamMemberId: me.teamMemberId, name: (me.name ?? "You").split(" ")[0] };
  return (await kylePerson(roster).catch(() => null)) ?? { key: "kyle", teamMemberId: null, name: "Kyle" };
}

/** The desk for a viewer, the way the dashboard reads it (test clients out
 *  unless ?test=1; read-only while the owner previews a login). */
export async function officeDeskFor(
  me: { name?: string | null; email?: string | null; teamMemberId?: string | null; impersonating?: boolean } | null,
  opts: { now?: Date; includeTest?: boolean } = {},
): Promise<OfficeDesk> {
  const [roster, excludeClientIds] = await Promise.all([
    listAssignees().catch(() => [] as Assignee[]),
    opts.includeTest ? Promise.resolve([] as string[]) : syntheticClientIds(),
  ]);
  const person = await deskPerson(me, roster);
  return buildOfficeDesk({ now: opts.now, includeTest: opts.includeTest, excludeClientIds, person, roster, readOnly: !!me?.impersonating });
}

/** The words on a button for an action. */
export function actionLabel(a: DeskAction): string {
  switch (a.kind) {
    case "photo-approve": return "Review photos";
    case "video-send": return a.label === "Try again" ? "Try again" : "Send video";
    case "video-push": return a.canDeliverNow ? "Deliver now" : "Release";
    case "video-notice": return "Record the notice";
    case "reply": return "Reply";
    case "task": return "Handle";
    case "ask": return "Check request";
    case "remind": return "Remind";
    case "confirm": return "Confirm";
    case "brief-send": return "Send brief now";
    case "link": return a.label;
  }
}
