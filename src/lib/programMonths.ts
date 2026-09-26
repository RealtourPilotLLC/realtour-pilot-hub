import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

import { etMonthKey } from "@/lib/contentProgram";

// ---------------------------------------------------------------------------
// PROGRAM MONTH STATE (spec §4 / §19), Sep 16 2026.
//
// A month's call status used to be frozen at row creation and then poked by
// four different writers (the Calendly stamp, the Drive sweep, two buttons,
// the pipeline's COMPLETED). This module is the ONE derivation:
//
//   strategyCallStatus  ← the month's ProgramCallRecords + the enrollment's
//                         call mode (NOT_REQUIRED by rule, not by hand)
//   planningMode        ← CALL | WRITTEN | UNDECIDED
//   preparationStatus   ← CALL_PLANNED | WRITTEN_SELECTED | AWAITING_ANSWERS |
//                         PREPARING_SCRIPTS | AWAITING_SCRIPT_APPROVAL |
//                         READY_FOR_FILMING
//   earliestSessionAt   ← the 72-weekday-hour window (ET; §3, Sep 25 2026),
//                         honouring the month's legacy day override, the
//                         enrollment's hour override and a staff
//                         exception+reason. preparationGate() is the ONE
//                         reader of it per session (A20).
//   sessions            ← per-session material readiness, because sufficiency
//                         is a SESSION question, not a month one
//
// `deriveMonthState` is PURE (unit-testable from a probe); `recalcProgramMonth`
// reads, derives and persists. Called after every call-record, transcript and
// session-request change, and hourly from the cron.
//
// Legacy truth is preserved: a month that says COMPLETED because a transcript
// was pasted or the old sweep ingested it, with no ProgramCallRecord behind
// it, stays COMPLETED — the derivation only RAISES from records and only
// re-homes NOT_SCHEDULED ↔ NOT_REQUIRED by the enrollment's call mode. That
// second rule is what fixes Mike Ciunci (strategyCallRequired=false since Aug
// 28, months minted NOT_SCHEDULED on Aug 24) without touching his row by hand.
// ---------------------------------------------------------------------------

export type CallMode = "REQUIRED" | "OPTIONAL_WRITTEN" | "NOT_INCLUDED";
export type PlanningMode = "CALL" | "WRITTEN" | "UNDECIDED";
export type PreparationStatus =
  | "CALL_PLANNED" | "WRITTEN_SELECTED" | "AWAITING_ANSWERS" | "PREPARING_SCRIPTS" | "AWAITING_SCRIPT_APPROVAL" | "READY_FOR_FILMING";
export type StrategyCallStatus = "NOT_REQUIRED" | "NOT_SCHEDULED" | "SCHEDULED" | "COMPLETED" | "SKIPPED";

// ---------------------------------------------------------------------------
// THE PREPARATION CLOCK (spec §8 / F04, Sep 21 2026).
//
// This module used to open the filming window with `addBusinessDaysET(base, 3)`.
// Jordan's confirmed rule differs in three ways and every one of them moved a
// real date:
//
//   · it is 48 HOURS OF WEEKDAY TIME. Not three business days, not 48 staffed
//     9-6 hours, not "the start of the second weekday". Monday 2 PM becomes
//     Wednesday 2 PM. Friday 10 AM becomes Tuesday 10 AM — 14 hours of Friday,
//     the weekend frozen, then 34 hours of Monday and Tuesday (spec §8, A22).
//   · the time of day survives. addBusinessDaysET lands on MIDNIGHT ET of the
//     Nth day, so a Monday 2 PM call used to open Thursday 00:00 ET: a day and
//     a half later than Jordan's own worked example.
//   · the clock starts when the call ENDS. scheduledStart was what the code
//     read, which opened every window half an hour early on the 30-minute
//     monthly calls that are actually on file.
//
// DST needs no special case and deliberately gets none. The US changes its
// clocks at 2 AM on a SUNDAY — the one time this clock does not count — and the
// walk below asks etAt() for each ET day's own end, so a 23- or 25-hour Sunday
// is consumed whole and contributes no hour either way. There is not a single
// hard-coded UTC offset in here.
//
// 72, NOT 48 (W01, Jordan's settled rule, Sep 25 2026): "72 elapsed weekday
// hours in America/New_York, excluding Saturdays and Sundays. Monday 2:30 p.m.
// becomes Thursday 2:30 p.m.; Friday 2 p.m. becomes Wednesday 2 p.m." Only the
// constant moved — the clock above was already that clock. The rule is
// evaluated when a request is made and snapshotted on it (gateWindowHours), so
// a session booked under 48 is never re-judged by 72: moving the rule moves
// the door, never anything already through it.
// ---------------------------------------------------------------------------

/** The program's preparation window: 72 hours of weekday time (§3). */
export const DEFAULT_PREPARATION_WINDOW_HOURS = 72;

/**
 * RETIRED Sep 21 2026 — the window is hours of weekday time now, not business
 * days. Kept (not deleted) because the per-month override column is still
 * `preparationWindowDays`, and the enrollment override used to be typed in
 * days: a legacy "3" means three 24-hour days of weekday time (`days * 24`).
 */
export const DEFAULT_PREPARATION_WINDOW_DAYS = 3;

/**
 * The enrollment's own window, in hours of weekday time, from its overrides
 * JSON (Settings → Permitted overrides). `preparationWindowHours` is the key
 * the panel writes now; a legacy `preparationWindowDays` is still read (×24).
 *
 * THE OVERRIDE USED TO BE A DEAD CONTROL (W01, batch 0): the panel wrote
 * `preparationWindowDays` into the enrollment's JSON and nothing in the tree
 * read it — the derivation read the MONTH column, which has no writer. So an
 * owner could set a client's window and the gate ignored it. Parsed here, not
 * via enrollmentChanges.readOverrides, so this module keeps no import on the
 * settings layer. Null = no override.
 */
export function enrollmentWindowOverrideHours(overridesJson: string | null | undefined): number | null {
  let o: Record<string, unknown> = {};
  try { const v = overridesJson ? JSON.parse(overridesJson) : {}; if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { return null; }
  const hours = Number(o.preparationWindowHours);
  if (o.preparationWindowHours != null && Number.isFinite(hours) && hours > 0) return Math.round(hours);
  const days = Number(o.preparationWindowDays);
  if (o.preparationWindowDays != null && Number.isFinite(days) && days > 0) return Math.round(days * 24);
  return null;
}

/**
 * Hours of weekday time for a month. Precedence (W01): the month's own legacy
 * day column (×24) → the enrollment's hour override → 72.
 */
export function preparationWindowHours(preparationWindowDays: number | null | undefined, enrollmentHours?: number | null): number {
  if (preparationWindowDays != null && preparationWindowDays > 0) return preparationWindowDays * 24;
  if (enrollmentHours != null && enrollmentHours > 0) return enrollmentHours;
  return DEFAULT_PREPARATION_WINDOW_HOURS;
}

const nextDayKeyET = (key: string): string => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
};

/**
 * `hours` of WEEKDAY time (Mon-Fri, America/New_York) after an instant.
 *
 * A clock that ticks only while it is a weekday in ET. It keeps the wall-clock
 * time of day, freezes across Saturday and Sunday, and is DST-correct by
 * construction (see the block comment above). A start that lands inside a
 * weekend simply finds no weekday time in those days and begins at 00:00 ET on
 * Monday. When the count runs out exactly at an ET midnight the answer is the
 * next moment of weekday time, never a Saturday 00:00.
 */
export function addWeekdayHoursET(from: Date, hours: number): Date {
  if (isNaN(from.getTime())) return new Date(NaN);
  let remaining = Math.max(0, hours) * 3_600_000;
  let cursor = new Date(from.getTime());
  // 400 ET days is ~57 weeks: far past any window a person would ever set, and
  // a hard stop so a bad `hours` can never spin the server.
  for (let guard = 0; guard < 400; guard++) {
    const dayEnd = etAt(nextDayKeyET(etDayKey(cursor)), 0);
    if (isWeekdayET(cursor)) {
      const available = dayEnd.getTime() - cursor.getTime();
      if (remaining < available) return new Date(cursor.getTime() + remaining);
      remaining -= available;
    }
    cursor = dayEnd;
  }
  return cursor;
}

/**
 * THE EARLIEST FILMING START — the one arithmetic every gate uses (unified
 * handoff §6.4, Sep 25 2026). The written route's material, the call route's
 * scheduled end and the written route's call buffer all go through here
 * inside deriveMonthState, and every reader asks preparationGate() for the
 * result (A20): the portal gate, the reminder's quoted date, the staff
 * overview, the desk task and the booking adapter's recheck. Nothing else
 * calls addWeekdayHoursET for scheduling.
 */
export function earliestFilmingStart(base: Date, w: { windowHours: number; windowWaived: boolean }): Date {
  return w.windowWaived ? base : addWeekdayHoursET(base, w.windowHours);
}

/** The enrollment's call mode: the explicit column, else derived from the legacy flag. */
export function callModeOf(e: { callMode: string | null; strategyCallRequired: boolean }): CallMode {
  if (e.callMode === "REQUIRED" || e.callMode === "OPTIONAL_WRITTEN" || e.callMode === "NOT_INCLUDED") return e.callMode;
  return e.strategyCallRequired ? "REQUIRED" : "NOT_INCLUDED";
}

/**
 * The call mode a MONTH actually runs on (§3, Sep 25 2026: "The previously
 * required first strategy call remains required … Later monthly calls are
 * optional"). callModeOf derives REQUIRED from strategyCallRequired, which
 * defaults to true, so every enrollment without a hand-set column was
 * call-only for EVERY month — the written route was never offered and the
 * reminder evaluator chased a mandatory call each month.
 *
 *   · an explicit column wins — staff overrides are kept exactly;
 *   · the legacy-derived REQUIRED holds only until the enrollment's first
 *     monthly strategy call has been held (in another month), then the month
 *     is OPTIONAL_WRITTEN — unless the client is switched off the written
 *     route (noCallEligible === false), which keeps it call-only.
 * Pure; the caller supplies `priorProgramCallHeld` (recalcProgramMonth and
 * planningFacts read it with one query).
 */
export function effectiveCallMode(
  e: { callMode: string | null; strategyCallRequired: boolean; noCallEligible?: boolean | null },
  ctx: { priorProgramCallHeld: boolean },
): CallMode {
  const base = callModeOf(e);
  const explicit = e.callMode === "REQUIRED" || e.callMode === "OPTIONAL_WRITTEN" || e.callMode === "NOT_INCLUDED";
  if (explicit || base !== "REQUIRED" || !ctx.priorProgramCallHeld) return base;
  return e.noCallEligible === false ? "REQUIRED" : "OPTIONAL_WRITTEN";
}

/**
 * N business days after an instant, on the ET calendar, landing at the start
 * of that ET day (a Friday 6pm ET call → the following Wednesday, not Thursday
 * because the server's UTC clock already said Saturday). Weekends only — the
 * program keeps no holiday calendar.
 */
// This WAS the only DST-correct business-day walk in the codebase, so it is now
// the one in datetime.ts and this is a re-export — every caller keeps working
// and there is one implementation to be right (audit S0, Sep 18).
import { addBusinessDaysET as addBusinessDaysET, etAt, etDayKey, isWeekdayET } from "@/lib/datetime";
export { addBusinessDaysET };

export type MonthCallRecordInput = {
  /** ProgramCallRecord.id — names the gate's anchor (A20). Optional: a caller building its own input may not have it. */
  id?: string | null;
  callType: string;
  status: string; // SCHEDULED | COMPLETED | CANCELLED | RESCHEDULED | NO_SHOW
  matchState: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  transcriptState: string;
  /** When the record landed — the moment a booked call opened filming (A19). */
  createdAt?: Date | null;
};

