import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { automationConfig, getAutomation, isAutomationEnabled, type AutomationKey } from "@/lib/programAutomation";
import { recalcProgramMonth, addBusinessDaysET, replacesPendingMove, sessionShortfall, type DerivedMonthState } from "@/lib/programMonths";
import { etDayKey, etAt } from "@/lib/datetime";
import { isTestClientName, isStaffControlledEmail } from "@/lib/testClients";
import { sendThroughOutbox, programReminderKey, markFailed, maskToRef } from "@/lib/outbox";
import { mintLoginLink } from "@/lib/portalAccess";
import { appBase } from "@/lib/appUrl";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import { clientTextWindowOpen } from "@/lib/clientTextSweeps";
import { ownersFor, type OwnerDuty } from "@/lib/programOwners";
import {
  templateForAction, renderReminder, monthName, firstNameOf, reminderTemplate, DEFAULT_TEMPLATE_IDS,
  type ReminderAction, type TemplateVars,
} from "@/lib/reminderTemplates";

// ---------------------------------------------------------------------------
// PROGRAM REMINDERS (spec §24) — the ledger and the evaluator. W2-F, Sep 17 2026.
//
// WHAT THIS IS. Once an hour (cron `programReminders`, and only while the
// `reminders` switch is ON — a missing ProgramAutomation row is OFF), every
// ACTIVE enrollment's open program months are read and ONE action is derived
// per month: choose a planning path, book the required call, finish the
// written answers, book the content session, or review shared work. If the
// cadence says it is time, a ProgramReminder row is written FIRST (the
// ledger: client / month / action / template / attempt / dedupeKey), the
// authoritative state is re-read, and only then is an OutboxMessage of kind
// `program_reminder` handed to the provider. The outbox's own answer
// (accepted / failed / unknown) is written back on the ledger row.
//
// WHY A LEDGER BEFORE A SEND (the Sep 8 lesson: an automation that can fail
// silently is worse than none). The row exists before anything can go wrong,
// so a crash, a refused send and an ambiguous send all leave a visible state
// with a reason — and a second evaluator run, or a retry, collides on the
// row's dedupeKey (`enrollment:month:action:attempt`) instead of sending
// twice. Nothing in here can send without a row, and no row can be sent twice.
//
// WHAT NEVER HAPPENS HERE.
//   · The existing automatic client texts (confirmation, delivery, welcome,
//     after-hours) and their AppSetting markers / `auto-*` CommLog sources are
//     not read, written or reused. Reminders are a new outbox kind, email
//     only in this build, and they obey the SAME send window (Mon–Fri 9:00 to
//     4:30 ET, `clientTextWindowOpen`) plus the policy's own business hours.
//   · A client never gets both a book-call reminder and a no-call-preparation
//     reminder for one month: the derivation below yields exactly one action,
//     and the no-call sentence renders only for an eligible client.
//   · A real client cannot be reached before launch even with the switch ON:
//     the policy's `testClientsOnly` lock (default true) suppresses every
//     non-TEST enrollment, and a TEST client whose address is not staff-
//     controlled is suppressed too. Jordan flips both deliberately.
//   · "Not booked" is never inferred from a stale scheduler: while no enabled
//     Calendly mapping has synced recently, booking-type reminders are
//     suppressed as `stale_scheduler_sync` (spec: a failed or stale sync must
//     not automatically mean not booked).
//
// dryRun evaluates everything — with the stored policy, or the code defaults
// when the switch is off — and writes nothing; it returns the exact rows that
// would send, wait or be suppressed, with reasons. That is the settings
// panel's "What would go out now?" and the acceptance probe's evidence.
//
// ---------------------------------------------------------------------------
// THE MONTHLY CALENDAR (spec §12, batch F20, Sep 21 2026). What changed and why.
//
// The cadence used to be "14 days before the month starts, then every 3
// business days, deadline the 25th of the PREVIOUS month". That is not the
// schedule Jordan confirmed, and the old deadline sat in the past for the whole
// of the month it governed — so `deadlineNear` was true on the first evaluation
// of every month and every client month escalated to Kyle immediately. §12's
// calendar is four dated milestones inside the program month itself:
//
//   MONTH_OPEN    the 1st                  (weekend → the next weekday)
//   FOLLOW_UP_1   three WEEKDAYS after the ACTUAL initial send
//   FOLLOW_UP_2   three more weekdays after that follow-up
//   MID_MONTH     the 15th                 (weekend → the next weekday)
//
// Three WEEKDAYS, not 72 staffed hours: addBusinessDaysET walks ET day keys, so
// a Friday send is due again on Wednesday, and a clock change cannot move it.
// The follow-ups anchor on the row that actually SENT, never on the day we
// wished it had — a send held overnight by quiet hours moves the whole tail.
//
// MID_MONTH is its own milestone with its own single attempt, its own ledger
// identity (`…:mid:n`) and a Kyle follow-up task. It is the "unused sessions do
// not roll over" note, so it is the one message that is WRONG to send to a
// client in their first paid production cycle or to one whose shortfall we
// caused, and both are suppressed with Kyle told instead (§3, §12, A28).
//
// LANES. §12 asks for review and address reminders to be kept off the planning
// cadence, so a month is evaluated once per lane:
//   PRIMARY  planning + session booking — the four milestones above.
//   REVIEW   released cuts waiting on the client — its own clock and its own cap.
//   ADDRESS  §8's "48 elapsed hours before filming, moved BACK to Friday if it
//            lands on a weekend". One email per SESSION booked with only a
//            general area (CP-05, Sep 24 2026), carrying a per-session link to
//            that session's address form. It runs FIRST, so on a day both are
//            due the time-critical one takes the one-email-a-day slot.
// At most one client email per enrollment per ET day across every lane, so two
// cadences coinciding produce one message and not two near-identical ones.
// A month is therefore TWO rows on every internal surface, and the lane has to
// travel with the month id wherever a person can act on one (reminderRowId).
//
// WHAT THE CLIENT IS TOLD IS ITS OWN SETTING (F20 review, Sep 21 2026). §12
// gives four milestones and no planning deadline, so the 15th is a milestone
// here and nothing more: it anchors the internal escalation clock and Kyle's
// follow-up, and it is NOT quoted in "We'd love to have it planned by <date>".
// That sentence renders only when `quotedPlanningDeadlineDayOfMonth` is set,
// which it is not by default — a client-facing promise is Jordan's to make, not
// a side effect of moving a milestone.
//
// PER SESSION, NOT PER MONTH (A23). Sessions were two booleans — "something is
// booked", "something was filmed" — which is the same answer for a Pro month
// with one of its two four-hour sessions on the calendar as for an Accelerator
// month that is fully booked. The count now comes from the enrollment's
// sessionsPerMonth against the distinct sessions actually accounted for, and the
// BOOK_SESSION cadence is keyed to WHICH session is missing (`…:s2:n`), so
// booking the first one does not spend the second one's reminders.
//
// CLIENTS CANNOT TURN THESE OFF (§12, superseding the earlier toggle talk).
// Nothing in this file reads a client-held preference. The only ways a reminder
// stops are the ones staff own — a snooze with a reason, a pause, an ended
// enrollment, revoked access — or the client's own state resolving the thing we
// were asking for.
// ---------------------------------------------------------------------------

export const REMINDERS_KEY: AutomationKey = "reminders";

export type ReminderPolicy = {
  timezone: string;
  businessHours: { days: number[]; start: string; end: string };
  sender: string;
  escalationOwnerDuty: string;
  /** RETIRED Sep 21 2026 (F20). The cadence starts on the 1st of the program
   *  month now (§12), not N days before it. Kept so a stored policy carrying
   *  the key still validates and saves; nothing reads it. */
  planningOpensDaysBeforeMonth: number;
  /** RETIRED Sep 21 2026 (F20). Replaced by planningDeadlineDayOfMonth — a
   *  deadline in the previous month is already past for every day of the month
   *  it governs, which made every month escalate on its first evaluation. */
  planningDeadlineDayOfPrevMonth: number;
  firstReminderDelayBusinessDays: number;
  /** §12: three WEEKDAYS between monthly scheduling follow-ups. */
  followUpAfterBusinessDays: number;
  maxAttemptsPerAction: number;
  escalateWhenDeadlineWithinBusinessDays: number;
  digestBothAppointments: boolean;
  includeNoCallOptionOnlyIfEligible: boolean;
  suppressWhen: string[];
  templates: Record<string, string>;
  // ---- additions beyond docs/CONTENT-PROGRAM-SCHEMA.md §5 (all documented on the settings panel)
  /** The pre-launch lock: only TEST clients may receive, even with the switch on. */
  testClientsOnly: boolean;
  /** Past open months (an August still OPEN in September) are obligations, not reminder targets, unless asked for. */
  includePastMonths: boolean;
  /** Booking-type reminders need an enabled Calendly mapping synced within this many hours. */
  staleSchedulerSyncHours: number;
  /** Shared cuts must have waited this many business days before a review reminder. */
  reviewWorkAfterBusinessDays: number;
  /**
   * BOOK_SESSION deadline: this day of the program month, 5 pm ET.
   *
   * REPORTED, NOT ENFORCED, AND NOT BUILT ON (Jordan, Sep 21 2026). He asked
   * explicitly whether anything in the tree implies a hard booking cutoff on the
   * 20th, and this is it — the only "20th" in the codebase. What it actually
   * does is narrow: it is the INTERNAL clock the BOOK_SESSION lane's escalation
   * threshold measures against, so when it is within
   * `escalateWhenDeadlineWithinBusinessDays` the evaluator stops nudging the
   * client and puts a task on the escalation owner. What it does NOT do, checked
   * line by line: it never reaches a client (the BOOK_SESSION branch leaves
   * `quotedDeadlineAt` null and the templates render only that), it never blocks
   * a booking (nothing in sessionRequests.ts, portal.ts or the session gate reads
   * it), and it never forfeits anything.
   *
   * Jordan's ruling is that no booking cutoff exists as a business rule, so this
   * number is left exactly as it was rather than corrected into one shape or the
   * other: raising it, lowering it or deleting it would each be a decision about
   * when Kyle gets told, and that is his to make. Batch 2 added nothing that
   * depends on it.
   */
  sessionBookingDeadlineDayOfMonth: number;
  /** Approve & share: releases inside this window go out as ONE email. */
  scriptShareBatchMinutes: number;
  /** Hard cap per evaluator run — a bug cannot email the whole roster in one tick. */
  maxSendsPerRun: number;
  // ---- the §12 calendar (F20, Sep 21 2026) ---------------------------------
  /** The monthly planning email goes on this day of the PROGRAM month; a
   *  weekend moves it to the next weekday. */
  monthlyOpenDayOfMonth: number;
  /** The mid-month milestone (the roll-over note + Kyle's follow-up), same
   *  weekend rule. It is ALSO the internal clock the escalation threshold
   *  measures against — see monthlyCalendar(). Nothing here is quoted to a
   *  client. */
  midMonthDayOfMonth: number;
  /** RETIRED Sep 21 2026 (F20 review). It was a single number doing two jobs:
   *  §12's 15th-of-the-month MILESTONE and the date quoted to the client in
   *  "We'd love to have it planned by <date>". Setting the milestone therefore
   *  moved a client-facing promise as a side effect — an October client would
   *  have been told the 15th where the pre-F20 build told them the 25th of
   *  September. Kept so a stored policy carrying the key still validates and
   *  saves; nothing reads it. */
  planningDeadlineDayOfMonth: number;
  /** THE ONLY DATE A CLIENT IS EVER TOLD. §12's calendar establishes four
   *  milestones and no planning deadline, so the hub quotes none until Jordan
   *  sets one: null (the default) renders the planning emails without the
   *  "planned by <date>" sentence, and a day of the program month renders it.
   *  Separate from every internal clock on purpose (F20 review, Sep 21 2026). */
  quotedPlanningDeadlineDayOfMonth: number | null;
  /** REVIEW lane spacing and cap, deliberately NOT the planning cadence. */
  reviewFollowUpBusinessDays: number;
  reviewMaxAttempts: number;
  /** §8: the missing-address reminder fires this many ELAPSED hours before
   *  filming (48), moved BACK to the Friday when it lands on a weekend. */
  addressReminderHoursBefore: number;
  /** One client email per enrollment per ET day across every lane, so two
   *  cadences falling together produce one message (§12). */
  maxClientEmailsPerDay: number;
};

export const REMINDER_DEFAULTS: ReminderPolicy = {
  timezone: "America/New_York",
  businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "16:30" },
  sender: "info@realtourpilot.com",
  escalationOwnerDuty: "ESCALATION",
  planningOpensDaysBeforeMonth: 14, // retired — see the type
  planningDeadlineDayOfPrevMonth: 25, // retired — see the type
  firstReminderDelayBusinessDays: 0,
  followUpAfterBusinessDays: 3,
  // §12's cadence is the 1st plus TWO follow-ups; the mid-month milestone has
  // its own single attempt on top and is not counted here.
  maxAttemptsPerAction: 3,
  escalateWhenDeadlineWithinBusinessDays: 3,
  digestBothAppointments: true,
  includeNoCallOptionOnlyIfEligible: true,
  // The CATALOGUE of reasons this evaluator can print, for the settings panel.
  // It is not a switch list: removing "snoozed" from it does not make snoozes
  // stop working, and a client has no way to add anything to it (§12 — clients
  // cannot disable program reminders).
  suppressWhen: [
    "booked", "no_call_chosen", "preparation_submitted", "paused", "ended", "snoozed",
    "pending_session_request", "stale_scheduler_sync", "access_revoked", "launch_not_authorised",
    "no_recipient", "test_client_real_address", "quiet_hours", "first_cycle_exempt",
    "catch_up_owed", "another_reminder_today", "no_template_yet",
  ],
  templates: { ...DEFAULT_TEMPLATE_IDS },
  testClientsOnly: true,
  includePastMonths: false,
  staleSchedulerSyncHours: 6,
  reviewWorkAfterBusinessDays: 2,
  sessionBookingDeadlineDayOfMonth: 20,
  scriptShareBatchMinutes: 15,
  maxSendsPerRun: 20,
  monthlyOpenDayOfMonth: 1,
  midMonthDayOfMonth: 15,
  planningDeadlineDayOfMonth: 15, // retired — see the type
  // No date is quoted to a client until Jordan sets one (F20 review, Sep 21 2026).
  quotedPlanningDeadlineDayOfMonth: null,
  // §8: four business days to review, with reminders two and one business days
  // before the deadline. Release + 2 business days is two before; the follow-up
  // one business day later is one before.
  reviewFollowUpBusinessDays: 1,
  reviewMaxAttempts: 2,
  addressReminderHoursBefore: 48,
  maxClientEmailsPerDay: 1,
};

// ---- policy validation (the settings panel and the action share it) ---------

export type PolicyValidation = { ok: true; policy: ReminderPolicy; warnings: string[] } | { ok: false; errors: string[] };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate a policy JSON against the documented shape. Unknown keys are kept
 *  (forward-compatible) but reported; a template id nobody has is an error,
 *  because a blank email is worse than a refused save. */
export function validateReminderPolicy(input: unknown): PolicyValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["The policy must be a JSON object."] };
  const raw = input as Record<string, unknown>;
  const p: ReminderPolicy = { ...REMINDER_DEFAULTS, ...raw } as ReminderPolicy;
  const num = (k: keyof ReminderPolicy, min: number, max: number) => {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) errors.push(`${k} must be a number between ${min} and ${max}.`);
  };
  const bool = (k: keyof ReminderPolicy) => { if (typeof p[k] !== "boolean") errors.push(`${k} must be true or false.`); };
  if (typeof p.timezone !== "string" || !p.timezone) errors.push("timezone must be an IANA zone, e.g. America/New_York.");
  else { try { new Intl.DateTimeFormat("en-US", { timeZone: p.timezone }); } catch { errors.push(`timezone "${p.timezone}" is not a valid IANA zone.`); } }
  const bh = p.businessHours as unknown;
  if (!bh || typeof bh !== "object") errors.push("businessHours must be {days, start, end}.");
  else {
    const b = bh as { days?: unknown; start?: unknown; end?: unknown };
    if (!Array.isArray(b.days) || b.days.length === 0 || !b.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) errors.push("businessHours.days must be weekday numbers 0–6 (1 = Monday).");
    if (typeof b.start !== "string" || !HHMM.test(b.start)) errors.push("businessHours.start must be HH:MM.");
    if (typeof b.end !== "string" || !HHMM.test(b.end)) errors.push("businessHours.end must be HH:MM.");
    if (typeof b.start === "string" && typeof b.end === "string" && HHMM.test(b.start) && HHMM.test(b.end) && b.start >= b.end) errors.push("businessHours.start must be before businessHours.end.");
    if (typeof b.end === "string" && HHMM.test(b.end) && b.end > "16:30") warnings.push("businessHours.end is later than 4:30 pm — the existing client-text window (Settings → Automated texts) still applies and will hold sends after it.");
  }
  if (typeof p.sender !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.sender)) errors.push("sender must be an email address.");
  if (typeof p.escalationOwnerDuty !== "string" || !["STRATEGY", "SCRIPTS", "SCHEDULING", "DELIVERY", "ESCALATION", "REMINDERS"].includes(p.escalationOwnerDuty)) errors.push("escalationOwnerDuty must be one of STRATEGY, SCRIPTS, SCHEDULING, DELIVERY, ESCALATION, REMINDERS.");
  num("planningOpensDaysBeforeMonth", 0, 60);
  num("planningDeadlineDayOfPrevMonth", 1, 28);
  num("firstReminderDelayBusinessDays", 0, 20);
  num("followUpAfterBusinessDays", 1, 30);
  num("maxAttemptsPerAction", 0, 6);
  num("escalateWhenDeadlineWithinBusinessDays", 0, 30);
  num("staleSchedulerSyncHours", 1, 168);
  num("reviewWorkAfterBusinessDays", 0, 20);
  num("sessionBookingDeadlineDayOfMonth", 1, 28);
  num("scriptShareBatchMinutes", 0, 240);
  num("maxSendsPerRun", 1, 200);
  num("monthlyOpenDayOfMonth", 1, 28);
  num("midMonthDayOfMonth", 1, 28);
  num("planningDeadlineDayOfMonth", 1, 28);
  // The one client-facing date in the whole policy. null is a deliberate value
  // ("quote no deadline"), not a missing one, so it is checked by hand.
  if (!(p.quotedPlanningDeadlineDayOfMonth === null || (typeof p.quotedPlanningDeadlineDayOfMonth === "number" && Number.isInteger(p.quotedPlanningDeadlineDayOfMonth) && p.quotedPlanningDeadlineDayOfMonth >= 1 && p.quotedPlanningDeadlineDayOfMonth <= 28)))
    errors.push("quotedPlanningDeadlineDayOfMonth must be a day of the month between 1 and 28, or null to quote no deadline to the client.");
  num("reviewFollowUpBusinessDays", 0, 20);
  num("reviewMaxAttempts", 0, 6);
  num("addressReminderHoursBefore", 1, 336);
  num("maxClientEmailsPerDay", 1, 5);
  // A mid-month milestone that lands on or before the opening day is not a
  // milestone, it is a second first email. Refuse the save rather than let the
  // collision rule quietly swallow one of them.
  if (typeof p.midMonthDayOfMonth === "number" && typeof p.monthlyOpenDayOfMonth === "number" && p.midMonthDayOfMonth <= p.monthlyOpenDayOfMonth)
    errors.push("midMonthDayOfMonth must be later in the month than monthlyOpenDayOfMonth.");
  // A deadline the client is asked to hit BEFORE we have written to them is not
  // a deadline, it is an apology waiting to happen.
  if (typeof p.quotedPlanningDeadlineDayOfMonth === "number" && typeof p.monthlyOpenDayOfMonth === "number" && p.quotedPlanningDeadlineDayOfMonth < p.monthlyOpenDayOfMonth)
    errors.push("quotedPlanningDeadlineDayOfMonth cannot be earlier in the month than monthlyOpenDayOfMonth — the client would be given a deadline before the first email reaches them.");
  if (typeof p.quotedPlanningDeadlineDayOfMonth === "number")
    warnings.push(`quotedPlanningDeadlineDayOfMonth is set: every planning email will tell the client "We'd love to have it planned by the ${p.quotedPlanningDeadlineDayOfMonth}th so your filming session lands on time." That is a promise about turnaround, so set it only if the ${p.quotedPlanningDeadlineDayOfMonth}th really does leave time to film and edit inside the month.`);
  bool("digestBothAppointments"); bool("includeNoCallOptionOnlyIfEligible"); bool("testClientsOnly"); bool("includePastMonths");
  if (!Array.isArray(p.suppressWhen) || !p.suppressWhen.every((s) => typeof s === "string")) errors.push("suppressWhen must be a list of reason names.");
  if (!p.templates || typeof p.templates !== "object" || Array.isArray(p.templates)) errors.push("templates must map actions to template ids.");
  else {
    for (const [action, id] of Object.entries(p.templates)) {
      if (typeof id !== "string") { errors.push(`templates.${action} must be a template id.`); continue; }
      try { const t = reminderTemplate(id); if (t.action !== action) errors.push(`templates.${action} points at "${id}", which is a ${t.action} template.`); }
      catch { errors.push(`templates.${action}: no template "${id}" exists.`); }
    }
  }
  for (const k of Object.keys(raw)) if (!(k in REMINDER_DEFAULTS)) warnings.push(`Unknown key "${k}" is kept but nothing reads it.`);
  if (p.testClientsOnly === false) warnings.push("testClientsOnly is false: with the switch on, REAL clients can receive reminders. Only Jordan's launch authorisation should set this.");
  if (errors.length) return { ok: false, errors };
  return { ok: true, policy: p, warnings };
}

