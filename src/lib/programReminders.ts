import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { automationConfig, getAutomation, isAutomationEnabled, type AutomationKey } from "@/lib/programAutomation";
import { recalcProgramMonth, addBusinessDaysET, type DerivedMonthState } from "@/lib/programMonths";
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
// ---------------------------------------------------------------------------

export const REMINDERS_KEY: AutomationKey = "reminders";

export type ReminderPolicy = {
  timezone: string;
  businessHours: { days: number[]; start: string; end: string };
  sender: string;
  escalationOwnerDuty: string;
  planningOpensDaysBeforeMonth: number;
  planningDeadlineDayOfPrevMonth: number;
  firstReminderDelayBusinessDays: number;
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
  /** BOOK_SESSION deadline: this day of the program month. */
  sessionBookingDeadlineDayOfMonth: number;
  /** Approve & share: releases inside this window go out as ONE email. */
  scriptShareBatchMinutes: number;
  /** Hard cap per evaluator run — a bug cannot email the whole roster in one tick. */
  maxSendsPerRun: number;
};

export const REMINDER_DEFAULTS: ReminderPolicy = {
  timezone: "America/New_York",
  businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "16:30" },
  sender: "info@realtourpilot.com",
  escalationOwnerDuty: "ESCALATION",
  planningOpensDaysBeforeMonth: 14,
  planningDeadlineDayOfPrevMonth: 25,
  firstReminderDelayBusinessDays: 0,
  followUpAfterBusinessDays: 3,
  maxAttemptsPerAction: 2,
  escalateWhenDeadlineWithinBusinessDays: 3,
  digestBothAppointments: true,
  includeNoCallOptionOnlyIfEligible: true,
  suppressWhen: ["booked", "no_call_chosen", "preparation_submitted", "paused", "ended", "snoozed", "pending_session_request", "stale_scheduler_sync"],
  templates: { ...DEFAULT_TEMPLATE_IDS },
  testClientsOnly: true,
  includePastMonths: false,
  staleSchedulerSyncHours: 6,
  reviewWorkAfterBusinessDays: 2,
  sessionBookingDeadlineDayOfMonth: 20,
  scriptShareBatchMinutes: 15,
  maxSendsPerRun: 20,
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
export function businessDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let n = 0;
  let key = etDayKey(from);
  const end = etDayKey(to);
  while (key < end) {
    const [y, m, d] = key.split("-").map(Number);
    key = new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

const monthStart = (monthKey: string) => etAt(`${monthKey}-01`, 0);
const prevMonthKey = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); const d = new Date(Date.UTC(y, m - 2, 15)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const currentMonthKey = (now: Date) => etDayKey(now).slice(0, 7);
const fmtDay = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" }) : null);

// ---- what the evaluator reads per month --------------------------------------

export type EvaluatedState = {
  strategyCallStatus: string;
  planningMode: string;
  preparationStatus: string | null;
  callMode: string;
  earliestSessionAt: string | null;
  sessionBooked: boolean;
  sessionFilmed: boolean;
  pendingSessionRequest: boolean;
  releasedCutsAwaiting: number;
  oldestReleaseAt: string | null;
  snoozedUntil: string | null;
  enrollmentStatus: string;
  schedulerSync: { fresh: boolean; detail: string };
};

export type ReminderDecision = "send" | "wait" | "suppressed" | "none" | "escalate";

export type ReminderCandidate = {
  enrollmentId: string;
  clientId: string;
  clientName: string;
  isTest: boolean;
  monthId: string;
  monthKey: string;
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
  deadlineAt: Date | null;
  noCallEligible: boolean;
  digestSession: boolean;
  /** COMPLETE_ANSWERS: the interview has begun (wording changes). */
  answersStarted: boolean;
  /** An existing FAILED row this send would retry, instead of a new attempt. */
  retryOfId: string | null;
  escalation: { due: boolean; reason: string } | null;
  state: EvaluatedState;
};

type EnrollmentRow = {
  id: string; clientId: string; status: string; callMode: string | null; strategyCallRequired: boolean; noCallEligible: boolean | null;
  portalToken: string | null; portalTokenExpiresAt: Date | null; accessRevokedAt: Date | null;
  client: { name: string; email: string | null };
};

type SchedulerSync = { fresh: boolean; detail: string };

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

async function monthFacts(monthId: string, now: Date) {
  const [projects, requests] = await Promise.all([
    prisma.project.findMany({ where: { contentMonthId: monthId, status: { not: "CANCELLED" } }, select: { id: true, shootDate: true, status: true } }),
    prisma.programSessionRequest.findMany({ where: { monthId, status: { in: ["REQUESTED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED", "CONFIRMED"] } }, select: { status: true, projectId: true } }),
  ]);
  const future = projects.filter((p) => p.shootDate && p.shootDate.getTime() >= now.getTime() - 6 * 3_600_000);
  const past = projects.filter((p) => p.shootDate && p.shootDate.getTime() < now.getTime() - 6 * 3_600_000);
  const confirmed = requests.some((r) => r.status === "CONFIRMED");
  const pending = requests.some((r) => r.status !== "CONFIRMED");
  const released = projects.length
    ? await prisma.reviewSubmission.findMany({
        where: { projectId: { in: projects.map((p) => p.id) }, clientReleasedAt: { not: null }, clientApprovedDecisionId: null, clientRequestedAt: null, withdrawnAt: null },
        select: { clientReleasedAt: true },
      })
    : [];
  const oldest = released.reduce<Date | null>((m, r) => (r.clientReleasedAt && (!m || r.clientReleasedAt < m) ? r.clientReleasedAt : m), null);
  return { sessionBooked: future.length > 0 || confirmed, sessionFilmed: past.length > 0, pendingSessionRequest: pending, releasedCutsAwaiting: released.length, oldestReleaseAt: oldest };
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
export async function resolvePortalLink(e: Pick<EnrollmentRow, "id" | "portalToken" | "portalTokenExpiresAt" | "accessRevokedAt">, seat: { membershipId: string | null; clientUserId: string | null } | null, byAppUserId: string | null, now: Date): Promise<{ url: string; kind: "login" | "token" } | null> {
  const tokenLink = e.portalToken && !e.accessRevokedAt && (!e.portalTokenExpiresAt || e.portalTokenExpiresAt > now) ? `${appBase()}/portal/${e.portalToken}` : null;
  if (seat?.membershipId && seat.clientUserId) {
    const u = await prisma.clientUser.findUnique({ where: { id: seat.clientUserId }, select: { loginTokenExpiresAt: true } });
    const holdsLiveLink = !!u?.loginTokenExpiresAt && u.loginTokenExpiresAt > now;
    if (!holdsLiveLink) {
      try {
        const { url } = await mintLoginLink(seat.membershipId, byAppUserId);
        return { url, kind: "login" };
      } catch {
        // Real client while portal_login_email is off, or a revoked seat: fall through to the token page.
      }
    }
  }
  return tokenLink ? { url: tokenLink, kind: "token" } : null;
}

// ---- the derivation: one month → one candidate ---------------------------------

/** `ignoreReminderId`: the row THIS dispatch already wrote. The recheck asks
 *  "is the CLIENT's state still the one that earned a reminder?", so our own
 *  in-flight attempt must not count as an attempt already made — otherwise a
 *  policy of maxAttemptsPerAction 1 would re-read its own PENDING row, decide
 *  the quota was spent, and suppress the very send it just authorised. */
async function evaluateMonth(e: EnrollmentRow, month: { id: string; monthKey: string; status: string; remindersSnoozedUntil: Date | null }, now: Date, p: ReminderPolicy, sync: SchedulerSync, clientWindowOpen: boolean, ignoreReminderId?: string | null): Promise<ReminderCandidate> {
  const isTest = isTestClientName(e.client.name);
  const base = {
    enrollmentId: e.id, clientId: e.clientId, clientName: e.client.name, isTest, monthId: month.id, monthKey: month.monthKey,
    templateKey: null as string | null, attempt: 0, dedupeKey: null as string | null, to: null as string | null, nextEligibleAt: null as Date | null, deadlineAt: null as Date | null,
    noCallEligible: false, digestSession: false, answersStarted: false, retryOfId: null as string | null, escalation: null as ReminderCandidate["escalation"],
  };
  // Authoritative month state, derived fresh (never persisted from here).
  const recalc = await recalcProgramMonth(month.id, { now, dryRun: true });
  const d: DerivedMonthState | null = recalc?.after ?? null;
  const facts = await monthFacts(month.id, now);
  const state: EvaluatedState = {
    strategyCallStatus: d?.strategyCallStatus ?? "?", planningMode: d?.planningMode ?? "?", preparationStatus: d?.preparationStatus ?? null, callMode: d?.callMode ?? "?",
    earliestSessionAt: d?.earliestSessionAt?.toISOString() ?? null,
    sessionBooked: facts.sessionBooked, sessionFilmed: facts.sessionFilmed, pendingSessionRequest: facts.pendingSessionRequest,
    releasedCutsAwaiting: facts.releasedCutsAwaiting, oldestReleaseAt: facts.oldestReleaseAt?.toISOString() ?? null,
    snoozedUntil: month.remindersSnoozedUntil?.toISOString() ?? null, enrollmentStatus: e.status, schedulerSync: sync,
  };
  const out = (c: Partial<ReminderCandidate> & { action: ReminderAction | null; decision: ReminderDecision; reason: string }): ReminderCandidate =>
    ({ ...base, suppressionReason: null, state, ...c });

  if (!d) return out({ action: null, decision: "none", reason: "month or enrollment not found" });
  if (month.status !== "OPEN") return out({ action: null, decision: "none", reason: `month is ${month.status}` });

  // ---- the ONE action -------------------------------------------------------
  const callHeld = d.strategyCallStatus === "COMPLETED";
  const callBooked = d.strategyCallStatus === "SCHEDULED";
  const prepComplete = d.preparationStatus === "PREPARING_SCRIPTS" || d.preparationStatus === "AWAITING_SCRIPT_APPROVAL" || d.preparationStatus === "READY_FOR_FILMING";
  const noCallEligible = d.callMode === "OPTIONAL_WRITTEN" ? (e.noCallEligible ?? true) : d.callMode === "NOT_INCLUDED";

  let action: ReminderAction | null = null;
  let planningSuppression: string | null = null;
  let answersStarted = false;
  // A month whose content session has ALREADY BEEN SHOT has nothing left to
  // plan — filming is terminal for the planning question, exactly the way a
  // held call is. Without this, a client whose September shoot happened on the
  // 11th and is sitting in EDITING would still be told "we still need to plan
  // your September content — grab a time for your strategy call": the
  // evaluator contradicting the facts it printed in the same object. (Found in
  // review Sep 17 against live data: Sarina Spinelli 2026-09, filmed 09-11,
  // held back only by the stale-sync lock and the pre-launch lock, neither of
  // which is a truth check.) Filmed months fall through to the session/review
  // branch below: REVIEW_WORK if cuts are waiting, otherwise nothing.
  if (!prepComplete && !callHeld && !facts.sessionFilmed) {
    if (callBooked) planningSuppression = "booked";
    else if (d.planningMode === "WRITTEN") { action = "COMPLETE_ANSWERS"; answersStarted = d.preparationStatus === "AWAITING_ANSWERS"; }
    else if (d.callMode === "REQUIRED") action = "BOOK_CALL";
    else action = "CHOOSE_PATH";
  }
  let sessionSuppression: string | null = null;
  if (!action && !planningSuppression) {
    if (facts.sessionBooked || facts.sessionFilmed) {
      if (facts.releasedCutsAwaiting > 0) action = "REVIEW_WORK";
    } else if (facts.pendingSessionRequest) sessionSuppression = "pending_session_request";
    else if (prepComplete || callHeld) action = "BOOK_SESSION";
  }
  const digestSession = !!action && ["CHOOSE_PATH", "BOOK_CALL", "COMPLETE_ANSWERS"].includes(action) && p.digestBothAppointments && !facts.sessionBooked && !facts.pendingSessionRequest && !facts.sessionFilmed;

  // ---- suppression (spec §24), in the order a person would ask ----------------
  const sup = (reason: string, why: string, withAction: ReminderAction | null = action) => out({ action: withAction, decision: "suppressed", suppressionReason: reason, reason: why, noCallEligible, digestSession, answersStarted });
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
  if (sessionSuppression) return sup(sessionSuppression, "a session request is waiting on the office, not the client", null);
  if (!action) {
    // "already been filmed — nothing left to book" was read off sessionFilmed
    // alone, which is only "a shoot on this month is in the past". A month can
    // hold BOTH (Sarina Spinelli's 2026-09: filmed on the 11th, another booked
    // for the 19th) and the sentence then said the opposite of the calendar
    // (review, Sep 17). Say what is true of each.
    const filmedReason = facts.sessionBooked
      ? "a session has already been filmed this month, and another is on the calendar — nothing to remind"
      : "a session has already been filmed this month — nothing left to plan or book";
    return out({ action: null, decision: "none", reason: facts.sessionFilmed ? filmedReason : prepComplete || callHeld ? (facts.sessionBooked ? "planned and booked — nothing needed" : "nothing needed") : "nothing needed", noCallEligible });
  }
  if ((action === "BOOK_CALL" || action === "CHOOSE_PATH") && !sync.fresh) return sup("stale_scheduler_sync", `booking state is not trustworthy: ${sync.detail}`);
  if (action === "REVIEW_WORK" && facts.oldestReleaseAt && businessDaysBetween(facts.oldestReleaseAt, now) < p.reviewWorkAfterBusinessDays) {
    return out({ action, decision: "wait", reason: `cuts shared ${businessDaysBetween(facts.oldestReleaseAt, now)} business day(s) ago — reminder after ${p.reviewWorkAfterBusinessDays}`, nextEligibleAt: addBusinessDaysET(facts.oldestReleaseAt, p.reviewWorkAfterBusinessDays), noCallEligible });
  }
  if (p.testClientsOnly && !isTest) return sup("launch_not_authorised", "policy.testClientsOnly is on — only TEST clients may receive until launch is authorised");

  // ---- cadence ----------------------------------------------------------------
  const start = monthStart(month.monthKey);
  const prev = prevMonthKey(month.monthKey);
  let opensAt: Date;
  let deadlineAt: Date;
  if (action === "BOOK_SESSION") {
    const prepAt = d.planningMode === "CALL" ? d.strategyCallAt : d.preparationCompletedAt;
    opensAt = prepAt && prepAt < now ? prepAt : now;
    deadlineAt = etAt(`${month.monthKey}-${String(Math.min(p.sessionBookingDeadlineDayOfMonth, 28)).padStart(2, "0")}`, 17);
  } else if (action === "REVIEW_WORK") {
    opensAt = facts.oldestReleaseAt ? addBusinessDaysET(facts.oldestReleaseAt, p.reviewWorkAfterBusinessDays) : now;
    deadlineAt = addBusinessDaysET(opensAt, 5);
  } else {
    opensAt = new Date(start.getTime() - p.planningOpensDaysBeforeMonth * 864e5);
    deadlineAt = etAt(`${prev}-${String(p.planningDeadlineDayOfPrevMonth).padStart(2, "0")}`, 17);
  }
  const templateKey = templateForAction(action as keyof typeof DEFAULT_TEMPLATE_IDS, p.templates).id;
  if (now < opensAt) return out({ action, templateKey, decision: "wait", reason: `planning opens ${fmtDay(opensAt)}`, nextEligibleAt: opensAt, deadlineAt, noCallEligible, digestSession });

  const prior = (await prisma.programReminder.findMany({ where: { enrollmentId: e.id, monthKey: month.monthKey, action }, orderBy: { attempt: "desc" } }))
    .filter((r) => r.id !== ignoreReminderId);
  const counted = prior.filter((r) => r.state === "SENT" || r.state === "UNKNOWN" || r.state === "QUEUED" || r.state === "BOUNCED" || (r.state === "PENDING" && r.leaseUntil && r.leaseUntil > now));
  const lastSentAt = prior.reduce<Date | null>((m, r) => (r.sentAt && (!m || r.sentAt > m) ? r.sentAt : m), null);
  const failedRetry = prior.find((r) => r.state === "FAILED" && (!r.nextAttemptAt || r.nextAttemptAt <= now)) ?? null;
  const attemptsMade = counted.length;
  // One escalation per (month, action): the ESCALATION ledger row carries the
  // client action it escalated in its templateKey.
  const escalated = (await prisma.programReminder.count({ where: { monthId: month.id, action: "ESCALATION", templateKey: `escalation:${action}` } })) > 0;
  const deadlineNear = businessDaysBetween(now, deadlineAt) <= p.escalateWhenDeadlineWithinBusinessDays;
  // A ledger that only ever grows and never sends is the churn version of the
  // same silence: stop and hand it to a person rather than write row 40.
  const rowCeiling = p.maxAttemptsPerAction + 5;
  const rowCeilingHit = !failedRetry && prior.length >= rowCeiling;
  const escalation = !escalated && (deadlineNear || attemptsMade >= p.maxAttemptsPerAction || rowCeilingHit)
    ? { due: true, reason: rowCeilingHit ? `${prior.length} reminder rows exist for this month and action but only ${attemptsMade} actually sent — the evaluator has stopped` : deadlineNear ? `deadline ${fmtDay(deadlineAt)} is within ${p.escalateWhenDeadlineWithinBusinessDays} business days` : `${attemptsMade} reminder(s) sent, no response` }
    : null;

  const to = await recipientFor(e);
  const common = { action, templateKey, deadlineAt, noCallEligible, digestSession, answersStarted, escalation, to: to ? maskToRef("email", to.email) : null };
  if (rowCeilingHit) {
    return out({ ...common, attempt: attemptsMade, decision: escalation ? "escalate" : "none", reason: `${prior.length} reminder rows already written for this month and action (only ${attemptsMade} sent) — stopping so a person looks` });
  }
  if (attemptsMade >= p.maxAttemptsPerAction && !failedRetry) {
    return out({ ...common, attempt: attemptsMade, decision: escalation ? "escalate" : "none", reason: `${attemptsMade} of ${p.maxAttemptsPerAction} reminders already sent${escalation ? " — escalating to the office" : ""}` });
  }
  const attempt = failedRetry ? failedRetry.attempt : attemptsMade + 1;
  // THE ROW IDENTITY IS THE ROW'S POSITION IN THE LEDGER, NOT THE ATTEMPT
  // NUMBER. dedupeKey is @unique, and a SUPPRESSED or CANCELLED row does not
  // count towards `attemptsMade` — so keying on the attempt meant a reminder
  // that was cancelled before it left (a pause, a snooze, a lease race) burned
  // `…:BOOK_CALL:1` for ever: every later run recomputed attempt 1, collided on
  // P2002, recorded `duplicate`, and that client was never reminded again with
  // nothing anywhere reading as broken. Sequencing on prior.length keeps the
  // concurrency guarantee (two runs reading the same ledger compute the same
  // key, one wins on P2002) while letting a consumed-but-unsent row step aside.
  // Cadence — how many reminders this person has actually had, and when the
  // next is due — still comes from `counted` alone.
  const dedupeKey = failedRetry ? (failedRetry.dedupeKey ?? `${e.id}:${month.monthKey}:${action}:retry:${failedRetry.id}`) : `${e.id}:${month.monthKey}:${action}:${prior.length + 1}`;
  const nextEligibleAt = failedRetry ? (failedRetry.nextAttemptAt ?? now) : attempt === 1 ? addBusinessDaysET(opensAt, p.firstReminderDelayBusinessDays) : lastSentAt ? addBusinessDaysET(lastSentAt, p.followUpAfterBusinessDays) : now;
  if (now < nextEligibleAt) return out({ ...common, attempt, dedupeKey, decision: "wait", reason: attempt === 1 ? `first reminder due ${fmtDay(nextEligibleAt)}` : `follow-up due ${fmtDay(nextEligibleAt)} (${p.followUpAfterBusinessDays} business days after the last one)`, nextEligibleAt, retryOfId: failedRetry?.id ?? null });
  if (!to) return sup("no_recipient", "no email address on the portal seat or the client record");
  if (isTest && !isStaffControlledEmail(to.email)) return sup("test_client_real_address", `TEST client's address ${maskToRef("email", to.email)} is not staff-controlled`);
  if (!inPolicyWindow(now, p) || !clientWindowOpen) {
    const next = nextPolicyWindowOpen(now, p);
    return out({ ...common, attempt, dedupeKey, decision: "wait", suppressionReason: "quiet_hours", reason: `outside the send window — next opening ${fmtDay(next)} ${next.toLocaleTimeString("en-US", { timeZone: p.timezone, hour: "numeric", minute: "2-digit" })}`, nextEligibleAt: next, retryOfId: failedRetry?.id ?? null });
  }
  return out({ ...common, attempt, dedupeKey, decision: "send", reason: failedRetry ? `retrying attempt ${attempt} (last error: ${failedRetry.lastError ?? "unknown"})` : attempt === 1 ? "first reminder" : `follow-up ${attempt}`, nextEligibleAt, retryOfId: failedRetry?.id ?? null });
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
  const dedupeKey = `${c.enrollmentId}:${c.monthKey}:ESCALATION:${c.action}`;
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
        clientId: c.clientId, assignedKey: owner.assignedKey, dedupeKey: `program-reminder-escalation:${c.monthId}:${c.action}`,
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

async function dispatch(c: ReminderCandidate, e: EnrollmentRow, p: ReminderPolicy, now: Date, opts: { requestedBy: string; manual: boolean; byAppUserId: string | null; sync: SchedulerSync; clientWindowOpen: boolean }): Promise<DispatchOutcome> {
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
  const fresh = month && enrollment ? await evaluateMonth({ ...e, status: enrollment.status }, month, now, p, opts.sync, opts.clientWindowOpen, reminderId) : null;
  const stillSend = fresh && fresh.decision === "send" && fresh.action === c.action;
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
  const link = await resolvePortalLink(e, to, opts.byAppUserId, now);
  if (!link) {
    await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "SUPPRESSED", suppressionReason: "no_portal_link", toRef: to.email, leaseUntil: null, leaseBy: null } });
    return { reminderId, outcome: "suppressed", detail: "no portal link could be produced (no seat, no token)" };
  }
  // 4. RENDER.
  const vars = await templateVarsFor(c, e, link.url, fresh);
  const body = renderReminder(reminderTemplate(c.templateKey), vars);
  await prisma.programReminder.update({ where: { id: reminderId }, data: { state: "QUEUED", toRef: to.email, evaluatedStateJson: JSON.stringify({ ...fresh.state, portalLinkKind: link.kind }) } });
  // 5. THE ONE SEND. sendThroughOutbox queues, leases and delivers in one call,
  //    so a pending row never sits where the recovery drain could pick it up
  //    outside the window (it is a client kind there too, for that reason).
  const r = await sendThroughOutbox(
    { channel: "email", toRef: to.email, body, dedupeKey: programReminderKey(c.action, reminderId, c.monthKey), clientId: c.clientId, requestedBy: opts.requestedBy },
    { workerId: leaseBy },
  );
  return recordSendResult(reminderId, r, now);
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
    sessionNote: c.digestSession ? `Once ${month} is planned we'll also need to book your filming session — you can pick a time in the same portal and we'll confirm it.` : null,
    earliestSession: fmtDay(fresh?.state.earliestSessionAt ? new Date(fresh.state.earliestSessionAt) : null),
    itemCount: fresh?.state.releasedCutsAwaiting ?? c.state.releasedCutsAwaiting,
    titles: [],
    updatedTitles: [],
    deadline: c.deadlineAt && c.deadlineAt > new Date() ? c.deadlineAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric" }) : null,
  };
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
    return { enabled: false, policySource: source, evaluated: 0, candidates: [], sent: [], escalations: [], healthError: null, note: "reminders are off (missing or disabled ProgramAutomation row) — nothing evaluated, nothing written" };
  }
  const [sync, clientWindowOpen] = await Promise.all([schedulerSyncState(now, policy), clientTextWindowOpen(now)]);
  const enrollments = (await prisma.contentEnrollment.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] }, ...(opts.enrollmentIds?.length ? { id: { in: opts.enrollmentIds } } : {}) },
    select: { id: true, clientId: true, status: true, callMode: true, strategyCallRequired: true, noCallEligible: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true },
  }));
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
  let sends = 0;
  for (const m of months) {
    const en = enrollments.find((e) => e.id === m.enrollmentId);
    const client = en ? clients.get(en.clientId) : null;
    if (!en || !client) continue;
    const e: EnrollmentRow = { ...en, client: { name: client.name, email: client.email } };
    const c = await evaluateMonth(e, m, now, policy, sync, clientWindowOpen);
    candidates.push(c);
    if (c.escalation?.due && (c.decision === "send" || c.decision === "escalate" || c.decision === "wait")) {
      const r = await escalate(c, policy, now, c.escalation.reason, opts.dryRun);
      escalations.push({ candidate: c, ...r });
    }
    if (opts.dryRun || c.decision !== "send") continue;
    if (sends >= policy.maxSendsPerRun) { sent.push({ reminderId: null, outcome: "skipped", detail: `maxSendsPerRun (${policy.maxSendsPerRun}) reached — ${c.clientName} ${c.monthKey} waits for the next run` }); continue; }
    const r = await dispatch(c, e, policy, now, { requestedBy: opts.requestedBy ?? "reminders-cron", manual: false, byAppUserId: opts.byAppUserId ?? null, sync, clientWindowOpen });
    sent.push(r);
    if (r.outcome === "sent") sends++;
  }
  const wouldSend = candidates.filter((c) => c.decision === "send").length;
  // A BROKEN SCHEDULER MUST NOT BE A QUIET ONE. `stale_scheduler_sync` is a
  // safety suppression, not a decision about the client: while it holds, every
  // booking reminder in the business stops, and (because sup() carries no
  // escalation) nobody was told. That is the Sep 8 shape exactly — an
  // integration goes dark, then days of unnoticed silence. One line on the
  // automation row and one task per ET day, so the silence has an owner.
  const stale = candidates.filter((c) => c.suppressionReason === "stale_scheduler_sync");
  const healthError = stale.length
    ? `${stale.length} month(s) got no booking reminder because the Calendly booking state is not trustworthy: ${sync.detail}. Nothing was sent for them — this is a suppression, not a decision about the client.`
    : null;
  if (!opts.dryRun && healthError) await raiseSchedulerStaleTask(stale, sync, now, healthError);
  return {
    enabled, policySource: source, evaluated: candidates.length, candidates, sent, escalations, healthError,
    note: opts.dryRun ? `dry run: ${wouldSend} would send, ${candidates.filter((c) => c.decision === "suppressed").length} suppressed, ${candidates.filter((c) => c.decision === "wait").length} waiting` : `${sends} sent`,
  };
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
        description: `${why}\n\nAffected months: ${real.slice(0, 20).map((c) => `${c.clientName} ${c.monthKey}`).join(", ")}${real.length > 20 ? ` and ${real.length - 20} more` : ""}.\n\nThe evaluator refuses to tell a client "you still haven't booked" while the booking feed is stale — it would be guessing. Fix the Calendly mapping on Settings → Calendly & calls; the next hourly run clears this on its own.`,
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
        const stop = switchOff || en?.status !== "ACTIVE" || (month?.remindersSnoozedUntil && month.remindersSnoozedUntil > now) || ((r.action === "BOOK_CALL" || r.action === "CHOOSE_PATH") && booked);
        if (stop) {
          const why = switchOff ? "the automation was switched off" : en?.status !== "ACTIVE" ? (en?.status === "PAUSED" ? "paused" : "ended") : booked ? "booked" : "snoozed";
          const released = await markFailed(r.outboxMessageId, `cancelled before send: ${why}`);
          if (released) {
            await prisma.programReminder.update({ where: { id: r.id }, data: { state: "CANCELLED", suppressionReason: switchOff ? "switched_off" : why, lastError: `cancelled before send: ${why}`, lastErrorAt: now } });
            await prisma.contentScriptRelease.updateMany({ where: { reminderId: r.id }, data: { notificationState: "SUPPRESSED", note: `Email cancelled before it went out: ${why}. The approval and the portal release stand.` } });
            cancelled++;
          }
        }
      }
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

