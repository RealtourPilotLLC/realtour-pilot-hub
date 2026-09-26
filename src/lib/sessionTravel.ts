import "server-only";
import { prisma } from "@/lib/prisma";
import { etAt, etDayKey } from "@/lib/datetime";
import type { PortalSlotDay } from "@/lib/portal";

// ---------------------------------------------------------------------------
// TRAVEL BETWEEN FILMING ADDRESSES (§6.6 W02 / A22 / A23, Sep 25 2026).
//
// What the portal offered before this: Aryeo's availability for the package's
// duration and the product's creatives — the right DAY and the right LENGTH,
// but asked with no destination at all (Aryeo's scheduling routes take none
// before an order exists: batch 0 read the whole spec). So a 12:00 start was
// offered to a client in Doylestown when the same videographer was filming in
// West Chester until 12:00, an hour's drive away, and every destination got
// identical slots.
//
// Jordan, Sep 24: "Aryeo's scheduling API should show the live availability
// and allow travel time between one address to another." Sep 25, asked whether
// the hub may estimate it meanwhile: "Yes, estimate drive time." So:
//
//   · A slot fits a creative only if they can get there and get away:
//       prevEnd + drive(prev → here) + buffer  <=  start
//       end + drive(here → next) + buffer      <=  nextStart
//     where prev/next are that creative's appointments on the same ET day (the
//     hub's own Appointment rows, and every session request already asked of
//     or booked with them — a request is a booking in all but name).
//   · drive = OSRM's fastest route (travel.driveMinutesStrict: 5 s, no guess),
//     memoised for the length of one request. buffer = session_booking's
//     `travelBufferMinutes` (default 15), editable without a deploy.
//   · A slot that CANNOT be checked (a neighbour with no map location, OSRM not
//     answering, a creative whose calendar the hub cannot see because no
//     TeamMember maps them yet) is labelled UNCHECKED: it is still offered, with Kyle
//     confirming it by hand. It is never auto-booked and never called
//     travel-validated (§6.6: "Do not label date-and-duration-only slots
//     travel-validated").
//   · HUB_DRIVE is the default travelSource. ARYEO_APPOINTMENT is the adapter
//     for Aryeo's own appointment-scoped availability, switched on only if the
//     supervised test proves Aryeo counts drive time (integrations/aryeo:
//     timeslotsForAppointment).
//
// No mileage threshold is introduced (Jordan chose travel time over distance),
// and nothing here moves an appointment.
// ---------------------------------------------------------------------------

export type TravelSource = "HUB_DRIVE" | "ARYEO_APPOINTMENT";
/** What a slot's travel was checked against. UNCHECKED = a person confirms it. */
export type TravelLabel = "HUB_DRIVE" | "ARYEO_APPOINTMENT" | "UNCHECKED";

export const TRAVEL_DEFAULTS = { travelBufferMinutes: 15, travelSource: "HUB_DRIVE" as TravelSource };

export type LatLng = { lat: number; lng: number };

/** One thing already on a creative's day. `at` null = we do not know where it is. */
export type TravelNeighbour = { ref: string; start: Date; end: Date; at: LatLng | null; source: "APPOINTMENT" | "REQUEST" | "ARYEO" };

/**
 * Each creative's neighbours, plus the creatives whose calendar the hub cannot
 * see: no TeamMember row maps their Aryeo team-member id (a new hire before
 * someone presses "Sync now", a member Aryeo has no email for). Their
 * Appointment rows are unreachable, so an empty day for them means "unknown",
 * never "nothing else is on the creative's day".
 */
export type NeighbourMap = Map<string, TravelNeighbour[]> & { unlinked: Set<string> };

/** The words for a creative whose calendar the hub cannot see. */
const UNLINKED_REASON = "travel not checked: the creative's calendar is not linked in the hub yet (no team-member record for them), so their other shoots that day are unknown";

/** An empty (or all-clear) day for an unlinked creative is UNCHECKED — a no from what IS known stays a no. */
function unlinkedFit(fit: TravelFit): TravelFit {
  return fit.fits === false ? fit : { ...fit, label: "UNCHECKED", fits: null, reason: UNLINKED_REASON };
}

/** Minutes of driving from a to b, or null when it could not be measured. */
export type DriveFn = (a: LatLng, b: LatLng) => Promise<number | null>;