/** The policy in force for a run: the stored one when the switch is on; null
 *  when off (the caller does nothing). dryRun callers pass `orDefaults`. */
export async function reminderPolicy(opts: { orDefaults?: boolean } = {}): Promise<{ enabled: boolean; policy: ReminderPolicy | null; source: "stored" | "defaults" | "off" }> {
  const cfg = await automationConfig<ReminderPolicy>(REMINDERS_KEY, REMINDER_DEFAULTS);
  if (cfg) {
    const v = validateReminderPolicy(cfg);
    // An invalid stored policy must not run on half-read numbers: it counts as
    // off, and the settings panel shows the errors.
    if (!v.ok) return { enabled: false, policy: null, source: "off" };
    return { enabled: true, policy: v.policy, source: "stored" };
  }
  if (opts.orDefaults) {
    // The switch is off but a stored (disabled) config may exist — preview with it when valid.
    const s = await getAutomation(REMINDERS_KEY);
    const row = s.missing ? null : await prisma.programAutomation.findUnique({ where: { key: REMINDERS_KEY }, select: { configJson: true } });
    if (row?.configJson) {
      try { const v = validateReminderPolicy(JSON.parse(row.configJson)); if (v.ok) return { enabled: false, policy: v.policy, source: "stored" }; } catch { /* fall through to defaults */ }
    }
    return { enabled: false, policy: REMINDER_DEFAULTS, source: "defaults" };
  }
  return { enabled: false, policy: null, source: "off" };
}

// ---- business-time helpers (policy timezone) ---------------------------------

function zonedParts(at: Date, tz: string): { dow: number; minutes: number; dayKey: string } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(at)) o[p.type] = p.value;
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(o.hour) % 24;
  return { dow: DOW[o.weekday] ?? 0, minutes: hour * 60 + Number(o.minute), dayKey: `${o.year}-${o.month}-${o.day}` };
}
const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

export function inPolicyWindow(at: Date, p: ReminderPolicy): boolean {
  const z = zonedParts(at, p.timezone);
  if (!p.businessHours.days.includes(z.dow)) return false;
  return z.minutes >= hhmm(p.businessHours.start) && z.minutes < hhmm(p.businessHours.end);
}

/** The next instant the policy window opens at or after `at` (15-minute steps, ≤ 14 days out). */
export function nextPolicyWindowOpen(at: Date, p: ReminderPolicy): Date {
  let t = new Date(Math.ceil(at.getTime() / 900_000) * 900_000);
  for (let i = 0; i < 14 * 96; i++) {
    if (inPolicyWindow(t, p)) return t;
    t = new Date(t.getTime() + 900_000);
  }
  return t;
}

/** Business days between two instants on the ET calendar (weekends only; no holiday calendar in the program). */
// Kept as a named export for its callers; the arithmetic lives in datetime.ts
// with the rest of the business-day walk (audit S0, Sep 18).
import { businessDaysBetweenET as businessDaysBetween, endOfBusinessDaysET } from "@/lib/datetime";
export { businessDaysBetween };

// `monthStart` and `prevMonthKey` retired here on Sep 21 2026 (F20): they only
// ever served the "14 days before the month, deadline the 25th of the month
// before" cadence, which §12 replaced with monthlyCalendar() below. Nothing
// outside this file ever read them.
const currentMonthKey = (now: Date) => etDayKey(now).slice(0, 7);
const fmtDay = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" }) : null);

// ---- ET day-key arithmetic for the §12 calendar ------------------------------
// Day keys, never millisecond addition: "the 15th" is a date on the ET calendar
// and a clock change must not be able to move it (datetime.ts §S0, Sep 18).

const dowOfKey = (key: string) => new Date(`${key}T12:00:00Z`).getUTCDay();
const shiftKey = (key: string, days: number) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
};
const isWeekendKey = (key: string) => dowOfKey(key) === 0 || dowOfKey(key) === 6;

/** §12: "1st/15th on a weekend → move that action to the next weekday." */
export function nextWeekdayKeyET(key: string): string {
  let k = key;
  for (let i = 0; i < 7 && isWeekendKey(k); i++) k = shiftKey(k, 1);
  return k;
}

/** §8's opposite rule, for the missing-address reminder only: "Monday filming
 *  produces a Friday reminder, never a Saturday reminder." */
export function previousWeekdayKeyET(key: string): string {
  let k = key;
  for (let i = 0; i < 7 && isWeekendKey(k); i++) k = shiftKey(k, -1);
  return k;
}

/**
 * A23 — THE SESSION GAP, AS A COUNT. Pure, so the acceptance drill can put a
 * Pro month in front of it without a fixture in the live database (there is
 * exactly ONE Pro enrollment on the roster and it is paused, and Aryeo has never
 * carried a single Pro order, so the two-session path cannot be exercised from
 * production data alone).
 *
 * "One booked or filmed session does not satisfy two" is the whole rule: the
 * package says how many are owed, and booking or filming one of them leaves the
 * others outstanding. A request the office has not answered covers one missing
 * session each; two missing and one requested still leaves one to ask about.
 */
export function sessionGap(input: { sessionsRequired: number; sessionsBooked: number; sessionsFilmed: number; pendingSessionRequests: number }): {
  required: number; accountedFor: number; missing: number;
  action: "BOOK_SESSION" | null; ordinal: number | null; suppression: "pending_session_request" | null;
} {
  const required = Math.max(1, input.sessionsRequired);
  const accountedFor = input.sessionsBooked + input.sessionsFilmed;
  const missing = Math.max(0, required - accountedFor);
  if (missing === 0) return { required, accountedFor, missing, action: null, ordinal: null, suppression: null };
  if (input.pendingSessionRequests >= missing) return { required, accountedFor, missing, action: null, ordinal: null, suppression: "pending_session_request" };
  return { required, accountedFor, missing, action: "BOOK_SESSION", ordinal: accountedFor + 1, suppression: null };
}

/**
 * A28 — WHO MUST NOT GET THE ROLL-OVER WARNING. Pure for the same reason.
 *
 * The first paid production cycle is exempt from use-it-or-lose-it and from
 * forfeiture (§3), and work that carried into a month for a reason nobody has
 * written down might be work WE owe, which is never forfeited either. In both
 * cases the client hears nothing about losing anything and Kyle gets the
 * follow-up, with the task saying plainly that the client is not at fault.
 */
export function midMonthExemption(input: { firstCycle: boolean; carryoverUnclassified: number }): "first_cycle_exempt" | "catch_up_owed" | null {
  if (input.firstCycle) return "first_cycle_exempt";
  if (input.carryoverUnclassified > 0) return "catch_up_owed";
  return null;
}

export type ReminderMilestone = "MONTH_OPEN" | "FOLLOW_UP_1" | "FOLLOW_UP_2" | "MID_MONTH" | "OFF_CALENDAR";
export type ReminderLane = "PRIMARY" | "REVIEW" | "ADDRESS";

export type MonthlyCalendar = {
  /** The 1st of the program month, weekend-adjusted, at the policy's opening hour. */
  monthOpenAt: Date;
  /** The 15th, weekend-adjusted, at the policy's opening hour. */
  midMonthAt: Date;
  /** THE INTERNAL CLOCK, 5 pm ET on the mid-month day. It is what the
   *  escalation threshold measures against ("this month is running out of
   *  room, hand it to Kyle"). It is never shown to a client. */
  planningDeadlineAt: Date;
  /** THE CLIENT-FACING DATE, or null when Jordan has not set one — which is the
   *  default, because §12 establishes milestones and no quoted deadline
   *  (F20 review, Sep 21 2026). */
  quotedPlanningDeadlineAt: Date | null;
};

/** The dated milestones of one program month. Follow-ups are NOT here: §12
 *  anchors them on the instant the previous reminder actually sent, which is a
 *  fact about the ledger, not about the calendar. */
export function monthlyCalendar(monthKey: string, p: ReminderPolicy): MonthlyCalendar {
  const [h, m] = p.businessHours.start.split(":").map(Number);
  const day = (n: number) => nextWeekdayKeyET(`${monthKey}-${String(Math.min(Math.max(n, 1), 28)).padStart(2, "0")}`);
  return {
    monthOpenAt: etAt(day(p.monthlyOpenDayOfMonth), h, m),
    midMonthAt: etAt(day(p.midMonthDayOfMonth), h, m),
    // ONE NUMBER USED TO DO BOTH OF THESE (F20 review, Sep 21 2026). The
    // internal escalation clock is anchored on the mid-month milestone, which is
    // where §12 itself says the month starts running out of room; the date a
    // client is told is a separate, deliberate setting that defaults to "none",
    // so introducing the 15th milestone cannot move a client-facing promise.
    planningDeadlineAt: etAt(day(p.midMonthDayOfMonth), 17),
    quotedPlanningDeadlineAt: p.quotedPlanningDeadlineDayOfMonth == null ? null : etAt(day(p.quotedPlanningDeadlineDayOfMonth), 17),
  };
}

/**
 * §8: the missing-address reminder for a session starting at `shootStart`.
 * 48 ELAPSED hours before filming (this clock is not the weekday-time one the
 * preparation window uses — §8 is explicit that they are different clocks), and
 * if that instant lands on a Saturday or Sunday it moves BACK to the Friday, at
 * the policy's opening hour. Monday filming therefore produces a Friday
 * reminder, never a Saturday one.
 *
 * Returns null when the moment has already passed — §8's answer there is "send
 * at the next valid office opportunity and flag Kyle if urgent", which is the
 * caller's decision, not this function's.
 */
export function addressReminderAt(shootStart: Date, p: ReminderPolicy): Date {
  const raw = new Date(shootStart.getTime() - p.addressReminderHoursBefore * 3_600_000);
  const key = etDayKey(raw);
  if (!isWeekendKey(key)) return raw;
  const [h, m] = p.businessHours.start.split(":").map(Number);
  return etAt(previousWeekdayKeyET(key), h, m);
}

// ---- what the evaluator reads per month --------------------------------------

export type EvaluatedState = {
  strategyCallStatus: string;
  planningMode: string;
  preparationStatus: string | null;
  callMode: string;
  earliestSessionAt: string | null;
  /** Kept as they were so an old ledger row and a new one read the same way;
   *  every DECISION below now uses the counts underneath them. */
  sessionBooked: boolean;
  sessionFilmed: boolean;
  pendingSessionRequest: boolean;
  // ---- per-session completeness (A23, Sep 21 2026) --------------------------
  /** The package's sessions for this month: Starter 1, Accelerator 1, Pro 2. */
  sessionsRequired: number;
  sessionsBooked: number;
  sessionsFilmed: number;
  sessionsAccountedFor: number;
  sessionsMissing: number;
  /** Requests waiting on the OFFICE, which are not the client's to chase. */
  pendingSessionRequests: number;
  /** Jordan, Sep 21 2026: every session the package owes is a DISTINCT confirmed
   *  session. One Pro booking leaves this false with one session remaining. */
  fullyScheduled: boolean;
  /** The last time this month LOST a session (a cancelled request, a cancelled
   *  appointment). Reminders written before it no longer count against the ask,
   *  so a re-opened gap is chased again instead of going quiet for good. */
  sessionLostAt: string | null;
  releasedCutsAwaiting: number;
  oldestReleaseAt: string | null;
  /** CP-02: the earliest OPEN review window's PERSISTED deadline — the same
   *  instant the portal shows and enforcement uses. Never recomputed here. */
  reviewDeadlineAt?: string | null;
  /** CP-02: `r<YYYYMMDD>` of the earliest open window's release. The review
   *  cadence belongs to that batch of releases, not to the month. */
  reviewTag?: string | null;
  snoozedUntil: string | null;
  enrollmentStatus: string;
  schedulerSync: { fresh: boolean; detail: string };
  /** The Aryeo appointment feed's freshness — "no session is booked" is only as
   *  true as the feed that would have told us it was (§12). */
  sessionFeed: { fresh: boolean; detail: string };
  /** This is the enrollment's FIRST paid production cycle (§3, A28). */
  firstCycle: boolean;
  /** Work carried into this month whose cause nobody has classified yet. */
  carryoverUnclassified: number;
};

export type ReminderDecision = "send" | "wait" | "suppressed" | "none" | "escalate";

export type ReminderCandidate = {
  enrollmentId: string;
  clientId: string;
  clientName: string;
  isTest: boolean;
  monthId: string;
  monthKey: string;
  /** Which cadence this candidate belongs to (§12 keeps them apart). */
  lane: ReminderLane;
  /** Where it sits on §12's dated calendar. REVIEW and ADDRESS are OFF_CALENDAR. */
  milestone: ReminderMilestone;
  /** BOOK_SESSION only: the 1-based session this reminder is chasing, so
   *  booking session 1 does not spend session 2's reminders (A23). */
  sessionOrdinal: number | null;
  action: ReminderAction | null;
  templateKey: string | null;
  attempt: number;
  dedupeKey: string | null;
  /** Masked for display; the raw address stays inside the evaluator. */
  to: string | null;
  decision: ReminderDecision;
  reason: string;
  suppressionReason: string | null;
  nextEligibleAt: Date | null;
  /** The INTERNAL deadline this lane is measured against (escalation, the
   *  preview, the panel). Not client-facing. */
  deadlineAt: Date | null;
  /** The date this message would QUOTE to the client, or null when it quotes
   *  none. The templates render this one and never `deadlineAt` (F20 review,
   *  Sep 21 2026). */
  quotedDeadlineAt: Date | null;
  noCallEligible: boolean;
  digestSession: boolean;
  /** COMPLETE_ANSWERS: the interview has begun (wording changes). */
  answersStarted: boolean;
  /** An existing FAILED row this send would retry, instead of a new attempt. */
  retryOfId: string | null;
  escalation: { due: boolean; reason: string } | null;
  /** The §12 calendar this month is running on, for the preview and the panel. */
  calendar: MonthlyCalendar | null;
  /** MID_MONTH only: the follow-up Kyle gets whether or not the client is written to. */
  kyleFollowUp: { due: boolean; reason: string } | null;
  /** The extra paragraph this particular milestone adds to the template's body. */
  extraParagraph: string | null;
  /** CP-08: where the portal link lands (`?tab=topics&iv=<id>`) when this reminder is a follow-up on specific open questions. */
  linkPath?: string | null;
  /** REVIEW lane (CP-02): the release batch this candidate chases, `r<YYYYMMDD>`. */
  reviewTag?: string | null;
  state: EvaluatedState;
};

type EnrollmentRow = {
  id: string; clientId: string; status: string; callMode: string | null; strategyCallRequired: boolean; noCallEligible: boolean | null;
  portalToken: string | null; portalTokenExpiresAt: Date | null; accessRevokedAt: Date | null;
  /** A23: how many sessions this package owes per month (Pro = 2). */
  sessionsPerMonth: number;
  /** A23: the month's planned videos, so "four videos in this session" is read
   *  off the package rather than written into a sentence. Three live
   *  Accelerators carry a manual override of 5 that §3 says must survive. */
  videosPerMonth: number;
  /** A28: the first program month this enrollment ever had — its first paid
   *  production cycle, which never receives a use-it-or-lose-it warning. */
  firstMonthKey: string | null;
  client: { name: string; email: string | null };
};

const ENROLLMENT_SELECT = {
  id: true, clientId: true, status: true, callMode: true, strategyCallRequired: true, noCallEligible: true,
  portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true, sessionsPerMonth: true, videosPerMonth: true, startedAt: true,
} as const;

/** The enrollment's first paid production cycle: whichever is EARLIER, the
 *  month it started billing in or the first program month on file. Read once
 *  per run and carried on the row, because "is this their first month?" is
 *  asked for every month of every enrollment.
 *
 *  Backfilled (historical) months count here on purpose. They are evidence the
 *  client has been through a cycle already, and the mistake to avoid is telling
 *  a long-standing client "you are exempt": the exemption exists for someone who
 *  has never done this before, not for someone whose early months were imported
 *  rather than run through the hub. */
async function firstMonthKeysFor(enrollmentIds: string[], startedAt: Map<string, Date | null>): Promise<Map<string, string | null>> {
  const rows = enrollmentIds.length
    ? await prisma.contentMonth.groupBy({ by: ["enrollmentId"], where: { enrollmentId: { in: enrollmentIds } }, _min: { monthKey: true } })
    : [];
  const out = new Map<string, string | null>();
  for (const id of enrollmentIds) {
    const earliestMonth = rows.find((r) => r.enrollmentId === id)?._min.monthKey ?? null;
    const started = startedAt.get(id) ?? null;
    const startedKey = started ? etDayKey(started).slice(0, 7) : null;
    const candidates = [earliestMonth, startedKey].filter((k): k is string => !!k).sort();
    out.set(id, candidates[0] ?? null);
  }
  return out;
}

