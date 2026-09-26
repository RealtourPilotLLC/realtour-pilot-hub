import "server-only";
import { prisma } from "@/lib/prisma";
import { MONTHLY_PLAN_RE } from "@/lib/videoStyles";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { monthSessionCount, monthSessionIndexes, recalcProgramMonth, replacesPendingMove, sessionShortfall, type ProgramDb } from "@/lib/programMonths";
import { isTestClientName } from "@/lib/testClients";
import { aryeoProductFor, etMonthKey } from "@/lib/contentProgram";
import { TEXT_KYLE } from "@/lib/portalWords";

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
// only, DESK-ASSISTED: bookingState stays NONE, nothing is written to Aryeo,
// and Kyle's desk task carries the booking. ON — and only for a client the
// switch's config authorises — the request is QUEUED for the provider adapter
// (sessionBooking.ts, CP-04), which books, reads back and confirms on its own;
// no desk task is raised for a queued request, because Kyle booking the same
// slot by hand while the adapter books it is how a creative gets two orders.
// A request the adapter cannot finish is handed to the desk with the reason.
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
  /** CP-04: the creative the client picked for the slot (a COMPANY_TEAM_MEMBER id) — required for the adapter to book. */
  creative?: { teamMemberId: string; name: string | null } | null;
  /** §6.6 W02: the exact-address plan the slot was offered for, at the version
   *  it was offered under. Required for the adapter to book (the portal sends
   *  it on every slot booking); a staff or legacy ask without one is the desk's. */
  plan?: { planId: string; addressVersion: number } | null;
  /** §6.6 A24: which session of the month (Pro: 1 or 2). Legacy rows resolve by slot order. */
  sessionIndex?: number | null;
  /** §6.6 W02: how the slot's travel was checked for the picked creative.
   *  UNCHECKED is desk-confirmed: never queued for the adapter. */
  travel?: { check: "HUB_DRIVE" | "ARYEO_APPOINTMENT" | "UNCHECKED"; evidenceJson?: string | null } | null;
  /** A18/A25: the gate the slot was offered under, SNAPSHOT at request time
   *  (anchor + window), so a later rule change never reassesses it. */
  gate?: { route?: string | null; anchorRef?: string | null; anchorAt?: Date | null; windowHours?: number | null; earliestAt?: Date | null } | null;
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
    select: { id: true, projectId: true, aryeoAppointmentId: true, kind: true, extraApprovedBy: true, status: true, bookingState: true, supersedesId: true },
  });
  // A CONFIRMED request is already inside `count` (it is one of the things
  // countDistinctSessions folds), so only the asks the office has not answered
  // are added on top — and only when they do not already resolve to a counted
  // session. Two clicks that landed on one appointment are one session, not two.
  const countedKeys = new Set(count.sessions.map((x) => x.key));
  const pending = requests.filter(
    (r) => (r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED") &&
      // CP-04: the slot was taken before the hub could book it. The client is
      // asked to pick again, so the dead ask must not hold the month's place.
      r.bookingState !== "CONFLICT" &&
      // A pending move holds the place of the session it moves, not a second one.
      !replacesPendingMove(r, requests) &&
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
  if (enrollment.status !== "ACTIVE") return { ok: false, reason: `Your program is paused — ${TEXT_KYLE} and we'll sort the next session together.` };

  const start = input.slot.startISO ? new Date(input.slot.startISO) : null;
  if (input.slot.startISO && (!start || !Number.isFinite(start.getTime()))) return { ok: false, reason: "Pick a time from the list." };
  const end = input.slot.endISO ? new Date(input.slot.endISO) : null;
  const when = (input.slot.when ?? "").trim();
  if (!start && !when) return { ok: false, reason: "Pick a time from the list, or tell us what works." };
  if (start && start < new Date()) return { ok: false, reason: "That time has passed — pick a later one." };
  const location = clip((input.slot.locationText ?? "").trim(), 300);

  const kind = input.kind ?? "CONTENT_SESSION";
  const dedupeKey = `${enrollment.id}:${month.id}:${start ? start.toISOString() : "flex"}`;
  const now = new Date();
  // WHAT THIS REPLACES (review of CP-04, Sep 24 2026). A new time for a session
  // already on the calendar — or for an ask Kyle may already have booked by
  // hand — is a MOVE, and a move is a person's job: the adapter only creates,
  // so queueing it put a second order on a creative's calendar while the first
  // still stood. And a new time for a move that is itself still pending replaces
  // the pending ask, not the booking: the new request supersedes the BOOKED
  // row, so the chain never loses it (it used to stay RESCHEDULE_REQUESTED for
  // ever, with no buttons and its appointment unclaimed).
  const { replaced, booked, deskHeld } = await whatItReplaces(input.supersedesId);
  const supersedesId = booked?.id ?? input.supersedesId ?? null;
  // A MOVE nobody read a gate for (the adapter handing a half-made move to the
  // desk) is the same session under the same anchor (A24/A25): it keeps the
  // booking's own index and gate snapshot, so every new row carries one.
  const movedFrom = supersedesId && (input.sessionIndex == null || input.gate == null)
    ? await prisma.programSessionRequest.findUnique({ where: { id: supersedesId }, select: { sessionIndex: true, gateRoute: true, gateAnchorRef: true, gateAnchorAt: true, gateWindowHours: true, gateEarliestAt: true } })
    : null;
  const gateSnap: CreateSessionRequestInput["gate"] = input.gate
    ?? (movedFrom && (movedFrom.gateRoute != null || movedFrom.gateWindowHours != null)
      ? { route: movedFrom.gateRoute, anchorRef: movedFrom.gateAnchorRef, anchorAt: movedFrom.gateAnchorAt, windowHours: movedFrom.gateWindowHours, earliestAt: movedFrom.gateEarliestAt }
      : null);
  // WHO BOOKS IT (CP-04). The adapter only for a picked slot with a chosen
  // creative AND a client the guard would let it write for — asked here with
  // the same read-only check the write itself makes, so a real client is never
  // QUEUED while only a fixture is authorised. Everyone else: the desk, as today.
  let hubBooks = false;
  let deskReason: string | null = null;
  // §6.6 W02: the plan the slot was offered for, read now (the version must
  // still be the one the client saw).
  const plan = input.plan?.planId
    ? await prisma.programSessionPlan.findUnique({ where: { id: input.plan.planId } })
    : null;
  if (input.plan?.planId && (!plan || plan.monthId !== month.id || plan.enrollmentId !== enrollment.id)) return { ok: false, reason: "Add the exact filming address for this session first." };
  if (start && (await isAutomationEnabled("session_booking"))) {
    const { planBookable } = await import("@/lib/sessionAddress");
    if (booked) deskReason = `this moves a session already on the calendar${booked.aryeoAppointmentId ? ` (appointment ${booked.aryeoAppointmentId})` : ""}, and the hub only books new sessions`;
    else if (deskHeld) deskReason = "this replaces an ask Kyle may already have booked by hand";
    else if (!input.creative?.teamMemberId) deskReason = "no creative was chosen for the slot";
    // EXACT ADDRESS FIRST (§3): the adapter books only an exact, geocoded plan
    // at the version the client was offered the slot for.
    else if (!plan || !planBookable(plan)) deskReason = "there is no exact, mapped filming address for this session";
    else if (plan.addressVersion !== input.plan!.addressVersion) deskReason = "the filming address changed after the time was offered";
    // UNCHECKED TRAVEL IS DESK-CONFIRMED, never auto-booked (Jordan, Sep 25).
    else if (!input.travel || input.travel.check === "UNCHECKED") deskReason = "the drive from the creative's other appointments that day could not be checked, so a person confirms this time";
    else {
      const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { id: true, name: true } });
      const { hubWritePermit } = await import("@/lib/integrations/aryeo");
      const gate = await hubWritePermit({ switchKey: "session_booking", client, operation: "orders.create" });
      if (gate.ok) hubBooks = true; else deskReason = gate.reason;
    }
  }
  const product = aryeoProductFor((await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { package: true } }))?.package);
  const planLine = plan ? clip((await import("@/lib/sessionAddress")).planAddressLine(plan), 300) : null;

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
    | { kind: "taken"; capacity: CapacityCheck }
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
    // A reschedule frees the place of the request it replaces, so it is not
    // refused for the capacity that request itself is holding.
    const freed = input.supersedesId
      ? await tx.programSessionRequest.count({ where: { id: input.supersedesId, enrollmentId: enrollment.id, monthId: month.id, status: { in: ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED"] } } })
      : 0;
    if (kind === "CONTENT_SESSION" && capacity.remaining + freed <= 0) return { kind: "full", capacity } satisfies Settled;
    // A24: ONE live ask per session. Two different times picked for the same
    // Pro session (two tabs) both fit a two-session capacity, and the second
    // would then stand in for session 2 without ever passing session 2's
    // gate. Read inside the lock, so it sees the first one's row. The request
    // being replaced (a move) does not count against its own replacement.
    if (kind === "CONTENT_SESSION" && input.sessionIndex != null) {
      const replacing = [supersedesId, input.supersedesId, existing?.id].filter((x): x is string => !!x);
      const holders = await tx.programSessionRequest.count({
        where: {
          monthId: month.id, sessionIndex: input.sessionIndex, status: { in: ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED"] }, bookingState: { not: "CONFLICT" },
          id: { notIn: replacing },
        },
      });
      if (holders > 0) return { kind: "taken", capacity } satisfies Settled;
      // …and a session held WITHOUT the column (batch-3 review, Sep 25 2026):
      // one Kyle booked by hand in Aryeo has no request row, and an ask made
      // before sessionIndex existed has none set, yet each holds a session by
      // slot order — the month's own occupancy (monthSessionIndexes, the
      // reader every screen uses). A tab that still offered "Session 1 of 2"
      // over one of those admitted the month's SECOND session as "1" without
      // ever reading session 2's gate, and renumbered the booked one as 2.
      const idx = input.sessionIndex;
      if (idx >= 1 && idx <= capacity.sessionsPerMonth) {
        const occ = await monthSessionIndexes(month.id, enrollment.clientId, capacity.sessionsPerMonth, now, tx);
        const own = replacing.some((id) => occ.requestIndex.get(id) === idx);
        if (!occ.free.includes(idx) && !own) return { kind: "taken", capacity } satisfies Settled;
      }
    }
    const data = {
      enrollmentId: enrollment.id, clientId: enrollment.clientId, monthId: month.id, kind,
      slotStart: start, slotEnd: end, timezone: input.slot.timezone ?? enrollment.timezone ?? "America/New_York",
      locationText: location || planLine || null,
      notes: [when && `Preferred: ${when}`, input.slot.notes?.trim()].filter(Boolean).join("\n") || null,
      requestedByClientUserId: input.actor.kind === "CLIENT" ? input.actor.clientUserId : null,
      requestedByStaffUserId: input.actor.kind === "STAFF" ? input.actor.userId : null,
      status: "REQUESTED",
      supersedesId,
      capacityCheckJson: JSON.stringify(capacity),
      // The switch AND the guard decide whether a provider booking is attempted.
      bookingState: hubBooks ? "QUEUED" : "NONE",
      lastError: deskReason ? `desk-assisted: ${deskReason}` : null,
      productId: product?.productId ?? null,
      variantId: product?.variantId ?? null,
      creativeTeamMemberId: input.creative?.teamMemberId ?? null,
      creativeName: input.creative?.name ?? null,
      dedupeKey,
      // §6.6: which session, the plan and its version, the travel evidence, and
      // the gate the slot was offered under — all as they were at this moment.
      sessionIndex: input.sessionIndex ?? plan?.sessionIndex ?? movedFrom?.sessionIndex ?? null,
      planId: plan?.id ?? null,
      planAddressVersion: plan ? input.plan!.addressVersion : null,
      travelCheck: input.travel?.check ?? null,
      travelEvidenceJson: input.travel?.evidenceJson ?? null,
      gateRoute: gateSnap?.route ?? null,
      gateAnchorRef: gateSnap?.anchorRef ?? null,
      gateAnchorAt: gateSnap?.anchorAt ?? null,
      gateWindowHours: gateSnap?.windowHours ?? null,
      gateEarliestAt: gateSnap?.earliestAt ?? null,
    };
    // A CANCELLED/EXPIRED row re-used for the same slot starts CLEAN (CP-04):
    // an old order id or appointment id left on it would send the adapter to
    // somebody else's booking. The history stays in ProgramBookingAttempt.
    const row = existing
      ? await tx.programSessionRequest.update({
          where: { id: existing.id },
          data: {
            ...data, cancelledAt: null, cancelledBy: null, cancelReason: null, confirmedAt: null, confirmedBy: null,
            projectId: null, aryeoAppointmentId: null, aryeoOrderId: null, aryeoAddressId: null, matchState: null, matchEvidenceJson: null,
            currentAttemptId: null, leaseUntil: null, leaseBy: null, nextAttemptAt: null, lastErrorAt: null, attempts: 0,
            providerConfirmedAt: null, pendingChangeJson: null, taskId: null,
          },
          select: { id: true },
        })
      : await tx.programSessionRequest.create({ data, select: { id: true } });
    if (input.supersedesId) {
      // An ask that was never booked is simply replaced; a booked one waits as
      // RESCHEDULE_REQUESTED until its replacement confirms (then it closes).
      await tx.programSessionRequest.updateMany({ where: { id: input.supersedesId, status: "REQUESTED" }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: "replaced by a new time" } });
      await tx.programSessionRequest.updateMany({ where: { id: input.supersedesId, status: "CONFIRMED" }, data: { status: "RESCHEDULE_REQUESTED" } });
    }
    // A request whose time was taken before the hub could book it is over
    // once the client picks again.
    await tx.programSessionRequest.updateMany({ where: { enrollmentId: enrollment.id, monthId: month.id, status: "REQUESTED", bookingState: "CONFLICT", id: { not: row.id } }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: "the time was taken; the client picked another" } });
    return { kind: "created", id: row.id, capacity } satisfies Settled;
    // The lock is held only for these statements; the desk task and the month
    // recalculation below are deliberately outside it. 20s is far past anything
    // this transaction does and short enough that a stuck caller frees the month.
  }, { timeout: 20_000 });

  if (settled.kind === "duplicate") {
    return { ok: true, id: settled.id, status: settled.status, duplicate: true, capacity: settled.capacity, message: "We already have this request — it shows as requested until we confirm it." };
  }
  if (settled.kind === "taken") {
    return { ok: false, reason: "That session is already requested or booked. It shows on your page, and you can change its time there.", capacity: settled.capacity };
  }
  if (settled.kind === "full") {
    const c = settled.capacity;
    // Jordan, Sep 21: "One booking should still show one session remaining."
    // The refusal says which session is missing rather than "your month is full",
    // because on Pro those are different sentences.
    return { ok: false, reason: `This month's ${c.allowed} session${c.allowed === 1 ? " is" : "s are"} already booked or requested — ask us about an extra session.`, capacity: c };
  }
  // The plan remembers the request it became (its address now changes on the
  // booked session, not on the plan).
  if (plan) await prisma.programSessionPlan.update({ where: { id: plan.id }, data: { requestId: settled.id, lastStep: "REQUESTED" } }).catch(() => null);
  // A QUEUED request is the adapter's; Kyle hears about it only if the adapter
  // hands it over (handToDesk). Everything else is desk-assisted, as before —
  // and a replacement says MOVE, with the booking it replaces in plain words.
  if (!hubBooks) {
    if (booked) await ensureDeskTask(settled.id, "RESCHEDULE", `This replaces the confirmed session at ${slotWords(booked.slotStart, booked.timezone)}${booked.aryeoAppointmentId ? ` (appointment ${booked.aryeoAppointmentId})` : ""}. Move that appointment rather than booking a second one.`);
    else if (deskHeld && replaced) await ensureDeskTask(settled.id, "RESCHEDULE", `The client first asked for ${slotWords(replaced.slotStart, replaced.timezone)} and changed it before that showed as booked. If you already booked ${replaced.slotStart ? "that time" : "it"} in Aryeo, move that booking to the new time; do not add a second one. If nothing was booked, book the new time.`);
    else await ensureDeskTask(settled.id, "BOOK", deskReason);
  }
  if (input.supersedesId) await closeDeskTask(input.supersedesId, "CANCELLED").catch(() => {});
  await recalcProgramMonth(month.id);
  // The capacity quoted back is the one the decision was made on, re-read after
  // the write so the caller sees the session it just used up.
  const after = await sessionCapacity(enrollment.id, month.id, { now });
  const remainingNote = after.remaining > 0
    ? ` You still have ${after.remaining} session${after.remaining === 1 ? "" : "s"} to book this month.`
    : "";
  return {
    ok: true, id: settled.id, status: "REQUESTED", duplicate: false, capacity: after,
    message: hubBooks
      ? `Booking your session now. It shows as booked as soon as the calendar confirms it.${remainingNote}`
      : `Requested. Kyle books it in our calendar by hand, so it shows as requested until he confirms it.${remainingNote}`,
  };
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

/**
 * A23: the month's capacity, read INSIDE the month's advisory lock — the same
 * lock createSessionRequest decides under, so the booking adapter's last check
 * before it writes cannot interleave with a new ask for the same month.
 */
export async function capacityUnderMonthLock(enrollmentId: string, monthId: string, now: Date): Promise<CapacityCheck> {
  const [lockA, lockB] = monthLockKey(enrollmentId, monthId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockA}::int4, ${lockB}::int4)`;
    return sessionCapacity(enrollmentId, monthId, { now, db: tx });
  }, { timeout: 20_000 });
}

/**
 * A23: a request that is over gives back its creative-day hold
 * (sessionBooking.takeCreativeHold). Best effort: a hold whose request is no
 * longer being booked never blocks anyone anyway (the hold check joins on it).
 */
export async function releaseCreativeHold(requestId: string, state: string, now: Date = new Date()): Promise<void> {
  await prisma.programCreativeHold.updateMany({ where: { requestId, releasedAt: null }, data: { releasedAt: now, state } }).catch(() => {});
}

/** Booking states in which an ask is in the DESK's hands (Kyle books it), not the adapter's. */
const DESK_BOOKING_STATES = ["NONE", "RECONCILE", "REJECTED", "MISMATCH", "FAILED"];

type ReplacedRow = { id: string; status: string; bookingState: string; supersedesId: string | null; aryeoAppointmentId: string | null; slotStart: Date | null; timezone: string | null };
const REPLACED_SELECT = { id: true, status: true, bookingState: true, supersedesId: true, aryeoAppointmentId: true, slotStart: true, timezone: true } as const;

/**
 * What a new time replaces (review of CP-04, Sep 24 2026):
 *   `booked`   the session on the calendar being MOVED — the row itself when it
 *              is CONFIRMED, or, when the row is a pending move, the booked row
 *              that move replaces (so a second "Change time" follows the chain);
 *   `deskHeld` a pending ask in Kyle's hands with his task open — he may have
 *              booked it in Aryeo in the hour before the reconcile sees it.
 */
async function whatItReplaces(requestId: string | null | undefined): Promise<{ replaced: ReplacedRow | null; booked: ReplacedRow | null; deskHeld: boolean }> {
  if (!requestId) return { replaced: null, booked: null, deskHeld: false };
  const replaced = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: REPLACED_SELECT });
  if (!replaced) return { replaced: null, booked: null, deskHeld: false };
  if (replaced.status === "CONFIRMED" || replaced.status === "RESCHEDULE_REQUESTED") return { replaced, booked: replaced, deskHeld: false };
  if (replaced.status !== "REQUESTED") return { replaced, booked: null, deskHeld: false };
  const booked = replaced.supersedesId ? await prisma.programSessionRequest.findFirst({ where: { id: replaced.supersedesId, status: "RESCHEDULE_REQUESTED" }, select: REPLACED_SELECT }) : null;
  const deskHeld = DESK_BOOKING_STATES.includes(replaced.bookingState) &&
    (await prisma.smartTask.count({ where: { dedupeKey: `${TASK_PREFIX}${replaced.id}`, status: { notIn: ["COMPLETED", "CANCELLED"] } } })) > 0;
  return { replaced, booked, deskHeld };
}

/** A slot the way Kyle and the client read it: "Tuesday, October 20, 10:00 AM (America/New_York)". */
function slotWords(at: Date | null, timezone: string | null): string {
  if (!at) return "an unscheduled time";
  const tz = timezone ?? "America/New_York";
  return `${at.toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${tz === "America/New_York" ? "ET" : tz})`;
}

const sameMinute = (a: Date | null | undefined, b: Date | null | undefined) =>
  !!a && !!b && Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);

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

/**
 * WHAT KYLE IS BEING ASKED TO DO (CP-04). One desk row per request (dedupeKey
 * `content-session-request-<id>`), but the job on it changes: a client's
 * cancellation used to reopen that row still titled "Book content session" with
 * "Book it in Aryeo" underneath, so a cancel read as a booking. The title and
 * the instruction now follow the mode.
 */
export type DeskMode = "BOOK" | "CANCEL" | "RESCHEDULE" | "RECOVER" | "FIX" | "UNDO_MOVE";

const DESK_TITLE: Record<DeskMode, string> = {
  BOOK: "Book content session",
  CANCEL: "Cancel content session",
  RESCHEDULE: "Move content session",
  RECOVER: "Check Aryeo for a hub booking",
  FIX: "Fix a hub booking in Aryeo",
  UNDO_MOVE: "Check a withdrawn move",
};

async function ensureDeskTask(requestId: string, mode: DeskMode = "BOOK", reason?: string | null): Promise<void> {
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId } });
  if (!r) return;
  const [client, month] = await Promise.all([
    prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true } }),
    prisma.contentMonth.findUnique({ where: { id: r.monthId }, select: { monthKey: true } }),
  ]);
  // TEST clients get no row on Kyle's real desk — except when a probe asks for
  // one, or when the hub really wrote to Aryeo for an authorised fixture (then
  // a real booking exists and a person must be able to find it). Without the
  // escape hatch this create/close path could only ever be read, never run:
  // `ensureDeskTask` returned early for the only clients we are allowed to
  // write to (review, Sep 17). The flag is set by a probe process, never in
  // production.
  // A desk MOVE of a booking the hub made counts as the hub having written:
  // the booking it moves is real, so the move must be findable too.
  const movesHubBooking = !!r.supersedesId && (await prisma.programSessionRequest.count({ where: { id: r.supersedesId, OR: [{ aryeoOrderId: { not: null } }, { currentAttemptId: { not: null } }] } })) > 0;
  if (isTestClientName(client?.name) && process.env.PROGRAM_DESK_TASKS_FOR_TEST !== "1" && !(r.aryeoOrderId || r.currentAttemptId || movesHubBooking)) return;
  const dedupeKey = `${TASK_PREFIX}${r.id}`;
  const when = r.slotStart
    ? `${r.slotStart.toLocaleString("en-US", { timeZone: r.timezone ?? "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${r.timezone ?? "ET"})`
    : "no slot picked";
  // WHICH session, on a package that owes more than one (A23, Jordan Sep 21
  // 2026). "Book content session" told Kyle nothing about whether this was the
  // first or the second half of a Pro month, and the two are different bookings
  // of the same four-hour product.
  const capacity = await sessionCapacity(r.enrollmentId, r.monthId).catch(() => null);
  // A24: the request's OWN session when it names one; a legacy row falls back
  // to "the next one" as before.
  const ordinal = capacity && capacity.sessionsPerMonth > 1 ? (r.sessionIndex ?? Math.min(capacity.confirmedSessions + 1, capacity.sessionsPerMonth)) : null;
  const ordinalLine = mode === "BOOK" && ordinal && capacity
    ? `Session ${ordinal} of ${capacity.sessionsPerMonth} — ${capacity.confirmedSessions} already confirmed for this month. Book the four-hour product again, as its own order; it is a second booking, not a longer one.`
    : null;
  // A18/A20: the earliest start the client was held to, from the request's own
  // snapshot of the gate (programMonths.preparationGate) — so a free-text ask
  // ("Tuesday afternoon") still tells Kyle the first time he may book.
  const { earliestStartLine } = await import("@/lib/programMonths");
  const earliestLine = mode === "BOOK" || mode === "RESCHEDULE" ? earliestStartLine(r) : null;
  const instruction: Record<DeskMode, string> = {
    BOOK: "Book it in Aryeo — the request flips to CONFIRMED on its own when the appointment appears (hourly), and the client sees the date.",
    CANCEL: `The client asked to cancel this session. Cancel ${r.aryeoAppointmentId ? `appointment ${r.aryeoAppointmentId}` : "the appointment"} in Aryeo — the request flips to CANCELLED on its own when Aryeo shows it cancelled.`,
    RESCHEDULE: `The client asked to move this session. Move ${r.aryeoAppointmentId ? `appointment ${r.aryeoAppointmentId}` : "it"} in Aryeo to the new time — the request confirms on its own when the appointment shows the new time.`,
    RECOVER: `The hub was booking this and could not tell whether Aryeo accepted it. Search Aryeo orders for the note "hub-session:${r.id}" before doing anything else.`,
    FIX: "The hub's booking needs a person in Aryeo. Once it is right, confirm the request on the client file.",
    UNDO_MOVE: "The client withdrew this move, so the session stays at its original time. If you had not moved it in Aryeo yet, just close this task. If you already moved it, move it back.",
  };
  const description = [
    `Content session request for ${month?.monthKey ?? "their month"} (${r.kind === "EXTRA_SESSION" ? "EXTRA session" : "package session"}).`,
    ordinalLine,
    `Time: ${when}`,
    earliestLine,
    r.creativeName ? `Creative the client picked: ${r.creativeName}` : null,
    r.locationText ? `Filming location: ${r.locationText}` : null,
    r.aryeoOrderId ? `Aryeo order: ${r.aryeoOrderId}` : null,
    r.notes ? r.notes : null,
    "",
    reason ? reason : null,
    // A07: when two real content bookings both fit, the reconcile refuses to
    // pick and says so HERE rather than leaving Kyle to wonder why an obviously
    // booked session never confirmed.
    r.matchState === "AMBIGUOUS" ? ambiguityLine(r.matchEvidenceJson) : null,
    instruction[mode],
    `Request ${r.id}`,
  ].filter((x): x is string => x != null).join("\n");
  const title = mode === "BOOK" && ordinal && capacity
    ? `${DESK_TITLE.BOOK} ${ordinal} of ${capacity.sessionsPerMonth} — ${client?.name ?? "client"}`
    : `${DESK_TITLE[mode]} — ${client?.name ?? "client"}`;
  const summary = clip(`${mode === "BOOK" ? "Requested" : mode === "CANCEL" ? "Cancel" : mode === "RESCHEDULE" ? "Move" : "Check"}: ${when}${r.locationText ? ` · ${r.locationText}` : ""}`, 200);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { title: title.slice(0, 140), summary, description, status: "OPEN", completedAt: null, priority: mode === "BOOK" ? "HIGH" : "URGENT" } });
    if (!r.taskId) await prisma.programSessionRequest.update({ where: { id: r.id }, data: { taskId: existing.id } });
    return;
  }
  const task = await prisma.smartTask.create({
    data: {
      taskType: "todo",
      title: title.slice(0, 140),
      summary,
      description, reasonCreated: mode === "BOOK" ? "Client requested a content session (persisted request)" : `Content session request needs a person (${mode.toLowerCase()})`, source: "portal", priority: mode === "BOOK" ? "HIGH" : "URGENT",
      dueAt: new Date(Date.now() + 24 * 3600_000), assignedKey: "kyle", clientId: client?.id ?? null, dedupeKey,
    },
    select: { id: true },
  });
  await prisma.programSessionRequest.update({ where: { id: r.id }, data: { taskId: task.id } });
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({ kind: "portal_session", title: `${DESK_TITLE[mode]} — ${client?.name ?? "a client"}`, body: clip(when, 140), href: "/tasks?tab=board", targets: [{ roles: ["OWNER", "ADMIN"] }], dedupeKey: `session-request-${r.id}-${mode.toLowerCase()}` });
  } catch { /* bell is best-effort */ }
}

