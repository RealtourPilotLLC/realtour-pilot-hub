// ---------------------------------------------------------------------------
// DRILL: batch 3 — TRAVEL-BOOKING (§6.6 W02 / A22 / A23 / 3-booking-behavior,
// unified handoff Sep 25 2026). The portal journey, address first.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b3-travel-booking.ts
//
// THE CLOCK IS PINNED: Mon Oct 26 2026, 10:00 EDT (it advances from there).
// Every slot is an ET wall clock; §13 crosses the November 1 DST change.
//
// What it proves (OLD first, from 810b29f — never HEAD):
//   0. OLD: the scheduler showed times before "where", took "just the area",
//      and the portal accepted an area for a picked time; the base calendar is
//      the same for every destination.
//   1. No exact address → no times, no request; an area is refused.
//   2. An exact address → times, every factor applied (gate, product, duration,
//      weekends), each labelled with how its travel was checked.
//   3. Travel: a 9:00–12:00 appointment an hour away removes the 12:00, 12:30
//      and 13:00 starts for that creative and keeps 13:30; five minutes away
//      keeps 12:30; the NEXT appointment counts too.
//   4. The buffer is editable (session_booking config), even with the switch off.
//   5. Booking through the portal: exact street to Aryeo, travel evidence kept.
//   6. OSRM down → UNCHECKED, labelled, desk-confirmed, never QUEUED.
//   7. A neighbour with no map location → UNCHECKED.
//   8. A neighbour that appears after the pick (only in Aryeo): the adapter's
//      fresh read → CONFLICT with zero orders.
//   9. A geocode miss → no confirmable times; the "when works" ask goes to Kyle.
//  10. Times offered for an old address version are refused.
//  11. An address change on a booked session that breaks the drive → Kyle's
//      task; the booking is never moved (zero PUT).
//  12. Pro: two sessions, each its own plan, address and times.
//  13. DST: the same rule on Monday Nov 2 (EST).
//  14. A22 in one journey: Starter's own 120-minute calendar, a Saturday POSTed
//      directly refused, Harrison offered only once Aryeo assigns him.
//  15. The Aryeo-decides adapter: honoured vs ignored filter[appointment_id]
//      (never labelled ARYEO_APPOINTMENT when not proven), schedule with
//      auto_confirm true and notify false.
//  5b. (batch-3 review) With one second per Aryeo/OSRM call the OLD 25 s
//      inline budget stops part-way; the portal's 75 s budget books inline.
//  14+ (batch-3 review) A creative Aryeo offers but the hub has no TeamMember
//      for: every time UNCHECKED, a request with them desk-confirmed; HUB_DRIVE
//      once a TeamMember maps them.
//  17. The supervised script, against the fake: the whole journey, then its
//      stops (batch-3 review): an order timeout (switches off first, search for
//      the marker), a MISMATCH (cancel the LIVE appointment by hand), and a fee
//      on the order after the booking (the run FAILS).
//  16. Fence: nothing reached anything but the fakes.
//
// NOT PROVEN HERE, said plainly: real Aryeo (the supervised test,
// scripts/_ops/aryeo-supervised-test.ts, is the main session's to run), real
// OSRM (the stub answers by a distance table), and true concurrency (PGlite is
// one session; the R04 harness owns real-Postgres races).
//
// ISOLATION: PGlite on 127.0.0.1:${DRILL_PORT ?? 5662}.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import { createFakeAryeo, DRILL_TEAM } from "./_fake-aryeo";

const PORT = Number(process.env.DRILL_PORT ?? 5662);
const BASE = "810b29f"; // pinned: the tree batch 3 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 26, 14, 0, 0); // Mon Oct 26 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
/** An ET wall clock in 2026: EDT (UTC-4) through Oct 31, EST (UTC-5) from Nov 1. */
const et = (month: number, day: number, hour: number, minute = 0) =>
  new RealDate(RealDate.UTC(2026, month - 1, day, hour + (month > 10 ? 5 : 4), minute));
const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

// ---- places, and the drive between them (the OSRM stub) --------------------
const NEAR = { lat: 39.9607, lng: -75.6055 }; // 117 Kyle Lane, West Chester
const FAR = { lat: 40.6, lng: -75.1 }; // an hour away
const NEAR2 = { lat: 39.9612, lng: -75.6049 }; // five minutes from NEAR
const ADDRESSES: Record<string, { lat: number; lng: number } | null> = {
  "117 KYLE LANE": NEAR, "9 FAR AWAY ROAD": FAR, "12 NEXT DOOR LANE": NEAR2, "1 NOWHERE ROAD": null,
};
const isFar = (lat: number) => Math.abs(lat - FAR.lat) < 0.01;
let osrmDown = false;
let osrmCalls = 0;
/** 5b: real-world latency, added before every Aryeo and OSRM answer (0 = the instant fake). */
let latencyMs = 0;
const lag = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : null);
const geocodes: string[] = [];

installNextStubs();
let fake: ReturnType<typeof createFakeAryeo>;
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://geocoding.geo.census.gov/")) {
    const q = decodeURIComponent(new URL(url).searchParams.get("address") ?? "").toUpperCase();
    geocodes.push(q);
    const key = Object.keys(ADDRESSES).find((k) => q.startsWith(k));
    const hit = key ? ADDRESSES[key] : NEAR;
    if (!hit) return new Response(JSON.stringify({ result: { addressMatches: [] } }), { status: 200 });
    return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: hit.lng, y: hit.lat }, matchedAddress: q }] } }), { status: 200 });
  }
  if (url.startsWith("https://nominatim.openstreetmap.org/")) return new Response("[]", { status: 200 });
  if (url.startsWith("https://router.project-osrm.org/")) {
    osrmCalls++;
    await lag();
    if (osrmDown) return new Response("Service Unavailable", { status: 503 });
    const m = /driving\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/.exec(url);
    const [aLat, bLat] = m ? [Number(m[2]), Number(m[4])] : [0, 0];
    const minutes = isFar(aLat) !== isFar(bLat) ? 60 : 5;
    return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: minutes * 1000, duration: minutes * 60 }] }), { status: 200 });
  }
  if (url.startsWith("https://api.aryeo.com/")) await lag();
  return fake ? fake.handle(url, init) : null;
});

