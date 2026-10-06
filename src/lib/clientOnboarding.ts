import "server-only";
import { prisma } from "@/lib/prisma";
import { lockAdvisory } from "@/lib/dbLocks";
import { appBase } from "@/lib/appUrl";
import { isAutomationEnabled, type AutomationKey } from "@/lib/programAutomation";
import { isStaffControlledEmail, isSyntheticClientRow, isVerifiedTestDestinationEmail, isVerifiedTestDestinationPhone } from "@/lib/testClients";
import { featureTestOnlyFor, loadProgramRollout, programReach, updateProgramRollout } from "@/lib/programRollout";
import {
  CLOSED_ROLLOUT, PROGRAM_REACH_OPS, clientAllowedOps, pilotGroupOf, pilotOpsFor, pilotStateOf, pilotLastDay, rolloutDecision, setClientOpsChange,
  type ProgramReachOp, type ProgramRollout, type RolloutMode,
} from "@/lib/programRolloutCore";
import type { PilotState } from "@/lib/hubWritePermit";
import type { TemplateVars } from "@/lib/reminderTemplates";
import {
  ONBOARDING_BODY_MAX, ONBOARDING_LOG_MAX, ONBOARDING_MESSAGES, ONBOARDING_RECORD_PREFIX, ONBOARDING_TOGGLES, SWITCH_WOULD,
  isIntentId, isOnboardingMessageKey, isOnboardingToggleKey, lastSentOf, messageOf, missingToggles, onboardingChip, onboardingKey,
  onboardingSteps, opsWithToggle, parseOnboardingKey, parseOnboardingRecord, toggleNames, toggleOf, toggleOn,
  type OnboardingChannel, type OnboardingChip, type OnboardingLogEntry, type OnboardingMessageKey, type OnboardingRecord,
  type OnboardingStep, type OnboardingToggleKey,
} from "@/lib/clientOnboardingCore";