export type TravelFit = {
  /** HUB_DRIVE = measured; UNCHECKED = could not be (see reason). */
  label: "HUB_DRIVE" | "UNCHECKED";
  /** null when unchecked. */
  fits: boolean | null;
  /** Staff words: why it fits, does not, or could not be checked. */
  reason: string;
  prev: { ref: string; endISO: string; driveMinutes: number | null } | null;
  next: { ref: string; startISO: string; driveMinutes: number | null } | null;
  bufferMinutes: number;
};

/** The session's config, read whether or not the switch is ON: the buffer governs
 *  the slots every client is OFFERED, desk-assisted or not, so Jordan can edit it
 *  before anyone self-books. */
export async function travelConfig(): Promise<{ bufferMinutes: number; source: TravelSource }> {
  const row = await prisma.programAutomation.findUnique({ where: { key: "session_booking" }, select: { configJson: true } }).catch(() => null);
  let cfg: Record<string, unknown> = {};
  try { cfg = row?.configJson ? (JSON.parse(row.configJson) as Record<string, unknown>) : {}; } catch { cfg = {}; }
  const buf = Number(cfg.travelBufferMinutes);
  return {
    bufferMinutes: Number.isFinite(buf) && buf >= 0 && buf <= 240 ? Math.round(buf) : TRAVEL_DEFAULTS.travelBufferMinutes,
    source: cfg.travelSource === "ARYEO_APPOINTMENT" ? "ARYEO_APPOINTMENT" : "HUB_DRIVE",
  };
}

/** OSRM, strict, memoised for one request: the same pair is asked once, even
 *  when two slots ask for it at the same moment. */
export function driveMemo(): DriveFn {
  const seen = new Map<string, Promise<number | null>>();
  const k = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  return (a, b) => {
    const key = `${k(a)}>${k(b)}`;
    let hit = seen.get(key);
    if (!hit) {
      hit = import("@/lib/travel").then((t) => t.driveMinutesStrict(a.lat, a.lng, b.lat, b.lng)).then((r) => (r ? r.minutes : null)).catch(() => null);
      seen.set(key, hit);
    }
    return hit;
  };
}

const MIN = 60_000;
const hhmm = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

/**
 * THE RULE, pure: does [start, end] at `dest` fit between this creative's
 * neighbours on the same ET day? Any overlap is a no. The nearest appointment
 * before and the nearest after decide the rest; one that cannot be placed on a
 * map, or a drive OSRM would not measure, makes the answer UNCHECKED (unless
 * the other side already says no).
 */
export async function fitBetween(
  neighbours: TravelNeighbour[],
  slot: { start: Date; end: Date; dest: LatLng },
  bufferMinutes: number,
  drive: DriveFn,
): Promise<TravelFit> {
  const day = etDayKey(slot.start);
  const same = neighbours.filter((n) => etDayKey(n.start) === day || etDayKey(n.end) === day);
  const base = { prev: null, next: null, bufferMinutes } as Pick<TravelFit, "prev" | "next" | "bufferMinutes">;
  const clash = same.find((n) => n.start < slot.end && n.end > slot.start);
  if (clash) return { ...base, label: "HUB_DRIVE", fits: false, reason: `the creative is already booked ${hhmm(clash.start)}–${hhmm(clash.end)} ET` };
  const before = same.filter((n) => n.end <= slot.start).sort((a, b) => b.end.getTime() - a.end.getTime())[0] ?? null;
  const after = same.filter((n) => n.start >= slot.end).sort((a, b) => a.start.getTime() - b.start.getTime())[0] ?? null;
  if (!before && !after) return { ...base, label: "HUB_DRIVE", fits: true, reason: "nothing else is on the creative's day" };

  const unchecked: string[] = [];
  const refusals: string[] = [];
  let prev: TravelFit["prev"] = null;
  let next: TravelFit["next"] = null;
  if (before) {
    const m = before.at ? await drive(before.at, slot.dest) : null;
    prev = { ref: before.ref, endISO: before.end.toISOString(), driveMinutes: m == null ? null : Math.round(m) };
    if (!before.at) unchecked.push(`their ${hhmm(before.start)} appointment has no map location`);
    else if (m == null) unchecked.push("the drive from their earlier appointment could not be measured");
    else if (before.end.getTime() + (m + bufferMinutes) * MIN > slot.start.getTime()) {
      refusals.push(`${Math.round(m)} minutes' drive plus ${bufferMinutes} after their appointment ending ${hhmm(before.end)} ET`);
    }
  }
  if (after) {
    const m = after.at ? await drive(slot.dest, after.at) : null;
    next = { ref: after.ref, startISO: after.start.toISOString(), driveMinutes: m == null ? null : Math.round(m) };
    if (!after.at) unchecked.push(`their ${hhmm(after.start)} appointment has no map location`);
    else if (m == null) unchecked.push("the drive to their next appointment could not be measured");
    else if (slot.end.getTime() + (m + bufferMinutes) * MIN > after.start.getTime()) {
      refusals.push(`${Math.round(m)} minutes' drive plus ${bufferMinutes} before their ${hhmm(after.start)} ET appointment`);
    }
  }
  if (refusals.length) return { label: "HUB_DRIVE", fits: false, reason: `no room for the drive: ${refusals.join("; ")}`, prev, next, bufferMinutes };
  if (unchecked.length) return { label: "UNCHECKED", fits: null, reason: `travel not checked: ${unchecked.join("; ")}`, prev, next, bufferMinutes };
  return { label: "HUB_DRIVE", fits: true, reason: "the drives before and after fit", prev, next, bufferMinutes };
}