/** The adapter's hand-over (sessionBooking.ts): the request's one desk row, in the given mode, carrying why. */
export async function handToDesk(requestId: string, mode: DeskMode, reason: string): Promise<void> {
  await ensureDeskTask(requestId, mode, reason);
}

export async function closeDeskTask(requestId: string, outcome: "COMPLETED" | "CANCELLED"): Promise<void> {
  await prisma.smartTask.updateMany({ where: { dedupeKey: `${TASK_PREFIX}${requestId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: outcome, completedAt: new Date() } });
}

export type CancelResult = { ok: boolean; status: string; message: string };

/**
 * Cancel a request (CP-04). Four shapes, each saying exactly what happened:
 *   · a client inside 24 hours of the slot → refused, with Kyle's number
 *     (Jordan: inside 24 hours it is a phone call, not a button);
 *   · a session the HUB booked, with session_booking on → the adapter cancels
 *     it in Aryeo and reads it back (sessionBooking.cancelHubBooking);
 *   · a hand-booked CONFIRMED session, or one the adapter is mid-way through
 *     booking → CANCEL_REQUESTED and Kyle's desk row, titled as a cancellation;
 *   · an ask nothing was booked for → CANCELLED, desk row closed.
 */
export async function cancelSessionRequest(requestId: string, by: string | null, reason?: string, opts: { actor?: "CLIENT" | "STAFF"; now?: Date } = {}): Promise<CancelResult> {
  const now = opts.now ?? new Date();
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { id: true, status: true, monthId: true, slotStart: true, timezone: true, bookingState: true, aryeoAppointmentId: true } });
  if (!r) throw new Error("Request not found.");
  if (["CANCELLED", "EXPIRED", "DECLINED"].includes(r.status)) return { ok: true, status: r.status, message: "That request is already closed." };
  const { INSIDE_24H_MESSAGE, within24hElapsed, hubBookedAttempt, cancelHubBooking, IN_FLIGHT_STATES } = await import("@/lib/sessionBooking");
  if (opts.actor === "CLIENT" && r.slotStart && (r.status === "CONFIRMED" || r.status === "RESCHEDULE_REQUESTED") && within24hElapsed(r.slotStart, now)) {
    return { ok: false, status: r.status, message: INSIDE_24H_MESSAGE };
  }
  if (r.status === "CONFIRMED" && (await isAutomationEnabled("session_booking")) && (await hubBookedAttempt(r))) {
    const c = await cancelHubBooking(r.id, { by, reason: reason ?? null, now });
    if (c.state !== "REFUSED") {
      await recalcProgramMonth(r.monthId);
      return { ok: c.ok, status: c.state === "DONE" ? "CANCELLED" : "CANCEL_REQUESTED", message: c.message };
    }
    // The guard refused (switch off for this client since): the desk cancels.
  }
  const inFlight = r.status === "REQUESTED" && (IN_FLIGHT_STATES as readonly string[]).includes(r.bookingState);
  // A CONFIRMED request has a real Aryeo appointment behind it, and one the
  // adapter is mid-way through may have one: the request is marked, and a
  // person cancels it in Aryeo (spec §19: confirm the provider result separately).
  const needsPerson = r.status === "CONFIRMED" || r.status === "RESCHEDULE_REQUESTED" || inFlight;
  await prisma.programSessionRequest.update({ where: { id: requestId }, data: { status: needsPerson ? "CANCEL_REQUESTED" : "CANCELLED", cancelledAt: now, cancelledBy: by, cancelReason: reason?.trim() || null } });
  await releaseCreativeHold(requestId, "CANCELLED", now);
  if (needsPerson) await ensureDeskTask(requestId, "CANCEL", inFlight ? "The hub was mid-way through booking this when the client cancelled. Check Aryeo for an order carrying the request's note, and cancel it if it exists." : null);
  else {
    // A PENDING MOVE WITHDRAWN (review, Sep 24 2026). Cancelling the new time
    // used to leave the booked session RESCHEDULE_REQUESTED for ever — no
    // buttons, no reconcile, its appointment unclaimed. The session it would
    // have replaced is still on the calendar, so it goes back to CONFIRMED.
    // Kyle's move task becomes a check: he may already have moved it.
    const moveTaskOpen = (await prisma.smartTask.count({ where: { dedupeKey: `${TASK_PREFIX}${requestId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } } })) > 0;
    const restored = await restoreMovedFrom(requestId);
    if (restored) {
      if (moveTaskOpen) await ensureDeskTask(requestId, "UNDO_MOVE", `The session stays at ${slotWords(restored.slotStart, restored.timezone)}${restored.aryeoAppointmentId ? ` (appointment ${restored.aryeoAppointmentId})` : ""}. The move to ${slotWords(r.slotStart, r.timezone)} was withdrawn.`);
      await recalcProgramMonth(r.monthId);
      return { ok: true, status: "CANCELLED", message: `Move withdrawn. Your session stays at ${slotWords(restored.slotStart, restored.timezone)}.` };
    }
    await closeDeskTask(requestId, "CANCELLED");
  }
  await recalcProgramMonth(r.monthId);
  return needsPerson
    ? { ok: true, status: "CANCEL_REQUESTED", message: "Cancellation requested. The session is on the calendar, so Kyle will take it off and confirm." }
    : { ok: true, status: "CANCELLED", message: "Cancelled." };
}