// ---------------------------------------------------------------------------
// THE PREPARATION GATE — one reading per session (A18/A19/A20, Sep 25 2026).
//
// §3 has two routes and one clock:
//   · WRITTEN — filming opens when the session's topics are chosen and their
//     answers are SUBMITTED (an autosave never counts); sessions start from
//     that submission + 72 weekday hours;
//   · CALL — filming opens the moment the strategy call is BOOKED, before it
//     happens; sessions start from the call's scheduled END + 72 weekday
//     hours. Never the time somebody clicked Book.
// Before this, the call route opened in the derivation only once the call was
// HELD, while the portal ran its own "booked, not held" branch: two readings
// of one rule (F04's shape), so the reminder's quoted date, the staff overview
// and the portal disagreed on every booked-but-future call. deriveMonthState
// now anchors every session itself, and preparationGate() is the one reader.
//
// The ANCHOR is the fact the window is counted from, with an identity (`ref`)
// that changes when the fact moves — a call rebooked later, answers submitted
// again. A request snapshots it (gateAnchorRef/gateWindowHours/gateEarliestAt),
// so reassessment compares ANCHORS, never windows: a rule change (48 → 72)
// never flags a session booked under the old rule.
// ---------------------------------------------------------------------------

export type GateAnchor = {
  kind: "SUBMISSION" | "CALL_END";
  /** The instant the window is counted from. */
  at: Date;
  /** `CALL_END:<recordId|legacy>:<epoch ms>` or `SUBMISSION:<topicId|month>:<epoch ms>` — equal only while the fact is unchanged. */
  ref: string;
  /** Staff words for it ("the strategy call's scheduled end"). */
  label: string;
  /** Counted from an estimate (a call with no end on record → its start). */
  estimated: boolean;
};

/** Why a session's filming calendar is shut. */
export type GateLock = "BOOK_CALL" | "CHOOSE_ROUTE" | "ANSWERS" | "UNDER_PLANNED" | "PREPARING";

// ---------------------------------------------------------------------------
// SESSIONS AND THEIR MATERIAL (spec §3 / §8 / A15 / A23, Sep 21 2026).
//
// Sufficiency is per SESSION, not per month and certainly not per topic. The
// code this replaces asked one question — "has ANY interview been submitted?" —
// which opened a four-video Accelerator session on one finished topic, and
// would have let a Pro client film their FIRST session only once the SECOND
// session's material was in.
//
// The hub owns the session split. Aryeo's "VIDEO PRO - 8HR Session" product is
// a single 240-minute block and no Pro order has ever been placed, so there is
// no provider record to read a session index off; §3 is the authority and it
// says Pro is two sessions of four videos. Sessions are therefore DERIVED here:
// the month's required topics in a stable order, chunked into the package's
// session count. No schema column, no guesswork about which topic a client
// "meant" for which half.
//
// A topic is required when it is planned to be filmed this month (SELECTED, or
// SCRIPTED because a script was already written for it). A carried-over topic
// arrives in exactly that shape with its approved script attached, which is why
// an approved script counts as material in its own right (§8: "including
// already approved carried-over scripts").
// ---------------------------------------------------------------------------

/** ContentTopic.status values that mean "planned to be filmed in this month". */
const REQUIRED_TOPIC_STATUSES = new Set(["SELECTED", "SCRIPTED"]);
/**
 * Footage exists (A24, Sep 25 2026). These stay IN the session split: with the
 * filmed topics dropped, a Pro month whose first session was filmed slid its
 * remaining four topics into "session 1" and left session 2 empty — so the
 * gate for the session the client actually had left to book (index 2) read
 * "no topics" and locked. A filmed topic's material obviously existed.
 */
const FILMED_TOPIC_STATUSES = new Set(["FILMED", "EDITING", "DELIVERED"]);

export type TopicMaterialInput = {
  topicId: string;
  /** ContentTopic.status */
  status: string;
  title?: string | null;
  createdAt: Date | null;
  /** An APPROVED / released / historical script exists for this topic (a carried-over script counts). */
  scriptApproved: boolean;
  scriptApprovedAt: Date | null;
  /** ContentInterview.status for this topic, or null when no interview exists. */
  interviewStatus: string | null;
  interviewSubmittedAt: Date | null;
  /**
   * CP-08: the interview's stored sufficiency reading. `false` = a legacy
   * SUBMITTED row whose answers cannot carry a script; it does not open the
   * preparation clock. Omitted/null = no reading on the row (not a veto).
   */
  interviewSufficient?: boolean | null;
};

export type SessionReadiness = {
  /** 1-based: session 1 is the first four videos of a Pro month. */
  index: number;
  /** What the package plans for this session (Starter 2, Accelerator 4, Pro 4 + 4). */
  plannedVideos: number;
  topicIds: string[];
  readyTopicIds: string[];
  missingTopicIds: string[];
  /** Every required topic in THIS session has material. */
  sufficient: boolean;
  /** When the last required piece of this session's material landed. */
  materialReadyAt: Date | null;
  /** The earliest this session may be filmed, or null while the gate is shut. */
  earliestSessionAt: Date | null;
  /** What `earliestSessionAt` is counted from (null while shut). */
  anchor: GateAnchor | null;
  /** Why it is shut (null while open). */
  lock: GateLock | null;
  notes: string[];
};

export type PreparationFollowUp = {
  kind: "MISSING_POST_CALL_INFO" | "UNFINISHED_ANSWERS" | "ANSWERS_REOPENED" | "UNDER_PLANNED_SESSION" | "CALL_INSIDE_BUFFER" | "CONFIRM_CALL_END";
  /** Who owns chasing it (spec §3: scheduling and client follow-up are Kyle's). */
  owner: "KYLE" | "JORDAN";
  reason: string;
  sessionIndex: number | null;
  /** The identity of the facts behind it, when a desk task is keyed on them
   *  (CALL_INSIDE_BUFFER: the session's start and the call's end, epoch ms). */
  ref?: string;
};

/** A topic's material is complete. A submission STAMP is not enough on its own:
 *  an interview reopened after submission keeps `submittedAt` and would have
 *  held the gate open forever, which is the same defect as the stored month
 *  stamp this batch removed. The live status wins whenever there is one. */
export function topicMaterialReady(t: TopicMaterialInput): boolean {
  if (t.scriptApproved || FILMED_TOPIC_STATUSES.has(t.status)) return true;
  // SUBMITTED_WITH_GAPS is not SUBMITTED, so it never opens the gate; a
  // SUBMITTED row that stored "not sufficient" (sent before CP-08) does not either.
  return t.interviewStatus ? t.interviewStatus === "SUBMITTED" && t.interviewSufficient !== false : !!t.interviewSubmittedAt;
}

/** The `sufficient` flag an interview row stored, or null when it stored none. */
function storedSufficiency(json: string | null): boolean | null {
  if (!json) return null;
  try { const v = JSON.parse(json) as { sufficient?: unknown }; return typeof v.sufficient === "boolean" ? v.sufficient : null; } catch { return null; }
}

/** The moment this topic's material landed — the earliest real event, never "now". */
export function topicMaterialReadyAt(t: TopicMaterialInput): Date | null {
  const times = [t.scriptApproved ? t.scriptApprovedAt : null, topicMaterialReady(t) ? t.interviewSubmittedAt : null]
    .filter((d): d is Date => d instanceof Date && !isNaN(d.getTime()));
  if (times.length === 0) return null;
  return times.reduce((a, b) => (a <= b ? a : b));
}

/**
 * Split a month's required topics into the package's sessions. Stable order
 * (creation, then id) so the same month always splits the same way.
 *
 * EXTRAS ARE NOT HERE (R01, Sep 25 2026). recalcProgramMonth hands in only the
 * topics inside the month's allowance (planningState.allowanceOrder). It used
 * to hand in every topic pointing at the month, so an extra — kept, "waits its
 * turn" — landed in the last session and an unanswered one held the written
 * route's filming calendar shut (and, on Pro, session 2). Anything past the
 * plan that still arrives here (a caller building its own input) lands in the
 * last session rather than vanishing.
 */
export function planSessions(
  topics: TopicMaterialInput[],
  plan: { videosPerMonth: number; sessionsPerMonth: number },
): { index: number; plannedVideos: number; topics: TopicMaterialInput[] }[] {
  const sessions = Math.max(1, Math.floor(plan.sessionsPerMonth) || 1);
  const perSession = Math.max(1, Math.ceil((Math.max(0, plan.videosPerMonth) || sessions) / sessions));
  const required = topics
    .filter((t) => REQUIRED_TOPIC_STATUSES.has(t.status) || FILMED_TOPIC_STATUSES.has(t.status))
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.topicId.localeCompare(b.topicId));
  // The LAST session plans the remainder (A18): a month whose allowance is not
  // a multiple of its sessions (a staff override of 5 on Pro) is 3 + 2, not
  // 3 + 3 — the written gate shuts an under-planned session, so a second
  // session planned for a topic that can never exist would never open.
  const total = Math.max(0, Math.floor(plan.videosPerMonth) || 0);
  return Array.from({ length: sessions }, (_, i) => ({
    index: i + 1,
    plannedVideos: i === sessions - 1 && total > 0 ? Math.max(1, total - perSession * (sessions - 1)) : perSession,
    topics: i === sessions - 1 ? required.slice(i * perSession) : required.slice(i * perSession, (i + 1) * perSession),
  }));
}

// ---------------------------------------------------------------------------
// WHAT COUNTS AS A BOOKED SESSION (spec §3 / A23 / A24, Jordan Sep 21 2026).
//
// Jordan, in his own words: "Video Pro is two separate four-hour sessions. Book
// the existing four-hour Video Pro product in Aryeo twice. No new product is
// needed. The month is fully scheduled only when two distinct, confirmed
// sessions are linked to that client and month. One booking should still show
// one session remaining."
//
// Booking one product twice puts TWO APPOINTMENTS on ONE Aryeo order, and one
// Aryeo order is ONE Project here. Every place that answered "how many sessions
// does this month have" counted PROJECTS, so a Pro month with both of its
// sessions booked the way Jordan says to book them would have counted as one:
// the portal would have said one session remaining with nothing left to book,
// and the evaluator would have gone on chasing a session that was already on
// the calendar.
//
// That is not hypothetical arithmetic. Joe Sutow's 2026-07 content month
// carries ONE project with TWO live appointment legs (2026-07-24 14:30-18:30Z
// and 2026-07-27 19:00-20:00Z) and the project's own shootDate points at the
// SECOND one. Measured read-only across all 110 live content months on Sep 21
// 2026, that is the single month where project-counting and appointment-
// counting disagree today, and it is the exact shape a Pro month will take.
//
// So a session's identity is its APPOINTMENT. A project-level shoot date is the
// fallback ONLY for a project that carries no appointment row at all (3 of 65
// content-month projects, 1 of them with a shoot date). DISTINCTNESS is the
// whole point of the rule: an appointment is one session however many records
// point at it, so two requests that resolve to the same appointment are one
// session, not two.
//
// This function is PURE on purpose. There is exactly one Pro enrollment on the
// roster, it is PAUSED, and Aryeo has never carried a single Pro order, so the
// two-session path cannot be exercised from production data at all — the only
// way to hold it to account is to put a Pro month in front of a pure function.
// ---------------------------------------------------------------------------

/** A live Aryeo appointment on a content month's project. */
export type SessionAppointmentInput = {
  /** The stable provider id (Appointment.aryeoId), which is what a session request links to. */
  appointmentId: string;
  projectId: string;
  startAt: Date | null;
  endAt: Date | null;
  /** Aryeo status CANCELED, or the project itself cancelled. */
  cancelled: boolean;
};

/** A content-month project, for the no-appointment fallback only. */
export type SessionProjectInput = { projectId: string; shootDate: Date | null; addressLine?: string | null };

/** A ProgramSessionRequest that says a session exists (CONFIRMED), with whatever it links to. */
export type SessionRequestLinkInput = { requestId: string; projectId: string | null; appointmentId: string | null; slotStart: Date | null };