async function loadForManual(monthId: string, now: Date, policyOpt: { orDefaults: boolean }) {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, monthKey: true, status: true, remindersSnoozedUntil: true } });
  if (!month) throw new Error("Month not found.");
  const en = await prisma.contentEnrollment.findUnique({ where: { id: month.enrollmentId }, select: { id: true, clientId: true, status: true, callMode: true, strategyCallRequired: true, noCallEligible: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true } });
  if (!en) throw new Error("Enrollment not found.");
  const client = await prisma.client.findUnique({ where: { id: en.clientId }, select: { name: true, email: true } });
  const e: EnrollmentRow = { ...en, client: { name: client?.name ?? "", email: client?.email ?? null } };
  const { enabled, policy } = await reminderPolicy(policyOpt);
  const sync = await schedulerSyncState(now, policy ?? REMINDER_DEFAULTS);
  const clientWindowOpen = await clientTextWindowOpen(now);
  return { month, e, enabled, policy: policy ?? REMINDER_DEFAULTS, sync, clientWindowOpen };
}

/**
 * COPY LINK: the rendered text + the portal link for a person to paste into
 * their own message. Sends nothing, so it works with the switch off — but the
 * suppression rules still apply (a booked month has no link to copy), and the
 * copy is recorded as an attempt (channel "copy") so the cadence counts it.
 */