/**
 * Move a session (CP-04 — until now `supersedesId` had no caller, so the portal
 * had no reschedule at all). Refused inside 24 hours of the OLD time (Kyle's
 * number). A session the hub booked is moved in Aryeo and read back; any other
 * becomes a new request that replaces the old one, and Kyle's row says "move".
 */
export async function requestReschedule(
  requestId: string,
  newSlot: { startISO: string; endISO: string | null; locationText?: string | null },
  creative: { teamMemberId: string; name: string | null } | null,
  actor: SessionRequestActor,
  // A24/A18: the session the move is for and the gate the new time was offered
  // under (the portal reads both with sessionGate), snapshotted on the new row.
  opts: { now?: Date; sessionIndex?: number | null; gate?: CreateSessionRequestInput["gate"] } = {},
): Promise<{ ok: boolean; message: string; id?: string }> {
  const now = opts.now ?? new Date();
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId } });
  if (!r) return { ok: false, message: "That request isn't on your page." };
  if (!["REQUESTED", "CONFIRMED"].includes(r.status)) return { ok: false, message: "That request is already closed." };
  const { INSIDE_24H_MESSAGE, within24hElapsed, hubBookedAttempt, rescheduleHubBooking, IN_FLIGHT_STATES } = await import("@/lib/sessionBooking");
  const start = new Date(newSlot.startISO);
  if (!Number.isFinite(start.getTime())) return { ok: false, message: "Pick a time from the list." };
  // The session actually on the calendar: this row, or — for a move still
  // pending — the booked row it replaces. Inside 24 hours of THAT is a call.
  const { booked } = await whatItReplaces(r.id);
  if (actor.kind !== "STAFF" && r.slotStart && within24hElapsed(r.slotStart, now)) return { ok: false, message: INSIDE_24H_MESSAGE };
  if (actor.kind !== "STAFF" && booked?.slotStart && within24hElapsed(booked.slotStart, now)) return { ok: false, message: INSIDE_24H_MESSAGE };
  if (actor.kind !== "STAFF" && within24hElapsed(start, now)) return { ok: false, message: INSIDE_24H_MESSAGE };
  const { sessionSlotRefusal } = await import("@/lib/portal");
  const weekend = sessionSlotRefusal(start);
  if (weekend) return { ok: false, message: weekend };
  if (r.status === "REQUESTED" && (IN_FLIGHT_STATES as readonly string[]).includes(r.bookingState)) {
    return { ok: false, message: "We are booking that time right now. Give it a minute, then move it if you still need to." };
  }
  if (r.status === "CONFIRMED" && (await isAutomationEnabled("session_booking")) && (await hubBookedAttempt(r))) {
    const moved = await rescheduleHubBooking(r.id, start, { by: actor.kind === "STAFF" ? actor.userId : actor.kind === "CLIENT" ? actor.clientUserId : null, now });
    if (moved.state !== "REFUSED") {
      await recalcProgramMonth(r.monthId);
      return { ok: moved.ok, message: moved.message, id: r.id };
    }
  }
  const created = await createSessionRequest({
    enrollmentId: r.enrollmentId,
    monthId: r.monthId,
    slot: { startISO: start.toISOString(), endISO: newSlot.endISO, timezone: r.timezone, locationText: newSlot.locationText ?? r.locationText, notes: `Moved from ${slotWords((booked ?? r).slotStart, (booked ?? r).timezone)}.` },
    actor,
    kind: r.kind === "EXTRA_SESSION" ? "EXTRA_SESSION" : "CONTENT_SESSION",
    supersedesId: r.id,
    creative: creative ?? (r.creativeTeamMemberId ? { teamMemberId: r.creativeTeamMemberId, name: r.creativeName } : null),
    sessionIndex: opts.sessionIndex ?? r.sessionIndex ?? null,
    gate: opts.gate ?? null,
  });
  if (!created.ok) return { ok: false, message: created.reason };
  // The old booking still stands in Aryeo until a person moves it: the new
  // request's desk row says MOVE, not book (createSessionRequest writes it,
  // naming the booking — including when this row was itself a pending move).
  return { ok: true, message: booked ? "We have your new time. Kyle will move the session and confirm it." : created.message, id: created.id };
}