/** A request is on a creative's calendar when it is booked (or being moved or
 *  cancelled — still there until that lands), or while the HUB is booking it.
 *  A desk ask Kyle has not booked yet is not: Aryeo shows it the moment he does. */
const ON_CALENDAR = ["CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"];
const HUB_BOOKING = ["QUEUED", "RUNNING", "ORDER_CREATED", "APPT_PENDING", "UNKNOWN"];
const pt = (lat: number | null | undefined, lng: number | null | undefined): LatLng | null =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

/**
 * Everything the HUB knows is on these creatives' calendars in [from, to):
 * their Appointment rows (hourly from Aryeo) and the session requests with
 * them that are booked or that the hub is booking right now (the design's
 * "in-flight or confirmed"). A request that is also an appointment is one
 * neighbour. Where each is: the exact address the client gave (plan, then the
 * CP-05 session address), else the job's own map pin.
 */
export async function localNeighbours(opts: {
  creativeTeamMemberIds: string[]; from: Date; to: Date; excludeRequestId?: string | null; excludeAppointmentIds?: string[];
  /**
   * ALL (the offer): every request the hub is booking counts, so a slot another
   * client is being booked into is not offered twice. COMMITTED (the adapter,
   * just before it writes): a request still queued or rechecking counts only
   * once it holds the creative's day (sessionBooking.takeCreativeHold) —
   * otherwise two queued requests would each refuse the other and neither
   * would book. The hold step itself catches one that appears meanwhile.
   */
  inFlight?: "ALL" | "COMMITTED";
}): Promise<NeighbourMap> {
  const out = Object.assign(new Map<string, TravelNeighbour[]>(), { unlinked: new Set<string>() }) as NeighbourMap;
  const ids = [...new Set(opts.creativeTeamMemberIds.filter(Boolean))];
  for (const id of ids) out.set(id, []);
  if (!ids.length) return out;
  // The session being checked is never its own neighbour — as a request, or as
  // the appointment that request (or a CP-05 address change) is about.
  const skipAppts = new Set(opts.excludeAppointmentIds ?? []);
  if (opts.excludeRequestId) {
    const own = await prisma.programSessionRequest.findUnique({ where: { id: opts.excludeRequestId }, select: { aryeoAppointmentId: true } });
    if (own?.aryeoAppointmentId) skipAppts.add(own.aryeoAppointmentId);
  }
  const team = await prisma.teamMember.findMany({ where: { aryeoTeamMemberId: { in: ids } }, select: { id: true, aryeoTeamMemberId: true } });
  const tmOf = new Map(team.map((t) => [t.id, t.aryeoTeamMemberId!]));
  // A creative Aryeo offers but the hub has no TeamMember for: their
  // Appointment rows cannot be found (they are joined through that row), so
  // their day is unknown, not empty (batch-3 review, Sep 25 2026).
  const linked = new Set(team.map((t) => t.aryeoTeamMemberId));
  for (const id of ids) if (!linked.has(id)) out.unlinked.add(id);
  const [appts, requests] = await Promise.all([
    team.length
      ? prisma.appointment.findMany({
          where: { assignedToId: { in: team.map((t) => t.id) }, status: { not: "CANCELED" }, startAt: { gte: new Date(opts.from.getTime() - 12 * 3_600_000), lt: opts.to } },
          select: { aryeoId: true, startAt: true, endAt: true, durationMin: true, assignedToId: true, project: { select: { lat: true, lng: true, status: true } } },
        })
      : [],
    prisma.programSessionRequest.findMany({
      where: {
        creativeTeamMemberId: { in: ids },
        OR: [{ status: { in: ON_CALENDAR } }, { status: "REQUESTED", bookingState: { in: HUB_BOOKING } }],
        slotStart: { gte: new Date(opts.from.getTime() - 12 * 3_600_000), lt: opts.to },
        ...(opts.excludeRequestId ? { id: { not: opts.excludeRequestId } } : {}),
      },
      select: { id: true, status: true, bookingState: true, creativeTeamMemberId: true, slotStart: true, slotEnd: true, planId: true, aryeoAppointmentId: true, supersedesId: true },
    }),
  ]);
  if (opts.inFlight === "COMMITTED") {
    const early = requests.filter((r) => r.status === "REQUESTED" && (r.bookingState === "QUEUED" || r.bookingState === "RUNNING"));
    if (early.length) {
      const held = new Set((await prisma.programCreativeHold.findMany({ where: { requestId: { in: early.map((r) => r.id) }, releasedAt: null }, select: { requestId: true } })).map((h) => h.requestId));
      for (let i = requests.length - 1; i >= 0; i--) {
        const r = requests[i];
        if (r.status === "REQUESTED" && (r.bookingState === "QUEUED" || r.bookingState === "RUNNING") && !held.has(r.id)) requests.splice(i, 1);
      }
    }
  }
  // Where each session is: the plan the client filled in (exact, geocoded),
  // then an exact address given after booking (CP-05), then the job's pin.
  const planIds = [...new Set(requests.map((r) => r.planId).filter((x): x is string => !!x))];
  const plans = planIds.length ? await prisma.programSessionPlan.findMany({ where: { id: { in: planIds } }, select: { id: true, latitude: true, longitude: true } }) : [];
  const planAt = new Map(plans.map((p) => [p.id, pt(p.latitude, p.longitude)]));
  const apptKeys = appts.map((a) => `appt:${a.aryeoId}`);
  const addrRows = apptKeys.length || requests.length
    ? await prisma.programSessionAddress.findMany({
        where: { OR: [{ sessionKey: { in: apptKeys } }, { requestId: { in: requests.map((r) => r.id) } }], submittedAt: { not: null } },
        select: { sessionKey: true, requestId: true, latitude: true, longitude: true },
      })
    : [];
  const addrByKey = new Map(addrRows.map((a) => [a.sessionKey, pt(a.latitude, a.longitude)]));
  const addrByReq = new Map(addrRows.filter((a) => a.requestId).map((a) => [a.requestId!, pt(a.latitude, a.longitude)]));

  const reqByAppt = new Map(requests.filter((r) => r.aryeoAppointmentId).map((r) => [r.aryeoAppointmentId!, r]));
  const used = new Set<string>();
  for (const a of appts) {
    if (!a.startAt || a.project.status === "CANCELLED" || skipAppts.has(a.aryeoId)) continue;
    const tm = a.assignedToId ? tmOf.get(a.assignedToId) : undefined;
    if (!tm) continue;
    const req = reqByAppt.get(a.aryeoId);
    if (req) used.add(req.id);
    const end = a.endAt ?? new Date(a.startAt.getTime() + (a.durationMin ?? 120) * MIN);
    const at = addrByKey.get(`appt:${a.aryeoId}`) ?? (req?.planId ? planAt.get(req.planId) : null) ?? (req ? addrByReq.get(req.id) : null) ?? pt(a.project.lat, a.project.lng);
    out.get(tm)?.push({ ref: `appt:${a.aryeoId}`, start: a.startAt, end, at: at ?? null, source: "APPOINTMENT" });
  }
  // A pending MOVE stands in for the booking it replaces: the old time is
  // still on the calendar until the move lands, so both are neighbours.
  for (const r of requests) {
    if (used.has(r.id) || !r.slotStart || !r.creativeTeamMemberId) continue;
    const end = r.slotEnd ?? new Date(r.slotStart.getTime() + 2 * 3_600_000);
    const at = (r.planId ? planAt.get(r.planId) : null) ?? addrByReq.get(r.id) ?? null;
    out.get(r.creativeTeamMemberId)?.push({ ref: `request:${r.id}`, start: r.slotStart, end, at, source: "REQUEST" });
  }
  return out;
}

