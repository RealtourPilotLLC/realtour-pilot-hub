import "server-only";
import { prisma } from "@/lib/prisma";
import type { ProgramBookingAttempt, ProgramSessionPlan, ProgramSessionRequest } from "@prisma/client";
import {
  AryeoBooking, AryeoError, bookableProviderIdsFor, classifyAryeoWriteError, hubWritePermit, teamMemberIdByUserId,
  type AryeoBookedAppointment, type HubWriteDecision, type HubWritePermit,
} from "@/lib/integrations/aryeo";
import { automationConfig, recordAutomationRun } from "@/lib/programAutomation";
import { aryeoProductFor, type AryeoContentProduct } from "@/lib/contentProgram";
import { URGENT_CONTACT } from "@/lib/reviewWindows";
import { etAt, etDayKey } from "@/lib/datetime";
import { isWeekendET } from "@/lib/portal";
import { planBookable, sameAddress, formatAddressLine } from "@/lib/sessionAddress";
import { capacityUnderMonthLock, closeDeskTask, closeSuperseded, createSessionRequest, handToDesk, releaseCreativeHold } from "@/lib/sessionRequests";
import { recalcProgramMonth } from "@/lib/programMonths";
import { advisoryKeyPair } from "@/lib/dbLocks";
import { TRAVEL_DEFAULTS, travelEvidence, travelFit, type TravelSource } from "@/lib/sessionTravel";

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
  /** §6.6 W02 (Jordan, Sep 25 2026): minutes kept free on top of the estimated
   *  drive between two filming addresses. Read by the slot offer even while the
   *  switch is off (sessionTravel.travelConfig), so it can be set first. */
  travelBufferMinutes: TRAVEL_DEFAULTS.travelBufferMinutes,
  /** HUB_DRIVE (OSRM estimate, the default) or ARYEO_APPOINTMENT (Aryeo's own
   *  appointment-scoped availability) — the latter only once the supervised
   *  test proves Aryeo counts drive time. */
  travelSource: TRAVEL_DEFAULTS.travelSource as TravelSource,
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

/** The order's address as a readback sees it. */
export type ReadbackOrder = { address?: { id?: string | null; street_number?: string | null; street_name?: string | null; unit_number?: string | null; postal_code?: string | null } | null };

/**
 * THE READBACK RULE. A booking is confirmed only when Aryeo's own copy of the
 * appointment is ours, at our times, scheduled, with our creative on it — and
 * (A23, Sep 25 2026) its order is at the address the hub made, the client's
 * exact street. Any one of those missing is a MISMATCH for Kyle — never a
 * confirmation.
 */