export async function declineSessionRequest(requestId: string, by: string | null, reason: string): Promise<void> {
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { monthId: true } });
  if (!r) throw new Error("Request not found.");
  await prisma.programSessionRequest.update({ where: { id: requestId }, data: { status: "DECLINED", cancelledAt: new Date(), cancelledBy: by, cancelReason: reason.trim() || "declined" } });
  await releaseCreativeHold(requestId, "DECLINED");
  await closeDeskTask(requestId, "CANCELLED");
  // The office said no to a new time: the session it would have moved stands.
  await restoreMovedFrom(requestId);
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
  await closeSuperseded(requestId);
  await recalcProgramMonth(r.monthId);
}

/**
 * A replacement confirmed: the booking it replaced is over (it was moved) —
 * but only when its appointment IS the one the replacement confirmed on, or is
 * gone. One left standing beside a NEW booking (Kyle booked the new time
 * instead of moving the old one, or the hub booked it) is still on a creative's
 * calendar, so the old row asks Kyle to cancel it rather than closing quietly
 * over a live appointment. Exported for the adapter's confirm (sessionBooking).
 */
export async function closeSuperseded(requestId: string): Promise<void> {
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { supersedesId: true, aryeoAppointmentId: true, slotStart: true, timezone: true } });
  if (!r?.supersedesId) return;
  const old = await prisma.programSessionRequest.findFirst({ where: { id: r.supersedesId, status: { in: ["RESCHEDULE_REQUESTED", "REQUESTED"] } }, select: { id: true, aryeoAppointmentId: true } });
  if (!old) return;
  const leftBehind = old.aryeoAppointmentId && old.aryeoAppointmentId !== r.aryeoAppointmentId
    ? await prisma.appointment.findUnique({ where: { aryeoId: old.aryeoAppointmentId }, select: { status: true, project: { select: { status: true } } } })
    : null;
  if (leftBehind && leftBehind.status !== "CANCELED" && leftBehind.project.status !== "CANCELLED") {
    await prisma.programSessionRequest.updateMany({ where: { id: old.id, status: { in: ["RESCHEDULE_REQUESTED", "REQUESTED"] } }, data: { status: "CANCEL_REQUESTED", cancelledAt: new Date(), cancelledBy: "aryeo-reconcile", cancelReason: "moved to a new booking; the old appointment is still on the calendar" } });
    await ensureDeskTask(old.id, "CANCEL", `This session moved to ${slotWords(r.slotStart, r.timezone)}${r.aryeoAppointmentId ? ` (appointment ${r.aryeoAppointmentId})` : ""}, which is now booked. The old appointment ${old.aryeoAppointmentId} is still on the calendar, so the creative could be sent to both.`);
    return;
  }
  await prisma.programSessionRequest.updateMany({ where: { id: old.id, status: { in: ["RESCHEDULE_REQUESTED", "REQUESTED"] } }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "moved to the new time" } });
  await closeDeskTask(old.id, "COMPLETED");
}

