import "server-only";
import { prisma } from "@/lib/prisma";
import type { ProgramBookingAttempt, ProgramSessionRequest } from "@prisma/client";
import {
  AryeoBooking, AryeoError, bookableProviderIdsFor, classifyAryeoWriteError, hubWritePermit, teamMemberIdByUserId,
  type AryeoBookedAppointment, type HubWritePermit,
} from "@/lib/integrations/aryeo";
import { automationConfig, recordAutomationRun } from "@/lib/programAutomation";
import { aryeoProductFor, type AryeoContentProduct } from "@/lib/contentProgram";
import { URGENT_CONTACT } from "@/lib/reviewWindows";
import { etDayKey } from "@/lib/datetime";
import { isWeekendET } from "@/lib/portal";
import { parseFreeAddress } from "@/lib/sessionAddress";
import { closeDeskTask, closeSuperseded, createSessionRequest, handToDesk } from "@/lib/sessionRequests";
import { recalcProgramMonth } from "@/lib/programMonths";

// ---------------------------------------------------------------------------
// THE BOOKING ADAPTER (CP-04, Sep 24 2026).
//
// A client's session request used to end at Kyle's desk: `driveSessionBookings`
// turned every queued request into RECONCILE with the sentence "Aryeo
// appointment-create is not verified" and made no call. This is the adapter
// that was missing, built from the documented API (the Phase 0 docs in the
// scratchpad) and exercised against a local fake. It has never written to the
// real Aryeo, and it cannot until Jordan's supervised test: every write goes
// through hubWritePermit (integrations/aryeo.ts), which needs `session_booking`
// ON *and* the client listed in its authorizedFixtureClientIds *and* a TEST
// client. Today the switch has no row, so nothing below reaches a socket.
//
// THE PATH: POST /addresses → POST /orders → POST /appointments/store → GET the
// appointment back. One Aryeo order per session (Jordan, Sep 24: Pro is the
// existing four-hour product booked TWICE, one order per session), so each
// session owns its own Address and CP-05 can give each its own exact address.
//
// WHAT MAKES IT SAFE TO RUN TWICE, and what makes a timeout survivable:
//
//   · A ProgramBookingAttempt row is written BEFORE any provider call, carrying
//     a marker `hub-session:<requestId>:<n>` that goes into the order's team-only
//     internal notes. A POST /orders that timed out after Aryeo committed is
//     found again by that marker, never booked a second time.
//   · Every state is on the row. A crash anywhere leaves a state the next tick
//     resumes from; nothing lives only in memory.
//   · Leases, not locks: no transaction is ever held open across an HTTP call.
//   · UNKNOWN is a state, not an error. It is settled by a READ (the marker scan,
//     the order's appointments, the appointment itself), never by writing again
//     on a hunch. If the reads cannot settle it, Kyle gets a RECOVER task and
//     the hub waits — a person decides, then "Retry" opens attempt n+1.
//   · CONFIRMED only after the appointment is read BACK and matches: our order,
//     our start and end to the minute, SCHEDULED, and our creative on it.
//
// Nothing here messages a client. Aryeo's own notifications go to our team
// only (customer notifications off by construction); the client sees the
// state in the portal.
// ---------------------------------------------------------------------------

/** Kyle's line for anything inside 24 hours (Jordan, Sep 24 2026). */
export const KYLE_SCHEDULING_PHONE = { display: URGENT_CONTACT, e164: "+12156454889" } as const;

/** Client-safe, Jordan's voice: no em dashes, and it says the way forward. */
export const INSIDE_24H_MESSAGE = `That is less than 24 hours away, so it needs a person. Call or text Kyle at ${URGENT_CONTACT} and he will sort it out with you.`;

/** Inside 24 ELAPSED hours of the slot (not office hours — Jordan's rule is a phone call either way). */
export function within24hElapsed(slotStart: Date, now: Date): boolean {
  return slotStart.getTime() - now.getTime() < 24 * 3_600_000;
}

export const BOOKING_DEFAULTS = {
  /** The disposable TEST fixtures Jordan has authorised for a real write. Empty = none. */
  authorizedFixtureClientIds: [] as string[],
  /** Aryeo's appointment notice to OUR team. Customer notices are always off. */
  notifyCompany: true,
  /** A slot taken between the pick and the booking: tell Kyle too (default: the portal re-offers). */
  deskOnConflict: false,
  maxPerRun: 3,
};
export type BookingConfig = typeof BOOKING_DEFAULTS;

/** States in which a provider booking may be half-made. Nothing infers or expires these. */
export const IN_FLIGHT_STATES = ["RUNNING", "ORDER_CREATED", "APPT_PENDING", "UNKNOWN"] as const;
/** What the driver picks up. */
const DRIVABLE = ["QUEUED", "RUNNING", "ORDER_CREATED", "APPT_PENDING", "UNKNOWN"];
const SETTLED_ATTEMPT = ["CONFIRMED", "REJECTED", "CONFLICT", "MISMATCH", "ABANDONED"];
const LEASE_MS = 5 * 60_000;
const RECHECK_MS = 10 * 60_000;

export const bookingMarker = (requestId: string, n: number) => `hub-session:${requestId}:${n}`;
const changeMarker = (requestId: string, kind: "CANCEL" | "RESCHEDULE", n: number) => `hub-session:${requestId}:${kind === "CANCEL" ? "c" : "r"}${n}`;

// ---- pure: the decisions a drill can read without a database -------------------------

/** An order carrying this request's marker. `exact` = this attempt's own marker only. */
export function findMarkedOrder<T extends { id?: string; internal_notes?: string | null }>(orders: T[], requestId: string, exactMarker?: string | null): T | null {
  const prefix = `hub-session:${requestId}:`;
  for (const o of orders) {
    const notes = o.internal_notes ?? "";
    if (exactMarker ? notes.includes(exactMarker) : notes.includes(prefix)) return o;
  }
  return null;
}

const sameMinute = (iso: string | null | undefined, at: Date) => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && Math.floor(t / 60_000) === Math.floor(at.getTime() / 60_000);
};

/**
 * THE READBACK RULE. A booking is confirmed only when Aryeo's own copy of the
 * appointment is ours, at our times, scheduled, with our creative on it. Any
 * one of those missing is a MISMATCH for Kyle — never a confirmation.
 */
export function verifyReadback(
  expected: { orderId: string; start: Date; end: Date; creativeTeamMemberId: string; creativeUserId: string | null },
  appt: Pick<AryeoBookedAppointment, "id" | "status" | "start_at" | "end_at" | "orderId" | "userIds" | "teamMemberIds">,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (appt.orderId !== expected.orderId) problems.push(`the appointment is on order ${appt.orderId ?? "(none)"}, not ours (${expected.orderId})`);
  if (!sameMinute(appt.start_at, expected.start)) problems.push(`it starts ${appt.start_at ?? "(no time)"}, not ${expected.start.toISOString()}`);
  if (!sameMinute(appt.end_at, expected.end)) problems.push(`it ends ${appt.end_at ?? "(no time)"}, not ${expected.end.toISOString()}`);
  if ((appt.status ?? "").toUpperCase() !== "SCHEDULED") problems.push(`its status is ${appt.status ?? "(none)"}, not SCHEDULED`);
  const onIt = appt.teamMemberIds.includes(expected.creativeTeamMemberId) || (!!expected.creativeUserId && appt.userIds.includes(expected.creativeUserId));
  if (!onIt) problems.push("the chosen creative is not on it");
  return { ok: problems.length === 0, problems };
}

// ---- the context one booking needs ---------------------------------------------------

type Ctx = {
  r: ProgramSessionRequest;
  client: { id: string; name: string; aryeoCustomerId: string | null };
  enrollment: { id: string; status: string; package: string };
  month: { id: string; monthKey: string; historical: boolean } | null;
  product: AryeoContentProduct | null;
  cfg: BookingConfig;
  now: Date;
  worker: string;
  deadline: number;
};

export type BookOutcome = {
  requestId: string;
  outcome: "confirmed" | "busy" | "desk" | "conflict" | "unknown" | "rejected" | "mismatch" | "pending" | "retry" | "skipped";
  detail: string;
};