type SchedulerSync = { fresh: boolean; detail: string };
/** Two different feeds answer two different questions: Calendly says whether a
 *  strategy CALL is booked, Aryeo says whether a filming SESSION is. Chasing a
 *  client off a stale feed is the inaccuracy §12 forbids, so each is checked
 *  against the lane that depends on it. */
type BookingFeeds = { call: SchedulerSync; session: SchedulerSync };

/** Booking truth is only as fresh as the verified call chain. Until an
 *  ENABLED monthly mapping exists and has synced inside the policy window,
 *  "not booked" is a guess — and a guess never earns a client a reminder. */
async function schedulerSyncState(now: Date, p: ReminderPolicy): Promise<SchedulerSync> {
  const conn = await prisma.connection.findUnique({ where: { provider: "calendly" }, select: { status: true, lastError: true } }).catch(() => null);
  if (!conn || conn.status !== "CONNECTED") return { fresh: false, detail: "Calendly is not connected" };
  const mappings = await prisma.programCalendlyEventMapping.findMany({ where: { purpose: "MONTHLY_STRATEGY", enabled: true }, select: { lastSyncedAt: true, lastError: true, validationStatus: true } });
  if (mappings.length === 0) return { fresh: false, detail: "no enabled monthly-strategy Calendly mapping has synced yet (Settings → Calendly & calls)" };
  const newest = mappings.reduce<Date | null>((m, r) => (r.lastSyncedAt && (!m || r.lastSyncedAt > m) ? r.lastSyncedAt : m), null);
  if (!newest) return { fresh: false, detail: "the monthly-strategy mapping has never synced" };
  const ageH = (now.getTime() - newest.getTime()) / 3_600_000;
  if (ageH > p.staleSchedulerSyncHours) return { fresh: false, detail: `the last Calendly sync was ${ageH.toFixed(1)} h ago (limit ${p.staleSchedulerSyncHours} h)` };
  if (mappings.some((m) => m.lastError)) return { fresh: false, detail: `the last Calendly sync reported an error: ${mappings.find((m) => m.lastError)?.lastError}` };
  if (mappings.some((m) => m.validationStatus === "MISSING")) return { fresh: false, detail: "a mapped Calendly event type is missing on the account" };
  return { fresh: true, detail: `synced ${ageH.toFixed(1)} h ago` };
}

/** The same rule for FILMING sessions, whose truth comes from Aryeo. Telling a
 *  client "you still have not booked your session" while the appointment feed
 *  is dark is the Sep 8 shape again — the integration goes quiet and the client
 *  gets blamed for it. A stale feed holds the reminder and raises the internal
 *  exception instead (§12). */
async function sessionFeedState(now: Date, p: ReminderPolicy): Promise<SchedulerSync> {
  const conn = await prisma.connection.findUnique({ where: { provider: "aryeo" }, select: { status: true, lastSyncedAt: true, lastError: true } }).catch(() => null);
  if (!conn) return { fresh: false, detail: "there is no Aryeo connection on file" };
  if (conn.status !== "CONNECTED") return { fresh: false, detail: `Aryeo is ${conn.status.toLowerCase()}` };
  if (!conn.lastSyncedAt) return { fresh: false, detail: "the Aryeo sync has never recorded a run" };
  const ageH = (now.getTime() - conn.lastSyncedAt.getTime()) / 3_600_000;
  if (ageH > p.staleSchedulerSyncHours) return { fresh: false, detail: `the last Aryeo sync was ${ageH.toFixed(1)} h ago (limit ${p.staleSchedulerSyncHours} h)` };
  if (conn.lastError) return { fresh: false, detail: `the last Aryeo sync reported an error: ${conn.lastError.slice(0, 120)}` };
  return { fresh: true, detail: `synced ${ageH.toFixed(1)} h ago` };
}

async function bookingFeeds(now: Date, p: ReminderPolicy): Promise<BookingFeeds> {
  const [call, session] = await Promise.all([schedulerSyncState(now, p), sessionFeedState(now, p)]);
  return { call, session };
}

/**
 * ARYEO'S OWN LAST-CHANGE STAMP for an appointment, out of the payload we store
 * verbatim in `Appointment.rawJson` (integrations/aryeo.ts:4134).
 *
 * The one durable time an appointment carries. Our `updatedAt` is rewritten by
 * every hourly sync pass; this one moves only when the appointment changes at
 * the provider, so on a CANCELED row it dates the cancellation. Undated and
 * unparseable rows answer null on purpose: "we do not know when this was lost"
 * must never be answered with "just now", which is the defect this replaced.
 */