export type CountedSession = {
  /** The identity two records have to share to be ONE session. */
  key: string;
  source: "APPOINTMENT" | "PROJECT_SHOOT_DATE" | "CONFIRMED_REQUEST";
  projectId: string | null;
  appointmentId: string | null;
  /** The instant this session is anchored to: an appointment's END where there
   *  is one, because §9's production clock starts there. Never invented. */
  at: Date | null;
  /** When it STARTS — a different clock from `at`, and the one §8's
   *  missing-address reminder counts back 48 elapsed hours from. */
  startsAt: Date | null;
  /** In the past (with the same six-hour grace the evaluator has always used). */
  filmed: boolean;
  /** Every record that resolved to this one session — the evidence of distinctness. */
  evidence: string[];
  addressLine?: string | null;
};

export type BookedSessionCount = {
  sessions: CountedSession[];
  /** Sessions on the calendar that have not happened yet. */
  booked: number;
  /** Sessions that have. */
  filmed: number;
  accountedFor: number;
  /** Records that pointed at a session something else had already counted. */
  duplicatesFolded: number;
};

/** The grace the evaluator has always applied before calling a shoot "past". */
const FILMED_GRACE_MS = 6 * 3_600_000;

/**
 * The DISTINCT confirmed sessions linked to one client and one month.
 *
 * Order of authority: live appointments first (they are the provider's own
 * record of a booked session), then a project with a shoot date and no
 * appointment row, then a confirmed request that points at neither. A record
 * that resolves to a session already counted is folded into it and named in
 * `evidence` rather than dropped silently.
 *
 * An appointment with no start time is NOT a booked session. Jordan, Sep 21:
 * "Do not invent production dates — show Not scheduled for genuinely unbooked
 * work." An UNSCHEDULED leg is exactly that, and counting it would report a
 * month as fully scheduled on the strength of a row with no date in it.
 */