const out = (requestId: string, outcome: BookOutcome["outcome"], detail: string): BookOutcome => ({ requestId, outcome, detail });

async function setRequest(id: string, data: Parameters<typeof prisma.programSessionRequest.update>[0]["data"]) {
  return prisma.programSessionRequest.update({ where: { id }, data });
}
async function setAttempt(id: string, data: Parameters<typeof prisma.programBookingAttempt.update>[0]["data"]) {
  return prisma.programBookingAttempt.update({ where: { id }, data });
}

/** Still the client's live ask? Re-read before every write: a cancel or a staff
 *  confirm made while we were mid-booking must stop us. */
async function stillMine(id: string, worker: string): Promise<boolean> {
  const r = await prisma.programSessionRequest.findUnique({ where: { id }, select: { status: true, leaseBy: true } });
  return !!r && r.status === "REQUESTED" && r.leaseBy === worker;
}

async function permitFor(ctx: Ctx, operation: string): Promise<{ ok: true; permit: HubWritePermit } | { ok: false; reason: string }> {
  return hubWritePermit({ switchKey: "session_booking", client: { id: ctx.client.id, name: ctx.client.name }, operation });
}

async function toDesk(ctx: Ctx, bookingState: string, mode: "BOOK" | "RECOVER" | "FIX", reason: string, outcome: BookOutcome["outcome"] = "desk"): Promise<BookOutcome> {
  await setRequest(ctx.r.id, { bookingState, lastError: reason.slice(0, 1000), lastErrorAt: ctx.now, nextAttemptAt: null });
  await handToDesk(ctx.r.id, mode, reason);
  return out(ctx.r.id, outcome, reason);
}

/** The hub-side rules that must still hold at the moment of the write. The
 *  preparation window is deliberately NOT re-checked: it is evaluated at request
 *  time and nowhere else (portal/actions.ts, "HOW EXISTING BOOKINGS STAY
 *  STABLE"), so a rule change never un-books someone already through the door. */
async function guards(ctx: Ctx): Promise<string | null> {
  const { r, client, enrollment, month, product, now } = ctx;
  if (enrollment.status !== "ACTIVE") return `the program is ${enrollment.status.toLowerCase()}`;
  if (!month || month.historical) return "the month is closed";
  if (!product) return `package "${enrollment.package}" has no Aryeo product on file`;
  if (!client.aryeoCustomerId) return "the client has no Aryeo customer id, so an order cannot be made for them";
  if (!r.slotStart) return "no time was picked";
  if (isWeekendET(r.slotStart)) return "the slot is on a weekend";
  if (within24hElapsed(r.slotStart, now)) return "the slot is inside 24 hours";
  if (!r.creativeTeamMemberId) return "no creative was chosen for the slot";
  let eligible: string[];
  try {
    eligible = await bookableProviderIdsFor(product.productId);
  } catch {
    return "__RETRY__"; // could not ask Aryeo: nothing sent, try again next tick
  }
  if (!eligible.includes(r.creativeTeamMemberId)) return `${r.creativeName ?? "that creative"} is not assigned to ${product.title} in Aryeo any more`;
  const end = new Date(r.slotStart.getTime() + product.durationMinutes * 60_000);
  const clash = await prisma.programSessionRequest.findFirst({
    where: {
      id: { not: r.id }, creativeTeamMemberId: r.creativeTeamMemberId, status: { in: ["REQUESTED", "CONFIRMED"] },
      bookingState: { in: [...IN_FLIGHT_STATES, "SUCCEEDED"] },
      slotStart: { lt: end }, slotEnd: { gt: r.slotStart },
    },
    select: { id: true },
  });
  if (clash) return `the hub is already booking ${r.creativeName ?? "that creative"} at an overlapping time (request ${clash.id})`;
  return null;
}

async function loadCtx(r: ProgramSessionRequest, now: Date, worker: string, deadline: number, cfg: BookingConfig): Promise<Ctx | null> {
  const [client, enrollment, month] = await Promise.all([
    prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true, aryeoCustomerId: true } }),
    prisma.contentEnrollment.findUnique({ where: { id: r.enrollmentId }, select: { id: true, status: true, package: true } }),
    prisma.contentMonth.findUnique({ where: { id: r.monthId }, select: { id: true, monthKey: true, historical: true } }),
  ]);
  if (!client || !enrollment) return null;
  return { r, client, enrollment, month, product: aryeoProductFor(enrollment.package), cfg, now, worker, deadline };
}

const budgetLeft = (ctx: Ctx) => ctx.deadline - Date.now();

// ---- THE DRIVE ---------------------------------------------------------------------

/**
 * Book one request, or move it one safe step further. Idempotent: two callers
 * racing (the portal's inline call and the cron) resolve on the lease, and a
 * row half-way through resumes where it stopped.
 */
