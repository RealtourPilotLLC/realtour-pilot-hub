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
//   earliestSessionAt   ← the 48-weekday-hour window (ET), honouring
//                         preparationWindowDays and a staff exception+reason
//                         (Sep 21 2026: was 3 business days — see THE
//                         PREPARATION CLOCK below for why that was wrong)
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
// ---------------------------------------------------------------------------

/** The program's preparation window: 48 hours of weekday time (spec §8). */
export const DEFAULT_PREPARATION_WINDOW_HOURS = 48;

/**
 * RETIRED Sep 21 2026 — the window is hours of weekday time now, not business
 * days. Kept (not deleted) because the per-month override column is still
 * `preparationWindowDays` and the staff settings panel still writes days into
 * it: a staff member who types "3" means three 24-hour days of weekday time, so
 * an override is read as `days * 24` hours. Schema work belongs to a later
 * batch; this constant is what the translation is anchored to.
 */
export const DEFAULT_PREPARATION_WINDOW_DAYS = 3;

/** Hours of weekday time for a month, honouring the legacy day-shaped override. */
export function preparationWindowHours(preparationWindowDays: number | null | undefined): number {
  return preparationWindowDays != null && preparationWindowDays > 0
    ? preparationWindowDays * 24
    : DEFAULT_PREPARATION_WINDOW_HOURS;
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

/** The enrollment's call mode: the explicit column, else derived from the legacy flag. */
export function callModeOf(e: { callMode: string | null; strategyCallRequired: boolean }): CallMode {
  if (e.callMode === "REQUIRED" || e.callMode === "OPTIONAL_WRITTEN" || e.callMode === "NOT_INCLUDED") return e.callMode;
  return e.strategyCallRequired ? "REQUIRED" : "NOT_INCLUDED";
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
  callType: string;
  status: string; // SCHEDULED | COMPLETED | CANCELLED | RESCHEDULED | NO_SHOW
  matchState: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  transcriptState: string;
};

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
  notes: string[];
};

export type PreparationFollowUp = {
  kind: "MISSING_POST_CALL_INFO" | "UNFINISHED_ANSWERS" | "ANSWERS_REOPENED" | "UNDER_PLANNED_SESSION";
  /** Who owns chasing it (spec §3: scheduling and client follow-up are Kyle's). */
  owner: "KYLE" | "JORDAN";
  reason: string;
  sessionIndex: number | null;
};

/** A topic's material is complete. A submission STAMP is not enough on its own:
 *  an interview reopened after submission keeps `submittedAt` and would have
 *  held the gate open forever, which is the same defect as the stored month
 *  stamp this batch removed. The live status wins whenever there is one. */