/**
 * A pending MOVE that will not happen (the client withdrew it, the office
 * declined the new time, or it expired): the session it would have replaced is
 * still on the calendar, so that row goes back to CONFIRMED — with its buttons
 * — unless another replacement is still pursuing the move. Returns it, restored.
 */
async function restoreMovedFrom(requestId: string): Promise<{ id: string; slotStart: Date | null; timezone: string | null; aryeoAppointmentId: string | null } | null> {
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { supersedesId: true } });
  if (!r?.supersedesId) return null;
  const still = await prisma.programSessionRequest.count({ where: { supersedesId: r.supersedesId, id: { not: requestId }, status: { in: ["REQUESTED", "CONFIRMED"] } } });
  if (still) return null;
  const n = await prisma.programSessionRequest.updateMany({ where: { id: r.supersedesId, status: "RESCHEDULE_REQUESTED" }, data: { status: "CONFIRMED" } });
  if (!n.count) return null;
  return prisma.programSessionRequest.findUnique({ where: { id: r.supersedesId }, select: { id: true, slotStart: true, timezone: true, aryeoAppointmentId: true } });
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
//   PROVIDER_ORDER     (CP-04) the appointment sits on the Aryeo ORDER the hub
//                      created for this request. The order is this request's
//                      alone, so whatever Kyle books on it by hand — after the
//                      adapter made the order and Aryeo refused the appointment
//                      — is this session, at whatever time he chose.
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
  project: { contentMonthId: string | null; aryeoOrderId?: string | null; deliverables: { label: string | null }[] };
};