export async function bookSessionRequest(requestId: string, opts: { now?: Date; worker?: string; budgetMs?: number; cfg?: BookingConfig } = {}): Promise<BookOutcome> {
  const now = opts.now ?? new Date();
  const worker = `${opts.worker ?? "booking"}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  const cfg = opts.cfg ?? (await automationConfig<BookingConfig>("session_booking", BOOKING_DEFAULTS));
  if (!cfg) return out(requestId, "skipped", "session_booking is off");
  const claimed = await prisma.programSessionRequest.updateMany({
    where: {
      id: requestId, status: "REQUESTED", bookingState: { in: DRIVABLE },
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      ],
    },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseBy: worker },
  });
  if (claimed.count === 0) return out(requestId, "busy", "not due, already settled, or another worker holds it");
  try {
    const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId } });
    if (!r) return out(requestId, "skipped", "request vanished");
    const ctx = await loadCtx(r, now, worker, Date.now() + (opts.budgetMs ?? 60_000), cfg);
    if (!ctx) return out(requestId, "skipped", "client or enrollment missing");
    return await drive(ctx);
  } finally {
    await prisma.programSessionRequest.updateMany({ where: { id: requestId, leaseBy: worker }, data: { leaseUntil: null, leaseBy: null } });
  }
}

async function drive(ctx: Ctx): Promise<BookOutcome> {
  const { r } = ctx;
  let attempt = r.currentAttemptId ? await prisma.programBookingAttempt.findUnique({ where: { id: r.currentAttemptId } }) : null;
  if (attempt && SETTLED_ATTEMPT.includes(attempt.state)) attempt = null;

  // Resuming a half-made booking: the order may already exist, so the next
  // step is a READ, never a fresh create.
  if (attempt?.state === "ORDER_UNKNOWN" || attempt?.state === "ORDER_SENT") return recoverOrderUnknown(ctx, attempt);
  if (attempt?.state === "APPT_UNKNOWN" || attempt?.state === "APPT_SENT") return recoverAppointmentUnknown(ctx, attempt);
  if (attempt?.state === "APPT_CREATED" && attempt.aryeoAppointmentId) return readbackAndConfirm(ctx, attempt, attempt.aryeoAppointmentId);
  if (attempt?.state === "ORDER_CREATED" && attempt.aryeoOrderId) return appointmentStep(ctx, attempt);

  // ---- a fresh (or not-yet-sent) attempt ----
  const why = await guards(ctx);
  if (why === "__RETRY__") {
    await setRequest(r.id, { nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: "could not read the product's creatives from Aryeo — nothing was sent", lastErrorAt: ctx.now });
    return out(r.id, "retry", "Aryeo unreachable before any write");
  }
  if (why) return toDesk(ctx, "RECONCILE", "BOOK", `The hub did not book this: ${why}.`);
  const gate = await permitFor(ctx, "orders.create");
  if (!gate.ok) return toDesk(ctx, "RECONCILE", "BOOK", `Desk-assisted: ${gate.reason}.`);

  if (!attempt) attempt = await openAttempt(ctx);
  // A prior attempt that got as far as an order (its appointment was refused,
  // or staff re-queued it) — that order is ours and is used, never duplicated.
  if (attempt.aryeoOrderId) return appointmentStep(ctx, attempt);

  // RECHECK (read-only): is the slot still this creative's?
  const product = ctx.product!;
  const start = r.slotStart!;
  const end = new Date(start.getTime() + product.durationMinutes * 60_000);
  let creativeUserId: string | null = null;
  let hit: { userIds: string[] | null } | undefined;
  try {
    const byUser = await teamMemberIdByUserId();
    creativeUserId = [...byUser].find(([, tm]) => tm === r.creativeTeamMemberId)?.[0] ?? null;
    const slots = await AryeoBooking.timeslotsFor({ date: etDayKey(start), durationMin: product.durationMinutes, teamMemberIds: [r.creativeTeamMemberId!] });
    hit = slots.find((s) => new Date(s.startAt).getTime() === start.getTime());
  } catch {
    await setRequest(r.id, { bookingState: "QUEUED", nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: "could not recheck the slot with Aryeo — nothing was sent", lastErrorAt: ctx.now });
    return out(r.id, "retry", "slot recheck failed before any write");
  }
  // A timeslot that lists people must list ours. One that lists nobody was
  // already filtered to this one creative by the query itself.
  const free = !!hit && (!hit.userIds || hit.userIds.length === 0 || (!!creativeUserId && hit.userIds.includes(creativeUserId)));
  if (!free) {
    await setAttempt(attempt.id, { state: "CONFLICT", settledAt: ctx.now, lastError: "the slot is no longer free for this creative", lastErrorAt: ctx.now });
    await setRequest(r.id, { bookingState: "CONFLICT", lastError: "That time was taken between the pick and the booking.", lastErrorAt: ctx.now, nextAttemptAt: null });
    if (ctx.cfg.deskOnConflict) await handToDesk(r.id, "BOOK", "The time the client picked was taken before the hub could book it. They have been asked to pick another.");
    return out(r.id, "conflict", "slot taken");
  }
  await setAttempt(attempt.id, { state: "RECHECKED", slotStart: start, slotEnd: end, creativeTeamMemberId: r.creativeTeamMemberId });

  // ADDRESS: the area the client typed, never an invented street.
  if (!attempt.aryeoAddressId) {
    const parsed = parseFreeAddress(r.locationText);
    const { geocodeAddress } = await import("@/lib/travel");
    const geo = r.locationText ? await geocodeAddress(r.locationText).catch(() => null) : null;
    if (!geo) {
      await setAttempt(attempt.id, { state: "ABANDONED", settledAt: ctx.now, lastError: "could not place the filming area on a map", lastErrorAt: ctx.now });
      return toDesk(ctx, "RECONCILE", "BOOK", `The hub could not place "${r.locationText ?? "(no location)"}" on a map, so it did not book. Book it by hand.`);
    }
    const body = {
      ...(parsed.exact ? { street_number: parsed.streetNumber, street_name: parsed.streetName, unit_number: parsed.unit } : {}),
      city: parsed.city, state_or_province: parsed.stateCode, postal_code: parsed.postalCode, country: "US",
      latitude: geo.lat, longitude: geo.lng,
    };
    if (budgetLeft(ctx) < 30_000 || !(await stillMine(r.id, ctx.worker))) return out(r.id, "pending", "stopped before the address write");
    const p = await permitFor(ctx, "addresses.create");
    if (!p.ok) return toDesk(ctx, "RECONCILE", "BOOK", `Desk-assisted: ${p.reason}.`);
    try {
      const a = await AryeoBooking.createAddress(p.permit, body);
      attempt = await setAttempt(attempt.id, { aryeoAddressId: a.id, requestJson: JSON.stringify({ address: body }) });
      await setRequest(r.id, { aryeoAddressId: a.id });
    } catch (e) {
      const kind = classifyAryeoWriteError(e);
      const msg = e instanceof Error ? e.message : String(e);
      if (kind === "REJECTED") {
        await setAttempt(attempt.id, { state: "REJECTED", settledAt: ctx.now, lastError: msg, lastErrorAt: ctx.now });
        return toDesk(ctx, "REJECTED", "BOOK", `Aryeo refused the filming address (${msg}). Nothing was booked. Book it by hand.`, "rejected");
      }
      // An Address on its own books nothing, so a maybe-created one is inert:
      // the next tick simply makes another.
      await setRequest(r.id, { bookingState: "QUEUED", nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: `address create: ${msg}`, lastErrorAt: ctx.now });
      return out(r.id, "retry", `address create ${kind.toLowerCase()}`);
    }
  }

  // ORDER: the intent row says ORDER_SENT before the call leaves.
  if (budgetLeft(ctx) < 30_000 || !(await stillMine(r.id, ctx.worker))) return out(r.id, "pending", "stopped before the order write");
  const p = await permitFor(ctx, "orders.create");
  if (!p.ok) return toDesk(ctx, "RECONCILE", "BOOK", `Desk-assisted: ${p.reason}.`);
  const notes = `${attempt.marker} · booked by the hub for ${ctx.month?.monthKey ?? "the program month"}, ${ctx.client.name}`;
  attempt = await setAttempt(attempt.id, { state: "ORDER_SENT", nextCheckAt: new Date(ctx.now.getTime() + RECHECK_MS) });
  await setRequest(r.id, { bookingState: "RUNNING" });
  try {
    const order = await AryeoBooking.createOrder(p.permit, { customer_id: ctx.client.aryeoCustomerId!, address_id: attempt.aryeoAddressId!, variantId: product.variantId, internal_notes: notes });
    attempt = await setAttempt(attempt.id, { state: "ORDER_CREATED", aryeoOrderId: order.id, responseJson: JSON.stringify({ order }), nextCheckAt: null });
    await setRequest(r.id, { aryeoOrderId: order.id, bookingState: "ORDER_CREATED", lastError: null, lastErrorAt: null });
  } catch (e) {
    const kind = classifyAryeoWriteError(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (kind === "UNKNOWN") {
      // IT MAY EXIST. Settled by the marker scan, never by sending again.
      await setAttempt(attempt.id, { state: "ORDER_UNKNOWN", lastError: msg, lastErrorAt: ctx.now, nextCheckAt: new Date(ctx.now.getTime() + RECHECK_MS) });
      await setRequest(r.id, { bookingState: "UNKNOWN", nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: `order create outcome unknown: ${msg}`, lastErrorAt: ctx.now });
      return out(r.id, "unknown", `order create: ${msg}`);
    }
    if (kind === "RETRYABLE") {
      await setAttempt(attempt.id, { state: "RECHECKED", nextCheckAt: null, lastError: msg, lastErrorAt: ctx.now });
      await setRequest(r.id, { bookingState: "QUEUED", nextAttemptAt: new Date(ctx.now.getTime() + 5 * 60_000), lastError: msg, lastErrorAt: ctx.now });
      return out(r.id, "retry", "order create rate-limited — nothing was created");
    }
    await setAttempt(attempt.id, { state: "REJECTED", settledAt: ctx.now, lastError: msg, lastErrorAt: ctx.now });
    return toDesk(ctx, "REJECTED", "BOOK", `Aryeo refused the order (${msg}). Nothing was booked. Book it by hand.`, "rejected");
  }
  return appointmentStep(ctx, attempt);
}

/** Open attempt n+1 — find-then-create on its marker. A prior attempt that made
 *  an order hands that order forward: one request, one order, ever. */
async function openAttempt(ctx: Ctx): Promise<ProgramBookingAttempt> {
  const r = ctx.r;
  const prior = await prisma.programBookingAttempt.findMany({ where: { requestId: r.id, kind: "CREATE" }, orderBy: { attemptNo: "desc" } });
  const n = (prior[0]?.attemptNo ?? 0) + 1;
  const marker = bookingMarker(r.id, n);
  // The order can also be one staff adopted by marker on Retry (it is on the
  // request, not on any attempt yet).
  const carriedOrder = prior.find((a) => a.aryeoOrderId) ?? (r.aryeoOrderId ? { aryeoOrderId: r.aryeoOrderId, aryeoAddressId: r.aryeoAddressId } : null);
  const carried = carriedOrder;
  const existing = await prisma.programBookingAttempt.findUnique({ where: { marker } });
  const row = existing ?? await prisma.programBookingAttempt.create({
    data: {
      requestId: r.id, kind: "CREATE", attemptNo: n, marker, state: carried ? "ORDER_CREATED" : "INTENT",
      creativeTeamMemberId: r.creativeTeamMemberId, slotStart: r.slotStart, slotEnd: r.slotEnd,
      aryeoAddressId: carried?.aryeoAddressId ?? null, aryeoOrderId: carried?.aryeoOrderId ?? null,
    },
  });
  await setRequest(r.id, { currentAttemptId: row.id, bookingState: carried ? "ORDER_CREATED" : "RUNNING", attempts: { increment: 1 }, lastError: null, lastErrorAt: null });
  return row;
}

async function appointmentStep(ctx: Ctx, attempt: ProgramBookingAttempt): Promise<BookOutcome> {
  const { r } = ctx;
  const product = ctx.product!;
  const start = r.slotStart!;
  const end = new Date(start.getTime() + product.durationMinutes * 60_000);
  const orderId = attempt.aryeoOrderId!;
  let order;
  try {
    order = await AryeoBooking.getOrder(orderId);
  } catch (e) {
    await setRequest(r.id, { bookingState: "ORDER_CREATED", nextAttemptAt: new Date(ctx.now.getTime() + 5 * 60_000), lastError: `order read: ${e instanceof Error ? e.message : e}`, lastErrorAt: ctx.now });
    return out(r.id, "pending", "could not read the order back yet");
  }
  // Idempotency by readback: an appointment already on OUR order at OUR start
  // is ours (Kyle's hand, or a store that timed out after committing).
  const already = (order.appointments ?? []).find((a) => (a.status ?? "").toUpperCase() !== "CANCELED" && sameMinute(a.start_at, start));
  if (already?.id) {
    await setAttempt(attempt.id, { state: "APPT_CREATED", aryeoAppointmentId: already.id });
    return readbackAndConfirm(ctx, attempt, already.id);
  }
  if (budgetLeft(ctx) < 30_000 || !(await stillMine(r.id, ctx.worker))) return out(r.id, "pending", "stopped before the appointment write");
  const p = await permitFor(ctx, "appointments.store");
  if (!p.ok) return toDesk(ctx, "RECONCILE", "FIX", `Order ${order.number ? `#${order.number}` : orderId} was created by the hub, and the appointment was not: ${p.reason}. Book the appointment on that order by hand.`);
  const itemIds = (order.items ?? []).filter((i) => !i.is_canceled).map((i) => i.id).filter((x): x is string => !!x);
  attempt = await setAttempt(attempt.id, { state: "APPT_SENT", nextCheckAt: new Date(ctx.now.getTime() + RECHECK_MS) });
  await setRequest(r.id, { bookingState: "APPT_PENDING" });
  try {
    const appt = await AryeoBooking.storeAppointment(p.permit, { order_id: orderId, start, end, teamMemberId: r.creativeTeamMemberId!, itemIds, notifyCompany: ctx.cfg.notifyCompany !== false });
    attempt = await setAttempt(attempt.id, { state: "APPT_CREATED", aryeoAppointmentId: appt.id, nextCheckAt: null });
    await setRequest(r.id, { aryeoAppointmentId: appt.id });
    return readbackAndConfirm(ctx, attempt, appt.id);
  } catch (e) {
    const kind = classifyAryeoWriteError(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (kind === "UNKNOWN") {
      await setAttempt(attempt.id, { state: "APPT_UNKNOWN", lastError: msg, lastErrorAt: ctx.now, nextCheckAt: new Date(ctx.now.getTime() + RECHECK_MS) });
      await setRequest(r.id, { bookingState: "UNKNOWN", nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: `appointment store outcome unknown: ${msg}`, lastErrorAt: ctx.now });
      return out(r.id, "unknown", `appointment store: ${msg}`);
    }
    if (kind === "RETRYABLE") {
      await setAttempt(attempt.id, { state: "ORDER_CREATED", nextCheckAt: null, lastError: msg, lastErrorAt: ctx.now });
      await setRequest(r.id, { bookingState: "ORDER_CREATED", nextAttemptAt: new Date(ctx.now.getTime() + 5 * 60_000), lastError: msg, lastErrorAt: ctx.now });
      return out(r.id, "retry", "appointment store rate-limited");
    }
    await setAttempt(attempt.id, { state: "REJECTED", settledAt: ctx.now, lastError: msg, lastErrorAt: ctx.now });
    // The order EXISTS without an appointment. Kyle books the appointment on
    // it by hand, and the reconcile confirms on the order id (PROVIDER_ORDER).
    return toDesk(ctx, "REJECTED", "FIX", `Order ${order.number ? `#${order.number}` : orderId} exists in Aryeo without an appointment: Aryeo refused the appointment (${msg}). Book the appointment on THAT order by hand; do not make a new order. The request confirms on its own once it syncs.`, "rejected");
  }
}

async function readbackAndConfirm(ctx: Ctx, attempt: ProgramBookingAttempt, appointmentId: string): Promise<BookOutcome> {
  const { r } = ctx;
  const product = ctx.product!;
  const start = r.slotStart!;
  const end = new Date(start.getTime() + product.durationMinutes * 60_000);
  let appt: AryeoBookedAppointment;
  let creativeUserId: string | null = null;
  try {
    appt = await AryeoBooking.getAppointment(appointmentId);
    const byUser = await teamMemberIdByUserId();
    creativeUserId = [...byUser].find(([, tm]) => tm === r.creativeTeamMemberId)?.[0] ?? null;
  } catch (e) {
    await setRequest(r.id, { bookingState: "APPT_PENDING", nextAttemptAt: new Date(ctx.now.getTime() + 5 * 60_000), lastError: `readback: ${e instanceof Error ? e.message : e}`, lastErrorAt: ctx.now });
    return out(r.id, "pending", "appointment made; readback not done yet");
  }
  const v = verifyReadback({ orderId: attempt.aryeoOrderId!, start, end, creativeTeamMemberId: r.creativeTeamMemberId!, creativeUserId }, appt);
  await setAttempt(attempt.id, { readbackJson: JSON.stringify({ appointment: appt.raw, problems: v.problems }).slice(0, 20_000) });
  if (!v.ok) {
    await setAttempt(attempt.id, { state: "MISMATCH", settledAt: ctx.now, lastError: v.problems.join("; "), lastErrorAt: ctx.now });
    return toDesk(ctx, "MISMATCH", "FIX", `The hub booked appointment ${appointmentId}, but Aryeo's copy does not match the request: ${v.problems.join("; ")}. Fix it in Aryeo, then confirm the request on the client file.`, "mismatch");
  }
  // Booked is booked; a clash the creative's calendar shows AFTER the store is
  // still a real booking, so it confirms — and Kyle hears about the clash.
  let doubleBooked = false;
  try { doubleBooked = await AryeoBooking.appointmentHasConflicts(appointmentId, r.creativeTeamMemberId!, product.durationMinutes); } catch { /* the check is advisory */ }
  const now = ctx.now;
  await prisma.$transaction([
    prisma.programSessionRequest.update({
      where: { id: r.id },
      data: {
        status: "CONFIRMED", bookingState: "SUCCEEDED", matchState: "PROVIDER_ID", aryeoAppointmentId: appointmentId, aryeoOrderId: attempt.aryeoOrderId,
        providerConfirmedAt: now, confirmedAt: now, confirmedBy: "hub-booking", lastError: null, lastErrorAt: null, nextAttemptAt: null,
        matchEvidenceJson: JSON.stringify({ chose: appointmentId, why: "the hub booked it and read it back", marker: attempt.marker }),
      },
    }),
    prisma.programBookingAttempt.update({ where: { id: attempt.id }, data: { state: "CONFIRMED", aryeoAppointmentId: appointmentId, settledAt: now } }),
  ]);
  if (doubleBooked) await raiseDoubleBooked(ctx, appointmentId);
  await afterConfirm(r.id, r.monthId, attempt.aryeoOrderId!);
  return out(r.id, "confirmed", `appointment ${appointmentId} on order ${attempt.aryeoOrderId}`);
}

