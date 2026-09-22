import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { MONTHLY_PLAN_RE } from "@/lib/videoStyles";
import { isAutomationEnabled, recordAutomationRun } from "@/lib/programAutomation";
import { monthSessionCount, recalcProgramMonth, sessionShortfall, type ProgramDb } from "@/lib/programMonths";
import { isTestClientName } from "@/lib/testClients";

// ---------------------------------------------------------------------------
// SESSION REQUESTS (spec §4), Sep 16 2026.
//
// A client's "book my content session" used to be a SmartTask and a green
// tick that vanished on reload. Now it is a durable ProgramSessionRequest:
//
//   REQUESTED ──(Aryeo appointment appears at that slot)──▶ CONFIRMED
//             ──(client / staff)──▶ CANCELLED     ──(slot passed, nothing booked)──▶ EXPIRED
//
// Truth about "booked" comes ONLY from Aryeo (the Appointment rows the hourly
// sync already writes) — the request never says Booked on its own. Kyle still
// books in Aryeo by hand; the request is the persisted ask plus the reconcile.
//
// `session_booking` OFF (the default, and Jordan's rule for now) = request
// only: bookingState stays NONE and nothing is written to Aryeo. ON would
// queue a provider booking job — the Aryeo appointment-create endpoint is NOT
// verified, so the driver below refuses honestly (RECONCILE with a reason)
// rather than pretending. See the handover.
//
// Capacity: package sessions per month + staff-approved extras, counted from
// CONFIRMED requests and Projects already attached to the month.
// ---------------------------------------------------------------------------

export type SessionRequestActor =
  | { kind: "CLIENT"; clientUserId: string | null }
  | { kind: "STAFF"; userId: string | null }
  | { kind: "TOKEN" }; // legacy token portal (no ClientUser yet)

export type CreateSessionRequestInput = {
  enrollmentId: string;
  /** The program month the client is booking FOR — explicitly chosen, never "the server's current month". */
  monthId: string;
  slot: {
    /** ISO start of the picked slot; omit for "here is what works" free text. */
    startISO?: string | null;
    endISO?: string | null;
    timezone?: string | null;
    /** Free-text preference when no slot was picked. */
    when?: string | null;
    locationText?: string | null;
    notes?: string | null;
  };
  actor: SessionRequestActor;
  kind?: "CONTENT_SESSION" | "EXTRA_SESSION";
  /** A reschedule: the request this one replaces (kept, marked superseded via status). */
  supersedesId?: string | null;
};

export type CapacityCheck = {
  allowed: number; used: number; extrasApproved: number; remaining: number; sessionHours: number;
  // ---- A23 (Jordan, Sep 21 2026) -------------------------------------------
  /** The package's sessions for this month, before staff-approved extras. Pro = 2. */
  sessionsPerMonth: number;
  /** DISTINCT confirmed sessions already linked to this client and month. */
  confirmedSessions: number;
  /** Requests waiting on the office that do not yet resolve to one of those. */
  pendingRequests: number;
  /** Every session the package owes is a distinct confirmed session. One Pro
   *  booking leaves this false with one session remaining. */
  fullyScheduled: boolean;
};

export type CreateSessionRequestResult =
  | { ok: true; id: string; status: string; duplicate: boolean; capacity: CapacityCheck; message: string }
  | { ok: false; reason: string; capacity?: CapacityCheck };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const TASK_PREFIX = "content-session-request-";

/**
 * Sessions used vs allowed for a month.
 *
 * COUNTED FROM APPOINTMENTS, NOT PROJECTS (A23, Jordan Sep 21 2026). Video Pro
 * is the existing four-hour product booked TWICE, which puts two appointments on
 * one Aryeo order and therefore on ONE Project here. This function used to count
 * projects, so a Pro client who had booked both of their sessions the way Jordan
 * says to book them would have been shown one session used and one remaining,
 * and a Pro client who had booked ONE would have been shown the same thing. The
 * rule now lives in programMonths.countDistinctSessions and is shared with the
 * reminder evaluator, so the portal and the chaser cannot drift apart.
 *
 * Only THIS client's sessions use up the allowance: a job mis-attached to another
 * client's month is hidden by the portal and must not block a booking here.
 */