function aryeoLastChangedAt(rawJson: string | null): Date | null {
  if (!rawJson) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const updatedAt = (parsed as { updated_at?: unknown } | null)?.updated_at;
    if (typeof updatedAt !== "string") return null;
    const d = new Date(updatedAt);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * WHAT THIS MONTH ACTUALLY HAS, COUNTED (A23, Sep 21 2026).
 *
 * This used to answer in booleans — "something is booked", "something was
 * filmed" — and a Pro month with ONE of its two four-hour sessions on the
 * calendar therefore looked exactly like a fully booked Accelerator month: the
 * evaluator said "nothing left to book" and the second session was never
 * chased. §12 is explicit that one booked or filmed session does not satisfy
 * two, so the answer is now a count against the package's `sessionsPerMonth`.
 *
 * A session is accounted for by a Project with a shoot date (the Aryeo
 * appointment) or by a CONFIRMED request that has not become one yet. A
 * confirmed request that already points at a counted project is the SAME
 * session seen twice, so it is not added again.
 */
async function monthFacts(monthId: string, clientId: string, now: Date, sessionsRequired: number) {
  const [projects, requests, carryover, count, lostRequests] = await Promise.all([
    prisma.project.findMany({ where: { contentMonthId: monthId, status: { not: "CANCELLED" } }, select: { id: true, shootDate: true, status: true, addressLine: true } }),
    prisma.programSessionRequest.findMany({ where: { monthId, status: { in: ["REQUESTED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED", "CONFIRMED"] } }, select: { id: true, status: true, projectId: true, aryeoAppointmentId: true, supersedesId: true } }),
    // Work that arrived in this month from an earlier one. Whether the client
    // did not film it or WE were late is not recorded anywhere, and §3 says to
    // hand an unclear shortfall to Kyle rather than invent the answer — so the
    // count is all this needs to be.
    prisma.contentVideo.count({ where: { monthId, kind: "CARRYOVER" } }),
    // A23 (Jordan, Sep 21 2026). This used to count PROJECTS with a shoot date.
    // Video Pro is the existing four-hour product booked TWICE, which is two
    // appointments on ONE order and therefore one Project here — so a Pro month
    // with both sessions on the calendar counted as one, and the evaluator went
    // on chasing a session that was already booked. The rule now lives in
    // programMonths.countDistinctSessions and the portal's capacity reads the
    // same function, so the chaser and the client's own screen cannot disagree.
    // CP-10: read through the one month-progress reader, so the chaser counts
    // exactly what the roster, the client file and portal Home show. Held
    // semantics are unchanged; an UNCONFIRMED filming is a staff-only unknown
    // there and never a client reminder here. (Dynamic: that reader pulls in
    // the library and the release rule, which this module must not load eagerly.)
    import("@/lib/monthProgress").then((m) => m.monthBookedSessions(monthId, clientId, now)),
    // WHEN A SESSION WAS LAST LOST (Jordan, Sep 21 2026: the reminders "must
    // stop when the condition actually resolves, including a cancellation that
    // takes a month back to one confirmed session"). Stopping is the easy half;
    // the hard half is STARTING AGAIN. A Pro month that spent its second
    // session's three reminders, got booked, and then had that booking
    // cancelled would have gone permanently quiet, because the cadence counts
    // rows and the rows were already there. So a cancellation is a fact with a
    // time, and reminders written before it no longer count against the ask.
    //
    // ONLY A REQUEST THAT WAS ACTUALLY A BOOKING COUNTS AS A LOSS (review, Sep
    // 21 2026). The set used to include EXPIRED and DECLINED, and every
    // CANCELLED row whether or not it had ever been confirmed. None of those is
    // a lost booking: EXPIRED is a client ask nobody answered in time, DECLINED
    // is the office saying no, and a CANCELLED row with no `confirmedAt` is a
    // client withdrawing their own pending ask. Treating any of them as a loss
    // would wipe the cadence and re-ask a client who was never booked in the
    // first place. `confirmedAt` is the one column that says a session existed.
    // (ProgramSessionRequest holds 0 rows today — the program is pre-launch —
    // so this is the rule the first real row will meet, measured against the
    // writer in sessionRequests.confirmSessionRequest rather than against data.)
    prisma.programSessionRequest.findMany({ where: { monthId, status: "CANCELLED", confirmedAt: { not: null } }, select: { cancelledAt: true, updatedAt: true } }),
  ]);
  const addressByProject = new Map(projects.map((p) => [p.id, p.addressLine]));
  const shortfall = sessionShortfall(sessionsRequired, count);
  const sessionsBooked = count.booked;
  const sessionsFilmed = count.filmed;
  const sessionsAccountedFor = count.accountedFor;
  const countedKeys = new Set(count.sessions.map((x) => x.key));
  // A request the CLIENT has made and the office has not answered is not the
  // client's to chase. One that already resolves to a counted session is that
  // session seen twice, not an extra ask. A cancel request is about a session
  // that is still on the calendar, so it holds no missing slot of its own.
  const pendingSessionRequests = requests.filter(
    (r) => (r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED") &&
      !replacesPendingMove(r, requests) &&
      !(r.aryeoAppointmentId && countedKeys.has(`appt:${r.aryeoAppointmentId}`)) &&
      !(r.projectId && countedKeys.has(`project:${r.projectId}`)),
  ).length;
  const cancelRequested = requests.filter((r) => r.status === "CANCEL_REQUESTED").length;
  // THE REVIEW LANE READS THE REVIEW WINDOWS (CP-02, Sep 24 2026). It used to
  // select ReviewSubmission rows with clientReleasedAt set — a column nothing
  // wrote — so it counted zero, always, and review reminders could never fire.
  // The windows are OPEN until the client decides, carry their deadline frozen
  // at release, and a LAZY window (released before windows were recorded) is
  // never chased: nobody told that client about a clock.
  const { reviewLaneFacts } = await import("@/lib/reviewWindows");
  const review = await reviewLaneFacts(projects.map((p) => p.id));
  const oldest = review.oldestOpenedAt;
  // A cancelled APPOINTMENT is the other way a month loses a session, and
  // dating it is where the first version of this went wrong.
  //
  // IT USED TO READ `Appointment.updatedAt` (review, Sep 21 2026). That column
  // is @updatedAt on a row the Aryeo sync rewrites unconditionally on every
  // pass — `prisma.appointment.upsert({ update: fields })`,
  // integrations/aryeo.ts:4136, hourly, over recent plus all future and undated
  // rows. Measured against production that hour: 1150 of 1573 appointment rows
  // had `updatedAt` inside the last 3 hours, and 21 of the 39 CANCELED ones
  // did. So on any month holding a cancellation the loss stamp walked forward
  // to ~now every hour, every earlier reminder read as "written before the
  // loss", and the re-open this block exists for could never fire.
  //
  // Aryeo's own `updated_at`, kept verbatim in `rawJson`, is the durable stamp:
  // it moves only when the appointment actually changes AT THE PROVIDER. Same
  // measurement: 1505 of 1534 live rows carry an Aryeo `updated_at` more than 7
  // days old while our own column says minutes. And it is the cancellation it
  // dates — on all 6 CANCELED appointments that also have a one-per-transition
  // cancellation bell on file (notify dedupeKey `appt-<id>-canceled`, which is
  // never rewritten), 5 match the bell to within 20 seconds and the 6th is 4
  // days later because that appointment was touched again at Aryeo afterwards.
  //
  // So: the provider's last-change time, never ours. It is read only as "the
  // loss happened no earlier than here" and is never quoted to anyone.
  const cancelledAppts = projects.length
    ? await prisma.appointment.findMany({ where: { projectId: { in: projects.map((p) => p.id) }, status: "CANCELED" }, select: { rawJson: true } })
    : [];
  const sessionLostAt = [...lostRequests.map((r) => r.cancelledAt ?? r.updatedAt), ...cancelledAppts.map((a) => aryeoLastChangedAt(a.rawJson))]
    .filter((d): d is Date => d instanceof Date && !isNaN(d.getTime()))
    .reduce<Date | null>((m, d) => (!m || d > m ? d : m), null);
  return {
    sessionBooked: sessionsBooked > 0,
    sessionFilmed: sessionsFilmed > 0,
    pendingSessionRequest: pendingSessionRequests + cancelRequested > 0,
    sessionsRequired: shortfall.required,
    sessionsBooked,
    sessionsFilmed,
    sessionsAccountedFor,
    sessionsMissing: shortfall.missing,
    fullyScheduled: shortfall.fullyScheduled,
    sessionLostAt,
    pendingSessionRequests,
    carryoverUnclassified: carryover,
    releasedCutsAwaiting: review.count,
    oldestReleaseAt: oldest,
    reviewDeadlineAt: review.deadlineAt,
    reviewTag: review.tag,
    reviewWindows: review.windows,
    /** Upcoming sessions and where they say they are. (Since CP-05 the ADDRESS
     *  lane reads sessionAddress.upcomingProgramSessions, which carries each
     *  session's identity and order; this stays for the facts snapshot.)
     *  PER SESSION, not per project: a Pro month's two four-hour legs are two
     *  filming days at two addresses, and one row for the order would have asked
     *  about one of them (§8). `startsAt`, never the end, because the reminder
     *  counts 48 elapsed hours back from when filming BEGINS. */
    upcomingShoots: count.sessions
      // A confirmed request with no project behind it yet has nothing to attach
      // an address to, so it is not an address-lane row — an empty projectId in
      // a preview is a row nobody can act on.
      .filter((x): x is typeof x & { startsAt: Date; projectId: string } => !x.filmed && !!x.startsAt && !!x.projectId)
      .map((x) => ({ projectId: x.projectId, shootDate: x.startsAt, addressLine: x.addressLine ?? addressByProject.get(x.projectId) ?? null })),
  };
}

/** The live OWNER seat's address first (the person the portal knows), else the client record's. */
async function recipientFor(e: EnrollmentRow): Promise<{ email: string; membershipId: string | null; clientUserId: string | null } | null> {
  const seats = await prisma.clientMembership.findMany({ where: { enrollmentId: e.id, revokedAt: null }, select: { id: true, clientUserId: true, role: true }, orderBy: { invitedAt: "asc" } });
  const owner = seats.find((s) => s.role === "OWNER") ?? seats[0] ?? null;
  if (owner) {
    const u = await prisma.clientUser.findUnique({ where: { id: owner.clientUserId }, select: { email: true, status: true } });
    if (u && u.status !== "DISABLED" && u.email) return { email: u.email, membershipId: owner.id, clientUserId: owner.clientUserId };
  }
  const email = (e.client.email ?? "").trim().toLowerCase();
  if (email) return { email, membershipId: null, clientUserId: null };
  return null;
}

/** {portalLink}: an authenticated sign-in link for the seat holder, else the
 *  enrollment's token page for a token-era client. Minting a login link voids
 *  the person's previous one, so while THEY hold a live link (asked for it in
 *  the last 15 minutes) the token page is used instead of cutting them off. */
export async function resolvePortalLink(e: Pick<EnrollmentRow, "id" | "portalToken" | "portalTokenExpiresAt" | "accessRevokedAt">, seat: { membershipId: string | null; clientUserId: string | null } | null, byAppUserId: string | null, now: Date, opts: { path?: string | null } = {}): Promise<{ url: string; kind: "login" | "token" } | null> {
  // CP-08: a follow-up can land on the open questions themselves. Only the one
  // shape the sign-in route will honour is ever appended; anything else is the
  // plain link.
  const path = opts.path && /^\?tab=topics&iv=[a-z0-9]{10,40}$/.test(opts.path) ? opts.path : null;
  const tokenLink = e.portalToken && !e.accessRevokedAt && (!e.portalTokenExpiresAt || e.portalTokenExpiresAt > now) ? `${appBase()}/portal/${e.portalToken}${path ?? ""}` : null;
  if (seat?.membershipId && seat.clientUserId) {
    const u = await prisma.clientUser.findUnique({ where: { id: seat.clientUserId }, select: { loginTokenExpiresAt: true } });
    const holdsLiveLink = !!u?.loginTokenExpiresAt && u.loginTokenExpiresAt > now;
    if (!holdsLiveLink) {
      try {
        const { url } = await mintLoginLink(seat.membershipId, byAppUserId);
        return { url: path ? `${url}?next=${encodeURIComponent(`/portal/me${path}`)}` : url, kind: "login" };
      } catch {
        // Real client while portal_login_email is off, or a revoked seat: fall through to the token page.
      }
    }
  }
  return tokenLink ? { url: tokenLink, kind: "token" } : null;
}

// ---- the derivation: one month, one lane → one candidate ------------------------

/** The client-facing paragraph a milestone adds on top of its template. The
 *  templates live in reminderTemplates.ts and are not this batch's to edit, so
 *  the sentence is inserted ABOVE the template's sign-off — which is the one
 *  line every template ends with, by construction. If the marker ever moves the
 *  paragraph lands before the sign-off block anyway, never after it. */
export function withExtraParagraph(body: string, paragraph: string | null): string {
  if (!paragraph) return body;
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.startsWith("— Jordan"));
  if (at < 0) return `${body}\n\n${paragraph}`;
  const before = lines.slice(0, at);
  while (before.length && before[before.length - 1].trim() === "") before.pop();
  return [...before, "", paragraph, "", ...lines.slice(at)].join("\n");
}

/** §12's roll-over note. No em dashes, no emojis, and it ends with the way
 *  forward — Jordan's rule for anything a client reads. */
export const MID_MONTH_PARAGRAPH =
  "One note on timing: your monthly sessions do not roll over into next month, and the calendar fills up as the month goes on. Picking your time this week is the surest way to get the slot you want.";

/** A23: the second Pro session is a different ask from the first, and the
 *  template cannot tell them apart on its own.
 *
 *  The video count comes from the PACKAGE, not from the word "four". Pro is 8
 *  videos across 2 sessions today, but three live Accelerator enrollments carry
 *  a manual videosPerMonth of 5 that §3 says must survive reconciliation, so a
 *  hard-coded four is a sentence that can become untrue without anyone touching
 *  this file. No em dashes and it ends with the way forward (Jordan's rule). */
export const secondSessionParagraph = (ordinal: number, required: number, videosPerMonth: number) => {
  const perSession = Math.max(1, Math.ceil(Math.max(0, videosPerMonth) / Math.max(1, required)) || 1);
  const done = ordinal - 1;
  return `Your package includes ${required === 2 ? "two filming sessions" : `${required} filming sessions`} this month, and ${done === 1 ? "one is" : `${done} are`} already on the calendar. This one is about session ${ordinal} of ${required}, which is another ${perSession} video${perSession === 1 ? "" : "s"}. Pick a time in your portal and we'll confirm it.`;
};

/** Which sub-lane of the ledger a row belongs to. The dedupeKey carries it:
 *  `enrollment:month:action[:sN][:rYYYYMMDD][:mid|:copy|:retry]:sequence`. Rows
 *  written before Sep 21 2026 have no tag at all, which reads correctly as
 *  session 1 on the ordinary cadence. A REVIEW_WORK row written before CP-02
 *  (Sep 24 2026) has no review tag and reads as "legacy" — which the review
 *  cadence counts against EVERY batch, so a month in flight cannot re-send. */
function ledgerLaneOf(dedupeKey: string | null, enrollmentId: string, monthKey: string, action: string): { midMonth: boolean; sessionTag: string; manual: boolean; reviewTag: string } {
  const prefix = `${enrollmentId}:${monthKey}:${action}:`;
  const rest = dedupeKey && dedupeKey.startsWith(prefix) ? dedupeKey.slice(prefix.length) : "";
  const segs = rest.split(":");
  return {
    midMonth: segs.includes("mid"),
    sessionTag: segs.find((s) => /^s\d+$/.test(s)) ?? "s1",
    manual: segs[0] === "copy" || segs[0] === "retry",
    reviewTag: segs.find((s) => /^r\d{8}$/.test(s)) ?? "legacy",
  };
}

/** `ignoreReminderId`: the row THIS dispatch already wrote. The recheck asks
 *  "is the CLIENT's state still the one that earned a reminder?", so our own
 *  in-flight attempt must not count as an attempt already made — otherwise a
 *  policy of maxAttemptsPerAction 1 would re-read its own PENDING row, decide
 *  the quota was spent, and suppress the very send it just authorised. */
async function evaluateMonth(
  e: EnrollmentRow,
  month: { id: string; monthKey: string; status: string; remindersSnoozedUntil: Date | null },
  now: Date,
  p: ReminderPolicy,
  feeds: BookingFeeds,
  clientWindowOpen: boolean,
  lane: "PRIMARY" | "REVIEW",
  ignoreReminderId?: string | null,
): Promise<ReminderCandidate> {
  const isTest = isTestClientName(e.client.name);
  const cal = monthlyCalendar(month.monthKey, p);
  const base = {
    enrollmentId: e.id, clientId: e.clientId, clientName: e.client.name, isTest, monthId: month.id, monthKey: month.monthKey,
    lane: lane as ReminderLane, milestone: "OFF_CALENDAR" as ReminderMilestone, sessionOrdinal: null as number | null,
    templateKey: null as string | null, attempt: 0, dedupeKey: null as string | null, to: null as string | null, nextEligibleAt: null as Date | null,
    deadlineAt: null as Date | null, quotedDeadlineAt: null as Date | null,
    noCallEligible: false, digestSession: false, answersStarted: false, retryOfId: null as string | null, escalation: null as ReminderCandidate["escalation"],
    calendar: cal, kyleFollowUp: null as ReminderCandidate["kyleFollowUp"], extraParagraph: null as string | null,
  };
  // Authoritative month state, derived fresh (never persisted from here).
  const recalc = await recalcProgramMonth(month.id, { now, dryRun: true });
  const d: DerivedMonthState | null = recalc?.after ?? null;
  const facts = await monthFacts(month.id, e.clientId, now, e.sessionsPerMonth);
  const firstCycle = !!e.firstMonthKey && e.firstMonthKey === month.monthKey;
  const state: EvaluatedState = {
    strategyCallStatus: d?.strategyCallStatus ?? "?", planningMode: d?.planningMode ?? "?", preparationStatus: d?.preparationStatus ?? null, callMode: d?.callMode ?? "?",
    earliestSessionAt: d?.earliestSessionAt?.toISOString() ?? null,
    sessionBooked: facts.sessionBooked, sessionFilmed: facts.sessionFilmed, pendingSessionRequest: facts.pendingSessionRequest,
    sessionsRequired: facts.sessionsRequired, sessionsBooked: facts.sessionsBooked, sessionsFilmed: facts.sessionsFilmed,
    sessionsAccountedFor: facts.sessionsAccountedFor, sessionsMissing: facts.sessionsMissing, pendingSessionRequests: facts.pendingSessionRequests,
    fullyScheduled: facts.fullyScheduled, sessionLostAt: facts.sessionLostAt?.toISOString() ?? null,
    releasedCutsAwaiting: facts.releasedCutsAwaiting, oldestReleaseAt: facts.oldestReleaseAt?.toISOString() ?? null,
    reviewDeadlineAt: facts.reviewDeadlineAt?.toISOString() ?? null, reviewTag: facts.reviewTag,
    snoozedUntil: month.remindersSnoozedUntil?.toISOString() ?? null, enrollmentStatus: e.status,
    schedulerSync: feeds.call, sessionFeed: feeds.session, firstCycle, carryoverUnclassified: facts.carryoverUnclassified,
  };
  const out = (c: Partial<ReminderCandidate> & { action: ReminderAction | null; decision: ReminderDecision; reason: string }): ReminderCandidate =>
    ({ ...base, suppressionReason: null, state, ...c });

  if (!d) return out({ action: null, decision: "none", reason: "month or enrollment not found" });
  if (month.status !== "OPEN") return out({ action: null, decision: "none", reason: `month is ${month.status}` });

  // ---- the ONE action for THIS lane -----------------------------------------
  const callHeld = d.strategyCallStatus === "COMPLETED";
  const callBooked = d.strategyCallStatus === "SCHEDULED";
  // "Skip the strategy call this month" is an answer, not silence. It arrives
  // either as an explicit SKIPPED stamp or as the written path being chosen;
  // §12 says do not nag someone who chose it, so the call lane closes and only
  // the written-preparation lane stays open. (F20, Sep 21 2026: before this, a
  // month a staff member had marked SKIPPED while its planningMode was still
  // CALL or UNDECIDED went straight back to "grab a time for your call".)
  const callSkipped = d.strategyCallStatus === "SKIPPED";
  const prepComplete = d.preparationStatus === "PREPARING_SCRIPTS" || d.preparationStatus === "AWAITING_SCRIPT_APPROVAL" || d.preparationStatus === "READY_FOR_FILMING";
  const noCallEligible = d.callMode === "OPTIONAL_WRITTEN" ? (e.noCallEligible ?? true) : d.callMode === "NOT_INCLUDED";

  let action: ReminderAction | null = null;
  let planningSuppression: string | null = null;
  let answersStarted = false;
  let sessionSuppression: string | null = null;
  let sessionOrdinal: number | null = null;

  if (lane === "REVIEW") {
    // The review lane is deliberately independent of planning (§12): a client
    // who owes us answers can still be the client who owes us an approval, and
    // the two run on different clocks.
    if (facts.releasedCutsAwaiting > 0) action = "REVIEW_WORK";
  } else {
    // A month whose content sessions are ALL accounted for has nothing left to
    // plan — filming is terminal for the planning question, exactly the way a
    // held call is. Without this, a client whose September shoot happened on the
    // 11th and is sitting in EDITING would still be told "we still need to plan
    // your September content — grab a time for your strategy call": the
    // evaluator contradicting the facts it printed in the same object. (Found in
    // review Sep 17 against live data: Sarina Spinelli 2026-09, filmed 09-11.)
    // Read as a COUNT since Sep 21 (A23): a Pro month with one of two sessions
    // filmed is not a finished month, and the planning question there has
    // already been answered, so it falls through to the session branch.
    if (!prepComplete && !callHeld && facts.sessionsFilmed === 0) {
      if (callBooked) planningSuppression = "booked";
      else if (d.planningMode === "WRITTEN") { action = "COMPLETE_ANSWERS"; answersStarted = d.preparationStatus === "AWAITING_ANSWERS"; }
      else if (callSkipped) planningSuppression = "no_call_chosen";
      else if (d.callMode === "REQUIRED") action = "BOOK_CALL";
      else action = "CHOOSE_PATH";
    }
    if (!action && !planningSuppression) {
      const plannedEnough = prepComplete || callHeld || facts.sessionsAccountedFor > 0;
      const gap = sessionGap(facts);
      if (plannedEnough) {
        if (gap.suppression) sessionSuppression = gap.suppression;
        else if (gap.action) { action = gap.action; sessionOrdinal = gap.ordinal; }
      }
    }
  }
  const digestSession = !!action && ["CHOOSE_PATH", "BOOK_CALL", "COMPLETE_ANSWERS"].includes(action) && p.digestBothAppointments && facts.sessionsMissing > 0 && facts.pendingSessionRequests === 0;

  // ---- suppression (spec §24), in the order a person would ask ----------------
  const sup = (reason: string, why: string, withAction: ReminderAction | null = action, extra: Partial<ReminderCandidate> = {}) =>
    out({ action: withAction, decision: "suppressed", suppressionReason: reason, reason: why, noCallEligible, digestSession, answersStarted, sessionOrdinal, ...extra });
  if (e.status === "PAUSED") return sup("paused", "enrollment is paused");
  if (e.status === "ENDED") return sup("ended", "enrollment has ended");
  // Access deliberately cut off. The seat row is NOT revoked by revoking
  // enrollment access, so recipientFor would still find a live address and
  // resolvePortalLink would mint a fresh sign-in link — emailing (and
  // effectively re-inviting) someone we cut off, and voiding whatever live
  // login link they were holding. The share-notice drain already suppresses on
  // this; the evaluator must agree with it.
  if (e.accessRevokedAt) return sup("access_revoked", "portal access for this enrollment has been revoked");
  if (month.remindersSnoozedUntil && month.remindersSnoozedUntil > now) return sup("snoozed", `snoozed until ${month.remindersSnoozedUntil.toISOString()}`);
  if (planningSuppression === "booked") return sup("booked", "a strategy call is booked — nothing to remind", null);
  if (planningSuppression === "no_call_chosen") return sup("no_call_chosen", "this month's strategy call was skipped on purpose — we do not chase it", null);
  if (sessionSuppression) return sup(sessionSuppression, "a session request is waiting on the office, not the client", null);
  if (!action) {
    if (lane === "REVIEW") return out({ action: null, decision: "none", reason: "no released cut is waiting on this client" });
    // "already been filmed — nothing left to book" was read off sessionFilmed
    // alone, which is only "a shoot on this month is in the past". A month can
    // hold BOTH (Sarina Spinelli's 2026-09: filmed on the 11th, another booked
    // for the 19th) and the sentence then said the opposite of the calendar
    // (review, Sep 17). Say what is true of each.
    const filmedReason = facts.sessionsBooked > 0
      ? `${facts.sessionsFilmed} session(s) filmed this month and ${facts.sessionsBooked} more on the calendar — nothing to remind`
      : `all ${facts.sessionsRequired} session(s) for this month have been filmed — nothing left to plan or book`;
    return out({
      action: null, decision: "none", noCallEligible,
      reason: facts.sessionsFilmed > 0 ? filmedReason : prepComplete || callHeld ? (facts.sessionsMissing === 0 ? "planned and booked — nothing needed" : "nothing needed") : "nothing needed",
    });
  }
  // "Not booked" is only as true as the feed that would have told us it was.
  if ((action === "BOOK_CALL" || action === "CHOOSE_PATH") && !feeds.call.fresh) return sup("stale_scheduler_sync", `booking state is not trustworthy: ${feeds.call.detail}`);
  if (action === "BOOK_SESSION" && !feeds.session.fresh) return sup("stale_scheduler_sync", `appointment state is not trustworthy: ${feeds.session.detail}`);
  // THE PRE-LAUNCH LOCK SITS AHEAD OF THE CALENDAR ON PURPOSE. A real client
  // blocked here never reaches the mid-month branch, so no mid-month task is
  // raised for them either. That is deliberate for now — the whole program is
  // pre-launch — but it means Kyle's 15th-of-the-month list stays empty for real
  // clients until Jordan authorises client reminders, which is his call to make,
  // not this file's to assume (F20, Sep 21 2026).
  if (p.testClientsOnly && !isTest) return sup("launch_not_authorised", "policy.testClientsOnly is on — only TEST clients may receive until launch is authorised");

  // ---- the §12 calendar ---------------------------------------------------------
  const sessionTag = sessionOrdinal && sessionOrdinal > 1 ? `s${sessionOrdinal}` : "s1";
  // THE WHOLE MONTH'S LEDGER, not just this action's. The 15th is a milestone of
  // the MONTH (§12), and reading it per action let it fire twice: the ordinary
  // BOOK_CALL -> BOOK_SESSION transition the moment a strategy call is held
  // emptied the mid-month rows for the new action, the test passed again, and
  // the client got a SECOND copy of the same roll-over warning days after the
  // first (F20 review, Sep 21 2026). The cadence rows stay per action, because
  // "how many times have we asked for THIS thing" is an action question.
  const monthRows = (await prisma.programReminder.findMany({ where: { enrollmentId: e.id, monthKey: month.monthKey }, orderBy: { attempt: "desc" } }))
    .filter((r) => r.id !== ignoreReminderId);
  const prior = monthRows.filter((r) => r.action === action);
  const laneOf = (k: string | null) => ledgerLaneOf(k, e.id, month.monthKey, action);
  const sameSession = (k: string | null) => laneOf(k).sessionTag === sessionTag;
  const isCounted = (r: { state: string; leaseUntil: Date | null }) =>
    r.state === "SENT" || r.state === "UNKNOWN" || r.state === "QUEUED" || r.state === "BOUNCED" || (r.state === "PENDING" && !!r.leaseUntil && r.leaseUntil > now);
  // A mid-month row is read by ITS OWN action (the dedupeKey carries it), so a
  // BOOK_CALL milestone still counts while we are evaluating BOOK_SESSION. The
  // session tag deliberately does not scope this either: one 15th, one message.
  const isMidRow = (r: { dedupeKey: string | null; action: string }) => ledgerLaneOf(r.dedupeKey, e.id, month.monthKey, r.action).midMonth;
  // CP-02, REVIEWED Sep 24: the review cadence is counted PER WINDOW. Every
  // review reminder counted every window open when it went, so a window's
  // attempts are the lane's sends since its release (any tag, legacy rows
  // too), and the cadence chases the oldest window with attempts left
  // (reviewWindows.reviewCadenceTarget). Keyed on the earliest open window's
  // release day instead, approving Monday's videos reset a Tuesday video
  // already chased twice to "attempt 1", and one undecided Monday video kept a
  // Friday batch from ever being chased. The tag still names the ledger rows —
  // it is the target window's release day.
  const reviewSends = lane === "REVIEW" ? prior.filter((r) => !isMidRow(r) && isCounted(r)) : [];
  const { reviewCadenceTarget } = await import("@/lib/reviewWindows");
  const reviewTarget = lane === "REVIEW" ? reviewCadenceTarget(facts.reviewWindows, reviewSends.map((r) => r.sentAt ?? r.createdAt), p.reviewMaxAttempts) : null;
  const reviewTag = lane === "REVIEW" ? reviewTarget?.tag ?? facts.reviewTag ?? null : null;
  if (reviewTarget) {
    // What this reminder is about — and the one deadline it may quote.
    state.reviewTag = reviewTarget.tag;
    state.reviewDeadlineAt = reviewTarget.window.deadlineAt.toISOString();
  }
  const sameBatch = (k: string | null) => !reviewTag || laneOf(k).reviewTag === reviewTag || laneOf(k).reviewTag === "legacy";
  const midRows = monthRows.filter(isMidRow);
  const cadenceRows = prior.filter((r) => sameSession(r.dedupeKey) && sameBatch(r.dedupeKey) && !isMidRow(r));
  const midSpent = midRows.some(isCounted);
  // A CANCELLATION RE-OPENS THE ASK (Jordan, Sep 21 2026). Stopping when the
  // condition resolves was already true — a booked session yields no action at
  // all. Starting again was not: a Pro month that spent session 2's three
  // reminders, got it booked, and then had that booking cancelled went quiet for
  // good, because the cadence counts LEDGER ROWS and the rows were still there.
  // Reminders written before the loss no longer count against the ask.
  //
  // The ROW SEQUENCE deliberately still counts every row (`cadenceRows` below
  // feeds the dedupeKey and the runaway ceiling). dedupeKey is @unique, so
  // re-numbering from a shrunken count would collide on P2002, record
  // "duplicate", and silence the very reminder this is meant to restore — the
  // same defect the sequencing comment further down was written for.
  //
  // AND IT RE-OPENS ONE LANE, NOT ALL OF THEM (review, Sep 21 2026). This was
  // computed once per evaluateMonth and then applied to whatever action the
  // month happened to be on, so `counted`, `attemptsMade`, `lastSentAt`,
  // `reopened` and `milestone` were shared by REVIEW_WORK, COMPLETE_ANSWERS,
  // BOOK_CALL and CHOOSE_PATH as well. A cancelled filming session therefore
  // reset the review cadence, and a client could be chased past
  // reviewMaxAttempts for a cut they had already been chased about three times.
  // A lost session is a fact about the BOOKING, so only the booking lane reads
  // it: planning is not undone by a cancellation (a held call stays held, sent
  // answers stay sent) and a released cut is not waiting on the calendar at all.
  const lostAt = action === "BOOK_SESSION" ? facts.sessionLostAt : null;
  const afterLoss = (r: { sentAt: Date | null; createdAt: Date }) => !lostAt || (r.sentAt ?? r.createdAt) > lostAt;
  const counted = cadenceRows.filter((r) => isCounted(r) && afterLoss(r));
  // REVIEW: the target window's own count, and spacing from the lane's last
  // send whatever batch it was tagged with.
  const attemptsMade = reviewTarget ? reviewTarget.attempts : counted.length;
  const reopened = !!lostAt && cadenceRows.filter(isCounted).length > attemptsMade;
  const lastSentAt = (reviewTarget ? reviewSends : counted).reduce<Date | null>((m, r) => (r.sentAt && (!m || r.sentAt > m) ? r.sentAt : m), null);

  // MID_MONTH is the 15th's own milestone, with its own single attempt. It wins
  // a day it shares with an ordinary follow-up, because it is the message that
  // carries the roll-over note and Kyle's task — §12: avoid two near-identical
  // messages on one day when the cadences coincide.
  const midMonthDue = lane === "PRIMARY" && now >= cal.midMonthAt && !midSpent;
  const milestone: ReminderMilestone = midMonthDue
    ? "MID_MONTH"
    : lane === "REVIEW"
      ? "OFF_CALENDAR"
      // A cadence re-opened by a cancellation is NOT back at the 1st of the
      // month. The count resets so the ask can be made again, but calling the
      // next email "this month's planning email" in the third week would be the
      // evaluator contradicting the calendar it prints beside it.
      : reopened
        ? "OFF_CALENDAR"
        : attemptsMade === 0 ? "MONTH_OPEN" : attemptsMade === 1 ? "FOLLOW_UP_1" : attemptsMade === 2 ? "FOLLOW_UP_2" : "OFF_CALENDAR";

  // Where this lane's clock starts, and what we promise the client.
  let laneReadyAt = cal.monthOpenAt;
  let deadlineAt: Date;
  // TWO DIFFERENT THINGS, KEPT APART (F20 review, Sep 21 2026). `deadlineAt` is
  // the internal clock the escalation threshold measures; `quotedDeadlineAt` is
  // the date the client actually reads. Only the planning templates quote one,
  // and only when Jordan has set it.
  let quotedDeadlineAt: Date | null = null;
  if (lane === "REVIEW") {
    const releasedAt = reviewTarget?.window.openedAt ?? facts.oldestReleaseAt;
    laneReadyAt = releasedAt ? addBusinessDaysET(releasedAt, p.reviewWorkAfterBusinessDays) : now;
    // §8: four business days for each released version.
    // The PERSISTED deadline of the window being chased (CP-02) — the one the
    // portal shows and enforcement uses — never a recompute from the release.
    deadlineAt = reviewTarget?.window.deadlineAt ?? facts.reviewDeadlineAt ?? (releasedAt ? endOfBusinessDaysET(releasedAt, 4) : addBusinessDaysET(now, 4));
  } else if (action === "BOOK_SESSION") {
    const prepAt = d.planningMode === "CALL" ? d.strategyCallAt : d.preparationCompletedAt;
    // Never before the 1st, and never before the month was actually planned.
    laneReadyAt = prepAt && prepAt > cal.monthOpenAt ? prepAt : cal.monthOpenAt;
    deadlineAt = etAt(`${month.monthKey}-${String(Math.min(p.sessionBookingDeadlineDayOfMonth, 28)).padStart(2, "0")}`, 17);
  } else {
    deadlineAt = cal.planningDeadlineAt;
    quotedDeadlineAt = cal.quotedPlanningDeadlineAt;
  }

  const maxAttempts = milestone === "MID_MONTH" ? 1 : lane === "REVIEW" ? p.reviewMaxAttempts : p.maxAttemptsPerAction;
  const spacingBusinessDays = lane === "REVIEW" ? p.reviewFollowUpBusinessDays : p.followUpAfterBusinessDays;
  const laneRows = milestone === "MID_MONTH" ? midRows : cadenceRows;
  const laneAttemptsMade = milestone === "MID_MONTH" ? midRows.filter(isCounted).length : attemptsMade;

  const templateKey = templateForAction(action as keyof typeof DEFAULT_TEMPLATE_IDS, p.templates).id;
  // CP-08: a written-answers month with a topic whose answers stop short of a
  // script names the (at most two) questions still open and links straight to
  // them. House or per-topic wording only — never a fact from the file.
  const answerGap = action === "COMPLETE_ANSWERS" ? await import("@/lib/programDeskTasks").then((m) => m.monthAnswerGapParagraph(month.id)).catch(() => null) : null;
  const extraParagraph = milestone === "MID_MONTH"
    ? MID_MONTH_PARAGRAPH
    : action === "BOOK_SESSION" && sessionOrdinal && sessionOrdinal > 1
      ? secondSessionParagraph(sessionOrdinal, facts.sessionsRequired, e.videosPerMonth)
      : answerGap?.paragraph ?? null;
  const linkPath = answerGap?.path ?? null;

  // §12/A28: the roll-over note is the one message that must never reach a
  // client in their first paid production cycle, or a client whose shortfall we
  // caused. Kyle still gets the follow-up; the client is not told they are
  // losing something they are not losing, and is not blamed for work we owe.
  const kyleFollowUp = milestone === "MID_MONTH" ? { due: true, reason: `mid-month check on ${month.monthKey}: still needs ${actionLabel(action)}` } : null;
  const withMid = { milestone, sessionOrdinal, calendar: cal, kyleFollowUp, extraParagraph, linkPath, templateKey, deadlineAt, quotedDeadlineAt };
  if (milestone === "MID_MONTH") {
    const exempt = midMonthExemption({ firstCycle, carryoverUnclassified: facts.carryoverUnclassified });
    if (exempt === "first_cycle_exempt") {
      return sup("first_cycle_exempt", "first paid production cycle — no use-it-or-lose-it warning and no forfeiture (§3). Kyle picks this up instead.", action, { ...withMid });
    }
    if (exempt === "catch_up_owed") {
      return sup("catch_up_owed", `${facts.carryoverUnclassified} carried-in video(s) on this month and nobody has classified why — agency-delayed work is not forfeited, so the client is not warned. Kyle classifies it (§3).`, action, {
        ...withMid,
        kyleFollowUp: { due: true, reason: `${facts.carryoverUnclassified} carried-in video(s) on ${month.monthKey} need classifying: client-unfilmed, or delayed by us` },
      });
    }
  }

  const opensAt = milestone === "MID_MONTH"
    ? cal.midMonthAt
    : laneAttemptsMade === 0
      ? laneReadyAt
      // THREE WEEKDAYS AFTER THE ACTUAL SEND, not after the day we meant to
      // send. A first email held overnight by quiet hours moves the whole tail
      // with it, which is what §12 asks for and what "72 staffed hours" would
      // not have given.
      : lastSentAt ? addBusinessDaysET(lastSentAt, spacingBusinessDays) : laneReadyAt;
  if (now < opensAt) {
    return out({
      ...withMid, action, decision: "wait", noCallEligible, digestSession, answersStarted,
      reason: milestone === "MONTH_OPEN" ? `this month's planning email goes out ${fmtDay(opensAt)}` : `follow-up due ${fmtDay(opensAt)} (${spacingBusinessDays} weekdays after the last one actually sent)`,
      nextEligibleAt: opensAt,
    });
  }

  // A retry re-uses the EXISTING row, so it may only ever be a row written for
  // the action we are about to send. The mid-month lane is read across the whole
  // month now, and without this a failed BOOK_CALL milestone would be resurrected
  // to carry a BOOK_SESSION body while the ledger still called it a BOOK_CALL
  // (F20 review, Sep 21 2026).
  const failedRetry = laneRows.find((r) => r.action === action && r.state === "FAILED" && (!r.nextAttemptAt || r.nextAttemptAt <= now)) ?? null;
  // One escalation per (month, action): the ESCALATION ledger row carries the
  // client action it escalated in its templateKey.
  const escalated = (await prisma.programReminder.count({
    where: {
      monthId: month.id, action: "ESCALATION", templateKey: `escalation:${action}`,
      // REVIEW: an escalation filed after the chased window was released
      // already covered it (whatever batch it was tagged with) — so closing
      // Monday's videos cannot earn a Tuesday video a second one.
      ...(reviewTarget ? { createdAt: { gte: reviewTarget.window.openedAt } }
        : reviewTag ? { OR: [{ dedupeKey: { endsWith: `:${reviewTag}` } }, { dedupeKey: `${e.id}:${month.monthKey}:ESCALATION:${action}` }] } : {}),
    },
  })) > 0;
  // The review window is FOUR business days end to end (§8), so the planning
  // lane's three-day escalation threshold would fire on the very first review
  // reminder and put a task on Kyle for every cut we share. The review lane
  // escalates when the deadline is genuinely upon us.
  const escalateWithin = lane === "REVIEW" ? Math.min(p.escalateWhenDeadlineWithinBusinessDays, 1) : p.escalateWhenDeadlineWithinBusinessDays;
  const deadlineNear = businessDaysBetween(now, deadlineAt) <= escalateWithin;
  // A ledger that only ever grows and never sends is the churn version of the
  // same silence: stop and hand it to a person rather than write row 40.
  const rowCeiling = maxAttempts + 5;
  const rowCeilingHit = !failedRetry && laneRows.length >= rowCeiling;
  const escalation = !escalated && (deadlineNear || laneAttemptsMade >= maxAttempts || rowCeilingHit)
    ? { due: true, reason: rowCeilingHit ? `${laneRows.length} reminder rows exist for this month and action but only ${laneAttemptsMade} actually sent — the evaluator has stopped` : deadlineNear ? `deadline ${fmtDay(deadlineAt)} is within ${escalateWithin} business day(s)` : `${laneAttemptsMade} reminder(s) sent, no response` }
    : null;

  const to = await recipientFor(e);
  const common = { ...withMid, action, noCallEligible, digestSession, answersStarted, escalation, to: to ? maskToRef("email", to.email) : null, reviewTag };
  if (rowCeilingHit) {
    return out({ ...common, attempt: laneAttemptsMade, decision: escalation ? "escalate" : "none", reason: `${laneRows.length} reminder rows already written for this month and action (only ${laneAttemptsMade} sent) — stopping so a person looks` });
  }
  if (laneAttemptsMade >= maxAttempts && !failedRetry) {
    return out({ ...common, attempt: laneAttemptsMade, decision: escalation ? "escalate" : "none", reason: milestone === "MID_MONTH" ? "the mid-month milestone has already gone out for this month" : `${laneAttemptsMade} of ${maxAttempts} reminders already sent${escalation ? " — escalating to the office" : ""}` });
  }
  const attempt = failedRetry ? failedRetry.attempt : laneAttemptsMade + 1;
  // THE ROW IDENTITY IS THE ROW'S POSITION IN THE LEDGER, NOT THE ATTEMPT
  // NUMBER. dedupeKey is @unique, and a SUPPRESSED or CANCELLED row does not
  // count towards `attemptsMade` — so keying on the attempt meant a reminder
  // that was cancelled before it left (a pause, a snooze, a lease race) burned
  // `…:BOOK_CALL:1` for ever: every later run recomputed attempt 1, collided on
  // P2002, recorded `duplicate`, and that client was never reminded again with
  // nothing anywhere reading as broken. Sequencing on the lane's row count keeps
  // the concurrency guarantee (two runs reading the same ledger compute the same
  // key, one wins on P2002) while letting a consumed-but-unsent row step aside.
  // The tags in the middle are what keep the lanes apart: `s2` is the second Pro
  // session's cadence, `mid` is the 15th's single milestone.
  const tags = [sessionTag === "s1" ? null : sessionTag, reviewTag, milestone === "MID_MONTH" ? "mid" : null].filter(Boolean).join(":");
  const dedupeKey = failedRetry
    ? (failedRetry.dedupeKey ?? `${e.id}:${month.monthKey}:${action}:retry:${failedRetry.id}`)
    : `${e.id}:${month.monthKey}:${action}:${tags ? `${tags}:` : ""}${laneRows.length + 1}`;
  const nextEligibleAt = failedRetry
    ? (failedRetry.nextAttemptAt ?? now)
    // addBusinessDaysET lands at MIDNIGHT of its day, so adding zero days would
    // report a time earlier than the milestone itself. Zero delay means "the
    // milestone", not "the milestone's midnight".
    : attempt === 1 && p.firstReminderDelayBusinessDays > 0 ? addBusinessDaysET(opensAt, p.firstReminderDelayBusinessDays) : opensAt;
  if (now < nextEligibleAt) return out({ ...common, attempt, dedupeKey, decision: "wait", reason: attempt === 1 ? `first reminder due ${fmtDay(nextEligibleAt)}` : `follow-up due ${fmtDay(nextEligibleAt)} (${spacingBusinessDays} weekdays after the last one)`, nextEligibleAt, retryOfId: failedRetry?.id ?? null });
  if (!to) return sup("no_recipient", "no email address on the portal seat or the client record");
  if (isTest && !isStaffControlledEmail(to.email)) return sup("test_client_real_address", `TEST client's address ${maskToRef("email", to.email)} is not staff-controlled`);
  // ONE client email per enrollment per ET day, across every lane. Two cadences
  // landing together is a normal month (a planning follow-up on the day the
  // review clock opens), and two emails an hour apart reads as a system with no
  // one steering it (§12).
  const dayFrom = etAt(etDayKey(now), 0);
  const dayTo = etAt(shiftKey(etDayKey(now), 1), 0);
  const sentToday = await prisma.programReminder.count({
    where: {
      enrollmentId: e.id, channel: { in: ["email", "copy"] },
      ...(ignoreReminderId ? { id: { not: ignoreReminderId } } : {}),
      // A QUEUED row has no sentAt yet — it is a message on its way out, and it
      // counts, or the second lane would slip past the one just handed over.
      OR: [
        { state: "SENT", sentAt: { gte: dayFrom, lt: dayTo } },
        { state: "QUEUED", createdAt: { gte: dayFrom, lt: dayTo } },
      ],
    },
  });
  if (sentToday >= p.maxClientEmailsPerDay) {
    const next = nextPolicyWindowOpen(etAt(shiftKey(etDayKey(now), 1), 0), p);
    return out({ ...common, attempt, dedupeKey, decision: "wait", suppressionReason: "another_reminder_today", reason: `${sentToday} program email already went to this client today — the next one waits until ${fmtDay(next)}`, nextEligibleAt: next, retryOfId: failedRetry?.id ?? null });
  }
  if (!inPolicyWindow(now, p) || !clientWindowOpen) {
    const next = nextPolicyWindowOpen(now, p);
    return out({ ...common, attempt, dedupeKey, decision: "wait", suppressionReason: "quiet_hours", reason: `outside the send window — next opening ${fmtDay(next)} ${next.toLocaleTimeString("en-US", { timeZone: p.timezone, hour: "numeric", minute: "2-digit" })}`, nextEligibleAt: next, retryOfId: failedRetry?.id ?? null });
  }
  return out({ ...common, attempt, dedupeKey, decision: "send", reason: `${failedRetry ? `retrying attempt ${attempt} (last error: ${failedRetry.lastError ?? "unknown"})` : milestone === "MID_MONTH" ? "the 15th: the mid-month milestone" : milestone === "MONTH_OPEN" ? "the 1st: this month's planning email" : `follow-up ${attempt} (${milestone.toLowerCase().replace("_", " ")})`}${reopened ? " — a booked session was cancelled, so this ask is open again" : ""}`, nextEligibleAt, retryOfId: failedRetry?.id ?? null });
}

// ---- the escalation owner ---------------------------------------------------------
// ONE source of truth: W2-E's programOwners, which re-exports contentProgram's
// ownersFor (MONTH override → ENROLLMENT override → DEFAULT, defaults minted by
// W1-C as Jordan = STRATEGY / SCRIPTS / ESCALATION, Kyle = SCHEDULING /
// DELIVERY / REMINDERS). Nobody re-derives "who is Kyle" from a role, so a
// reassignment made on the client file is the one this evaluator obeys too.
// The policy's `escalationOwnerDuty` chooses WHICH duty answers (ESCALATION by
// default); an unknown duty falls back to ESCALATION rather than to nobody,
// because an unowned escalation is an alert that reaches no one.
async function escalationOwner(enrollmentId: string, monthId: string, duty: string): Promise<{ appUserId: string | null; label: string; assignedKey: string | null; email: string | null }> {
  const owners = await ownersFor(enrollmentId, monthId || null);
  const o = owners[duty as OwnerDuty] ?? owners.ESCALATION;
  // SmartTask.assignedKey is a first name, lowercased — the hub's convention.
  const first = (o.label ?? "").trim().split(/\s+/)[0]?.toLowerCase() || null;
  return { appUserId: o.appUserId, label: o.label, assignedKey: first, email: o.email };
}

/** An internal task for the escalation owner — one per (month, action). Never a client message. */
async function escalate(c: ReminderCandidate, p: ReminderPolicy, now: Date, why: string, dryRun: boolean): Promise<{ created: boolean; owner: string }> {
  // The dry run answers BEFORE the owner lookup: ownersFor() mints the DEFAULT
  // assignment rows on first use, and "what would go out now?" must not write.
  if (dryRun) return { created: false, owner: "(not resolved in a dry run)" };
  const owner = await escalationOwner(c.enrollmentId, c.monthId, p.escalationOwnerDuty);
  // One escalation per (month, action) — and per review BATCH on the review
  // lane (CP-02), or a second release in the month could never escalate.
  const batch = c.lane === "REVIEW" && c.reviewTag ? `:${c.reviewTag}` : "";
  const dedupeKey = `${c.enrollmentId}:${c.monthKey}:ESCALATION:${c.action}${batch}`;
  try {
    const row = await prisma.programReminder.create({
      data: {
        enrollmentId: c.enrollmentId, clientId: c.clientId, monthId: c.monthId, monthKey: c.monthKey, action: "ESCALATION", templateKey: `escalation:${c.action}`, templateVersion: "1",
        channel: "task", attempt: 1, state: "SENT", sentAt: now, outcome: c.isTest ? "task_skipped_test_client" : "task", manual: false, requestedBy: "reminders-cron", escalatedToAppUserId: owner.appUserId, dedupeKey,
        evaluatedStateJson: JSON.stringify({ ...c.state, why }),
      },
      select: { id: true },
    });
    // TEST records make no owner work (same rule as the call review queue):
    // the ledger row is the evidence, nobody's to-do list grows.
    if (c.isTest) return { created: true, owner: owner.label };
    const task = await prisma.smartTask.create({
      data: {
        taskType: "todo", status: "OPEN", source: "content_program", priority: "HIGH",
        title: `${c.clientName}: ${c.monthKey} still needs ${actionLabel(c.action)}`.slice(0, 140),
        summary: `${why}. Reminders sent: ${Math.max(0, c.attempt - 1)}. Owner: ${owner.label}.`.slice(0, 500),
        description: `The reminder evaluator stopped nudging the client and handed this to you.\n\n${why}.\nMonth ${c.monthKey} — ${actionLabel(c.action)}.\nLast evaluated state: ${JSON.stringify(c.state)}\n\nOpen the client file on /content/${c.enrollmentId} to call, text, or snooze the reminders.`,
        reasonCreated: "Content-program reminder escalation (spec §24)",
        clientId: c.clientId, assignedKey: owner.assignedKey, dedupeKey: `program-reminder-escalation:${c.monthId}:${c.action}${batch}`,
        dueAt: new Date(now.getTime() + 864e5),
      },
      select: { id: true },
    }).catch(() => null);
    if (task) await prisma.programReminder.update({ where: { id: row.id }, data: { escalationTaskId: task.id } });
    return { created: true, owner: owner.label };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { created: false, owner: owner.label };
    throw e;
  }
}

export function actionLabel(a: ReminderAction | null): string {
  switch (a) {
    case "CHOOSE_PATH": return "a planning path (call or written)";
    case "BOOK_CALL": return "a strategy call booking";
    case "COMPLETE_ANSWERS": return "the written preparation answers";
    case "BOOK_SESSION": return "a content session booking";
    case "REVIEW_WORK": return "a review of the shared cuts";
    case "SCRIPTS_READY": return "scripts ready";
    case "STRATEGY_READY": return "strategy ready";
    default: return "attention";
  }
}

// ---- dispatch: ledger row → recheck → link → outbox → outcome ---------------------

export type DispatchOutcome = { reminderId: string | null; outcome: "sent" | "failed" | "unknown" | "suppressed" | "duplicate" | "skipped"; detail: string };

async function dispatch(c: ReminderCandidate, e: EnrollmentRow, p: ReminderPolicy, now: Date, opts: { requestedBy: string; manual: boolean; byAppUserId: string | null; feeds: BookingFeeds; clientWindowOpen: boolean }): Promise<DispatchOutcome> {
  if (c.decision !== "send" || !c.action || !c.dedupeKey || !c.templateKey) return { reminderId: null, outcome: "skipped", detail: c.reason };
  const leaseBy = `${opts.requestedBy}:${process.pid}`;
  const leaseUntil = new Date(now.getTime() + 5 * 60_000);
  // 1. THE ROW FIRST. A P2002 on dedupeKey means another run owns this attempt.
  let reminderId: string;
  if (c.retryOfId) {
    const won = await prisma.programReminder.updateMany({ where: { id: c.retryOfId, state: "FAILED" }, data: { state: "PENDING", leaseUntil, leaseBy, nextAttemptAt: null } });
    if (won.count === 0) return { reminderId: c.retryOfId, outcome: "duplicate", detail: "another run already took this retry" };
    reminderId = c.retryOfId;
  } else {
    try {
      const row = await prisma.programReminder.create({
        data: {
          enrollmentId: c.enrollmentId, clientId: c.clientId, monthId: c.monthId, monthKey: c.monthKey, action: c.action, templateKey: c.templateKey,
          templateVersion: reminderTemplate(c.templateKey).version, channel: "email", attempt: c.attempt, state: "PENDING", leaseUntil, leaseBy,
          manual: opts.manual, requestedBy: opts.requestedBy, dedupeKey: c.dedupeKey, nextEligibleAt: c.nextEligibleAt,
        },
        select: { id: true },
      });
      reminderId = row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { reminderId: null, outcome: "duplicate", detail: `attempt ${c.attempt} already exists (${c.dedupeKey})` };
      throw err;
    }
  }
  const month = await prisma.contentMonth.findUnique({ where: { id: c.monthId }, select: { id: true, monthKey: true, status: true, remindersSnoozedUntil: true } });
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id: e.id }, select: { status: true } });
  // 2. RECHECK — the authoritative state, read again this instant.
  const fresh = month && enrollment ? await evaluateMonth({ ...e, status: enrollment.status }, month, now, p, opts.feeds, opts.clientWindowOpen, c.lane === "REVIEW" ? "REVIEW" : "PRIMARY", reminderId) : null;
  // The recheck has to agree about the MILESTONE too, not just the action: a
  // run that decided "the 15th, with the roll-over note" must not quietly send
  // the plain follow-up body, and vice versa.
  const stillSend = fresh && fresh.decision === "send" && fresh.action === c.action && fresh.milestone === c.milestone;
  if (!stillSend) {
    const reason = fresh?.suppressionReason ?? (fresh?.decision === "wait" ? "quiet_hours" : "state_changed");
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "SUPPRESSED", suppressionReason: reason, evaluatedStateJson: JSON.stringify(fresh?.state ?? {}), leaseUntil: null, leaseBy: null, lastError: fresh?.reason ?? null } });
    return { reminderId, outcome: "suppressed", detail: `${reason}: ${fresh?.reason ?? "state changed between evaluation and send"}` };
  }
  // 3. RECIPIENT + LINK.
  const to = await recipientFor(e);
  if (!to) {
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "SUPPRESSED", suppressionReason: "no_recipient", leaseUntil: null, leaseBy: null } });
    return { reminderId, outcome: "suppressed", detail: "no recipient" };
  }
  const link = await resolvePortalLink(e, to, opts.byAppUserId, now, { path: fresh.linkPath });
  if (!link) {
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "SUPPRESSED", suppressionReason: "no_portal_link", toRef: to.email, leaseUntil: null, leaseBy: null } });
    return { reminderId, outcome: "suppressed", detail: "no portal link could be produced (no seat, no token)" };
  }
  // 4. RENDER.
  const vars = await templateVarsFor(c, e, link.url, fresh);
  const body = withExtraParagraph(renderReminder(reminderTemplate(c.templateKey), vars), fresh.extraParagraph);
  await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "QUEUED", toRef: to.email, evaluatedStateJson: JSON.stringify({ ...fresh.state, portalLinkKind: link.kind }) } });
  // 5. THE ONE SEND. sendThroughOutbox queues, leases and delivers in one call,
  //    so a pending row never sits where the recovery drain could pick it up
  //    outside the window (it is a client kind there too, for that reason).
  const r = await sendThroughOutbox(
    { channel: "email", toRef: to.email, body, dedupeKey: programReminderKey(c.action, reminderId, c.monthKey), clientId: c.clientId, requestedBy: opts.requestedBy },
    { workerId: leaseBy },
  );
  const result = await recordSendResult(reminderId, r, now);
  // A review reminder that actually went out is the evidence the client was
  // told (CP-02): the open windows it was about carry clientNotifiedAt, which
  // an automatic approval needs.
  if (c.lane === "REVIEW" && result.outcome === "sent") {
    const { markReviewWindowsNotified } = await import("@/lib/reviewWindows");
    await markReviewWindowsNotified(c.monthId, now).catch(() => 0);
  }
  return result;
}