/** Best-effort local catch-up: import the order, attach it to the month, close
 *  the desk row. The confirmation above does not depend on any of it —
 *  countDistinctSessions already counts `appt:<id>` from the request itself. */
async function afterConfirm(requestId: string, monthId: string, orderId: string): Promise<void> {
  try {
    const { syncAryeoOrders, syncAryeoAppointments } = await import("@/lib/integrations/aryeo");
    await syncAryeoOrders({ orderId }).catch(() => null);
    await syncAryeoAppointments({ orderId }).catch(() => null);
    const project = await prisma.project.findFirst({ where: { aryeoOrderId: orderId }, select: { id: true, contentMonthId: true } });
    if (project) {
      if (!project.contentMonthId) await prisma.project.update({ where: { id: project.id }, data: { contentMonthId: monthId } });
      await prisma.programSessionRequest.update({ where: { id: requestId }, data: { projectId: project.id } });
    }
  } catch { /* the hourly sync repairs it */ }
  await closeDeskTask(requestId, "COMPLETED").catch(() => {});
  // A hub-confirmed replacement closes the row it replaced — or, when that
  // row's appointment still stands beside the new one, asks Kyle to cancel it.
  await closeSuperseded(requestId).catch(() => {});
  await recalcProgramMonth(monthId).catch(() => null);
}