// ---------------------------------------------------------------------------
// CLIENT ONBOARDING, against the database (Oct 5 2026). The words and rules
// are in clientOnboardingCore.ts; Settings → Client onboarding is the page.
//
// WHAT THIS FILE NEVER DOES. Nothing here sends on a read, on a toggle or on
// any sweep. The page's loader composes every message for Jordan to read and
// writes NOTHING (no portal token is minted, no sign-in link, no row). The
// toggles write only the client's own list in the program rollout (through
// the one writer, updateProgramRollout). The one path to a provider is
// sendOnboardingMessage, which the owner-only action calls when Jordan presses
// "Send now" — and the outbox's dispatch gate re-checks that message's toggle
// and the TEST floor at the moment it leaves (programRolloutGate.onboardingGate).
//
// THE RECORD. One AppSetting row per client, `client-onboarding:<clientId>`:
// when the client was marked onboarded, by whom, and a log of every send,
// "marked sent", toggle, account and done mark (newest ONBOARDING_LOG_MAX).
// Every write takes the row's advisory lock and also writes an AuditLog row
// (target = the client id), so the history survives the log's trim.
// ---------------------------------------------------------------------------

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
const recordKey = (clientId: string) => `${ONBOARDING_RECORD_PREFIX}${clientId}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e: string | null | undefined): string | null => {
  const v = (e ?? "").trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : null;
};
/** A 10-digit phone key (the outbox's sms toRef), or null. */
const phoneDigits = (p: string | null | undefined): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};
const prettyPhone = (d: string) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;

// ---- the record ---------------------------------------------------------------

export async function readOnboardingRecord(clientId: string): Promise<OnboardingRecord> {
  const row = await prisma.appSetting.findUnique({ where: { key: recordKey(clientId) }, select: { value: true } });
  return parseOnboardingRecord(row?.value ?? null);
}

/**
 * Change one client's record under its advisory lock, and write the AuditLog
 * row in the same transaction (unless the change was already audited by the
 * rollout writer — a toggle).
 */
async function writeRecord(
  clientId: string,
  change: (r: OnboardingRecord, now: Date) => OnboardingRecord,
  audit: { actor: string; action: string; detail: string } | null,
): Promise<OnboardingRecord> {
  return prisma.$transaction(async (tx) => {
    await lockAdvisory(tx, recordKey(clientId));
    const now = new Date();
    const row = await tx.appSetting.findUnique({ where: { key: recordKey(clientId) }, select: { value: true } });
    const cur = parseOnboardingRecord(row?.value ?? null);
    const next = change(cur, now);
    // The change said "nothing to record" (an entry already logged): no write, no audit row.
    if (next === cur) return next;
    const value = JSON.stringify({ ...next, log: next.log.slice(-ONBOARDING_LOG_MAX) });
    await tx.appSetting.upsert({ where: { key: recordKey(clientId) }, create: { key: recordKey(clientId), value, updatedBy: audit?.actor ?? null }, update: { value, updatedBy: audit?.actor ?? null } });
    if (audit) await tx.auditLog.create({ data: { actor: audit.actor, action: audit.action, target: clientId, detail: audit.detail.slice(0, 4000) } });
    return next;
  });
}

const appendLog = (entry: Omit<OnboardingLogEntry, "at">) => (r: OnboardingRecord, now: Date): OnboardingRecord => ({ ...r, log: [...r.log, { at: now.toISOString(), ...entry }] });

// ---- who a message may go to ------------------------------------------------

export type OnboardingRecipient = { channel: OnboardingChannel; toRef: string; label: string };

/**
 * The addresses on file for this client — the only ones a message may go to:
 * the client's own email, their backup email, every live portal seat's email,
 * and the client's phone. Read fresh; the dispatch gate re-reads it at send.
 */
export async function onboardingRecipientsFor(clientId: string): Promise<OnboardingRecipient[]> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { email: true, backupEmail: true, phone: true } });
  if (!client) return [];
  const out: OnboardingRecipient[] = [];
  const add = (r: OnboardingRecipient) => { if (!out.some((x) => x.channel === r.channel && x.toRef === r.toRef)) out.push(r); };
  const own = normEmail(client.email);
  if (own) add({ channel: "email", toRef: own, label: "client email" });
  const backup = normEmail(client.backupEmail);
  if (backup) add({ channel: "email", toRef: backup, label: "backup email" });
  const seats = await prisma.clientMembership.findMany({ where: { clientId, revokedAt: null }, orderBy: { invitedAt: "asc" }, select: { clientUserId: true, role: true } });
  if (seats.length) {
    const people = await prisma.clientUser.findMany({ where: { id: { in: seats.map((s) => s.clientUserId) } }, select: { id: true, email: true, status: true } });
    for (const s of seats) {
      const u = people.find((p) => p.id === s.clientUserId);
      const e = u && u.status !== "DISABLED" ? normEmail(u.email) : null;
      if (e) add({ channel: "email", toRef: e, label: `portal ${s.role.toLowerCase()} seat` });
    }
  }
  const phone = phoneDigits(client.phone);
  if (phone) add({ channel: "sms", toRef: phone, label: `text ${prettyPhone(phone)}` });
  return out;
}

// ---- the client list ------------------------------------------------------------

export type OnboardingListRow = {
  clientId: string;
  enrollmentId: string;
  name: string;
  isTest: boolean;
  trial: boolean;
  paused: boolean;
  chip: OnboardingChip;
};

/** Every client with an ACTIVE or PAUSED program: real clients by name, then the TEST clients. */
export async function listOnboardingClients(): Promise<OnboardingListRow[]> {
  const enrollments = await prisma.contentEnrollment.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true, clientId: true, status: true, billingType: true } });
  if (!enrollments.length) return [];
  const ids = enrollments.map((e) => e.clientId);
  const [clients, records, seats, loaded] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.appSetting.findMany({ where: { key: { in: ids.map(recordKey) } }, select: { key: true, value: true } }),
    prisma.clientMembership.groupBy({ by: ["clientId"], where: { clientId: { in: ids }, revokedAt: null }, _count: { _all: true } }),
    loadProgramRollout().catch(() => ({ rollout: { ...CLOSED_ROLLOUT } as ProgramRollout })),
  ]);
  const rows: OnboardingListRow[] = enrollments.map((e) => {
    const c = clients.find((x) => x.id === e.clientId);
    const name = c?.name ?? e.clientId;
    const isTest = isSyntheticClientRow({ id: e.clientId, name: c?.name ?? null });
    const record = parseOnboardingRecord(records.find((r) => r.key === recordKey(e.clientId))?.value ?? null);
    const allowedCount = isTest ? 0 : clientAllowedOps(loaded.rollout, { id: e.clientId, name: c?.name ?? null }).length;
    const seatCount = seats.find((s) => s.clientId === e.clientId)?._count._all ?? 0;
    return {
      clientId: e.clientId, enrollmentId: e.id, name, isTest, trial: e.billingType === "TRIAL", paused: e.status === "PAUSED",
      chip: onboardingChip({ record, allowedCount, seats: seatCount }),
    };
  });
  return rows.sort((a, b) => Number(a.isTest) - Number(b.isTest) || a.name.localeCompare(b.name));
}

// ---- one client, every step -------------------------------------------------------

export type SwitchState = { key: AutomationKey; title: string; on: boolean };

export type OnboardingToggleView = {
  key: OnboardingToggleKey;
  on: boolean;
  /** Every op of it reaches this client right now (the rollout's own decision). */
  reaching: boolean;
  switches: SwitchState[];
  /** The feature's own testClientsOnly lock is on (it then still reaches TEST clients only). */
  lockedToTest: boolean;
};

export type OnboardingMessageView = {
  key: OnboardingMessageKey;
  /** May the owner send it now (the toggle is on, or a TEST client)? */
  allowed: boolean;
  blockedWhy: string | null;
  recipients: OnboardingRecipient[];
  body: { email: string; sms: string };
  /** One line under the preview, when something about it needs saying. */
  note: string | null;
  last: OnboardingLogEntry | null;
};

export type OnboardingDetail = {
  client: { id: string; name: string; company: string | null; isTest: boolean };
  enrollment: {
    id: string; package: string; videosPerMonth: number; sessionsPerMonth: number; sessionMinutes: number;
    status: string; trial: boolean; monthKey: string; monthLabel: string; monthStatus: string | null; callStatus: string | null;
  };
  strategy: {
    inReview: { id: string; versionNo: number } | null;
    /** A newer version still being written (DRAFT), when nothing waits for approval. */
    draftNo: number | null;
    approved: { id: string; versionNo: number; approvedAt: string | null; approvedBy: string | null; releasedAt: string | null } | null;
    /** Releasing would ALSO queue the "strategy ready" email right now (its switch and this client's toggle are both on). */
    releaseEmails: boolean;
  };
  rollout: { mode: RolloutMode; pilotState: PilotState; endsOn: string | null; problem: string | null };
  allowed: ProgramReachOp[];
  /** Something is allowed for this client but the rollout does not reach them yet, and why (else null). */
  reachNote: string | null;
  toggles: OnboardingToggleView[];
  seats: { membershipId: string; email: string; name: string | null; role: string; revoked: boolean; lastLoginAt: string | null }[];
  heldWelcome: { email: string; since: string } | null;
  portal: { hasLink: boolean; signInByEmail: boolean; signInWhyNot: string | null };
  messages: OnboardingMessageView[];
  booking: { auto: boolean; autoAvailable: boolean; whyNot: string[] };
  record: OnboardingRecord;
  steps: OnboardingStep[];
};

const MONTH_LABEL = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return y && m ? new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : key;
};

/**
 * Everything the page shows for ONE client. READ-ONLY: it composes the
 * messages, it never mints a portal link or a sign-in token, and it writes
 * nothing. null when the client has no program.
 */
export async function loadOnboardingDetail(clientId: string): Promise<OnboardingDetail | null> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, company: true, email: true } });
  if (!client) return null;
  const enrollment = await prisma.contentEnrollment.findUnique({
    where: { clientId },
    select: { id: true, package: true, videosPerMonth: true, sessionsPerMonth: true, sessionHours: true, status: true, billingType: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true },
  });
  if (!enrollment) return null;
  const isTest = isSyntheticClientRow({ id: client.id, name: client.name });
  const now = new Date();
  const { etMonthKey } = await import("@/lib/contentProgram");
  const monthKey = etMonthKey(now);
  const { AUTOMATION_EFFECTS } = await import("@/lib/programAutomationCopy");
  const switchKeys = [...new Set(ONBOARDING_TOGGLES.flatMap((t) => t.switches))];

  const [month, inReview, draft, approved, loaded, switchRows, seats, record, recipients] = await Promise.all([
    prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, monthKey }, select: { id: true, status: true, strategyCallStatus: true } }),
    prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: enrollment.id, status: "INTERNAL_REVIEW" }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true } }),
    prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: enrollment.id, status: "DRAFT" }, orderBy: { versionNo: "desc" }, select: { versionNo: true } }),
    prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: enrollment.id, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true, approvedAt: true, approvedBy: true, releasedAt: true } }),
    loadProgramRollout().then((l) => ({ rollout: l.rollout, problem: l.problem })).catch((e) => ({ rollout: { ...CLOSED_ROLLOUT } as ProgramRollout, problem: `the rollout could not be read (${errText(e)})` })),
    prisma.programAutomation.findMany({ where: { key: { in: switchKeys } }, select: { key: true, enabled: true, lastRunAt: true, lastError: true, lastErrorAt: true } }),
    prisma.clientMembership.findMany({ where: { enrollmentId: enrollment.id }, orderBy: { invitedAt: "asc" }, select: { id: true, clientUserId: true, role: true, revokedAt: true } }),
    readOnboardingRecord(clientId),
    onboardingRecipientsFor(clientId),
  ]);
  const { rollout, problem } = loaded;
  const switchOn = (k: AutomationKey) => !!switchRows.find((r) => r.key === k)?.enabled;
  const lockOps: ProgramReachOp[] = ["reminders", "script_share_email", "script_auto_share", "review_auto_approve"];
  const locks = new Map<ProgramReachOp, boolean>(await Promise.all(lockOps.map(async (op) => [op, await featureTestOnlyFor(op)] as const)));
  const who = { id: client.id, name: client.name };
  const allowed = clientAllowedOps(rollout, who);
  const reach = (op: ProgramReachOp) => !problem && rolloutDecision({ rollout, client: who, op, now }).ok;
  const firstAllowed = isTest || problem ? null : allowed[0] ?? null;
  const firstDecision = firstAllowed ? rolloutDecision({ rollout, client: who, op: firstAllowed, now }) : null;
  const reachNote = firstDecision && !firstDecision.ok ? firstDecision.reason : null;

  const toggles: OnboardingToggleView[] = ONBOARDING_TOGGLES.map((t) => ({
    key: t.key,
    on: isTest ? true : toggleOn(t, allowed),
    reaching: t.ops.every(reach),
    switches: t.switches.map((k) => ({ key: k, title: AUTOMATION_EFFECTS[k].title, on: switchOn(k) })),
    lockedToTest: !isTest && t.ops.some((op) => locks.get(op) === true),
  }));

  const people = seats.length ? await prisma.clientUser.findMany({ where: { id: { in: seats.map((s) => s.clientUserId) } }, select: { id: true, email: true, name: true, status: true, lastLoginAt: true } }) : [];
  const seatViews = seats.map((s) => {
    const u = people.find((p) => p.id === s.clientUserId);
    return { membershipId: s.id, email: u?.email ?? "", name: u?.name ?? null, role: s.role, revoked: !!s.revokedAt || u?.status === "DISABLED", lastLoginAt: u?.lastLoginAt?.toISOString() ?? null };
  });
  const { owedAccessFor } = await import("@/lib/portalAccess");
  const owed = (await owedAccessFor(enrollment.id).catch(() => [])).find((o) => o.reason === "welcome") ?? null;

  // The portal link the messages carry: the client's own link when it is
  // issued and working (it is never minted here), else the sign-in page.
  const tokenWorks = !!enrollment.portalToken && !enrollment.accessRevokedAt && !(enrollment.portalTokenExpiresAt && enrollment.portalTokenExpiresAt.getTime() <= now.getTime());
  const portalLink = tokenWorks ? `${appBase()}/portal/${enrollment.portalToken}` : `${appBase()}/portal/login`;
  const loginSwitch = switchOn("portal_login_email");
  const signInByEmail = loginSwitch && (isTest || reach("portal_login_email"));
  const signInWhyNot = signInByEmail ? null : !loginSwitch ? "\"Portal sign-in links\" is switched off, so a sign-in email is never sent" : "\"Portal account and sign-in\" is off for this client";

  // Release: would it email now? The same three gates the release itself reads.
  let releaseEmails = false;
  if (switchOn("script_share_email") && approved && !approved.releasedAt) {
    const { programReachWithLock } = await import("@/lib/programRollout");
    releaseEmails = (await programReachWithLock("script_share_email", client.id)).ok;
  }

  const messages = await composeMessages({ clientId, enrollmentId: enrollment.id, clientName: client.name, isTest, portalLink, monthKey, monthId: month?.id ?? null, approvedId: approved?.id ?? null, now, recipients, record, reach, signInByEmail, signInWhyNot });

  const whyNot = autoBookingProblems(switchRows, AUTOMATION_EFFECTS);
  if (isTest) whyNot.push("a TEST client is booked only as a TEST fixture (Settings → Who the hub may write for)");

  const liveOwnerSeat = seatViews.some((s) => !s.revoked && s.role === "OWNER");
  const steps = onboardingSteps({
    isTest, paused: enrollment.status !== "ACTIVE",
    emails: recipients.filter((r) => r.channel === "email").map((r) => r.toRef),
    strategy: { inReview: inReview?.versionNo ?? null, draftNo: inReview ? null : draft?.versionNo ?? null, approvedNo: approved?.versionNo ?? null, released: !!approved?.releasedAt },
    allowed, liveOwnerSeat, record, autoBooking: !isTest && toggleOn(toggleOf("bookings"), allowed),
  });

  return {
    client: { id: client.id, name: client.name, company: client.company, isTest },
    enrollment: {
      id: enrollment.id, package: enrollment.package, videosPerMonth: enrollment.videosPerMonth, sessionsPerMonth: enrollment.sessionsPerMonth,
      sessionMinutes: Math.round(enrollment.sessionHours * 60), status: enrollment.status, trial: enrollment.billingType === "TRIAL",
      monthKey, monthLabel: MONTH_LABEL(monthKey), monthStatus: month?.status ?? null, callStatus: month?.strategyCallStatus ?? null,
    },
    strategy: {
      inReview: inReview ? { id: inReview.id, versionNo: inReview.versionNo } : null,
      draftNo: inReview ? null : draft?.versionNo ?? null,
      approved: approved ? { id: approved.id, versionNo: approved.versionNo, approvedAt: approved.approvedAt?.toISOString() ?? null, approvedBy: approved.approvedBy, releasedAt: approved.releasedAt?.toISOString() ?? null } : null,
      releaseEmails,
    },
    rollout: { mode: rollout.mode, pilotState: pilotStateOf(rollout, now), endsOn: rollout.pilot?.expiresAt ? pilotLastDay(rollout.pilot.expiresAt) : null, problem },
    allowed,
    reachNote,
    toggles,
    seats: seatViews,
    heldWelcome: owed ? { email: owed.email, since: owed.since } : null,
    portal: { hasLink: tokenWorks, signInByEmail, signInWhyNot },
    messages,
    booking: { auto: !isTest && toggleOn(toggleOf("bookings"), allowed), autoAvailable: whyNot.length === 0, whyNot },
    record,
    steps,
  };
}

/**
 * AUTOMATIC ARYEO BOOKING MAY BE CHOSEN only once both write switches are on
 * AND each has worked at least once with no error since — proven on a TEST
 * booking first. Empty = available. Pure over the switch rows.
 */
function autoBookingProblems(
  rows: { key: string; enabled: boolean; lastRunAt: Date | null; lastError: string | null; lastErrorAt: Date | null }[],
  effects: Record<string, { title: string }>,
): string[] {
  const out: string[] = [];
  for (const k of ["session_booking", "address_sync"] as const) {
    const r = rows.find((x) => x.key === k);
    const title = effects[k]?.title ?? k;
    if (!r?.enabled) out.push(`"${title}" is switched off`);
    else if (!r.lastRunAt) out.push(`"${title}" has not completed a booking yet — prove it on a TEST booking first`);
    else if (r.lastError && (!r.lastErrorAt || r.lastErrorAt.getTime() >= r.lastRunAt.getTime())) out.push(`"${title}" failed last time: ${r.lastError.slice(0, 160)}`);
  }
  return out;
}

// ---- the messages, composed (never sent here) --------------------------------------

const SIGN = "Jordan and the RealTour Pilot team\n(Reply to this email and it comes straight to us.)";

async function composeMessages(a: {
  clientId: string; enrollmentId: string; clientName: string; isTest: boolean; portalLink: string; monthKey: string; monthId: string | null;
  approvedId: string | null; now: Date; recipients: OnboardingRecipient[]; record: OnboardingRecord; reach: (op: ProgramReachOp) => boolean;
  signInByEmail: boolean; signInWhyNot: string | null;
}): Promise<OnboardingMessageView[]> {
  const { reminderTemplate, renderReminder, monthName, firstNameOf } = await import("@/lib/reminderTemplates");
  const { GENERAL_STRATEGY_CALL_BOOKING_URL } = await import("@/lib/settings");
  const { STRATEGY_CALL_BOOKING_URL } = await import("@/lib/integrations/calendly");
  const first = firstNameOf(a.clientName);
  const month = monthName(a.monthKey);
  const base = {
    firstName: first, month, portalLink: a.portalLink, bookCallLink: null, noCallEligible: false, answersStarted: false, sessionNote: null,
    earliestSession: null, itemCount: 1, titles: [] as string[], updatedTitles: [] as string[], deadline: null,
  };
  const [welcome, strategyVars, scripts, monthlyMapping] = await Promise.all([
    import("@/lib/portalAccess").then((m) => m.composeWelcomeEmail({ name: a.clientName, clientName: a.clientName, reason: "welcome", clientId: a.clientId })).catch(() => null),
    a.approvedId ? import("@/lib/scriptShare").then((m) => m.strategyReadyVars(a.enrollmentId, a.clientId, a.now, a.approvedId)).catch(() => null) : Promise.resolve(null),
    a.monthId ? prisma.contentScript.findMany({ where: { monthId: a.monthId, sharedVersionId: { not: null } }, orderBy: { createdAt: "asc" }, select: { title: true } }) : Promise.resolve([] as { title: string }[]),
    prisma.programCalendlyEventMapping.findFirst({ where: { purpose: "MONTHLY_STRATEGY", enabled: true }, select: { publicUrl: true } }).catch(() => null),
  ]);
  const titles = scripts.map((s) => s.title).filter(Boolean);
  const render = (id: string, extra: Partial<TemplateVars> = {}) => renderReminder(reminderTemplate(id), { ...base, ...extra });

  const bodies: Record<OnboardingMessageKey, { email: string; sms: string; note: string | null }> = {
    welcome: {
      email: welcome ?? [`Hi ${first},`, "", `Your RealTour Pilot content portal is ready: ${a.portalLink}`, "", SIGN].join("\n"),
      sms: `Hi ${first}, it's Jordan at RealTour Pilot. Your content portal is ready: ${a.portalLink} Your strategy, scripts, filming dates and finished videos all live there.`,
      note: a.signInByEmail ? null : `The welcome tells them to sign in with their email, but ${a.signInWhyNot}. Until then, send them the portal link (step 4) instead.`,
    },
    strategy_call: {
      email: render("reminder.book_call.v1", { bookCallLink: GENERAL_STRATEGY_CALL_BOOKING_URL }),
      sms: `Hi ${first}, it's Jordan at RealTour Pilot. Grab a time for your strategy call here: ${GENERAL_STRATEGY_CALL_BOOKING_URL}`,
      note: `Inside their portal, "Book a call" uses the monthly strategy-call event (${monthlyMapping?.publicUrl ?? STRATEGY_CALL_BOOKING_URL}) instead of this link.`,
    },
    strategy_ready: {
      email: strategyVars ? render("strategy_ready.v2", strategyVars) : render("strategy_ready.v2", { callLink: GENERAL_STRATEGY_CALL_BOOKING_URL, setupMissing: [], strategyUpdate: false }),
      sms: `Hi ${first}, your content strategy is ready in your RealTour Pilot portal: ${a.portalLink}`,
      note: a.approvedId ? null : "No approved strategy yet: approve and release it in step 2 before telling them it is ready.",
    },
    scripts_ready: {
      email: render("scripts_ready.v1", { titles: titles.length ? titles : ["(your scripts)"] }),
      sms: `Hi ${first}, your ${month} scripts are ready to read in your RealTour Pilot portal: ${a.portalLink}`,
      note: titles.length ? null : `No script for ${month} is released to their portal yet, so the list in the email is a placeholder. Edit it before sending.`,
    },
    video_ready: {
      email: render("reminder.review_work.v2"),
      sms: `Hi ${first}, a new video is waiting for your review in your RealTour Pilot portal: ${a.portalLink}`,
      note: null,
    },
    note: {
      email: [`Hi ${first},`, "", "", "", SIGN].join("\n"),
      sms: `Hi ${first}, it's Jordan at RealTour Pilot. `,
      note: null,
    },
  };

  return ONBOARDING_MESSAGES.map((m) => {
    // Every op the message needs (the welcome: the account AND Jordan's own messages).
    const missing = a.isTest ? [] : missingToggles(m, a.reach);
    const allowed = missing.length === 0;
    return {
      key: m.key,
      allowed,
      blockedWhy: allowed ? null : `Turn on ${toggleNames(missing)} for ${a.clientName} in step 3 first. That only allows it; nothing is sent until you press Send now.`,
      recipients: a.isTest ? a.recipients.filter((r) => (r.channel === "email" ? isVerifiedTestDestinationEmail(r.toRef) : isVerifiedTestDestinationPhone(r.toRef))) : a.recipients,
      body: { email: bodies[m.key].email, sms: bodies[m.key].sms },
      note: bodies[m.key].note,
      last: lastSentOf(a.record, m.key),
    };
  });
}