function oldCopy(rel: string, name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b3-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8" });
  const pointed = src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const file = path.join(dir, name);
  fs.writeFileSync(file, pointed);
  return file;
}
const show = (rel: string) => execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8" });

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
  const products: Record<string, string[]> = {
    [ARYEO_CONTENT_PRODUCTS.Starter.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
    [ARYEO_CONTENT_PRODUCTS.Accelerator.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
    [ARYEO_CONTENT_PRODUCTS.Pro.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
  };
  fake = createFakeAryeo({
    products,
    variants: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.productId, p.variantId])),
    variantPrices: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.variantId, 0])),
    defaultCustomerEmail: "info@realtourpilot.com",
  });
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo", "drill-key-not-a-real-one");
  const aryeo = await import("@/lib/integrations/aryeo");
  const sr = await import("@/lib/sessionRequests");
  const st = await import("@/lib/sessionTravel");
  const portal = await import("@/lib/portal");
  const pa = await import("@/app/portal/actions");

  // The creatives, as the hub knows them (Appointment.assignedTo → TeamMember).
  const james = await prisma.teamMember.create({ data: { name: DRILL_TEAM.james.name, email: "james@drill.invalid", aryeoTeamMemberId: DRILL_TEAM.james.tm, aryeoUserId: DRILL_TEAM.james.user, isServiceProvider: true } });
  const jordanTm = await prisma.teamMember.create({ data: { name: DRILL_TEAM.jordan.name, email: "jordan@drill.invalid", aryeoTeamMemberId: DRILL_TEAM.jordan.tm, aryeoUserId: DRILL_TEAM.jordan.user, isServiceProvider: true } });
  void jordanTm;

  let n = 0;
  const setSwitch = async (key: string, enabled: boolean, config: Record<string, unknown> | null = null) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(), configJson: config ? JSON.stringify(config) : null }, update: { enabled, configJson: config ? JSON.stringify(config) : null } });
  const authorised = new Set<string>();
  const authorise = async (clientId: string) => { authorised.add(clientId); await setSwitch("session_booking", true, { authorizedFixtureClientIds: [...authorised] }); };
  const clearSlotCache = () => prisma.appSetting.deleteMany({ where: { key: { startsWith: "portal-aryeo-slots:" } } });

  /** A TEST client's month with its strategy call HELD (ended Mon Oct 19, 2 PM ET), so filming is open. */
  const world = async (pkg: "Accelerator" | "Pro" | "Starter" = "Accelerator", monthKey = "2026-10"): Promise<ContentMonthFixture> => {
    const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: `Travel Drill ${++n} TEST`, package: pkg, monthKey, project: false, owner: { email: `travel${n}@realtourpilot.com` } });
    await prisma.client.update({ where: { id: f.clientId }, data: { email: "info@realtourpilot.com", aryeoCustomerId: `0198dddd-0000-4000-8000-${String(n).padStart(12, "0")}` } });
    await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "MONTHLY_STRATEGY", monthId: f.monthId, status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(10, 19, 13, 30), scheduledEnd: et(10, 19, 14), transcriptState: "ANALYZED" } });
    return f;
  };
  const auth = (f: ContentMonthFixture) => ({ token: f.portalToken });
  const exact = (street: string, city = "West Chester", zip = "19382") => ({ street, unit: null, city, state: "PA", zip });
  const slots = (f: ContentMonthFixture, idx = 1, moveRequestId?: string | null) => pa.portalSessionSlots(auth(f), f.monthId, idx, { moveRequestId: moveRequestId ?? null });
  const dayOf = (r: Awaited<ReturnType<typeof slots>>, dayKey: string) => r.days.find((d) => d.date === dayKey) ?? null;
  const offered = (r: Awaited<ReturnType<typeof slots>>, start: Date, tm: string) => {
    const d = r.days.find((x) => x.slots.includes(iso(start)));
    return !!d && (d.slotCreatives?.[iso(start)] ?? []).some((cr) => cr.teamMemberId === tm);
  };
  const labelOf = (r: Awaited<ReturnType<typeof slots>>, start: Date, tm: string) => {
    const d = r.days.find((x) => x.slots.includes(iso(start)));
    return d?.slotCreativeTravel[iso(start)]?.[tm] ?? null;
  };
  /** A creative's other appointment: on the hub's own calendar AND in Aryeo (the same id). */
  const neighbour = async (tm: typeof DRILL_TEAM.james, teamMemberId: string, start: Date, end: Date, at: { lat: number; lng: number } | null) => {
    const seeded = fake.seedNeighbour({ tm: tm.tm, start, end, lat: at?.lat ?? null, lng: at?.lng ?? null });
    const other = await prisma.client.create({ data: { name: `Another client ${++n}` } });
    const p = await prisma.project.create({ data: { clientId: other.id, title: "Another client's shoot", status: "SCHEDULED", lat: at?.lat ?? null, lng: at?.lng ?? null, aryeoOrderId: seeded.orderId } });
    await prisma.appointment.create({ data: { projectId: p.id, aryeoId: seeded.appointmentId, startAt: start, endAt: end, status: "SCHEDULED", assignedToId: teamMemberId } });
    return { ...seeded, projectId: p.id };
  };
  const JAMES = DRILL_TEAM.james.tm;
  const JORDAN = DRILL_TEAM.jordan.tm;

  // ======================================================================
  c.head("0 · OLD (810b29f): times before 'where', 'just the area', and one calendar for every destination");
  {
    const oldScheduler = show("src/components/portal/PortalScheduler.tsx");
    c.ok("OLD: the time grid rendered BEFORE the 'Where are we filming?' field", oldScheduler.indexOf("Pick a time") > 0 && oldScheduler.indexOf("Pick a time") < oldScheduler.indexOf("Where are we filming?"));
    c.ok("OLD: its placeholder invited 'just the area for now'", /just the area for now/.test(oldScheduler));
    const oldActions = show("src/app/portal/actions.ts");
    c.ok("OLD: the action's only location rule was 'not empty'", /if \(!location\) return fail\("Tell us where we're filming\."\)/.test(oldActions));
    const f = await world();
    const oldPa = (await import(oldCopy("src/app/portal/actions.ts", "actions.b3base.ts"))) as typeof pa;
    const r = await oldPa.portalRequestSession(auth(f), { monthId: f.monthId, slotISO: et(10, 28, 10).toISOString(), location: "West Chester, PA 19382", creativeTeamMemberId: JAMES });
    const row = r.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: r.requestId } }) : null;
    c.ok("OLD: a picked time with only an AREA was accepted and written", r.ok && row?.locationText === "West Chester, PA 19382" && !row.planId, `${r.ok} ${r.message} ${row?.locationText}`);
    if (row) await prisma.programSessionRequest.update({ where: { id: row.id }, data: { status: "CANCELLED" } });
    const base = await portal.programSlotDays({ package: "Accelerator" });
    const day = base.find((d) => d.date === "2026-10-28");
    c.ok("OLD/base: programSlotDays asks with no destination (the same list for every address)", !!day && day.slots.length > 0 && !("slotTravel" in day), `${day?.slots.length ?? 0} starts on Oct 28`);
  }

  // ======================================================================
  c.head("1 · no exact address → no times and no request; an area is refused");
  let A: ContentMonthFixture;
  {
    A = await world();
    const r = await slots(A);
    c.ok("portalSessionSlots says the address comes first, and offers nothing", !r.ok && !!r.needsAddress && r.days.length === 0, r.message);
    const w = await pa.portalRequestSession(auth(A), { monthId: A.monthId, slotISO: et(10, 28, 13, 30).toISOString(), location: "West Chester, PA 19382", creativeTeamMemberId: JAMES });
    c.ok("a picked time with a free-text area is refused", !w.ok && /exact filming address/.test(w.message), w.message);
    const area = await pa.portalSaveSessionPlanAddress(auth(A), A.monthId, 1, exact("West Chester"));
    c.ok("'West Chester' as the street is refused as an area", !area.ok && /house or building number/.test(area.message), area.message);
    c.ok("nothing written: no plan, no request", (await prisma.programSessionPlan.count({ where: { monthId: A.monthId } })) === 0 && (await prisma.programSessionRequest.count({ where: { monthId: A.monthId } })) === 0);
  }

  // ======================================================================
  c.head("2 · an exact address → times, each labelled with how its travel was checked");
  {
    const saved = await pa.portalSaveSessionPlanAddress(auth(A), A.monthId, 1, exact("117 Kyle Lane"));
    const plan = await prisma.programSessionPlan.findFirst({ where: { monthId: A.monthId, sessionIndex: 1 } });
    c.ok("saved on the session's plan, geocoded, version 1", saved.ok && !!plan && plan.addressVersion === 1 && plan.latitude === NEAR.lat && !!plan.addressValidatedAt, `${saved.message} v${plan?.addressVersion}`);
    const again = await pa.portalSaveSessionPlanAddress(auth(A), A.monthId, 1, exact("117 Kyle Ln"));
    c.ok("the same address again is a no-op (the version stays 1)", again.ok && (await prisma.programSessionPlan.findFirstOrThrow({ where: { monthId: A.monthId } })).addressVersion === 1, again.message);
    await clearSlotCache(); // §0 warmed the shared base cache; ask Aryeo afresh so its reads can be seen
    const reads0 = fake.reads.length;
    const r = await slots(A);
    c.ok("times are offered from the address", r.ok && r.days.length > 0 && r.addressLine === "117 Kyle Lane, West Chester, PA 19382" && r.planId === plan?.id, `${r.days.length} days; ${r.addressLine}`);
    const labels = new Set(r.days.flatMap((d) => Object.values(d.slotTravel)));
    c.ok("every time is HUB_DRIVE (nothing else on those days yet)", labels.size === 1 && labels.has("HUB_DRIVE"), [...labels].join(","));
    const dows = new Set(r.days.map((d) => new RealDate(`${d.date}T12:00:00Z`).getUTCDay()));
    c.ok("no Saturday or Sunday", !dows.has(0) && !dows.has(6), [...dows].join(","));
    c.ok("nothing before the gate (Tue Oct 27, 10:00 ET: 24 hours from now, after the 72-hour window)", r.days.every((d) => d.slots.every((s) => new RealDate(s).getTime() >= et(10, 27, 10).getTime())) && !!r.earliestISO, r.earliestISO ?? "");
    const reads = fake.reads.slice(reads0).filter((x) => x.startsWith("/scheduling/available-timeslots"));
    c.ok("Aryeo was asked for the Accelerator's 240 minutes", reads.length > 0 && reads.every((x) => x.includes("duration=240")), reads[0] ?? "(cached)");
    c.ok("Harrison (not assigned to the product in Aryeo) is never offered", r.days.every((d) => Object.values(d.slotCreatives ?? {}).flat().every((cr) => cr.teamMemberId !== DRILL_TEAM.harrison.tm)));
  }

  // ======================================================================
  c.head("3 · travel: the appointment before AND the one after decide, per creative");
  let far: Awaited<ReturnType<typeof neighbour>>;
  {
    far = await neighbour(DRILL_TEAM.james, james.id, et(10, 28, 9), et(10, 28, 12), FAR);
    await clearSlotCache(); // Aryeo's own answer changed (James is busy 9–12)
    const r = await slots(A);
    c.ok("an hour away until 12:00: James is NOT offered at 12:00, 12:30 or 13:00", !offered(r, et(10, 28, 12), JAMES) && !offered(r, et(10, 28, 12, 30), JAMES) && !offered(r, et(10, 28, 13), JAMES));
    c.ok("  and IS offered at 13:30 (12:00 + 60 min + 15 buffer = 13:15)", offered(r, et(10, 28, 13, 30), JAMES) && labelOf(r, et(10, 28, 13, 30), JAMES) === "HUB_DRIVE");
    c.ok("  Jordan, free that day, is still offered at 12:00 (the rule is per creative)", offered(r, et(10, 28, 12), JORDAN));
    // The same appointment five minutes away.
    await prisma.project.update({ where: { id: far.projectId }, data: { lat: NEAR2.lat, lng: NEAR2.lng } });
    fake.addresses.get(far.addressId)!.latitude = NEAR2.lat; fake.addresses.get(far.addressId)!.longitude = NEAR2.lng;
    const r2 = await slots(A);
    c.ok("five minutes away: 12:00 still out (12:00 + 5 + 15 = 12:20), 12:30 in", !offered(r2, et(10, 28, 12), JAMES) && offered(r2, et(10, 28, 12, 30), JAMES));
    // The NEXT appointment counts too: Thu Oct 29, 15:00–17:00, an hour away.
    await neighbour(DRILL_TEAM.james, james.id, et(10, 29, 15), et(10, 29, 17), FAR);
    await clearSlotCache();
    const r3 = await slots(A);
    c.ok("before a 15:00 appointment an hour away: 11:00 (ends 15:00) and 10:00 (ends 14:00) are out, 9:00 (ends 13:00) is in",
      !offered(r3, et(10, 29, 11), JAMES) && !offered(r3, et(10, 29, 10), JAMES) && offered(r3, et(10, 29, 9), JAMES),
      `9:00 ${offered(r3, et(10, 29, 9), JAMES)} 10:00 ${offered(r3, et(10, 29, 10), JAMES)} 11:00 ${offered(r3, et(10, 29, 11), JAMES)}`);
    const d = dayOf(r3, "2026-10-29");
    c.ok("  (Aryeo itself offered James 10:00 and 11:00: date + duration only)", !!(await portal.programSlotDays({ package: "Accelerator" })).find((x) => x.date === "2026-10-29")?.slotCreatives?.[iso(et(10, 29, 11))]?.some((cr) => cr.teamMemberId === JAMES), `${d?.slots.length} starts`);
  }

  // ======================================================================
  c.head("4 · the buffer is Jordan's to set (session_booking config), even with the switch OFF");
  {
    await setSwitch("session_booking", false, { travelBufferMinutes: 45 });
    const r = await slots(A);
    c.ok("45 minutes: five minutes away after 12:00 → 12:30 out, 13:00 in", !offered(r, et(10, 28, 12, 30), JAMES) && offered(r, et(10, 28, 13), JAMES) && r.bufferMinutes === 45, `buffer ${r.bufferMinutes}`);
    await prisma.programAutomation.deleteMany({ where: { key: "session_booking" } });
    const r2 = await slots(A);
    c.ok("no row → the default 15", r2.bufferMinutes === 15 && offered(r2, et(10, 28, 12, 30), JAMES));
  }

  // ======================================================================
  c.head("5 · booking through the portal: exact street to Aryeo, travel evidence on the request");
  let booked: { id: string; appt: string };
  {
    await authorise(A.clientId);
    const r = await slots(A);
    const o0 = fake.count("POST", "/orders", true);
    const res = await pa.portalRequestSession(auth(A), { monthId: A.monthId, slotISO: et(10, 28, 13, 30).toISOString(), creativeTeamMemberId: JAMES, planId: r.planId, addressVersion: r.addressVersion, sessionIndex: 1 });
    const row = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: res.requestId! } });
    c.ok("booked inline: CONFIRMED on the provider's id", res.ok && row.status === "CONFIRMED" && row.matchState === "PROVIDER_ID", `${res.message} [${row.status} ${row.bookingState} ${row.lastError}]`);
    c.ok("one order", fake.count("POST", "/orders", true) - o0 === 1);
    const addr = fake.writes.filter((w) => w.method === "POST" && w.path === "/addresses").slice(-1)[0]?.body as Record<string, unknown>;
    c.ok("Aryeo got the EXACT street and the map point", addr?.street_number === "117" && addr.street_name === "Kyle Lane" && addr.latitude === NEAR.lat, JSON.stringify(addr));
    const ev = JSON.parse(row.travelEvidenceJson ?? "{}") as { at?: string; label?: string; fits?: boolean; prev?: { driveMinutes?: number } };
    c.ok("the request carries the travel check (HUB_DRIVE) and the booking-time evidence", row.travelCheck === "HUB_DRIVE" && ev.at === "booking" && ev.fits === true && ev.prev?.driveMinutes === 5, `${row.travelCheck} ${row.travelEvidenceJson}`);
    c.ok("with its plan, version and session", row.planId === r.planId && row.planAddressVersion === 1 && row.sessionIndex === 1);
    booked = { id: row.id, appt: row.aryeoAppointmentId! };
  }

  // ======================================================================
  c.head("6 · OSRM down → UNCHECKED: labelled, desk-confirmed, never queued for the hub");
  {
    const B = await world();
    await authorise(B.clientId);
    await pa.portalSaveSessionPlanAddress(auth(B), B.monthId, 1, exact("117 Kyle Lane"));
    osrmDown = true;
    const r = await slots(B);
    osrmDown = false;
    c.ok("James at 9:00 on Oct 29 (before the far 15:00) is offered but UNCHECKED", offered(r, et(10, 29, 9), JAMES) && labelOf(r, et(10, 29, 9), JAMES) === "UNCHECKED", String(labelOf(r, et(10, 29, 9), JAMES)));
    c.ok("a day with nothing else on it is still HUB_DRIVE (nothing to measure)", labelOf(r, et(10, 30, 9), JAMES) === "HUB_DRIVE", String(labelOf(r, et(10, 30, 9), JAMES)));
    osrmDown = true;
    const w0 = fake.writes.length;
    const res = await pa.portalRequestSession(auth(B), { monthId: B.monthId, slotISO: et(10, 29, 9).toISOString(), creativeTeamMemberId: JAMES, planId: r.planId, addressVersion: r.addressVersion });
    osrmDown = false;
    const row = res.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: res.requestId } }) : null;
    c.ok("requested, NOT queued: desk-assisted with the reason", res.ok && row?.bookingState === "NONE" && row.travelCheck === "UNCHECKED" && /could not be checked/.test(row.lastError ?? ""), `${row?.bookingState} ${row?.lastError}`);
    c.ok("Kyle has the BOOK task", (await prisma.smartTask.findUnique({ where: { dedupeKey: `content-session-request-${row?.id}` } }))?.title.startsWith("Book content session") === true);
    c.ok("zero writes to Aryeo", fake.writes.length === w0);
    c.ok("the client reads 'Requested', never 'Booked'", sr.sessionRequestLabel(row!.status, row!.bookingState) === "Requested, awaiting confirmation");
  }

  // ======================================================================
  c.head("7 · a neighbour with no map location → UNCHECKED, never 'validated'");
  {
    await neighbour(DRILL_TEAM.james, james.id, et(10, 30, 9), et(10, 30, 11), null);
    await clearSlotCache();
    const r = await slots(A);
    c.ok("James at 11:00 on Oct 30 (after an appointment we cannot place) is UNCHECKED", labelOf(r, et(10, 30, 11), JAMES) === "UNCHECKED", String(labelOf(r, et(10, 30, 11), JAMES)));
  }

  // ======================================================================
  c.head("8 · a neighbour that appears after the pick (only in Aryeo yet): CONFLICT, zero orders");
  {
    const C = await world();
    await authorise(C.clientId);
    await pa.portalSaveSessionPlanAddress(auth(C), C.monthId, 1, exact("117 Kyle Lane"));
    const r = await slots(C);
    c.ok("(Jordan at 13:30 on Tue Oct 27 is offered, HUB_DRIVE)", labelOf(r, et(10, 27, 13, 30), JORDAN) === "HUB_DRIVE");
    // Kyle books Jordan 11:00–13:00 an hour away, straight in Aryeo; the hourly sync has not run.
    fake.seedNeighbour({ tm: JORDAN, start: et(10, 27, 11), end: et(10, 27, 13), lat: FAR.lat, lng: FAR.lng });
    const o0 = fake.count("POST", "/orders");
    const a0 = fake.count("POST", "/addresses");
    const res = await pa.portalRequestSession(auth(C), { monthId: C.monthId, slotISO: et(10, 27, 13, 30).toISOString(), creativeTeamMemberId: JORDAN, planId: r.planId, addressVersion: r.addressVersion });
    const row = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: res.requestId! } });
    c.ok("the adapter's fresh read of Jordan's day finds it: CONFLICT", row.bookingState === "CONFLICT" && !res.ok && /just taken/.test(res.message), `${row.bookingState}: ${res.message}`);
    c.ok("zero POST /orders and zero POST /addresses", fake.count("POST", "/orders") === o0 && fake.count("POST", "/addresses") === a0);
    const att = await prisma.programBookingAttempt.findFirst({ where: { requestId: row.id } });
    c.ok("the attempt says why (travel)", att?.state === "CONFLICT" && /travel: no room for the drive/.test(att.lastError ?? ""), att?.lastError ?? "");
  }

  // ======================================================================
  c.head("9 · an address we cannot place on a map: no confirmable times; the ask goes to Kyle");
  {
    const D = await world();
    const saved = await pa.portalSaveSessionPlanAddress(auth(D), D.monthId, 1, exact("1 Nowhere Road", "Nowhere", "19999"));
    c.ok("saved, but not bookable, and the client is told Kyle confirms it", saved.ok && saved.bookable === false && /Kyle will confirm/.test(saved.message), saved.message);
    const r = await slots(D);
    c.ok("no times: desk only", r.ok && !!r.deskOnly && r.days.length === 0, r.message);
    const picked = await pa.portalRequestSession(auth(D), { monthId: D.monthId, slotISO: et(10, 28, 10).toISOString(), creativeTeamMemberId: JORDAN, planId: r.planId, addressVersion: r.addressVersion });
    c.ok("a picked time POSTed anyway is refused", !picked.ok && /could not find that address on a map/.test(picked.message), picked.message);
    const w0 = fake.writes.length;
    const ask = await pa.portalRequestSession(auth(D), { monthId: D.monthId, when: "Any weekday morning", planId: r.planId, addressVersion: r.addressVersion });
    const row = ask.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: ask.requestId } }) : null;
    c.ok("'what works' goes to the desk with the exact address", ask.ok && row?.bookingState === "NONE" && row.locationText === "1 Nowhere Road, Nowhere, PA 19999", `${row?.bookingState} ${row?.locationText}`);
    c.ok("zero writes", fake.writes.length === w0);
  }

  // ======================================================================
  c.head("10 · times offered for an old address are refused");
  {
    const E = await world();
    await pa.portalSaveSessionPlanAddress(auth(E), E.monthId, 1, exact("117 Kyle Lane"));
    const r = await slots(E);
    const moved = await pa.portalSaveSessionPlanAddress(auth(E), E.monthId, 1, exact("9 Far Away Road", "Doylestown", "18901"));
    c.ok("(the address moved: version 2)", moved.ok && moved.addressVersion === 2);
    const res = await pa.portalRequestSession(auth(E), { monthId: E.monthId, slotISO: et(10, 30, 13).toISOString(), creativeTeamMemberId: JORDAN, planId: r.planId, addressVersion: r.addressVersion });
    c.ok("booking with the old version is refused, asking for a re-pick", !res.ok && /address changed/.test(res.message), res.message);
  }

  // ======================================================================
  c.head("11 · an address change on a BOOKED session that breaks the drive → Kyle's task; never moved");
  {
    // James also films 18:00–19:00 near the session's current address.
    await neighbour(DRILL_TEAM.james, james.id, et(10, 28, 18), et(10, 28, 19), NEAR);
    const before = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: booked.id } });
    const p0 = fake.count("PUT", "/appointments/");
    const res = await pa.portalSubmitSessionAddress(auth(A), `appt:${booked.appt}`, exact("9 Far Away Road", "Doylestown", "18901"));
    c.ok("the new address is saved (updating the booking)", res.ok, res.message);
    const task = await prisma.smartTask.findFirst({ where: { dedupeKey: { startsWith: `program-session-address:appt:${booked.appt}:travel:` } } });
    c.ok("Kyle's task: the new address leaves no room for the drive to the 18:00 shoot", !!task && task.title.startsWith("New filming address leaves no room for the drive") && /no room for the drive/.test(task.description ?? ""), task?.title ?? "(none)");
    c.ok("  and it says the session time was not changed", /The session time was not changed/.test(task?.description ?? ""));
    const after = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: booked.id } });
    c.ok("zero PUT (no reschedule, no cancel); the slot is unchanged", fake.count("PUT", "/appointments/") === p0 && after.slotStart?.getTime() === before.slotStart?.getTime());
  }

  // ======================================================================
  c.head("12 · Pro: two sessions, each its own plan, address and times");
  {
    const P = await world("Pro");
    await authorise(P.clientId);
    await pa.portalSaveSessionPlanAddress(auth(P), P.monthId, 1, exact("117 Kyle Lane"));
    const two = await pa.portalSaveSessionPlanAddress(auth(P), P.monthId, 2, exact("9 Far Away Road", "Doylestown", "18901"));
    const three = await pa.portalSaveSessionPlanAddress(auth(P), P.monthId, 3, exact("117 Kyle Lane"));
    c.ok("session 2 has its own plan; there is no session 3", two.ok && !three.ok, `${two.message} | ${three.message}`);
    const s1 = await slots(P, 1);
    const s2 = await slots(P, 2);
    c.ok("each session's times come from its own address", s1.addressLine?.startsWith("117 Kyle Lane") === true && s2.addressLine?.startsWith("9 Far Away Road") === true && s1.planId !== s2.planId);
    // From Doylestown (an hour from the NEAR 18:00 shoot) James's day differs from West Chester's.
    const b1 = await pa.portalRequestSession(auth(P), { monthId: P.monthId, slotISO: et(11, 3, 9).toISOString(), creativeTeamMemberId: JORDAN, planId: s1.planId, addressVersion: s1.addressVersion, sessionIndex: 1 });
    const s2b = await slots(P, 2);
    const b2 = await pa.portalRequestSession(auth(P), { monthId: P.monthId, slotISO: et(11, 4, 9).toISOString(), creativeTeamMemberId: JORDAN, planId: s2b.planId, addressVersion: s2b.addressVersion, sessionIndex: 2 });
    const rows = await prisma.programSessionRequest.findMany({ where: { monthId: P.monthId, status: "CONFIRMED" }, orderBy: { sessionIndex: "asc" } });
    c.ok("two bookings, sessions 1 and 2, on their own plans", b1.ok && b2.ok && rows.length === 2 && rows[0].sessionIndex === 1 && rows[1].sessionIndex === 2 && rows[0].planId !== rows[1].planId, `${b1.message} | ${b2.message}`);
    const streets = fake.writes.filter((w) => w.method === "POST" && w.path === "/addresses").slice(-2).map((w) => (w.body as { street_name?: string }).street_name);
    c.ok("each order got its own session's street", streets[0] === "Kyle Lane" && streets[1] === "Far Away Road", streets.join(", "));
  }

  // ======================================================================
  c.head("13 · DST: the same rule on Monday Nov 2 (EST, UTC-5)");
  {
    const N = await world("Accelerator", "2026-11");
    await pa.portalSaveSessionPlanAddress(auth(N), N.monthId, 1, exact("117 Kyle Lane"));
    await neighbour(DRILL_TEAM.james, james.id, et(11, 2, 9), et(11, 2, 12), FAR);
    await clearSlotCache();
    const r = await slots(N);
    c.ok("after the clocks change: 12:00/12:30/13:00 EST out for James, 13:30 EST in", !offered(r, et(11, 2, 12), JAMES) && !offered(r, et(11, 2, 12, 30), JAMES) && !offered(r, et(11, 2, 13), JAMES) && offered(r, et(11, 2, 13, 30), JAMES), `13:30 EST = ${iso(et(11, 2, 13, 30))}`);
  }

  // ======================================================================
  c.head("14 · A22 in one journey: Starter's own 120 minutes, a Saturday refused, Harrison only once assigned");
  {
    const S = await world("Starter");
    await pa.portalSaveSessionPlanAddress(auth(S), S.monthId, 1, exact("117 Kyle Lane"));
    const reads0 = fake.reads.length;
    const r = await slots(S);
    const reads = fake.reads.slice(reads0).filter((x) => x.startsWith("/scheduling/available-timeslots"));
    c.ok("Starter's calendar is asked for 120 minutes", reads.length > 0 && reads.every((x) => x.includes("duration=120")), reads[0] ?? "");
    c.ok("  and after the far 9–12 on Nov 2, James at 13:30 EST (the drive rule is the same for a 2-hour session)", offered(r, et(11, 2, 13, 30), JAMES) && !offered(r, et(11, 2, 13), JAMES));
    const sat = await pa.portalRequestSession(auth(S), { monthId: S.monthId, slotISO: et(10, 31, 10).toISOString(), creativeTeamMemberId: JAMES, planId: r.planId, addressVersion: r.addressVersion });
    c.ok("a Saturday slot POSTed directly is refused", !sat.ok && /Monday through Friday/.test(sat.message), sat.message);
    c.ok("Harrison is not offered while unassigned", r.days.every((d) => Object.values(d.slotCreatives ?? {}).flat().every((cr) => cr.teamMemberId !== DRILL_TEAM.harrison.tm)));
    products[ARYEO_CONTENT_PRODUCTS.Starter.productId] = [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm, DRILL_TEAM.harrison.tm];
    aryeo.resetProductProviderCache();
    await clearSlotCache();
    const r2 = await slots(S);
    c.ok("once Aryeo assigns him to Starter, Harrison is offered", r2.days.some((d) => Object.values(d.slotCreatives ?? {}).flat().some((cr) => cr.teamMemberId === DRILL_TEAM.harrison.tm)));
    // Batch-3 review (Sep 25 2026): the hub has no TeamMember for Harrison yet
    // (the team sync is a manual "Sync now"), so his Aryeo appointments are
    // invisible to it. His empty day used to read "nothing else is on the
    // creative's day" — HUB_DRIVE, travel-checked — when nothing was measured.
    const HARRISON = DRILL_TEAM.harrison.tm;
    const hSlots = r2.days.flatMap((d) => d.slots.filter((s) => (d.slotCreatives?.[s] ?? []).some((cr) => cr.teamMemberId === HARRISON)).map((s) => ({ d, s })));
    c.ok("an unlinked creative's times are UNCHECKED ('Kyle confirms'), never HUB_DRIVE", hSlots.length > 0 && hSlots.every(({ d, s }) => d.slotCreativeTravel[s]?.[HARRISON] === "UNCHECKED"), `${hSlots.length} slot(s): ${[...new Set(hSlots.map(({ d, s }) => d.slotCreativeTravel[s]?.[HARRISON]))].join(",")}`);
    const pickH = hSlots.find(({ s }) => new Date(s).getTime() > Date.now() + 48 * 3_600_000)!;
    const askH = await pa.portalRequestSession(auth(S), { monthId: S.monthId, slotISO: pickH.s, creativeTeamMemberId: HARRISON, planId: r2.planId, addressVersion: r2.addressVersion });
    const rowH = askH.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: askH.requestId } }) : null;
    c.ok("…a request with him stores travelCheck UNCHECKED with the reason (desk-confirmed, never auto-booked)", askH.ok && rowH?.travelCheck === "UNCHECKED" && /calendar is not linked/.test(rowH.travelEvidenceJson ?? ""), `${rowH?.travelCheck} ${rowH?.travelEvidenceJson?.slice(0, 160)}`);
    await prisma.programSessionRequest.update({ where: { id: rowH!.id }, data: { status: "CANCELLED" } });
    await prisma.teamMember.create({ data: { name: DRILL_TEAM.harrison.name, email: "harrison@drill.invalid", aryeoTeamMemberId: HARRISON, aryeoUserId: DRILL_TEAM.harrison.user, isServiceProvider: true } });
    await clearSlotCache();
    const r3 = await slots(S);
    const hLinked = r3.days.flatMap((d) => d.slots.filter((s) => (d.slotCreatives?.[s] ?? []).some((cr) => cr.teamMemberId === HARRISON)).map((s) => d.slotCreativeTravel[s]?.[HARRISON]));
    c.ok("once linked (a TeamMember maps him), his clear day is HUB_DRIVE again", hLinked.length > 0 && hLinked.every((l) => l === "HUB_DRIVE"), [...new Set(hLinked)].join(","));
  }

  // ======================================================================
  c.head("15 · the Aryeo-decides adapter: honoured vs ignored, and the schedule write");
  {
    const probe = fake.seedNeighbour({ tm: JORDAN, start: et(11, 5, 9), end: et(11, 5, 13), lat: NEAR.lat, lng: NEAR.lng });
    const honoured = await aryeo.AryeoBooking.timeslotsForAppointment({ appointmentId: probe.appointmentId, date: "2026-11-06", expectDurationMin: 240, expectTeamMemberIds: [JORDAN] });
    c.ok("a provider that honours filter[appointment_id] echoes the appointment's duration and creative", honoured.honoured && honoured.slots.length > 0, honoured.why);
    const ignoring = createFakeAryeo({ products, appointmentScope: "ignore", defaultCustomerEmail: "info@realtourpilot.com" });
    ignoring.seedOrder({ id: "ord-ign", number: 1, customerId: "c", address: { id: "addr-ign", street_number: "1", street_name: "A St", unit_number: null, city: "X", state_or_province: "PA", postal_code: "19000", country: "US", latitude: 1, longitude: 1, unparsed_address: null }, appointments: [{ id: "appt-ign", start_at: iso(et(11, 5, 9)), end_at: iso(et(11, 5, 13)), tmIds: [JORDAN] }] });
    const real = fake;
    fake = ignoring;
    const ignored = await aryeo.AryeoBooking.timeslotsForAppointment({ appointmentId: "appt-ign", date: "2026-11-06", expectDurationMin: 240, expectTeamMemberIds: [JORDAN] });
    fake = real;
    c.ok("a provider that ignores it is NOT taken as appointment-scoped", !ignored.honoured, ignored.why);
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [...authorised], travelSource: "ARYEO_APPOINTMENT" });
    const r = await slots(A);
    const labels = new Set(r.days.flatMap((d) => Object.values(d.slotTravel)));
    c.ok("even with travelSource ARYEO_APPOINTMENT, no offered time claims Aryeo checked it (no appointment-scoped read exists yet)", !labels.has("ARYEO_APPOINTMENT"), [...labels].join(","));
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [...authorised] });
    const g = await aryeo.hubWritePermit({ switchKey: "session_booking", client: { id: A.clientId, name: null }, operation: "appointments.schedule" });
    if (!g.ok) throw new Error(g.reason);
    const put0 = fake.count("PUT", "/appointments/");
    await aryeo.AryeoBooking.scheduleAppointment(g.permit, probe.appointmentId, { start: et(11, 6, 9), end: et(11, 6, 13), teamMemberIds: [JORDAN] });
    const body = fake.writes.filter((w) => w.method === "PUT" && w.path.endsWith("/schedule")).slice(-1)[0]?.body as Record<string, unknown> | undefined;
    c.ok("PUT /appointments/:id/schedule with auto_confirm true and notify false", fake.count("PUT", "/appointments/") - put0 === 1 && body?.auto_confirm === true && body.notify === false && body.start_at === iso(et(11, 6, 9)), JSON.stringify(body));
    void st;
  }

  // ======================================================================
  c.head("17 · scripts/_ops/aryeo-supervised-test.ts, end to end against the fake (the main session runs it for real)");
  {
    const { aryeoSupervisedTest } = await import("../_ops/aryeo-supervised-test");
    const lines: string[] = [];
    const log = (l: string) => { lines.push(l); };
    const run = async (argv: string[]) => { lines.length = 0; return aryeoSupervisedTest(argv, log); };
    // The fixture: TEST name, the verified inbox, a linked Aryeo customer, an ACTIVE Accelerator month.
    const F = await world("Accelerator");
    const clientRow = await prisma.client.findUniqueOrThrow({ where: { id: F.clientId } });
    const setBoth = async (fixtures: string[], pilot: Record<string, unknown> | null = null) => {
      for (const key of ["session_booking", "address_sync"]) await setSwitch(key, true, { authorizedFixtureClientIds: fixtures, ...(pilot ? { pilot } : {}) });
    };
    const ADDR = ["--address", "117 Kyle Lane|West Chester|PA|19382", "--new-address", "12 Next Door Lane|West Chester|PA|19382"];

    // Refusals first.
    const real = await prisma.client.create({ data: { name: "Real Person", email: "real.person@example.com", aryeoCustomerId: "0198eeee-0000-4000-8000-000000000001" } });
    await setBoth([F.clientId]);
    const w0 = fake.writes.length;
    const rReal = await run(["--fixture", real.id, ...ADDR, "--apply"]);
    c.ok("a real client is refused", rReal.code === 2 && /real client/.test(rReal.refused ?? ""), rReal.refused);
    const impostor = await world("Accelerator");
    await prisma.client.update({ where: { id: impostor.clientId }, data: { email: "somebody@example.com" } });
    await setBoth([impostor.clientId]);
    const rImp = await run(["--fixture", impostor.clientId, ...ADDR, "--apply"]);
    c.ok("a TEST name whose own inbox is not the test inbox is refused (assertFixtureIdentity)", rImp.code === 2 && /verified test inbox/.test(rImp.refused ?? ""), rImp.refused);
    await setBoth([F.clientId], { clientIds: [real.id], operations: ["orders.create"], approvedBy: "drill", approvedAt: new Date().toISOString(), expiresAt: null, note: null });
    const rPilot = await run(["--fixture", F.clientId, ...ADDR, "--apply"]);
    c.ok("a pilot naming a real client is refused (empty every pilot first)", rPilot.code === 2 && /pilot/.test(rPilot.refused ?? ""), rPilot.refused);
    await setBoth([F.clientId, impostor.clientId]);
    const rTwo = await run(["--fixture", F.clientId, ...ADDR, "--apply"]);
    c.ok("switches authorising more than this fixture are refused for --apply", rTwo.code === 2 && /this fixture only/.test(rTwo.refused ?? ""), rTwo.refused);
    c.ok("and every refusal wrote nothing to Aryeo", fake.writes.length === w0, `${fake.writes.length - w0}`);

    // Dry run: reads only.
    await setBoth([F.clientId]);
    const reqs0 = await prisma.programSessionRequest.count();
    const dry = await run(["--fixture", F.clientId, ...ADDR]);
    c.ok("the dry run passes its checks and prints the plan", dry.code === 0 && dry.mode === "dry-run" && lines.some((l) => /DRY RUN: nothing was written/.test(l)) && lines.some((l) => /price \$0 ✓/.test(l)), lines.slice(-2).join(" | "));
    c.ok("  and writes nothing (Aryeo, requests, plans)", fake.writes.length === w0 && (await prisma.programSessionRequest.count()) === reqs0 && (await prisma.programSessionPlan.count({ where: { monthId: F.monthId } })) === 0);

    // --apply: the whole §5 journey.
    const before = { a: fake.count("POST", "/addresses", true), o: fake.count("POST", "/orders", true), s: fake.count("POST", "/appointments/store", true), p: fake.count("PATCH", "/addresses/", true), put: fake.count("PUT", "/appointments/", true) };
    const res = await run(["--fixture", F.clientId, ...ADDR, "--apply"]);
    const rep = (res.report ?? {}) as { money?: { totalCents: number | null; balanceCents: number | null; paymentStatus: string | null }; addressPatch?: { syncState?: string }; reschedule?: { ok?: boolean }; cancel?: { status?: string }; aryeoTravelProbe?: { appointmentScopedHonoured?: boolean }; booking?: { permitScope?: string } };
    c.ok("--apply: booked, patched, moved and cancelled — exit 0", res.code === 0 && res.mode === "apply", `${res.code} ${res.refused ?? ""} ${lines.filter((l) => /^\d\./.test(l)).join(" | ")}`);
    c.ok("  exactly: 1 address, 1 order, 1 appointment, 1 address PATCH, 2 PUTs (move + cancel)",
      fake.count("POST", "/addresses", true) - before.a === 1 && fake.count("POST", "/orders", true) - before.o === 1 && fake.count("POST", "/appointments/store", true) - before.s === 1 && fake.count("PATCH", "/addresses/", true) - before.p === 1 && fake.count("PUT", "/appointments/", true) - before.put === 2,
      JSON.stringify({ a: fake.count("POST", "/addresses", true) - before.a, o: fake.count("POST", "/orders", true) - before.o, s: fake.count("POST", "/appointments/store", true) - before.s, p: fake.count("PATCH", "/addresses/", true) - before.p, put: fake.count("PUT", "/appointments/", true) - before.put }));
    c.ok("  the money readback is recorded: total 0, balance 0, payment_status", rep.money?.totalCents === 0 && rep.money.balanceCents === 0 && !!rep.money.paymentStatus, JSON.stringify(rep.money));
    c.ok("  under the FIXTURE scope", rep.booking?.permitScope === "FIXTURE", rep.booking?.permitScope);
    c.ok("  the exact-address PATCH read back SYNCED", rep.addressPatch?.syncState === "SYNCED", JSON.stringify(rep.addressPatch));
    c.ok("  the reschedule landed and the cancel read back CANCELLED", rep.reschedule?.ok === true && rep.cancel?.status === "CANCELLED", JSON.stringify({ r: rep.reschedule, c: rep.cancel }));
    c.ok("  the travel probe was recorded (the fake honours filter[appointment_id])", rep.aryeoTravelProbe?.appointmentScopedHonoured === true);
    c.ok("  no payment, discount or void route was ever called", !fake.writes.some((w) => /payments|discounts|void|refund/.test(w.path)));
    c.ok("  and the manual cleanup list is printed", lines.some((l) => /MANUAL CLEANUP/.test(l)) && lines.some((l) => /void that balance by hand/.test(l)) && lines.some((l) => l.includes(`hub-write-fixture.ts --switch session_booking --remove ${F.clientId} --off --apply`)) && lines.some((l) => l.includes(`--switch address_sync --remove ${F.clientId} --off --apply`)));
    c.ok("  …including closing the order, the QuickBooks invoice and telling James it was a test", lines.some((l) => /Close or cancel the test order itself/.test(l)) && lines.some((l) => /QuickBooks/.test(l)) && lines.some((l) => /Tell James/.test(l)));
    c.ok("  the money check after the booking is recorded as PASS ($0 / $0)", /^PASS/.test(String((res.report as { moneyCheck?: string } | undefined)?.moneyCheck ?? "")), String((res.report as { moneyCheck?: string } | undefined)?.moneyCheck));
    void clientRow;

    // Batch-3 review (Sep 25 2026): the cleanup list used to be the success
    // path's on every stop. Each stop now says what is really left behind.
    const armed = async () => { const Fx = await world("Accelerator"); await setBoth([Fx.clientId]); return Fx; };
    const text = () => lines.join("\n");
    // (a) POST /orders times out AFTER Aryeo committed: no order id came back.
    const Fa = await armed();
    fake.script("POST /orders", "abort-after-commit");
    const ra = await run(["--fixture", Fa.clientId, ...ADDR, "--apply"]);
    const rowA = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: ra.requestId! } });
    c.ok("(a) order timeout after commit: stop, and FIRST switch both off (the cron would carry on)", ra.code === 1 && rowA.bookingState === "UNKNOWN" && /1\. Switch both OFF now/.test(text()) && text().includes(`--switch session_booking --remove ${Fa.clientId} --off --apply`), `${rowA.bookingState} | ${lines.find((l) => /1\./.test(l)) ?? ""}`);
    c.ok("(a) …then SEARCH Aryeo orders for the marker — never 'the test order (none made)'", text().includes(`SEARCH ORDERS for the internal note "hub-session:${rowA.id}:"`) && !/none made/.test(text()));
    // The operator's cleanup, so the next run's slot is free again.
    await prisma.programSessionRequest.update({ where: { id: rowA.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await sr.releaseCreativeHold(rowA.id, "CANCELLED");
    // (b) the appointment stored at the wrong time (MISMATCH): it is live on James's calendar.
    const Fb = await armed();
    fake.script("POST /appointments/store", "shift-start-30");
    const rb = await run(["--fixture", Fb.clientId, ...ADDR, "--apply"]);
    if (!rb.requestId) throw new Error(`(b) setup: ${rb.refused} | ${lines.slice(-3).join(" | ")}`);
    const rowB = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: rb.requestId } });
    c.ok("(b) readback MISMATCH: 'CANCEL appointment … by hand: it is LIVE' (never 'confirm it reads CANCELED')", rb.code === 1 && rowB.bookingState === "MISMATCH" && text().includes(`CANCEL appointment ${rowB.aryeoAppointmentId} by hand: it is LIVE`) && !/reads CANCELED/.test(text()), `${rowB.bookingState} ${rowB.aryeoAppointmentId}`);
    c.ok("(b) …the order is named for closing", text().includes(`open test order ${rowB.aryeoOrderId}`) && /Close or cancel the test order itself/.test(text()));
    // (c) R03 after the store: a fee appears with the appointment → the run FAILS.
    const Fc = await armed();
    fake.script("POST /appointments/store", "add-fee-on-store");
    const rc = await run(["--fixture", Fc.clientId, ...ADDR, "--apply"]);
    const repC = (rc.report ?? {}) as { moneyCheck?: string };
    c.ok("(c) a balance on the order after the booking marks the run FAIL (exit 1, moneyCheck FAIL)", rc.code === 1 && rc.refused === "money-readback" && /^FAIL/.test(repC.moneyCheck ?? "") && lines.some((l) => /FAIL \(R03\)/.test(l)), `${rc.code} ${repC.moneyCheck}`);
    // Every armed switch goes back off before the fence check.
    for (const key of ["session_booking", "address_sync"]) await setSwitch(key, false, { authorizedFixtureClientIds: [] });
  }

  // ======================================================================
  // Batch-3 review (Sep 25 2026): the inline booking had a 25 s budget and 22 s
  // of room at each of its three write gates — 3 s for everything else — so it
  // only ever finished against instant fakes. One second per Aryeo and OSRM
  // call, the old budget first, then the portal's own.
  c.head("5b · booking inline with real latency: one second per Aryeo and OSRM call");
  {
    const sb = await import("@/lib/sessionBooking");
    const Lt = await world();
    await authorise(Lt.clientId);
    await pa.portalSaveSessionPlanAddress(auth(Lt), Lt.monthId, 1, exact("117 Kyle Lane"));
    await clearSlotCache();
    const r = await slots(Lt);
    const lastFor = (tm: string) => r.days.flatMap((d) => d.slots.filter((s2) => d.slotCreativeTravel[s2]?.[tm] === "HUB_DRIVE")).slice(-1)[0] ?? null;
    const jordanSlot = lastFor(JORDAN);
    const jamesSlot = r.days.flatMap((d) => d.slots.filter((s2) => s2 !== jordanSlot && d.slotCreativeTravel[s2]?.[JAMES] === "HUB_DRIVE")).slice(-1)[0] ?? null;
    c.ok("(a free HUB_DRIVE time for each creative, weeks out)", !!jamesSlot && !!jordanSlot, `${jamesSlot} / ${jordanSlot}`);
    const plan = await prisma.programSessionPlan.findUniqueOrThrow({ where: { monthId_sessionIndex: { monthId: Lt.monthId, sessionIndex: 1 } } });
    const old = await sr.createSessionRequest({
      enrollmentId: Lt.enrollmentId, monthId: Lt.monthId, slot: { startISO: jamesSlot!, endISO: new Date(Date.parse(jamesSlot!) + 4 * 3_600_000).toISOString() },
      actor: { kind: "STAFF", userId: null }, creative: { teamMemberId: JAMES, name: DRILL_TEAM.james.name },
      plan: { planId: plan.id, addressVersion: plan.addressVersion }, travel: { check: "HUB_DRIVE", evidenceJson: null }, sessionIndex: 1,
    });
    if (!old.ok) throw new Error(old.reason);
    latencyMs = 1000;
    const w0 = fake.writes.length;
    const t0 = Date.now();
    const oldOut = await sb.bookSessionRequest(old.id, { worker: "portal", budgetMs: 25_000 });
    c.ok("OLD budget (25 s): it stops part-way, nothing on the calendar — 'Booking your session' waits for the cron", oldOut.outcome === "pending" && /stopped before the (address|order|appointment) write/.test(oldOut.detail) && !fake.writes.slice(w0).some((w) => w.path === "/appointments/store"), `${oldOut.outcome}: ${oldOut.detail} (${Math.round((Date.now() - t0) / 1000)} s, ${fake.writes.length - w0} write(s))`);
    await prisma.programSessionRequest.update({ where: { id: old.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "drill: the old-budget run" } });
    await sr.releaseCreativeHold(old.id, "CANCELLED");
    const t1 = Date.now();
    const res = await pa.portalRequestSession(auth(Lt), { monthId: Lt.monthId, slotISO: jordanSlot!, creativeTeamMemberId: JORDAN, planId: r.planId, addressVersion: r.addressVersion, sessionIndex: 1 });
    latencyMs = 0;
    const row = res.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: res.requestId } }) : null;
    c.ok(`NEW (${sb.INLINE_BOOKING_BUDGET_MS / 1000} s): the portal books it inline — 'Booked', CONFIRMED on the provider's id`, res.ok && /Booked/.test(res.message) && row?.status === "CONFIRMED" && row.matchState === "PROVIDER_ID", `${res.message} [${row?.status} ${row?.bookingState}] ${Math.round((Date.now() - t1) / 1000)} s`);
    const pages = ["src/app/portal/[token]/page.tsx", "src/app/portal/me/page.tsx"].map((f) => fs.readFileSync(path.join(REPO, f), "utf8"));
    c.ok("both portal pages give their actions the room (maxDuration 90 > the 75 s budget)", pages.every((src) => /export const maxDuration = 90;/.test(src)) && sb.INLINE_BOOKING_BUDGET_MS < 90_000);
  }

  // ======================================================================
  c.head("16 · nothing left the machine but the fakes");
  {
    const other = fence.faked.filter((u) => !/^https:\/\/(api\.aryeo\.com|geocoding\.geo\.census\.gov|nominatim\.openstreetmap\.org|router\.project-osrm\.org)\//.test(u));
    c.ok("no other destination was answered", other.length === 0, other.slice(0, 3).join(", "));
    c.ok("nothing was blocked", fence.blocked.length === 0, fence.blocked.slice(0, 5).join(", "));
    console.log(`    fake Aryeo writes: ${fake.writes.filter((w) => w.committed).length} committed; geocodes ${geocodes.length}; OSRM (stub) calls ${osrmCalls}`);
    c.ok("the database was never production", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/`));
  }

  c.summary();
  quiet.restore();
  await stop();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  fence.restore();
  process.exit(process.exitCode ?? 0);
});