/**
 * ONE slot, for ONE creative, against their day. `fresh` also reads that day
 * from Aryeo (the booking adapter, just before it writes); the portal's offer
 * uses the hub's own rows. A failed fresh read is reported (`readFailed`) so
 * the caller retries rather than books on a guess.
 */
export async function travelFit(opts: {
  creativeTeamMemberId: string;
  start: Date;
  end: Date;
  dest: LatLng;
  now?: Date;
  excludeRequestId?: string | null;
  excludeAppointmentIds?: string[];
  /** read that creative's day from Aryeo too (booking time). */
  fresh?: { userId: string | null } | null;
  bufferMinutes?: number;
  drive?: DriveFn;
}): Promise<TravelFit & { readFailed?: boolean; neighbours: number; considered: string[] }> {
  const day = etDayKey(opts.start);
  const [y, m, d] = day.split("-").map(Number);
  const from = etAt(day, 0);
  const to = etAt(new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10), 0);
  const bufferMinutes = opts.bufferMinutes ?? (await travelConfig()).bufferMinutes;
  const localMap = await localNeighbours({
    creativeTeamMemberIds: [opts.creativeTeamMemberId], from, to, excludeRequestId: opts.excludeRequestId, excludeAppointmentIds: opts.excludeAppointmentIds,
    inFlight: opts.fresh ? "COMMITTED" : "ALL",
  });
  const local = localMap.get(opts.creativeTeamMemberId) ?? [];
  let neighbours = local;
  if (opts.fresh) {
    try {
      const { AryeoBooking } = await import("@/lib/integrations/aryeo");
      const live = await AryeoBooking.creativeDayAppointments({ teamMemberId: opts.creativeTeamMemberId, userId: opts.fresh.userId, dayStart: from, dayEnd: to });
      // Our own booking in progress may already be on Aryeo (a recovered order):
      // the request being checked is never its own neighbour.
      const own = opts.excludeRequestId
        ? (await prisma.programSessionRequest.findUnique({ where: { id: opts.excludeRequestId }, select: { aryeoAppointmentId: true } }))?.aryeoAppointmentId ?? null
        : null;
      const mine = new Set([...(own ? [own] : []), ...(opts.excludeAppointmentIds ?? [])]);
      const known = new Set(local.map((n) => n.ref));
      for (const a of live) {
        if (!a.start_at || mine.has(a.id)) continue;
        const start = new Date(a.start_at);
        const end = a.end_at ? new Date(a.end_at) : new Date(start.getTime() + 2 * 3_600_000);
        const ref = `appt:${a.id}`;
        if (known.has(ref)) {
          // Aryeo's own copy wins on TIME (the local row can be an hour old);
          // the hub's exact address wins on PLACE when Aryeo has only an area.
          neighbours = neighbours.map((n) => (n.ref === ref ? { ...n, start, end, at: n.at ?? pt(a.lat, a.lng) } : n));
        } else {
          neighbours = [...neighbours, { ref, start, end, at: pt(a.lat, a.lng), source: "ARYEO" }];
        }
      }
    } catch (e) {
      return { label: "UNCHECKED", fits: null, reason: `could not read the creative's day from Aryeo (${e instanceof Error ? e.message : String(e)})`, prev: null, next: null, bufferMinutes, readFailed: true, neighbours: local.length, considered: local.map((n) => n.ref) };
    }
  }
  const measured = await fitBetween(neighbours, { start: opts.start, end: opts.end, dest: opts.dest }, bufferMinutes, opts.drive ?? driveMemo());
  // The FRESH read (the adapter) reaches Aryeo by team-member id, whatever the
  // hub's own rows say; without it an unlinked creative's day is unknown.
  const fit = localMap.unlinked.has(opts.creativeTeamMemberId) && !opts.fresh ? unlinkedFit(measured) : measured;
  return { ...fit, neighbours: neighbours.length, considered: neighbours.map((n) => n.ref) };
}

