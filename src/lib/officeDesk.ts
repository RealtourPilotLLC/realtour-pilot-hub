import "server-only";
import { prisma } from "@/lib/prisma";
import { loadQueue } from "@/app/ops/photo-delivery/data";
import type { QueueCard, QueueColumnKey, QueueData, ThumbRef } from "@/components/photoDelivery/types";
import { HOLD_REASON_LABEL } from "@/components/photoDelivery/format";
import { videoDeliveryBoard, type VideoDeliveryBoard, type VideoRow } from "@/lib/videoDelivery";
import { clientNotToldYet, type NotTold } from "@/lib/readyToSend";
import { deliveryNoticeIncidents, type DeliveryNoticeIncident } from "@/lib/deliveryNoticeIncidents";
import { unansweredCommsBoards, type CommsGroup } from "@/lib/commsBoard";
import { schedulingBoard, specialRequestsBoard } from "@/lib/clientAsks";
import { checklistTasks, checklistTasksClosedToday, personTaskWhere, WEEK_OLD_DAYS, type ChecklistPerson, type ClosedTask, type OldItem } from "@/lib/taskAging";
import { jobsBoard, type JobsBoard } from "@/lib/jobsBoard";
import { chipPerson, kylePerson, MESSAGE_BEHIND_HOURS, waitingClientReplyHref, lateWords } from "@/lib/opsHome";
import { remindViewsFor, REMIND_GAP_MS, type RemindView } from "@/lib/remindPhotographer";
import { parseAccessBrief, type AccessInfo } from "@/lib/opsDay";
import { parseEvidence } from "@/lib/statusEvidence";
import { briefStatusForAppointments, type BriefState } from "@/lib/photographerBrief";
import { tasksAssignedTo, type DelegatedTask, type DelegationState } from "@/lib/delegation";
import { expectedCrons, staleAfterMs, type CronJobHealth } from "@/lib/cronHealth";
import { scrubMoney } from "@/lib/text";
import { RERUN_LABEL } from "@/lib/topazRerun";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { listAssignees, viewerAssigneeKey, type Assignee } from "@/lib/assignees";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { etAt, etDate, etDateTime, etDayBoundsUtc, etDayKey, etDayStartUtc, etFullDate, etTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// KYLE'S DESK, revision 2 (Oct 23 2026, evening). Jordan: "For Kyle I feel
// like his dashboard is worse now", with a mockup. The office dashboard at "/"
// for Kyle (and any office login) is FOUR SECTIONS, all visible at once:
//   · Review & Deliver: photos, floor plans and 3D tours (one row per job,
//     each asset its own status and action, a floor plan never holding the
//     photos), then approved videos (Upload to Aryeo and send, Upload to
//     Aryeo only, Send now for "On Aryeo, not sent yet"). A video still in the
//     1080p pass is a quiet line, never an action.
//   · Client Communications: threads genuinely waiting on us, Content Program
//     messages that are Kyle's, booking requests, new leads.
//   · Today's Shoots: today and the next business day, each visit's prep
//     (confirmation, access, photographer, the brief and its Got it). A brief
//     is never suggested after the appointment's time; "Send" when none went,
//     "Resend" only when one did; an unknown state asks Kyle to verify.
//   · Requests & Follow-Ups: client revisions (where each stands), special
//     requests, tasks from Jordan, production follow-ups (missing uploads,
//     late edits), Kyle's own tasks due; waiting items collapsed until due.
// Above them: the Daily checks (Morning, Midday, End-of-day review; system
// evidence ticks what it can, a manual tick only for a real review, a tick
// never closes the work), and only a verified, time-sensitive interruption.
//
// THE RULES (kept from the first build):
//   · ONE item per underlying action, in ONE section. Every count is the
//     length of the rows it labels (deskCounts). "View all" opens the rest.
//   · "now" needs Kyle; "waiting" is someone else's move with a named person
//     and a time it comes back (and it comes back when that time passes);
//     "ok" is ready and counted nowhere.
//   · Approved is not delivered, replied is not resolved, assigned is not
//     completed, waiting is not forgotten.
//   · Kyle never sees a figure, does not bill, never approves a video.
//   · Old tasks are NOT re-dated or closed to shrink a number: a task a week
//     or more past its date leaves the overview for the backlog (one link),
//     and scripts/_live/oct23-reconcile-old-tasks.ts reconciles them against
//     their sources as a dry run.
// Every source fails on its own: a source that could not be read greys its
// own section ("?") and is named in the freshness line, never shown as zero.
//
// REVISION 3 (Oct 23 2026, evening: Jordan's updated mockup and his huddle
// with Kyle): a full-width "Next business day" card (appointments confirmed,
// access and contacts, photographer instructions; Prepare <Day> lists what is
// missing, each with its action), an "End-of-day closeout" card (the bar keeps
// the three reviews as a summary), a "Completed today" card built from real
// events only, "N awaiting files" folded under Review & Deliver, the
// photographer briefs still waiting on a Got it, every conversation opening
// with the reply engine's own draft (texts, email and Content Program
// messages), "Fixes done" on a photo job, and the tasks assigned to Kyle
// through delegation (Accept or Update until accepted).
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const DESK_SECTIONS = [
  { key: "deliver", title: "Review & Deliver", empty: "All ready media delivered" },
  { key: "comms", title: "Client Communications", empty: "No client replies needed" },
  { key: "shoots", title: "Today's Shoots", empty: "No shoots on the calendar" },
  { key: "followups", title: "Requests & Follow-Ups", empty: "Nothing due today" },
] as const;
export type DeskSectionKey = (typeof DESK_SECTIONS)[number]["key"];

/** The order of the work (the spec): shoot blockers and urgent client issues,
 *  then overdue commitments, upcoming deadlines, routine work, housekeeping. */
export const RANK = { blocker: 0, overdue: 1, today: 2, routine: 3, housekeeping: 4 } as const;
/** Sync health is read for these jobs (vercel.json names). */
export const FRESH_JOBS = [
  { job: "aryeo", label: "Aryeo orders" },
  { job: "gmail", label: "Email and texts" },
  { job: "photo-delivery", label: "Photo delivery" },
] as const;

/** The Daily checks (Jordan's revision): three reviews, each a few checks.
 *  `manual` = a person may tick it (a real review); otherwise only the system's
 *  evidence can. A tick never completes the work under it. */
export const DAILY_CHECKS = [
  { key: "morning", label: "Morning review", items: [
    { key: "am_messages", label: "Review client messages", manual: true },
    { key: "am_shoots", label: "Check today's shoot readiness", manual: true },
    { key: "am_deliveries", label: "Review due deliveries and production blockers", manual: true },
  ] },
  { key: "midday", label: "Midday review", items: [
    { key: "md_new", label: "Review new messages and returned media", manual: true },
    { key: "md_commitments", label: "Follow up on commitments due today", manual: false },
  ] },
  { key: "eod", label: "End-of-day review", items: [
    { key: "eod_messages", label: "Client messages reviewed", manual: true },
    { key: "eod_deliveries", label: "Due deliveries completed or exceptions noted", manual: true },
    { key: "eod_owners", label: "Open requests have owners and follow-up times", manual: false },
    { key: "eod_nextday", label: "Next business day prepared", manual: false },
  ] },
] as const;
export type CheckGroupKey = (typeof DAILY_CHECKS)[number]["key"];
export type CheckKey = (typeof DAILY_CHECKS)[number]["items"][number]["key"];
export const CHECK_KEYS: CheckKey[] = DAILY_CHECKS.flatMap((g) => g.items.map((i) => i.key));
export const MANUAL_CHECKS: CheckKey[] = DAILY_CHECKS.flatMap((g) => g.items.filter((i) => i.manual).map((i) => i.key));

/** The AppSetting row that holds one ET day's checks. */
export const closeoutSettingKey = (dayKey: string) => `office_closeout:${dayKey}`;
/** The AppSetting row naming who a task waits on (set with "Waiting on"). */
export const waitingSettingKey = (taskId: string) => `office_waiting:${taskId}`;
export const WAITING_PREFIX = "office_waiting:";

export type CloseoutRecord = { ticks: Partial<Record<CheckKey, { at: string; by: string }>>; finished?: { at: string; by: string } | null };
export type WaitingRecord = { who: string; role: "creative" | "owner" | "other"; note: string | null; at: string; by: string; followUpAt: string };

// ---- types ----------------------------------------------------------------------------

export type DeskState = "now" | "waiting" | "ok";

/** What a button does. Every kind is an EXISTING action (the server actions
 *  the screens already use); the side panel renders the matching control. */
export type DeskAction =
  | { kind: "photo-approve"; jobId: string; street: string }
  | { kind: "video-send"; submissionId: string; street: string; label: "Upload to Aryeo and send" | "Send" | "Try again"; openAsks: { summary: string; askedBy: string | null }[]; asksUnknown: boolean; listingWarning: string | null; uploadOnly: boolean }
  | { kind: "video-push"; submissionId: string; canDeliverNow: boolean; canRelease: boolean; uploadedOnly: boolean }
  | { kind: "video-notice"; row: NotTold }
  /** the reply engine: a draft on open (texts: generateReply; email: the Gmail task's draft), sent through its own send */
  | { kind: "reply"; threadKey: string; family: "phone" | "email"; clientId: string | null; groupKey: string; phone: string | null; href: string; taskId: string | null }
  /** a Content Program message: drafted from the program conversation, posted with the program's own reply */
  | { kind: "program-reply"; enrollmentId: string; href: string }
  /** a task assigned to Kyle through delegation: Accept until accepted, then Update (and the rest of its actions) */
  | { kind: "delegation"; taskId: string; state: DelegationState; needsVerification: boolean }
  | { kind: "follow-up"; clientId: string | null; projectId: string | null; title: string }
  | { kind: "task"; taskId: string; allowNewDate: boolean; canWait: boolean }
  | { kind: "ask"; askId: string; askKind: "SPECIAL_REQUEST" | "SCHEDULING" }
  | { kind: "remind"; projectId: string; street: string; view: RemindView }
  /** the confirmation text (the template, through the outbox), or "confirmed another way" */
  | { kind: "confirm"; taskId: string }
  /** the photographer brief's own Send brief now; `resend` only when one already went */
  | { kind: "brief-send"; teamMemberId: string; day: string; name: string; resend: boolean }
  /** "Run Topaz again" (Oct 23 2026): a finished Topaz file not sent yet (readyToSend's offer) */
  | { kind: "topaz-rerun"; jobId: string; street: string; video: string; credits: number | null; limit: number | null }
  | { kind: "link"; label: string; href: string };

export type AssetLine = {
  id: string;
  kind: "photos" | "floorplan" | "tour" | "video" | "notice";
  label: string;
  /** what is true right now, in words ("Approved by James, ready to send") */
  status: string;
  tone: "now" | "waiting" | "done" | "failed";
  late: boolean;
  dueISO: string | null;
  /** whose move it is when it is not Kyle's */
  who: string | null;
  /** context, never a checklist: what the free photo check found, who approved */
  note: string | null;
  action: DeskAction | null;
  /** a second control for the same asset, after `action` in the side panel
   *  (Oct 23 2026: "Run Topaz again" beside a video's send) */
  more?: DeskAction[];
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
  confirmation: { state: "sent" | "other" | "open" | "scheduled" | "none" | "na"; words: string; taskId: string | null };
  access: { lockbox: string | null; access: string | null; presence: string | null; contactName: string | null; contactPhone: string | null };
  /** the services THIS visit covers (the appointment's own order items) */
  services: string[];
  servicesFrom: "visit" | "order" | "none";
  /** requests made before this visit, for it (askId when it is a client ask still to check) */
  requests: { text: string; whenISO: string; askId: string | null }[];
  /** this visit's instructions from the order (special instructions, notes) */
  instructions: string[];
  /** folded: notes for the job's other visits, and order notes shared by every visit */
  earlier: { text: string; whenISO: string | null }[];
  /** changes asked after delivery: revisions, never this visit's requests */
  revisionsAfterDelivery: string[];
  conflicts: string[];
  gaps: string[];
  brief: { state: BriefState | "unknown"; words: string; why: string | null; href: string | null; sent: boolean };
  otherVisits: { whenISO: string | null; services: string[] }[];
};

export type DeskPanel =
  | { kind: "job"; projectId: string; street: string; client: string | null; assets: AssetLine[]; findings: string[]; aryeoUrl: string | null }
  | { kind: "thread"; client: string; family: "phone" | "email"; messages: { atISO: string; text: string }[]; holding: string | null; revisionNote: string | null; alsoAsked: string[] }
  | { kind: "visit"; visit: PrepVisit }
  | { kind: "task"; lines: { label: string; value: string }[] };

/** What kind of request or follow-up a row is (client revisions look different from production follow-ups). */
export type DeskTag = "revision" | "request" | "jordan" | "assigned" | "production" | "task" | "reply" | "program" | "booking" | "lead";

export type DeskItem = {
  /** canonical: one per underlying action ("media:<projectId>", "reply:phone:<key>", "task:<id>", "visit:<apptId>") */
  id: string;
  section: DeskSectionKey;
  /** Review & Deliver's two groups */
  group?: "media" | "video";
  tag?: DeskTag;
  /** Today's Shoots: today, or the next business day */
  day?: "today" | "next";
  state: DeskState;
  /** the property or the person ("30 Caedman Dr", "Mike Ciunci") */
  title: string;
  /** one short line under it ("Photos + floor plan ready", "Waiting on editor · Follow up at 11:00 AM") */
  line: string;
  /** the longer reason, in the side panel */
  reason: string;
  client: string | null;
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
  /** a follow-up that still lacks a named person or a follow-up time */
  needsFollowUp?: boolean;
  thumb?: ThumbRef | null;
  /** Client Communications: initials, channel and elapsed business time */
  initials?: string;
  channel?: string;
  elapsed?: string;
  /** Today's Shoots: the prep chip */
  chip?: { label: string; tone: "ok" | "warn" | "bad" | "muted" };
};

export type DeskSection = {
  key: DeskSectionKey;
  title: string;
  empty: string;
  /** the actionable count: ALWAYS now.length, or null when the source could not be read */
  count: number | null;
  now: DeskItem[];
  waiting: DeskItem[];
  ok: DeskItem[];
  /** quiet lines that are not actions ("2 videos finishing the Topaz pass") */
  quiet: { text: string; href: string | null }[];
  unavailable: string[];
};

export type Freshness = { key: string; label: string; state: "ok" | "stale" | "failed" | "unknown"; atISO: string | null; words: string };

export type CheckLine = {
  key: CheckKey;
  label: string;
  /** a person may tick it (a real review) */
  manual: boolean;
  /** derived from the system: true done, false not yet, null not derivable */
  auto: boolean | null;
  autoWords: string;
  tick: { atISO: string; by: string } | null;
  done: boolean;
};
export type CheckGroup = {
  key: CheckGroupKey; label: string; lines: CheckLine[]; done: boolean;
  /** when the last tick that completed it was made (null when the system's evidence completed it, or it is not done) */
  completedAtISO: string | null;
};

export type DaySummary = {
  /** what Kyle finished today, newest first, from real events only (photo approvals, sends, replies, checks, confirmations) */
  activity: { atISO: string; what: string; detail: string | null }[];
  completed: { what: string; count: number; examples: string[] }[];
  completedTotal: number;
  pending: { section: string; now: number | null; waiting: number }[];
  blockers: string[];
  tomorrow: { dayWords: string; lines: string[] };
};

export type DailyChecks = {
  dayKey: string;
  groups: CheckGroup[];
  finished: { atISO: string; by: string } | null;
  /** items that came onto the desk after the day was finished (finishing never hides them) */
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
  /** only a verified, time-sensitive issue that interrupts the day (points at an item; never a second item) */
  urgent: { id: string; text: string }[];
  sections: DeskSection[];
  checks: DailyChecks;
  /** Kyle's own tasks and leads a week or more past their date: off the overview, one link */
  backlog: { count: number; href: string };
  /** the next business day, at a glance; Prepare lists what is missing (the visit rows' own actions) */
  nextDay: NextDay;
  /** briefs that went and still wait on the photographer's Got it, by day */
  briefsPending: BriefPending[];
  /** "Other conversations are up to date": only when the messages were read and the mail sync is fresh */
  commsFresh: boolean;
};

export type NextDay = {
  dayKey: string;
  /** "Monday" */
  dayName: string;
  visits: number;
  appointments: { confirmed: number; pending: number };
  access: { recorded: number; missing: number };
  instructions: { ready: number; review: number };
  /** what is missing, one line per problem, each pointing at its visit row (never a second item) */
  missing: { visitId: string; street: string; timeISO: string | null; problem: string; action: DeskAction | null }[];
};

export type BriefPending = { visitId: string; day: "today" | "next"; street: string; timeISO: string | null; photographer: string; teamMemberId: string; dayKey: string; phone: string | null; state: "sent" | "changed" };

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

/** Waiting time that counts weekdays only (a Friday-night text read on Monday
 *  morning is not "60 hours"): "24 min", "3 business hours", "2 business days". */
export function businessElapsedWords(fromISO: string, now: Date): string {
  let ms = 0;
  let t = Date.parse(fromISO);
  const end = now.getTime();
  while (t < end) {
    const step = Math.min(end, etDayBoundsUtc(etDayKey(new Date(t))).end.getTime());
    const dow = dowOf(etDayKey(new Date(t)));
    if (dow !== 0 && dow !== 6) ms += step - t;
    t = step;
  }
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} business ${h === 1 ? "hour" : "hours"}`;
  const d = Math.round((h / 24) * 10) / 10;
  return `${d} business ${d === 1 ? "day" : "days"}`;
}

/** A sync job's health in words. A failed or late sync is said, never read as zero. */
export function freshnessOf(j: Pick<CronJobHealth, "lastRunAt" | "lastOk" | "stale" | "neverRecorded"> | null, label: string, key: string, now: Date): Freshness {
  if (!j || j.neverRecorded || !j.lastRunAt) return { key, label, state: "unknown", atISO: null, words: "no sync recorded" };
  if (j.lastOk === false) return { key, label, state: "failed", atISO: j.lastRunAt, words: `last sync failed ${agoWords(j.lastRunAt, now)}` };
  if (j.stale) return { key, label, state: "stale", atISO: j.lastRunAt, words: `last synced ${agoWords(j.lastRunAt, now)}, late` };
  return { key, label, state: "ok", atISO: j.lastRunAt, words: `synced ${agoWords(j.lastRunAt, now)}` };
}

/** The section counts, from the lists themselves: a count can never disagree with what it labels. */
export function deskCounts(sections: DeskSection[]): Record<DeskSectionKey, number | null> {
  return Object.fromEntries(sections.map((s) => [s.key, s.count])) as Record<DeskSectionKey, number | null>;
}

/** "MC" from "Mike Ciunci"; "(7" never: digits and symbols are skipped. */
export function initialsOf(name: string): string {
  const parts = name.replace(/[^A-Za-z\s'-]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "")).toUpperCase();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const streetOf = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || "a job";
const short = (s: string, n = 110) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const first = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "";

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

/** What the brief offers for a visit (pure: the drill holds each rule).
 *  NEVER a pre-shoot brief once the appointment has started; "Send" when no
 *  brief went, "Resend" only when one did; an unknown state is Kyle's to verify. */
export function briefOffer(o: { state: BriefState | "unknown"; sent: boolean; started: boolean; why: string | null }): { problem: string | null; waiting: boolean; send: "send" | "resend" | null } {
  if (o.started) return { problem: null, waiting: false, send: null };
  if (o.state === "unknown") return { problem: "Brief status unknown: check the photographer has this visit's instructions", waiting: false, send: null };
  if (o.state === "off" || o.state === "acknowledged") return { problem: null, waiting: false, send: null };
  if (o.state === "failed") return { problem: `Brief not sent${o.why ? `: ${o.why.replace(/^(Update )?not sent:\s*/i, "")}` : ""}`, waiting: false, send: o.sent ? "resend" : "send" };
  if (o.state === "pending") {
    // "Not sent before the day's first shoot": a later visit that day still needs it.
    return /before the day's first shoot/i.test(o.why ?? "") ? { problem: "Brief not sent yet", waiting: false, send: o.sent ? "resend" : "send" } : { problem: null, waiting: false, send: null };
  }
  // sent or changed: waiting on the photographer's Got it until the briefing build says it needs a person.
  const urgent = !!o.why && /First shoot|not acknowledged/i.test(o.why);
  if (urgent) return { problem: o.state === "changed" ? "Instructions changed and no new Got it yet" : "No Got it from the photographer yet", waiting: false, send: "resend" };
  return { problem: null, waiting: true, send: null };
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

/** Tasks the hub files elsewhere on the desk (or never as Kyle's own to-do). */
const NOT_A_FOLLOW_UP = new Set(["lead", "revision", "client_reply", "confirmation_text", "delivery_text", "program_message"]);
const fromJordan = (t: { source?: string | null; reasonCreated?: string | null }) => t.source === "assistant" || /\bJordan\b/.test(t.reasonCreated ?? "");

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
  const nowMs = now.getTime();
  const current = Math.abs(nowMs - Date.now()) < 60_000;
  const { companyHolidayName } = await import("@/lib/paySavings").catch(() => ({ companyHolidayName: (_: string) => null as string | null }));
  const days = prepDayKeys(now, (k) => !!companyHolidayName(k));
  const nextDay = days.at(-1)!;

  const me = opts.person.teamMemberId
    ? await prisma.teamMember.findUnique({ where: { id: opts.person.teamMemberId }, select: { name: true, email: true } }).catch(() => null)
    : null;
  const myNames = [me?.name, opts.person.name, me?.email].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const isMe = (s: string | null | undefined) => !!s && myNames.some((n) => s.toLowerCase() === n || s.toLowerCase().startsWith(`${n} `) || s.toLowerCase().includes(`<${n}>`));
  const kyleTask = [...(opts.person.key ? [{ assignedKey: opts.person.key }] : []), ...(opts.person.teamMemberId ? [{ assignedKey: null, ownerId: opts.person.teamMemberId }] : [])];
  const clientScope = ex.length ? { AND: [{ OR: [{ clientId: null }, { clientId: { notIn: ex } }] }] } : {};

  const [queue, board, notTold, incidents, comms, tasks, laterTasks, revisions, photoAsks, visits, jobs, cron, closeRec, waitingRecs, creative, owner, leads, programTasks, sched, special] = await Promise.all([
    loadQueue({ now }).catch(warn("photo queue")) as Promise<QueueData | null>,
    videoDeliveryBoard(current ? {} : { now }).catch(warn("video board")) as Promise<VideoDeliveryBoard | null>,
    clientNotToldYet({ excludeClientIds: ex }).catch(warn("client not told")) as Promise<NotTold[] | null>,
    deliveryNoticeIncidents(undefined, scope).catch(warn("delivery texts")) as Promise<DeliveryNoticeIncident[] | null>,
    unansweredCommsBoards(now, scope).catch(warn("client messages")),
    checklistTasks(now, { person: opts.person, excludeClientIds: ex, scrub: true, roster: opts.roster }).catch(warn("tasks")),
    prisma.smartTask.findMany({
      where: {
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        taskType: { notIn: [...NOT_A_FOLLOW_UP] },
        AND: [personTaskWhere(opts.person, scope), { OR: [{ dueAt: null, followUpAt: null }, { followUpAt: { gte: etDayBoundsUtc(nextKey(dayKey)).start } }, { followUpAt: null, dueAt: { gte: etDayBoundsUtc(nextKey(dayKey)).start } }] }],
      },
      select: { id: true, title: true, taskType: true, source: true, reasonCreated: true, dueAt: true, followUpAt: true, createdAt: true, projectId: true, project: { select: { title: true } } },
      orderBy: { createdAt: "asc" },
      take: 200,
    }).catch(warn("later tasks")),
    prisma.smartTask.findMany({
      where: { taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] }, ...clientScope },
      select: {
        id: true, title: true, assignedKey: true, dueAt: true, followUpAt: true, createdAt: true, dedupeKey: true, projectId: true, clientId: true,
        project: { select: { title: true, promisedDueAt: true, deliveryDue: true, client: { select: { name: true } } } },
      },
      orderBy: { createdAt: "asc" },
      take: 60,
    }).catch(warn("revisions")),
    prisma.clientAsk.findMany({
      where: { kind: "SPECIAL_REQUEST", state: "OPEN", medium: { in: ["photo", "both"] }, projectId: { not: null }, ...(ex.length ? { clientId: { notIn: ex } } : {}) },
      select: { id: true, projectId: true, summary: true, text: true, askedAt: true, clientId: true, holdsDelivery: true },
      take: 120,
    }).catch(warn("photo asks")),
    prepRows(days, ex).catch(warn("shoot prep")),
    jobsBoard(now, { includeTest: !!opts.includeTest }).catch(warn("shoots board")) as Promise<JobsBoard | null>,
    syncHealth(now).catch(warn("sync health")),
    prisma.appSetting.findUnique({ where: { key: closeoutSettingKey(dayKey) } }).catch(warn("daily checks")),
    prisma.appSetting.findMany({ where: { key: { startsWith: WAITING_PREFIX } }, take: 300 }).catch(warn("waiting notes")),
    prisma.teamMember.findFirst({ where: { creativeManager: true }, select: { id: true, name: true } }).catch(() => null),
    prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE" }, select: { name: true } }).catch(() => null),
    prisma.smartTask.findMany({
      where: {
        taskType: "lead", status: { notIn: ["COMPLETED", "CANCELLED"] },
        OR: [{ assignedKey: null }, ...kyleTask],
        ...clientScope,
      },
      select: { id: true, title: true, createdAt: true, dueAt: true, summary: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    }).catch(warn("leads")),
    // Content Program messages that are Kyle's (the program's Messages owner, else Kyle).
    prisma.smartTask.findMany({
      where: { taskType: "program_message", status: { notIn: ["COMPLETED", "CANCELLED"] }, OR: kyleTask.length ? kyleTask : [{ assignedKey: "kyle" }], ...clientScope },
      select: { id: true, title: true, description: true, dedupeKey: true, createdAt: true, updatedAt: true, dueAt: true, clientId: true, client: { select: { name: true } } },
      take: 30,
    }).catch(warn("program messages")),
    schedulingBoard(now, { countsOnly: true }).catch(warn("booking requests")),
    specialRequestsBoard(now, { countsOnly: true }).catch(warn("special requests")),
  ]);
  const assigned: DelegatedTask[] | null = await tasksAssignedTo(opts.person.key ?? "kyle").catch(warn("assigned tasks"));
  const creativeName = first(creative?.name) || "James";
  const ownerName = first(owner?.name) || "Jordan";
  const excludedProjects = new Set(
    ex.length ? (await prisma.project.findMany({ where: { clientId: { in: ex } }, select: { id: true } }).catch(() => [])).map((p) => p.id) : [],
  );
  const waitingNotes = new Map<string, WaitingRecord>();
  for (const r of waitingRecs ?? []) {
    try { waitingNotes.set(r.key.slice(WAITING_PREFIX.length), JSON.parse(r.value) as WaitingRecord); } catch { /* unreadable: ignored */ }
  }
  const items: DeskItem[] = [];
  const push = (i: DeskItem) => items.push(i);
  const quiet: Record<DeskSectionKey, { text: string; href: string | null }[]> = { deliver: [], comms: [], shoots: [], followups: [] };
  const taskAction = (id: string): DeskAction => ({ kind: "task", taskId: id, allowNewDate: true, canWait: true });
  const prepProjectIds = new Set((visits ?? []).map((v) => v.project.id));

  // =====================================================================
  // REVIEW & DELIVER: photos, floor plans and 3D tours (one row per job),
  // then approved videos (one row per job). Only what needs Kyle is a row;
  // the rest is a quiet line ("3 photo sets in editing or checks").
  // =====================================================================
  type Group = { id: string; group: "media" | "video"; projectId: string; street: string; client: string | null; assets: AssetLine[]; aryeoUrl: string | null; photoJobId: string | null; thumb: ThumbRef | null };
  const groups = new Map<string, Group>();
  const groupOf = (projectId: string, kind: "media" | "video", street: string, client: string | null): Group => {
    const id = `${kind}:${projectId}`;
    let g = groups.get(id);
    if (!g) { g = { id, group: kind, projectId, street: clean(street), client: client ? clean(client) : null, assets: [], aryeoUrl: null, photoJobId: null, thumb: null }; groups.set(id, g); }
    return g;
  };
  const photoCards: { col: QueueColumnKey; c: QueueCard }[] = [];
  for (const col of queue?.columns ?? []) for (const c of col.cards) {
    if (c.clientId && ex.includes(c.clientId)) continue;
    photoCards.push({ col: col.key, c });
  }
  const findingsFor = new Map<string, string[]>();
  const reviewJobs = photoCards.filter((x) => x.col === "decision" || x.col === "ready").map((x) => x.c.id);
  const mismatchJobs = photoCards.filter((x) => x.c.stage === "DELIVERY_MISMATCH" || x.col === "delivered").map((x) => x.c.id);
  const [findingRows, checkRows] = await Promise.all([
    reviewJobs.length
      ? prisma.photoQcFinding.findMany({ where: { jobId: { in: reviewJobs.slice(0, 60) }, status: "OPEN" }, select: { jobId: true, specificIssue: true, severity: true }, orderBy: { severity: "asc" }, take: 400 }).catch(() => [])
      : Promise.resolve([]),
    // The delivery check's own words (a known problem is said, never "check delivery"),
    // and the floor plan the photo check saw missing from the listing (floorPlanMissing).
    mismatchJobs.length
      ? prisma.photoJob.findMany({ where: { id: { in: mismatchJobs.slice(0, 120) } }, select: { id: true, deliveryCheckNote: true, deliveryDiffJson: true } }).catch(() => [])
      : Promise.resolve([]),
  ]);
  for (const r of findingRows) {
    const list = findingsFor.get(r.jobId) ?? [];
    if (list.length < 4) list.push(`${r.severity.toLowerCase()}: ${clean(r.specificIssue)}`);
    findingsFor.set(r.jobId, list);
  }
  const checkNote = new Map(checkRows.map((r) => [r.id, r.deliveryCheckNote]));
  const floorMissing = new Map(checkRows.map((r) => {
    try { return [r.id, !!(JSON.parse(r.deliveryDiffJson ?? "{}") as { floorPlanMissing?: boolean }).floorPlanMissing] as const; } catch { return [r.id, false] as const; }
  }));
  // A client's request that holds delivery, by job (Approve is refused until it is checked).
  const holdingAsks = new Map<string, { id: string; summary: string }[]>();
  for (const a of photoAsks ?? []) {
    if (!a.holdsDelivery || !a.projectId) continue;
    holdingAsks.set(a.projectId, [...(holdingAsks.get(a.projectId) ?? []), { id: a.id, summary: clean(short(a.summary?.trim() || a.text, 80)) }]);
  }
  const photoLate: { c: QueueCard; failed: boolean }[] = [];
  let photosInProgress = 0;
  for (const { col, c } of photoCards) {
    const due = c.slaDueAt ? Date.parse(c.slaDueAt) : null;
    const late = due != null && due < nowMs && col !== "delivered";
    const issues = c.issues.CRITICAL + c.issues.MAJOR + c.issues.MINOR;
    const found = issues ? `The free check found ${plural(c.issues.CRITICAL, "critical")} · ${c.issues.MAJOR} major · ${c.issues.MINOR} minor` : "The free check found nothing to decide";
    const open = (label: string): DeskAction => ({ kind: "link", label, href: `/ops/photo-delivery/${c.id}` });
    const a: AssetLine = { id: `photo:${c.id}`, kind: "photos", label: "Photos", status: "", tone: "waiting", late, dueISO: c.slaDueAt, who: null, note: null, action: null };
    const held = holdingAsks.get(c.projectId) ?? [];
    switch (col) {
      case "editing":
        // A failed or late edit is a production follow-up (Requests & Follow-Ups), not a delivery.
        if (c.stage === "EDIT_FAILED" || late) photoLate.push({ c, failed: c.stage === "EDIT_FAILED" });
        else photosInProgress++;
        // Oct 23 2026 (photo huddle item 12): before the raws arrive it is the photographer's upload, never "Being edited".
        Object.assign(a, c.waitingForUpload ? { tone: "waiting", status: "Waiting for upload", who: "the photographer" } : { tone: "waiting", status: c.stage === "EDIT_FAILED" ? "Editing failed in AutoHDR" : "Being edited", who: "AutoHDR" });
        break;
      case "qc":
        if (late) photoLate.push({ c, failed: false }); else photosInProgress++;
        Object.assign(a, { tone: "waiting", status: c.fix?.status === "DONE" ? "Fixes done, the free check is re-running" : "Edited photos received, free check running", who: "the hub" });
        break;
      case "fixing":
        if (late) photoLate.push({ c, failed: false }); else photosInProgress++;
        Object.assign(a, { tone: "waiting", status: "Corrections running in AutoHDR", who: "AutoHDR" });
        break;
      case "decision":
        Object.assign(a, { tone: "now", status: c.stage === "REVISION_REQUESTED" ? "Client asked for changes: decide the fix" : "Free check found issues to decide", note: found, action: open("Decide") });
        break;
      case "hold":
        Object.assign(a, { tone: "now", status: held.length ? `Held by the client's request: "${held[0].summary}"` : `On hold: ${(c.holdReason && HOLD_REASON_LABEL[c.holdReason]) || "held"}`, action: held.length ? { kind: "ask", askId: held[0].id, askKind: "SPECIAL_REQUEST" } : open("Open photos") });
        break;
      case "ready":
        Object.assign(a, {
          tone: "now",
          // "Fixes done" (Jordan's huddle with Kyle, Oct 23 2026): the corrections are back and checked.
          status: held.length ? `Ready, held by the client's request: "${held[0].summary}"` : c.fix?.status === "DONE" ? "Fixes done · ready to review" : "Photos ready",
          note: issues ? found : "The free check passed",
          action: { kind: "photo-approve", jobId: c.id, street: clean(c.street) },
        });
        break;
      case "delivering":
        if (c.stage === "DELIVERY_MISMATCH") Object.assign(a, { tone: "failed", status: `Delivery not confirmed: ${clean(checkNote.get(c.id) ?? "Aryeo shows a different set")}`, late: false, action: open("Fix delivery") });
        else { photosInProgress++; Object.assign(a, { tone: "waiting", status: "Approved, not delivered yet: waiting on Aryeo to confirm", who: "Aryeo", late: false }); }
        break;
      case "delivered":
        Object.assign(a, { tone: "done", status: `Delivered ${c.deliveredAt ? etDateTime(c.deliveredAt) : ""}`.trim(), late: false });
        break;
    }
    const g = groupOf(c.projectId, "media", c.street, c.clientName);
    g.photoJobId = c.id;
    g.thumb = c.hero ?? null;
    g.assets.push(a);
    // A photo held by a client request: its check is right beside the approval.
    if (col === "ready" && held.length) g.assets.push({ id: `hold:${held[0].id}`, kind: "notice", label: "Client request", status: `Check "${held[0].summary}" before delivering`, tone: "now", late: false, dueISO: null, who: null, note: null, action: { kind: "ask", askId: held[0].id, askKind: "SPECIAL_REQUEST" } });
  }
  // Floor plans and 3D tours: their own status and action, never holding the photos.
  const mediaProjects = [...groups.values()].filter((g) => g.group === "media").map((g) => g.projectId);
  let plansOnTheirWay = 0;
  if (mediaProjects.length) {
    const projs = await prisma.project.findMany({
      where: { id: { in: mediaProjects } },
      select: { id: true, statusEvidence: true, promisedDueAt: true, deliveryDue: true, deliverables: { where: { ...OWED_DELIVERABLE_WHERE, type: { in: ["FLOORPLAN", "MATTERPORT_3D", "ZILLOW_3D"] } }, select: { type: true, status: true } } },
    }).catch(() => []);
    for (const p of projs) {
      const g = groups.get(`media:${p.id}`)!;
      const ev = parseEvidence(p.statusEvidence)?.aryeo ?? null;
      const photosOut = g.assets.some((a) => a.kind === "photos" && a.tone === "done");
      for (const d of p.deliverables) {
        const plan = d.type === "FLOORPLAN";
        const maker = plan ? "CubiCasa" : d.type === "ZILLOW_3D" ? "Zillow" : "Matterport";
        // The photo check's own read of the listing outranks a stale order line (floorPlanMissing).
        // Oct 23 2026: but that read is taken once, at delivery (30 Caedman Dr's plan comes from
        // CubiCasa later), so a plan the hourly status read now sees on the listing is on it.
        const missingNow = plan && g.photoJobId ? floorMissing.get(g.photoJobId) === true && !((ev?.floorPlans ?? 0) > 0) : false;
        const onListing = !missingNow && (plan ? (ev?.floorPlans ?? 0) > 0 : (ev?.interactive ?? 0) > 0);
        const promise = (p.promisedDueAt ?? p.deliveryDue)?.toISOString() ?? g.assets.find((x) => x.kind === "photos")?.dueISO ?? null;
        const lateNow = !!promise && Date.parse(promise) < nowMs;
        const base: AssetLine = { id: `${plan ? "floorplan" : "tour"}:${p.id}`, kind: plan ? "floorplan" : "tour", label: plan ? "Floor plan" : "3D tour", status: "", tone: "waiting", late: false, dueISO: promise, who: maker, note: null, action: null };
        const check: DeskAction = { kind: "link", label: plan ? "Check floor plan" : "Check tour", href: `/projects/${p.id}` };
        if ((d.status === "DONE" && !missingNow) || onListing) Object.assign(base, { tone: "done", status: onListing ? "On the Aryeo listing" : "Done", who: null });
        else if (d.status === "FLAGGED") Object.assign(base, { tone: "now", status: `${base.label} flagged: check it before it goes out`, who: null, action: check });
        else if (d.status === "UPLOADED" || d.status === "IN_PROGRESS") Object.assign(base, { tone: "now", status: plan ? "Floor plan ready to check" : "3D tour ready to verify", who: null, action: check });
        else if (lateNow && photosOut) Object.assign(base, { tone: "now", late: true, status: `${base.label} missing: not on the Aryeo listing yet (${maker})`, action: { kind: "link", label: `Chase ${maker}`, href: `/projects/${p.id}` } });
        else { plansOnTheirWay++; Object.assign(base, { status: missingNow ? "Not on the Aryeo listing yet" : "On its way", late: lateNow }); }
        g.assets.push(base);
      }
    }
  }
  // Approved videos only (the edits and the reviews are James's and the editors'; Follow-Ups chases them).
  let finishing = 0;
  let uploading = 0;
  const videoRows = [...(board?.lanes.sending ?? []), ...(board?.lanes.held ?? []), ...(board?.lanes.finishing ?? [])].filter((r) => !excludedProjects.has(r.projectId));
  for (const r of videoRows) {
    if (r.lane === "finishing") { finishing++; continue; }
    const s = r.send;
    const p = r.push;
    const approvedBy = s?.approvedBy ? first(clean(s.approvedBy)) : null;
    const approved = approvedBy ? `Approved by ${approvedBy}` : "Approved";
    const asks = (s?.openAsks ?? []).map((x) => ({ summary: clean(x.summary), askedBy: x.askedBy ?? null }));
    const a: AssetLine = { id: `video:${r.key}`, kind: "video", label: clean(r.label), status: "", tone: "now", late: r.late, dueISO: r.promiseISO, who: null, note: approvedBy ? `${approved} (creative review). You send it.` : null, action: null };
    const running = !!p?.state && !(p.tone === "failed" || p.tone === "held") && p.tone !== "done" && !p.waitingForKyle;
    if (running) { uploading++; continue; }
    if (r.lane === "held") {
      const canSend = !!(p?.canStart && s && !s.byHandWhy);
      Object.assign(a, {
        status: `${approved}, held: ${clean(r.heldWhy ?? r.stage)}`,
        action: canSend && r.submissionId
          ? { kind: "video-send", submissionId: r.submissionId, street: clean(r.street), label: "Try again", openAsks: asks, asksUnknown: !!s?.asksUnknown, listingWarning: null, uploadOnly: false }
          : p && r.submissionId && (p.canDeliverNow || p.canRelease)
            ? { kind: "video-push", submissionId: r.submissionId, canDeliverNow: p.canDeliverNow, canRelease: p.canRelease, uploadedOnly: !!p.uploadedOnly }
            : { kind: "link", label: "Open in Videos", href: r.reviewHref ?? "/review" },
      });
    } else if (p?.uploadedOnly && p.canDeliverNow && r.submissionId) {
      Object.assign(a, { status: `On Aryeo, not sent yet (${approved.toLowerCase()})`, action: { kind: "video-push", submissionId: r.submissionId, canDeliverNow: true, canRelease: p.canRelease, uploadedOnly: true } });
    } else if (p?.waitingForKyle && r.submissionId && (p.canDeliverNow || p.canRelease)) {
      Object.assign(a, { status: `On the Aryeo listing, waiting for your Deliver now: ${clean(p.says)}`, action: { kind: "video-push", submissionId: r.submissionId, canDeliverNow: p.canDeliverNow, canRelease: p.canRelease, uploadedOnly: false } });
    } else if (p?.tone === "failed") {
      Object.assign(a, {
        tone: "failed", status: `Upload to Aryeo stopped: ${clean(p.says)}`,
        action: p.canStart && s && r.submissionId ? { kind: "video-send", submissionId: r.submissionId, street: clean(r.street), label: "Try again", openAsks: asks, asksUnknown: s.asksUnknown, listingWarning: null, uploadOnly: false } : { kind: "link", label: "Open in Videos", href: r.reviewHref ?? "/review" },
      });
    } else {
      const canPress = !!s && !s.byHandWhy && (p ? p.canStart : false);
      Object.assign(a, {
        status: s?.byHandWhy ? `${approved}: ${clean(s.byHandWhy)}` : `${approved}, ready to send${asks.length ? ` · check ${plural(asks.length, "client request")} first` : ""}`,
        action: canPress && s && r.submissionId
          ? { kind: "video-send", submissionId: r.submissionId, street: clean(r.street), label: p?.canRetry ? "Try again" : s.uploaded ? "Send" : "Upload to Aryeo and send", openAsks: asks, asksUnknown: s.asksUnknown, listingWarning: s.listingWarning, uploadOnly: !p?.canRetry && !s.uploaded }
          : { kind: "link", label: "Open in Videos", href: r.reviewHref ?? "/review" },
      });
    }
    // Run Topaz again (Jordan, Oct 23 2026) beside the video's send, wherever
    // the board offers it: a finished or held Topaz file not sent yet.
    if (r.rerun) a.more = [{ kind: "topaz-rerun", jobId: r.rerun.jobId, street: clean(r.street), video: clean(r.label), credits: r.rerun.credits, limit: r.rerun.limit }];
    const g = groupOf(r.projectId, "video", r.street, r.clientName);
    g.aryeoUrl = g.aryeoUrl ?? r.aryeoUrl;
    g.assets.push(a);
  }
  // Published but the client was never told: NOT delivered (delivered = accessible AND notified).
  for (const n of notTold ?? []) {
    if (excludedProjects.has(n.projectId)) continue;
    groupOf(n.projectId, "video", n.street, null).assets.push({
      id: `notice:${n.submissionId}`, kind: "notice", label: "Client notice", tone: "now", late: false, dueISO: null, who: null,
      status: `Sent ${etDateTime(n.sentAtISO)}, the client was not told yet`, note: n.sentBy ? `Sent by ${clean(n.sentBy)}` : null,
      action: { kind: "video-notice", row: { ...n, street: clean(n.street) } },
    });
  }
  for (const i of incidents ?? []) {
    if (!i.projectId || excludedProjects.has(i.projectId)) continue;
    const failed = i.state === "failed" || i.state === "unknown";
    if (!failed) continue; // still sending: nothing for Kyle yet
    const g = groups.get(`video:${i.projectId}`) ?? groupOf(i.projectId, "media", i.street, null);
    g.assets.push({
      id: `text:${i.outboxId}`, kind: "notice", label: "Delivery text", tone: "failed", late: false, dueISO: null, who: null,
      status: i.state === "failed" ? "The client's delivery text failed" : "Not known whether the client's delivery text went out",
      note: null, action: { kind: "link", label: i.state === "failed" ? "Resend the text" : "Check the text", href: `/projects/${i.projectId}` },
    });
  }
  const order = { failed: 0, now: 1, waiting: 2, done: 3 } as const;
  const lateJobs = new Set(photoLate.map((x) => x.c.projectId));
  for (const g of groups.values()) {
    const needs = g.assets.filter((a) => a.tone === "now" || a.tone === "failed");
    if (!needs.length) {
      // AWAITING FILES: every open asset is someone else's to produce (AutoHDR,
      // CubiCasa, the photographer, Aryeo's confirmation). Folded under the
      // section, each named with who and when; a late edit is a follow-up instead.
      const waits = g.assets.filter((a) => a.tone === "waiting");
      if (!waits.length || lateJobs.has(g.projectId)) continue;
      const dueW = waits.map((a) => a.dueISO).filter((x): x is string => !!x).sort()[0] ?? null;
      push({
        id: g.id, section: "deliver", group: g.group, state: "waiting",
        title: g.street, line: waits.map((a) => `${a.label}: ${a.status.charAt(0).toLowerCase()}${a.status.slice(1)}`).join(" · "),
        reason: g.assets.map((a) => `${a.label}: ${a.status}`).join(" · "), client: g.client, who: waits.map((a) => a.who).find((w) => !!w) ?? null,
        dueISO: dueW, dueWords: dueW ? dueWordsFor(dueW, now) : null, late: false, rank: RANK.routine,
        primary: null, actions: [], href: g.photoJobId ? `/ops/photo-delivery/${g.photoJobId}` : `/projects/${g.projectId}`,
        panel: { kind: "job", projectId: g.projectId, street: g.street, client: g.client, assets: g.assets, findings: [], aryeoUrl: g.aryeoUrl },
        sinceISO: null, thumb: g.thumb,
      });
      continue;
    }
    g.assets.sort((a, b) => order[a.tone] - order[b.tone] || Number(b.late) - Number(a.late));
    const lead = needs.sort((a, b) => order[a.tone] - order[b.tone])[0];
    const late = needs.some((a) => a.late);
    const dueISO = needs.map((a) => a.dueISO).filter((x): x is string => !!x).sort()[0] ?? null;
    const failed = needs.some((a) => a.tone === "failed");
    const dueToday = !!dueISO && Date.parse(dueISO) < endToday.getTime();
    const photosReady = needs.some((a) => a.kind === "photos" && a.action?.kind === "photo-approve");
    const planReady = needs.some((a) => a.kind === "floorplan" && a.status.includes("ready"));
    const line = photosReady && planReady ? "Photos + floor plan ready"
      : needs.length === 1 ? lead.status
      : `${lead.status} · ${needs.filter((a) => a !== lead).map((a) => a.label.toLowerCase()).join(", ")} too`;
    // Each asset's action, then its second control (Run Topaz again after a video's send).
    const actions = [...needs.flatMap((a) => [a.action, ...(a.more ?? [])]).filter((x): x is DeskAction => !!x)];
    push({
      id: g.id, section: "deliver", group: g.group, state: "now",
      title: g.street, line, reason: g.assets.map((a) => `${a.label}: ${a.status}`).join(" · "), client: g.client, who: "You",
      dueISO, dueWords: dueWordsFor(dueISO, now), late,
      rank: failed ? RANK.blocker : late ? RANK.overdue : dueToday ? RANK.today : RANK.routine,
      primary: lead.action ? { label: actionLabel(lead.action), action: lead.action } : null,
      actions, href: g.photoJobId ? `/ops/photo-delivery/${g.photoJobId}` : g.group === "video" ? `/review/${g.projectId}` : `/projects/${g.projectId}`,
      panel: { kind: "job", projectId: g.projectId, street: g.street, client: g.client, assets: g.assets, findings: g.photoJobId ? findingsFor.get(g.photoJobId) ?? [] : [], aryeoUrl: g.aryeoUrl },
      sinceISO: null, thumb: g.thumb,
    });
  }
  void photosInProgress; void plansOnTheirWay; // they are the "awaiting files" rows now
  if (uploading) quiet.deliver.push({ text: `${plural(uploading, "video")} uploading to Aryeo`, href: "/review" });
  if (finishing) quiet.deliver.push({ text: `${plural(finishing, "video")} finishing the Topaz pass`, href: "/review" });

  // =====================================================================
  // CLIENT COMMUNICATIONS: genuinely waiting on us (the comms scan already
  // counts a draft or an automatic acknowledgement as NOT answered), the
  // Content Program messages that are Kyle's, booking requests, new leads.
  // =====================================================================
  const openRevisionClients = new Set((revisions ?? []).map((r) => r.clientId).filter((x): x is string => !!x));
  const replyGroups = [...(comms?.phone ?? []).map((g) => ["phone", g] as const), ...(comms?.email ?? []).map((g) => ["email", g] as const)];
  const clientIds = [...new Set(replyGroups.map(([, g]) => g.clientId).filter(Boolean))];
  const phones = new Map(
    clientIds.length ? (await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, phone: true } }).catch(() => [])).map((c) => [c.id, c.phone] as const) : [],
  );
  const replyClients = new Set<string>();
  for (const [family, g] of replyGroups) {
    if (g.clientId) replyClients.add(g.clientId);
    const latest = g.items[g.items.length - 1];
    const behind = g.holding ? g.holding.overdue : g.oldestHours >= MESSAGE_BEHIND_HOURS;
    const firstAt = g.items[0]?.atISO ?? new Date(nowMs - g.oldestHours * HOUR).toISOString();
    const dueISO = g.holding?.dueISO ?? new Date(Date.parse(firstAt) + MESSAGE_BEHIND_HOURS * HOUR).toISOString();
    const href = waitingClientReplyHref({ family, group: g, behind });
    const phone = family === "phone" ? (g.clientId ? phones.get(g.clientId) ?? null : null) ?? (/^\+?\d{10,11}$/.test(g.groupKey) ? g.groupKey : null) : null;
    const said = latest ? clean(latest.subject ? `${latest.subject}: ${latest.snippet}` : latest.snippet) : "";
    const reply: DeskAction = { kind: "reply", threadKey: g.key, family, clientId: g.clientId || null, groupKey: g.groupKey, phone, href, taskId: g.openTaskId ?? null };
    // A row that is here only for an open booking ask says so (one row: the ask is not listed again).
    const booking = g.fromAsk ? g.schedulingAsks[0] ?? null : null;
    push({
      id: `reply:${family}:${g.groupKey}`, section: "comms", tag: booking ? "booking" : "reply", state: "now",
      title: clean(g.clientName), line: booking ? `Booking request: ${short(clean(booking), 70)}` : said ? short(said, 80) : "Waiting on a reply", client: clean(g.clientName),
      reason: g.holding ? `You promised an answer ${g.holding.overdue ? "and it is overdue" : `by ${etTime(g.holding.dueISO)}`}` : `Waiting ${businessElapsedWords(firstAt, now)}`,
      who: "You", dueISO, dueWords: dueWordsFor(dueISO, now), late: behind,
      rank: behind ? RANK.blocker : RANK.today,
      primary: { label: "Reply", action: reply },
      actions: [reply, { kind: "follow-up", clientId: g.clientId || null, projectId: null, title: `Follow up with ${clean(g.clientName)}` }],
      href,
      panel: {
        kind: "thread", client: clean(g.clientName), family,
        messages: g.items.map((m) => ({ atISO: m.atISO, text: clean(m.subject ? `${m.subject}: ${m.snippet}` : m.snippet) })),
        holding: g.holding ? clean(g.holding.text) : null,
        revisionNote: g.clientId && openRevisionClients.has(g.clientId) ? "This client also has an open change request. Replying does not close it: it stays in Requests & Follow-Ups until the change is checked." : null,
        alsoAsked: (g.schedulingAsks ?? []).map((x) => clean(x)),
      },
      sinceISO: g.items[0]?.atISO ?? null,
      initials: initialsOf(g.clientName), channel: family === "email" ? "Email" : "Text", elapsed: businessElapsedWords(firstAt, now),
    });
  }
  const programIds = (programTasks ?? []).map((t) => ((t.dedupeKey ?? "").startsWith("program-message:") ? t.dedupeKey!.slice("program-message:".length) : null)).filter((x): x is string => !!x);
  const programRows = programIds.length
    ? await prisma.programMessage.findMany({ where: { enrollmentId: { in: programIds } }, select: { enrollmentId: true, authorKind: true, authorLabel: true, body: true, createdAt: true, handledAt: true, refKind: true }, orderBy: { createdAt: "asc" }, take: 400 }).catch(() => [])
    : [];
  for (const t of programTasks ?? []) {
    const enrollment = (t.dedupeKey ?? "").startsWith("program-message:") ? t.dedupeKey!.slice("program-message:".length) : null;
    const name = clean(t.client?.name ?? t.title.replace(/^Reply to (.*?)'s message$/, "$1"));
    const said = (t.description ?? "").split("\n").find((l) => l.startsWith("•"))?.replace(/^•\s*/, "") ?? "";
    const href = enrollment ? `/content/${enrollment}?tab=messages` : "/content";
    const dueISO = t.dueAt?.toISOString() ?? null;
    const late = !!t.dueAt && t.dueAt.getTime() < nowMs;
    push({
      id: `program:${t.id}`, section: "comms", tag: "program", state: "now",
      title: name, line: said ? short(clean(said), 80) : "Content Program message", client: name,
      reason: "A Content Program message waiting on the office. It closes itself when you reply there, or mark the thread No reply needed.",
      who: "You", dueISO, dueWords: dueWordsFor(dueISO, now), late, rank: late ? RANK.overdue : RANK.today,
      primary: { label: "Reply", action: enrollment ? { kind: "program-reply", enrollmentId: enrollment, href } : { kind: "link", label: "Reply on Content Program", href } },
      actions: [
        ...(enrollment ? [{ kind: "program-reply", enrollmentId: enrollment, href } as DeskAction] : [{ kind: "link", label: "Reply on Content Program", href } as DeskAction]),
        { kind: "follow-up", clientId: t.clientId ?? null, projectId: null, title: `Follow up with ${name}` },
      ],
      href,
      panel: {
        kind: "thread", client: name, family: "email",
        messages: programRows.filter((m) => m.enrollmentId === enrollment && !m.refKind).slice(-6).map((m) => ({ atISO: m.createdAt.toISOString(), text: clean(`${m.authorKind === "STAFF" ? "Us" : m.authorLabel}: ${short(m.body, 400)}`) })),
        holding: null, revisionNote: null, alsoAsked: [],
      },
      sinceISO: t.updatedAt.toISOString(), initials: initialsOf(name), channel: "Content Program", elapsed: businessElapsedWords(t.updatedAt.toISOString(), now),
    });
  }
  for (const a of sched?.asks ?? []) {
    // A booking ask from a client already waiting on a reply is part of that reply (said in its panel).
    if (replyClients.has(a.clientId)) continue;
    const name = clean(a.clientName ?? "A client");
    const href = a.projectId ? `/projects/${a.projectId}` : `/clients/${a.clientId}`;
    push({
      id: `booking:${a.id}`, section: "comms", tag: "booking", state: "now",
      title: name, line: `Booking request: ${short(clean(a.summary), 70)}`, client: name,
      reason: `${clean(a.summary)} (${a.sourceWords}, ${a.whenWords})`,
      who: "You", dueISO: a.dueAtISO, dueWords: a.dueAtISO ? dueWordsFor(a.dueAtISO, now) : null, late: a.behind, rank: a.behind ? RANK.overdue : RANK.today,
      primary: { label: "Answer", action: { kind: "link", label: "Open the client", href } },
      actions: [{ kind: "ask", askId: a.id, askKind: "SCHEDULING" }, { kind: "link", label: "Open the client", href }],
      href, panel: { kind: "task", lines: [{ label: "They asked", value: clean(a.text) }, { label: "Asked", value: `${a.whenWords} (${a.sourceWords})` }] },
      sinceISO: a.askedAtISO, initials: initialsOf(name), channel: a.sourceWords, elapsed: businessElapsedWords(a.askedAtISO, now),
    });
  }
  const onBoard = new Set(replyGroups.map(([, g]) => g.openTaskId).filter((x): x is string => !!x));
  let backlog = 0;
  for (const l of leads ?? []) {
    if (onBoard.has(l.id)) continue;
    const dueISO = (l.dueAt ?? new Date(l.createdAt.getTime() + MESSAGE_BEHIND_HOURS * HOUR)).toISOString();
    // A lead a week or more past its date is backlog (one link), not the day's work.
    if (nowMs - Date.parse(dueISO) >= WEEK_OLD_DAYS * DAY) { backlog++; continue; }
    const behind = Date.parse(dueISO) < nowMs;
    const name = clean(l.title.replace(/^New (lead|texter|caller)\s*[:—-]\s*/i, ""));
    push({
      id: `lead:${l.id}`, section: "comms", tag: "lead", state: "now",
      title: clean(l.title), line: "New lead", client: null,
      reason: `New lead, waiting since ${etDateTime(l.createdAt)}${l.summary ? `: ${clean(short(l.summary, 200))}` : ""}`, who: "You",
      dueISO, dueWords: dueWordsFor(dueISO, now), late: behind, rank: behind ? RANK.overdue : RANK.today,
      primary: { label: "Handle lead", action: { kind: "task", taskId: l.id, allowNewDate: true, canWait: false } },
      actions: [{ kind: "task", taskId: l.id, allowNewDate: true, canWait: false }],
      href: "/communications",
      panel: { kind: "task", lines: [{ label: "Lead", value: clean(l.title) }, ...(l.summary ? [{ label: "Notes", value: clean(short(l.summary, 300)) }] : [])] },
      sinceISO: l.createdAt.toISOString(), initials: /^[A-Z]/.test(name) ? initialsOf(name) : "NL", channel: "Lead", elapsed: businessElapsedWords(l.createdAt.toISOString(), now),
    });
  }

  // =====================================================================
  // TODAY'S SHOOTS: today and the next business day, one row per VISIT.
  // =====================================================================
  const prep = visits ?? [];
  const briefs = await briefStatusForAppointments(prep.map((v) => v.apptId).filter((x): x is string => !!x)).catch(() => null);
  const photoDelivered = new Map<string, Date>();
  const askProjects = [...new Set([...prep.map((v) => v.project.id), ...(photoAsks ?? []).map((a) => a.projectId!).filter(Boolean)])];
  if (askProjects.length) {
    for (const j of await prisma.photoJob.findMany({ where: { projectId: { in: askProjects }, deliveredAt: { not: null } }, select: { projectId: true, deliveredAt: true } }).catch(() => [])) {
      photoDelivered.set(j.projectId, j.deliveredAt!);
    }
  }
  const prepAsks = prep.length
    ? await prisma.clientAsk.findMany({ where: { projectId: { in: prep.map((v) => v.project.id) }, kind: "SPECIAL_REQUEST", state: { in: ["OPEN", "CONFIRMED"] } }, select: { id: true, state: true, projectId: true, summary: true, text: true, askedAt: true } }).catch(() => [])
    : [];
  const prepAskIds = new Set<string>();
  const briefsPending: BriefPending[] = [];
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
    type Note = { text: string; at: Date; askId: string | null };
    const notes: Note[] = [
      ...prepAsks.filter((a) => a.projectId === p.id).map((a) => ({ text: clean(a.summary?.trim() || a.text), at: a.askedAt, askId: a.state === "OPEN" ? a.id : null })),
      ...p.activities
        .filter((act) => !prepAsks.some((a) => a.projectId === p.id && Math.abs(a.askedAt.getTime() - act.createdAt.getTime()) < 5 * 60_000))
        .map((act) => ({ text: clean(act.body.replace(/^Client request \([^)]*\):\s*/i, "")), at: act.createdAt, askId: null })),
    ];
    const revisionsAfter = notes.filter((n) => !!delivered && n.at > delivered).map((n) => short(n.text, 120));
    const forThis = notes.filter((n) => !(delivered && n.at > delivered) && (!prevStart || n.at > prevStart));
    const forEarlier = notes.filter((n) => !(delivered && n.at > delivered) && !!prevStart && n.at <= prevStart);
    for (const n of forThis) if (n.askId) prepAskIds.add(n.askId);
    const acc: AccessInfo = parseAccessBrief(v.description);
    const orderNotes = [acc.special, acc.orderNotes, acc.notes && !/^n\/?a$/i.test(acc.notes) ? acc.notes : null].filter((x): x is string => !!x && !!x.trim()).map((x) => clean(x));
    const multi = live.length > 1;
    const own = apptItems(v.rawJson);
    const services = own.length ? own : multi ? [] : [...new Set(p.deliverables.map((d) => d.label ?? d.type))];
    const servicesFrom: PrepVisit["servicesFrom"] = own.length ? "visit" : services.length ? "order" : "none";
    const started = !!start && start.getTime() <= nowMs;
    const over = !!start && (v.endAt ?? new Date(start.getTime() + 2 * HOUR)) < now;
    // The client's confirmation, sent 48 hours out by the hub (its task's date).
    const conf = p.smartTasks.find((t) => !start || !t.dueAt || (t.dueAt.getTime() <= start.getTime() && t.dueAt.getTime() >= start.getTime() - 3 * DAY)) ?? null;
    const within48 = !!start && start.getTime() - nowMs <= 48 * HOUR;
    const confirmation: PrepVisit["confirmation"] = started ? { state: "na", words: over ? "Shot" : "On site now", taskId: null }
      : !conf ? (within48 ? { state: "none", words: "No confirmation on file", taskId: null } : { state: "scheduled", words: "Confirmation goes out 48 hours before", taskId: null })
      : conf.status === "COMPLETED" ? { state: "sent", words: "Confirmed", taskId: conf.id }
      : conf.status === "CANCELLED" ? { state: "other", words: "Confirmed another way", taskId: conf.id }
      : conf.dueAt && conf.dueAt.getTime() > nowMs ? { state: "scheduled", words: `Confirmation goes out ${etDate(conf.dueAt)} ${etTime(conf.dueAt)}`, taskId: conf.id }
      : { state: "open", words: "Not confirmed yet", taskId: conf.id };
    const photographerId = v.assignedToId ?? p.photographerId ?? null;
    const photographer = v.assignedTo ?? p.photographer?.name ?? null;
    const b = v.apptId && briefs ? briefs.get(v.apptId) ?? null : null;
    const bState: BriefState | "unknown" = v.apptId ? (b?.state ?? "unknown") : "off";
    const sent = !!b?.sentAt;
    const offer = briefOffer({ state: bState, sent, started, why: b?.why ?? null });
    const briefWords: Record<BriefState | "unknown", string> = {
      off: "Brief switched off",
      pending: b?.why && /^Goes out/i.test(b.why) ? `Brief ${b.why.charAt(0).toLowerCase()}${b.why.slice(1).replace(/\.$/, "")}` : "Brief not sent yet",
      sent: `Brief sent${b?.sentAt ? ` ${etTime(b.sentAt)}` : ""}, no Got it yet`,
      failed: "Brief not sent",
      acknowledged: "Brief acknowledged",
      changed: "Instructions changed, waiting for a new Got it",
      unknown: "Brief status unknown",
    };
    const gaps: string[] = [];
    if (!p.addressLine?.trim() || /^\[No address/i.test(p.addressLine)) gaps.push("No street address on the listing");
    if (!photographer) gaps.push("No photographer assigned");
    if (!acc.lockbox && !acc.access && !acc.presence) gaps.push("No access instructions (lockbox, door code or who is there)");
    if (!acc.phone) gaps.push("No on-site contact phone");
    if (servicesFrom === "none") gaps.push(multi ? "No services listed for this visit (a split order)" : "No services on the order");
    const conflicts = visitConflicts({ services, requests: forThis.map((n) => n.text), orderNotes, lockbox: acc.lockbox, liveVisits: live.length });
    const unconfirmed = confirmation.state === "open" || confirmation.state === "none";
    const problems = started ? [] : [...(unconfirmed ? [confirmation.words] : []), ...gaps, ...conflicts, ...(offer.problem ? [offer.problem] : [])];
    const street = clean(streetOf(p.title));
    const visit: PrepVisit = {
      apptId: v.apptId, projectId: p.id, street, client: p.client ? clean(p.client.name) : null, dayKey: visitDay,
      timeISO: start?.toISOString() ?? null, endISO: v.endAt?.toISOString() ?? null, over: started, photographer: photographer ? clean(photographer) : null, photographerId,
      confirmation,
      access: { lockbox: acc.lockbox ? clean(acc.lockbox) : null, access: acc.access ? clean(acc.access) : null, presence: acc.presence ? clean(acc.presence) : null, contactName: acc.name, contactPhone: acc.phone },
      services, servicesFrom,
      requests: forThis.map((n) => ({ text: short(n.text, 200), whenISO: n.at.toISOString(), askId: n.askId })),
      instructions: multi ? [] : orderNotes.map((n) => short(n, 300)),
      earlier: [
        ...(multi ? orderNotes.map((n) => ({ text: `Order note (all ${live.length} visits): ${short(n, 240)}`, whenISO: null })) : []),
        ...forEarlier.map((n) => ({ text: short(n.text, 200), whenISO: n.at.toISOString() })),
      ],
      revisionsAfterDelivery: revisionsAfter,
      conflicts, gaps,
      brief: { state: bState, words: briefWords[bState], why: b?.why ?? null, href: photographerId ? `/shoot/brief/${visitDay}?as=${photographerId}` : null, sent },
      otherVisits: live.filter((a) => a.id !== v.apptId).map((a) => ({ whenISO: a.startAt?.toISOString() ?? null, services: apptItems(a.rawJson) })),
    };
    const confirmAction: DeskAction | null = confirmation.state === "open" && confirmation.taskId ? { kind: "confirm", taskId: confirmation.taskId } : null;
    const briefSend: DeskAction | null = offer.send && photographerId ? { kind: "brief-send", teamMemberId: photographerId, day: visitDay, name: photographer ? first(clean(photographer)) : "the photographer", resend: offer.send === "resend" } : null;
    const openJob: DeskAction = { kind: "link", label: "Open the job", href: `/projects/${p.id}` };
    const firstProblem = problems[0] ?? null;
    const primary = !firstProblem ? null
      : unconfirmed && firstProblem === confirmation.words && confirmAction ? confirmAction
      : offer.problem && firstProblem === offer.problem && briefSend ? briefSend
      : openJob;
    const waitingAck = !problems.length && !started && offer.waiting;
    const ackBy = start ? new Date(start.getTime() - 2 * HOUR) : null;
    const chip: DeskItem["chip"] = started ? { label: over ? "Shot" : "On site", tone: "muted" }
      : unconfirmed ? { label: "Needs confirmation", tone: "warn" }
      : gaps.some((g) => g.startsWith("No access")) ? { label: "Needs access info", tone: "bad" }
      : gaps.length ? { label: "Missing details", tone: "warn" }
      : conflicts.length ? { label: "Check instructions", tone: "warn" }
      : offer.problem ? { label: bState === "failed" ? "Brief failed" : "No Got it yet", tone: "bad" }
      : waitingAck ? { label: "Waiting for Got it", tone: "muted" }
      : { label: "Ready", tone: "ok" };
    if (!started && (bState === "sent" || bState === "changed") && photographerId) {
      briefsPending.push({ visitId: v.apptId ? `visit:${v.apptId}` : `visit:p:${p.id}`, day: visitDay === dayKey ? "today" : "next", street, timeISO: start?.toISOString() ?? null, photographer: photographer ? clean(photographer) : "the photographer", teamMemberId: photographerId, dayKey: visitDay, phone: null, state: bState });
    }
    // Once the shoot has started the brief is moot: its state is not shown as if it still mattered.
    const statusLine = started ? confirmation.words : [confirmation.words, briefWords[bState]].join(" · ");
    push({
      id: v.apptId ? `visit:${v.apptId}` : `visit:p:${p.id}`, section: "shoots", day: visitDay === dayKey ? "today" : "next",
      state: problems.length ? "now" : waitingAck ? "waiting" : "ok",
      title: street, line: problems.length ? problems.slice(0, 2).join(" · ") : statusLine, client: p.client ? clean(p.client.name) : null,
      reason: problems.length ? problems.join(" · ") : statusLine,
      who: problems.length ? "You" : waitingAck ? (photographer ? clean(photographer) : "the photographer") : photographer ? clean(photographer) : null,
      dueISO: waitingAck && ackBy ? ackBy.toISOString() : start?.toISOString() ?? null,
      dueWords: start ? `${visitDay === dayKey ? "" : `${etDate(start)} `}${etTime(start)}` : null,
      late: false,
      rank: problems.length ? (visitDay === dayKey || (!!start && start.getTime() - nowMs < DAY) ? RANK.blocker : RANK.routine) : RANK.housekeeping,
      primary: primary ? { label: actionLabel(primary), action: primary } : null,
      actions: [...(confirmAction ? [confirmAction] : []), ...(briefSend ? [briefSend] : []), ...forThis.filter((n) => n.askId).map((n): DeskAction => ({ kind: "ask", askId: n.askId!, askKind: "SPECIAL_REQUEST" })), openJob],
      href: `/projects/${p.id}`,
      panel: { kind: "visit", visit },
      sinceISO: null, chip,
    });
  }

  // =====================================================================
  // REQUESTS & FOLLOW-UPS: client revisions (visibly distinct), special
  // requests, tasks from Jordan, production follow-ups, Kyle's own tasks due
  // today; waiting items collapsed until their follow-up time.
  // =====================================================================
  const nameOfKey = (key: string | null) => (key ? opts.roster?.find((a) => a.key === key)?.name ?? key : null);
  const waitingWords = (w: WaitingRecord) => (w.role === "creative" ? `${w.who} (creative question)` : w.role === "owner" ? `${w.who} (business or policy)` : w.who);
  const taskLines = (t: { title: string; kind?: string; projectTitle?: string | null }, w?: WaitingRecord | null) => [
    { label: "Task", value: clean(t.title) }, ...(t.kind ? [{ label: "Kind", value: t.kind }] : []), ...(t.projectTitle ? [{ label: "Job", value: clean(t.projectTitle) }] : []), ...(w ? [{ label: "Waiting on", value: waitingWords(w) }] : []),
  ];
  const kyleRaw = new Map<string, { source: string | null; reasonCreated: string | null }>();
  const dueIds = [...(tasks?.earlier ?? []), ...(tasks?.dueToday ?? [])].map((t) => t.id);
  if (dueIds.length) for (const r of await prisma.smartTask.findMany({ where: { id: { in: dueIds } }, select: { id: true, source: true, reasonCreated: true } }).catch(() => [])) kyleRaw.set(r.id, r);
  const dueTaskItem = (t: OldItem, earlier: boolean) => {
    if (NOT_A_FOLLOW_UP.has(t.taskType)) return;
    const w = waitingNotes.get(t.id);
    const jordan = fromJordan(kyleRaw.get(t.id) ?? {});
    // A week or more past its date: backlog, off the overview (never re-dated or closed here).
    if (earlier && t.daysPast >= WEEK_OLD_DAYS && !w) { backlog++; return; }
    if (w && Date.parse(w.followUpAt) > nowMs && Date.parse(t.chaseISO) > nowMs) {
      push({
        id: `task:${t.id}`, section: "followups", tag: jordan ? "jordan" : "task", state: "waiting", title: clean(t.title),
        line: `Waiting on ${w.who} · Follow up at ${etTime(w.followUpAt)}`, client: null,
        reason: `Waiting on ${waitingWords(w)}${w.note ? `: ${clean(w.note)}` : ""}`, who: w.who,
        dueISO: w.followUpAt, dueWords: `Follow up ${etTime(w.followUpAt)}`, late: false, rank: RANK.routine,
        primary: null, actions: [taskAction(t.id)], href: t.href,
        panel: { kind: "task", lines: [...taskLines(t, w), { label: "Comes back", value: etDateTime(w.followUpAt) }] },
        sinceISO: null,
      });
      return;
    }
    const back = !!w && Date.parse(w.followUpAt) <= nowMs;
    push({
      id: `task:${t.id}`, section: "followups", tag: jordan ? "jordan" : "task", state: "now",
      title: clean(t.title),
      line: back ? `Waiting on ${w!.who} · Follow up now` : [jordan ? "From Jordan" : t.kind, t.projectTitle ? streetOf(clean(t.projectTitle)) : null].filter(Boolean).join(" · "),
      client: null,
      reason: back ? `You were waiting on ${waitingWords(w!)} until ${etDateTime(w!.followUpAt)}${w!.note ? `: ${clean(w!.note)}` : ""}` : [jordan ? "From Jordan" : t.kind, earlier ? `${plural(t.daysPast, "day")} past its date` : "due today", t.pushes ? `pushed ${plural(t.pushes, "time")}` : null].filter(Boolean).join(" · "),
      who: back ? w!.who : "You", dueISO: t.chaseISO, dueWords: dueWordsFor(t.chaseISO, now), late: earlier || Date.parse(t.chaseISO) < nowMs,
      rank: back || earlier ? RANK.overdue : RANK.today,
      primary: { label: back ? "Follow up" : "Handle", action: taskAction(t.id) },
      actions: [taskAction(t.id)], href: t.href,
      panel: { kind: "task", lines: taskLines(t, w) },
      sinceISO: null,
    });
  };
  // TASKS ASSIGNED TO KYLE (delegation): Accept until he has, then Update,
  // each with who assigned it, the outcome wanted and when it is due. One row
  // per task: the same task never shows again as one of his own to-dos.
  const STATE_WORDS: Record<DelegationState, string> = {
    ASSIGNED: "Not accepted yet", ACCEPTED: "Accepted", IN_PROGRESS: "In progress", BLOCKED: "Blocked",
    READY_FOR_VERIFICATION: "Waiting on verification", COMPLETED: "Completed", CANCELLED: "Cancelled",
  };
  for (const dt of assigned ?? []) {
    if (dt.state === "COMPLETED" || dt.state === "CANCELLED") continue;
    const by = first(dt.assignedBy) || "someone";
    const jordan = /^jordan/i.test(dt.assignedBy ?? "");
    const waitingVerify = dt.state === "READY_FOR_VERIFICATION";
    const late = !!dt.dueAt && Date.parse(dt.dueAt) < nowMs;
    const action: DeskAction = { kind: "delegation", taskId: dt.taskId, state: dt.state, needsVerification: dt.needsVerification };
    push({
      id: `task:${dt.taskId}`, section: "followups", tag: jordan ? "jordan" : "assigned",
      state: waitingVerify ? "waiting" : "now",
      title: clean(dt.title),
      line: [STATE_WORDS[dt.state], dt.blocker ? `blocked: ${clean(short(dt.blocker, 50))}` : null, dt.dueAt ? `due ${etDayKey(new Date(dt.dueAt)) === dayKey ? etTime(dt.dueAt) : `${etDate(dt.dueAt)} ${etTime(dt.dueAt)}`}` : null].filter(Boolean).join(" · "),
      reason: [`Assigned by ${by}`, dt.outcome ? `Outcome wanted: ${clean(dt.outcome)}` : null, dt.latestUpdate ? `Latest: ${clean(dt.latestUpdate)}` : null, dt.nextStep ? `Next: ${clean(dt.nextStep)}` : null].filter(Boolean).join(" · "),
      client: null, who: waitingVerify ? by : "You", dueISO: dt.dueAt, dueWords: dt.dueAt ? dueWordsFor(dt.dueAt, now) : null, late,
      rank: dt.state === "ASSIGNED" || dt.state === "BLOCKED" ? RANK.today : late ? RANK.overdue : RANK.routine,
      primary: waitingVerify ? null : { label: dt.state === "ASSIGNED" ? "Accept" : "Update", action },
      actions: [action], href: dt.sourceHref ?? (dt.projectId ? `/projects/${dt.projectId}` : null),
      panel: { kind: "task", lines: [{ label: "Task", value: clean(dt.title) }, { label: "Assigned by", value: by }, ...(dt.outcome ? [{ label: "Outcome", value: clean(dt.outcome) }] : []), ...(dt.assignedAt ? [{ label: "Assigned", value: etDateTime(dt.assignedAt) }] : []), { label: "State", value: STATE_WORDS[dt.state] }, ...(dt.latestUpdate ? [{ label: "Latest update", value: clean(dt.latestUpdate) }] : [])] },
      sinceISO: dt.assignedAt,
    });
  }
  for (const t of tasks?.earlier ?? []) dueTaskItem(t, true);
  for (const t of tasks?.dueToday ?? []) dueTaskItem(t, false);
  for (const t of laterTasks ?? []) {
    const chase = [t.dueAt, t.followUpAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const w = waitingNotes.get(t.id);
    const jordan = fromJordan(t);
    const base = { section: "followups" as const, tag: (jordan ? "jordan" : "task") as DeskTag, href: t.projectId ? `/projects/${t.projectId}` : "/tasks", sinceISO: t.createdAt.toISOString(), client: null };
    const lines = taskLines({ title: t.title, projectTitle: t.project?.title ?? null }, w);
    if (!chase) {
      // No date at all: nobody would ever come back to it. A recent one is
      // Kyle's to give a time; an old one is backlog (never dated for him).
      if (nowMs - t.createdAt.getTime() >= WEEK_OLD_DAYS * DAY) { backlog++; continue; }
      push({
        ...base, id: `task:${t.id}`, state: "now", title: clean(t.title), line: jordan ? "From Jordan · no date yet" : "No date yet",
        reason: "No date or follow-up time yet. Give it one, or close it.", who: "You",
        dueISO: null, dueWords: null, late: false, rank: RANK.routine,
        primary: { label: "Set a time", action: taskAction(t.id) }, actions: [taskAction(t.id)],
        panel: { kind: "task", lines }, needsFollowUp: true,
      });
      continue;
    }
    push({
      ...base, id: `task:${t.id}`, state: "waiting", title: clean(t.title),
      line: w ? `Waiting on ${w.who} · Follow up ${etDate(chase)} ${etTime(chase)}` : `${jordan ? "From Jordan · " : ""}Due ${etDate(chase)}`,
      reason: w ? `Waiting on ${waitingWords(w)}${w.note ? `: ${clean(w.note)}` : ""}` : t.followUpAt ? "You set a follow-up time" : "Due later",
      who: w ? w.who : "You", dueISO: chase.toISOString(), dueWords: `Back ${etDate(chase)} ${etTime(chase)}`, late: false, rank: RANK.routine,
      primary: null, actions: [taskAction(t.id)],
      panel: { kind: "task", lines: [...lines, { label: "Comes back", value: etDateTime(chase) }] },
    });
  }

  // Revisions: a reply or an assignment is not the end. The change is open
  // until the corrected work is back, reviewed, sent, and checked.
  const revProjects = [...new Set((revisions ?? []).map((r) => r.projectId).filter((x): x is string => !!x))];
  const [cuts, photoJobsRev] = await Promise.all([
    revProjects.length ? prisma.reviewSubmission.findMany({ where: { projectId: { in: revProjects } }, select: { projectId: true, status: true, createdAt: true, sentToClientAt: true }, orderBy: { createdAt: "desc" }, take: 300 }).catch(() => []) : Promise.resolve([]),
    revProjects.length ? prisma.photoJob.findMany({ where: { projectId: { in: revProjects } }, select: { projectId: true, stage: true, deliveredAt: true, id: true } }).catch(() => []) : Promise.resolve([]),
  ]);
  const revisionProjects = new Set<string>();
  for (const r of revisions ?? []) {
    const street = clean(streetOf(r.project?.title));
    const photoLane = (r.dedupeKey ?? "").includes("photo");
    const latest = cuts.find((c) => c.projectId === r.projectId && c.createdAt > r.createdAt) ?? null;
    const pj = photoJobsRev.find((j) => j.projectId === r.projectId) ?? null;
    const promise = r.project?.promisedDueAt ?? r.project?.deliveryDue ?? null;
    const follow = r.followUpAt ?? r.dueAt ?? null;
    const editor = r.assignedKey && r.assignedKey !== opts.person.key ? first(nameOfKey(r.assignedKey)) : null;
    if (r.projectId) revisionProjects.add(r.projectId);
    const what = photoLane ? "Photo correction" : "Video revision";
    const lines = [{ label: "Change asked", value: clean(r.title) }, ...(r.project?.client ? [{ label: "Client", value: clean(r.project.client.name) }] : []), { label: "Opened", value: etDateTime(r.createdAt) }];
    const base = { id: `rev:${r.id}`, section: "followups" as const, tag: "revision" as const, title: `${street} · ${what}`, client: r.project?.client ? clean(r.project.client.name) : null, href: r.projectId ? (photoLane ? `/projects/${r.projectId}` : `/review/${r.projectId}`) : null, sinceISO: r.createdAt.toISOString() };
    let state: DeskState; let line: string; let reason: string; let who: string | null; let due: Date | null; let primary: DeskAction | null; let label = "Follow up"; let needs = false;
    if (photoLane && pj && pj.deliveredAt && pj.deliveredAt > r.createdAt) {
      [state, line, reason, who, due, primary, label] = ["now", "Updated photos delivered · Ready to check", `Corrected photos delivered ${etDateTime(pj.deliveredAt)}. Confirm with the client it is what they asked for, then close.`, "You", null, taskAction(r.id), "Review & close"];
    } else if (photoLane && pj && ["REVISION_REQUESTED", "FIXING", "READY", "DELIVERING", "QC_REVIEW", "EDITED", "QC_RUNNING"].includes(pj.stage)) {
      [state, line, reason, who, due, primary] = ["waiting", pj.stage === "READY" ? "Updated photos received · In Review & Deliver" : "With AutoHDR", "The corrected photos are in Photo Delivery. Assigned is not completed: it stays open until they are delivered and checked.", "Photo Delivery", follow ?? promise, null];
    } else if (latest?.sentToClientAt) {
      [state, line, reason, who, due, primary, label] = ["now", "Corrected version sent · Confirm with the client", `Corrected version sent ${etDateTime(latest.sentToClientAt)}. Replied or sent is not resolved: confirm it is what they asked for, then close.`, "You", null, taskAction(r.id), "Review & close"];
    } else if (latest?.status === "APPROVED") {
      [state, line, reason, who, due, primary] = ["waiting", "Approved · Ready to send in Review & Deliver", "Approved in review, not sent yet: it is in Review & Deliver to send.", "You (Review & Deliver)", follow ?? promise, null];
    } else if (latest?.status === "PENDING") {
      [state, line, reason, who, due, primary] = ["waiting", `Returned · In review with ${creativeName}`, `Corrected work returns to review, not done: waiting on ${creativeName}.`, creativeName, follow ?? promise, null];
    } else if (editor) {
      [state, line, reason, who, due, primary] = ["waiting", `Waiting on ${editor}`, `Assigned to ${editor}, not done yet.`, editor, follow ?? promise, null];
    } else {
      [state, line, reason, who, due, primary, label] = ["now", "Nobody has it yet · Give it to the editor", "Nobody has this change yet. Give it to the editor, then set when to check back.", "You", null, { kind: "link", label: "Open the job", href: base.href ?? "/review" }, "Route it"];
    }
    if (state === "waiting" && !due) { state = "now"; needs = true; reason = `${reason} No follow-up time is set.`; line = `${line} · No follow-up time`; primary = taskAction(r.id); label = "Set a time"; }
    if (state === "waiting" && due && due.getTime() <= nowMs) { state = "now"; reason = `${reason} The follow-up time has passed.`; line = `${line} · Follow up now`; primary = primary ?? taskAction(r.id); }
    else if (state === "waiting" && due) line = `${line} · Follow up ${etDayKey(due) === dayKey ? "at" : etDate(due)} ${etTime(due)}`;
    push({
      ...base, state, line, reason, who,
      dueISO: due?.toISOString() ?? null, dueWords: due ? dueWordsFor(due.toISOString(), now) : null,
      late: !!due && due.getTime() <= nowMs,
      rank: state === "now" ? (due && due.getTime() <= nowMs ? RANK.overdue : RANK.today) : RANK.routine,
      primary: state === "now" && primary ? { label, action: primary } : null,
      actions: [...(primary ? [primary] : []), ...(primary?.kind === "task" ? [] : [taskAction(r.id)])],
      panel: { kind: "task", lines: [...lines, { label: "Where it stands", value: reason }] },
      needsFollowUp: needs,
    });
  }
  // A photo change asked AFTER the photos went out (Alex's lamp): a revision
  // with a link back to its job, never that job's shoot request.
  const afterTitles = new Map<string, string>();
  const afterIds = [...new Set((photoAsks ?? []).map((a) => a.projectId!).filter(Boolean))];
  if (afterIds.length) for (const p of await prisma.project.findMany({ where: { id: { in: afterIds } }, select: { id: true, title: true } }).catch(() => [])) afterTitles.set(p.id, p.title);
  const afterDeliveryAsks = new Set<string>();
  for (const a of photoAsks ?? []) {
    const delivered = photoDelivered.get(a.projectId!);
    if (!delivered || a.askedAt <= delivered) continue;
    afterDeliveryAsks.add(a.id);
    const street = clean(streetOf(afterTitles.get(a.projectId!)));
    const dueISO = new Date(a.askedAt.getTime() + DAY).toISOString();
    const late = Date.parse(dueISO) < nowMs;
    push({
      id: `ask:${a.id}`, section: "followups", tag: "revision", state: "now",
      title: `${street} · Photo correction`, line: `Asked after delivery: "${short(clean(a.summary?.trim() || a.text), 60)}"`, client: null,
      reason: `The client asked for a change after the photos went out: "${clean(a.text)}"`,
      who: "You", dueISO, dueWords: dueWordsFor(dueISO, now), late, rank: late ? RANK.overdue : RANK.today,
      primary: { label: "Open photos", action: { kind: "link", label: "Open photos", href: `/projects/${a.projectId}` } },
      actions: [{ kind: "link", label: "Open photos", href: `/projects/${a.projectId}` }, { kind: "ask", askId: a.id, askKind: "SPECIAL_REQUEST" }],
      href: `/projects/${a.projectId}`,
      panel: { kind: "task", lines: [{ label: "The client asked", value: clean(a.text) }, { label: "Asked", value: etDateTime(a.askedAt) }, { label: "Photos delivered", value: etDateTime(delivered) }] },
      sinceISO: a.askedAt.toISOString(),
    });
  }
  // Special requests to check before delivery (a request for a visit on Today's
  // Shoots is in that visit; one that holds a photo approval is beside it).
  const heldIds = new Set([...holdingAsks.values()].flat().map((x) => x.id));
  for (const a of (special?.groups ?? []).flatMap((g) => g.asks)) {
    if (!a.projectId || prepAskIds.has(a.id) || afterDeliveryAsks.has(a.id) || heldIds.has(a.id) || prepProjectIds.has(a.projectId)) continue;
    const soon = a.behind || a.dueToday;
    if (!soon) continue; // a job going out later: on the job, not today's work
    push({
      id: `ask:${a.id}`, section: "followups", tag: "request", state: "now",
      title: `${clean(a.street ?? "A job")} · Special request`, line: `Check before delivery: ${short(clean(a.summary), 60)}`, client: a.clientName ? clean(a.clientName) : null,
      reason: `${clean(a.summary)}${a.holdsDelivery ? " (holds delivery)" : ""}`,
      who: "You", dueISO: a.dueAtISO, dueWords: a.dueAtISO ? dueWordsFor(a.dueAtISO, now) : null, late: a.behind, rank: a.behind ? RANK.overdue : RANK.today,
      primary: { label: "Check request", action: { kind: "ask", askId: a.id, askKind: "SPECIAL_REQUEST" } },
      actions: [{ kind: "ask", askId: a.id, askKind: "SPECIAL_REQUEST" }, { kind: "link", label: "Open the job", href: `/projects/${a.projectId}` }],
      href: `/projects/${a.projectId}`,
      panel: { kind: "task", lines: [{ label: "The client asked", value: clean(a.text) }, { label: "Asked", value: `${a.whenWords} (${a.sourceWords})` }] },
      sinceISO: a.askedAtISO,
    });
  }
  // Production follow-ups: photos late (or failed) at AutoHDR.
  for (const { c, failed } of photoLate) {
    const street = clean(c.street);
    // Oct 23 2026 (photo huddle item 12): a late job whose raws never arrived is the photographer's, not AutoHDR's.
    const notUp = !failed && !!c.waitingForUpload;
    push({
      id: `photos-late:${c.id}`, section: "followups", tag: "production", state: "now",
      title: `${street} · Photos`, line: failed ? "Editing failed in AutoHDR · Restart it" : notUp ? "Waiting for upload · Ask the photographer" : "Late from AutoHDR · Follow up", client: c.clientName ? clean(c.clientName) : null,
      reason: failed ? "AutoHDR could not edit this set. Restart it from Photo Delivery." : `Promised ${c.slaDueAt ? etDateTime(c.slaDueAt) : "earlier"}, still ${c.stageLabel.toLowerCase()}.`,
      who: failed ? "You" : notUp ? "the photographer" : "AutoHDR", dueISO: c.slaDueAt, dueWords: dueWordsFor(c.slaDueAt, now), late: true, rank: RANK.overdue,
      primary: { label: failed ? "Restart edits" : "Follow up", action: { kind: "link", label: "Open photos", href: `/ops/photo-delivery/${c.id}` } },
      actions: [{ kind: "link", label: "Open photos", href: `/ops/photo-delivery/${c.id}` }],
      href: `/ops/photo-delivery/${c.id}`,
      panel: { kind: "task", lines: [{ label: "Job", value: street }, { label: "Where it stands", value: c.stageLabel }, ...(c.slaDueAt ? [{ label: "Promised", value: etDateTime(c.slaDueAt) }] : [])] },
      sinceISO: null, thumb: c.hero ?? null,
    });
  }
  // Video edits and reviews not yet approved: the editor's or the creative
  // manager's move, followed up by Kyle once the promise is near or past.
  const jobRows = jobs?.rows ?? [];
  for (const r of [...(board?.lanes.late ?? []), ...(board?.lanes.today ?? [])]) {
    if (excludedProjects.has(r.projectId) || revisionProjects.has(r.projectId)) continue;
    const inReview = r.cutStatus === "PENDING";
    const editor = chipPerson(jobRows.find((j) => j.projectId === r.projectId)?.video?.label) ?? "the editor";
    const who = inReview ? creativeName : editor;
    const street = clean(r.street);
    const late = r.late;
    push({
      id: `edit:${r.key}`, section: "followups", tag: "production", state: late ? "now" : "waiting",
      title: `${street} · ${clean(r.label)}`,
      line: late ? `Late with ${who} · Follow up` : `${inReview ? `In review with ${creativeName}` : `With ${editor}`} · Due ${r.promiseISO ? etTime(r.promiseISO) : "today"}`,
      client: r.clientName ? clean(r.clientName) : null,
      reason: `${inReview ? `Waiting on ${creativeName}'s review` : `Waiting on ${editor}`}: ${clean(r.stage)}`,
      who, dueISO: r.promiseISO, dueWords: late && r.lateHours != null ? `Late by ${lateWords(r.lateHours)}` : dueWordsFor(r.promiseISO, now), late,
      rank: late ? RANK.overdue : RANK.today,
      primary: late ? { label: "Follow up", action: { kind: "link", label: "Open in Videos", href: r.reviewHref ?? "/review" } } : null,
      actions: [{ kind: "link", label: "Open in Videos", href: r.reviewHref ?? "/review" }],
      href: r.reviewHref ?? "/review",
      panel: { kind: "task", lines: [{ label: "Video", value: `${street} · ${clean(r.label)}` }, { label: "Where it stands", value: clean(r.stage) }, { label: "Waiting on", value: who }, ...(r.promiseISO ? [{ label: "Promised", value: etDateTime(r.promiseISO) }] : [])] },
      sinceISO: null,
    });
  }
  // Missing upload details and editing instructions after a shoot (the 10 AM nudge's own read).
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
      id: `remind:${projectId}`, section: "followups", tag: "production", state: waiting ? "waiting" : "now",
      title: `${street} · Missing upload details`,
      line: waiting ? `Waiting on ${first(who)} · Follow up at ${etTime(new Date(backAt!))}` : `Missing: ${view.missing.slice(0, 2).join(", ")}`, client: null,
      reason: `Missing: ${view.missing.join(", ")}${view.last ? ` · last reminded ${view.last.words}` : ""}`,
      who, dueISO: waiting ? new Date(backAt!).toISOString() : null, dueWords: waiting ? `Follow up ${etTime(new Date(backAt!))}` : null, late: false,
      rank: RANK.today,
      primary: waiting ? null : { label: "Remind", action }, actions: [action], href: `/projects/${projectId}`,
      panel: { kind: "task", lines: [{ label: "Job", value: street }, { label: "Missing", value: view.missing.join(", ") }, { label: "Photographer", value: who }] },
      sinceISO: null,
    });
  }

  // =====================================================================
  // THE SECTIONS, THE INTERRUPTIONS, THE DAILY CHECKS
  // =====================================================================
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  const unavailableBy: Record<DeskSectionKey, string[]> = {
    deliver: [!queue ? "photo delivery" : null, !board ? "videos" : null, !notTold ? "client notices" : null].filter((x): x is string => !!x),
    comms: [!comms ? "client messages" : null, !leads ? "leads" : null, !programTasks ? "program messages" : null].filter((x): x is string => !!x),
    shoots: [!visits ? "the shoot calendar" : null, !briefs ? "the photographer briefs" : null].filter((x): x is string => !!x),
    followups: [!tasks || !laterTasks ? "your tasks" : null, !revisions ? "revisions" : null, !board ? "videos" : null].filter((x): x is string => !!x),
  };
  const byDue = (a: DeskItem, b: DeskItem) => a.rank - b.rank || Number(b.late) - Number(a.late) || (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999") || a.title.localeCompare(b.title);
  const byTime = (a: DeskItem, b: DeskItem) => (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999");
  const sections: DeskSection[] = DESK_SECTIONS.map((s) => {
    const mine = unique.filter((i) => i.section === s.key);
    const sort = s.key === "shoots" ? byTime : s.key === "comms" ? (a: DeskItem, b: DeskItem) => Number(b.late) - Number(a.late) || (a.sinceISO ?? "").localeCompare(b.sinceISO ?? "") : byDue;
    const nowList = mine.filter((i) => i.state === "now").sort(sort);
    const unavailable = unavailableBy[s.key];
    return {
      key: s.key, title: s.title, empty: s.empty,
      count: unavailable.length && nowList.length === 0 ? null : nowList.length,
      now: nowList,
      waiting: mine.filter((i) => i.state === "waiting").sort(byTime),
      ok: mine.filter((i) => i.state === "ok").sort(byTime),
      quiet: quiet[s.key],
      unavailable,
    };
  });
  const sec = (k: DeskSectionKey) => sections.find((s) => s.key === k)!;
  const allNow = sections.flatMap((s) => s.now);

  // Only a verified, time-sensitive issue interrupts the day: a shoot within two
  // hours with no access instructions, no photographer or a brief that failed,
  // and a promised delivery due within the hour that is blocked.
  const urgent: OfficeDesk["urgent"] = [];
  for (const i of sec("shoots").now) {
    const v = i.panel.kind === "visit" ? i.panel.visit : null;
    if (!v?.timeISO || v.over) continue;
    const mins = (Date.parse(v.timeISO) - nowMs) / 60_000;
    if (mins > 120 || mins < 0) continue;
    const why = v.gaps.find((g) => g.startsWith("No access") || g.startsWith("No photographer")) ?? (v.brief.state === "failed" ? "the photographer's brief failed" : null);
    if (why) urgent.push({ id: i.id, text: `Shoot at ${etTime(v.timeISO)}, ${v.street}: ${why.charAt(0).toLowerCase()}${why.slice(1)}` });
  }
  for (const i of sec("deliver").now) {
    if (!i.dueISO) continue;
    const mins = (Date.parse(i.dueISO) - nowMs) / 60_000;
    const blocked = i.panel.kind === "job" && i.panel.assets.some((a) => a.tone === "failed" || (a.kind === "photos" && a.tone === "now" && a.action?.kind !== "photo-approve"));
    if (mins >= 0 && mins <= 60 && blocked) urgent.push({ id: i.id, text: `${i.title}: promised ${etTime(i.dueISO)} and blocked (${i.line.charAt(0).toLowerCase()}${i.line.slice(1)})` });
  }

  // ---- freshness: only what is wrong is said ----
  const freshness: Freshness[] = FRESH_JOBS.map((f) => freshnessOf(cron ? cron.find((j) => j.job === f.job) ?? null : null, f.label, f.job, now));
  if (!cron) freshness.forEach((f) => Object.assign(f, { state: "unknown", words: "sync health couldn't be read" }));
  const unavailable = [...new Set(Object.values(unavailableBy).flat())];
  for (const what of unavailable) freshness.push({ key: `read:${what}`, label: what[0].toUpperCase() + what.slice(1), state: "failed", atISO: null, words: "couldn't be read just now" });

  // ---- the daily checks ----
  let record: CloseoutRecord = { ticks: {} };
  try {
    if (closeRec?.value) {
      const parsed = JSON.parse(closeRec.value) as Partial<CloseoutRecord>;
      record = { ticks: parsed.ticks ?? {}, finished: parsed.finished ?? null };
    }
  } catch { /* unreadable: no ticks */ }
  const todayVisits = [...sec("shoots").now, ...sec("shoots").ok, ...sec("shoots").waiting].filter((i) => i.day === "today" && i.panel.kind === "visit" && !i.panel.visit.over);
  const todayOpen = sec("shoots").now.filter((i) => i.day === "today");
  const nextAll = [...sec("shoots").now, ...sec("shoots").ok, ...sec("shoots").waiting].filter((i) => i.day === "next");
  const nextOpen = sec("shoots").now.filter((i) => i.day === "next");
  const dueOpen = sec("deliver").now.filter((i) => !!i.dueISO && Date.parse(i.dueISO) < endToday.getTime());
  const followDue = sec("followups").now.filter((i) => !i.dueISO || Date.parse(i.dueISO) < endToday.getTime());
  const withoutTime = sec("followups").now.filter((i) => i.needsFollowUp);
  const comms0 = sec("comms").count;
  const derived: Record<CheckKey, { auto: boolean | null; words: string }> = {
    am_messages: comms0 == null ? { auto: null, words: "Messages couldn't be read" } : comms0 === 0 ? { auto: true, words: "Nobody is waiting on a reply" } : { auto: false, words: `${plural(comms0, "conversation")} waiting on you` },
    am_shoots: sec("shoots").count == null ? { auto: null, words: "The calendar couldn't be read" } : todayOpen.length === 0 ? { auto: true, words: todayVisits.length ? `${plural(todayVisits.length, "shoot")} ready` : "No shoots left today" } : { auto: false, words: `${plural(todayOpen.length, "shoot")} not ready` },
    am_deliveries: sec("deliver").count == null ? { auto: null, words: "Deliveries couldn't be read" } : sec("deliver").count === 0 ? { auto: true, words: "Nothing waiting on you to deliver" } : { auto: false, words: `${plural(sec("deliver").count!, "delivery", "deliveries")} waiting on you` },
    md_new: { auto: null, words: "Your review" },
    eod_messages: comms0 == null ? { auto: null, words: "Messages couldn't be read" } : comms0 === 0 ? { auto: true, words: "Nobody is waiting on a reply" } : { auto: false, words: `${plural(comms0, "conversation")} still waiting: answer, or note why not` },
    md_commitments: followDue.length === 0 ? { auto: true, words: "Every commitment due today is handled" } : { auto: false, words: `${plural(followDue.length, "follow-up")} due` },
    eod_deliveries: dueOpen.length === 0 ? { auto: true, words: "Everything due today is out" } : { auto: false, words: `${plural(dueOpen.length, "delivery", "deliveries")} due today still open: send, or note the exception` },
    eod_owners: withoutTime.length === 0 ? { auto: true, words: "Every open request has an owner and a follow-up time" } : { auto: false, words: `${plural(withoutTime.length, "item")} without a follow-up time` },
    eod_nextday: sec("shoots").count == null ? { auto: null, words: "The calendar couldn't be read" } : nextOpen.length === 0 ? { auto: true, words: nextAll.length ? `${plural(nextAll.length, "visit")} ready through ${etDate(etAt(nextDay, 12))}` : `No shoots through ${etDate(etAt(nextDay, 12))}` } : { auto: false, words: `${plural(nextOpen.length, "visit")} through ${etDate(etAt(nextDay, 12))} not ready` },
  };
  const groupsOut: CheckGroup[] = DAILY_CHECKS.map((g) => {
    const lines: CheckLine[] = g.items.map((c) => {
      const d = derived[c.key];
      const tick = c.manual ? record.ticks[c.key] ?? null : null;
      return { key: c.key, label: c.label, manual: c.manual, auto: d.auto, autoWords: d.words, tick: tick ? { atISO: tick.at, by: tick.by } : null, done: d.auto === true || !!tick };
    });
    const done = lines.every((l) => l.done);
    const ticks = lines.map((l) => l.tick?.atISO).filter((x): x is string => !!x).sort();
    return { key: g.key, label: g.label, lines, done, completedAtISO: done ? ticks.at(-1) ?? null : null };
  });
  const finished = record.finished ? { atISO: record.finished.at, by: record.finished.by } : null;
  const newSinceFinish = finished ? allNow.filter((i) => !!i.sinceISO && i.sinceISO > finished.atISO).length : 0;

  // ---- the day's summary, from what actually happened ----
  const myUser = opts.person.teamMemberId ? await prisma.appUser.findFirst({ where: { teamMemberId: opts.person.teamMemberId }, select: { id: true } }).catch(() => null) : null;
  const [approvals, sent, notices, closed, asksDone, texts, programPosts, confirmedByMe] = await Promise.all([
    prisma.photoJobEvent.findMany({ where: { at: { gte: startToday }, action: { startsWith: "approved:" } }, select: { actor: true, at: true, action: true, job: { select: { projectId: true } } }, take: 200 }).catch(() => []),
    prisma.reviewSubmission.findMany({ where: { sentToClientAt: { gte: startToday } }, select: { sentToClientBy: true, sentToClientAt: true, project: { select: { title: true } } }, take: 200 }).catch(() => []),
    prisma.reviewSubmission.findMany({ where: { clientNoticeAt: { gte: startToday } }, select: { clientNoticeBy: true, clientNoticeAt: true, clientNoticeVia: true, project: { select: { title: true } } }, take: 200 }).catch(() => []),
    checklistTasksClosedToday(now, { person: opts.person, excludeClientIds: ex, scrub: true }).catch(() => [] as ClosedTask[]),
    prisma.clientAsk.findMany({ where: { OR: [{ confirmedAt: { gte: startToday } }, { doneAt: { gte: startToday } }] }, select: { summary: true, text: true, confirmedBy: true, confirmedAt: true, doneBy: true, doneAt: true }, take: 200 }).catch(() => []),
    opts.person.teamMemberId
      ? prisma.commLog.findMany({ where: { direction: "out", occurredAt: { gte: startToday }, senderTeamMemberId: opts.person.teamMemberId }, select: { clientName: true, occurredAt: true, channel: true }, orderBy: { occurredAt: "asc" }, take: 300 }).catch(() => [])
      : Promise.resolve([] as { clientName: string | null; occurredAt: Date; channel: string }[]),
    myUser ? prisma.programMessage.findMany({ where: { authorKind: "STAFF", staffUserId: myUser.id, createdAt: { gte: startToday } }, select: { createdAt: true, clientId: true }, take: 100 }).catch(() => []) : Promise.resolve([] as { createdAt: Date; clientId: string }[]),
    // A shoot Kyle confirmed himself ("Confirmed another way"): the dismissal names him.
    prisma.smartTask.findMany({ where: { taskType: "confirmation_text", status: "CANCELLED", updatedAt: { gte: startToday }, summary: { startsWith: "Dismissed by " } }, select: { summary: true, updatedAt: true, project: { select: { title: true } } }, take: 100 }).catch(() => []),
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
  // The Completed today card: each a real event with its own time, newest first.
  const programClients = new Map(
    programPosts.length ? (await prisma.client.findMany({ where: { id: { in: [...new Set(programPosts.map((m) => m.clientId))] } }, select: { id: true, name: true } }).catch(() => [])).map((c) => [c.id, c.name] as const) : [],
  );
  const activity: DaySummary["activity"] = [
    ...approvals.filter((a) => isMe(a.actor)).map((a) => ({ atISO: a.at.toISOString(), what: `Photos approved · ${streetOf(approvalTitles.get(a.job.projectId))}`, detail: /deliver/.test(a.action) ? "Approve and deliver" : "Approve and upload" })),
    ...sent.filter((x) => isMe(x.sentToClientBy) && x.sentToClientAt).map((x) => ({ atISO: x.sentToClientAt!.toISOString(), what: `Video sent · ${streetOf(x.project?.title)}`, detail: null })),
    ...notices.filter((x) => isMe(x.clientNoticeBy) && x.clientNoticeAt).map((x) => ({ atISO: x.clientNoticeAt!.toISOString(), what: `Client told the video is up · ${streetOf(x.project?.title)}`, detail: x.clientNoticeVia ? `By ${x.clientNoticeVia.replace(/-/g, " ")}` : null })),
    ...(() => {
      // One line per client conversation answered (the last message's time).
      const last = new Map<string, { at: Date; channel: string }>();
      for (const t of texts) last.set(t.clientName ?? "a client", { at: t.occurredAt, channel: t.channel });
      return [...last.entries()].map(([who, x]) => ({ atISO: x.at.toISOString(), what: `Replied to ${who}`, detail: x.channel === "email" ? "Email" : x.channel === "call" ? "Call" : "Text" }));
    })(),
    ...programPosts.map((m) => ({ atISO: m.createdAt.toISOString(), what: `Replied on Content Program · ${programClients.get(m.clientId) ?? "a client"}`, detail: null })),
    ...asksDone.filter((a) => isMe(a.confirmedBy) || isMe(a.doneBy)).map((a) => ({ atISO: ((isMe(a.confirmedBy) ? a.confirmedAt : a.doneAt) ?? now).toISOString(), what: "Client request checked", detail: short(a.summary?.trim() || a.text, 70) })),
    ...confirmedByMe.filter((t) => myNames.some((n) => (t.summary ?? "").toLowerCase().startsWith(`dismissed by ${n}`))).map((t) => ({ atISO: t.updatedAt.toISOString(), what: `Shoot confirmed · ${streetOf(t.project?.title)}`, detail: "Confirmed another way" })),
    ...closed.map((t) => ({ atISO: t.atISO, what: t.how === "done" ? "Task done" : "Task closed as not needed", detail: t.title })),
  ].map((x) => ({ ...x, what: clean(x.what), detail: x.detail ? clean(x.detail) : null })).sort((a, b) => b.atISO.localeCompare(a.atISO));
  const summary: DaySummary = {
    activity,
    completed,
    completedTotal: completed.reduce((n, c) => n + c.count, 0),
    pending: sections.map((s) => ({ section: s.title, now: s.count, waiting: s.waiting.length })),
    blockers: [...allNow.filter((i) => i.late || i.rank === RANK.blocker).slice(0, 5).map((i) => `${i.title}: ${i.line}`), ...freshness.filter((f) => f.state === "failed" || f.state === "stale").map((f) => `${f.label}: ${f.words}`)],
    tomorrow: {
      dayWords: etFullDate(etAt(nextDay, 12)),
      lines: [
        `${plural(nextAll.length, "visit")} on the calendar${nextOpen.length ? `, ${nextOpen.length} not ready yet` : ""}`,
        ...(() => {
          const b = etDayBoundsUtc(nextDay);
          const back = unique.filter((i) => i.state === "waiting" && !!i.dueISO && Date.parse(i.dueISO) < b.end.getTime()).length;
          return [`${plural(back, "follow-up")} coming back`];
        })(),
      ],
    },
  };

  // ---- the next business day, at a glance (the visit rows' own facts) ----
  const nextVisits = nextAll.filter((i) => i.panel.kind === "visit").map((i) => ({ i, v: (i.panel as { kind: "visit"; visit: PrepVisit }).visit }));
  const accessMissing = (v: PrepVisit) => v.gaps.some((g) => g.startsWith("No access") || g.startsWith("No on-site contact"));
  const instructionsNeedReview = (v: PrepVisit) => v.conflicts.length > 0 || v.servicesFrom === "none" || v.brief.state === "failed" || v.brief.state === "unknown" || v.gaps.some((g) => g.startsWith("No photographer"));
  const nextDayOut: NextDay = {
    dayKey: nextDay,
    dayName: new Date(`${nextDay}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
    visits: nextVisits.length,
    appointments: { confirmed: nextVisits.filter(({ v }) => v.confirmation.state === "sent" || v.confirmation.state === "other").length, pending: nextVisits.filter(({ v }) => v.confirmation.state !== "sent" && v.confirmation.state !== "other").length },
    access: { recorded: nextVisits.filter(({ v }) => !accessMissing(v)).length, missing: nextVisits.filter(({ v }) => accessMissing(v)).length },
    instructions: { ready: nextVisits.filter(({ v }) => !instructionsNeedReview(v)).length, review: nextVisits.filter(({ v }) => instructionsNeedReview(v)).length },
    missing: nextVisits.filter(({ i }) => i.state === "now").flatMap(({ i, v }) => i.reason.split(" · ").filter(Boolean).map((problem) => ({
      visitId: i.id, street: v.street, timeISO: v.timeISO, problem,
      action: problem === v.confirmation.words ? i.actions.find((a) => a.kind === "confirm") ?? i.primary?.action ?? null
        : /^Brief/.test(problem) || /Got it/.test(problem) ? i.actions.find((a) => a.kind === "brief-send") ?? i.primary?.action ?? null
        : i.actions.find((a) => a.kind === "link") ?? null,
    }))),
  };
  // A photographer's number, for "Text <name>" beside a brief still waiting on its Got it.
  const pendIds = [...new Set(briefsPending.map((b) => b.teamMemberId))];
  if (pendIds.length) {
    const phonesTm = new Map((await prisma.teamMember.findMany({ where: { id: { in: pendIds } }, select: { id: true, phone: true } }).catch(() => [])).map((t) => [t.id, t.phone] as const));
    for (const b of briefsPending) b.phone = phonesTm.get(b.teamMemberId) ?? null;
  }
  const gmailFresh = freshness.find((f) => f.key === "gmail")?.state === "ok";

  return {
    nowISO: now.toISOString(), dayKey, dateWords: etFullDate(now), person: opts.person.name, people: { creative: creativeName, owner: ownerName }, readOnly: !!opts.readOnly,
    freshness, unavailable, urgent, sections,
    checks: { dayKey, groups: groupsOut, finished, newSinceFinish, summary },
    backlog: { count: backlog, href: "/ops/checklist#earlier" },
    nextDay: nextDayOut,
    briefsPending,
    commsFresh: gmailFresh && sec("comms").unavailable.length === 0,
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
    case "photo-approve": return "Review";
    case "video-send": return a.label === "Try again" ? "Try again" : "Deliver";
    case "video-push": return a.uploadedOnly ? "Send now" : a.canDeliverNow ? "Deliver now" : "Release";
    case "video-notice": return "Tell the client";
    case "reply": return "Reply";
    case "program-reply": return "Reply";
    case "delegation": return a.state === "ASSIGNED" ? "Accept" : "Update";
    case "follow-up": return "Create follow-up";
    case "task": return "Handle";
    case "ask": return a.askKind === "SCHEDULING" ? "Answer" : "Check request";
    case "remind": return "Remind";
    case "confirm": return "Confirm";
    case "brief-send": return a.resend ? "Resend brief" : "Send brief";
    case "topaz-rerun": return RERUN_LABEL;
    case "link": return a.label;
  }
}