// ---- the changes the page makes -----------------------------------------------------

export type OnboardingResult = { ok: boolean; message: string };
const UNCHANGED = "__unchanged__";

/**
 * What a toggle's switches would do, each with its state — said after every
 * turn-on: "Client reminders (off) — would email them reminders on its own: …".
 * Plain words for what WOULD happen; never an invitation to turn one on.
 */
async function switchesLine(key: OnboardingToggleKey): Promise<{ line: string; anyOn: boolean }> {
  const { AUTOMATION_EFFECTS } = await import("@/lib/programAutomationCopy");
  const t = toggleOf(key);
  const states = await Promise.all(t.switches.map(async (k) => ({ k, on: await isAutomationEnabled(k) })));
  return {
    line: states.map(({ k, on }) => `${AUTOMATION_EFFECTS[k].title} (${on ? "on" : "off"})${SWITCH_WOULD[k] ? ` — ${SWITCH_WOULD[k]}` : ""}`).join("; "),
    anyOn: states.some((x) => x.on),
  };
}

const OTHERS_ON_FILE = "__others_on_file__";

/** Is this client reached for anything a group carries, under `r`? */
const reachedAny = (r: ProgramRollout, who: { id: string; name: string | null }, now: Date): boolean =>
  PROGRAM_REACH_OPS.some((op) => pilotGroupOf(op) !== null && rolloutDecision({ rollout: r, client: who, op, now }).ok);