async function raiseDoubleBooked(ctx: Ctx, appointmentId: string): Promise<void> {
  const dedupeKey = `content-session-doublebooked-${ctx.r.id}`;
  const exists = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (exists) return;
  await prisma.smartTask.create({
    data: {
      taskType: "todo", status: "OPEN", source: "content_program", priority: "HIGH", assignedKey: "kyle", clientId: ctx.client.id, dedupeKey,
      title: `Double-booked? ${ctx.r.creativeName ?? "creative"} — ${ctx.client.name}`.slice(0, 140),
      summary: `The hub booked appointment ${appointmentId} and Aryeo now reports a conflict on that creative's calendar.`,
      description: `The booking is real and stays. Aryeo's availability check says ${ctx.r.creativeName ?? "the creative"} has something else overlapping it. Look at their day and move one of the two.`,
      reasonCreated: "Hub booking post-check (CP-04)", dueAt: new Date(ctx.now.getTime() + 4 * 3_600_000),
    },
  }).catch(() => null);
}

// ---- recovery: settle UNKNOWN by reading, never by re-sending -----------------------

async function recoverOrderUnknown(ctx: Ctx, attempt: ProgramBookingAttempt): Promise<BookOutcome> {
  const { r, now } = ctx;
  if (attempt.nextCheckAt && attempt.nextCheckAt > now) return out(r.id, "pending", "waiting for the next marker scan");
  let orders;
  try {
    orders = await AryeoBooking.recentOrders(2);
  } catch (e) {
    await setAttempt(attempt.id, { nextCheckAt: new Date(now.getTime() + RECHECK_MS), lastError: `marker scan: ${e instanceof Error ? e.message : e}`, lastErrorAt: now });
    await setRequest(r.id, { nextAttemptAt: new Date(now.getTime() + RECHECK_MS) });
    return out(r.id, "pending", "marker scan could not read Aryeo");
  }
  const hit = findMarkedOrder(orders, r.id, attempt.marker);
  if (hit?.id) {
    const found = await setAttempt(attempt.id, { state: "ORDER_CREATED", aryeoOrderId: hit.id, nextCheckAt: null, lastError: null, responseJson: JSON.stringify({ recoveredBy: "marker", order: { id: hit.id, number: hit.number ?? null } }) });
    await setRequest(r.id, { aryeoOrderId: hit.id, bookingState: "ORDER_CREATED", lastError: null, lastErrorAt: null, nextAttemptAt: null });
    return appointmentStep(ctx, found);
  }
  const scans = attempt.recoveryScans + 1;
  const oldEnough = now.getTime() - attempt.createdAt.getTime() >= 30 * 60_000;
  if (scans >= 2 && oldEnough) {
    // Two scans, half an hour on, no order carries our marker. It PROBABLY was
    // never made — but "probably" does not book a creative twice. A person
    // looks, and the Retry button opens attempt n+1 once they have.
    await setAttempt(attempt.id, { recoveryScans: scans, nextCheckAt: null, lastError: "no order carries this marker after two scans", lastErrorAt: now });
    const customerOrders = orders.filter((o) => o.customer?.id && o.customer.id === ctx.client.aryeoCustomerId).slice(0, 5).map((o) => `#${o.number ?? "?"} (${o.id})`);
    return toDesk(ctx, "RECONCILE", "RECOVER", [
      `The hub asked Aryeo for an order at ${attempt.updatedAt.toISOString()} and did not hear back.`,
      `Search Aryeo orders for the internal note "${attempt.marker}".`,
      customerOrders.length ? `This client's newest orders: ${customerOrders.join(", ")}.` : null,
      "If an order carries that note, book or confirm the appointment on it. If none does, press Retry on the client file (it asks you to confirm there is no order first).",
    ].filter(Boolean).join(" "));
  }
  await setAttempt(attempt.id, { recoveryScans: scans, nextCheckAt: new Date(Math.max(now.getTime() + RECHECK_MS, attempt.createdAt.getTime() + 35 * 60_000)) });
  await setRequest(r.id, { nextAttemptAt: new Date(Math.max(now.getTime() + RECHECK_MS, attempt.createdAt.getTime() + 35 * 60_000)) });
  return out(r.id, "pending", `marker scan ${scans}: not found yet`);
}

async function recoverAppointmentUnknown(ctx: Ctx, attempt: ProgramBookingAttempt): Promise<BookOutcome> {
  const { r, now } = ctx;
  if (attempt.nextCheckAt && attempt.nextCheckAt > now) return out(r.id, "pending", "waiting to read the order back");
  const start = r.slotStart!;
  let order;
  try {
    order = await AryeoBooking.getOrder(attempt.aryeoOrderId!);
  } catch (e) {
    await setAttempt(attempt.id, { nextCheckAt: new Date(now.getTime() + RECHECK_MS), lastError: `order readback: ${e instanceof Error ? e.message : e}`, lastErrorAt: now });
    await setRequest(r.id, { nextAttemptAt: new Date(now.getTime() + RECHECK_MS) });
    return out(r.id, "pending", "could not read the order back");
  }
  // The order is ours alone, so an appointment on it at our start is ours.
  const found = (order.appointments ?? []).find((a) => (a.status ?? "").toUpperCase() !== "CANCELED" && sameMinute(a.start_at, start));
  if (found?.id) {
    const adopted = await setAttempt(attempt.id, { state: "APPT_CREATED", aryeoAppointmentId: found.id, nextCheckAt: null, lastError: null });
    await setRequest(r.id, { aryeoAppointmentId: found.id, lastError: null, lastErrorAt: null, nextAttemptAt: null });
    return readbackAndConfirm(ctx, adopted, found.id);
  }
  if (attempt.recoveryScans >= 1) {
    await setAttempt(attempt.id, { nextCheckAt: null, lastError: "no appointment on our order after a re-store", lastErrorAt: now });
    return toDesk(ctx, "RECONCILE", "FIX", `Order ${order.number ? `#${order.number}` : attempt.aryeoOrderId} (note "${attempt.marker}") has no appointment at the requested time after two tries. Book the appointment on THAT order by hand; do not make a new order.`);
  }
  // Read back empty: the store never landed. ONE re-store, and only onto our
  // own order, which nothing else can have used.
  const reopened = await setAttempt(attempt.id, { state: "ORDER_CREATED", recoveryScans: 1, nextCheckAt: null });
  await setRequest(r.id, { bookingState: "ORDER_CREATED" });
  return appointmentStep(ctx, reopened);
}

// ---- cancel and reschedule a session the hub booked ---------------------------------

/** A session the hub itself booked (and read back) — the only ones it may move or cancel. */
export async function hubBookedAttempt(r: Pick<ProgramSessionRequest, "id" | "aryeoAppointmentId">): Promise<ProgramBookingAttempt | null> {
  if (!r.aryeoAppointmentId) return null;
  return prisma.programBookingAttempt.findFirst({ where: { requestId: r.id, kind: "CREATE", state: "CONFIRMED", aryeoAppointmentId: r.aryeoAppointmentId } });
}

type PendingChange = { kind: "CANCEL" | "RESCHEDULE"; attemptId: string; newStart?: string; newEnd?: string; by: string | null; reason?: string | null };
const readChange = (json: string | null): PendingChange | null => { try { return json ? (JSON.parse(json) as PendingChange) : null; } catch { return null; } };

async function openChangeAttempt(r: ProgramSessionRequest, kind: "CANCEL" | "RESCHEDULE", slot?: { start: Date; end: Date }): Promise<ProgramBookingAttempt> {
  const prior = await prisma.programBookingAttempt.findFirst({ where: { requestId: r.id, kind }, orderBy: { attemptNo: "desc" }, select: { attemptNo: true } });
  const n = (prior?.attemptNo ?? 0) + 1;
  const marker = changeMarker(r.id, kind, n);
  return (await prisma.programBookingAttempt.findUnique({ where: { marker } })) ?? prisma.programBookingAttempt.create({
    data: { requestId: r.id, kind, attemptNo: n, marker, state: "INTENT", aryeoAppointmentId: r.aryeoAppointmentId, aryeoOrderId: r.aryeoOrderId, creativeTeamMemberId: r.creativeTeamMemberId, slotStart: slot?.start ?? r.slotStart, slotEnd: slot?.end ?? r.slotEnd },
  });
}

export type ChangeOutcome = { ok: boolean; state: "DONE" | "PENDING" | "DESK" | "REFUSED"; message: string };

/**
 * Cancel a session the hub booked. The PUT carries `notify: false` (the
 * documented key, which the staff wrapper also sends since Sep 24 2026),
 * then the appointment is READ BACK: CANCELED is the only proof. A timeout is
 * settled by the next tick's readback; a second PUT happens only if that
 * readback shows it still scheduled.
 */
export async function cancelHubBooking(requestId: string, opts: { by: string | null; reason?: string | null; now?: Date }): Promise<ChangeOutcome> {
  const now = opts.now ?? new Date();
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId } });
  if (!r || !r.aryeoAppointmentId) return { ok: false, state: "REFUSED", message: "That session is not one the hub booked." };
  const client = await prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true } });
  const gate = await hubWritePermit({ switchKey: "session_booking", client: client ? { id: client.id, name: client.name } : null, operation: "appointments.cancel" });
  if (!gate.ok) return { ok: false, state: "REFUSED", message: gate.reason };
  const attempt = await openChangeAttempt(r, "CANCEL");
  await setRequest(r.id, { status: "CANCEL_REQUESTED", cancelledAt: now, cancelledBy: opts.by, cancelReason: opts.reason?.trim() || null, pendingChangeJson: JSON.stringify({ kind: "CANCEL", attemptId: attempt.id, by: opts.by, reason: opts.reason ?? null } satisfies PendingChange) });
  return sendCancel(r, attempt, gate.permit, now);
}