export async function copyReminderLink(monthId: string, by: { email: string; appUserId?: string | null }, opts: { now?: Date } = {}): Promise<ManualResult> {
  const now = opts.now ?? new Date();
  const { month, e, policy, sync } = await loadForManual(monthId, now, { orDefaults: true });
  // Cadence, quiet hours and the launch lock do not bind a human copying text;
  // the derivation and the state-based suppressions do.
  const c = await evaluateMonth(e, month, now, { ...policy, testClientsOnly: false, firstReminderDelayBusinessDays: 0, followUpAfterBusinessDays: 0, maxAttemptsPerAction: 99 }, sync, true);
  if (c.decision === "suppressed" && c.suppressionReason !== "test_client_real_address") return { ok: false, message: `Nothing to copy — ${c.reason}.`, candidate: c };
  if (!c.action || !c.templateKey) return { ok: false, message: `Nothing to copy — ${c.reason}.`, candidate: c };
  const to = await recipientFor(e);
  const link = await resolvePortalLink(e, to, by.appUserId ?? null, now);
  if (!link) return { ok: false, message: "No portal link exists for this client yet (no seat, no token).", candidate: c };
  const body = renderReminder(reminderTemplate(c.templateKey), await templateVarsFor(c, e, link.url, c));
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
export async function sendReminderNow(monthId: string, by: { email: string; appUserId?: string | null }, opts: { now?: Date } = {}): Promise<ManualResult> {
  const now = opts.now ?? new Date();
  if (!(await isAutomationEnabled(REMINDERS_KEY))) return { ok: false, message: "Reminders are switched off (Settings → Automations). Copy the link instead." };
  const { month, e, enabled, policy, sync, clientWindowOpen } = await loadForManual(monthId, now, { orDefaults: false });
  // The switch is on but reminderPolicy still says no: the SAVED policy failed
  // validation, so the hourly pass is doing nothing. Send now must not quietly
  // run on code defaults while the settings panel shows the errors — the two
  // surfaces would disagree about whether reminders are running at all.
  if (!enabled) return { ok: false, message: "The saved reminder policy is not valid, so nothing is running on it (Settings → Reminders lists the errors). Fix the policy, or copy the link and send it yourself." };
  const c = await evaluateMonth(e, month, now, { ...policy, firstReminderDelayBusinessDays: 0, followUpAfterBusinessDays: 0 }, sync, clientWindowOpen);
  if (c.decision === "suppressed") return { ok: false, message: `Not sent — ${c.reason}.`, candidate: c };
  if (c.decision === "wait") return { ok: false, message: `Not sent — ${c.reason}.`, candidate: c };
  if (c.decision !== "send") return { ok: false, message: `Not sent — ${c.reason}.`, candidate: c };
  const r = await dispatch(c, e, policy, now, { requestedBy: `send-now:${by.email}`, manual: true, byAppUserId: by.appUserId ?? null, sync, clientWindowOpen });
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