export type OnboardingToggleResult = OnboardingResult & {
  /** Refused because other named clients still have choices on file (the list would wake them): their names. */
  othersOnFile?: string[];
};

/**
 * Turn ONE toggle on or off for ONE real client. Writes the client's own list
 * in the program rollout through updateProgramRollout (advisory lock, one
 * transaction, AuditLog) with setClientOpsChange, then notes it in the
 * client's onboarding log. Sends nothing.
 *
 * NOBODY ELSE COMES BACK ON (review fix, Oct 5 2026). While the named list
 * reaches nobody (the mode is "Only my TEST clients"), turning something on
 * here would switch the list back on — and every other client's choices on
 * file with it. That is refused, naming them, unless Jordan presses "Turn on
 * for <client> only" (`onlyThisClient`), which sets everyone else on the list
 * to nothing in the same write. The success message is computed from what
 * actually changed (who is reached before and after), so "nobody else was
 * turned on" is said only when it is true.
 */
export async function setOnboardingToggle(input: { clientId: string; toggle: string; on: boolean; by: string; onlyThisClient?: boolean }): Promise<OnboardingToggleResult> {
  if (!isOnboardingToggleKey(input.toggle)) return { ok: false, message: "Unknown setting. Nothing was changed." };
  const key = input.toggle;
  const t = toggleOf(key);
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, name: true } });
  if (!client) return { ok: false, message: "That client no longer exists. Nothing was changed." };
  if (isSyntheticClientRow(client)) return { ok: false, message: "A TEST client always gets everything that is switched on (at your test inbox only), so there is nothing to turn on here." };
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { clientId: client.id }, select: { status: true } });
  if (!enrollment) return { ok: false, message: `${client.name} has no program. Nothing was changed.` };
  if (input.on && enrollment.status !== "ACTIVE") return { ok: false, message: `${client.name}'s program is ${enrollment.status.toLowerCase()}, so nothing can be turned on for them. Nothing was changed.` };
  if (key === "bookings" && input.on) {
    const { AUTOMATION_EFFECTS } = await import("@/lib/programAutomationCopy");
    const rows = await prisma.programAutomation.findMany({ where: { key: { in: ["session_booking", "address_sync"] } }, select: { key: true, enabled: true, lastRunAt: true, lastError: true, lastErrorAt: true } });
    const why = autoBookingProblems(rows, AUTOMATION_EFFECTS);
    if (why.length) return { ok: false, message: `Automatic Aryeo booking can't be chosen yet: ${why.join("; ")}. Kyle keeps booking by hand. Nothing was changed.` };
  }
  let others: string[] = [];
  let at = new Date();
  const r = await updateProgramRollout((cur, now) => {
    at = now;
    const had = clientAllowedOps(cur, client);
    const next = opsWithToggle(had, key, input.on);
    if (next.length === had.length && next.every((op) => had.includes(op))) return { error: UNCHANGED };
    const change = setClientOpsChange(cur, { client, ops: next, by: input.by, now, onlyThisClient: input.onlyThisClient === true });
    if ("error" in change && change.othersOnFile?.length) {
      others = change.othersOnFile;
      return { error: OTHERS_ON_FILE };
    }
    return change;
  }, input.by, "client_onboarding_toggle");
  const namesOf = async (ids: string[]): Promise<string[]> => {
    if (!ids.length) return [];
    const rows = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return ids.map((id) => rows.find((x) => x.id === id)?.name ?? id);
  };
  const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join(""));
  if (!r.ok) {
    if (r.message === UNCHANGED) return { ok: true, message: `"${t.label}" was already ${input.on ? "on" : "off"} for ${client.name}. Nothing was changed.` };
    if (r.message === OTHERS_ON_FILE) {
      const names = await namesOf(others);
      const { rollout } = await loadProgramRollout().catch(() => ({ rollout: { ...CLOSED_ROLLOUT } as ProgramRollout }));
      const why = rollout.mode === "TEST_ONLY"
        ? "Who the program may reach is set to \"Only my TEST clients\""
        : "the named-client list has no recorded approval, so it reaches nobody right now";
      return {
        ok: false,
        othersOnFile: names,
        message: `Nothing was changed. ${why}, and ${list(names)} still ${names.length === 1 ? "has" : "have"} choices on file from before. Turning on "${t.label}" for ${client.name} would switch the list back on, and ${names.length === 1 ? "they" : "they all"} would get those choices again. Choose "Turn on for ${client.name} only" (everyone else on the list is set to nothing), or first set Who the program may reach to "My TEST clients and the clients I name below" on purpose.`,
      };
    }
    return { ok: false, message: r.message };
  }
  await writeRecord(client.id, appendLog({ by: input.by, kind: "toggle", detail: `${input.on ? "Allowed" : "Turned off"}: ${t.label}${input.onlyThisClient ? " (for this client only; everyone else on the list set to nothing)" : ""}` }), null).catch(() => null);
  if (!input.on) {
    return { ok: true, message: `"${t.label}" is off for ${client.name}. Anything of it not yet sent is stopped at sending.` };
  }

  // WHAT ACTUALLY CHANGED, read off the rollout before and after.
  const involved = [...new Set([...(r.from.pilot?.clientIds ?? []), ...(r.to.pilot?.clientIds ?? [])])].filter((id) => id !== client.id);
  const named = involved.length ? await prisma.client.findMany({ where: { id: { in: involved } }, select: { id: true, name: true } }) : [];
  const whoOf = (id: string) => ({ id, name: named.find((x) => x.id === id)?.name ?? null });
  const wokeIds = involved.filter((id) => !reachedAny(r.from, whoOf(id), at) && reachedAny(r.to, whoOf(id), at));
  const clearedIds = involved.filter((id) => {
    const before = r.from.pilot?.clientIds.includes(id) ? pilotOpsFor(r.from.pilot, id) : [];
    const after = r.to.pilot?.clientIds.includes(id) ? pilotOpsFor(r.to.pilot, id) : [];
    return before.length > 0 && after.length === 0;
  });
  const reachesFor = (ro: ProgramRollout, tk: (typeof ONBOARDING_TOGGLES)[number]) => tk.ops.every((op) => rolloutDecision({ rollout: ro, client, op, now: at }).ok);
  const resumed = ONBOARDING_TOGGLES.filter((x) => x.key !== key && reachesFor(r.to, x) && !reachesFor(r.from, x)).map((x) => `"${x.label}"`);
  const parts: string[] = [];
  if (r.from.mode === "TEST_ONLY" && r.to.mode === "PILOT") parts.push("The program now reaches the clients you turn things on for (it was TEST clients only).");
  if (clearedIds.length) parts.push(`Set to nothing, so they were not turned back on: ${list(clearedIds.map((id) => whoOf(id).name ?? id))}.`);
  if (wokeIds.length) parts.push(`Also reached again now: ${list(wokeIds.map((id) => whoOf(id).name ?? id))}.`);
  else if (parts.length) parts.push("Nobody else was turned on.");
  if (resumed.length) parts.push(`Already on for ${client.name} and now reaching them too: ${resumed.join(", ")}.`);
  if (r.to.mode === "ALL") parts.push("Note: Content program automations are set to reach every client, so this per-client choice only matters for bookings until that is set back to named clients.");
  const tail = parts.length ? ` ${parts.join(" ")}` : "";
  if (!t.switches.length) {
    return { ok: true, message: `"${t.label}" is allowed for ${client.name}. Nothing was sent. A message goes only when you press Send now in step 5.${tail}` };
  }
  const sw = await switchesLine(key);
  const reachNow = reachesFor(r.to, t);
  const state = !sw.anyOn
    ? `${t.switches.length === 1 ? "That switch is" : "Those switches are all"} off, so nothing happens for ${client.name}.`
    : reachNow ? `Because a switch is on, this now applies to ${client.name}.` : `A switch is on, but the program does not reach ${client.name} yet.`;
  return { ok: true, message: `"${t.label}" is allowed for ${client.name}. Nothing was sent. It is automatic and works only while its switch is on: ${sw.line}. ${state}${tail}` };
}