async function sendCancel(r: ProgramSessionRequest, attempt: ProgramBookingAttempt, permit: HubWritePermit, now: Date): Promise<ChangeOutcome> {
  await setAttempt(attempt.id, { state: "APPT_SENT", nextCheckAt: new Date(now.getTime() + RECHECK_MS) });
  try {
    await AryeoBooking.cancelAppointment(permit, r.aryeoAppointmentId!);
  } catch (e) {
    const kind = classifyAryeoWriteError(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (kind === "REJECTED") {
      await setAttempt(attempt.id, { state: "REJECTED", settledAt: now, lastError: msg, lastErrorAt: now });
      await setRequest(r.id, { pendingChangeJson: null, lastError: `cancel refused: ${msg}`, lastErrorAt: now });
      await handToDesk(r.id, "CANCEL", `Aryeo refused the hub's cancellation (${msg}). Cancel appointment ${r.aryeoAppointmentId} by hand.`);
      return { ok: true, state: "DESK", message: "Cancellation requested. Kyle will take it off the calendar and confirm." };
    }
    await setAttempt(attempt.id, { state: "APPT_UNKNOWN", lastError: msg, lastErrorAt: now });
    return { ok: true, state: "PENDING", message: "Cancelling. It will show as cancelled once the calendar confirms." };
  }
  return settleCancel(r, attempt, now);
}

async function settleCancel(r: ProgramSessionRequest, attempt: ProgramBookingAttempt, now: Date): Promise<ChangeOutcome> {
  let appt: AryeoBookedAppointment;
  try { appt = await AryeoBooking.getAppointment(r.aryeoAppointmentId!); } catch {
    await setAttempt(attempt.id, { state: "APPT_UNKNOWN", nextCheckAt: new Date(now.getTime() + RECHECK_MS) });
    return { ok: true, state: "PENDING", message: "Cancelling. It will show as cancelled once the calendar confirms." };
  }
  await setAttempt(attempt.id, { readbackJson: JSON.stringify(appt.raw).slice(0, 20_000) });
  if ((appt.status ?? "").toUpperCase() !== "CANCELED") return { ok: false, state: "PENDING", message: "not cancelled yet" };
  // confirmedAt is kept: programReminders' sessionLostAt reads the cancel stamp
  // and re-opens BOOK_SESSION exactly as it does for a cancelled appointment.
  const change = readChange(r.pendingChangeJson);
  await prisma.$transaction([
    prisma.programSessionRequest.update({ where: { id: r.id }, data: { status: "CANCELLED", pendingChangeJson: null, cancelledAt: r.cancelledAt ?? now, cancelledBy: r.cancelledBy ?? change?.by ?? null, cancelReason: r.cancelReason ?? change?.reason ?? "cancelled by the hub" } }),
    prisma.programBookingAttempt.update({ where: { id: attempt.id }, data: { state: "CONFIRMED", settledAt: now } }),
    // Aryeo just said CANCELED: the local copy follows now rather than at the
    // next sync, so the month counts the session as gone at once (and the
    // reminders re-open the ask) instead of an hour later.
    prisma.appointment.updateMany({ where: { aryeoId: r.aryeoAppointmentId! }, data: { status: "CANCELED", canCancel: false, canReschedule: false } }),
  ]);
  // …and the job's future shoot date goes with it when nothing live is left —
  // the appointment sync's own rule ("a future shootDate no live appointment
  // explains is cleared"), applied now so the session stops counting at once.
  const local = await prisma.appointment.findUnique({ where: { aryeoId: r.aryeoAppointmentId! }, select: { projectId: true } });
  if (local) {
    const live = await prisma.appointment.count({ where: { projectId: local.projectId, aryeoId: { not: r.aryeoAppointmentId! }, status: { not: "CANCELED" }, startAt: { gt: now } } });
    if (!live) await prisma.project.updateMany({ where: { id: local.projectId, shootDate: { gt: now } }, data: { shootDate: null } });
  }
  await closeDeskTask(r.id, "COMPLETED").catch(() => {});
  await recalcProgramMonth(r.monthId).catch(() => null);
  return { ok: true, state: "DONE", message: "Cancelled. The session is off the calendar." };
}

/**
 * Move a session the hub booked. Same shape as cancel: PUT, then read back —
 * the new start is the only proof. The request keeps its appointment id and
 * stays CONFIRMED; its slot and dedupe identity move with it.
 */
export async function rescheduleHubBooking(requestId: string, newStart: Date, opts: { by: string | null; now?: Date }): Promise<ChangeOutcome> {
  const now = opts.now ?? new Date();
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId } });
  if (!r || !r.aryeoAppointmentId) return { ok: false, state: "REFUSED", message: "That session is not one the hub booked." };
  const [client, enrollment] = await Promise.all([
    prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true } }),
    prisma.contentEnrollment.findUnique({ where: { id: r.enrollmentId }, select: { package: true } }),
  ]);
  const product = aryeoProductFor(enrollment?.package);
  if (!product) return { ok: false, state: "REFUSED", message: "No Aryeo product on file for this package." };
  const newEnd = new Date(newStart.getTime() + product.durationMinutes * 60_000);
  const gate = await hubWritePermit({ switchKey: "session_booking", client: client ? { id: client.id, name: client.name } : null, operation: "appointments.reschedule" });
  if (!gate.ok) return { ok: false, state: "REFUSED", message: gate.reason };
  const attempt = await openChangeAttempt(r, "RESCHEDULE", { start: newStart, end: newEnd });
  await setRequest(r.id, { pendingChangeJson: JSON.stringify({ kind: "RESCHEDULE", attemptId: attempt.id, newStart: newStart.toISOString(), newEnd: newEnd.toISOString(), by: opts.by } satisfies PendingChange) });
  return sendReschedule(r, attempt, gate.permit, newStart, newEnd, now);
}