export type SessionMatchKind = "PROVIDER_ID" | "PROVIDER_ORDER" | "MONTH_LINK" | "CONTENT_DELIVERABLE";

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
  req: { monthId: string; monthKey: string | null; slotStart: Date | null; createdAt: Date; aryeoOrderId?: string | null },
  appts: ApptRow[],
  claimed: ReadonlySet<string>,
): SessionMatchDecision {
  // The hub's own order decides it, before any timing or content reading.
  if (req.aryeoOrderId) {
    const onOurOrder = appts.filter((a) => !claimed.has(a.aryeoId) && !!a.startAt && a.project.aryeoOrderId === req.aryeoOrderId);
    if (onOurOrder.length) {
      return {
        eligible: onOurOrder.map((a) => ({ a, kind: "PROVIDER_ORDER" as const, why: "it is on the Aryeo order the hub created for this request" })),
        nearMisses: [],
        verdict: onOurOrder.length === 1 ? "CONFIRM" : "AMBIGUOUS",
      };
    }
  }
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
 *   REQUESTED move of a booked session + that booking now at the new time → CONFIRMED;
 *   REQUESTED + two that both fit → AMBIGUOUS, left for Kyle;
 *   CONFIRMED / RESCHEDULE_REQUESTED whose appointment was cancelled in Aryeo → CANCELLED;
 *   RESCHEDULE_REQUESTED that no replacement is pursuing any more → CONFIRMED;
 *   REQUESTED whose slot passed 2 days ago with nothing booked → EXPIRED.
 */
/** Stamped on lastError so a passed, unsettled booking is handed over once, not hourly. */
const RECOVER_RAISED = "[recover raised]";

export async function reconcileSessionRequests(opts: { now?: Date } = {}): Promise<{ checked: number; confirmed: number; cancelled: number; expired: number; ambiguous: number }> {
  const now = opts.now ?? new Date();
  const open = await prisma.programSessionRequest.findMany({ where: { status: { in: ["REQUESTED", "CONFIRMED", "CANCEL_REQUESTED", "RESCHEDULE_REQUESTED"] } } });
  let confirmed = 0, cancelled = 0, expired = 0, ambiguous = 0;
  const { IN_FLIGHT_STATES } = await import("@/lib/sessionBooking");
  // HALF-MADE PROVIDER BOOKINGS ARE NOT INFERRED OR EXPIRED (CP-04). A request
  // the adapter is mid-way through — or whose Aryeo copy did not match — is the
  // adapter's and Kyle's, not the matcher's: confirming it off a nearby
  // appointment, or expiring it two days after its slot, would erase the only
  // record that an order may exist. Once its slot has passed it goes to the
  // desk as RECOVER instead, once.
  const heldByAdapter = new Set<string>([...IN_FLIGHT_STATES, "MISMATCH"]);
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
  //
  // A booking being MOVED or CANCELLED is still claimed (review, Sep 24 2026).
  // Only CONFIRMED rows used to count, so the moment a hand-booked session went
  // RESCHEDULE_REQUESTED its appointment was free again — and the replacement,
  // asking for 11:30, confirmed onto the SAME appointment still at 10:00 (inside
  // the two-hour window, and attached to the month). The portal said Booked at
  // 11:30, Kyle's move task closed, and Aryeo still had 10:00. A move now
  // confirms on its own appointment only when Aryeo shows the NEW time.
  const claimed = new Set(
    (await prisma.programSessionRequest.findMany({ where: { status: { in: ["CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"] }, aryeoAppointmentId: { not: null } }, select: { aryeoAppointmentId: true } }))
      .map((x) => x.aryeoAppointmentId!)
      .filter(Boolean),
  );
  for (const r of open) {
    if (r.status === "REQUESTED" && heldByAdapter.has(r.bookingState)) {
      if (r.slotStart && now.getTime() - r.slotStart.getTime() > 2 * 864e5 && !(r.lastError ?? "").includes(RECOVER_RAISED)) {
        await ensureDeskTask(r.id, "RECOVER", `The slot has passed and the hub's booking never settled (booking state ${r.bookingState}).`).catch(() => {});
        await prisma.programSessionRequest.update({ where: { id: r.id }, data: { lastError: `${(r.lastError ?? "").slice(0, 900)} ${RECOVER_RAISED}`.trim() } });
      }
      continue;
    }
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
          await closeSuperseded(r.id);
          confirmed++; touched.add(r.monthId);
          continue;
        }
      }
      // A MOVE OF A BOOKED SESSION: the appointment it replaces confirms it
      // only once Aryeo shows that appointment at the new time, to the minute.
      // Until then Kyle's move task stays open and the request says requested.
      const movedFrom = r.supersedesId && r.slotStart
        ? await prisma.programSessionRequest.findFirst({ where: { id: r.supersedesId, status: "RESCHEDULE_REQUESTED", aryeoAppointmentId: { not: null } }, select: { aryeoAppointmentId: true } })
        : null;
      if (movedFrom?.aryeoAppointmentId) {
        const x = await prisma.appointment.findUnique({ where: { aryeoId: movedFrom.aryeoAppointmentId }, select: { projectId: true, status: true, startAt: true, project: { select: { status: true } } } });
        if (x && x.status !== "CANCELED" && x.project.status !== "CANCELLED" && sameMinute(x.startAt, r.slotStart)) {
          claimed.add(movedFrom.aryeoAppointmentId);
          await prisma.programSessionRequest.update({
            where: { id: r.id },
            data: { status: "CONFIRMED", projectId: x.projectId, aryeoAppointmentId: movedFrom.aryeoAppointmentId, confirmedAt: now, confirmedBy: "aryeo-reconcile", matchState: "MOVED", matchEvidenceJson: JSON.stringify({ chose: movedFrom.aryeoAppointmentId, why: "the booked session this replaces now shows the new time in Aryeo" }) },
          });
          await closeDeskTask(r.id, "COMPLETED");
          await closeSuperseded(r.id);
          confirmed++; touched.add(r.monthId);
          continue;
        }
      }
      const month = await prisma.contentMonth.findUnique({ where: { id: r.monthId }, select: { monthKey: true } });
      const appts: ApptRow[] = await prisma.appointment.findMany({
        where: { project: { clientId: r.clientId, status: { not: "CANCELLED" } }, status: { not: "CANCELED" }, startAt: { not: null } },
        select: { id: true, aryeoId: true, startAt: true, projectId: true, project: { select: { contentMonthId: true, aryeoOrderId: true, deliverables: { where: { removedFromOrderAt: null }, select: { label: true } } } } },
        orderBy: { startAt: "asc" },
      });

      const decision = chooseSessionAppointment(
        { monthId: r.monthId, monthKey: month?.monthKey ?? null, slotStart: r.slotStart, createdAt: r.createdAt, aryeoOrderId: r.aryeoOrderId },
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
        await closeSuperseded(r.id);
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
        await releaseCreativeHold(r.id, "EXPIRED", now);
        await closeDeskTask(r.id, "CANCELLED");
        expired++; touched.add(r.monthId);
      }
      continue;
    }
    // CONFIRMED / CANCEL_REQUESTED / RESCHEDULE_REQUESTED: follow the provider.
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
        // A booking being MOVED was cancelled instead: there is nothing left
        // to move, so the pending new time is a booking to make.
        if (r.status === "RESCHEDULE_REQUESTED") {
          const next = await prisma.programSessionRequest.findFirst({ where: { supersedesId: r.id, status: "REQUESTED" }, select: { id: true } });
          if (next) await ensureDeskTask(next.id, "BOOK", `The old appointment ${r.aryeoAppointmentId} was cancelled in Aryeo, so there is nothing to move: book the new time.`).catch(() => {});
        }
        cancelled++; touched.add(r.monthId);
        continue;
      }
    }
    // A MOVE NOBODY IS PURSUING (review, Sep 24 2026): its replacement was
    // withdrawn, declined or expired. The booked session still stands, so the
    // row goes back to CONFIRMED instead of waiting for ever; a replacement
    // that confirmed without closing it is closed now.
    if (r.status === "RESCHEDULE_REQUESTED") {
      const next = await prisma.programSessionRequest.findFirst({ where: { supersedesId: r.id, status: { in: ["REQUESTED", "CONFIRMED"] } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true } });
      if (next?.status === "CONFIRMED") { await closeSuperseded(next.id); touched.add(r.monthId); }
      else if (!next) { await prisma.programSessionRequest.updateMany({ where: { id: r.id, status: "RESCHEDULE_REQUESTED" }, data: { status: "CONFIRMED" } }); touched.add(r.monthId); }
    }
  }
  for (const m of touched) await recalcProgramMonth(m, { now });
  return { checked: open.length, confirmed, cancelled, expired, ambiguous };
}