export function verifyReadback(
  expected: { orderId: string; start: Date; end: Date; creativeTeamMemberId: string; creativeUserId: string | null },
  appt: Pick<AryeoBookedAppointment, "id" | "status" | "start_at" | "end_at" | "orderId" | "userIds" | "teamMemberIds">,
  address?: { expectedAddressId: string; expected: { streetNumber: string | null; streetName: string | null; unit: string | null; postalCode: string | null } | null; order: ReadbackOrder } | null,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (appt.orderId !== expected.orderId) problems.push(`the appointment is on order ${appt.orderId ?? "(none)"}, not ours (${expected.orderId})`);
  if (!sameMinute(appt.start_at, expected.start)) problems.push(`it starts ${appt.start_at ?? "(no time)"}, not ${expected.start.toISOString()}`);
  if (!sameMinute(appt.end_at, expected.end)) problems.push(`it ends ${appt.end_at ?? "(no time)"}, not ${expected.end.toISOString()}`);
  if ((appt.status ?? "").toUpperCase() !== "SCHEDULED") problems.push(`its status is ${appt.status ?? "(none)"}, not SCHEDULED`);
  const onIt = appt.teamMemberIds.includes(expected.creativeTeamMemberId) || (!!expected.creativeUserId && appt.userIds.includes(expected.creativeUserId));
  if (!onIt) problems.push("the chosen creative is not on it");
  if (address) {
    const a = address.order.address ?? null;
    if (!a || a.id !== address.expectedAddressId) problems.push(`the order's address is ${a?.id ?? "(none)"}, not the one the hub made (${address.expectedAddressId})`);
    else if (address.expected && !sameAddress({ streetNumber: a.street_number ?? null, streetName: a.street_name ?? null, unit: a.unit_number ?? null, postalCode: a.postal_code ?? null }, address.expected)) {
      problems.push(`the order's address reads back as ${[a.street_number, a.street_name, a.postal_code].filter(Boolean).join(" ") || "(no street)"}, not the client's ${[address.expected.streetNumber, address.expected.streetName, address.expected.postalCode].filter(Boolean).join(" ")}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---- the context one booking needs ---------------------------------------------------

type Ctx = {
  r: ProgramSessionRequest;
  client: { id: string; name: string; aryeoCustomerId: string | null };
  enrollment: { id: string; status: string; package: string };
  /** §6.6 W02: the exact-address plan the slot was offered for (null on a legacy ask). */
  plan: ProgramSessionPlan | null;
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

async function permitFor(ctx: Ctx, operation: string): Promise<HubWriteDecision> {
  return hubWritePermit({ switchKey: "session_booking", client: { id: ctx.client.id, name: ctx.client.name }, operation });
}

async function toDesk(ctx: Ctx, bookingState: string, mode: "BOOK" | "RECOVER" | "FIX", reason: string, outcome: BookOutcome["outcome"] = "desk"): Promise<BookOutcome> {
  await setRequest(ctx.r.id, { bookingState, lastError: reason.slice(0, 1000), lastErrorAt: ctx.now, nextAttemptAt: null });
  // The desk has it now: the hub is no longer booking this creative's time
  // (a RECOVER keeps its hold — an order may exist and Kyle is checking).
  if (mode !== "RECOVER") await releaseCreativeHold(ctx.r.id, bookingState, ctx.now);
  await handToDesk(ctx.r.id, mode, reason);
  return out(ctx.r.id, outcome, reason);
}

/** A slot lost between the pick and the booking: nothing written, the client re-picks. */
async function conflict(ctx: Ctx, attempt: ProgramBookingAttempt, why: string, clientWords: string): Promise<BookOutcome> {
  await setAttempt(attempt.id, { state: "CONFLICT", settledAt: ctx.now, lastError: why, lastErrorAt: ctx.now });
  await setRequest(ctx.r.id, { bookingState: "CONFLICT", lastError: clientWords, lastErrorAt: ctx.now, nextAttemptAt: null });
  await releaseCreativeHold(ctx.r.id, "CONFLICT", ctx.now);
  if (ctx.cfg.deskOnConflict) await handToDesk(ctx.r.id, "BOOK", `The time the client picked was lost before the hub could book it (${why}). They have been asked to pick another.`);
  return out(ctx.r.id, "conflict", why);
}

/** R02: which scope said yes, for the attempt row. */
function scopeOf(d: { ok: true; permit: HubWritePermit } & { scope?: string }): string {
  return d.scope ?? d.permit.scope ?? "FIXTURE";
}

const nextEtDay = (d: Date): string => {
  const [y, m, dd] = etDayKey(d).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd + 1, 12)).toISOString().slice(0, 10);
};

/** Booking states in which a hold stands for a booking really in progress. */
const HOLDING = ["QUEUED", "RUNNING", "ORDER_CREATED", "APPT_PENDING", "UNKNOWN"];

/**
 * A23 — THE CREATIVE-DAY HOLD. One short transaction under
 * pg_advisory_xact_lock(fnv(creative)::int4, fnv(ET day)::int4): look for a
 * live hold overlapping this time, and for a hub request already booking or
 * booked there; if neither, write (or re-arm) this request's hold. The lock
 * serialises the check-then-write per creative per day and is released when
 * the transaction ends — no provider call ever runs inside it.
 *
 * A hold counts only while its request is still being booked by the hub, so
 * a release that was missed (a crash) can never block the day for good.
 * Released on every terminal state: CONFIRMED, CONFLICT, REJECTED, MISMATCH,
 * ABANDONED, CANCELLED, DECLINED, EXPIRED.
 */
export async function takeCreativeHold(h: {
  requestId: string; creativeTeamMemberId: string; start: Date; end: Date; state?: string;
  /** the neighbour refs the travel check just measured against (`request:<id>`, `appt:<id>`) */
  considered?: string[];
}): Promise<{ ok: true } | { ok: false; reason: string; retry?: boolean }> {
  const a = advisoryKeyPair(`creative|${h.creativeTeamMemberId}`)[0];
  const b = advisoryKeyPair(`day|${etDayKey(h.start)}`)[0];
  const now = new Date();
  // A hold is live while its request is still being booked — or, for a MOVE of
  // a booked session (state MOVING), while that move is in flight (its pending
  // change is on the row, or it was taken in the last ten minutes).
  const liveWhere = (ids: string[]) => ({
    id: { in: ids },
    OR: [
      { status: "REQUESTED", bookingState: { in: HOLDING } },
      { status: "CONFIRMED", pendingChangeJson: { not: null } },
    ],
  });
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${a}::int4, ${b}::int4)`;
    const holds = await tx.programCreativeHold.findMany({
      where: { creativeTeamMemberId: h.creativeTeamMemberId, releasedAt: null, requestId: { not: h.requestId }, startAt: { lt: h.end }, endAt: { gt: h.start } },
      select: { requestId: true, state: true, createdAt: true },
    });
    if (holds.length) {
      const freshMoves = holds.filter((x) => x.state === "MOVING" && now.getTime() - x.createdAt.getTime() < 10 * 60_000).map((x) => x.requestId);
      const live = await tx.programSessionRequest.findFirst({
        where: { OR: [liveWhere(holds.map((x) => x.requestId)), ...(freshMoves.length ? [{ id: { in: freshMoves }, status: "CONFIRMED" }] : [])] },
        select: { id: true },
      });
      if (live) return { ok: false as const, reason: `another hub booking (request ${live.id}) is booking this creative at an overlapping time` };
    }
    // A hold on the SAME DAY that the travel check did not see (it was taken
    // after that check read the day): not a conflict yet, but the drive to or
    // from it was never measured. Nothing is written; the next tick checks
    // again with it on the day.
    if (h.considered) {
      const dayHolds = await tx.programCreativeHold.findMany({
        where: { creativeTeamMemberId: h.creativeTeamMemberId, releasedAt: null, requestId: { not: h.requestId }, startAt: { lt: etAt(nextEtDay(h.start), 0) }, endAt: { gt: etAt(etDayKey(h.start), 0) } },
        select: { requestId: true },
      });
      const unseen = dayHolds.filter((x) => !h.considered!.includes(`request:${x.requestId}`));
      if (unseen.length) {
        const live = await tx.programSessionRequest.findFirst({ where: liveWhere(unseen.map((x) => x.requestId)), select: { id: true } });
        if (live) return { ok: false as const, retry: true, reason: `another hub booking for this creative that day (request ${live.id}) started while the drive was being checked` };
      }
    }
    // Booked, or past its own hold and into the provider writes. A request
    // that is merely queued or rechecking is NOT counted here: two of those
    // would each refuse the other and neither would book (its hold, once it
    // has one, is what the check above sees).
    const booked = await tx.programSessionRequest.findFirst({
      where: {
        id: { not: h.requestId }, creativeTeamMemberId: h.creativeTeamMemberId, slotStart: { lt: h.end }, slotEnd: { gt: h.start },
        OR: [{ status: "CONFIRMED" }, { status: "REQUESTED", bookingState: { in: ["ORDER_CREATED", "APPT_PENDING", "UNKNOWN"] } }],
      },
      select: { id: true },
    });
    if (booked) return { ok: false as const, reason: `the hub already has this creative at an overlapping time (request ${booked.id})` };
    await tx.programCreativeHold.upsert({
      where: { requestId: h.requestId },
      create: { requestId: h.requestId, creativeTeamMemberId: h.creativeTeamMemberId, startAt: h.start, endAt: h.end, state: h.state ?? "HELD" },
      // Re-armed (a retry, or a move of a booked session): its clock restarts.
      update: { creativeTeamMemberId: h.creativeTeamMemberId, startAt: h.start, endAt: h.end, state: h.state ?? "HELD", releasedAt: null, createdAt: now },
    });
    return { ok: true as const };
  }, { timeout: 20_000 });
}

/**
 * R03 — THE READBACK'S MONEY RULE, pure. A hub order is for a client who
 * already paid through Stripe, so Aryeo's copy must total $0 and owe $0. A
 * missing figure is not a pass. payment_status is recorded, never trusted on
 * its own (what Aryeo calls a $0 order is one of the supervised test's
 * questions).
 */
export function prepaidOrderCheck(order: { total_amount?: number | null; balance_amount?: number | null; payment_status?: string | null }): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  if (typeof order.total_amount !== "number") problems.push("Aryeo did not report the order's total");
  else if (order.total_amount !== 0) problems.push(`the order totals ${dollars(order.total_amount)}`);
  if (typeof order.balance_amount !== "number") problems.push("Aryeo did not report the order's balance");
  else if (order.balance_amount !== 0) problems.push(`it shows ${dollars(order.balance_amount)} owed`);
  return { ok: problems.length === 0, problems };
}