export async function sessionCapacity(enrollmentId: string, monthId: string, opts: { now?: Date; db?: ProgramDb } = {}): Promise<CapacityCheck> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const enrollment = await db.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, sessionsPerMonth: true, sessionHours: true } });
  const count = enrollment ? await monthSessionCount(monthId, enrollment.clientId, now, db) : { sessions: [], booked: 0, filmed: 0, accountedFor: 0, duplicatesFolded: 0 };
  const requests = await db.programSessionRequest.findMany({
    where: { enrollmentId, monthId, status: { in: ["REQUESTED", "RESCHEDULE_REQUESTED", "CONFIRMED"] } },
    select: { id: true, projectId: true, aryeoAppointmentId: true, kind: true, extraApprovedBy: true, status: true },
  });
  // A CONFIRMED request is already inside `count` (it is one of the things
  // countDistinctSessions folds), so only the asks the office has not answered
  // are added on top — and only when they do not already resolve to a counted
  // session. Two clicks that landed on one appointment are one session, not two.
  const countedKeys = new Set(count.sessions.map((x) => x.key));
  const pending = requests.filter(
    (r) => (r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED") &&
      !(r.aryeoAppointmentId && countedKeys.has(`appt:${r.aryeoAppointmentId}`)) &&
      !(r.projectId && countedKeys.has(`project:${r.projectId}`)),
  );
  const extrasApproved = requests.filter((r) => r.kind === "EXTRA_SESSION" && r.extraApprovedBy).length;
  const sessionsPerMonth = Math.max(1, enrollment?.sessionsPerMonth ?? 1);
  const allowed = sessionsPerMonth + extrasApproved;
  const used = count.accountedFor + pending.length;
  const shortfall = sessionShortfall(sessionsPerMonth, count);
  return {
    allowed, used, extrasApproved, remaining: Math.max(0, allowed - used), sessionHours: enrollment?.sessionHours ?? 2,
    sessionsPerMonth, confirmedSessions: count.accountedFor, pendingRequests: pending.length,
    fullyScheduled: shortfall.fullyScheduled,
  };
}

/**
 * THE function the portal action (W1-A) and staff call. Duplicate clicks
 * collide on dedupeKey `<enrollment>:<month>:<slot|flex>` and return the
 * existing row. Never writes to Aryeo.
 */