/**
 * Create the client's OWNER seat WITHOUT emailing anybody, so Jordan can share
 * the portal link himself. A real client needs "Portal account and sign-in"
 * on; a TEST client takes only a staff-controlled address (the pre-launch rule
 * inviteClientUser holds). The seat rules are portalAccess's: an address seated
 * on another client is not ours to seat here, a revoked seat is not re-opened
 * by this button, and a name is filled in, never replaced. A welcome HELD from
 * their payment for the same address is cleared — the account it was owed now
 * exists, and the welcome is Jordan's to send from step 5.
 */
export async function createOnboardingSeat(input: { clientId: string; email: string; name: string | null; by: string; byAppUserId: string | null }): Promise<OnboardingResult> {
  const email = normEmail(input.email);
  if (!email) return { ok: false, message: "That doesn't look like an email address. Nothing was created." };
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, name: true } });
  if (!client) return { ok: false, message: "That client no longer exists. Nothing was created." };
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { clientId: client.id }, select: { id: true, status: true } });
  if (!enrollment) return { ok: false, message: `${client.name} has no program. Nothing was created.` };
  const isTest = isSyntheticClientRow(client);
  if (isTest && !isStaffControlledEmail(email)) return { ok: false, message: "A TEST client's portal person must use a staff-controlled @realtourpilot.com address. Nothing was created." };
  if (!isTest) {
    const d = await programReach("portal_invites", client.id);
    if (!d.ok) return { ok: false, message: `Turn on "Portal account and sign-in" for ${client.name} in step 3 first (${d.reason}). Nothing was created.` };
  }
  const name = (input.name ?? "").trim().slice(0, 120) || null;
  const prior = await prisma.clientUser.findUnique({ where: { email }, select: { id: true, name: true } });
  if (prior) {
    const elsewhere = await prisma.clientMembership.findFirst({ where: { clientUserId: prior.id, revokedAt: null, clientId: { not: client.id } }, select: { id: true } });
    if (elsewhere) return { ok: false, message: `${email} already has an account with another client of ours, so it was not added here. Check with them first. Nothing was created.` };
    const seat = await prisma.clientMembership.findUnique({ where: { clientUserId_enrollmentId: { clientUserId: prior.id, enrollmentId: enrollment.id } }, select: { id: true, revokedAt: true } });
    if (seat?.revokedAt) return { ok: false, message: `${email}'s access to this program was taken away on purpose. Restore it from the client's Settings tab if that's right. Nothing was created.` };
    if (seat) return { ok: true, message: `${email} already has a portal account for ${client.name}. Nothing was changed, and nothing was sent.` };
  }
  const owedKey = `portal-access-owed:${enrollment.id}:${email}`;
  const clearedHeld: string | null = await prisma.$transaction(async (tx) => {
    const person = prior
      ? name && !prior.name?.trim()
        ? await tx.clientUser.update({ where: { id: prior.id }, data: { name }, select: { id: true } })
        : { id: prior.id }
      : await tx.clientUser.upsert({ where: { email }, create: { email, name }, update: {}, select: { id: true } });
    await tx.clientMembership.createMany({
      data: [{ clientUserId: person.id, enrollmentId: enrollment.id, clientId: client.id, role: "OWNER", invitedByAppUserId: input.byAppUserId }],
      skipDuplicates: true,
    });
    const owed = await tx.appSetting.findUnique({ where: { key: owedKey }, select: { value: true } });
    if (owed) await tx.appSetting.deleteMany({ where: { key: owedKey } });
    return owed?.value ?? null;
  });
  await writeRecord(client.id, appendLog({ by: input.by, kind: "seat", to: email, detail: `Portal account created without an email${clearedHeld ? "; the welcome held from their payment was cleared (send it yourself from step 5)" : ""}` }), {
    actor: input.by, action: "client_onboarding_seat", detail: `OWNER seat for ${email} on ${client.name}, no email sent${clearedHeld ? `; held welcome cleared: ${clearedHeld}` : ""}`,
  });
  return {
    ok: true,
    message: `Portal account created for ${email}. No email was sent.${clearedHeld ? " The welcome that was held from their payment is cleared, so it can't go out on its own — send it yourself from step 5 when you're ready." : ""}`,
  };
}