/** A slot day with every start's travel label and, per creative, whether they can make it. */
export type TravelSlotDay = PortalSlotDay & {
  slotTravel: Record<string, TravelLabel>;
  /** per start: creative team-member id → label (a creative who cannot make it is absent). */
  slotCreativeTravel: Record<string, Record<string, TravelLabel>>;
};

/**
 * THE OFFER, per destination (§6.6 W02). The base days stay the shared,
 * cached answer from Aryeo (programSlotDays, keyed by product and length); this
 * runs per destination on top of it and never writes the cache. A creative who
 * cannot make a start is dropped from it; a start nobody can make is dropped;
 * a start nobody could be CHECKED for stays, labelled UNCHECKED.
 */
export async function annotateSlotDays(
  days: PortalSlotDay[],
  opts: { dest: LatLng; durationMin: number; excludeRequestId?: string | null; bufferMinutes?: number; drive?: DriveFn },
): Promise<TravelSlotDay[]> {
  if (!days.length) return [];
  const bufferMinutes = opts.bufferMinutes ?? (await travelConfig()).bufferMinutes;
  const drive = opts.drive ?? driveMemo();
  const tms = [...new Set(days.flatMap((d) => Object.values(d.slotCreatives ?? {}).flat().map((c) => c.teamMemberId)))];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const from = etAt(sorted[0].date, 0);
  const last = sorted[sorted.length - 1].date;
  const [y, m, d] = last.split("-").map(Number);
  const to = etAt(new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10), 0);
  const neighbours = await localNeighbours({ creativeTeamMemberIds: tms, from, to, excludeRequestId: opts.excludeRequestId });
  const out: TravelSlotDay[] = [];
  for (const day of sorted) {
    const slotTravel: Record<string, TravelLabel> = {};
    const slotCreativeTravel: Record<string, Record<string, TravelLabel>> = {};
    const slotCreatives: Record<string, { teamMemberId: string; name: string }[]> = {};
    const checks = await Promise.all(day.slots.map(async (s) => {
      const start = new Date(s);
      const end = new Date(start.getTime() + opts.durationMin * MIN);
      const who = day.slotCreatives?.[s] ?? [];
      const each = await Promise.all(who.map(async (c) => {
        const fit = await fitBetween(neighbours.get(c.teamMemberId) ?? [], { start, end, dest: opts.dest }, bufferMinutes, drive);
        return { c, fit: neighbours.unlinked.has(c.teamMemberId) ? unlinkedFit(fit) : fit };
      }));
      return { s, each };
    }));
    const slots: string[] = [];
    for (const { s, each } of checks) {
      const kept = each.filter((x) => x.fit.fits !== false);
      if (!kept.length) continue;
      slots.push(s);
      slotCreatives[s] = kept.map((x) => x.c);
      slotCreativeTravel[s] = Object.fromEntries(kept.map((x) => [x.c.teamMemberId, x.fit.fits ? "HUB_DRIVE" : "UNCHECKED"] as const));
      slotTravel[s] = kept.some((x) => x.fit.fits) ? "HUB_DRIVE" : "UNCHECKED";
    }
    if (slots.length) out.push({ ...day, slots, slotCreatives, slotTravel, slotCreativeTravel });
  }
  return out;
}