async function sendReschedule(r: ProgramSessionRequest, attempt: ProgramBookingAttempt, permit: HubWritePermit, start: Date, end: Date, now: Date): Promise<ChangeOutcome> {
  await setAttempt(attempt.id, { state: "APPT_SENT", nextCheckAt: new Date(now.getTime() + RECHECK_MS) });
  try {
    await AryeoBooking.rescheduleAppointment(permit, r.aryeoAppointmentId!, start, end);
  } catch (e) {
    const kind = classifyAryeoWriteError(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (kind === "REJECTED") {
      await setAttempt(attempt.id, { state: "REJECTED", settledAt: now, lastError: msg, lastErrorAt: now });
      await setRequest(r.id, { pendingChangeJson: null, lastError: `reschedule refused: ${msg}`, lastErrorAt: now });
      await handToDesk(r.id, "RESCHEDULE", `Aryeo refused the hub's move to ${start.toISOString()} (${msg}). The session is still at its old time. Move appointment ${r.aryeoAppointmentId} by hand if the new time works.`);
      return { ok: true, state: "DESK", message: "We have your new time. Kyle will move the session and confirm." };
    }
    await setAttempt(attempt.id, { state: "APPT_UNKNOWN", lastError: msg, lastErrorAt: now });
    return { ok: true, state: "PENDING", message: "Moving your session. The new time shows once the calendar confirms." };
  }
  return settleReschedule(r, attempt, start, end, now);
}

async function settleReschedule(r: ProgramSessionRequest, attempt: ProgramBookingAttempt, start: Date, end: Date, now: Date): Promise<ChangeOutcome> {
  let appt: AryeoBookedAppointment;
  try { appt = await AryeoBooking.getAppointment(r.aryeoAppointmentId!); } catch {
    await setAttempt(attempt.id, { state: "APPT_UNKNOWN", nextCheckAt: new Date(now.getTime() + RECHECK_MS) });
    return { ok: true, state: "PENDING", message: "Moving your session. The new time shows once the calendar confirms." };
  }
  await setAttempt(attempt.id, { readbackJson: JSON.stringify(appt.raw).slice(0, 20_000) });
  if (!sameMinute(appt.start_at, start)) return { ok: false, state: "PENDING", message: "not moved yet" };
  // The dedupe identity is `enrollment:month:slot`; it moves with the slot, but
  // only when no other request already holds the new one (checked, not caught).
  const newKey = `${r.enrollmentId}:${r.monthId}:${start.toISOString()}`;
  const holder = await prisma.programSessionRequest.findUnique({ where: { dedupeKey: newKey }, select: { id: true } });
  await prisma.$transaction([
    prisma.programSessionRequest.update({ where: { id: r.id }, data: { slotStart: start, slotEnd: end, pendingChangeJson: null, providerConfirmedAt: now, ...(holder && holder.id !== r.id ? {} : { dedupeKey: newKey }) } }),
    prisma.programBookingAttempt.update({ where: { id: attempt.id }, data: { state: "CONFIRMED", settledAt: now } }),
    // The local copy follows Aryeo's answer now (the hourly sync would anyway).
    prisma.appointment.updateMany({ where: { aryeoId: r.aryeoAppointmentId! }, data: { startAt: new Date(appt.start_at!), endAt: appt.end_at ? new Date(appt.end_at) : end, rescheduledAt: now } }),
  ]);
  await recalcProgramMonth(r.monthId).catch(() => null);
  return { ok: true, state: "DONE", message: "Moved. Your session is at the new time." };
}

/** A cancel/reschedule whose PUT timed out: read back, and send once more only
 *  if the readback shows it did not happen. */
async function recoverChange(r: ProgramSessionRequest, now: Date): Promise<ChangeOutcome | null> {
  const change = readChange(r.pendingChangeJson);
  if (!change) return null;
  const attempt = await prisma.programBookingAttempt.findUnique({ where: { id: change.attemptId } });
  if (!attempt || SETTLED_ATTEMPT.includes(attempt.state)) {
    await setRequest(r.id, { pendingChangeJson: null });
    return null;
  }
  if (attempt.nextCheckAt && attempt.nextCheckAt > now) return null;
  if (change.kind === "CANCEL") {
    const settled = await settleCancel(r, attempt, now);
    if (settled.state === "DONE" || attempt.recoveryScans >= 1) {
      if (settled.state !== "DONE") {
        await setAttempt(attempt.id, { nextCheckAt: null });
        await setRequest(r.id, { pendingChangeJson: null });
        await handToDesk(r.id, "CANCEL", `The hub's cancellation of appointment ${r.aryeoAppointmentId} did not take after two tries. Cancel it by hand.`);
        return { ok: true, state: "DESK", message: "handed to Kyle" };
      }
      return settled;
    }
    const client = await prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true } });
    const gate = await hubWritePermit({ switchKey: "session_booking", client, operation: "appointments.cancel" });
    if (!gate.ok) { await setRequest(r.id, { pendingChangeJson: null }); await handToDesk(r.id, "CANCEL", `Cancel appointment ${r.aryeoAppointmentId} by hand: ${gate.reason}.`); return { ok: true, state: "DESK", message: gate.reason }; }
    await setAttempt(attempt.id, { recoveryScans: 1 });
    return sendCancel(r, { ...attempt, recoveryScans: 1 }, gate.permit, now);
  }
  const start = new Date(change.newStart ?? "");
  const end = new Date(change.newEnd ?? "");
  const settled = await settleReschedule(r, attempt, start, end, now);
  if (settled.state === "DONE") return settled;
  if (attempt.recoveryScans >= 1) {
    await setAttempt(attempt.id, { nextCheckAt: null });
    await setRequest(r.id, { pendingChangeJson: null });
    await handToDesk(r.id, "RESCHEDULE", `The hub's move of appointment ${r.aryeoAppointmentId} to ${start.toISOString()} did not take after two tries. Move it by hand.`);
    return { ok: true, state: "DESK", message: "handed to Kyle" };
  }
  const client = await prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true } });
  const gate = await hubWritePermit({ switchKey: "session_booking", client, operation: "appointments.reschedule" });
  if (!gate.ok) { await setRequest(r.id, { pendingChangeJson: null }); await handToDesk(r.id, "RESCHEDULE", `Move appointment ${r.aryeoAppointmentId} by hand: ${gate.reason}.`); return { ok: true, state: "DESK", message: gate.reason }; }
  await setAttempt(attempt.id, { recoveryScans: 1 });
  return sendReschedule(r, { ...attempt, recoveryScans: 1 }, gate.permit, start, end, now);
}

// ---- the driver ----------------------------------------------------------------------

/**
 * The cron's booking step. OFF (no row) = skipped, zero calls. ON = at most
 * `maxPerRun` requests moved one safe step each, then any half-finished
 * cancel/reschedule read back. No new write starts with under 30 s of budget.
 */