/**
 * THE ONE PATH THAT SENDS (the owner's "Send now"). The caller has checked
 * requireOwner. Checks here, in order, all before anything is queued:
 *   · a known message, a channel, a browser-minted press id, a non-empty body;
 *   · the recipient is one of the addresses on file for this client
 *     (onboardingRecipientsFor) — never a typed address;
 *   · a TEST client: the recipient is one of Jordan's verified test
 *     destinations (the outbox floor refuses anything else as well);
 *   · a real client: the message's toggle is on (the rollout scope for its op,
 *     without any feature's own automatic lock).
 * Then the outbox (kind `onboarding`): the dispatch gate re-checks the same at
 * the moment of sending. The outcome is logged on the client and in AuditLog.
 */
export async function sendOnboardingMessage(input: {
  clientId: string; message: string; channel: string; toRef: string; body: string; intentId: string; by: string;
}): Promise<OnboardingResult & { outcome?: string }> {
  if (!isOnboardingMessageKey(input.message)) return { ok: false, message: "Unknown message. Nothing was sent." };
  if (input.channel !== "email" && input.channel !== "sms") return { ok: false, message: "Pick email or text. Nothing was sent." };
  if (!isIntentId(input.intentId)) return { ok: false, message: "This send could not be identified — reload the page and press Send again. Nothing was sent." };
  const body = (input.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, message: "The message is empty. Nothing was sent." };
  if (body.length > ONBOARDING_BODY_MAX) return { ok: false, message: `The message is longer than ${ONBOARDING_BODY_MAX} characters. Nothing was sent.` };
  const m = messageOf(input.message);
  const channel: OnboardingChannel = input.channel;
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, name: true } });
  if (!client) return { ok: false, message: "That client no longer exists. Nothing was sent." };
  const toRef = channel === "email" ? normEmail(input.toRef) : phoneDigits(input.toRef);
  const on = await onboardingRecipientsFor(client.id);
  if (!toRef || !on.some((r) => r.channel === channel && r.toRef === toRef)) return { ok: false, message: "That address is not on file for this client. Pick one from the list. Nothing was sent." };
  const isTest = isSyntheticClientRow(client);
  if (isTest && !(channel === "email" ? isVerifiedTestDestinationEmail(toRef) : isVerifiedTestDestinationPhone(toRef))) {
    return { ok: false, message: "A TEST client may only be messaged at your verified test inbox or phone. Nothing was sent." };
  }
  if (!isTest) {
    // EVERY op the message needs: manual_messages ("Messages I send myself"),
    // and for the welcome the portal account too. Never the automatic emails'
    // ops (Oct 5 2026 review fix).
    const decisions = await Promise.all(m.ops.map((op) => programReach(op, client.id)));
    const missing = m.toggles.filter((_, i) => !decisions[i].ok);
    const why = decisions.find((d) => !d.ok);
    if (missing.length && why && !why.ok) return { ok: false, message: `Turn on ${toggleNames(missing)} for ${client.name} in step 3 first (${why.reason}). Nothing was sent.` };
  }

  const { sendThroughOutbox, TestClientSendRefusedError } = await import("@/lib/outbox");
  let r: Awaited<ReturnType<typeof sendThroughOutbox>>;
  try {
    r = await sendThroughOutbox({ channel, toRef, body, dedupeKey: onboardingKey(m.key, client.id, input.intentId), clientId: client.id, requestedBy: `onboarding:${input.by}` });
  } catch (e) {
    if (e instanceof TestClientSendRefusedError) return { ok: false, message: "A TEST client may only be messaged at your verified test inbox or phone. Nothing was sent." };
    return { ok: false, message: `The message could not be queued (${errText(e)}). Nothing was sent.` };
  }
  const where = channel === "email" ? toRef : prettyPhone(toRef);
  if (r.outcome === "duplicate") return { ok: true, outcome: "duplicate", message: `That press was already handled (${r.state}). Nothing new was sent.` };
  if (r.outcome === "busy") return { ok: false, outcome: "busy", message: "That message is being sent right now. Reload in a moment to see the result." };
  const kind: OnboardingLogEntry["kind"] = r.outcome === "accepted" ? "sent" : r.outcome === "unknown" ? "send_unknown" : "send_failed";
  const detail = r.outcome === "accepted" ? `sent (outbox ${r.id})` : r.outcome === "unknown" ? `may have gone — ${r.error} (outbox ${r.id})` : `not sent — ${r.error.replace(/^refused before send: /, "")} (outbox ${r.id})`;
  await writeRecord(client.id, appendLog({ by: input.by, kind, message: m.key, channel, to: toRef, detail, ...(r.id ? { outboxId: r.id } : {}) }), {
    actor: input.by, action: "client_onboarding_send", detail: `${m.label} → ${channel} ${toRef}: ${detail}`,
  }).catch((e) => console.error(`[onboarding] ${client.id} ${m.key} ${r.outcome} but the log write failed`, e));
  if (r.outcome === "accepted") return { ok: true, outcome: "sent", message: `Sent "${m.label}" to ${where}.` };
  if (r.outcome === "unknown") return { ok: false, outcome: "unknown", message: `It may have gone to ${where} — the provider did not confirm. It is held on Connections for you to check; it will not be re-sent on its own.` };
  return { ok: false, outcome: "failed", message: `Not sent: ${r.error.replace(/^refused before send: /, "")}.` };
}