/** The evidence a request carries: what was checked, against what, when. */
export function travelEvidence(fit: TravelFit, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ label: fit.label, fits: fit.fits, reason: fit.reason, prev: fit.prev, next: fit.next, bufferMinutes: fit.bufferMinutes, ...extra }).slice(0, 4000);
}

export type SessionSlotsResult = {
  ok: boolean;
  message: string;
  /** the month (or this session) is not open for filming yet — `message` says why */
  locked?: boolean;
  /** no exact address saved for this session yet: the address step comes first */
  needsAddress?: boolean;
  /** an exact address we could not place on a map: no confirmable times; Kyle confirms by hand */
  deskOnly?: boolean;
  planId?: string;
  addressVersion?: number;
  addressLine?: string;
  earliestISO?: string | null;
  bufferMinutes?: number;
  days: TravelSlotDay[];
};

/**
 * THE PORTAL'S TIMES FOR ONE SESSION (§6.6 W02 / A22) — every factor at once:
 * the preparation gate for THIS session (72 weekday hours, A18/A19), the
 * exact address first, live Aryeo availability for the package's product,
 * duration and assigned creatives with weekends removed (programSlotDays, the
 * shared cache), and travel from and to each creative's neighbours per slot
 * (annotateSlotDays). A move (`moveRequestId`) is measured from the booked
 * session's own address and never counts the session against itself.
 */