async function templateVarsFor(c: ReminderCandidate, e: EnrollmentRow, portalLink: string, fresh: ReminderCandidate | null): Promise<TemplateVars> {
  const monthly = await prisma.programCalendlyEventMapping.findFirst({ where: { purpose: "MONTHLY_STRATEGY", enabled: true }, select: { publicUrl: true } });
  const month = monthName(c.monthKey);
  return {
    firstName: firstNameOf(e.client.name),
    month,
    portalLink,
    bookCallLink: monthly?.publicUrl ?? STRATEGY_CALL_BOOKING_URL,
    noCallEligible: c.noCallEligible,
    answersStarted: c.answersStarted,
    // No em dashes in anything a client reads (Jordan's rule).
    sessionNote: c.digestSession ? `Once ${month} is planned we'll also need to book your filming session. You can pick a time in the same portal and we'll confirm it.` : null,
    earliestSession: fmtDay(fresh?.state.earliestSessionAt ? new Date(fresh.state.earliestSessionAt) : null),
    itemCount: fresh?.state.releasedCutsAwaiting ?? c.state.releasedCutsAwaiting,
    titles: [],
    updatedTitles: [],
    // THE QUOTED DATE, NEVER THE INTERNAL ONE. `deadlineAt` moves with the
    // escalation calendar and with the lane; a client-facing promise must not
    // move with it, so it is a separate, deliberately-set value and it is null
    // unless Jordan has set one (F20 review, Sep 21 2026).
    deadline: c.quotedDeadlineAt && c.quotedDeadlineAt > new Date() ? c.quotedDeadlineAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric" }) : null,
    // CP-02: the review window's own deadline, quoted only while the policy
    // that shows it in the portal is on (and the auto sentence only with
    // automatic approval on) — the email never promises what the page does not.
    ...(c.lane === "REVIEW" ? await reviewTemplateVars(fresh?.state.reviewDeadlineAt ?? c.state.reviewDeadlineAt ?? null, c.isTest) : {}),
  };
}