export function topicMaterialReady(t: TopicMaterialInput): boolean {
  if (t.scriptApproved) return true;
  return t.interviewStatus ? t.interviewStatus === "SUBMITTED" : !!t.interviewSubmittedAt;
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
 * (creation, then id) so the same month always splits the same way. Overflow —
 * more selected topics than the package plans for — lands in the last session
 * rather than vanishing; §3 says extra filmed work is flagged, not dropped.
 */
export function planSessions(
  topics: TopicMaterialInput[],
  plan: { videosPerMonth: number; sessionsPerMonth: number },
): { index: number; plannedVideos: number; topics: TopicMaterialInput[] }[] {
  const sessions = Math.max(1, Math.floor(plan.sessionsPerMonth) || 1);
  const perSession = Math.max(1, Math.ceil((Math.max(0, plan.videosPerMonth) || sessions) / sessions));
  const required = topics
    .filter((t) => REQUIRED_TOPIC_STATUSES.has(t.status))
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.topicId.localeCompare(b.topicId));
  return Array.from({ length: sessions }, (_, i) => ({
    index: i + 1,
    plannedVideos: perSession,
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
  enrollment: { callMode: string | null; strategyCallRequired: boolean; noCallEligible: boolean | null };
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

export function deriveMonthState(input: DeriveInput): DerivedMonthState {
  const { now, month, enrollment } = input;
  const reasons: string[] = [];
  const exceptions: string[] = [];
  const followUps: PreparationFollowUp[] = [];
  const callMode = callModeOf(enrollment);

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
  } else if (stored === "COMPLETED" || stored === "SKIPPED" || stored === "SCHEDULED") {
    // Legacy truth (pasted transcript, old sweep's stamp, hand-set skip):
    // preserved. The legacy sweep still owns SCHEDULED→NOT_SCHEDULED on a
    // cancellation until a mapping hands over to call records.
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

  const windowHours = preparationWindowHours(month.preparationWindowDays);
  const windowWaived = !!month.preparationExceptionAt && !!month.preparationExceptionReason;
  if (windowWaived) reasons.push(`window waived: ${month.preparationExceptionReason}`);
  const afterWindow = (base: Date): Date => (windowWaived ? base : addWeekdayHoursET(base, windowHours));

  // THE CALL CLOCK starts when the call ENDS (spec §8). scheduledEnd is what
  // every monthly record in production actually carries; scheduledStart is the
  // fallback only because the overview screen builds its input without the end
  // column, and starting half an hour early is better than refusing to answer.
  const heldCall = held[0] ?? null;
  // The SAME value the portal's pre-call estimate reads off `strategyCallEndsAt`
  // — deliberately one expression, not two. F04 (Sep 21 2026) was two readings
  // of one rule drifting apart, so the estimate and the gate share a base here
  // rather than each recomputing it.
  const callEndedAt = heldCall ? strategyCallEndsAt : null;
  if (heldCall && !heldCall.scheduledEnd && heldCall.scheduledStart) {
    reasons.push("this call has no end time on record — the window is measured from when it was due to start");
  }

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
      // does NOT restart (or withhold) the clock. The WRITTEN path is gated by
      // the material, per session, every pass — which is what closes a month
      // again when its answers go unfinished.
      const base = planningMode === "CALL" ? callEndedAt : materialReadyAt;
      const open = planningMode === "CALL" ? !!callEndedAt : sufficient && !!base;
      sessions.push({
        index: s.index, plannedVideos: s.plannedVideos,
        topicIds: s.topics.map((t) => t.topicId),
        readyTopicIds: ready.map((t) => t.topicId),
        missingTopicIds: missing.map((t) => t.topicId),
        sufficient, materialReadyAt,
        earliestSessionAt: open && base ? afterWindow(base) : null,
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
    const base = planningMode === "CALL" ? callEndedAt : materialReadyAt;
    const open = planningMode === "CALL" ? !!callEndedAt : sufficient && !!base;
    sessions.push({
      index: 1, plannedVideos: 0, topicIds: [], readyTopicIds: [], missingTopicIds: [],
      sufficient, materialReadyAt,
      earliestSessionAt: open && base ? afterWindow(base) : null,
      notes: ["session split unknown — the caller supplied no topics or package"],
    });
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
  const booking = input.booking ?? null;
  const bookingKnown = !!booking;
  const shortfall = booking ? sessionShortfall(sessionsRequired, booking) : null;
  if (booking && booking.duplicatesFolded > 0) {
    reasons.push(`${booking.duplicatesFolded} record(s) pointed at a session another record had already counted — folded into one session each`);
  }
  if (booking && shortfall && shortfall.accountedFor > sessionsRequired) {
    exceptions.push(`${shortfall.accountedFor} distinct filming sessions are linked to this month but the package owes ${sessionsRequired} — a person should say whether that is an approved extra`);
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
    callMode, strategyCallStatus, strategyCallAt, strategyCallEndsAt, planningMode, preparationStatus, preparationCompletedAt, filmingReadyAt,
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
      preparationExceptionAt: true, preparationExceptionReason: true, filmingReadyAt: true,
    },
  });
  if (!month) return null;
  const [enrollment, records, scripts, interviews, monthTopics] = await Promise.all([
    prisma.contentEnrollment.findUnique({
      where: { id: month.enrollmentId },
      select: { clientId: true, callMode: true, strategyCallRequired: true, noCallEligible: true, videosPerMonth: true, sessionsPerMonth: true },
    }),
    prisma.programCallRecord.findMany({
      where: { monthId: month.id },
      select: { callType: true, status: true, matchState: true, scheduledStart: true, scheduledEnd: true, transcriptState: true },
    }),
    prisma.contentScript.findMany({ where: { monthId: month.id }, select: { topicId: true, status: true, approvedVersionId: true, approvedAt: true, historical: true } }),
    prisma.contentInterview.findMany({ where: { monthId: month.id }, select: { topicId: true, status: true, submittedAt: true } }),
    // Topics PLANNED for this month. The bank (monthId null) is not material.
    prisma.contentTopic.findMany({ where: { monthId: month.id }, select: { id: true, title: true, status: true, createdAt: true } }),
  ]);
  if (!enrollment) return null;
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
    };
  });
  const after = deriveMonthState({
    now, month, enrollment, records, scripts, interviews, topics,
    plan: { videosPerMonth: enrollment.videosPerMonth, sessionsPerMonth: enrollment.sessionsPerMonth },
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
  return { monthId: month.id, changed, before, after };
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

/** Staff or the client: choose the written path (or back to the call path). Never cancels a booking. */
export async function setPlanningMode(monthId: string, mode: "CALL" | "WRITTEN"): Promise<DerivedMonthState | null> {
  await prisma.contentMonth.update({ where: { id: monthId }, data: { planningMode: mode } });
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