export async function createSessionRequest(input: CreateSessionRequestInput): Promise<CreateSessionRequestResult> {
  const [enrollment, month] = await Promise.all([
    prisma.contentEnrollment.findUnique({ where: { id: input.enrollmentId }, select: { id: true, clientId: true, status: true, timezone: true } }),
    prisma.contentMonth.findUnique({ where: { id: input.monthId }, select: { id: true, enrollmentId: true, monthKey: true, historical: true } }),
  ]);
  if (!enrollment) return { ok: false, reason: "This program membership is not active." };
  if (!month || month.enrollmentId !== enrollment.id) return { ok: false, reason: "Pick one of your program months." };
  if (month.historical) return { ok: false, reason: "That month is closed." };
  if (enrollment.status !== "ACTIVE") return { ok: false, reason: "Your program is paused — text us and we'll sort the next session together." };

  const start = input.slot.startISO ? new Date(input.slot.startISO) : null;
  if (input.slot.startISO && (!start || !Number.isFinite(start.getTime()))) return { ok: false, reason: "Pick a time from the list." };
  const end = input.slot.endISO ? new Date(input.slot.endISO) : null;
  const when = (input.slot.when ?? "").trim();
  if (!start && !when) return { ok: false, reason: "Pick a time from the list, or tell us what works." };
  if (start && start < new Date()) return { ok: false, reason: "That time has passed — pick a later one." };
  const location = clip((input.slot.locationText ?? "").trim(), 300);

  const kind = input.kind ?? "CONTENT_SESSION";
  const dedupeKey = `${enrollment.id}:${month.id}:${start ? start.toISOString() : "flex"}`;
  const bookingOn = await isAutomationEnabled("session_booking");
  const now = new Date();

  // A24 — SIMULTANEOUS REQUESTS MUST NOT CREATE DUPLICATE PRO SESSIONS.
  //
  // §8: "Revalidate the slot and program capacity at submission. Prevent double
  // bookings and duplicate Pro sessions under simultaneous requests." The
  // capacity read and the row write used to be two separate statements, so two
  // clicks a few milliseconds apart on a Pro month with one session left BOTH
  // read `remaining: 1`, both passed, and both wrote — two requests against one
  // remaining session, with nothing anywhere reading as broken. dedupeKey does
  // not catch it: two DIFFERENT slots are two different keys, which is exactly
  // the Pro case (a client picking their second session's time twice).
  //
  // The provider write is not ours to make in this build, so the concurrency
  // work that IS ours is to make the check and the write one atomic decision:
  // an advisory lock scoped to this enrollment and month, held for the length of
  // the transaction, so the second caller reads the first caller's row.
  //
  // ::int4 IS NOT DECORATION (Topaz drill, Sep 18 2026). Prisma sends a JS
  // number as a bigint, Postgres has no pg_advisory_xact_lock(bigint, bigint),
  // and without the casts every call raised 42883 — which is how cut uploads
  // were broken for four hours.
  const [lockA, lockB] = monthLockKey(enrollment.id, month.id);
  type Settled =
    | { kind: "duplicate"; id: string; status: string; capacity: CapacityCheck }
    | { kind: "full"; capacity: CapacityCheck }
    | { kind: "created"; id: string; capacity: CapacityCheck };
  const settled = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockA}::int4, ${lockB}::int4)`;
    // Read INSIDE the lock, so it is the capacity as of this decision.
    const capacity = await sessionCapacity(enrollment.id, month.id, { now, db: tx });
    // The duplicate check comes BEFORE the capacity check: a second click on
    // the same slot is the same request (the row it already made fills the
    // month's one slot), not "over capacity".
    const existing = await tx.programSessionRequest.findUnique({ where: { dedupeKey }, select: { id: true, status: true } });
    if (existing && !["CANCELLED", "DECLINED", "EXPIRED"].includes(existing.status)) {
      return { kind: "duplicate", id: existing.id, status: existing.status, capacity } satisfies Settled;
    }
    if (kind === "CONTENT_SESSION" && capacity.remaining <= 0) return { kind: "full", capacity } satisfies Settled;
    const data = {
      enrollmentId: enrollment.id, clientId: enrollment.clientId, monthId: month.id, kind,
      slotStart: start, slotEnd: end, timezone: input.slot.timezone ?? enrollment.timezone ?? "America/New_York",
      locationText: location || null,
      notes: [when && `Preferred: ${when}`, input.slot.notes?.trim()].filter(Boolean).join("\n") || null,
      requestedByClientUserId: input.actor.kind === "CLIENT" ? input.actor.clientUserId : null,
      requestedByStaffUserId: input.actor.kind === "STAFF" ? input.actor.userId : null,
      status: "REQUESTED",
      supersedesId: input.supersedesId ?? null,
      capacityCheckJson: JSON.stringify(capacity),
      // The switch decides whether a provider booking is even attempted.
      bookingState: bookingOn && start ? "QUEUED" : "NONE",
      dedupeKey,
    };
    const row = existing
      ? await tx.programSessionRequest.update({ where: { id: existing.id }, data: { ...data, cancelledAt: null, cancelledBy: null, cancelReason: null, confirmedAt: null, confirmedBy: null }, select: { id: true } })
      : await tx.programSessionRequest.create({ data, select: { id: true } });
    if (input.supersedesId) {
      await tx.programSessionRequest.updateMany({ where: { id: input.supersedesId, status: { in: ["REQUESTED", "CONFIRMED"] } }, data: { status: "RESCHEDULE_REQUESTED" } });
    }
    return { kind: "created", id: row.id, capacity } satisfies Settled;
    // The lock is held only for these statements; the desk task and the month
    // recalculation below are deliberately outside it. 20s is far past anything
    // this transaction does and short enough that a stuck caller frees the month.
  }, { timeout: 20_000 });

  if (settled.kind === "duplicate") {
    return { ok: true, id: settled.id, status: settled.status, duplicate: true, capacity: settled.capacity, message: "We already have this request — it shows as requested until we confirm it." };
  }
  if (settled.kind === "full") {
    const c = settled.capacity;
    // Jordan, Sep 21: "One booking should still show one session remaining."
    // The refusal says which session is missing rather than "your month is full",
    // because on Pro those are different sentences.
    return { ok: false, reason: `This month's ${c.allowed} session${c.allowed === 1 ? " is" : "s are"} already booked or requested — ask us about an extra session.`, capacity: c };
  }
  await ensureDeskTask(settled.id);
  await recalcProgramMonth(month.id);
  // The capacity quoted back is the one the decision was made on, re-read after
  // the write so the caller sees the session it just used up.
  const after = await sessionCapacity(enrollment.id, month.id, { now });
  const remainingNote = after.remaining > 0
    ? ` You still have ${after.remaining} session${after.remaining === 1 ? "" : "s"} to book this month.`
    : "";
  return { ok: true, id: settled.id, status: "REQUESTED", duplicate: false, capacity: after, message: `Requested — it stays “awaiting confirmation” until it's booked in Aryeo, then the date shows here.${remainingNote}` };
}

/**
 * A stable int4 pair for pg_advisory_xact_lock, scoped to ONE enrollment's ONE
 * month. Two FNV-1a passes with different seeds, the same shape review uploads
 * use: same month → same pair on every worker, different months → different
 * pairs, so two clients booking at the same instant never wait on each other. A
 * collision across months would cost a moment's waiting, never correctness.
 * (Two int4s rather than one int8 because the build targets below ES2020.)
 */