/** The team-only note that says why this order is $0: which Stripe purchase paid for it. */
async function prepaidProvenance(ctx: Ctx): Promise<string> {
  const signup = await prisma.programSignup.findFirst({ where: { enrollmentId: ctx.enrollment.id }, orderBy: { paidAt: "desc" }, select: { subscriptionId: true, checkoutId: true } }).catch(() => null);
  const ref = signup?.subscriptionId ?? signup?.checkoutId ?? null;
  return ref
    ? `Prepaid: Content Program ${ctx.enrollment.package} via Stripe ${ref} (no charge on this order).`
    : `Prepaid: Content Program ${ctx.enrollment.package} (no Stripe signup on file; no charge on this order).`;
}

/**
 * The hub-side rules that must still hold at the moment of the write (A23,
 * Sep 25 2026 — each one a thing that can change between the pick and the
 * booking, and each one refused rather than booked around):
 *
 *   · THE GATE, but only when its ANCHOR moved. The request snapshots the
 *     preparation gate it was offered under (gateAnchorRef: the call's end or
 *     the answers' submission). A different anchor now — the call moved or was
 *     cancelled, the answers were reopened — and a slot before the NEW earliest
 *     is refused. A rule change alone (48 → 72 hours) never refuses: the anchor
 *     is compared, not the window, so nobody already through the door is
 *     turned back (portal/actions.ts, "HOW EXISTING BOOKINGS STAY STABLE").
 *   · THE ADDRESS: the plan is still exact and on the map, at the version the
 *     time was offered for.
 *   · CAPACITY, read inside the month's lock with this request as one of the
 *     asks: a session confirmed by hand meanwhile, or a smaller package, sends
 *     it to the desk.
 *   · Product assignment, weekends, 24 hours and the hub's own clash, as before.
 *   (Travel, on a FRESH read of the creative's day, runs in drive() once the
 *   slot recheck has named the creative's Aryeo user.)
 */
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
  // EXACT ADDRESS FIRST (§3, W02).
  if (!ctx.plan || !planBookable(ctx.plan)) return "there is no exact, mapped filming address for this session";
  if (r.planAddressVersion == null || ctx.plan.addressVersion !== r.planAddressVersion) return "the filming address changed after this time was picked";
  const gate = await gateMoved(ctx);
  if (gate) return gate;
  let eligible: string[];
  try {
    eligible = await bookableProviderIdsFor(product.productId);
  } catch {
    return "__RETRY__"; // could not ask Aryeo: nothing sent, try again next tick
  }
  if (!eligible.includes(r.creativeTeamMemberId)) return `${r.creativeName ?? "that creative"} is not assigned to ${product.title} in Aryeo any more`;
  if (r.kind !== "EXTRA_SESSION") {
    const cap = await capacityUnderMonthLock(r.enrollmentId, r.monthId, now);
    // This request is one of the asks `used` counts; over is over.
    if (cap.used > cap.allowed) return `the month's ${cap.allowed} session${cap.allowed === 1 ? " is" : "s are"} already booked or requested (${cap.used} counted)`;
  }
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

/** A23(a): the gate, re-read — and refused only if its anchor moved AND the
 *  slot is now too early (or the month shut). No snapshot = nothing to compare. */
async function gateMoved(ctx: Ctx): Promise<string | null> {
  const { r, now } = ctx;
  if (!r.gateAnchorRef || !r.slotStart) return null;
  const { sessionGate } = await import("@/lib/portal");
  const g = await sessionGate(r.enrollmentId, r.monthId, { now, sessionIndex: r.sessionIndex ?? undefined });
  const prep = g.preparation;
  const liveRef = prep?.anchor?.ref ?? null;
  if (liveRef === r.gateAnchorRef) return null;
  if (!prep || prep.locked || !prep.earliest) return `what this session's filming was measured from has changed and the month is not open for filming now (${prep?.reason ?? g.reason})`;
  if (r.slotStart < prep.earliest) return `what this session's filming was measured from has changed (${prep.reason}), so the earliest start is now ${prep.earliest.toISOString()}`;
  return null;
}

async function loadCtx(r: ProgramSessionRequest, now: Date, worker: string, deadline: number, cfg: BookingConfig): Promise<Ctx | null> {
  const [client, enrollment, month, plan] = await Promise.all([
    prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true, aryeoCustomerId: true } }),
    prisma.contentEnrollment.findUnique({ where: { id: r.enrollmentId }, select: { id: true, status: true, package: true } }),
    prisma.contentMonth.findUnique({ where: { id: r.monthId }, select: { id: true, monthKey: true, historical: true } }),
    r.planId ? prisma.programSessionPlan.findUnique({ where: { id: r.planId } }) : Promise.resolve(null),
  ]);
  if (!client || !enrollment) return null;
  return { r, client, enrollment, plan, month, product: aryeoProductFor(enrollment.package), cfg, now, worker, deadline };
}

const budgetLeft = (ctx: Ctx) => ctx.deadline - Date.now();
/**
 * Room a write needs before it may START: one write's own timeout (20 s, in
 * integrations/aryeo) and a margin. This was 30 s, and the portal gives its
 * inline booking a 25 s budget — so the portal's "book it now" stopped before
 * the first write every time, and every self-booking waited for the hourly
 * cron (found by the batch-3 portal journey, Sep 25 2026). A write cut off by
 * the platform is still safe: its intent row says *_SENT first, and the next
 * tick settles it by reading, never by sending again.
 */
const WRITE_ROOM_MS = 22_000;

/**
 * The portal's inline booking budget: every read before the first write, then
 * the address, the order and the appointment — each of those three writes has
 * its own 20 s timeout and may START only with WRITE_ROOM_MS left. It was
 * 25 s: 22 s of room at each of three gates left 3 s for everything else, so
 * with Aryeo and OSRM answering in half a second a call the run always stopped
 * before a write and the client's "Booking your session" waited up to an hour
 * for the cron — at worst with an order made and no appointment on it (batch-3
 * review, Sep 25 2026; proven only against instant fakes before). 75 s covers
 * the reads plus the address and order writes at their worst and still leaves
 * the appointment its room; typical real latency finishes in well under ten.
 * The portal pages declare maxDuration 90 so the platform does not cut the
 * action off first.
 */
