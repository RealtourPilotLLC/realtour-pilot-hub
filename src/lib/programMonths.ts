import "server-only";
import { prisma } from "@/lib/prisma";
import { etAt, etDayKey } from "@/lib/datetime";
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
//   earliestSessionAt   ← the 3-business-day window (ET), honouring
//                         preparationWindowDays and a staff exception+reason
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

export const DEFAULT_PREPARATION_WINDOW_DAYS = 3;

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
export function addBusinessDaysET(from: Date, days: number): Date {
  let key = etDayKey(from);
  let left = Math.max(0, days);
  const step = (k: string): string => {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
  };
  while (left > 0) {
    key = step(key);
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return etAt(key, 0);
}

export type MonthCallRecordInput = {
  callType: string;
  status: string; // SCHEDULED | COMPLETED | CANCELLED | RESCHEDULED | NO_SHOW
  matchState: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  transcriptState: string;
};

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
  interviews: { status: string; submittedAt: Date | null }[];
};

export type DerivedMonthState = {
  callMode: CallMode;
  strategyCallStatus: StrategyCallStatus;
  strategyCallAt: Date | null;
  planningMode: PlanningMode;
  preparationStatus: PreparationStatus | null;
  preparationCompletedAt: Date | null;
  filmingReadyAt: Date | null;
  /** The earliest a content session may start, or null while preparation has not begun. */
  earliestSessionAt: Date | null;
  windowDays: number;
  windowWaived: boolean;
  reasons: string[];
};

const HELD = (r: MonthCallRecordInput, now: Date) =>
  r.status === "COMPLETED" ||
  r.transcriptState === "CONFIRMED" || r.transcriptState === "ANALYZED" ||
  (r.status === "SCHEDULED" && !!(r.scheduledEnd ?? r.scheduledStart) && (r.scheduledEnd ?? r.scheduledStart)! < now);

export function deriveMonthState(input: DeriveInput): DerivedMonthState {
  const { now, month, enrollment } = input;
  const reasons: string[] = [];
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
  const held = live.filter((r) => HELD(r, now)).sort((a, b) => (b.scheduledStart?.getTime() ?? 0) - (a.scheduledStart?.getTime() ?? 0));
  const upcoming = live.filter((r) => !HELD(r, now) && r.status === "SCHEDULED").sort((a, b) => (a.scheduledStart?.getTime() ?? 0) - (b.scheduledStart?.getTime() ?? 0));

  const stored = month.strategyCallStatus as StrategyCallStatus;
  let strategyCallStatus: StrategyCallStatus;
  let strategyCallAt: Date | null = month.strategyCallAt;
  if (held.length > 0) {
    strategyCallStatus = "COMPLETED";
    strategyCallAt = held[0].scheduledStart ?? strategyCallAt;
    reasons.push(`${held.length} monthly call(s) held on record`);
  } else if (upcoming.length > 0) {
    // A transcript on file (legacy paste/sweep) outranks a later booking.
    strategyCallStatus = stored === "COMPLETED" && month.transcriptText ? "COMPLETED" : "SCHEDULED";
    if (strategyCallStatus === "SCHEDULED") strategyCallAt = upcoming[0].scheduledStart ?? strategyCallAt;
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
  const submitted = input.interviews.some((i) => i.status === "SUBMITTED" || !!i.submittedAt);
  const preparationCompletedAt =
    planningMode === "WRITTEN"
      ? (month.preparationCompletedAt ?? (submitted ? (input.interviews.find((i) => i.submittedAt)?.submittedAt ?? now) : null))
      : month.preparationCompletedAt;

  let preparationStatus: PreparationStatus | null = null;
  const afterPrep = (): PreparationStatus =>
    scripts.length === 0 ? "PREPARING_SCRIPTS" : scriptsDone ? "READY_FOR_FILMING" : "AWAITING_SCRIPT_APPROVAL";
  if (planningMode === "CALL") preparationStatus = callHeld ? afterPrep() : "CALL_PLANNED";
  else if (planningMode === "WRITTEN") {
    if (preparationCompletedAt) preparationStatus = afterPrep();
    else preparationStatus = input.interviews.length > 0 ? "AWAITING_ANSWERS" : "WRITTEN_SELECTED";
  }

  // The window: 3 business days (ET) after the call, or after sufficient
  // written answers — never "tomorrow because the call was skipped".
  const windowDays = month.preparationWindowDays ?? DEFAULT_PREPARATION_WINDOW_DAYS;
  const windowWaived = !!month.preparationExceptionAt && !!month.preparationExceptionReason;
  const base = planningMode === "CALL" ? (callHeld ? strategyCallAt : null) : preparationCompletedAt;
  let earliestSessionAt: Date | null = null;
  if (base) {
    earliestSessionAt = windowWaived ? base : addBusinessDaysET(base, windowDays);
    if (windowWaived) reasons.push(`window waived: ${month.preparationExceptionReason}`);
  }

  // The filming-ready stamp is the moment the LAST script was approved — a
  // real event with a real time — never "now" because a recalculation happened
  // to run (that would date six August months to the day the derivation
  // shipped, and §24 reminders key off this column). A stored stamp wins; a
  // derived READY_FOR_FILMING with no approval time on any script stays null.
  const lastApproval = approved.reduce<Date | null>((m, s) => (s.approvedAt && (!m || s.approvedAt > m) ? s.approvedAt : m), null);
  const filmingReadyAt = month.filmingReadyAt ?? (preparationStatus === "READY_FOR_FILMING" ? lastApproval : null);
  return { callMode, strategyCallStatus, strategyCallAt, planningMode, preparationStatus, preparationCompletedAt, filmingReadyAt, earliestSessionAt, windowDays, windowWaived, reasons };
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
  const [enrollment, records, scripts, interviews] = await Promise.all([
    prisma.contentEnrollment.findUnique({ where: { id: month.enrollmentId }, select: { callMode: true, strategyCallRequired: true, noCallEligible: true } }),
    prisma.programCallRecord.findMany({
      where: { monthId: month.id },
      select: { callType: true, status: true, matchState: true, scheduledStart: true, scheduledEnd: true, transcriptState: true },
    }),
    prisma.contentScript.findMany({ where: { monthId: month.id }, select: { status: true, approvedVersionId: true, approvedAt: true, historical: true } }),
    prisma.contentInterview.findMany({ where: { monthId: month.id }, select: { status: true, submittedAt: true } }),
  ]);
  if (!enrollment) return null;
  const after = deriveMonthState({ now, month, enrollment, records, scripts, interviews });
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

/** The written path's completion stamp (called when sufficient answers were submitted). */
export async function markPreparationComplete(monthId: string, at: Date = new Date()): Promise<void> {
  await prisma.contentMonth.update({ where: { id: monthId }, data: { preparationCompletedAt: at } });
  await recalcProgramMonth(monthId);
}