export async function driveSessionBookings(opts: { max?: number; now?: Date; budgetMs?: number } = {}): Promise<{ skipped: string; handedToDesk: number } | { handled: number; outcomes: BookOutcome[]; changes: number }> {
  const cfg = await automationConfig<BookingConfig>("session_booking", BOOKING_DEFAULTS);
  if (!cfg) return { skipped: "session_booking is off", handedToDesk: await handOverWhileOff(opts.now ?? new Date()) };
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const max = Math.max(1, Math.min(opts.max ?? cfg.maxPerRun ?? 3, 10));
  const rows = await prisma.programSessionRequest.findMany({
    where: {
      status: "REQUESTED", bookingState: { in: DRIVABLE },
      AND: [
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      ],
    },
    orderBy: { createdAt: "asc" }, take: max, select: { id: true },
  });
  const outcomes: BookOutcome[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    if (deadline - Date.now() < 30_000) break;
    try {
      outcomes.push(await bookSessionRequest(row.id, { now, worker: "cron", budgetMs: deadline - Date.now(), cfg }));
    } catch (e) {
      errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let changes = 0;
  const pending = await prisma.programSessionRequest.findMany({ where: { pendingChangeJson: { not: null }, status: { in: ["CONFIRMED", "CANCEL_REQUESTED"] } }, take: max });
  for (const r of pending) {
    if (deadline - Date.now() < 30_000) break;
    try { if (await recoverChange(r, now)) changes++; } catch (e) { errors.push(`${r.id} change: ${e instanceof Error ? e.message : String(e)}`); }
  }
  await recordAutomationRun("session_booking", errors.length ? errors.join(" | ").slice(0, 1900) : null);
  return { handled: outcomes.length, outcomes, changes };
}

/**
 * THE STOP CONTROL LEAVES NOTHING STRANDED (review, Sep 24 2026). Turning
 * `session_booking` off used to make the driver return before it read a row,
 * so a request QUEUED for the adapter (which by design has no desk task) sat on
 * "Booking your session" until the reconcile quietly EXPIRED it, and a cancel
 * or move whose PUT timed out was never read back or handed over. Now, while
 * the switch is off, every such row goes to Kyle's desk once — no provider
 * call is made, and a row a live worker still holds (its lease) is left to it:
 *   · QUEUED, never sent        → BOOK (desk-assisted from here on);
 *   · half-way through a create → RECOVER (search Aryeo for the note first);
 *   · a cancel whose outcome is unknown → CANCEL, naming the appointment;
 *   · a move whose outcome is unknown   → a desk MOVE: the booked row waits as
 *     RESCHEDULE_REQUESTED and the new time is a request that confirms once
 *     Aryeo shows the appointment there (never "Booked" on a guess).
 */
async function handOverWhileOff(now: Date): Promise<number> {
  let n = 0;
  const free = { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
  const creates = await prisma.programSessionRequest.findMany({ where: { status: "REQUESTED", bookingState: { in: DRIVABLE }, ...free }, take: 50 });
  for (const r of creates) {
    const halfMade = r.bookingState !== "QUEUED" || !!r.currentAttemptId;
    const why = halfMade
      ? `session_booking was switched off while the hub was booking this (booking state ${r.bookingState}). Search Aryeo orders for the note "hub-session:${r.id}" first; finish or book it by hand.`
      : "session_booking was switched off before the hub booked this. Book it by hand in Aryeo.";
    const moved = await prisma.programSessionRequest.updateMany({ where: { id: r.id, status: "REQUESTED", bookingState: r.bookingState, ...free }, data: { bookingState: "RECONCILE", nextAttemptAt: null, lastError: `desk-assisted: ${why}`.slice(0, 1000), lastErrorAt: now } });
    if (!moved.count) continue;
    await handToDesk(r.id, halfMade ? "RECOVER" : "BOOK", why);
    n++;
  }
  const changes = await prisma.programSessionRequest.findMany({ where: { pendingChangeJson: { not: null }, status: { in: ["CONFIRMED", "CANCEL_REQUESTED"] } }, take: 50 });
  for (const r of changes) {
    const change = readChange(r.pendingChangeJson);
    const cleared = await prisma.programSessionRequest.updateMany({ where: { id: r.id, pendingChangeJson: r.pendingChangeJson }, data: { pendingChangeJson: null } });
    if (!cleared.count) continue;
    if (change?.attemptId) await prisma.programBookingAttempt.updateMany({ where: { id: change.attemptId, state: { notIn: SETTLED_ATTEMPT } }, data: { state: "ABANDONED", settledAt: now, nextCheckAt: null, lastError: "handed to the desk: session_booking was switched off", lastErrorAt: now } });
    if (change?.kind === "RESCHEDULE" && change.newStart && r.status === "CONFIRMED") {
      const made = await createSessionRequest({
        enrollmentId: r.enrollmentId, monthId: r.monthId,
        slot: { startISO: change.newStart, endISO: change.newEnd ?? null, timezone: r.timezone, locationText: r.locationText, notes: "The hub asked Aryeo to move this and could not confirm it before session_booking was switched off." },
        actor: { kind: "STAFF", userId: null }, supersedesId: r.id,
        creative: r.creativeTeamMemberId ? { teamMemberId: r.creativeTeamMemberId, name: r.creativeName } : null,
      }).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
      if (made.ok) { n++; continue; }
      await handToDesk(r.id, "RESCHEDULE", `The hub asked Aryeo to move appointment ${r.aryeoAppointmentId} to ${change.newStart} and could not confirm it before session_booking was switched off (${made.reason}). Check where it is; the request still shows the old time.`);
      n++;
      continue;
    }
    if (change?.kind === "CANCEL" || r.status === "CANCEL_REQUESTED") {
      await handToDesk(r.id, "CANCEL", `The hub asked Aryeo to cancel appointment ${r.aryeoAppointmentId} and could not confirm it before session_booking was switched off. Check it, and cancel it by hand if it is still scheduled.`);
    } else {
      await handToDesk(r.id, "FIX", `The hub was changing appointment ${r.aryeoAppointmentId} when session_booking was switched off, and could not confirm the change. Check it in Aryeo.`);
    }
    n++;
  }
  return n;
}

/**
 * Staff "Retry" (client file). A request stuck after an UNKNOWN order must not
 * be re-booked on a guess: the person confirms there is no order carrying the
 * marker, and even then a scan runs first — any order with ANY of this
 * request's markers is adopted instead of making another.
 */
export async function retrySessionBooking(requestId: string, opts: { confirmedNoOrder: boolean; by: string; now?: Date }): Promise<{ ok: boolean; message: string }> {
  const now = opts.now ?? new Date();
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId } });
  if (!r || r.status !== "REQUESTED") return { ok: false, message: "Only an open request can be retried." };
  // Retry means "let the hub book it". With the switch off nothing would, and
  // "Queued" would be the same false promise the stop control used to leave.
  if (!(await automationConfig<BookingConfig>("session_booking", BOOKING_DEFAULTS))) {
    return { ok: false, message: "Session booking is switched off, so the hub will not book this. Book it by hand in Aryeo; the request confirms on its own when the appointment appears." };
  }
  if (!["RECONCILE", "REJECTED", "MISMATCH", "CONFLICT", "UNKNOWN", "FAILED"].includes(r.bookingState)) return { ok: false, message: `Nothing to retry (booking state ${r.bookingState}).` };
  const attempt = r.currentAttemptId ? await prisma.programBookingAttempt.findUnique({ where: { id: r.currentAttemptId } }) : null;
  const unknownOrder = attempt && (attempt.state === "ORDER_UNKNOWN" || attempt.state === "ORDER_SENT");
  if (unknownOrder && !opts.confirmedNoOrder) return { ok: false, message: `First search Aryeo orders for the note "${attempt!.marker}" and confirm no order carries it.` };
  if (r.bookingState === "MISMATCH") return { ok: false, message: "The appointment exists but does not match. Fix it in Aryeo and confirm the request instead of retrying." };
  let adopted: string | null = null;
  try {
    const hit = findMarkedOrder(await AryeoBooking.recentOrders(2), r.id);
    adopted = hit?.id ?? null;
  } catch (e) {
    if (!(e instanceof AryeoError)) throw e;
    return { ok: false, message: `Could not scan Aryeo for an existing order (${e.message}). Try again in a minute.` };
  }
  if (attempt && !SETTLED_ATTEMPT.includes(attempt.state)) {
    await setAttempt(attempt.id, adopted
      ? { state: "ORDER_CREATED", aryeoOrderId: adopted, lastError: `adopted by ${opts.by} on retry`, nextCheckAt: null }
      : { state: "ABANDONED", settledAt: now, lastError: `${opts.by} confirmed no order exists`, lastErrorAt: now });
  }
  await setRequest(r.id, adopted
    ? { bookingState: "ORDER_CREATED", aryeoOrderId: adopted, nextAttemptAt: null, lastError: null, lastErrorAt: null }
    : { bookingState: "QUEUED", currentAttemptId: attempt && !adopted && attempt.state !== "CONFIRMED" ? null : r.currentAttemptId, nextAttemptAt: null, lastError: null, lastErrorAt: null });
  return { ok: true, message: adopted ? "An order with this request's note already exists; the hub will finish the booking on it." : "Queued. The hub books it on the next run." };
}