export const INLINE_BOOKING_BUDGET_MS = 75_000;

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
  if (attempt?.state === "ORDER_CREATED" && attempt.aryeoOrderId) {
    // Picked up where the SAME run of checks left off (a store that was
    // rate-limited, a budget that ran out, an order read that failed): the
    // creative-day hold taken for this slot still stands, nothing about the
    // slot was let go, so the appointment step follows directly.
    if (await holdStands(r)) return appointmentStep(ctx, attempt);
    // Back from the desk (a PAYMENT_MISMATCH fixed, a refused permit, a staff
    // Retry): the hold was released, and while the request sat with Kyle
    // anybody could have taken the slot — another hub booking, a hand booking,
    // or the 24-hour line. Every check a fresh booking makes runs again before
    // the appointment is stored on the order the hub already made (review of
    // batch 3, Sep 25 2026: a Retry used to store it with none of them).
    return carriedOrder(ctx, attempt);
  }

  // ---- a fresh (or not-yet-sent) attempt ----
  const why = await guards(ctx);
  if (why === "__RETRY__") {
    await setRequest(r.id, { nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: "could not read the product's creatives from Aryeo — nothing was sent", lastErrorAt: ctx.now });
    return out(r.id, "retry", "Aryeo unreachable before any write");
  }
  if (why) return r.aryeoOrderId ? toDesk(ctx, "RECONCILE", "FIX", carriedOrderWords(r.aryeoOrderId, why)) : toDesk(ctx, "RECONCILE", "BOOK", `The hub did not book this: ${why}.`);
  const gate = await permitFor(ctx, "orders.create");
  if (!gate.ok) return toDesk(ctx, "RECONCILE", "BOOK", `Desk-assisted: ${gate.reason}.`);

  if (!attempt) attempt = await openAttempt(ctx);
  // A prior attempt that got as far as an order (its appointment was refused,
  // or staff re-queued it) — that order is ours and is used, never duplicated.
  // The slot, the drive and the hold are checked again first (A23): the order
  // is old, the calendar around it is not.
  if (attempt.aryeoOrderId) {
    const carried = attempt;
    return appointmentStep(ctx, carried, () => recheckSlot(ctx, carried, carried.aryeoOrderId));
  }

  const stop = await recheckSlot(ctx, attempt, null);
  if (stop) return stop;
  const product = ctx.product!;

  // R03 — A HUB ORDER MUST NEVER BILL A STRIPE-PREPAID CLIENT. The program
  // products are priced $0 in Aryeo (Phase 0), which is what makes a hub order
  // carry no balance and no second revenue line. That is a setting somebody can
  // change in the Aryeo UI, so it is read before every order: a price above
  // zero sends the booking to the desk with NOTHING created — no address, no
  // order. Could not read it → try again; nothing was sent.
  let priceCents: number | null;
  try {
    priceCents = await AryeoBooking.productVariantPrice(product.productId, product.variantId);
  } catch (e) {
    await setRequest(r.id, { bookingState: "QUEUED", nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: `could not read ${product.title}'s price from Aryeo (${e instanceof Error ? e.message : e}) — nothing was sent`, lastErrorAt: ctx.now });
    return out(r.id, "retry", "price read failed before any write");
  }
  if (priceCents !== 0) {
    const why = priceCents == null
      ? `Aryeo's catalogue no longer lists ${product.title}'s variant, so the hub cannot confirm it is $0`
      : `Aryeo now prices ${product.title} at $${(priceCents / 100).toFixed(2)}; a hub order would bill a Stripe-prepaid client`;
    await setAttempt(attempt.id, { state: "REJECTED", settledAt: ctx.now, lastError: why, lastErrorAt: ctx.now });
    await releaseCreativeHold(r.id, "REJECTED", ctx.now);
    return toDesk(ctx, "REJECTED", "BOOK", `${why}. Nothing was created. Book it by hand once the price is sorted.`, "rejected");
  }

  // ADDRESS: the plan's exact street, on the map — never an area, never a guess.
  if (!attempt.aryeoAddressId) {
    const plan = ctx.plan!;
    const body = {
      street_number: plan.streetNumber, street_name: plan.streetName, unit_number: plan.unitNumber,
      city: plan.city, state_or_province: plan.stateCode, postal_code: plan.postalCode, country: "US",
      latitude: plan.latitude, longitude: plan.longitude,
    };
    if (budgetLeft(ctx) < WRITE_ROOM_MS || !(await stillMine(r.id, ctx.worker))) return out(r.id, "pending", "stopped before the address write");
    const p = await permitFor(ctx, "addresses.create");
    if (!p.ok) return toDesk(ctx, "RECONCILE", "BOOK", `Desk-assisted: ${p.reason}.`);
    try {
      const a = await AryeoBooking.createAddress(p.permit, body);
      attempt = await setAttempt(attempt.id, { aryeoAddressId: a.id, requestJson: JSON.stringify({ address: body }), permitScope: scopeOf(p) });
      await setRequest(r.id, { aryeoAddressId: a.id });
    } catch (e) {
      const kind = classifyAryeoWriteError(e);
      const msg = e instanceof Error ? e.message : String(e);
      if (kind === "REJECTED") {
        await setAttempt(attempt.id, { state: "REJECTED", settledAt: ctx.now, lastError: msg, lastErrorAt: ctx.now });
        await releaseCreativeHold(r.id, "REJECTED", ctx.now);
        return toDesk(ctx, "REJECTED", "BOOK", `Aryeo refused the filming address (${msg}). Nothing was booked. Book it by hand.`, "rejected");
      }
      // An Address on its own books nothing, so a maybe-created one is inert:
      // the next tick simply makes another.
      await setRequest(r.id, { bookingState: "QUEUED", nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: `address create: ${msg}`, lastErrorAt: ctx.now });
      return out(r.id, "retry", `address create ${kind.toLowerCase()}`);
    }
  }

  // ORDER: the intent row says ORDER_SENT before the call leaves.
  if (budgetLeft(ctx) < WRITE_ROOM_MS || !(await stillMine(r.id, ctx.worker))) return out(r.id, "pending", "stopped before the order write");
  const p = await permitFor(ctx, "orders.create");
  if (!p.ok) return toDesk(ctx, "RECONCILE", "BOOK", `Desk-assisted: ${p.reason}.`);
  // The marker, then the accounting provenance (R03): team-only, and never a
  // dollar amount — the order is $0 because the client paid through Stripe.
  const notes = `${attempt.marker} · booked by the hub for ${ctx.month?.monthKey ?? "the program month"}, ${ctx.client.name}. ${await prepaidProvenance(ctx)}`;
  attempt = await setAttempt(attempt.id, { state: "ORDER_SENT", nextCheckAt: new Date(ctx.now.getTime() + RECHECK_MS), permitScope: scopeOf(p) });
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

