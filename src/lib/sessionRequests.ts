import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { isAutomationEnabled, recordAutomationRun } from "@/lib/programAutomation";
import { recalcProgramMonth } from "@/lib/programMonths";
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

export type CapacityCheck = { allowed: number; used: number; extrasApproved: number; remaining: number; sessionHours: number };

export type CreateSessionRequestResult =
  | { ok: true; id: string; status: string; duplicate: boolean; capacity: CapacityCheck; message: string }
  | { ok: false; reason: string; capacity?: CapacityCheck };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const TASK_PREFIX = "content-session-request-";

/** Sessions used vs allowed for a month. Confirmed requests + attached projects, deduplicated by project. */
export async function sessionCapacity(enrollmentId: string, monthId: string): Promise<CapacityCheck> {
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, sessionsPerMonth: true, sessionHours: true } });
  const [projects, requests] = await Promise.all([
    // Only THIS client's filmed sessions use up the allowance. A job mis-attached to another client's month is hidden
    // by the portal and must not block a booking here, and a job with no shoot date (an editing-only or review job)
    // was never a filming session. Found by W1-A's fixer: synthetic review cuts were filling September's capacity.
    prisma.project.findMany({
      where: { contentMonthId: monthId, status: { not: "CANCELLED" }, shootDate: { not: null }, ...(enrollment ? { clientId: enrollment.clientId } : {}) },
      select: { id: true },
    }),
    prisma.programSessionRequest.findMany({ where: { enrollmentId, monthId, status: { in: ["CONFIRMED", "REQUESTED"] } }, select: { id: true, projectId: true, kind: true, extraApprovedBy: true, status: true } }),
  ]);
  const projectIds = new Set(projects.map((p) => p.id));
  // A confirmed request whose project is already attached counts once.
  const pending = requests.filter((r) => !(r.projectId && projectIds.has(r.projectId)));
  const extrasApproved = requests.filter((r) => r.kind === "EXTRA_SESSION" && r.extraApprovedBy).length;
  const allowed = (enrollment?.sessionsPerMonth ?? 1) + extrasApproved;
  const used = projectIds.size + pending.length;
  return { allowed, used, extrasApproved, remaining: Math.max(0, allowed - used), sessionHours: enrollment?.sessionHours ?? 2 };
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
  const capacity = await sessionCapacity(enrollment.id, month.id);
  // The duplicate check comes BEFORE the capacity check: a second click on
  // the same slot is the same request (the row it already made fills the
  // month's one slot), not "over capacity".
  const dedupeKey = `${enrollment.id}:${month.id}:${start ? start.toISOString() : "flex"}`;
  const existing = await prisma.programSessionRequest.findUnique({ where: { dedupeKey }, select: { id: true, status: true } });
  if (existing && !["CANCELLED", "DECLINED", "EXPIRED"].includes(existing.status)) {
    return { ok: true, id: existing.id, status: existing.status, duplicate: true, capacity, message: "We already have this request — it shows as requested until we confirm it." };
  }
  if (kind === "CONTENT_SESSION" && capacity.remaining <= 0) {
    return { ok: false, reason: `This month's ${capacity.allowed} session${capacity.allowed === 1 ? " is" : "s are"} already booked or requested — ask us about an extra session.`, capacity };
  }
  const bookingOn = await isAutomationEnabled("session_booking");
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
    ? await prisma.programSessionRequest.update({ where: { id: existing.id }, data: { ...data, cancelledAt: null, cancelledBy: null, cancelReason: null, confirmedAt: null, confirmedBy: null }, select: { id: true } })
    : await prisma.programSessionRequest.create({ data, select: { id: true } });
  if (input.supersedesId) {
    await prisma.programSessionRequest.updateMany({ where: { id: input.supersedesId, status: { in: ["REQUESTED", "CONFIRMED"] } }, data: { status: "RESCHEDULE_REQUESTED" } });
  }
  await ensureDeskTask(row.id);
  await recalcProgramMonth(month.id);
  return { ok: true, id: row.id, status: "REQUESTED", duplicate: false, capacity, message: "Requested — it stays “awaiting confirmation” until it's booked in Aryeo, then the date shows here." };
}