/**
 * AN ONBOARDING MESSAGE THE HUB SENT AFTER THE PRESS (Oct 5 2026 review fix).
 * Two roads deliver one of Jordan's presses without "Send now" returning to
 * write the log: the outbox recovery drain (api/cron/gmail — the worker that
 * took his press stopped before handing it over, and the drain sends that
 * same row a few minutes later), and his own Retry of an unconfirmed send
 * (tasks/sendAllActions.retryUnknownSend, owner only). Either way the page
 * would have shown "Not sent" and invited a second press. This writes the
 * send in the client's onboarding log — ONCE per outbox row — and in AuditLog.
 * Returns a note for the cron run, or null (not an onboarding row, or already
 * logged). Sends nothing.
 */
export async function recordOnboardingOutboxSend(
  row: { id: string; dedupeKey: string | null; clientId: string | null; channel: string; toRef: string; requestedBy?: string | null },
  how: "recovered" | "retried",
  by?: string | null,
): Promise<string | null> {
  const k = parseOnboardingKey(row.dedupeKey);
  if (!k || !row.clientId || row.clientId !== k.clientId) return null;
  const m = messageOf(k.message);
  const pressedBy = row.requestedBy?.startsWith("onboarding:") ? row.requestedBy.slice("onboarding:".length) : null;
  const who = by ?? pressedBy ?? "the hub";
  const channel: OnboardingChannel = row.channel === "email" ? "email" : "sms";
  const detail = how === "recovered"
    ? `sent by the hub a few minutes after your press — the first try was interrupted (outbox ${row.id})`
    : `re-sent by ${who} after an unconfirmed send (outbox ${row.id})`;
  let added = false;
  await writeRecord(k.clientId, (r, now) => {
    if (r.log.some((e) => e.kind === "sent" && e.outboxId === row.id)) return r;
    added = true;
    return { ...r, log: [...r.log, { at: now.toISOString(), by: who, kind: "sent", message: m.key, channel, to: row.toRef, detail, outboxId: row.id }] };
  }, { actor: who, action: how === "recovered" ? "client_onboarding_send_recovered" : "client_onboarding_send_retried", detail: `${m.label} → ${channel} ${row.toRef}: ${detail}` });
  return added ? `onboarding "${m.label}" (${how}) written on ${k.clientId}'s onboarding log` : null;
}