/** This request's creative-day hold still stands, for this creative at this time (never released since it was taken). */
async function holdStands(r: ProgramSessionRequest): Promise<boolean> {
  if (!r.slotStart || !r.creativeTeamMemberId) return false;
  const h = await prisma.programCreativeHold.findUnique({ where: { requestId: r.id }, select: { releasedAt: true, startAt: true, creativeTeamMemberId: true } });
  return !!h && !h.releasedAt && h.startAt.getTime() === r.slotStart.getTime() && h.creativeTeamMemberId === r.creativeTeamMemberId;
}

/** The desk's words for an order the hub made whose appointment it did not store. */
const carriedOrderWords = (orderId: string, why: string) =>
  `The hub already made order ${orderId} for this session (it has no appointment yet) and did not put it on the calendar: ${why}. Book the appointment on THAT order by hand at a time that works, or cancel the order in Aryeo; do not make a new one.`;

/**
 * An ORDER_CREATED attempt resumed without its hold (see drive): the same
 * rules a fresh booking passes — 24 hours, weekends, the gate's anchor, the
 * address version, capacity, the creative's assignment and the hub's own
 * clashes (guards), then the slot, the drive and the hold (recheckSlot) —
 * before the appointment is stored. They run inside the appointment step,
 * after the order is read back: its money check still comes first, and an
 * appointment Kyle already put on THIS order at our time is adopted as it
 * always was (the rules guard a write, and adopting writes nothing). Any no
 * is the desk's, with the order named; the order itself is never touched.
 */
async function carriedOrder(ctx: Ctx, attempt: ProgramBookingAttempt): Promise<BookOutcome> {
  const { r } = ctx;
  const orderId = attempt.aryeoOrderId!;
  return appointmentStep(ctx, attempt, async () => {
    const why = await guards(ctx);
    if (why === "__RETRY__") {
      await setRequest(r.id, { bookingState: "ORDER_CREATED", nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: `could not read the product's creatives from Aryeo — order ${orderId} has no appointment yet; nothing was sent`, lastErrorAt: ctx.now });
      return out(r.id, "retry", "Aryeo unreachable before the appointment write");
    }
    if (why) return toDesk(ctx, "RECONCILE", "FIX", carriedOrderWords(orderId, why));
    return recheckSlot(ctx, attempt, orderId);
  });
}

/**
 * THE SLOT, RE-READ JUST BEFORE A WRITE (A23), read-only apart from the hold:
 * is the time still this creative's in Aryeo, does the drive fit on a FRESH
 * read of their day, and can the creative-day hold be taken. null = all clear
 * (the hold is now this request's).
 *
 * `orderId` set = the hub already made an order for this request (a Retry,
 * or one carried from an earlier attempt). A lost slot then goes to the desk
 * with that order named instead of back to the client: a re-pick would open a
 * new request and leave the order behind in Aryeo with nobody looking at it.
 */
async function recheckSlot(ctx: Ctx, attempt: ProgramBookingAttempt, orderId: string | null): Promise<BookOutcome | null> {
  const { r } = ctx;
  const product = ctx.product!;
  const start = r.slotStart!;
  const end = new Date(start.getTime() + product.durationMinutes * 60_000);
  // Waiting: an order already made keeps its state (the resume path finds it
  // again); otherwise the request goes back to the queue.
  const waitState = orderId ? "ORDER_CREATED" : "QUEUED";
  const nothingSent = orderId ? `order ${orderId} has no appointment yet; nothing was sent` : "nothing was sent";
  const lost = (why: string, clientWords: string) =>
    orderId ? toDesk(ctx, "RECONCILE", "FIX", carriedOrderWords(orderId, why)) : conflict(ctx, attempt, why, clientWords);

  // RECHECK (read-only): is the slot still this creative's?
  let creativeUserId: string | null = null;
  let hit: { userIds: string[] | null } | undefined;
  try {
    const byUser = await teamMemberIdByUserId();
    creativeUserId = [...byUser].find(([, tm]) => tm === r.creativeTeamMemberId)?.[0] ?? null;
    const slots = await AryeoBooking.timeslotsFor({ date: etDayKey(start), durationMin: product.durationMinutes, teamMemberIds: [r.creativeTeamMemberId!] });
    hit = slots.find((s) => new Date(s.startAt).getTime() === start.getTime());
  } catch {
    await setRequest(r.id, { bookingState: waitState, nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: `could not recheck the slot with Aryeo — ${nothingSent}`, lastErrorAt: ctx.now });
    return out(r.id, "retry", "slot recheck failed before any write");
  }
  // A timeslot that lists people must list ours. One that lists nobody was
  // already filtered to this one creative by the query itself.
  const free = !!hit && (!hit.userIds || hit.userIds.length === 0 || (!!creativeUserId && hit.userIds.includes(creativeUserId)));
  if (!free) return lost("the slot is no longer free for this creative", "That time was taken between the pick and the booking.");

  // TRAVEL, on a FRESH read of the creative's day (A23(d)). The portal offered
  // the slot from the hub's own rows, which are an hour old at worst; an
  // appointment Aryeo gained since — nearby in time and far away — is found
  // here, before anything is written. Could not read Aryeo → try again, nothing
  // sent. Could not MEASURE the drive → a person confirms it (never auto-booked).
  const dest = { lat: ctx.plan!.latitude!, lng: ctx.plan!.longitude! };
  const fit = await travelFit({
    creativeTeamMemberId: r.creativeTeamMemberId!, start, end, dest, now: ctx.now, excludeRequestId: r.id,
    fresh: { userId: creativeUserId }, bufferMinutes: ctx.cfg.travelBufferMinutes ?? TRAVEL_DEFAULTS.travelBufferMinutes,
  });
  await setRequest(r.id, { travelEvidenceJson: travelEvidence(fit, { at: "booking", checkedAt: ctx.now.toISOString(), neighbours: fit.neighbours }) });
  if (fit.readFailed) {
    await setRequest(r.id, { bookingState: waitState, nextAttemptAt: new Date(ctx.now.getTime() + RECHECK_MS), lastError: `${fit.reason} — ${nothingSent}`, lastErrorAt: ctx.now });
    return out(r.id, "retry", "could not read the creative's day before any write");
  }
  if (fit.fits === false) return lost(`travel: ${fit.reason}`, "That time no longer leaves room for the drive from the videographer's other shoot that day.");
  if (fit.fits === null) {
    if (orderId) return toDesk(ctx, "RECONCILE", "FIX", carriedOrderWords(orderId, `${fit.reason}. Check the drive`));
    await setAttempt(attempt.id, { state: "ABANDONED", settledAt: ctx.now, lastError: fit.reason, lastErrorAt: ctx.now });
    await releaseCreativeHold(r.id, "ABANDONED", ctx.now);
    return toDesk(ctx, "RECONCILE", "BOOK", `The hub did not book this: ${fit.reason}. Check the drive and book it by hand.`);
  }

  // THE CREATIVE-DAY HOLD (A23): two workers booking the same creative into
  // overlapping times cannot both pass. Taken under a short advisory lock on
  // (creative, ET day); every HTTP call happens after the lock is released.
  const hold = await takeCreativeHold({ requestId: r.id, creativeTeamMemberId: r.creativeTeamMemberId!, start, end, considered: fit.considered });
  if (!hold.ok && hold.retry) {
    await setRequest(r.id, { bookingState: waitState, nextAttemptAt: new Date(ctx.now.getTime() + 60_000), lastError: `${hold.reason} — ${nothingSent}; checking again`, lastErrorAt: ctx.now });
    return out(r.id, "retry", hold.reason);
  }
  if (!hold.ok) return lost(`held: ${hold.reason}`, "That time was taken between the pick and the booking.");
  // An attempt that already has its order stays ORDER_CREATED (that is what
  // the resume path reads); a fresh one moves on to RECHECKED.
  await setAttempt(attempt.id, { ...(orderId ? {} : { state: "RECHECKED" }), slotStart: start, slotEnd: end, creativeTeamMemberId: r.creativeTeamMemberId });
  return null;
}