async function reviewTemplateVars(deadlineISO: string | null, isTest: boolean): Promise<Pick<TemplateVars, "reviewDeadline" | "reviewAutoApprove">> {
  const { revisionPolicy, deadlineLabel } = await import("@/lib/reviewWindows");
  const p = await revisionPolicy();
  if (!p.on || !deadlineISO) return { reviewDeadline: null, reviewAutoApprove: false };
  // Only promise automatic approval to a client it can actually happen to.
  return { reviewDeadline: deadlineLabel(new Date(deadlineISO)), reviewAutoApprove: p.autoApprove.on && (!p.autoApprove.testClientsOnly || isTest) };
}

/** Write the outbox's verdict on the ledger row. Exported so the share-notice
 *  drain (scriptShare.ts) records its sends the same way. */
export async function recordSendResult(reminderId: string, r: Awaited<ReturnType<typeof sendThroughOutbox>>, now: Date): Promise<DispatchOutcome> {
  const clear = { leaseUntil: null, leaseBy: null };
  if (r.outcome === "accepted") {
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "SENT", outcome: "accepted", outboxMessageId: r.id, providerMessageId: r.providerId, sentAt: now, lastError: null, ...clear } });
    return { reminderId, outcome: "sent", detail: `provider id ${r.providerId ?? "(none)"}` };
  }
  if (r.outcome === "failed") {
    // NOTHING WAS SENT. Same row retries after an hour (the outbox released the identity).
    const row = await prisma.programReminder.findUnique({ where: { id: reminderId }, select: { evaluatedStateJson: true } });
    const retries = readRetries(row?.evaluatedStateJson) + 1;
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "FAILED", outcome: "failed", outboxMessageId: r.id, failedAt: now, lastError: r.error.slice(0, 500), lastErrorAt: now, nextAttemptAt: retries >= 3 ? null : new Date(now.getTime() + 60 * 60_000), evaluatedStateJson: withRetries(row?.evaluatedStateJson, retries), ...clear } });
    return { reminderId, outcome: "failed", detail: r.error };
  }
  if (r.outcome === "unknown") {
    // IT MAY HAVE GONE. Never retried here; a person settles it on Connections.
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "UNKNOWN", outcome: "unknown", outboxMessageId: r.id, lastError: r.error.slice(0, 500), lastErrorAt: now, ...clear } });
    return { reminderId, outcome: "unknown", detail: r.error };
  }
  // duplicate / busy: the outbox already holds this identity — reconcile from it next run.
  await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "QUEUED", outboxMessageId: r.id || null, lastError: `outbox: ${r.outcome}`, ...clear } });
  return { reminderId, outcome: "unknown", detail: `outbox reported ${r.outcome}` };
}
function readRetries(json: string | null | undefined): number { try { return Number((JSON.parse(json ?? "{}") as { retries?: number }).retries ?? 0) || 0; } catch { return 0; } }
function withRetries(json: string | null | undefined, retries: number): string { let o: Record<string, unknown> = {}; try { o = JSON.parse(json ?? "{}") as Record<string, unknown>; } catch { /* keep {} */ } return JSON.stringify({ ...o, retries }); }

// ---- the evaluator --------------------------------------------------------------

export type EvaluateOpts = {
  now?: Date;
  /** true: write nothing, return every candidate with its decision. */
  dryRun: boolean;
  /** Restrict to these enrollments (a probe, a client-file button). */
  enrollmentIds?: string[];
  /** Who is running it — "reminders-cron" or a staff email for send-now. */
  requestedBy?: string;
  byAppUserId?: string | null;
};

export type EvaluateResult = {
  enabled: boolean;
  policySource: "stored" | "defaults" | "off";
  evaluated: number;
  candidates: ReminderCandidate[];
  sent: DispatchOutcome[];
  escalations: { candidate: ReminderCandidate; created: boolean; owner: string }[];
  /** Mid-month milestones that put a follow-up on Kyle, whether or not the
   *  client was written to (§12, A28). */
  kyleFollowUps: { candidate: ReminderCandidate; created: boolean; owner: string }[];
  /** §8's missing-address lane (CP-05): one row per session that still has
   *  only a general area — sent, waiting or suppressed, with the reason. */
  addressLane: AddressReminderPreview[];
  /** A run that went quiet for an infrastructure reason, in words, for the
   *  automation row's lastError and the settings panel. null = healthy. */
  healthError: string | null;
  note: string;
};

/**
 * THE HOURLY PASS. With the switch off and dryRun false it returns immediately
 * having read nothing but the switch — no row, no outbox message, no task.
 */
export async function evaluateReminders(opts: EvaluateOpts): Promise<EvaluateResult> {
  const now = opts.now ?? new Date();
  const { enabled, policy, source } = await reminderPolicy({ orDefaults: opts.dryRun });
  if (!policy || (!enabled && !opts.dryRun)) {
    return { enabled: false, policySource: source, evaluated: 0, candidates: [], sent: [], escalations: [], kyleFollowUps: [], addressLane: [], healthError: null, note: "reminders are off (missing or disabled ProgramAutomation row) — nothing evaluated, nothing written" };
  }
  const [feeds, clientWindowOpen] = await Promise.all([bookingFeeds(now, policy), clientTextWindowOpen(now)]);
  const sync = feeds.call;
  const rawEnrollments = await prisma.contentEnrollment.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] }, ...(opts.enrollmentIds?.length ? { id: { in: opts.enrollmentIds } } : {}) },
    select: ENROLLMENT_SELECT,
  });
  const firstMonths = await firstMonthKeysFor(rawEnrollments.map((e) => e.id), new Map(rawEnrollments.map((e) => [e.id, e.startedAt])));
  const enrollments = rawEnrollments.map((e) => ({ ...e, firstMonthKey: firstMonths.get(e.id) ?? null }));
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true, email: true } })).map((c) => [c.id, c]));
  const cur = currentMonthKey(now);
  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId: { in: enrollments.map((e) => e.id) }, historical: false, ...(policy.includePastMonths ? {} : { monthKey: { gte: cur } }) },
    select: { id: true, enrollmentId: true, monthKey: true, status: true, remindersSnoozedUntil: true },
    orderBy: [{ monthKey: "asc" }],
  });
  const candidates: ReminderCandidate[] = [];
  const sent: DispatchOutcome[] = [];
  const escalations: EvaluateResult["escalations"] = [];
  const kyleFollowUps: EvaluateResult["kyleFollowUps"] = [];
  const addressLane: AddressReminderPreview[] = [];
  let sends = 0;
  for (const m of months) {
    const en = enrollments.find((e) => e.id === m.enrollmentId);
    const client = en ? clients.get(en.clientId) : null;
    if (!en || !client) continue;
    const e: EnrollmentRow = { ...en, client: { name: client.name, email: client.email } };
    // ONE MONTH, THE LANES IN ORDER. Planning/session first — it is the lane
    // §12's calendar belongs to — then review on its own clock. The one-email-
    // a-day rule inside the derivation is what stops the second lane doubling
    // up on the first, and it re-reads the ledger, so it sees a send this loop
    // has only just made.
    // ADDRESS FIRST (CP-05). A session starting in two days with no street on
    // file is the one message that cannot wait for tomorrow, so it takes the
    // one-email-a-day slot and the planning cadence waits a day behind it.
    const address = await evaluateAddressLane(e, m, now, policy, feeds, clientWindowOpen, { dryRun: opts.dryRun });
    addressLane.push(...address);
    if (!opts.dryRun) {
      for (const a of address) {
        if (a.decision !== "send") continue;
        if (sends >= policy.maxSendsPerRun) { sent.push({ reminderId: null, outcome: "skipped", detail: `maxSendsPerRun (${policy.maxSendsPerRun}) reached — ${a.clientName} address reminder waits for the next run` }); continue; }
        const r = await dispatchAddress(a, e, policy, now, { requestedBy: opts.requestedBy ?? "reminders-cron", feeds, clientWindowOpen });
        sent.push(r);
        if (r.outcome === "sent") sends++;
      }
    }
    for (const lane of ["PRIMARY", "REVIEW"] as const) {
      const c = await evaluateMonth(e, m, now, policy, feeds, clientWindowOpen, lane);
      if (lane === "REVIEW" && c.action === null && c.decision === "none") continue; // nothing waiting: not worth a row in the preview
      candidates.push(c);
      if (c.kyleFollowUp?.due) {
        const r = await raiseMidMonthFollowUp(c, policy, now, opts.dryRun);
        kyleFollowUps.push({ candidate: c, ...r });
      }
      if (c.escalation?.due && (c.decision === "send" || c.decision === "escalate" || c.decision === "wait")) {
        const r = await escalate(c, policy, now, c.escalation.reason, opts.dryRun);
        escalations.push({ candidate: c, ...r });
      }
      if (opts.dryRun || c.decision !== "send") continue;
      if (sends >= policy.maxSendsPerRun) { sent.push({ reminderId: null, outcome: "skipped", detail: `maxSendsPerRun (${policy.maxSendsPerRun}) reached — ${c.clientName} ${c.monthKey} waits for the next run` }); continue; }
      const r = await dispatch(c, e, policy, now, { requestedBy: opts.requestedBy ?? "reminders-cron", manual: false, byAppUserId: opts.byAppUserId ?? null, feeds, clientWindowOpen });
      sent.push(r);
      if (r.outcome === "sent") sends++;
    }
  }
  const wouldSend = candidates.filter((c) => c.decision === "send").length;
  // A BROKEN SCHEDULER MUST NOT BE A QUIET ONE. `stale_scheduler_sync` is a
  // safety suppression, not a decision about the client: while it holds, every
  // booking reminder in the business stops, and (because sup() carries no
  // escalation) nobody was told. That is the Sep 8 shape exactly — an
  // integration goes dark, then days of unnoticed silence. One line on the
  // automation row and one task per ET day, so the silence has an owner.
  const stale = candidates.filter((c) => c.suppressionReason === "stale_scheduler_sync");
  // Two feeds can be the dark one now (Calendly for calls, Aryeo for filming
  // sessions), so the sentence names whichever it actually was rather than
  // always blaming Calendly.
  const staleDetail = [feeds.call.fresh ? null : `Calendly: ${feeds.call.detail}`, feeds.session.fresh ? null : `Aryeo: ${feeds.session.detail}`].filter(Boolean).join("; ") || sync.detail;
  const healthError = stale.length
    ? `${stale.length} month(s) got no booking reminder because the booking state is not trustworthy (${staleDetail}). Nothing was sent for them — this is a suppression, not a decision about the client.`
    : null;
  if (!opts.dryRun && healthError) await raiseSchedulerStaleTask(stale, { fresh: false, detail: staleDetail }, now, healthError);
  return {
    enabled, policySource: source, evaluated: candidates.length, candidates, sent, escalations, kyleFollowUps, addressLane, healthError,
    note: opts.dryRun ? `dry run: ${wouldSend} would send, ${candidates.filter((c) => c.decision === "suppressed").length} suppressed, ${candidates.filter((c) => c.decision === "wait").length} waiting` : `${sends} sent`,
  };
}

/**
 * THE 15th's FOLLOW-UP FOR KYLE (§12). It is raised whether or not the client
 * is written to, which is the whole point of it in the two exempt cases: a
 * first-cycle client and a client whose shortfall we caused both get no
 * warning, and Kyle still gets the work.
 *
 * ONE task per month, not one per action and not one per lane — §12 is explicit
 * that alerting several people must not produce several independent tasks. If
 * this month has already been escalated for this action, the escalation IS the
 * follow-up and nothing further is raised.
 */