function monthLockKey(enrollmentId: string, monthId: string): [number, number] {
  const str = `program-session|${enrollmentId}|${monthId}`;
  const fnv = (seed: number): number => {
    let h = seed;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h | 0;
  };
  return [fnv(0x811c9dc5), fnv(0x9e3779b9)];
}

/** Kyle's desk row for one request — the ask with the exact slot; closed when the request settles. */
/** The "two bookings both fit" sentence for Kyle's task, from the stored evidence. */
function ambiguityLine(matchEvidenceJson: string | null): string {
  let names = "";
  try {
    const v = JSON.parse(matchEvidenceJson ?? "") as { candidates?: { appointmentId: string; startAt: string | null }[] };
    names = (v.candidates ?? [])
      .map((c) => `${c.startAt ? new Date(c.startAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "no time"} (${c.appointmentId})`)
      .join(" and ");
  } catch { /* the sentence stands without the ids */ }
  return `⚠ TWO content appointments both fit this request${names ? `: ${names}` : ""}. The hub will not guess between them — open the request and confirm which one is this session.`;
}

async function ensureDeskTask(requestId: string): Promise<void> {
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId } });
  if (!r) return;
  const [client, month] = await Promise.all([
    prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true } }),
    prisma.contentMonth.findUnique({ where: { id: r.monthId }, select: { monthKey: true } }),
  ]);
  // TEST clients get no row on Kyle's real desk — except when a probe asks for
  // one. Without the escape hatch this create/close path could only ever be
  // read, never run: `ensureDeskTask` returned early for the only clients we
  // are allowed to write to (review, Sep 17). The flag is set by a probe
  // process, never in production.
  if (isTestClientName(client?.name) && process.env.PROGRAM_DESK_TASKS_FOR_TEST !== "1") return;
  const dedupeKey = `${TASK_PREFIX}${r.id}`;
  const when = r.slotStart
    ? `${r.slotStart.toLocaleString("en-US", { timeZone: r.timezone ?? "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${r.timezone ?? "ET"})`
    : "no slot picked";
  // WHICH session, on a package that owes more than one (A23, Jordan Sep 21
  // 2026). "Book content session" told Kyle nothing about whether this was the
  // first or the second half of a Pro month, and the two are different bookings
  // of the same four-hour product.
  const capacity = await sessionCapacity(r.enrollmentId, r.monthId).catch(() => null);
  const ordinalLine = capacity && capacity.sessionsPerMonth > 1
    ? `Session ${Math.min(capacity.confirmedSessions + 1, capacity.sessionsPerMonth)} of ${capacity.sessionsPerMonth} — ${capacity.confirmedSessions} already confirmed for this month. Book the four-hour product again; it is a second booking, not a longer one.`
    : null;
  const description = [
    `Content session request for ${month?.monthKey ?? "their month"} (${r.kind === "EXTRA_SESSION" ? "EXTRA session" : "package session"}).`,
    ordinalLine,
    `Time: ${when}`,
    r.locationText ? `Filming location: ${r.locationText}` : null,
    r.notes ? r.notes : null,
    "",
    // A07: when two real content bookings both fit, the reconcile refuses to
    // pick and says so HERE rather than leaving Kyle to wonder why an obviously
    // booked session never confirmed.
    r.matchState === "AMBIGUOUS" ? ambiguityLine(r.matchEvidenceJson) : null,
    "Book it in Aryeo — the request flips to CONFIRMED on its own when the appointment appears (hourly), and the client sees the date.",
    r.taskId ? null : `Request ${r.id}`,
  ].filter((x): x is string => x != null).join("\n");
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { description, status: "OPEN", completedAt: null } });
    return;
  }
  const task = await prisma.smartTask.create({
    data: {
      taskType: "todo",
      title: capacity && capacity.sessionsPerMonth > 1
        ? `Book content session ${Math.min(capacity.confirmedSessions + 1, capacity.sessionsPerMonth)} of ${capacity.sessionsPerMonth} — ${client?.name ?? "client"}`
        : `Book content session — ${client?.name ?? "client"}`,
      summary: clip(`Requested: ${when}${r.locationText ? ` · ${r.locationText}` : ""}`, 200),
      description, reasonCreated: "Client requested a content session (persisted request)", source: "portal", priority: "HIGH",
      dueAt: new Date(Date.now() + 24 * 3600_000), assignedKey: "kyle", clientId: client?.id ?? null, dedupeKey,
    },
    select: { id: true },
  });
  await prisma.programSessionRequest.update({ where: { id: r.id }, data: { taskId: task.id } });
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({ kind: "portal_session", title: `Session request — ${client?.name ?? "a client"}`, body: clip(when, 140), href: "/tasks?tab=board", targets: [{ roles: ["OWNER", "ADMIN"] }], dedupeKey: `session-request-${r.id}` });
  } catch { /* bell is best-effort */ }
}