export function countDistinctSessions(input: {
  now: Date;
  appointments: SessionAppointmentInput[];
  projects: SessionProjectInput[];
  confirmedRequests: SessionRequestLinkInput[];
}): BookedSessionCount {
  const cutoff = input.now.getTime() - FILMED_GRACE_MS;
  const byKey = new Map<string, CountedSession>();
  const projectsWithAppointments = new Set<string>();
  /** The counted appointment sessions of each project, in the order they were counted. */
  const apptKeysByProject = new Map<string, string[]>();
  /** Appointment sessions a confirmed request has already been resolved to. */
  const claimedByRequest = new Set<string>();
  let duplicatesFolded = 0;

  const fold = (key: string, make: () => CountedSession, evidence: string) => {
    const existing = byKey.get(key);
    if (existing) { existing.evidence.push(evidence); duplicatesFolded++; return; }
    byKey.set(key, { ...make(), evidence: [evidence] });
  };

  for (const a of input.appointments) {
    if (a.cancelled) continue;
    // No start time = not scheduled. See the doc comment: a dateless leg must
    // never make a month read as fully booked.
    if (!a.startAt) continue;
    projectsWithAppointments.add(a.projectId);
    const at = a.endAt ?? a.startAt;
    const key = `appt:${a.appointmentId}`;
    if (!byKey.has(key)) apptKeysByProject.set(a.projectId, [...(apptKeysByProject.get(a.projectId) ?? []), key]);
    fold(key, () => ({
      key, source: "APPOINTMENT", projectId: a.projectId, appointmentId: a.appointmentId,
      at, startsAt: a.startAt, filmed: at.getTime() < cutoff, evidence: [],
    }), `appointment ${a.appointmentId}`);
  }

  for (const p of input.projects) {
    if (!p.shootDate) continue;
    // A project whose legs we already have is not an extra session on top of
    // them. This is the line that keeps Joe Sutow's July at two legs rather
    // than three.
    if (projectsWithAppointments.has(p.projectId)) continue;
    fold(`project:${p.projectId}`, () => ({
      key: `project:${p.projectId}`, source: "PROJECT_SHOOT_DATE", projectId: p.projectId, appointmentId: null,
      at: p.shootDate, startsAt: p.shootDate, filmed: p.shootDate!.getTime() < cutoff, evidence: [], addressLine: p.addressLine ?? null,
    }), `project ${p.projectId} shoot date`);
  }

  // REQUESTS THAT NAME THEIR APPOINTMENT GO FIRST (review, Sep 21 2026). The
  // loop below resolves a request that names only a project onto one of that
  // project's appointment sessions, so an explicit link has to claim its own
  // appointment before a vaguer row can take it.
  for (const r of [...input.confirmedRequests.filter((x) => x.appointmentId), ...input.confirmedRequests.filter((x) => !x.appointmentId)]) {
    // The request's own links decide which session it IS. Two requests that
    // resolve to the same appointment are one session (§8: "prevent double
    // bookings and duplicate Pro sessions under simultaneous requests").
    //
    // A REQUEST CARRYING ONLY A PROJECT ID IS NOT AN EXTRA SESSION ON TOP OF
    // THAT PROJECT'S APPOINTMENTS (review, Sep 21 2026). It used to key on
    // `project:<id>` unconditionally, and the project loop above deliberately
    // skips a project whose legs it already has — so nothing held that key, the
    // request minted a second session, and ONE booking counted as two. That is
    // Jordan's clarification 1 inverted: a Pro month would have read as fully
    // scheduled on a single booking and the second session would never have
    // been chased. `confirmSessionRequest(requestId, { projectId }, by)`
    // (sessionRequests.ts) writes exactly this shape — `aryeoAppointmentId` is
    // optional and is filled in later, if ever, by the Aryeo sync.
    //
    // So it resolves onto the project's first unclaimed appointment session,
    // one for one. Only when a project carries MORE confirmed requests than it
    // has counted appointments does the surplus stand as a session of its own:
    // that is a slot the office confirmed and the provider has not synced back
    // yet, and folding it away would put us back to chasing a booked session.
    const freeApptKey = !r.appointmentId && r.projectId
      ? (apptKeysByProject.get(r.projectId) ?? []).find((k) => !claimedByRequest.has(k)) ?? null
      : null;
    const key = r.appointmentId
      ? `appt:${r.appointmentId}`
      : freeApptKey
        ? freeApptKey
        : r.projectId && !projectsWithAppointments.has(r.projectId)
          ? `project:${r.projectId}`
          : `request:${r.requestId}`;
    if (key.startsWith("appt:")) claimedByRequest.add(key);
    fold(key, () => ({
      key, source: "CONFIRMED_REQUEST", projectId: r.projectId, appointmentId: r.appointmentId,
      at: r.slotStart, startsAt: r.slotStart, filmed: !!r.slotStart && r.slotStart.getTime() < cutoff, evidence: [],
    }), `confirmed request ${r.requestId}`);
  }

  const sessions = [...byKey.values()].sort((a, b) => (a.at?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.at?.getTime() ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
  const filmed = sessions.filter((s) => s.filmed).length;
  return { sessions, booked: sessions.length - filmed, filmed, accountedFor: sessions.length, duplicatesFolded };
}

/**
 * Jordan's completeness rule, stated once: a month is fully scheduled ONLY when
 * every session the package owes is a DISTINCT confirmed session. One booking on
 * a Pro month leaves one remaining, everywhere.
 */
export function sessionShortfall(required: number, count: BookedSessionCount): { required: number; accountedFor: number; missing: number; fullyScheduled: boolean } {
  const req = Math.max(1, Math.floor(required) || 1);
  const missing = Math.max(0, req - count.accountedFor);
  return { required: req, accountedFor: count.accountedFor, missing, fullyScheduled: missing === 0 };
}

/**
 * A pending MOVE takes the place of the session it moves, not a second place
 * (review of CP-04, Sep 24 2026). The replacement of a booked session is a
 * REQUESTED row whose supersedesId points at the booked row, now
 * RESCHEDULE_REQUESTED — and that booked row (or its appointment) is already
 * counted. Counting the replacement as well showed a Pro client with one
 * session and one pending move as fully booked, and refused their second
 * session. The ONE rule for every pending-ask count (sessionCapacity,
 * monthProgress, the reminder evaluator); `requests` is the month's rows.
 */
export function replacesPendingMove(r: { status: string; supersedesId?: string | null }, requests: { id: string; status: string }[]): boolean {
  return r.status === "REQUESTED" && !!r.supersedesId && requests.some((x) => x.id === r.supersedesId && x.status === "RESCHEDULE_REQUESTED");
}

export type DeriveInput = {
  now: Date;
  month: {
    strategyCallStatus: string;
    strategyCallAt: Date | null;
    transcriptText: string | null;
    planningMode: string | null;
    preparationStatus: string | null;
    preparationCompletedAt: Date | null;
    preparationWindowDays: number | null;
    preparationExceptionAt: Date | null;
    preparationExceptionReason: string | null;
    filmingReadyAt: Date | null;
    historical: boolean;
  };
  /** `priorCallHeld`: a monthly strategy call was held in another month of this
   *  enrollment (effectiveCallMode). Optional — a caller that does not know
   *  (the read-only overview) gets the legacy reading, never a guess. */
  enrollment: {
    callMode: string | null; strategyCallRequired: boolean; noCallEligible: boolean | null; priorCallHeld?: boolean;
    /** The enrollment's window override in weekday hours (enrollmentWindowOverrideHours), when an owner set one. */
    preparationWindowHours?: number | null;
  };
  records: MonthCallRecordInput[];
  /**
   * Scripts on the month, INCLUDING historical imports. An import from Jordan's archive is
   * work that was written and sent outside the hub, so for the MONTH it means preparation is
   * done — even though the script itself is never re-labelled approved/released (Jordan's rule).
   * Without this, every archive-backed month read "preparing scripts" forever and the overview
   * would list it as work we owe (found on Joe Sutow's August: 4 imported scripts, 1 shoot).
   * `approvedAt` dates the filming-ready stamp.
   */
  scripts: { status: string; approvedVersionId: string | null; approvedAt?: Date | null; historical?: boolean }[];
  /** Interviews on the month (the written path). */
  interviews: { status: string; submittedAt: Date | null; topicId?: string | null }[];
  /**
   * The package shape for this month. OPTIONAL so the read-only overview screen
   * that builds its own input keeps compiling; when it is absent the derivation
   * falls back to the month-wide reading described on `sessionsKnown`.
   */
  plan?: { videosPerMonth: number; sessionsPerMonth: number } | null;
  /** The month's topics with the material each one carries. Optional, same reason. */
  topics?: TopicMaterialInput[] | null;
  /**
   * The month's DISTINCT confirmed sessions, from countDistinctSessions (A23,
   * Sep 21 2026). Optional for the same reason as `plan`: the read-only overview
   * screen builds its own input. When it is absent `bookingKnown` is false and
   * the scheduling counts below say nothing at all, rather than reporting zero
   * sessions booked — "we did not look" and "nothing is booked" are different
   * answers and only one of them may reach a client.
   */
  booking?: BookedSessionCount | null;
};

export type DerivedMonthState = {
  callMode: CallMode;
  strategyCallStatus: StrategyCallStatus;
  strategyCallAt: Date | null;
  planningMode: PlanningMode;
  preparationStatus: PreparationStatus | null;
  preparationCompletedAt: Date | null;
  filmingReadyAt: Date | null;
  /** The earliest a content session may start, or null while preparation has not begun.
   *  With two sessions this is the EARLIEST open one: a Pro client's first
   *  session must not wait on the second session's material (spec §8). */
  earliestSessionAt: Date | null;
  /** Per-session readiness — one entry per session the package plans. */
  sessions: SessionReadiness[];
  /** False when the caller supplied no topics/plan, so the month-wide fallback was used. */
  sessionsKnown: boolean;
  // ---- SCHEDULING COMPLETENESS (A23, Jordan Sep 21 2026) --------------------
  // Jordan: "The month is fully scheduled only when two distinct, confirmed
  // sessions are linked to that client and month. One booking should still show
  // one session remaining." These are the month's answer to that, counted from
  // APPOINTMENTS rather than projects — see countDistinctSessions.
  /** What the package owes this month: Starter 1, Accelerator 1, Pro 2. */
  sessionsRequired: number;
  /** Distinct confirmed sessions linked to this client and month. */
  sessionsAccountedFor: number;
  sessionsBooked: number;
  sessionsFilmed: number;
  sessionsMissing: number;
  /** Every owed session is a distinct confirmed session. */
  fullyScheduled: boolean;
  /** False when no booking evidence was supplied, so the four counts above are
   *  not an observation. Never render "0 booked" off a false one. */
  bookingKnown: boolean;
  /** At least one session's material is complete right now. Re-derived every
   *  pass, so a month whose answers go unfinished again closes again. */
  preparationSufficient: boolean;
  /** The end of the SAME call `strategyCallAt` names — the instant the
   *  preparation clock is measured from (spec §8). Null when no call record
   *  backs the status (legacy pasted transcripts, hand-set SKIPPED). Exposed
   *  Sep 21 2026 for F04: the portal's "booked but not yet held" branch has to
   *  estimate from the same base the real gate will use once the call is held,
   *  or its estimate reads EARLIER than the answer the client will actually get. */
  strategyCallEndsAt: Date | null;
  /** A19: when the month's anchoring call (held, else booked) arrived as a record —
   *  the moment a booked call opened filming. Null for a legacy stamp. */
  callBookedAt: Date | null;
  /** The preparation window in hours of weekday time. */
  windowHours: number;
  windowWaived: boolean;
  reasons: string[];
  /** Conflicting evidence a person has to settle — never resolved by guessing. */
  exceptions: string[];
  /** Chasing work with an owner. Computed only; nothing here sends anything. */
  followUps: PreparationFollowUp[];
};

const HELD = (r: MonthCallRecordInput, now: Date) =>
  r.status === "COMPLETED" ||
  r.transcriptState === "CONFIRMED" || r.transcriptState === "ANALYZED" ||
  (r.status === "SCHEDULED" && !!(r.scheduledEnd ?? r.scheduledStart) && (r.scheduledEnd ?? r.scheduledStart)! < now);

/**
 * Has this enrollment held a monthly strategy call in ANOTHER month? The input
 * to effectiveCallMode. A record counts when a verified identity put it on the
 * program (MATCHED / CONFIRMED_BY_STAFF) and it was held by the same test the
 * month derivation uses; a legacy month stamped COMPLETED (a pasted
 * transcript, the old sweep) counts too. Pure — the caller reads the rows.
 */
export function priorCallHeldFrom(
  monthId: string,
  records: (MonthCallRecordInput & { monthId: string | null })[],
  completedMonthIds: readonly string[],
  now: Date,
): boolean {
  if (completedMonthIds.some((id) => id !== monthId)) return true;
  return records.some((r) => r.monthId !== monthId && r.callType === "MONTHLY_STRATEGY" &&
    (r.matchState === "MATCHED" || r.matchState === "CONFIRMED_BY_STAFF") &&
    r.status !== "CANCELLED" && r.status !== "RESCHEDULED" && HELD(r, now));
}

export function deriveMonthState(input: DeriveInput): DerivedMonthState {
  const { now, month, enrollment } = input;
  const reasons: string[] = [];
  const exceptions: string[] = [];
  const followUps: PreparationFollowUp[] = [];
  const callMode = effectiveCallMode(enrollment, { priorProgramCallHeld: !!enrollment.priorCallHeld });
  if (callMode !== callModeOf(enrollment)) reasons.push("the first monthly call has been held — later months may be planned in writing (§3)");

  // Only records that a mapping classified as the MONTHLY call and that a
  // verified identity put on this month. Discovery calls, unrelated calls,
  // cancelled and superseded bookings never count. AMBIGUOUS_CLIENT is
  // included on purpose: a record only ever reaches a month through a
  // verified identity, and one whose address later stopped resolving keeps
  // that identity for a person to re-check — the month must not fall back to
  // NOT_SCHEDULED (and mint a booking-link draft) while the call is on file.
  const live = input.records.filter(
    (r) => r.callType === "MONTHLY_STRATEGY" &&
      (r.matchState === "MATCHED" || r.matchState === "CONFIRMED_BY_STAFF" || r.matchState === "AMBIGUOUS_CLIENT") &&
      r.status !== "CANCELLED" && r.status !== "RESCHEDULED",
  );
  // Evidence that contradicts itself is an EXCEPTION, not a tie to break (spec
  // §8: "If transcript evidence conflicts with attendance, surface an exception
  // rather than guessing"). Two shapes, both of which the old HELD() silently
  // resolved in favour of "the call happened" and opened the filming window on:
  //   · attendance says NO_SHOW while a transcript was confirmed or analysed;
  //   · the row says COMPLETED for a call that has not started yet, which is
  //     the "do not treat a future booked call as completed" rule read from the
  //     other direction — a status somebody set early, not a held call.
  // Neither counts as held until a person settles it. Production carries none
  // of either today (read-only check, Sep 21: 3 monthly records, all COMPLETED,
  // all in the past), so nothing live closes because of this.
  const conflicted = new Set(
    live.filter((r) => {
      const start = r.scheduledStart ?? r.scheduledEnd;
      if (r.status === "NO_SHOW" && (r.transcriptState === "CONFIRMED" || r.transcriptState === "ANALYZED")) {
        exceptions.push("attendance says the client did not show, but a transcript for this call was confirmed — a person has to settle which is right");
        return true;
      }
      if (r.status === "COMPLETED" && start && start > now) {
        exceptions.push("this call is marked completed but is still in the future — the filming window stays shut until that is corrected");
        return true;
      }
      return false;
    }),
  );
  const held = live.filter((r) => !conflicted.has(r) && HELD(r, now)).sort((a, b) => (b.scheduledStart?.getTime() ?? 0) - (a.scheduledStart?.getTime() ?? 0));
  /** Monthly call RECORDS own this month (live or not): its stored call status is theirs, not a legacy stamp's. */
  const recordsOwnMonth = input.records.some((r) => r.callType === "MONTHLY_STRATEGY");
  const upcoming = live.filter((r) => !HELD(r, now) && r.status === "SCHEDULED").sort((a, b) => (a.scheduledStart?.getTime() ?? 0) - (b.scheduledStart?.getTime() ?? 0));

  const stored = month.strategyCallStatus as StrategyCallStatus;
  let strategyCallStatus: StrategyCallStatus;
  let strategyCallAt: Date | null = month.strategyCallAt;
  // The END of that same call. Only a real record carries one, so legacy truth
  // (a pasted transcript, a hand-set SKIPPED) leaves it null and every reader
  // falls back to the start. See `strategyCallEndsAt` on DerivedMonthState.
  let strategyCallEndsAt: Date | null = null;
  if (held.length > 0) {
    strategyCallStatus = "COMPLETED";
    strategyCallAt = held[0].scheduledStart ?? strategyCallAt;
    strategyCallEndsAt = held[0].scheduledEnd ?? held[0].scheduledStart ?? null;
    reasons.push(`${held.length} monthly call(s) held on record`);
  } else if (upcoming.length > 0) {
    // A transcript on file (legacy paste/sweep) outranks a later booking.
    strategyCallStatus = stored === "COMPLETED" && month.transcriptText ? "COMPLETED" : "SCHEDULED";
    if (strategyCallStatus === "SCHEDULED") {
      strategyCallAt = upcoming[0].scheduledStart ?? strategyCallAt;
      strategyCallEndsAt = upcoming[0].scheduledEnd ?? upcoming[0].scheduledStart ?? null;
    }
    reasons.push("a monthly call is booked");
  } else if (
    stored === "SKIPPED" ||
    (stored === "COMPLETED" && (!!month.transcriptText || !recordsOwnMonth || conflicted.size > 0)) ||
    (stored === "SCHEDULED" && !recordsOwnMonth)
  ) {
    // Legacy truth (pasted transcript, old sweep's stamp, hand-set skip):
    // preserved. The legacy sweep still owns SCHEDULED→NOT_SCHEDULED on a
    // cancellation until a mapping hands over to call records.
    // W03 (Sep 25 2026): a stored SCHEDULED is legacy truth only while the
    // month has no monthly call RECORD. Once records own the month, SCHEDULED
    // with none of them live means the booking was cancelled or moved — kept,
    // it held filming open (measured from the dead call) after a client
    // cancelled on Calendly's page.
    // …and the same for a stored COMPLETED (batch-3 review, Sep 25 2026): a
    // record held → COMPLETED was persisted, then the record died (cancelled
    // after the fact, a no-show). With no transcript pasted on the month, the
    // stamp was that record's, not legacy truth — kept, it opened filming 72
    // weekday hours after a call this client never had. (Evidence that
    // contradicts itself keeps what is stored: a person settles it, and the
    // gate stays shut meanwhile — no legacy anchor below.)
    strategyCallStatus = stored;
    reasons.push(`kept ${stored} (set before call records existed)`);
  } else if (month.planningMode === "WRITTEN") {
    strategyCallStatus = "SKIPPED";
    reasons.push("client chose to plan without a call");
  } else if (callMode === "NOT_INCLUDED") {
    strategyCallStatus = "NOT_REQUIRED";
    if (stored !== "NOT_REQUIRED") reasons.push("call mode NOT_INCLUDED → NOT_REQUIRED (by rule)");
  } else {
    strategyCallStatus = "NOT_SCHEDULED";
    if (stored === "NOT_REQUIRED") reasons.push("call mode requires a call → NOT_SCHEDULED (by rule)");
  }

  // Planning mode: explicit choice first, then the call mode's default.
  let planningMode: PlanningMode;
  if (month.planningMode === "WRITTEN" || month.planningMode === "CALL") planningMode = month.planningMode;
  else if (held.length > 0 || upcoming.length > 0 || callMode === "REQUIRED") planningMode = "CALL";
  else if (callMode === "NOT_INCLUDED") planningMode = "WRITTEN";
  else if (stored === "COMPLETED" && month.transcriptText) planningMode = "CALL";
  else planningMode = "UNDECIDED";

  // Preparation — the client-visible truth about where the month is.
  const scripts = input.scripts;
  const approved = scripts.filter((s) => s.historical === true || s.status === "APPROVED" || s.status === "CLIENT_VISIBLE" || s.status === "READY_TO_FILM" || !!s.approvedVersionId);
  const scriptsDone = scripts.length > 0 && approved.length === scripts.length;
  const callHeld = strategyCallStatus === "COMPLETED";

  const windowHours = preparationWindowHours(month.preparationWindowDays, enrollment.preparationWindowHours ?? null);
  if ((month.preparationWindowDays == null || month.preparationWindowDays <= 0) && (enrollment.preparationWindowHours ?? 0) > 0) {
    reasons.push(`this client's preparation window is ${windowHours} weekday hours (owner override)`);
  }
  const windowWaived = !!month.preparationExceptionAt && !!month.preparationExceptionReason;
  if (windowWaived) reasons.push(`window waived: ${month.preparationExceptionReason}`);
  const afterWindow = (base: Date): Date => earliestFilmingStart(base, { windowHours, windowWaived });

  // THE CALL ANCHOR (A19, Sep 25 2026): the held call, else the BOOKED one.
  // The clock starts when that call is due to END (spec §8). scheduledEnd is
  // what every monthly record in production carries; scheduledStart is the
  // fallback only for a record without one, with the reason said.
  //
  // This used to be `heldCall ? strategyCallEndsAt : null` — the derivation
  // opened the call route only once the call was HELD, and the portal ran a
  // second "booked, not yet held" branch of its own. §3: filming opens "as
  // soon as the strategy call is booked, even before the call happens". The
  // reminder's quoted date and the staff overview read the derivation, so on
  // every booked-but-future call they said "not yet" while the portal said
  // "from Thursday". One anchor now, read by everyone.
  const callAnchorOf = (r: MonthCallRecordInput): GateAnchor | null => {
    const at = r.scheduledEnd ?? r.scheduledStart;
    if (!at) return null;
    return {
      kind: "CALL_END", at, ref: `CALL_END:${r.id ?? "record"}:${at.getTime()}`,
      label: r.scheduledEnd ? "the strategy call's scheduled end" : "the strategy call's start (no end time on record)",
      estimated: !r.scheduledEnd,
    };
  };
  const anchorCall = held[0] ?? upcoming[0] ?? null;
  let callAnchor: GateAnchor | null = anchorCall ? callAnchorOf(anchorCall) : null;
  if (anchorCall && !anchorCall.scheduledEnd && anchorCall.scheduledStart) {
    reasons.push("this call has no end time on record — the window is measured from when it was due to start");
  }
  // THE LEGACY STAMP (6.6, Sep 25 2026). A month the old Drive sweep (or a
  // button) stamped SCHEDULED/COMPLETED has a start time and no call record —
  // so no end — and with the held-only reading above it could NEVER open
  // filming: a COMPLETED legacy month read "we're still preparing this month"
  // for good. It is measured from the stamped start instead, says so, and asks
  // Kyle to confirm the call's end (CONFIRM_CALL_END below). Retires once
  // every portal booking arrives as a call record (W03).
  let legacyCallStamp = false;
  // Only a stamp that IS legacy truth (batch-3 review): a month no call
  // record owns, or a held call whose transcript was pasted on the month. A
  // record's own time, once that record is dead, is not a stamp to measure
  // from — and evidence that contradicts itself keeps the gate shut.
  const legacyTruth = !recordsOwnMonth || (strategyCallStatus === "COMPLETED" && !!month.transcriptText && conflicted.size === 0);
  if (!callAnchor && !anchorCall && legacyTruth && (strategyCallStatus === "SCHEDULED" || strategyCallStatus === "COMPLETED") && month.strategyCallAt) {
    const at = month.strategyCallAt;
    callAnchor = { kind: "CALL_END", at, ref: `CALL_END:legacy:${at.getTime()}`, label: "the call's start (no call record, so no end time)", estimated: true };
    legacyCallStamp = true;
    if (planningMode === "CALL") reasons.push("no call record for this month — the preparation window is measured from the call's start");
  }
  /** Why a session on the call route is shut, when no call anchors it. */
  const callLock: GateLock = strategyCallStatus === "NOT_SCHEDULED" ? "BOOK_CALL" : "PREPARING";

  // ---- per-session material -------------------------------------------------
  const topics = input.topics ?? null;
  const plan = input.plan ?? null;
  const sessionsKnown = !!topics && !!plan;
  const byTopic = new Map<string, { status: string; submittedAt: Date | null }>();
  for (const i of input.interviews) if (i.topicId) byTopic.set(i.topicId, { status: i.status, submittedAt: i.submittedAt });

  const sessions: SessionReadiness[] = [];
  if (sessionsKnown && topics && plan) {
    for (const s of planSessions(topics, plan)) {
      const notes: string[] = [];
      const ready = s.topics.filter(topicMaterialReady);
      const missing = s.topics.filter((t) => !topicMaterialReady(t));
      // A session with no planned topic has nothing to be sufficient ABOUT. It
      // is not "ready"; it is unplanned, and that is Kyle's follow-up.
      const sufficient = s.topics.length > 0 && missing.length === 0;
      for (const t of s.topics) {
        const iv = byTopic.get(t.topicId);
        if (iv && iv.submittedAt && iv.status !== "SUBMITTED") {
          notes.push(`"${t.title ?? t.topicId}" was submitted and then reopened`);
          followUps.push({ kind: "ANSWERS_REOPENED", owner: "KYLE", sessionIndex: s.index, reason: `Answers for "${t.title ?? t.topicId}" were reopened after being submitted — session ${s.index} is on hold until they are finished again.` });
        }
      }
      const times = s.topics.map(topicMaterialReadyAt).filter((d): d is Date => d != null);
      // The last piece to land dates the session; a sufficient session whose
      // material carries no timestamp at all (legacy imports) falls back to the
      // month's stored stamp rather than to `now`, which would restart the
      // clock on every recalculation.
      const materialReadyAt = sufficient
        ? (times.length === s.topics.length ? times.reduce((a, b) => (a >= b ? a : b)) : (times.length > 0 ? times.reduce((a, b) => (a >= b ? a : b)) : month.preparationCompletedAt))
        : null;
      if (sufficient && times.length < s.topics.length) notes.push("some of this session's material has no timestamp on record");
      if (s.topics.length > 0 && s.topics.length < s.plannedVideos) {
        notes.push(`${s.topics.length} of ${s.plannedVideos} planned videos have a topic`);
        followUps.push({ kind: "UNDER_PLANNED_SESSION", owner: "KYLE", sessionIndex: s.index, reason: `Session ${s.index} has ${s.topics.length} of ${s.plannedVideos} topics chosen.` });
      }
      if (!sufficient && missing.length > 0) {
        followUps.push({ kind: "UNFINISHED_ANSWERS", owner: "KYLE", sessionIndex: s.index, reason: `Session ${s.index} still needs material for ${missing.length} of ${s.topics.length} topics.` });
      }
      // The CALL path is gated by the call, not by the answers: §8 says missing
      // post-call information triggers follow-up and an internal warning and
      // does NOT restart (or withhold) the clock — and §6.4 says do not wait
      // for the call, the transcript or the topics either: the booked call is
      // the anchor for every session of the month.
      //
      // The WRITTEN path is gated per session, every pass (which is what closes
      // a month again when its answers go unfinished), and since A18 (Sep 25
      // 2026) on the WHOLE session: "Filming scheduling opens after topics are
      // selected and completed answers are submitted" (§3), and §6.4's written
      // route begins by selecting the allowance. Two of four topics answered
      // used to open an Accelerator session with only a Kyle follow-up; it now
      // stays shut until all four are chosen and their answers are in.
      let anchor: GateAnchor | null = null;
      let lock: GateLock | null = null;
      if (planningMode === "CALL") {
        anchor = callAnchor;
        if (!anchor) lock = callLock;
      } else if (s.topics.length === 0 || s.topics.length < s.plannedVideos) {
        lock = planningMode === "UNDECIDED" ? "CHOOSE_ROUTE" : "UNDER_PLANNED";
      } else if (!sufficient || !materialReadyAt) {
        lock = planningMode === "UNDECIDED" ? "CHOOSE_ROUTE" : sufficient ? "PREPARING" : "ANSWERS";
      } else {
        // The last piece of material to land names the anchor, so answers sent
        // again (a reopen and resubmit) are a different anchor.
        const last = s.topics.reduce<TopicMaterialInput | null>((a, t) => {
          const at = topicMaterialReadyAt(t);
          return at && (!a || at > (topicMaterialReadyAt(a) ?? new Date(0))) ? t : a;
        }, null);
        anchor = {
          kind: "SUBMISSION", at: materialReadyAt,
          ref: `SUBMISSION:${last?.topicId ?? "month"}:${materialReadyAt.getTime()}`,
          label: "when the session's answers were submitted",
          estimated: times.length < s.topics.length,
        };
      }
      sessions.push({
        index: s.index, plannedVideos: s.plannedVideos,
        topicIds: s.topics.map((t) => t.topicId),
        readyTopicIds: ready.map((t) => t.topicId),
        missingTopicIds: missing.map((t) => t.topicId),
        sufficient, materialReadyAt,
        earliestSessionAt: anchor ? afterWindow(anchor.at) : null,
        anchor, lock,
        notes,
      });
    }
  } else {
    // LEGACY READING — a caller that supplied no topics or package (today: the
    // read-only programOverview screen). One month-wide session, and the month
    // counts as prepared only when EVERY interview on it is submitted. That is
    // already stricter than the "any submitted" test this replaces, and it is
    // the most that can be said without knowing which topics were selected.
    const ivs = input.interviews;
    const allSubmitted = ivs.length > 0 && ivs.every((i) => i.status === "SUBMITTED");
    const times = ivs.map((i) => i.submittedAt).filter((d): d is Date => d != null);
    const materialReadyAt = allSubmitted
      ? (times.length > 0 ? times.reduce((a, b) => (a >= b ? a : b)) : month.preparationCompletedAt)
      : (ivs.length === 0 ? month.preparationCompletedAt : null);
    const sufficient = allSubmitted || (ivs.length === 0 && !!month.preparationCompletedAt);
    const anchor: GateAnchor | null = planningMode === "CALL"
      ? callAnchor
      : sufficient && materialReadyAt
        ? { kind: "SUBMISSION", at: materialReadyAt, ref: `SUBMISSION:month:${materialReadyAt.getTime()}`, label: "when the month's answers were submitted", estimated: times.length === 0 }
        : null;
    const lock: GateLock | null = anchor ? null : planningMode === "CALL" ? callLock : planningMode === "UNDECIDED" ? "CHOOSE_ROUTE" : "ANSWERS";
    sessions.push({
      index: 1, plannedVideos: 0, topicIds: [], readyTopicIds: [], missingTopicIds: [],
      sufficient, materialReadyAt,
      earliestSessionAt: anchor ? afterWindow(anchor.at) : null,
      anchor, lock,
      notes: ["session split unknown — the caller supplied no topics or package"],
    });
  }

  // ---- the written route's call buffer (§6.4, Sep 25 2026) ------------------
  // "The written route can still offer a strategy call to discuss scripts.
  // Preserve the agreed call buffer when it is used and surface any conflict
  // with an existing shoot. Do not silently move bookings." An explicit WRITTEN
  // choice keeps the route when a call is booked, and the gate read material
  // time only — so a call booked the day before a shoot, to talk the scripts
  // through, left the shoot inside the buffer and nobody was told.
  //   (a) NEW offers start no earlier than the call's end plus the window;
  //   (b) a booked, unfilmed session inside that buffer is an EXCEPTION with a
  //       follow-up for Kyle. The booking is never moved or cancelled here.
  const booking = input.booking ?? null;
  if (planningMode === "WRITTEN") {
    const calls = [...held, ...upcoming].filter((r) => !conflicted.has(r) && (r.scheduledEnd ?? r.scheduledStart));
    const latest = calls.reduce<MonthCallRecordInput | null>((a, r) => (!a || (r.scheduledEnd ?? r.scheduledStart)! > (a.scheduledEnd ?? a.scheduledStart)! ? r : a), null);
    if (latest) {
      const callEnd = (latest.scheduledEnd ?? latest.scheduledStart)!;
      const callStart = latest.scheduledStart ?? callEnd;
      const buffer = afterWindow(callEnd);
      // earliest = max(submission, call end) + the window (A18) — and the
      // anchor says which one it was, so a reassessment follows the call.
      for (const s of sessions) if (s.earliestSessionAt && s.earliestSessionAt < buffer) { s.earliestSessionAt = buffer; s.anchor = callAnchorOf(latest); }
      for (const b of booking?.sessions ?? []) {
        if (b.filmed || !b.startsAt || b.startsAt < callStart || b.startsAt >= buffer) continue;
        const day = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        exceptions.push(`a strategy call ending ${day(callEnd)} ET falls inside the ${windowHours}-hour buffer before the ${day(b.startsAt)} ET session — confirm with the client`);
        followUps.push({ kind: "CALL_INSIDE_BUFFER", owner: "KYLE", sessionIndex: null, ref: `${b.startsAt.getTime()}-${callEnd.getTime()}`, reason: `A strategy call (ends ${day(callEnd)} ET) was booked inside the preparation buffer before the ${day(b.startsAt)} ET filming session. Confirm with the client whether the session stays — nothing has been moved.` });
      }
    }
  }

  // A Pro month's FIRST session must not wait on the second session's material,
  // so the month-wide answer is the earliest OPEN session, not the last one.
  const openAts = sessions.map((s) => s.earliestSessionAt).filter((d): d is Date => d != null);
  const earliestSessionAt = openAts.length > 0 ? openAts.reduce((a, b) => (a <= b ? a : b)) : null;
  const preparationSufficient = sessions.some((s) => s.sufficient);

  // ---- scheduling completeness (A23) ----------------------------------------
  // The count is the caller's to supply because it needs appointment rows; the
  // RULE lives here, once, so the portal's capacity, the reminder evaluator and
  // anything that later asks "is this month fully scheduled?" cannot drift apart
  // the way the two readings of the preparation window did in F04.
  const sessionsRequired = Math.max(1, Math.floor(plan?.sessionsPerMonth ?? 1) || 1);
  const bookingKnown = !!booking;
  const shortfall = booking ? sessionShortfall(sessionsRequired, booking) : null;
  if (booking && booking.duplicatesFolded > 0) {
    reasons.push(`${booking.duplicatesFolded} record(s) pointed at a session another record had already counted — folded into one session each`);
  }
  if (booking && shortfall && shortfall.accountedFor > sessionsRequired) {
    exceptions.push(`${shortfall.accountedFor} distinct filming sessions are linked to this month but the package owes ${sessionsRequired} — a person should say whether that is an approved extra`);
  }
  // A legacy-stamped call opens the calendar from its START (see the legacy
  // stamp above). Kyle confirms the real end only while it can still matter:
  // the call route, a session still to book, and the start-based earliest not
  // yet passed. A past August month raises nothing.
  if (legacyCallStamp && planningMode === "CALL" && callAnchor && !(shortfall?.fullyScheduled) && afterWindow(callAnchor.at) > now) {
    const when = callAnchor.at.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    followUps.push({
      kind: "CONFIRM_CALL_END", owner: "KYLE", sessionIndex: null, ref: String(callAnchor.at.getTime()),
      reason: `This month's strategy call (${when} ET) has no call record, so filming is measured from its start. Confirm when the call ends (add it as a call record) so the ${windowHours} weekday hours run from the end.`,
    });
  }

  // The month's completion stamp is HISTORY — the moment material first became
  // complete — and it is no longer what opens the gate. Before Sep 21 2026 it
  // was both, so a month whose answers were reopened kept a stored stamp and
  // kept filming unlocked on material that no longer existed. Retired, not
  // deleted: the stamp is still reported and still persisted, the gate just
  // asks the sessions instead.
  const derivedCompletedAt = sessions.map((s) => s.materialReadyAt).filter((d): d is Date => d != null).reduce<Date | null>((m, d) => (!m || d > m ? d : m), null);
  const preparationCompletedAt = month.preparationCompletedAt ?? (planningMode === "WRITTEN" ? derivedCompletedAt : null);

  let preparationStatus: PreparationStatus | null = null;
  const afterPrep = (): PreparationStatus =>
    scripts.length === 0 ? "PREPARING_SCRIPTS" : scriptsDone ? "READY_FOR_FILMING" : "AWAITING_SCRIPT_APPROVAL";
  // Scripts on the month are proof that planning happened — by a call the old
  // Calendly sweep never stamped (0 of 734 runs matched the generic slug), by a
  // written path, or by an archive import. They outrank a missing call stamp so a
  // finished month (Marcee's August: 9 scripts, one shoot) never reads "book your
  // strategy call". The call STATUS itself is left alone: we do not invent a call.
  if (planningMode === "CALL") preparationStatus = callHeld || scripts.length > 0 ? afterPrep() : "CALL_PLANNED";
  else if (planningMode === "WRITTEN") {
    if (preparationSufficient) preparationStatus = afterPrep();
    else preparationStatus = input.interviews.length > 0 ? "AWAITING_ANSWERS" : "WRITTEN_SELECTED";
  } else if (scripts.length > 0) {
    // UNDECIDED (§3, Sep 25 2026: a month after the first held call may go
    // either way). The same rule the CALL branch keeps: scripts on the month
    // are proof it was planned, so a month whose route nobody picked but whose
    // scripts exist is never sent back to "choose how to plan".
    preparationStatus = afterPrep();
  }

  // Missing post-call information: a warning and a chase, never a closed gate
  // and never a restarted clock (spec §8).
  if (planningMode === "CALL" && callHeld && !preparationSufficient) {
    const gaps = sessions.filter((s) => !s.sufficient).map((s) => s.index);
    followUps.push({
      kind: "MISSING_POST_CALL_INFO", owner: "KYLE", sessionIndex: gaps[0] ?? null,
      reason: `The call was held but ${sessionsKnown ? `session ${gaps.join(" and ")} still ${gaps.length > 1 ? "need" : "needs"} material` : "the month's answers are not all in"}. Filming stays on for the booked time.`,
    });
    reasons.push("call held — material is still missing, which is a follow-up and does not move the filming window");
  }

  // The filming-ready stamp is the moment the LAST script was approved — a
  // real event with a real time — never "now" because a recalculation happened
  // to run (that would date six August months to the day the derivation
  // shipped, and §24 reminders key off this column). A stored stamp wins; a
  // derived READY_FOR_FILMING with no approval time on any script stays null.
  // A call whose transcript is stuck (NEEDS_REVIEW / FAILED) does not change
  // the preparation status — that is driven by approved SCRIPTS, and a person
  // approved those — but the derivation must say so rather than stay silent,
  // because §4 gating and §24 reminders read this record and the transcript is
  // the one input nobody has checked (review, Sep 17).
  const stuckTranscript = live.find((r) => r.transcriptState === "NEEDS_REVIEW" || r.transcriptState === "FAILED");
  if (stuckTranscript) reasons.push(`a monthly call's transcript is ${stuckTranscript.transcriptState.toLowerCase()} — its topics, answers and facts have not been read`);
  const lastApproval = approved.reduce<Date | null>((m, s) => (s.approvedAt && (!m || s.approvedAt > m) ? s.approvedAt : m), null);
  const filmingReadyAt = month.filmingReadyAt ?? (preparationStatus === "READY_FOR_FILMING" ? lastApproval : null);
  return {
    callMode, strategyCallStatus, strategyCallAt, strategyCallEndsAt, callBookedAt: anchorCall?.createdAt ?? null, planningMode, preparationStatus, preparationCompletedAt, filmingReadyAt,
    earliestSessionAt, sessions, sessionsKnown, preparationSufficient,
    sessionsRequired,
    sessionsAccountedFor: shortfall?.accountedFor ?? 0,
    sessionsBooked: booking?.booked ?? 0,
    sessionsFilmed: booking?.filmed ?? 0,
    sessionsMissing: shortfall?.missing ?? 0,
    // A month with no booking evidence supplied is not "fully scheduled" and is
    // not "missing everything" either; `bookingKnown` is how a reader tells.
    fullyScheduled: shortfall?.fullyScheduled ?? false,
    bookingKnown,
    // `windowDays` (windowHours / 24) is GONE, Sep 21 2026 (F04). When the
    // window became 48 weekday HOURS the derived day count silently fell from
    // 3 to 2, and src/lib/portal.ts fed it straight into addBusinessDaysET for
    // the booking gate a client is actually held to — so the same field name
    // quietly opened filming a full business day early. Deleting it rather
    // than correcting it is the point: a day-shaped reading of an hour-shaped
    // rule has to fail to compile, not round.
    windowHours, windowWaived, reasons, exceptions, followUps,
  };
}

export type PreparationGate = {
  /** The session this reading is for; null = the month-wide reading (the earliest open session). */
  sessionIndex: number | null;
  route: PlanningMode;
  /** The first moment filming may start, by the preparation rule alone (no 24-hour floor); null while shut. */
  earliest: Date | null;
  anchor: GateAnchor | null;
  windowHours: number;
  windowWaived: boolean;
  locked: boolean;
  lock: GateLock | null;
  /** Staff words: what it is counted from, or why it is shut. */
  reason: string;
};

const etWhen = (d: Date) => `${d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;

const LOCK_WORDS: Record<GateLock, string> = {
  BOOK_CALL: "no strategy call is booked for the month yet",
  CHOOSE_ROUTE: "the client has not chosen how to plan the month",
  ANSWERS: "the session's answers are not all submitted",
  UNDER_PLANNED: "the session's topics are not all chosen",
  PREPARING: "preparation is not complete",
};

/**
 * THE ONE READER of the preparation rule (A20, Sep 25 2026) — the portal gate
 * (portal.sessionGate), the reminder's "earliest session" line, the staff
 * overview, the desk task, a request's snapshot and the booking adapter's
 * anchor recheck all ask this, per session, and nothing else calls
 * addWeekdayHoursET for scheduling.
 *
 * `sessionIndex` picks the session (1-based; Pro has 1 and 2). Omitted, or
 * outside the package's sessions (an approved extra), it is the month-wide
 * reading: the earliest OPEN session, else the first session's lock. Pure.
 */
export function preparationGate(d: DerivedMonthState, sessionIndex?: number | null): PreparationGate {
  const exact = sessionIndex != null && Number.isInteger(sessionIndex) ? d.sessions.find((s) => s.index === sessionIndex) ?? null : null;
  const open = d.sessions.filter((s) => s.earliestSessionAt).sort((a, b) => a.earliestSessionAt!.getTime() - b.earliestSessionAt!.getTime());
  const s = exact ?? open[0] ?? d.sessions[0] ?? null;
  const base = { sessionIndex: exact ? exact.index : null, route: d.planningMode, windowHours: d.windowHours, windowWaived: d.windowWaived };
  if (!s || !s.earliestSessionAt || !s.anchor) {
    const lock: GateLock = s?.lock ?? "PREPARING";
    return { ...base, earliest: null, anchor: null, locked: true, lock, reason: LOCK_WORDS[lock] };
  }
  const reason = d.windowWaived
    ? `from ${s.anchor.label} (${etWhen(s.anchor.at)}), window waived by staff`
    : `${d.windowHours} weekday hours after ${s.anchor.label} (${etWhen(s.anchor.at)})`;
  return { ...base, earliest: s.earliestSessionAt, anchor: s.anchor, locked: false, lock: null, reason };
}

/** What a request stores about the gate it was offered under (ProgramSessionRequest.gate*). */
export type GateSnapshot = {
  sessionIndex: number | null;
  route: string;
  anchorRef: string | null;
  anchorAt: Date | null;
  windowHours: number;
  earliestAt: Date | null;
};

export function gateSnapshot(g: PreparationGate): GateSnapshot {
  return { sessionIndex: g.sessionIndex, route: g.route, anchorRef: g.anchor?.ref ?? null, anchorAt: g.anchor?.at ?? null, windowHours: g.windowHours, earliestAt: g.earliest };
}

/** "Earliest start allowed: Thu, Oct 1, 2:30 PM ET (72 weekday hours after the strategy call's scheduled end, Mon, Sep 28, 2:30 PM ET)" — the desk's line, from a snapshot. */
export function earliestStartLine(s: { gateEarliestAt: Date | null; gateWindowHours: number | null; gateAnchorRef: string | null; gateAnchorAt: Date | null }): string | null {
  if (!s.gateEarliestAt) return null;
  const from = s.gateAnchorRef?.startsWith("CALL_END:") ? "the strategy call ends" : s.gateAnchorRef?.startsWith("SUBMISSION:") ? "the answers were submitted" : null;
  const tail = s.gateWindowHours != null && from
    ? ` (${s.gateWindowHours} weekday hours after ${from}${s.gateAnchorAt ? `, ${etWhen(s.gateAnchorAt)}` : ""})`
    : "";
  return `Earliest start allowed: ${etWhen(s.gateEarliestAt)}${tail}.`;
}

// ---------------------------------------------------------------------------
// WHICH SESSION IS WHICH (A24, Sep 25 2026). Pro is two four-hour sessions
// with their own appointment, topics, address and readiness, so every request
// names its session (ProgramSessionRequest.sessionIndex) and the gate is read
// for THAT session. Rows written before the column existed have none: they
// take the lowest free index in slot order, which is what "Session 1 of 2"
// already meant on every screen.
// ---------------------------------------------------------------------------

export type SessionOccupant = { key: string; sessionIndex: number | null; at: Date | null };

/**
 * Which session index each booked session or live ask holds. Explicit indexes
 * first (the first to claim one keeps it), then the rest in slot order onto
 * the lowest free index; past the package's count they are extras
 * (required + 1, …). `free` is what is left to book, in order. Pure.
 */
export function assignSessionIndexes(occupants: readonly SessionOccupant[], required: number): { byKey: Map<string, number>; free: number[] } {
  const n = Math.max(1, Math.floor(required) || 1);
  const byKey = new Map<string, number>();
  const taken = new Set<number>();
  for (const o of occupants) {
    const i = o.sessionIndex;
    if (i != null && Number.isInteger(i) && i >= 1 && i <= n && !taken.has(i) && !byKey.has(o.key)) { byKey.set(o.key, i); taken.add(i); }
  }
  const rest = occupants.filter((o) => !byKey.has(o.key))
    .sort((a, b) => (a.at?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.at?.getTime() ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
  let extra = n;
  for (const o of rest) {
    if (byKey.has(o.key)) continue;
    let i = 1;
    while (i <= n && taken.has(i)) i++;
    const idx = i <= n ? i : ++extra;
    byKey.set(o.key, idx);
    taken.add(idx);
  }
  const free: number[] = [];
  for (let i = 1; i <= n; i++) if (!taken.has(i)) free.push(i);
  return { byKey, free };
}

/**
 * The month's session occupancy from the rows the counter already reads: every
 * DISTINCT session (a confirmed request lends it its index) and every ask
 * still waiting on the office (sessionCapacity's own filter). `next` is the
 * session a new booking is for; null when every session is taken.
 */
export async function monthSessionIndexes(monthId: string, clientId: string, sessionsRequired: number, now: Date, db: ProgramDb = prisma): Promise<{ byKey: Map<string, number>; free: number[]; next: number | null; requestIndex: Map<string, number> }> {
  const [count, requests] = await Promise.all([
    monthSessionCount(monthId, clientId, now, db),
    db.programSessionRequest.findMany({
      where: { monthId, status: { in: ["REQUESTED", "RESCHEDULE_REQUESTED", "CONFIRMED", "CANCEL_REQUESTED"] } },
      select: { id: true, status: true, bookingState: true, supersedesId: true, projectId: true, aryeoAppointmentId: true, slotStart: true, sessionIndex: true },
    }),
  ]);
  return sessionIndexesFrom(count, requests, sessionsRequired);
}

/** monthSessionIndexes over rows already in hand (monthProgress reads them batched). Pure. */
export function sessionIndexesFrom(
  count: BookedSessionCount,
  requests: readonly { id: string; status: string; bookingState?: string | null; supersedesId?: string | null; projectId: string | null; aryeoAppointmentId: string | null; slotStart: Date | null; sessionIndex?: number | null }[],
  sessionsRequired: number,
): { byKey: Map<string, number>; free: number[]; next: number | null; requestIndex: Map<string, number> } {
  const indexOf = new Map(requests.map((r) => [r.id, r.sessionIndex ?? null]));
  const occupants: SessionOccupant[] = count.sessions.map((s) => {
    const reqIds = s.evidence.map((e) => /^confirmed request (\S+)$/.exec(e)?.[1]).filter((x): x is string => !!x);
    const explicit = reqIds.map((id) => indexOf.get(id)).find((i) => i != null) ?? null;
    return { key: s.key, sessionIndex: explicit, at: s.startsAt ?? s.at };
  });
  const counted = new Set(count.sessions.map((s) => s.key));
  const pending = requests.filter((r) =>
    (r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED") && r.bookingState !== "CONFLICT" &&
    !replacesPendingMove({ status: r.status, supersedesId: r.supersedesId ?? null }, requests.map((x) => ({ id: x.id, status: x.status }))) &&
    !(r.aryeoAppointmentId && counted.has(`appt:${r.aryeoAppointmentId}`)) &&
    !(r.projectId && counted.has(`project:${r.projectId}`)));
  for (const r of pending) occupants.push({ key: `request:${r.id}`, sessionIndex: r.sessionIndex ?? null, at: r.slotStart });
  const { byKey, free } = assignSessionIndexes(occupants, sessionsRequired);
  // Every live request's index — its own column, else the session it resolved to.
  const requestIndex = new Map<string, number>();
  for (const s of count.sessions) for (const e of s.evidence) { const id = /^confirmed request (\S+)$/.exec(e)?.[1]; if (id && byKey.has(s.key)) requestIndex.set(id, byKey.get(s.key)!); }
  for (const r of pending) if (byKey.has(`request:${r.id}`)) requestIndex.set(r.id, byKey.get(`request:${r.id}`)!);
  // A pending MOVE holds the index of the session it moves.
  for (const r of requests) if (!requestIndex.has(r.id) && r.supersedesId && requestIndex.has(r.supersedesId)) requestIndex.set(r.id, requestIndex.get(r.supersedesId)!);
  for (const r of requests) if (!requestIndex.has(r.id) && r.sessionIndex != null) requestIndex.set(r.id, r.sessionIndex);
  return { byKey, free, next: free[0] ?? null, requestIndex };
}

// ---------------------------------------------------------------------------
// Persisted recalculation.
// ---------------------------------------------------------------------------
export type RecalcResult = {
  monthId: string;
  changed: boolean;
  before: { strategyCallStatus: string; strategyCallAt: Date | null; planningMode: string | null; preparationStatus: string | null };
  after: DerivedMonthState;
};

/** Either the client or an interactive-transaction client. Session counting has
 *  to be readable INSIDE the transaction that decides whether a new request fits
 *  (A24), or the check and the write are not looking at the same database. */
export type ProgramDb = Prisma.TransactionClient;

/**
 * The month's distinct confirmed sessions, read from the rows Aryeo's hourly
 * sync already maintains — no provider call.
 *
 * Scoped to the enrollment's OWN client on purpose: a job mis-attached to
 * another client's month is hidden by the portal and must not fill this
 * client's allowance (the same rule sessionCapacity has carried since W1-A).
 * Appointments are read through their projects for the same reason.
 */
export async function monthSessionCount(monthId: string, clientId: string, now: Date, db: ProgramDb = prisma): Promise<BookedSessionCount> {
  const projects = await db.project.findMany({
    where: { contentMonthId: monthId, clientId, status: { not: "CANCELLED" } },
    select: { id: true, shootDate: true, addressLine: true },
  });
  const appointments = projects.length
    ? await db.appointment.findMany({
        where: { projectId: { in: projects.map((p) => p.id) } },
        select: { aryeoId: true, projectId: true, startAt: true, endAt: true, status: true },
      })
    : [];
  const confirmed = await db.programSessionRequest.findMany({
    where: { monthId, status: "CONFIRMED" },
    select: { id: true, projectId: true, aryeoAppointmentId: true, slotStart: true },
  });
  return countDistinctSessions({
    now,
    appointments: appointments.map((a) => ({ appointmentId: a.aryeoId, projectId: a.projectId, startAt: a.startAt, endAt: a.endAt, cancelled: a.status === "CANCELED" })),
    projects: projects.map((p) => ({ projectId: p.id, shootDate: p.shootDate, addressLine: p.addressLine })),
    confirmedRequests: confirmed.map((r) => ({ requestId: r.id, projectId: r.projectId, appointmentId: r.aryeoAppointmentId, slotStart: r.slotStart })),
  });
}

export async function recalcProgramMonth(monthId: string, opts: { now?: Date; dryRun?: boolean } = {}): Promise<RecalcResult | null> {
  const now = opts.now ?? new Date();
  const month = await prisma.contentMonth.findUnique({
    where: { id: monthId },
    select: {
      id: true, enrollmentId: true, monthKey: true, historical: true, strategyCallStatus: true, strategyCallAt: true, transcriptText: true,
      planningMode: true, preparationStatus: true, preparationCompletedAt: true, preparationWindowDays: true,
      preparationExceptionAt: true, preparationExceptionReason: true, filmingReadyAt: true, videosOwed: true,
    },
  });
  if (!month) return null;
  const { monthAllowances } = await import("@/lib/planningFacts");
  const [enrollment, records, scriptsAll, interviews, allowances, priorRecords, completedMonths] = await Promise.all([
    prisma.contentEnrollment.findUnique({
      where: { id: month.enrollmentId },
      select: { clientId: true, callMode: true, strategyCallRequired: true, noCallEligible: true, videosPerMonth: true, sessionsPerMonth: true, overridesJson: true },
    }),
    prisma.programCallRecord.findMany({
      where: { monthId: month.id },
      select: { id: true, callType: true, status: true, matchState: true, scheduledStart: true, scheduledEnd: true, transcriptState: true, createdAt: true },
    }),
    prisma.contentScript.findMany({ where: { monthId: month.id }, select: { topicId: true, status: true, approvedVersionId: true, approvedAt: true, historical: true } }),
    prisma.contentInterview.findMany({ where: { monthId: month.id }, select: { topicId: true, status: true, submittedAt: true, sufficiencyJson: true } }),
    // Topics PLANNED for this month — the ones INSIDE its allowance (R01). The
    // bank (no selection) is not material, and neither is an extra: it waits
    // its turn, so it must not hold the filming calendar shut.
    monthAllowances([month.id]),
    // effectiveCallMode: has this program held a monthly call in another month?
    prisma.programCallRecord.findMany({
      where: { enrollmentId: month.enrollmentId, callType: "MONTHLY_STRATEGY", matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF"] }, OR: [{ monthId: null }, { monthId: { not: month.id } }] },
      select: { monthId: true, callType: true, status: true, matchState: true, scheduledStart: true, scheduledEnd: true, transcriptState: true },
    }),
    prisma.contentMonth.findMany({ where: { enrollmentId: month.enrollmentId, id: { not: month.id }, strategyCallStatus: "COMPLETED" }, select: { id: true } }),
  ]);
  if (!enrollment) return null;
  const allowance = allowances.get(month.id);
  const inTopicIds = allowance ? [...allowance.slots].filter(([, slot]) => slot === "IN").map(([id]) => id) : [];
  const extraTopicIds = new Set(allowance ? [...allowance.slots].filter(([, slot]) => slot === "EXTRA").map(([id]) => id) : []);
  const monthTopics = inTopicIds.length
    ? await prisma.contentTopic.findMany({ where: { id: { in: inTopicIds }, enrollmentId: month.enrollmentId }, select: { id: true, title: true, status: true, createdAt: true } })
    : [];
  // An extra's draft is not the month's script: it must not hold the month at
  // AWAITING_SCRIPT_APPROVAL either. Month-level rows (no topic) and imports
  // stay — they are evidence the month was planned.
  const scripts = scriptsAll.filter((s) => !s.topicId || !extraTopicIds.has(s.topicId));
  const priorCallHeld = priorCallHeldFrom(month.id, priorRecords, completedMonths.map((m) => m.id), now);
  // Per-topic material (spec §8): an approved script counts — including one
  // carried over from last month, which is why this reads the script's own
  // approval state rather than asking whether it was written this month.
  const scriptByTopic = new Map<string, { approved: boolean; approvedAt: Date | null }>();
  for (const s of scripts) {
    if (!s.topicId) continue;
    const isApproved = s.historical === true || s.status === "APPROVED" || s.status === "CLIENT_VISIBLE" || s.status === "READY_TO_FILM" || !!s.approvedVersionId;
    const prev = scriptByTopic.get(s.topicId);
    scriptByTopic.set(s.topicId, { approved: (prev?.approved ?? false) || isApproved, approvedAt: prev?.approvedAt ?? s.approvedAt ?? null });
  }
  const interviewByTopic = new Map(interviews.map((i) => [i.topicId, i]));
  const topics: TopicMaterialInput[] = monthTopics.map((t) => {
    const script = scriptByTopic.get(t.id);
    const iv = interviewByTopic.get(t.id);
    return {
      topicId: t.id, status: t.status, title: t.title, createdAt: t.createdAt,
      scriptApproved: script?.approved ?? false, scriptApprovedAt: script?.approvedAt ?? null,
      interviewStatus: iv?.status ?? null, interviewSubmittedAt: iv?.submittedAt ?? null,
      interviewSufficient: storedSufficiency(iv?.sufficiencyJson ?? null),
    };
  });
  const after = deriveMonthState({
    now, month,
    enrollment: { ...enrollment, priorCallHeld, preparationWindowHours: enrollmentWindowOverrideHours(enrollment.overridesJson) },
    records, scripts, interviews, topics,
    // The MONTH's allowance, not the package's (A18): the planning reader's IN
    // topics are counted against videosOwed, so a staff allowance change must
    // move the session plan with it — or a written session planned for a
    // topic the allowance cannot hold would never open.
    plan: { videosPerMonth: month.videosOwed > 0 ? month.videosOwed : enrollment.videosPerMonth, sessionsPerMonth: enrollment.sessionsPerMonth },
    booking: await monthSessionCount(month.id, enrollment.clientId, now),
  });
  const before = { strategyCallStatus: month.strategyCallStatus, strategyCallAt: month.strategyCallAt, planningMode: month.planningMode, preparationStatus: month.preparationStatus };
  const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
  // planningMode is NEVER persisted from here. The column is the client's (or
  // staff's) explicit choice — setPlanningMode is its only writer — and the
  // derivation reads it as such: a derived "WRITTEN" written back would be
  // read on the next pass as "the client chose to plan without a call" and
  // skip the call for good, and a derived "CALL" would hide the written path
  // when the enrollment later switches to OPTIONAL_WRITTEN. Consumers get the
  // derived reading from `after.planningMode`.
  const changed =
    before.strategyCallStatus !== after.strategyCallStatus ||
    !sameTime(month.strategyCallAt, after.strategyCallAt) ||
    (month.preparationStatus ?? null) !== after.preparationStatus ||
    !sameTime(month.preparationCompletedAt, after.preparationCompletedAt) ||
    !sameTime(month.filmingReadyAt, after.filmingReadyAt);
  if (changed && !opts.dryRun) {
    await prisma.contentMonth.update({
      where: { id: month.id },
      data: {
        strategyCallStatus: after.strategyCallStatus,
        strategyCallAt: after.strategyCallAt,
        preparationStatus: after.preparationStatus,
        preparationCompletedAt: after.preparationCompletedAt,
        filmingReadyAt: after.filmingReadyAt,
      },
    });
  }
  // The written route's call-buffer conflict is Kyle's to confirm with the
  // client (§6.4) — a desk task, raised and cleared with the facts. Desk truth,
  // not automation (programDeskTasks): never for a TEST client, never a send,
  // and the booking itself is never touched.
  if (!opts.dryRun) await syncCallBufferTask(month.id, month.monthKey, enrollment.clientId, after).catch(() => {});
  // 6.6: a legacy-stamped call with no end on record — Kyle confirms it.
  if (!opts.dryRun) await syncCallEndTask(month.id, month.monthKey, enrollment.clientId, after).catch(() => {});
  // A25: a booked session whose anchor moved or vanished is a person's call —
  // a reassessment and a desk task, never a moved booking. Every persisted
  // recalculation passes through here (a call record synced, a route chosen,
  // answers sent), so it is checked the moment the fact changes. It is handed
  // `after` and never recalculates persistently itself.
  if (!opts.dryRun) {
    const { reassessMonthSessions } = await import("@/lib/sessionReassess");
    await reassessMonthSessions(month.id, { now, derived: after }).catch(() => {});
  }
  return { monthId: month.id, changed, before, after };
}

const CALL_END_TASK_PREFIX = "program-call-end:";

/**
 * "Confirm this call's end time" (6.6-legacy-call-stamp). One task per month
 * and call start (`program-call-end:<month>:<startMs>`), raised while the
 * derivation asks for it and closed once it no longer does — a call record
 * arrived, the sessions are booked, or the start-based earliest has passed. A
 * person's close stands (reopenIfClosed false). Never for a TEST client.
 */
async function syncCallEndTask(monthId: string, monthKey: string, clientId: string, d: DerivedMonthState): Promise<void> {
  const { openProgramDeskTask, closeProgramDeskTask, TASK_DONE_INCLUDING_LEGACY } = await import("@/lib/programDeskTasks");
  const prefix = `${CALL_END_TASK_PREFIX}${monthId}`;
  const want = d.followUps.filter((f) => f.kind === "CONFIRM_CALL_END").map((f) => ({ key: `${prefix}:${f.ref ?? "start"}`, f }));
  const open = await prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: `${prefix}:` }, status: { notIn: TASK_DONE_INCLUDING_LEGACY } }, select: { dedupeKey: true } });
  for (const t of open) if (t.dedupeKey && !want.some((w) => w.key === t.dedupeKey)) await closeProgramDeskTask(t.dedupeKey);
  if (!want.length) return;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
  for (const { key, f } of want) {
    await openProgramDeskTask({
      dedupeKey: key, clientId, clientName: client?.name ?? "",
      title: `Confirm the strategy call's end time — ${client?.name ?? "program client"} · ${monthKey}`,
      lines: [
        f.reason,
        "",
        "Find this call in Calendly. If it is a booking of the monthly strategy event, the hourly sync files it as a call record with its end time and this task closes on its own.",
        "If it is not on Calendly, note the real end time on this task. Until a call record exists, filming offers stay measured from the call's start.",
        "Nothing has been moved or cancelled.",
      ],
      assignedKey: "kyle",
      reasonCreated: "Legacy strategy call stamp with no end time",
      reopenIfClosed: false,
    });
  }
}