async function raiseMidMonthFollowUp(c: ReminderCandidate, p: ReminderPolicy, now: Date, dryRun: boolean): Promise<{ created: boolean; owner: string }> {
  if (dryRun) return { created: false, owner: "(not resolved in a dry run)" };
  if (c.isTest) return { created: false, owner: "(TEST client — no owner work)" };
  const already = await prisma.programReminder.count({ where: { monthId: c.monthId, action: "ESCALATION", templateKey: `escalation:${c.action}` } });
  if (already > 0) return { created: false, owner: "(already escalated for this action)" };
  const owner = await escalationOwner(c.enrollmentId, c.monthId, "SCHEDULING").catch(() => null);
  const exempt = c.suppressionReason === "first_cycle_exempt" || c.suppressionReason === "catch_up_owed";
  const task = await prisma.smartTask
    .create({
      data: {
        taskType: "todo", status: "OPEN", source: "content_program", priority: "MEDIUM",
        title: `${c.clientName}: mid-month check on ${c.monthKey}`.slice(0, 140),
        summary: `${c.kyleFollowUp?.reason ?? "mid-month check"}${exempt ? " (the client was NOT sent a roll-over warning)" : ""}.`.slice(0, 500),
        description: [
          `It is the ${p.midMonthDayOfMonth}th and ${c.monthKey} still needs ${actionLabel(c.action)}.`,
          exempt
            ? c.suppressionReason === "first_cycle_exempt"
              ? "This is their FIRST paid production cycle, so no use-it-or-lose-it warning went to them and nothing is forfeited. Give them a hand with the booking."
              : "Work carried into this month and nobody has classified why. If we were late, it is still owed and it is not forfeited, and the client must not be told they are losing it. Classify it, then decide."
            : "The client has had the mid-month note about sessions not rolling over.",
          `Open the client file on /content/${c.enrollmentId}.`,
        ].join("\n\n"),
        reasonCreated: "Content-program mid-month milestone (spec §12)",
        clientId: c.clientId, assignedKey: owner?.assignedKey ?? null,
        dedupeKey: `program-reminder-midmonth:${c.monthId}`,
        dueAt: new Date(now.getTime() + 2 * 864e5),
      },
      select: { id: true },
    })
    .catch(() => null); // P2002 = this month already has its mid-month task
  return { created: !!task, owner: owner?.label ?? "(unassigned)" };
}

// ---- the ADDRESS lane (§8, CP-05) ----------------------------------------------------

export type AddressReminderPreview = {
  enrollmentId: string; clientName: string; monthKey: string; monthId: string;
  /** null when the session is a hub booking whose order has not been imported yet */
  projectId: string | null;
  /** the session's identity (countDistinctSessions key) — ONE reminder per session */
  sessionKey: string;
  shootAt: Date; remindAt: Date; movedOffWeekend: boolean; addressLine: string | null;
  /** Past its moment: §8 says send at the next office opportunity and flag Kyle. */
  overdue: boolean;
  /** Less than 24 hours between the send and the session: Kyle is told too. */
  urgent: boolean;
  decision: ReminderDecision;
  suppressionReason: string | null;
  nextEligibleAt: Date | null;
  dedupeKey: string;
  retryOfId: string | null;
  reason: string;
};

/** Live orders really do carry "August 2026 Social Content, West Chester, PA
 *  19382" and "[No address provided], 40.02,-76.52" as their address (Phase 0,
 *  verified against Aryeo), so a general filming AREA is the house pattern and
 *  not an error. What it is not is an exact address, and the one thing an exact
 *  address always has is a street number in front of a street name. Conservative
 *  on purpose: this decides whether a row appears in an internal preview. */
export function looksLikeGeneralArea(addressLine: string | null): boolean {
  const s = (addressLine ?? "").trim();
  if (!s) return true;
  if (/no address provided/i.test(s)) return true;
  return !/^\d+[A-Za-z]?\s+\S/.test(s);
}

/** The one attempt a session gets: `<enrollment>:<month>:CONFIRM_ADDRESS:<sessionKey>:1`. */
export const addressReminderKey = (enrollmentId: string, monthKey: string, sessionKey: string) => `${enrollmentId}:${monthKey}:CONFIRM_ADDRESS:${sessionKey}:1`;

/**
 * §8's missing-address reminder, per session (CP-05). One attempt per session
 * (a second email about the same address is noise, and Kyle's urgent task is
 * the backstop), at 48 elapsed hours before filming moved back to Friday, or
 * at the next window when that moment has passed. The preview and the send
 * share this one function, so "what would go out" is what goes out.
 */
async function evaluateAddressLane(
  e: EnrollmentRow,
  month: { id: string; monthKey: string },
  now: Date,
  p: ReminderPolicy,
  feeds: BookingFeeds,
  clientWindowOpen: boolean,
  opts: { dryRun: boolean; ignoreReminderId?: string | null; onlySessionKey?: string | null },
): Promise<AddressReminderPreview[]> {
  const { upcomingProgramSessions, sessionNeedsAddress } = await import("@/lib/sessionAddress");
  const sessions = (await upcomingProgramSessions(month.id, now)).filter((s) => !opts.onlySessionKey || s.key === opts.onlySessionKey);
  const isTest = isTestClientName(e.client.name);
  const out: AddressReminderPreview[] = [];
  for (const s of sessions) {
    if (!(await sessionNeedsAddress(s))) continue;
    const remindAt = addressReminderAt(s.startsAt, p);
    const raw = new Date(s.startsAt.getTime() - p.addressReminderHoursBefore * 3_600_000);
    const dedupeKey = addressReminderKey(e.id, month.monthKey, s.key);
    const inWindow = inPolicyWindow(now, p) && clientWindowOpen;
    const sendAt = now < remindAt ? remindAt : inWindow ? now : nextPolicyWindowOpen(now, p);
    const base = {
      enrollmentId: e.id, clientName: e.client.name, monthKey: month.monthKey, monthId: month.id, projectId: s.projectId, sessionKey: s.key,
      shootAt: s.startsAt, remindAt, movedOffWeekend: remindAt.getTime() !== raw.getTime(), addressLine: s.area, overdue: remindAt <= now,
      urgent: s.startsAt.getTime() - sendAt.getTime() < 24 * 3_600_000, dedupeKey, retryOfId: null as string | null,
    };
    const push = (decision: ReminderDecision, reason: string, suppressionReason: string | null = null, nextEligibleAt: Date | null = null) =>
      out.push({ ...base, decision, reason, suppressionReason, nextEligibleAt });
    const existing = await prisma.programReminder.findUnique({ where: { dedupeKey }, select: { id: true, state: true, nextAttemptAt: true } });
    if (existing && existing.id !== opts.ignoreReminderId) {
      if (existing.state === "FAILED" && existing.nextAttemptAt && existing.nextAttemptAt <= now) base.retryOfId = existing.id;
      else { push("none", `this session's address reminder already exists (${existing.state.toLowerCase()})`); continue; }
    }
    if (e.status !== "ACTIVE") { push("suppressed", `the program is ${e.status.toLowerCase()}`, "paused"); continue; }
    if (now < remindAt) { push("wait", `address reminder due ${fmtDay(remindAt)}`, null, remindAt); continue; }
    // Late is still worth sending, but Kyle is told once: an email read on
    // the morning of the shoot is too late to be the only safeguard.
    if (base.urgent && !opts.dryRun) await raiseUrgentAddressTask(e, month, s.key, s.startsAt, s.area, now);
    if (p.testClientsOnly && !isTest) { push("suppressed", "policy.testClientsOnly is on — only TEST clients may receive until launch is authorised", "launch_not_authorised"); continue; }
    if (!feeds.session.fresh) { push("suppressed", `the Aryeo booking feed is not trustworthy right now (${feeds.session.detail})`, "stale_scheduler_sync"); continue; }
    const to = await recipientFor(e);
    if (!to) { push("suppressed", "no email address on the portal seat or the client record", "no_recipient"); continue; }
    if (isTest && !isStaffControlledEmail(to.email)) { push("suppressed", `TEST client's address ${maskToRef("email", to.email)} is not staff-controlled`, "test_client_real_address"); continue; }
    const dayFrom = etAt(etDayKey(now), 0);
    const dayTo = etAt(shiftKey(etDayKey(now), 1), 0);
    const sentToday = await prisma.programReminder.count({
      where: {
        enrollmentId: e.id, channel: { in: ["email", "copy"] },
        ...(opts.ignoreReminderId ? { id: { not: opts.ignoreReminderId } } : {}),
        OR: [{ state: "SENT", sentAt: { gte: dayFrom, lt: dayTo } }, { state: "QUEUED", createdAt: { gte: dayFrom, lt: dayTo } }],
      },
    });
    if (sentToday >= p.maxClientEmailsPerDay) {
      const next = nextPolicyWindowOpen(etAt(shiftKey(etDayKey(now), 1), 0), p);
      push("wait", `${sentToday} program email already went to this client today — the next one waits until ${fmtDay(next)}`, "another_reminder_today", next);
      continue;
    }
    if (!inWindow) { const next = nextPolicyWindowOpen(now, p); push("wait", `outside the send window — next opening ${fmtDay(next)}`, "quiet_hours", next); continue; }
    push("send", `${base.overdue && remindAt.getTime() < now.getTime() - 3_600_000 ? "late: " : ""}exact address still missing for the ${fmtDay(s.startsAt)} session${base.urgent ? " (inside 24 hours — Kyle told too)" : ""}`);
  }
  return out;
}

/** Kyle hears about a late address once per session (find-then-create). TEST
 *  clients make no owner work unless a probe asks (PROGRAM_DESK_TASKS_FOR_TEST). */
async function raiseUrgentAddressTask(e: EnrollmentRow, month: { id: string; monthKey: string }, sessionKey: string, startsAt: Date, area: string | null, now: Date): Promise<void> {
  if (isTestClientName(e.client.name) && process.env.PROGRAM_DESK_TASKS_FOR_TEST !== "1") return;
  const dedupeKey = `program-address-urgent:${sessionKey}`;
  if (await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } })) return;
  const owner = await escalationOwner(e.id, month.id, "SCHEDULING").catch(() => null);
  await prisma.smartTask.create({
    data: {
      taskType: "todo", status: "OPEN", source: "content_program", priority: "URGENT",
      title: `${e.client.name}: no exact filming address yet`.slice(0, 140),
      summary: `The session starts ${fmtDay(startsAt)} and all we have is "${area ?? "a general area"}". The reminder email goes at the next office opening, which is under 24 hours before filming.`.slice(0, 500),
      description: `Call or text the client for the exact address, then put it on the booking (or enter it on /content/${e.id}#sessions).`,
      reasonCreated: "Content session missing address, inside 24 hours (spec §8, CP-05)",
      clientId: e.clientId, assignedKey: owner?.assignedKey ?? "kyle", dedupeKey, dueAt: new Date(Math.min(startsAt.getTime(), now.getTime() + 4 * 3_600_000)),
    },
  }).catch(() => null);
}

/** One ADDRESS send: ledger row → recheck → mint the session's link → outbox → outcome. */
async function dispatchAddress(a: AddressReminderPreview, e: EnrollmentRow, p: ReminderPolicy, now: Date, opts: { requestedBy: string; feeds: BookingFeeds; clientWindowOpen: boolean }): Promise<DispatchOutcome> {
  const leaseBy = `${opts.requestedBy}:${process.pid}`;
  const templateKey = "reminder.confirm_address.v1";
  let reminderId: string;
  if (a.retryOfId) {
    const won = await prisma.programReminder.updateMany({ where: { id: a.retryOfId, state: "FAILED" }, data: { state: "PENDING", leaseUntil: new Date(now.getTime() + 5 * 60_000), leaseBy, nextAttemptAt: null } });
    if (won.count === 0) return { reminderId: a.retryOfId, outcome: "duplicate", detail: "another run already took this retry" };
    reminderId = a.retryOfId;
  } else {
    try {
      const row = await prisma.programReminder.create({
        data: {
          enrollmentId: e.id, clientId: e.clientId, monthId: a.monthId, monthKey: a.monthKey, action: "CONFIRM_ADDRESS", templateKey, templateVersion: reminderTemplate(templateKey).version,
          channel: "email", attempt: 1, state: "PENDING", leaseUntil: new Date(now.getTime() + 5 * 60_000), leaseBy, manual: false, requestedBy: opts.requestedBy, dedupeKey: a.dedupeKey, nextEligibleAt: a.remindAt,
        },
        select: { id: true },
      });
      reminderId = row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { reminderId: null, outcome: "duplicate", detail: `the address reminder for ${a.sessionKey} already exists` };
      throw err;
    }
  }
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id: e.id }, select: { status: true } });
  const fresh = enrollment ? (await evaluateAddressLane({ ...e, status: enrollment.status }, { id: a.monthId, monthKey: a.monthKey }, now, p, opts.feeds, opts.clientWindowOpen, { dryRun: false, ignoreReminderId: reminderId, onlySessionKey: a.sessionKey }))[0] ?? null : null;
  if (!fresh || fresh.decision !== "send") {
    const reason = fresh?.suppressionReason ?? (fresh ? (fresh.decision === "wait" ? "quiet_hours" : "state_changed") : "address_received");
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "SUPPRESSED", suppressionReason: reason, leaseUntil: null, leaseBy: null, lastError: fresh?.reason ?? "the session no longer needs an address (given, moved or cancelled)" } });
    return { reminderId, outcome: "suppressed", detail: reason };
  }
  const to = await recipientFor(e);
  if (!to) {
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "SUPPRESSED", suppressionReason: "no_recipient", leaseUntil: null, leaseBy: null } });
    return { reminderId, outcome: "suppressed", detail: "no recipient" };
  }
  // THE SESSION'S OWN LINK, not resolvePortalLink: that one is a 15-minute
  // sign-in link landing on /portal/me, dead long before a Friday email for a
  // Monday session is opened. This one opens only this session's form, until
  // the session starts. Only its hash is stored; the raw token lives in the email.
  const { upcomingProgramSessions, ensureSessionAddressRow } = await import("@/lib/sessionAddress");
  const session = (await upcomingProgramSessions(a.monthId, now)).find((s) => s.key === a.sessionKey);
  if (!session) {
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "SUPPRESSED", suppressionReason: "state_changed", leaseUntil: null, leaseBy: null } });
    return { reminderId, outcome: "suppressed", detail: "the session is no longer upcoming" };
  }
  const { rawToken } = await ensureSessionAddressRow(session);
  const addressLink = `${appBase()}/portal/address/${rawToken}`;
  const body = renderReminder(reminderTemplate(templateKey), {
    firstName: firstNameOf(e.client.name), month: monthName(a.monthKey), portalLink: addressLink, bookCallLink: null, noCallEligible: false, answersStarted: false,
    sessionNote: null, earliestSession: null, itemCount: 0, titles: [], updatedTitles: [], deadline: null,
    sessionWhen: `${session.startsAt.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`,
    areaText: session.area, addressLink,
  });
  await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "QUEUED", toRef: to.email, evaluatedStateJson: JSON.stringify({ sessionKey: a.sessionKey, shootAt: a.shootAt.toISOString(), area: a.addressLine, urgent: a.urgent, portalLinkKind: "session_address" }) } });
  const r = await sendThroughOutbox(
    { channel: "email", toRef: to.email, body, dedupeKey: programReminderKey("CONFIRM_ADDRESS", reminderId, a.monthKey), clientId: e.clientId, requestedBy: opts.requestedBy },
    { workerId: leaseBy },
  );
  return recordSendResult(reminderId, r, now);
}

/** Has the exact address for this reminder's session been given? */
async function addressReceived(dedupeKey: string | null): Promise<boolean> {
  const key = addressReminderSessionKey(dedupeKey);
  if (!key) return false;
  const row = await prisma.programSessionAddress.findUnique({ where: { sessionKey: key }, select: { submittedAt: true } });
  return !!row?.submittedAt;
}

/** The session a CONFIRM_ADDRESS ledger row is about, out of its dedupeKey. */
export function addressReminderSessionKey(dedupeKey: string | null): string | null {
  const m = /:CONFIRM_ADDRESS:(.+):\d+$/.exec(dedupeKey ?? "");
  return m ? m[1] : null;
}

/** ONE task per ET day for the whole run, whoever the affected clients are —
 *  the fault is the integration's, not any one client's. TEST-only runs make no
 *  owner work, the same rule the rest of this file follows. */
async function raiseSchedulerStaleTask(stale: ReminderCandidate[], sync: SchedulerSync, now: Date, why: string): Promise<void> {
  const real = stale.filter((c) => !c.isTest);
  if (real.length === 0) return;
  const owner = await escalationOwner(real[0].enrollmentId, real[0].monthId, "SCHEDULING").catch(() => null);
  await prisma.smartTask
    .create({
      data: {
        taskType: "todo", status: "OPEN", source: "content_program", priority: "HIGH",
        title: `Content-program reminders are holding: ${sync.detail}`.slice(0, 140),
        summary: `${real.length} client month(s) got no booking reminder this run. ${why}`.slice(0, 500),
        description: `${why}\n\nAffected months: ${real.slice(0, 20).map((c) => `${c.clientName} ${c.monthKey}`).join(", ")}${real.length > 20 ? ` and ${real.length - 20} more` : ""}.\n\nThe evaluator refuses to tell a client "you still haven't booked" while the booking feed is stale — it would be guessing. Fix whichever feed the reason above names (the monthly-strategy mapping on Settings → Calendly & calls, or the Aryeo connection on Settings → Connections); the next hourly run clears this on its own.`,
        reasonCreated: "Content-program reminders suppressed by a stale scheduler sync (spec §24)",
        assignedKey: owner?.assignedKey ?? null, dedupeKey: `program-reminder-scheduler-stale:${etDayKey(now)}`, dueAt: new Date(now.getTime() + 4 * 3_600_000),
      },
      select: { id: true },
    })
    .catch(() => null); // P2002 = already raised today
}

// ---- reconciliation (uncertain delivery, bounces, stale leases, cancelled by booking) ----