async function closeDeskTask(requestId: string, outcome: "COMPLETED" | "CANCELLED"): Promise<void> {
  await prisma.smartTask.updateMany({ where: { dedupeKey: `${TASK_PREFIX}${requestId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: outcome, completedAt: new Date() } });
}

export async function cancelSessionRequest(requestId: string, by: string | null, reason?: string): Promise<void> {
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { status: true, monthId: true } });
  if (!r) throw new Error("Request not found.");
  if (["CANCELLED", "EXPIRED", "DECLINED"].includes(r.status)) return;
  // A CONFIRMED request has a real Aryeo appointment behind it: the request is
  // marked, but the appointment itself is cancelled by a person in Aryeo —
  // the hub never cancels provider bookings (spec §19: confirm the provider result separately).
  await prisma.programSessionRequest.update({ where: { id: requestId }, data: { status: r.status === "CONFIRMED" ? "CANCEL_REQUESTED" : "CANCELLED", cancelledAt: new Date(), cancelledBy: by, cancelReason: reason?.trim() || null } });
  if (r.status === "CONFIRMED") await ensureDeskTask(requestId); else await closeDeskTask(requestId, "CANCELLED");
  await recalcProgramMonth(r.monthId);
}

export async function declineSessionRequest(requestId: string, by: string | null, reason: string): Promise<void> {
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { monthId: true } });
  if (!r) throw new Error("Request not found.");
  await prisma.programSessionRequest.update({ where: { id: requestId }, data: { status: "DECLINED", cancelledAt: new Date(), cancelledBy: by, cancelReason: reason.trim() || "declined" } });
  await closeDeskTask(requestId, "CANCELLED");
  await recalcProgramMonth(r.monthId);
}

export async function approveExtraSession(requestId: string, by: string): Promise<void> {
  await prisma.programSessionRequest.update({ where: { id: requestId }, data: { extraApprovedBy: by } });
}

/** Staff confirm by hand against a known Aryeo appointment / project (the reconcile does this automatically). */
export async function confirmSessionRequest(requestId: string, link: { projectId?: string | null; aryeoAppointmentId?: string | null }, by: string): Promise<void> {
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { monthId: true, status: true } });
  if (!r) throw new Error("Request not found.");
  await prisma.programSessionRequest.update({
    where: { id: requestId },
    data: { status: "CONFIRMED", projectId: link.projectId ?? undefined, aryeoAppointmentId: link.aryeoAppointmentId ?? undefined, confirmedAt: new Date(), confirmedBy: by, bookingState: "SUCCEEDED", matchState: "STAFF", matchEvidenceJson: JSON.stringify({ chose: link.aryeoAppointmentId ?? null, why: `confirmed by hand by ${by}` }) },
  });
  await closeDeskTask(requestId, "COMPLETED");
  await recalcProgramMonth(r.monthId);
}

// ---------------------------------------------------------------------------
// A07 (Sep 21 audit, fixed Sep 22 2026) — PROXIMITY IS NOT EVIDENCE.
//
// The matcher took ANY non-cancelled appointment for the client within two
// hours of the requested slot. Nothing required that appointment to be content
// work at all, so a listing shoot at 11:00 confirmed a content session request
// at 10:00, linked the unrelated project, told the client "Booked", and closed
// Kyle's desk task. The flex (no-slot) arm was looser still: any appointment in
// the month.
//
// A confirmation now needs POSITIVE evidence that this appointment IS the
// content session, in this order of strength:
//
//   PROVIDER_ID        the hub booked it and holds the appointment id. Nothing
//                      to infer.
//   MONTH_LINK         the appointment's project is attached to THIS content
//                      month (Project.contentMonthId) — set by
//                      attachMonthlyProjects from the deliverable labels.
//   CONTENT_DELIVERABLE the project's own deliverables read as monthly content
//                      (MONTHLY_PLAN_RE, the one shared signal the rest of the
//                      pipeline uses) and it falls in the requested month.
//
// Timing still has to agree, but it can no longer carry the decision alone. An
// appointment that is merely NEAR the slot is recorded as a near miss and
// confirms nothing.
//
// And when two eligible appointments both fit, the request goes AMBIGUOUS
// rather than picking one: Kyle's task stays open and the evidence for each
// candidate is on the row. Guessing between two real bookings is the same
// error as guessing from proximity, just rarer.
// ---------------------------------------------------------------------------

export type ApptRow = {
  id: string;
  aryeoId: string;
  startAt: Date | null;
  projectId: string;
  project: { contentMonthId: string | null; deliverables: { label: string | null }[] };
};

export type SessionMatchKind = "PROVIDER_ID" | "MONTH_LINK" | "CONTENT_DELIVERABLE";

/** Is this appointment content-program work, and how do we know? Null = no evidence. */
function contentEvidence(a: ApptRow, monthId: string, monthKey: string | null): { kind: SessionMatchKind; why: string } | null {
  if (a.project.contentMonthId === monthId) {
    return { kind: "MONTH_LINK", why: "its project is attached to this content month" };
  }
  // Attached to a DIFFERENT content month is positive evidence of the wrong
  // thing — it is somebody's other session and must never match here.
  if (a.project.contentMonthId && a.project.contentMonthId !== monthId) return null;
  const monthly = a.project.deliverables.some((d) => d.label && MONTHLY_PLAN_RE.test(d.label));
  if (!monthly) return null;
  if (monthKey && a.startAt && etMonthKey(a.startAt) !== monthKey) return null;
  return { kind: "CONTENT_DELIVERABLE", why: "its deliverables read as monthly content and it falls in the requested month" };
}

export type SessionMatchDecision = {
  /** Appointments that are provably this content session AND fit the timing. */
  eligible: { a: ApptRow; kind: SessionMatchKind; why: string }[];
  /** Appointments that fit the timing but are not content work — what used to confirm. */
  nearMisses: { appointmentId: string; startAt: string | null; why: string }[];
  /** What the caller should do: exactly one eligible confirms, more than one is a person's call. */
  verdict: "CONFIRM" | "AMBIGUOUS" | "NONE";
};

/**
 * THE MATCH DECISION, pure — so the audit's scenarios can be run against it
 * without a database, and so the rule lives in one readable place rather than
 * inside a loop that also writes rows.
 */
export function chooseSessionAppointment(
  req: { monthId: string; monthKey: string | null; slotStart: Date | null; createdAt: Date },
  appts: ApptRow[],
  claimed: ReadonlySet<string>,
): SessionMatchDecision {
  const timingFits = (a: ApptRow): boolean => {
    if (!a.startAt) return false;
    if (req.slotStart) return Math.abs(a.startAt.getTime() - req.slotStart.getTime()) <= 2 * 3600_000;
    // Flex request: inside the requested program month, booked after the ask.
    return a.project.contentMonthId === req.monthId || (!!req.monthKey && etMonthKey(a.startAt) === req.monthKey && a.startAt > req.createdAt);
  };
  const eligible: SessionMatchDecision["eligible"] = [];
  const nearMisses: SessionMatchDecision["nearMisses"] = [];
  for (const a of appts) {
    if (claimed.has(a.aryeoId)) continue;
    const fits = timingFits(a);
    if (!fits) continue;
    const ev = contentEvidence(a, req.monthId, req.monthKey);
    if (ev) { eligible.push({ a, ...ev }); continue; }
    // Recorded so a person can see WHY nothing confirmed — the listing shoot an
    // hour away is exactly what used to be taken for the session.
    nearMisses.push({ appointmentId: a.aryeoId, startAt: a.startAt?.toISOString() ?? null, why: "close to the requested time, but nothing says it is content work" });
  }
  return { eligible, nearMisses, verdict: eligible.length === 1 ? "CONFIRM" : eligible.length > 1 ? "AMBIGUOUS" : "NONE" };
}

/**
 * Hourly reconcile against Aryeo (through the Appointment/Project rows the
 * appointments sync already maintains — no new Aryeo calls):
 *   REQUESTED + ONE appointment that is provably this content session → CONFIRMED;
 *   REQUESTED + two that both fit → AMBIGUOUS, left for Kyle;
 *   CONFIRMED whose appointment was cancelled in Aryeo → CANCELLED;
 *   REQUESTED whose slot passed 2 days ago with nothing booked → EXPIRED.
 */
export async function reconcileSessionRequests(opts: { now?: Date } = {}): Promise<{ checked: number; confirmed: number; cancelled: number; expired: number; ambiguous: number }> {
  const now = opts.now ?? new Date();
  const open = await prisma.programSessionRequest.findMany({ where: { status: { in: ["REQUESTED", "CONFIRMED", "CANCEL_REQUESTED"] } } });
  let confirmed = 0, cancelled = 0, expired = 0, ambiguous = 0;
  const touched = new Set<string>();
  // ONE APPOINTMENT IS ONE SESSION (A23 / A24, Jordan Sep 21 2026).
  //
  // Nothing stopped TWO requests resolving to the SAME appointment, and on a Pro
  // month that is the ordinary case rather than a freak one: a client asks for
  // 10:00 and 11:00 for their two four-hour sessions, Kyle books one of them,
  // and both requests confirmed against it. The client would then have read
  // "Booked" for a session that was never booked, Kyle's second desk task would
  // have closed itself, and the month would have counted as fully scheduled
  // with one session missing.
  //
  // So an appointment already claimed by another request is off the table. The
  // set starts from what the ledger already says and grows as this run confirms.
  const claimed = new Set(
    (await prisma.programSessionRequest.findMany({ where: { status: "CONFIRMED", aryeoAppointmentId: { not: null } }, select: { aryeoAppointmentId: true } }))
      .map((x) => x.aryeoAppointmentId!)
      .filter(Boolean),
  );
  for (const r of open) {
    if (r.status === "REQUESTED") {
      // THE HUB'S OWN BOOKING, when it ever makes one: the appointment id is
      // the provider's answer and there is nothing to infer from timing.
      if (r.aryeoAppointmentId && !claimed.has(r.aryeoAppointmentId)) {
        const mine = await prisma.appointment.findUnique({ where: { aryeoId: r.aryeoAppointmentId }, select: { projectId: true, status: true } });
        if (mine && mine.status !== "CANCELED") {
          claimed.add(r.aryeoAppointmentId);
          await prisma.programSessionRequest.update({
            where: { id: r.id },
            data: { status: "CONFIRMED", projectId: mine.projectId, confirmedAt: now, confirmedBy: "aryeo-reconcile", bookingState: r.bookingState === "NONE" ? "NONE" : "SUCCEEDED", matchState: "PROVIDER_ID", matchEvidenceJson: JSON.stringify({ chose: r.aryeoAppointmentId, why: "the hub holds this appointment id from its own booking" }) },
          });
          await closeDeskTask(r.id, "COMPLETED");
          confirmed++; touched.add(r.monthId);
          continue;
        }
      }
      const month = await prisma.contentMonth.findUnique({ where: { id: r.monthId }, select: { monthKey: true } });
      const appts: ApptRow[] = await prisma.appointment.findMany({
        where: { project: { clientId: r.clientId, status: { not: "CANCELLED" } }, status: { not: "CANCELED" }, startAt: { not: null } },
        select: { id: true, aryeoId: true, startAt: true, projectId: true, project: { select: { contentMonthId: true, deliverables: { where: { removedFromOrderAt: null }, select: { label: true } } } } },
        orderBy: { startAt: "asc" },
      });

      const decision = chooseSessionAppointment(
        { monthId: r.monthId, monthKey: month?.monthKey ?? null, slotStart: r.slotStart, createdAt: r.createdAt },
        appts,
        claimed,
      );
      const { eligible, nearMisses } = decision;

      if (eligible.length === 1) {
        const { a, kind, why } = eligible[0];
        claimed.add(a.aryeoId);
        await prisma.programSessionRequest.update({
          where: { id: r.id },
          data: {
            status: "CONFIRMED", projectId: a.projectId, aryeoAppointmentId: a.aryeoId, confirmedAt: now, confirmedBy: "aryeo-reconcile",
            bookingState: r.bookingState === "NONE" ? "NONE" : "SUCCEEDED",
            matchState: kind, matchEvidenceJson: JSON.stringify({ chose: a.aryeoId, why, nearMisses }),
          },
        });
        await closeDeskTask(r.id, "COMPLETED");
        confirmed++; touched.add(r.monthId);
        continue;
      }

      if (eligible.length > 1) {
        // Two real content bookings both fit. Picking one is a guess; the desk
        // task stays open and both candidates are on the row for Kyle.
        await prisma.programSessionRequest.update({
          where: { id: r.id },
          data: { matchState: "AMBIGUOUS", matchEvidenceJson: JSON.stringify({ candidates: eligible.map((e) => ({ appointmentId: e.a.aryeoId, startAt: e.a.startAt?.toISOString() ?? null, why: e.why })), chose: null, nearMisses }) },
        });
        await ensureDeskTask(r.id);
        ambiguous++; touched.add(r.monthId);
        continue;
      }

      // Nothing confirmable. Keep the near misses visible rather than silent.
      if (nearMisses.length) {
        await prisma.programSessionRequest.update({ where: { id: r.id }, data: { matchState: "NONE", matchEvidenceJson: JSON.stringify({ chose: null, nearMisses }) } }).catch(() => {});
      }

      if (r.slotStart && now.getTime() - r.slotStart.getTime() > 2 * 864e5) {
        await prisma.programSessionRequest.update({ where: { id: r.id }, data: { status: "EXPIRED", cancelReason: "slot passed with nothing booked in Aryeo" } });
        await closeDeskTask(r.id, "CANCELLED");
        expired++; touched.add(r.monthId);
      }
      continue;
    }
    // CONFIRMED / CANCEL_REQUESTED: follow the provider.
    if (r.aryeoAppointmentId) {
      const appt = await prisma.appointment.findUnique({ where: { aryeoId: r.aryeoAppointmentId }, select: { status: true, project: { select: { status: true } } } });
      const gone = !appt || appt.status === "CANCELED" || appt.project.status === "CANCELLED";
      if (gone) {
        // The appointment is gone, so the claim on it is too: a later request
        // for this month is free to match whatever replaces it. This is the
        // cancellation path Jordan named — a Pro month drops back to one
        // confirmed session and has to start asking for the other one again.
        claimed.delete(r.aryeoAppointmentId);
        await prisma.programSessionRequest.update({ where: { id: r.id }, data: { status: "CANCELLED", cancelledAt: r.cancelledAt ?? now, cancelledBy: r.cancelledBy ?? "aryeo-reconcile", cancelReason: r.cancelReason ?? "appointment cancelled in Aryeo" } });
        await closeDeskTask(r.id, "COMPLETED");
        cancelled++; touched.add(r.monthId);
      }
    }
  }
  for (const m of touched) await recalcProgramMonth(m, { now });
  return { checked: open.length, confirmed, cancelled, expired, ambiguous };
}

/**
 * Provider booking driver — only when `session_booking` is ON. The Aryeo
 * appointment-create endpoint has never been verified against the live
 * account (the hub only reads /scheduling/available-timeslots), so this
 * driver does not invent a write: it moves QUEUED requests to RECONCILE with
 * an honest reason, and the desk task carries the booking. Wire the real call
 * here once the endpoint is verified; every state after it is already handled.
 */
export async function driveSessionBookings(opts: { max?: number; now?: Date } = {}): Promise<{ skipped: string } | { handled: number }> {
  if (!(await isAutomationEnabled("session_booking"))) return { skipped: "session_booking is off" };
  const now = opts.now ?? new Date();
  const rows = await prisma.programSessionRequest.findMany({ where: { bookingState: "QUEUED", status: "REQUESTED" }, take: opts.max ?? 10, select: { id: true } });
  for (const r of rows) {
    await prisma.programSessionRequest.update({
      where: { id: r.id },
      data: { bookingState: "RECONCILE", attempts: { increment: 1 }, lastError: "Aryeo appointment-create is not verified in this build — booked by the desk, confirmed by reconcile", lastErrorAt: now },
    });
  }
  await recordAutomationRun("session_booking", rows.length ? "provider booking not available: requests handed to the desk" : null);
  return { handled: rows.length };
}

export type SessionRequestView = {
  id: string; status: string; kind: string; slotStart: Date | null; slotEnd: Date | null; timezone: string | null; locationText: string | null;
  projectId: string | null; aryeoAppointmentId: string | null; confirmedAt: Date | null; cancelledAt: Date | null; cancelReason: string | null; createdAt: Date;
  /** What the portal shows: "Requested, awaiting confirmation" until Aryeo says otherwise. */
  label: string;
};
export function sessionRequestLabel(status: string): string {
  switch (status) {
    case "REQUESTED": return "Requested, awaiting confirmation";
    case "CONFIRMED": return "Booked";
    case "RESCHEDULE_REQUESTED": return "Reschedule requested";
    case "CANCEL_REQUESTED": return "Cancellation requested";
    case "CANCELLED": return "Cancelled";
    case "DECLINED": return "Not available";
    case "EXPIRED": return "Expired";
    default: return status;
  }
}
export async function listSessionRequests(enrollmentId: string, monthId?: string): Promise<SessionRequestView[]> {
  const rows = await prisma.programSessionRequest.findMany({ where: { enrollmentId, ...(monthId ? { monthId } : {}) }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id, status: r.status, kind: r.kind, slotStart: r.slotStart, slotEnd: r.slotEnd, timezone: r.timezone, locationText: r.locationText,
    projectId: r.projectId, aryeoAppointmentId: r.aryeoAppointmentId, confirmedAt: r.confirmedAt, cancelledAt: r.cancelledAt, cancelReason: r.cancelReason, createdAt: r.createdAt,
    label: sessionRequestLabel(r.status),
  }));
}