const CALL_BUFFER_TASK_PREFIX = "program-call-buffer:";

// ONE TASK PER CONFLICT — keyed on the session and the call it collides with
// (`program-call-buffer:<month>:<sessionStartMs>-<callEndMs>`). One key per
// month could never be raised twice: a conflict that cleared closed it, and
// `reopenIfClosed: false` (a person's close must stand) then swallowed every
// later conflict in the month — a call moved away and a second one booked
// inside session 2's buffer reached nobody (batch-2 review, Sep 25 2026). A
// new conflict is a new key; a person's close still stands for the one they
// closed; stale keys are closed the way reconcileScriptApprovalTasks does.
async function syncCallBufferTask(monthId: string, monthKey: string, clientId: string, d: DerivedMonthState): Promise<void> {
  const { openProgramDeskTask, closeProgramDeskTask, TASK_DONE_INCLUDING_LEGACY } = await import("@/lib/programDeskTasks");
  const monthKeyPrefix = `${CALL_BUFFER_TASK_PREFIX}${monthId}`;
  const conflicts = d.followUps.filter((f) => f.kind === "CALL_INSIDE_BUFFER");
  const keyOf = (f: PreparationFollowUp) => (f.ref ? `${monthKeyPrefix}:${f.ref}` : monthKeyPrefix);
  const want = new Set(conflicts.map(keyOf));
  // The month's own key (the pre-conflict-key shape) counts as this month's too.
  const mine = (k: string | null): k is string => !!k && (k === monthKeyPrefix || k.startsWith(`${monthKeyPrefix}:`));
  const open = await prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: monthKeyPrefix }, status: { notIn: TASK_DONE_INCLUDING_LEGACY } }, select: { dedupeKey: true } });
  for (const t of open) if (mine(t.dedupeKey) && !want.has(t.dedupeKey)) await closeProgramDeskTask(t.dedupeKey);
  if (!conflicts.length) return;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
  for (const f of conflicts) {
    await openProgramDeskTask({
      dedupeKey: keyOf(f), clientId, clientName: client?.name ?? "",
      title: `Call inside the filming buffer — ${client?.name ?? "program client"} · ${monthKey}`,
      lines: [
        f.reason,
        "",
        "They plan this month in writing and booked a strategy call to talk the scripts through. Ask whether the session keeps its time or moves; move it only if they ask.",
        "This closes itself once the call or the session no longer overlaps the buffer.",
      ],
      assignedKey: "kyle",
      reasonCreated: "Strategy call booked inside the preparation buffer before a filming session",
      reopenIfClosed: false,
    });
  }
}