/** Jordan sent it himself, outside the hub: record it. Sends nothing. */
export async function markOnboardingSent(input: { clientId: string; message: string; channel: string; toRef?: string | null; by: string }): Promise<OnboardingResult> {
  if (!isOnboardingMessageKey(input.message)) return { ok: false, message: "Unknown message. Nothing was recorded." };
  const channel: OnboardingChannel | undefined = input.channel === "email" || input.channel === "sms" ? input.channel : undefined;
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, name: true } });
  if (!client) return { ok: false, message: "That client no longer exists. Nothing was recorded." };
  const m = messageOf(input.message);
  const to = (input.toRef ?? "").trim().slice(0, 200) || undefined;
  await writeRecord(client.id, appendLog({ by: input.by, kind: "marked", message: m.key, channel, to, detail: "sent by Jordan outside the hub" }), {
    actor: input.by, action: "client_onboarding_mark_sent", detail: `${m.label} marked sent by ${input.by}${channel ? ` (${channel}${to ? ` to ${to}` : ""})` : ""}; the hub sent nothing`,
  });
  return { ok: true, message: `Recorded: you sent "${m.label}" to ${client.name}. The hub sent nothing.` };
}

/** Step 7: the "Onboarded" checkbox. */
export async function setOnboarded(input: { clientId: string; done: boolean; by: string }): Promise<OnboardingResult> {
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, name: true } });
  if (!client) return { ok: false, message: "That client no longer exists. Nothing was changed." };
  await writeRecord(client.id, (r, now) => ({
    onboardedAt: input.done ? now.toISOString() : null,
    onboardedBy: input.done ? input.by : null,
    log: [...r.log, { at: now.toISOString(), by: input.by, kind: input.done ? "onboarded" : "reopened" }],
  }), { actor: input.by, action: input.done ? "client_onboarding_done" : "client_onboarding_reopened", detail: `${client.name} ${input.done ? "marked onboarded" : "onboarding reopened"}` });
  return { ok: true, message: input.done ? `${client.name} is marked onboarded.` : `${client.name} is back in progress.` };
}