/** Kyle's desk row for one request — the ask with the exact slot; closed when the request settles. */
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
  const description = [
    `Content session request for ${month?.monthKey ?? "their month"} (${r.kind === "EXTRA_SESSION" ? "EXTRA session" : "package session"}).`,
    `Time: ${when}`,
    r.locationText ? `Filming location: ${r.locationText}` : null,
    r.notes ? r.notes : null,
    "",
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
      taskType: "todo", title: `Book content session — ${client?.name ?? "client"}`,
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
    data: { status: "CONFIRMED", projectId: link.projectId ?? undefined, aryeoAppointmentId: link.aryeoAppointmentId ?? undefined, confirmedAt: new Date(), confirmedBy: by, bookingState: "SUCCEEDED" },
  });
  await closeDeskTask(requestId, "COMPLETED");
  await recalcProgramMonth(r.monthId);
}

/**
 * Hourly reconcile against Aryeo (through the Appointment/Project rows the
 * appointments sync already maintains — no new Aryeo calls):
 *   REQUESTED + an appointment for this client inside ±2h of the slot (or any
 *   in the month for a flex request) → CONFIRMED with the appointment id;
 *   CONFIRMED whose appointment was cancelled in Aryeo → CANCELLED;
 *   REQUESTED whose slot passed 2 days ago with nothing booked → EXPIRED.
 */
export async function reconcileSessionRequests(opts: { now?: Date } = {}): Promise<{ checked: number; confirmed: number; cancelled: number; expired: number }> {
  const now = opts.now ?? new Date();
  const open = await prisma.programSessionRequest.findMany({ where: { status: { in: ["REQUESTED", "CONFIRMED", "CANCEL_REQUESTED"] } } });
  let confirmed = 0, cancelled = 0, expired = 0;
  const touched = new Set<string>();
  for (const r of open) {
    if (r.status === "REQUESTED") {
      const month = await prisma.contentMonth.findUnique({ where: { id: r.monthId }, select: { monthKey: true } });
      const appts = await prisma.appointment.findMany({
        where: { project: { clientId: r.clientId, status: { not: "CANCELLED" } }, status: { not: "CANCELED" }, startAt: { not: null } },
        select: { id: true, aryeoId: true, startAt: true, projectId: true, project: { select: { contentMonthId: true, shootDate: true } } },
        orderBy: { startAt: "asc" },
      });
      const hit = appts.find((a) => {
        if (!a.startAt) return false;
        if (r.slotStart) return Math.abs(a.startAt.getTime() - r.slotStart.getTime()) <= 2 * 3600_000;
        // Flex request: any appointment inside the requested program month.
        return a.project.contentMonthId === r.monthId || (!!month && etMonthKey(a.startAt) === month.monthKey && a.startAt > r.createdAt);
      });
      if (hit) {
        await prisma.programSessionRequest.update({ where: { id: r.id }, data: { status: "CONFIRMED", projectId: hit.projectId, aryeoAppointmentId: hit.aryeoId, confirmedAt: now, confirmedBy: "aryeo-reconcile", bookingState: r.bookingState === "NONE" ? "NONE" : "SUCCEEDED" } });
        await closeDeskTask(r.id, "COMPLETED");
        confirmed++; touched.add(r.monthId);
        continue;
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
        await prisma.programSessionRequest.update({ where: { id: r.id }, data: { status: "CANCELLED", cancelledAt: r.cancelledAt ?? now, cancelledBy: r.cancelledBy ?? "aryeo-reconcile", cancelReason: r.cancelReason ?? "appointment cancelled in Aryeo" } });
        await closeDeskTask(r.id, "COMPLETED");
        cancelled++; touched.add(r.monthId);
      }
    }
  }
  for (const m of touched) await recalcProgramMonth(m, { now });
  return { checked: open.length, confirmed, cancelled, expired };
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