export async function recalcProgramMonthsForEnrollment(enrollmentId: string, opts: { now?: Date; dryRun?: boolean } = {}): Promise<RecalcResult[]> {
  const months = await prisma.contentMonth.findMany({ where: { enrollmentId, historical: false }, select: { id: true } });
  const out: RecalcResult[] = [];
  for (const m of months) { const r = await recalcProgramMonth(m.id, opts); if (r) out.push(r); }
  return out;
}

/**
 * Hourly: every live month from last month forward, for every enrollment.
 * The cron step that calls this persists ONLY once an enabled Calendly
 * mapping exists (the owner's switch for the whole call chain) and runs it as
 * a dry run before that — until then the cron does exactly what it did this
 * morning to every live month. On-action recalcs (a confirmed transcript, a
 * session request) persist regardless; they touch one month a person acted on.
 */
export async function recalcOpenProgramMonths(opts: { now?: Date; dryRun?: boolean } = {}): Promise<{ checked: number; changed: number; changes: { monthId: string; from: string; to: string }[] }> {
  const now = opts.now ?? new Date();
  const prev = etMonthKey(new Date(now.getTime() - 32 * 864e5));
  const months = await prisma.contentMonth.findMany({ where: { historical: false, monthKey: { gte: prev } }, select: { id: true } });
  const changes: { monthId: string; from: string; to: string }[] = [];
  for (const m of months) {
    const r = await recalcProgramMonth(m.id, { now, dryRun: opts.dryRun });
    if (r?.changed) changes.push({ monthId: m.id, from: `${r.before.strategyCallStatus}/${r.before.preparationStatus ?? "-"}`, to: `${r.after.strategyCallStatus}/${r.after.preparationStatus ?? "-"}` });
  }
  return { checked: months.length, changed: changes.length, changes };
}