async function appointmentStep(ctx: Ctx, attempt: ProgramBookingAttempt, beforeStore?: () => Promise<BookOutcome | null>): Promise<BookOutcome> {
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
  // R03 — THE MONEY READBACK, before anything is put on the calendar. Aryeo's
  // own figures are recorded on the attempt (evidence, not a guess), and an
  // order that shows anything owed stops here: no appointment is stored, the
  // request waits in RECONCILE, and Kyle gets ONE PAYMENT_MISMATCH task. The
  // hub never voids, refunds or edits the order — that is a person's call.
  const money = prepaidOrderCheck(order);
  await setAttempt(attempt.id, {
    orderTotalCents: typeof order.total_amount === "number" ? order.total_amount : null,
    orderBalanceCents: typeof order.balance_amount === "number" ? order.balance_amount : null,
    orderPaymentStatus: order.payment_status ?? null,
  });
  if (!money.ok) return paymentMismatch(ctx, attempt, order, money.problems);
  // Idempotency by readback: an appointment already on OUR order at OUR start
  // is ours (Kyle's hand, or a store that timed out after committing).
  const already = (order.appointments ?? []).find((a) => (a.status ?? "").toUpperCase() !== "CANCELED" && sameMinute(a.start_at, start));
  if (already?.id) {
    await setAttempt(attempt.id, { state: "APPT_CREATED", aryeoAppointmentId: already.id });
    return readbackAndConfirm(ctx, attempt, already.id);
  }
  // A resumed or carried order: the slot, the drive and the hold, re-read
  // now — after the money check, before the only write left.
  if (beforeStore) {
    const stop = await beforeStore();
    if (stop) return stop;
  }
  if (budgetLeft(ctx) < WRITE_ROOM_MS || !(await stillMine(r.id, ctx.worker))) return out(r.id, "pending", "stopped before the appointment write");
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

/** R03: one task for Kyle, the order untouched, the request parked. A retry
 *  adopts the SAME order by its marker and lands here again — never a second one. */
async function paymentMismatch(ctx: Ctx, attempt: ProgramBookingAttempt, order: { number?: number | null; balance_amount?: number | null; total_amount?: number | null }, problems: string[]): Promise<BookOutcome> {
  const r = ctx.r;
  const label = order.number ? `#${order.number}` : attempt.aryeoOrderId ?? "(unknown)";
  const owed = typeof order.balance_amount === "number" ? `$${(order.balance_amount / 100).toFixed(2)}` : "an unknown amount";
  const why = `PAYMENT_MISMATCH: order ${label} shows ${owed} owed for a Stripe-prepaid client (${problems.join("; ")}).`;
  await setRequest(r.id, { bookingState: "RECONCILE", nextAttemptAt: null, lastError: why.slice(0, 1000), lastErrorAt: ctx.now });
  await setAttempt(attempt.id, { lastError: why.slice(0, 1000), lastErrorAt: ctx.now, nextCheckAt: null });
  await releaseCreativeHold(r.id, "PAYMENT_MISMATCH", ctx.now);
  await paymentMismatchTask(ctx, attempt, order, problems, null);
  return out(r.id, "desk", why);
}

/**
 * Kyle's ONE PAYMENT_MISMATCH task. `bookedAppointmentId` null = found before
 * the appointment was stored (nothing is on the calendar; Retry reuses the
 * order); set = found on the readback after it (the booking is real and
 * stays; only the money is wrong). Always raised, TEST fixture or not: the
 * hub really made this order, so a person must be able to find it.
 */
async function paymentMismatchTask(ctx: Ctx, attempt: ProgramBookingAttempt, order: { number?: number | null; balance_amount?: number | null; total_amount?: number | null }, problems: string[], bookedAppointmentId: string | null): Promise<void> {
  const r = ctx.r;
  const label = order.number ? `#${order.number}` : attempt.aryeoOrderId ?? "(unknown)";
  const owed = typeof order.balance_amount === "number" ? `$${(order.balance_amount / 100).toFixed(2)}` : "an unknown amount";
  const why = `PAYMENT_MISMATCH: order ${label} shows ${owed} owed for a Stripe-prepaid client (${problems.join("; ")}).`;
  const dedupeKey = bookedAppointmentId ? `content-session-payment-mismatch-booked-${r.id}` : `content-session-payment-mismatch-${r.id}`;
  const exists = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (exists) return;
  await prisma.smartTask.create({
    data: {
      taskType: "todo", status: "OPEN", source: "content_program", priority: "URGENT", assignedKey: "kyle", clientId: ctx.client.id, dedupeKey,
      title: `PAYMENT_MISMATCH: order ${label} shows ${owed} owed for a Stripe-prepaid client`.slice(0, 140),
      summary: `${ctx.client.name} — the hub made order ${label} for their content session and Aryeo reads it back as money owed.`.slice(0, 500),
      description: [
        why,
        bookedAppointmentId
          ? `Client: ${ctx.client.name}. Order note "${attempt.marker}". The session IS booked (appointment ${bookedAppointmentId}) and stays booked: the money appeared on the order once the appointment was stored, after the check before it had read $0.`
          : `Client: ${ctx.client.name}. Order note "${attempt.marker}". Nothing was put on the calendar: the appointment was not stored.`,
        "The client paid for the program through Stripe, so this order must be $0. The hub did NOT void, refund or change it.",
        bookedAppointmentId
          ? "Check what Aryeo added to the order (a travel or territory fee on the creative, a price rule) and fix the balance by hand. Nothing needs retrying."
          : "Check the product's price and the order in Aryeo, fix the balance by hand, then press Retry on the request: it reuses this same order, and checks the time is still free and more than 24 hours away before it books it.",
        `Request ${r.id}`,
      ].join("\n"),
      reasonCreated: "Hub booking prepaid check (R03)", dueAt: new Date(ctx.now.getTime() + 4 * 3_600_000),
    },
  }).catch(() => null);
}

async function readbackAndConfirm(ctx: Ctx, attempt: ProgramBookingAttempt, appointmentId: string): Promise<BookOutcome> {
  const { r } = ctx;
  const product = ctx.product!;
  const start = r.slotStart!;
  const end = new Date(start.getTime() + product.durationMinutes * 60_000);
  let appt: AryeoBookedAppointment;
  let creativeUserId: string | null = null;
  let orderAddress: ReadbackOrder["address"] = null;
  let order: Awaited<ReturnType<typeof AryeoBooking.getOrder>>;
  try {
    appt = await AryeoBooking.getAppointment(appointmentId);
    const byUser = await teamMemberIdByUserId();
    creativeUserId = [...byUser].find(([, tm]) => tm === r.creativeTeamMemberId)?.[0] ?? null;
    // A23: the ORDER is read back too — its address must be the one the hub
    // made — and (R03) so is its money, AFTER the appointment: a fee Aryeo
    // attaches once a creative is on the order (their travel fee, a
    // territory fee) can only appear now, never on the pre-store read.
    order = await AryeoBooking.getOrder(attempt.aryeoOrderId!);
    if (attempt.aryeoAddressId) orderAddress = order.address ?? null;
  } catch (e) {
    await setRequest(r.id, { bookingState: "APPT_PENDING", nextAttemptAt: new Date(ctx.now.getTime() + 5 * 60_000), lastError: `readback: ${e instanceof Error ? e.message : e}`, lastErrorAt: ctx.now });
    return out(r.id, "pending", "appointment made; readback not done yet");
  }
  const plan = ctx.plan;
  const v = verifyReadback(
    { orderId: attempt.aryeoOrderId!, start, end, creativeTeamMemberId: r.creativeTeamMemberId!, creativeUserId },
    appt,
    attempt.aryeoAddressId
      ? { expectedAddressId: attempt.aryeoAddressId, expected: plan && planBookable(plan) ? { streetNumber: plan.streetNumber, streetName: plan.streetName, unit: plan.unitNumber, postalCode: plan.postalCode } : null, order: { address: orderAddress } }
      : null,
  );
  // The figures on the attempt are the ones Aryeo shows with the appointment
  // on the order (the pre-store ones were evidence for the pre-store check).
  const money = prepaidOrderCheck(order);
  await setAttempt(attempt.id, {
    readbackJson: JSON.stringify({ appointment: appt.raw, orderAddress, problems: v.problems }).slice(0, 20_000),
    orderTotalCents: typeof order.total_amount === "number" ? order.total_amount : null,
    orderBalanceCents: typeof order.balance_amount === "number" ? order.balance_amount : null,
    orderPaymentStatus: order.payment_status ?? null,
  });
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
  await releaseCreativeHold(r.id, "CONFIRMED", now);
  if (doubleBooked) await raiseDoubleBooked(ctx, appointmentId);
  // R03 after the store: the appointment is real and stays booked (like a
  // clash found afterwards), and Kyle gets the PAYMENT_MISMATCH task. The hub
  // still never voids, refunds or edits the order.
  if (!money.ok) await paymentMismatchTask(ctx, attempt, order, money.problems, appointmentId);
  await recordBookedAddress(ctx, attempt, appointmentId, start).catch(() => null);
  await afterConfirm(r.id, r.monthId, attempt.aryeoOrderId!);
  return out(r.id, "confirmed", `appointment ${appointmentId} on order ${attempt.aryeoOrderId}`);
}

/**
 * §6.6 W02: a hub booking was made AT the exact address, so the session's
 * address row is written now, SYNCED from the plan — the missing-address lane
 * (CP-05) never asks a client who already gave it. An existing row (an address
 * given some other way) is left as it is.
 */
async function recordBookedAddress(ctx: Ctx, attempt: ProgramBookingAttempt, appointmentId: string, start: Date): Promise<void> {
  const plan = ctx.plan;
  if (!plan || !planBookable(plan)) return;
  const now = ctx.now;
  await prisma.programSessionAddress.upsert({
    where: { sessionKey: `appt:${appointmentId}` },
    update: {},
    create: {
      sessionKey: `appt:${appointmentId}`, enrollmentId: ctx.enrollment.id, clientId: ctx.client.id, monthId: ctx.r.monthId,
      aryeoAppointmentId: appointmentId, aryeoOrderId: attempt.aryeoOrderId, requestId: ctx.r.id, shootStartAt: start,
      streetNumber: plan.streetNumber, streetName: plan.streetName, unitNumber: plan.unitNumber, city: plan.city, stateCode: plan.stateCode, postalCode: plan.postalCode,
      latitude: plan.latitude, longitude: plan.longitude, submittedAt: now, submittedBy: "hub-booking", version: 1,
      syncState: "SYNCED", syncedAt: now, aryeoAddressId: attempt.aryeoAddressId,
      readbackJson: JSON.stringify({ source: "hub-booking", marker: attempt.marker, address: formatAddressLine({ streetNumber: plan.streetNumber, streetName: plan.streetName, unit: plan.unitNumber, city: plan.city, stateCode: plan.stateCode, postalCode: plan.postalCode }) }),
    },
  });
  await prisma.programSessionPlan.update({ where: { id: plan.id }, data: { lastStep: "BOOKED" } }).catch(() => null);
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

/** REFUSED = the guard said no (the desk takes it); CONFLICT = the new time is not
 *  free for this creative (A23) — nothing was sent and the client picks again. */
export type ChangeOutcome = { ok: boolean; state: "DONE" | "PENDING" | "DESK" | "REFUSED" | "CONFLICT"; message: string };

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
 *
 * A23 (Sep 25 2026): the new time is checked the way a new booking is, BEFORE
 * the PUT — the reschedule used to write whatever time it was given. Aryeo
 * must still offer it to this creative (asked only when the new time does not
 * overlap the session's own current time, which Aryeo would count against
 * itself), the drive must fit on a FRESH read of their day (which also catches
 * any other appointment in the way), and the creative-day hold must be free.
 * Any no is CONFLICT: zero writes, the client picks again. A drive that cannot
 * be measured is REFUSED, so the desk moves it by hand.
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
  const check = await recheckMove(r, product.durationMinutes, newStart, newEnd, now);
  if (check.state !== "OK") return check.outcome;
  const attempt = await openChangeAttempt(r, "RESCHEDULE", { start: newStart, end: newEnd });
  await setAttempt(attempt.id, { permitScope: gate.scope ?? gate.permit.scope ?? "FIXTURE" });
  await setRequest(r.id, { pendingChangeJson: JSON.stringify({ kind: "RESCHEDULE", attemptId: attempt.id, newStart: newStart.toISOString(), newEnd: newEnd.toISOString(), by: opts.by } satisfies PendingChange) });
  return sendReschedule(r, attempt, gate.permit, newStart, newEnd, now);
}

const MOVE_TAKEN = "That time is no longer free for your videographer. Pick another time.";

/** A23: is the new time really this creative's? Reads only, then the hold. */
async function recheckMove(r: ProgramSessionRequest, durationMin: number, start: Date, end: Date, now: Date): Promise<{ state: "OK" } | { state: "NO"; outcome: ChangeOutcome }> {
  const tm = r.creativeTeamMemberId;
  if (!tm) return { state: "NO", outcome: { ok: false, state: "REFUSED", message: "No creative on record for this session." } };
  const conflictOut = async (why: string) => {
    await setRequest(r.id, { lastError: `move to ${start.toISOString()} refused, nothing sent: ${why}`.slice(0, 1000), lastErrorAt: now });
    return { state: "NO" as const, outcome: { ok: false, state: "CONFLICT" as const, message: MOVE_TAKEN } };
  };
  let userId: string | null = null;
  try {
    userId = [...(await teamMemberIdByUserId())].find(([, t]) => t === tm)?.[0] ?? null;
    const overlapsOwn = !!r.slotStart && !!r.slotEnd && r.slotStart < end && r.slotEnd > start;
    if (!overlapsOwn) {
      const slots = await AryeoBooking.timeslotsFor({ date: etDayKey(start), durationMin, teamMemberIds: [tm] });
      const hit = slots.find((x) => new Date(x.startAt).getTime() === start.getTime());
      const free = !!hit && (!hit.userIds || hit.userIds.length === 0 || (!!userId && hit.userIds.includes(userId)));
      if (!free) return await conflictOut("Aryeo does not offer that time to this creative");
    }
  } catch {
    return { state: "NO", outcome: { ok: false, state: "CONFLICT", message: "We could not check that time with the calendar just now. Try again in a minute." } };
  }
  const plan = r.planId ? await prisma.programSessionPlan.findUnique({ where: { id: r.planId }, select: { latitude: true, longitude: true } }) : null;
  const given = r.aryeoAppointmentId ? await prisma.programSessionAddress.findUnique({ where: { sessionKey: `appt:${r.aryeoAppointmentId}` }, select: { latitude: true, longitude: true, submittedAt: true } }) : null;
  const at = given?.submittedAt && given.latitude != null && given.longitude != null ? { lat: given.latitude, lng: given.longitude }
    : plan?.latitude != null && plan.longitude != null ? { lat: plan.latitude, lng: plan.longitude } : null;
  if (!at) return { state: "NO", outcome: { ok: false, state: "REFUSED", message: "The session has no mapped address, so a person moves it." } };
  const fit = await travelFit({ creativeTeamMemberId: tm, start, end, dest: at, now, excludeRequestId: r.id, fresh: { userId } });
  await setRequest(r.id, { travelEvidenceJson: travelEvidence(fit, { at: "reschedule", newStart: start.toISOString(), checkedAt: now.toISOString() }) });
  if (fit.readFailed) return { state: "NO", outcome: { ok: false, state: "CONFLICT", message: "We could not check that time with the calendar just now. Try again in a minute." } };
  if (fit.fits === false) return await conflictOut(`travel: ${fit.reason}`);
  if (fit.fits === null) return { state: "NO", outcome: { ok: false, state: "REFUSED", message: `The drive could not be checked (${fit.reason}), so a person moves it.` } };
  const hold = await takeCreativeHold({ requestId: r.id, creativeTeamMemberId: tm, start, end, state: "MOVING", considered: fit.considered });
  if (!hold.ok && hold.retry) return { state: "NO", outcome: { ok: false, state: "CONFLICT", message: "We could not check that time with the calendar just now. Try again in a minute." } };
  if (!hold.ok) return await conflictOut(hold.reason);
  return { state: "OK" };
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
      await releaseCreativeHold(r.id, "REJECTED", now);
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
  // A23: moved is not the same as moved RIGHT — the end and the creative are
  // read back too. A move that landed wrong is Kyle's, never "Moved".
  const creativeUserId = r.creativeTeamMemberId ? [...(await teamMemberIdByUserId().catch(() => new Map<string, string>()))].find(([, t]) => t === r.creativeTeamMemberId)?.[0] ?? null : null;
  const onIt = !r.creativeTeamMemberId || appt.teamMemberIds.includes(r.creativeTeamMemberId) || (!!creativeUserId && appt.userIds.includes(creativeUserId));
  if (!sameMinute(appt.end_at, end) || !onIt) {
    const problems = [!sameMinute(appt.end_at, end) ? `it ends ${appt.end_at ?? "(no time)"}, not ${end.toISOString()}` : null, !onIt ? "the creative is not on it" : null].filter(Boolean).join("; ");
    await prisma.$transaction([
      prisma.programBookingAttempt.update({ where: { id: attempt.id }, data: { state: "MISMATCH", settledAt: now, lastError: problems, lastErrorAt: now } }),
      prisma.programSessionRequest.update({ where: { id: r.id }, data: { pendingChangeJson: null, lastError: `move read back wrong: ${problems}`, lastErrorAt: now } }),
    ]);
    await releaseCreativeHold(r.id, "MISMATCH", now);
    await handToDesk(r.id, "FIX", `The hub moved appointment ${r.aryeoAppointmentId} to ${start.toISOString()}, but Aryeo's copy does not match: ${problems}. Fix it in Aryeo; the request still shows the old time.`);
    return { ok: true, state: "DESK", message: "We have your new time. Kyle is confirming it on the calendar." };
  }
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
  await releaseCreativeHold(r.id, "MOVED", now);
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
  // Whatever hold the request kept while it sat with the desk stood for
  // nothing there (a hold counts only while its request is being booked), so
  // it is let go: the next run re-checks the slot, the drive and the 24 hours
  // and takes a fresh one before anything is written (drive → carriedOrder).
  await releaseCreativeHold(r.id, "RETRY", now);
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