export async function sessionSlotsFor(a: {
  enrollmentId: string; monthId: string; sessionIndex: number; package: string | null; now?: Date; moveRequestId?: string | null;
}): Promise<SessionSlotsResult> {
  const now = a.now ?? new Date();
  const { sessionGate, programSlotDays } = await import("@/lib/portal");
  const { planBookable, planExact, planAddressLine } = await import("@/lib/sessionAddress");
  const { aryeoProductFor } = await import("@/lib/contentProgram");
  const product = aryeoProductFor(a.package);
  if (!product) return { ok: false, message: "Your package has no filming calendar yet. Call or text Kyle.", days: [] };
  // A move is held to the gate of the session it moves (its own index; a
  // legacy row without one reads the next session to book).
  const moving = a.moveRequestId
    ? await prisma.programSessionRequest.findUnique({ where: { id: a.moveRequestId }, select: { enrollmentId: true, monthId: true, planId: true, aryeoAppointmentId: true, sessionIndex: true } })
    : null;
  if (a.moveRequestId && (!moving || moving.enrollmentId !== a.enrollmentId || moving.monthId !== a.monthId)) return { ok: false, message: "That session isn't on your page.", days: [] };
  const gate = await sessionGate(a.enrollmentId, a.monthId, { now, sessionIndex: moving ? moving.sessionIndex ?? undefined : a.sessionIndex });
  if (gate.locked) return { ok: false, locked: true, message: gate.reason, days: [] };

  let dest: LatLng | null = null;
  let planInfo: Pick<SessionSlotsResult, "planId" | "addressVersion" | "addressLine"> = {};
  if (moving) {
    const r = moving;
    const given = r.aryeoAppointmentId ? await prisma.programSessionAddress.findUnique({ where: { sessionKey: `appt:${r.aryeoAppointmentId}` }, select: { submittedAt: true, latitude: true, longitude: true } }) : null;
    const plan = r.planId ? await prisma.programSessionPlan.findUnique({ where: { id: r.planId } }) : null;
    dest = (given?.submittedAt ? pt(given.latitude, given.longitude) : null) ?? (plan ? pt(plan.latitude, plan.longitude) : null);
  } else {
    const plan = await prisma.programSessionPlan.findUnique({ where: { monthId_sessionIndex: { monthId: a.monthId, sessionIndex: a.sessionIndex } } });
    if (!plan || plan.enrollmentId !== a.enrollmentId || !planExact(plan)) {
      return { ok: false, needsAddress: true, message: "Add the exact filming address first. We check the drive from your videographer's other shoots before we offer a time.", earliestISO: gate.earliest.toISOString(), days: [] };
    }
    planInfo = { planId: plan.id, addressVersion: plan.addressVersion, addressLine: planAddressLine(plan) };
    if (!planBookable(plan)) {
      return { ok: true, deskOnly: true, ...planInfo, earliestISO: gate.earliest.toISOString(), message: "We could not find that address on a map, so Kyle will confirm it and your time with you. Tell us what works.", days: [] };
    }
    dest = { lat: plan.latitude!, lng: plan.longitude! };
  }

  const cfg = await travelConfig();
  const base = await programSlotDays({ package: a.package, sessionMinutes: product.durationMinutes });
  const earliest = gate.earliest.getTime();
  const open = base
    .map((d) => ({ ...d, slots: d.slots.filter((s) => new Date(s).getTime() >= earliest) }))
    .filter((d) => d.slots.length > 0);
  const days = dest
    ? await annotateSlotDays(open, { dest, durationMin: product.durationMinutes, excludeRequestId: a.moveRequestId ?? null, bufferMinutes: cfg.bufferMinutes })
    // A legacy session with no mapped address: nothing can be measured, and
    // every time says so (a move like that is the desk's anyway).
    : open.map((d) => ({
        ...d,
        slotTravel: Object.fromEntries(d.slots.map((s) => [s, "UNCHECKED" as TravelLabel])),
        slotCreativeTravel: Object.fromEntries(d.slots.map((s) => [s, Object.fromEntries((d.slotCreatives?.[s] ?? []).map((c) => [c.teamMemberId, "UNCHECKED" as TravelLabel]))])),
      }));
  return {
    ok: true, ...planInfo, earliestISO: gate.earliest.toISOString(), bufferMinutes: cfg.bufferMinutes, days,
    message: days.length ? "" : "No open times fit right now. Tell us what works and Kyle will find one.",
  };
}