/**
 * Staff: apply an established exception to a month's preparation window with
 * a reason (spec §4). Never silent — the reason is stored and shown.
 */
export async function setPreparationException(monthId: string, reason: string, by: string | null): Promise<void> {
  const text = reason.trim();
  if (text.length < 3) throw new Error("An exception needs a reason.");
  await prisma.contentMonth.update({ where: { id: monthId }, data: { preparationExceptionReason: text, preparationExceptionBy: by, preparationExceptionAt: new Date() } });
  await recalcProgramMonth(monthId);
}

/**
 * Staff or the client: choose the written path (or back to the call path).
 * Never cancels a booking, never touches a call record, a session request, a
 * selection, an interview or a script — switching routes keeps every piece of
 * work (§6.4). `by` stamps planningChosenAt/By so an explicit choice is told
 * apart from the call mode's default, which the column alone could not do.
 */
export async function setPlanningMode(monthId: string, mode: "CALL" | "WRITTEN", by: string | null = null): Promise<DerivedMonthState | null> {
  await prisma.contentMonth.update({ where: { id: monthId }, data: { planningMode: mode, planningChosenAt: new Date(), planningChosenBy: by } });
  const r = await recalcProgramMonth(monthId);
  return r?.after ?? null;
}

/**
 * The written path's completion stamp — a RECORD of when material first became
 * complete, and since Sep 21 2026 no longer the thing that opens filming.
 *
 * It used to be both, and that is the defect F04 names: once stamped, the gate
 * stayed open even after the client reopened their answers, because nothing
 * ever cleared the column. `deriveMonthState` now re-reads the actual material
 * every pass and the stamp is history. Leaving the write in place (rather than
 * deleting the function) keeps the historical column honest and keeps the
 * existing callers working.
 */
export async function markPreparationComplete(monthId: string, at: Date = new Date()): Promise<void> {
  await prisma.contentMonth.update({ where: { id: monthId }, data: { preparationCompletedAt: at } });
  await recalcProgramMonth(monthId);
}