/**
 * Provider booking driver — only when `session_booking` is ON. The real one
 * lives in sessionBooking.ts (CP-04); this name is kept for the cron and every
 * caller that already imports it. With the switch off it returns `skipped`
 * having made no call, and with nothing to do it records a clean run — not an
 * error string, which is what the old RECONCILE-everything body wrote.
 */
export async function driveSessionBookings(opts: { max?: number; now?: Date; budgetMs?: number } = {}) {
  const { driveSessionBookings: drive } = await import("@/lib/sessionBooking");
  return drive(opts);
}

export type SessionRequestView = {
  id: string; status: string; kind: string; slotStart: Date | null; slotEnd: Date | null; timezone: string | null; locationText: string | null;
  projectId: string | null; aryeoAppointmentId: string | null; confirmedAt: Date | null; cancelledAt: Date | null; cancelReason: string | null; createdAt: Date;
  /** CP-04: where the provider booking stands, and who the client picked. */
  bookingState: string; creativeName: string | null; changePending: boolean;
  /** What the portal shows: "Requested, awaiting confirmation" until Aryeo says otherwise. */
  label: string;
};
/**
 * REQUESTED AND CONFIRMED ARE DIFFERENT SENTENCES, everywhere (CP-04). Only a
 * CONFIRMED request — Aryeo's own appointment, read back — says Booked. While
 * the adapter works the client sees that it is working, and a slot taken
 * between the pick and the booking says so and asks for another time.
 */
export function sessionRequestLabel(status: string, bookingState?: string | null): string {
  if (status === "REQUESTED") {
    switch (bookingState) {
      case "QUEUED": case "RUNNING": return "Booking your session";
      case "ORDER_CREATED": case "APPT_PENDING": case "UNKNOWN": return "Confirming with the calendar";
      case "CONFLICT": return "That time was just taken. Pick another time.";
      default: break;
    }
  }
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
    bookingState: r.bookingState, creativeName: r.creativeName, changePending: !!r.pendingChangeJson,
    label: r.pendingChangeJson && r.status === "CONFIRMED" ? "Moving your session" : sessionRequestLabel(r.status, r.bookingState),
  }));
}