export async function reconcileReminderOutcomes(opts: { now?: Date } = {}): Promise<{ checked: number; settled: number; cancelled: number; escalatedFailures: number }> {
  const now = opts.now ?? new Date();
  let settled = 0, cancelled = 0, escalatedFailures = 0;
  // A row already in the outbox is no longer covered by the switch its author
  // read: the recovery drain (cron `gmail`) re-checks only the send window, so
  // turning an automation OFF would not stop a message already queued. We stop
  // it here instead — the switch is re-read per kind, per pass.
  const [remindersOn, shareOn] = await Promise.all([isAutomationEnabled(REMINDERS_KEY), isAutomationEnabled("script_share_email")]);
  const switchOnFor = (action: string) => (action === "SCRIPTS_READY" || action === "STRATEGY_READY" ? shareOn : remindersOn);
  const open = await prisma.programReminder.findMany({ where: { state: { in: ["PENDING", "QUEUED", "UNKNOWN", "FAILED"] }, action: { not: "ESCALATION" } }, take: 200 });
  for (const r of open) {
    // A QUEUED row with NO outbox id and a dead lease died between the claim
    // and the outbox call — the sender crashed in the one-statement window
    // where the row says "mine" but nothing has been handed over. Neither the
    // evaluator (which only retries FAILED) nor the share drain (which only
    // picks up PENDING/FAILED) would ever look at it again, so it would sit
    // there for ever: no email, no task, no log line. Make it a retryable
    // failure and let the ordinary paths have it.
    if (r.state === "QUEUED" && !r.outboxMessageId && (!r.leaseUntil || r.leaseUntil < now)) {
      await prisma.programReminder.update({ where: { id: r.id }, data: { state: "FAILED", outcome: "failed", lastError: "the sender stopped before this reached the outbox — nothing was sent", lastErrorAt: now, failedAt: now, nextAttemptAt: now, leaseUntil: null, leaseBy: null } });
      await prisma.contentScriptRelease.updateMany({ where: { reminderId: r.id }, data: { notificationState: "FAILED", note: "The sender stopped before the email reached the outbox — nothing was sent; it retries on its own. The approval and the portal release stand." } });
      settled++;
      continue;
    }
    // A PENDING row whose lease expired never reached the outbox (dispatch
    // died before the send): it becomes a retryable FAILED, never a send.
    if (r.state === "PENDING" && r.leaseUntil && r.leaseUntil < now) {
      await prisma.programReminder.update({ where: { id: r.id }, data: { state: "FAILED", outcome: "failed", lastError: "the evaluator stopped before this reached the outbox — nothing was sent", lastErrorAt: now, failedAt: now, nextAttemptAt: now, leaseUntil: null, leaseBy: null } });
      settled++;
      continue;
    }
    if ((r.state === "QUEUED" || r.state === "UNKNOWN") && r.outboxMessageId) {
      const ob = await prisma.outboxMessage.findUnique({ where: { id: r.outboxMessageId }, select: { state: true, providerId: true, providerError: true, acceptedAt: true, dedupeKey: true } });
      if (!ob) continue;
      if (ob.state === "accepted") { await prisma.programReminder.update({ where: { id: r.id }, data: { state: "SENT", outcome: "accepted", providerMessageId: ob.providerId, sentAt: ob.acceptedAt ?? now, lastError: null } }); settled++; }
      else if (ob.state === "failed" && r.state === "QUEUED") { await prisma.programReminder.update({ where: { id: r.id }, data: { state: "FAILED", outcome: "failed", failedAt: now, lastError: ob.providerError, lastErrorAt: now, nextAttemptAt: new Date(now.getTime() + 60 * 60_000) } }); settled++; }
      else if (ob.state === "unknown" && r.state === "QUEUED") { await prisma.programReminder.update({ where: { id: r.id }, data: { state: "UNKNOWN", outcome: "unknown", lastError: ob.providerError, lastErrorAt: now } }); settled++; }
      else if (ob.state === "pending" && r.state === "QUEUED") {
        // Still waiting in the outbox. If the month got booked / snoozed / paused
        // meanwhile, pull it back: a booking stops a queued reminder (spec §24).
        // Only a PENDING outbox row is touched — an attempting one is mid-send.
        const month = await prisma.contentMonth.findUnique({ where: { id: r.monthId ?? "" }, select: { remindersSnoozedUntil: true, strategyCallStatus: true } });
        const en = await prisma.contentEnrollment.findUnique({ where: { id: r.enrollmentId }, select: { status: true } });
        const booked = month?.strategyCallStatus === "SCHEDULED" || month?.strategyCallStatus === "COMPLETED";
        const switchOff = !switchOnFor(r.action);
        // CP-05: the exact address arrived while the email waited — it would
        // now ask for something the client has already given us.
        const addressIn = r.action === "CONFIRM_ADDRESS" && (await addressReceived(r.dedupeKey));
        const stop = switchOff || en?.status !== "ACTIVE" || (month?.remindersSnoozedUntil && month.remindersSnoozedUntil > now) || ((r.action === "BOOK_CALL" || r.action === "CHOOSE_PATH") && booked) || addressIn;
        if (stop) {
          const why = switchOff ? "the automation was switched off" : en?.status !== "ACTIVE" ? (en?.status === "PAUSED" ? "paused" : "ended") : addressIn ? "address_received" : booked ? "booked" : "snoozed";
          const released = await markFailed(r.outboxMessageId, `cancelled before send: ${why}`);
          if (released) {
            await prisma.programReminder.update({ where: { id: r.id }, data: { state: "CANCELLED", suppressionReason: switchOff ? "switched_off" : why, lastError: `cancelled before send: ${why}`, lastErrorAt: now } });
            await prisma.contentScriptRelease.updateMany({ where: { reminderId: r.id }, data: { notificationState: "SUPPRESSED", note: `Email cancelled before it went out: ${why}. The approval and the portal release stand.` } });
            cancelled++;
          }
        }
      }
    }
    // A failed address reminder whose address has since arrived is over — its
    // retry would ask for something we already have (CP-05).
    if (r.state === "FAILED" && r.action === "CONFIRM_ADDRESS" && (await addressReceived(r.dedupeKey))) {
      await prisma.programReminder.update({ where: { id: r.id }, data: { state: "CANCELLED", suppressionReason: "address_received", nextAttemptAt: null, lastErrorAt: now } });
      cancelled++;
      continue;
    }
    // Persistent failure / unconfirmed delivery → the escalation owner hears about it once.
    const persistent = (r.state === "FAILED" && !r.nextAttemptAt) || r.state === "UNKNOWN" || r.state === "BOUNCED";
    if (persistent && !r.escalationTaskId) {
      const client = await prisma.client.findUnique({ where: { id: r.clientId }, select: { name: true } });
      if (isTestClientName(client?.name)) continue; // TEST records make no owner work
      const owner = await escalationOwner(r.enrollmentId, r.monthId ?? "", "ESCALATION");
      const task = await prisma.smartTask.create({
        data: {
          taskType: "todo", status: "OPEN", source: "content_program", priority: "MEDIUM",
          title: `${client?.name ?? "Client"}: ${r.monthKey ?? ""} reminder ${r.state === "BOUNCED" ? "bounced" : r.state === "UNKNOWN" ? "unconfirmed" : "failed"}`.slice(0, 140),
          summary: `${r.action} reminder (attempt ${r.attempt}) to ${maskToRef("email", r.toRef ?? "")}: ${r.lastError ?? r.state}`.slice(0, 500),
          description: `The hub could not confirm this reminder reached the client.\n\nState: ${r.state}\nReason: ${r.lastError ?? "—"}\n\n${r.state === "UNKNOWN" ? "Check the Sent folder / Connections → unconfirmed sends, then Retry there or contact the client another way." : "Fix the address on the client record or reach the client another way; the evaluator will not retry this attempt on its own."}`,
          reasonCreated: "Content-program reminder delivery problem (spec §24)",
          clientId: r.clientId, assignedKey: owner.assignedKey, dedupeKey: `program-reminder-delivery:${r.id}`, dueAt: new Date(now.getTime() + 864e5),
        },
        select: { id: true },
      }).catch(() => null);
      if (task) { await prisma.programReminder.update({ where: { id: r.id }, data: { escalationTaskId: task.id, escalatedToAppUserId: owner.appUserId } }); escalatedFailures++; }
    }
  }
  return { checked: open.length, settled, cancelled, escalatedFailures };
}

/** A bounce reported by the mailbox (HANDOVER: the Gmail poller can call this
 *  when a mailer-daemon reply quotes one of our provider ids). Marks the
 *  attempt BOUNCED; the reconcile pass then raises the task. */
export async function recordReminderBounce(providerMessageId: string, reason: string): Promise<boolean> {
  const r = await prisma.programReminder.updateMany({ where: { providerMessageId, state: { in: ["SENT", "QUEUED", "UNKNOWN"] } }, data: { state: "BOUNCED", outcome: "bounced", lastError: reason.slice(0, 500), lastErrorAt: new Date() } });
  return r.count > 0;
}

// ---- manual actions (same safeguards, same history) ---------------------------------

export type ManualResult = { ok: boolean; message: string; candidate?: ReminderCandidate; link?: string; body?: string; reminderId?: string | null };

/**
 * THE ROW IDENTITY A PERSON CLICKS (F20 review, Sep 21 2026).
 *
 * §12 evaluates every month once per lane, so a month id on its own does not
 * identify a row on the dry-run table: a month with a released cut waiting on
 * the client produces a planning row and a review row, and "Send now" on the
 * review row was silently acting on the planning lane — the client would have
 * received the wrong message entirely. The lane rides along with the month id
 * through the settings action, because that action's file is not this batch's
 * to widen, and a BARE month id still reads as PRIMARY so every existing caller
 * is unchanged. Month ids are cuids and never contain "#".
 */
export function reminderRowId(monthId: string, lane: ReminderLane): string {
  return `${monthId}#${lane}`;
}
export function parseReminderRowId(rowId: string): { monthId: string; lane: "PRIMARY" | "REVIEW" } {
  const hash = rowId.indexOf("#");
  if (hash < 0) return { monthId: rowId, lane: "PRIMARY" };
  return { monthId: rowId.slice(0, hash), lane: rowId.slice(hash + 1) === "REVIEW" ? "REVIEW" : "PRIMARY" };
}

async function loadForManual(monthId: string, now: Date, policyOpt: { orDefaults: boolean }) {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, monthKey: true, status: true, remindersSnoozedUntil: true } });
  if (!month) throw new Error("Month not found.");
  const en = await prisma.contentEnrollment.findUnique({ where: { id: month.enrollmentId }, select: ENROLLMENT_SELECT });
  if (!en) throw new Error("Enrollment not found.");
  const client = await prisma.client.findUnique({ where: { id: en.clientId }, select: { name: true, email: true } });
  const firstMonths = await firstMonthKeysFor([en.id], new Map([[en.id, en.startedAt]]));
  const e: EnrollmentRow = { ...en, firstMonthKey: firstMonths.get(en.id) ?? null, client: { name: client?.name ?? "", email: client?.email ?? null } };
  const { enabled, policy } = await reminderPolicy(policyOpt);
  const feeds = await bookingFeeds(now, policy ?? REMINDER_DEFAULTS);
  const clientWindowOpen = await clientTextWindowOpen(now);
  return { month, e, enabled, policy: policy ?? REMINDER_DEFAULTS, feeds, clientWindowOpen };
}

/**
 * THE PREVIEW (F20, Sep 21 2026). What this month's reminder calendar is, what
 * the next message would say, and why it is or is not going. It WRITES NOTHING
 * — not a ledger row, not a login link, not an owner task — which is what
 * separates it from copyReminderLink, whose whole job is to record that a human
 * pasted the text into a message they then sent themselves.
 *
 * `portalLink` therefore shows the token page or a placeholder: minting a
 * sign-in link voids the one the client is holding, and a preview must not be
 * able to do that to somebody.
 */
export type ReminderPreview = {
  monthKey: string;
  clientName: string;
  calendar: MonthlyCalendar;
  lanes: { lane: ReminderLane; candidate: ReminderCandidate; body: string | null }[];
  addressLane: AddressReminderPreview[];
};

export async function previewReminders(monthId: string, opts: { now?: Date } = {}): Promise<ReminderPreview> {
  const now = opts.now ?? new Date();
  const { month, e, policy, feeds, clientWindowOpen } = await loadForManual(monthId, now, { orDefaults: true });
  const lanes: ReminderPreview["lanes"] = [];
  for (const lane of ["PRIMARY", "REVIEW"] as const) {
    const c = await evaluateMonth(e, month, now, policy, feeds, clientWindowOpen, lane);
    let body: string | null = null;
    if (c.action && c.templateKey) {
      const tokenLink = e.portalToken && !e.accessRevokedAt ? `${appBase()}/portal/${e.portalToken}` : "(no portal link has been issued for this client yet)";
      body = withExtraParagraph(renderReminder(reminderTemplate(c.templateKey), await templateVarsFor(c, e, tokenLink, c)), c.extraParagraph);
    }
    lanes.push({ lane, candidate: c, body });
  }
  return {
    monthKey: month.monthKey,
    clientName: e.client.name,
    calendar: monthlyCalendar(month.monthKey, policy),
    lanes,
    addressLane: await evaluateAddressLane(e, month, now, policy, feeds, clientWindowOpen, { dryRun: true }),
  };
}

/**
 * COPY LINK: the rendered text + the portal link for a person to paste into
 * their own message. Sends nothing, so it works with the switch off — but the
 * suppression rules still apply (a booked month has no link to copy), and the
 * copy is recorded as an attempt (channel "copy") so the cadence counts it.
 */
export async function copyReminderLink(rowId: string, by: { email: string; appUserId?: string | null }, opts: { now?: Date } = {}): Promise<ManualResult> {
  const now = opts.now ?? new Date();
  // `rowId` is the month id, optionally carrying the lane the person clicked.
  const { monthId, lane } = parseReminderRowId(rowId);
  const { month, e, policy, feeds } = await loadForManual(monthId, now, { orDefaults: true });
  // Cadence, quiet hours and the launch lock do not bind a human copying text;
  // the derivation and the state-based suppressions do. maxClientEmailsPerDay
  // is lifted for the same reason: a person who has decided to write to this
  // client today is not the automation doubling up on itself.
  const c = await evaluateMonth(e, month, now, { ...policy, testClientsOnly: false, firstReminderDelayBusinessDays: 0, followUpAfterBusinessDays: 0, reviewFollowUpBusinessDays: 0, maxAttemptsPerAction: 99, reviewMaxAttempts: 99, maxClientEmailsPerDay: 99 }, feeds, true, lane);
  if (c.decision === "suppressed" && c.suppressionReason !== "test_client_real_address") return { ok: false, message: `Nothing to copy — ${c.reason}.`, candidate: c };
  if (!c.action || !c.templateKey) return { ok: false, message: `Nothing to copy — ${c.reason}.`, candidate: c };
  const to = await recipientFor(e);
  const link = await resolvePortalLink(e, to, by.appUserId ?? null, now, { path: c.linkPath });
  if (!link) return { ok: false, message: "No portal link exists for this client yet (no seat, no token).", candidate: c };
  const body = withExtraParagraph(renderReminder(reminderTemplate(c.templateKey), await templateVarsFor(c, e, link.url, c)), c.extraParagraph);
  const row = await prisma.programReminder.create({
    data: {
      enrollmentId: e.id, clientId: e.clientId, monthId: month.id, monthKey: month.monthKey, action: c.action, templateKey: c.templateKey, templateVersion: reminderTemplate(c.templateKey).version,
      channel: "copy", toRef: to?.email ?? null, attempt: c.attempt || 1, state: "SENT", outcome: "copied", sentAt: now, manual: true, requestedBy: by.email,
      evaluatedStateJson: JSON.stringify({ ...c.state, portalLinkKind: link.kind }), dedupeKey: `${e.id}:${month.monthKey}:${c.action}:copy:${now.toISOString()}`,
    },
    select: { id: true },
  });
  return { ok: true, message: `Copied — a ${link.kind === "login" ? "one-time sign-in link (15 minutes)" : "portal link"} for ${e.client.name}. Recorded in the reminder history.`, candidate: c, link: link.url, body, reminderId: row.id };
}

/**
 * SEND NOW: an owner's deliberate send. Still needs the switch ON, still
 * refuses a suppressed month, still holds outside the send window; it only
 * overrides the cadence (a human decided it is time).
 */
export async function sendReminderNow(rowId: string, by: { email: string; appUserId?: string | null }, opts: { now?: Date } = {}): Promise<ManualResult> {
  const now = opts.now ?? new Date();
  if (!(await isAutomationEnabled(REMINDERS_KEY))) return { ok: false, message: "Reminders are switched off (Settings → Automations). Copy the link instead." };
  // `rowId` is the month id, optionally carrying the lane the person clicked.
  const { monthId, lane } = parseReminderRowId(rowId);
  const { month, e, enabled, policy, feeds, clientWindowOpen } = await loadForManual(monthId, now, { orDefaults: false });
  // The switch is on but reminderPolicy still says no: the SAVED policy failed
  // validation, so the hourly pass is doing nothing. Send now must not quietly
  // run on code defaults while the settings panel shows the errors — the two
  // surfaces would disagree about whether reminders are running at all.
  if (!enabled) return { ok: false, message: "The saved reminder policy is not valid, so nothing is running on it (Settings → Reminders lists the errors). Fix the policy, or copy the link and send it yourself." };
  // A human overriding the cadence is not a human overriding the milestone: the
  // one-a-day rule and the mid-month exemptions stay exactly as the evaluator
  // computed them, because those protect the client, not the schedule.
  const c = await evaluateMonth(e, month, now, { ...policy, firstReminderDelayBusinessDays: 0, followUpAfterBusinessDays: 0, reviewFollowUpBusinessDays: 0 }, feeds, clientWindowOpen, lane);
  if (c.decision === "suppressed") return { ok: false, message: `Not sent — ${c.reason}.`, candidate: c };
  if (c.decision === "wait") return { ok: false, message: `Not sent — ${c.reason}.`, candidate: c };
  if (c.decision !== "send") return { ok: false, message: `Not sent — ${c.reason}.`, candidate: c };
  const r = await dispatch(c, e, policy, now, { requestedBy: `send-now:${by.email}`, manual: true, byAppUserId: by.appUserId ?? null, feeds, clientWindowOpen });
  return { ok: r.outcome === "sent", message: r.outcome === "sent" ? `Sent to ${c.to}.` : `${r.outcome}: ${r.detail}`, candidate: c, reminderId: r.reminderId };
}

export async function snoozeMonthReminders(monthId: string, until: Date, reason: string, by: string): Promise<void> {
  if (reason.trim().length < 3) throw new Error("A snooze needs a reason.");
  await prisma.contentMonth.update({ where: { id: monthId }, data: { remindersSnoozedUntil: until, remindersSnoozedBy: by, remindersSnoozeReason: reason.trim() } });
}
export async function unsnoozeMonthReminders(monthId: string): Promise<void> {
  await prisma.contentMonth.update({ where: { id: monthId }, data: { remindersSnoozedUntil: null, remindersSnoozedBy: null, remindersSnoozeReason: null } });
}

// ---- the ledger view ------------------------------------------------------------------

export type ReminderLedgerRow = {
  id: string; clientName: string; enrollmentId: string; monthKey: string | null; action: string; templateKey: string; attempt: number; channel: string;
  state: string; outcome: string | null; suppressionReason: string | null; to: string | null; sentAt: Date | null; nextEligibleAt: Date | null; nextAttemptAt: Date | null;
  lastError: string | null; manual: boolean; requestedBy: string | null; providerMessageId: string | null; outboxState: string | null; createdAt: Date;
};

export async function reminderLedger(opts: { take?: number; enrollmentId?: string } = {}): Promise<ReminderLedgerRow[]> {
  const rows = await prisma.programReminder.findMany({ where: opts.enrollmentId ? { enrollmentId: opts.enrollmentId } : {}, orderBy: { createdAt: "desc" }, take: opts.take ?? 60 });
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const out: ReminderLedgerRow[] = [];
  for (const r of rows) {
    const obRow = r.outboxMessageId ? await prisma.outboxMessage.findUnique({ where: { id: r.outboxMessageId }, select: { state: true } }).catch(() => null) : null;
    out.push({
      id: r.id, clientName: clients.get(r.clientId) ?? "?", enrollmentId: r.enrollmentId, monthKey: r.monthKey, action: r.action, templateKey: r.templateKey, attempt: r.attempt, channel: r.channel,
      state: r.state, outcome: r.outcome, suppressionReason: r.suppressionReason, to: r.toRef ? maskToRef("email", r.toRef) : null, sentAt: r.sentAt, nextEligibleAt: r.nextEligibleAt, nextAttemptAt: r.nextAttemptAt,
      lastError: r.lastError, manual: r.manual, requestedBy: r.requestedBy, providerMessageId: r.providerMessageId, outboxState: obRow?.state ?? null, createdAt: r.createdAt,
    });
  }
  return out;
}
