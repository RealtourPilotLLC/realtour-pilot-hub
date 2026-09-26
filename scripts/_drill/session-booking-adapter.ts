// ---------------------------------------------------------------------------
// DRILL: CP-04 — the booking adapter (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/session-booking-adapter.ts
//
// What it proves, the OLD behaviour first (the OLD sessionRequests.ts is loaded
// for real from HEAD, its `@/` imports pointed at this tree):
//   0. OLD — with session_booking ON the driver turned every QUEUED request into
//      RECONCILE and made no call; cancelling a confirmed session reopened
//      Kyle's row titled "Book content session".
//   1. Switch missing: skipped, zero calls, the desk books it (desk-assisted).
//   2. Switch ON, client NOT authorised: zero writes, desk-assisted with the
//      reason; a queued row the guard refuses goes to RECONCILE + the desk.
//   3. Happy path: 1 address (no invented street), 1 order (variant, marker,
//      notify false), 1 appointment (our creative, customer notices off),
//      read back → CONFIRMED on the provider id, no desk task, month full.
//   4. Double submit: one request, one order, one appointment.
//   5. Timeout AFTER Aryeo committed the order: UNKNOWN, no appointment; the
//      marker scan finds it next tick; one order, one appointment in total.
//   6. Timeout BEFORE commit: two scans, then Kyle (RECOVER, the marker in the
//      task), never an automatic re-create; staff Retry → exactly one order.
//   7. Timeout after the appointment store committed: adopted by readback, no
//      second store.
//   8. Appointment refused (422): the order stands, Kyle books on it by hand,
//      the reconcile confirms on the ORDER id (PROVIDER_ORDER).
//   9. The slot was taken: CONFLICT, zero writes, "That time was just taken".
//  10. Readback mismatch: MISMATCH + a FIX task, never CONFIRMED.
//  11. Reconcile safety: an UNKNOWN booking whose slot passed is not expired
//      and not inference-matched; it goes to the desk as RECOVER.
//  12. Pro: two sessions = two orders, two appointments; full only after both.
//  13. Portal rules: Saturday and inside-24h refused server-side, zero calls.
//  14. Cancel a hub booking: PUT with `notify` (not notify_customer), read back
//      CANCELED; inside 24 hours refused with Kyle's number.
//  15. Cancel a hand-booked session: Kyle's row says CANCEL.
//  16. Reschedule a hub booking; a timed-out reschedule is settled by readback.
//  17. The staff wrappers refuse a TEST client's appointment.
//  19-23 (review fixes, Sep 24 2026): a hand-booked move never confirms on its
//      old time; a pending move changed again follows the chain and, withdrawn,
//      restores the booking (Pro keeps its second session); an authorised
//      fixture's hand-booked move is a desk move, and a new booking beside a
//      live old one asks Kyle to cancel it; "Change time" on a desk ask says
//      MOVE; switching session_booking off hands every stranded row to the desk.
//  24-32 (batch 3, Sep 25 2026 — §6.6 A23 and R03; OLD from 810b29f where it
//      is observable): a priced product creates NOTHING (desk, REJECTED); an
//      order that reads back owing money stores no appointment, parks in
//      RECONCILE with one PAYMENT_MISMATCH task and a Retry reuses the order;
//      the $0 path records total/balance/scope and the Stripe provenance (no
//      dollar amount) and writes the session address SYNCED; an order address
//      that reads back different is a MISMATCH; capacity, the plan's address
//      version and a moved gate anchor are re-checked before any write (OLD:
//      over capacity it booked anyway); a hub-booked session moved into an
//      occupied slot or a too-short drive is refused with zero PUT; two
//      bookings for one creative at overlapping times: one hold wins.
//      Every slot booking now starts from an exact-address plan (§3), so §3's
//      address assertion is FLIPPED: the exact street is sent, never an area.
//  33-34 (batch-3 review, Sep 25 2026): a Retry after PAYMENT_MISMATCH (or any
//      order resumed from the desk, or carried forward after a missed marker
//      scan) re-runs the 24 hours, the hub's clashes, the Aryeo slot, the drive
//      and the hold before the appointment is stored — the desk, naming the
//      order, when any says no; and a fee Aryeo adds WITH the appointment keeps
//      the booking and raises the one PAYMENT_MISMATCH task.
//  18. Fence: nothing reached anything but the fake Aryeo and the stub geocoder.
//
// NOT DRILLED, said plainly: the race between the immediate syncAryeoOrders
// ({ orderId }) and Aryeo's ORDER_CREATED webhook importing the same order
// (P2002 on Project.aryeoOrderId) — it is caught and left to the hourly sync.
// And none of this is Aryeo: the fake is the DOCUMENTED contract. The eight
// provider unknowns are Jordan's supervised test.
//
// ISOLATION: PGlite on 127.0.0.1:${DRILL_PORT ?? 5516} via the shared harness.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import { createFakeAryeo, DRILL_TEAM } from "./_fake-aryeo";

const PORT = Number(process.env.DRILL_PORT ?? 5516);
const REPO = path.resolve(__dirname, "../..");
const BASE = "e26cacd"; // pinned: the commit batches B–D start from (HEAD moved on once they were committed)
const BASE_B3 = "810b29f"; // pinned: batch 3's baseline (the adapter before its A23/R03 guards)

installNextStubs();

let fake: ReturnType<typeof createFakeAryeo>;
const geocodes: string[] = [];
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://geocoding.geo.census.gov/")) {
    const q = decodeURIComponent(new URL(url).searchParams.get("address") ?? "");
    geocodes.push(q);
    if (/nowhere/i.test(q)) return new Response(JSON.stringify({ result: { addressMatches: [] } }), { status: 200 });
    return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -75.6055, y: 39.9607 }, matchedAddress: q.toUpperCase() }] } }), { status: 200 });
  }
  if (url.startsWith("https://nominatim.openstreetmap.org/")) return new Response("[]", { status: 200 });
  // §6.6 W02: the drive-time estimate (OSRM), stubbed at 20 minutes for any pair.
  if (url.startsWith("https://router.project-osrm.org/")) { osrmCalls++; return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 16_000, duration: 20 * 60 }] }), { status: 200 }); }
  return fake ? fake.handle(url, init) : null;
});
let osrmCalls = 0;

// The bell: counted, never sent anywhere.

function writeBaseCopy(): { dir: string; sessionRequests: string; sessionBooking: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp04-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const copy = (rev: string, rel: string, name: string) => {
    const src = execFileSync("git", ["show", `${rev}:${rel}`], { cwd: REPO, encoding: "utf8" });
    const pointed = src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
    const file = path.join(dir, name);
    fs.writeFileSync(file, pointed);
    return file;
  };
  return { dir, sessionRequests: copy(BASE, "src/lib/sessionRequests.ts", "sessionRequests.base.ts"), sessionBooking: copy(BASE_B3, "src/lib/sessionBooking.ts", "sessionBooking.b3base.ts") };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
  const variantPrices: Record<string, number> = Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.variantId, 0]));
  fake = createFakeAryeo({
    products: {
      [ARYEO_CONTENT_PRODUCTS.Starter.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
      [ARYEO_CONTENT_PRODUCTS.Accelerator.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
      [ARYEO_CONTENT_PRODUCTS.Pro.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
    },
    // R03: the catalogue as Phase 0 read it — each program product's one variant at $0.
    variants: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.productId, p.variantId])),
    variantPrices,
    // R02: every drill customer reads back as the verified test inbox.
    defaultCustomerEmail: "info@realtourpilot.com",
  });
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo", "drill-key-not-a-real-one");
  const aryeo = await import("@/lib/integrations/aryeo");
  const sr = await import("@/lib/sessionRequests");
  const sb = await import("@/lib/sessionBooking");
  const pa = await import("@/app/portal/actions");
  const base = writeBaseCopy();

  const HOUR = 3_600_000;
  const MIN = 60_000;
  const now = () => new Date();
  // Weekday slots in October 2026 (EDT, UTC-4), far enough out for every rule.
  const at = (day: string, hourET: number, min = 0) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hourET + 4, min));
  const JAMES = { teamMemberId: DRILL_TEAM.james.tm, name: DRILL_TEAM.james.name };
  let n = 0;

  const setSwitch = async (key: string, enabled: boolean, config: Record<string, unknown> | null = null) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(), configJson: config ? JSON.stringify(config) : null }, update: { enabled, configJson: config ? JSON.stringify(config) : null } });
  const dropSwitch = (key: string) => prisma.programAutomation.deleteMany({ where: { key } });
  const authorised = new Set<string>();
  const authorise = async (clientId: string) => { authorised.add(clientId); await setSwitch("session_booking", true, { authorizedFixtureClientIds: [...authorised] }); };

  const world = async (pkg: "Accelerator" | "Pro" | "Starter" = "Accelerator", opts: { authorise?: boolean } = {}): Promise<ContentMonthFixture> => {
    const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: `Booking Drill ${++n} TEST`, package: pkg, monthKey: "2026-10", project: false, owner: { email: `booking${n}@realtourpilot.com` } });
    // R02 (batch 3): a fixture's own inbox and its Aryeo customer's are the verified test inbox.
    await prisma.client.update({ where: { id: f.clientId }, data: { email: "info@realtourpilot.com", aryeoCustomerId: `0197cccc-0000-4000-8000-${String(n).padStart(12, "0")}` } });
    if (opts.authorise !== false) await authorise(f.clientId);
    return f;
  };
  // §6.6 W02 (batch 3): a slot booking starts from the session's exact-address
  // plan and carries the travel check it passed; this is what the portal sends.
  const sa = await import("@/lib/sessionAddress");
  const planFor = async (f: ContentMonthFixture, sessionIndex = 1) => {
    const saved = await sa.saveSessionPlanAddress({ enrollmentId: f.enrollmentId, monthId: f.monthId, sessionIndex, input: { street: "117 Kyle Lane", unit: "Unit 2", city: "West Chester", state: "PA", zip: "19382" }, by: "drill" });
    if (!saved.ok || !saved.planId) throw new Error(`plan: ${saved.message}`);
    return { planId: saved.planId, addressVersion: saved.addressVersion! };
  };
  const request = async (f: ContentMonthFixture, start: Date, over: Partial<Parameters<typeof sr.createSessionRequest>[0]> = {}, sessionIndex = 1) =>
    sr.createSessionRequest({
      enrollmentId: f.enrollmentId, monthId: f.monthId,
      slot: { startISO: start.toISOString(), endISO: new Date(start.getTime() + 4 * HOUR).toISOString() },
      actor: { kind: "STAFF", userId: null }, creative: JAMES,
      plan: await planFor(f, sessionIndex), travel: { check: "HUB_DRIVE", evidenceJson: null }, sessionIndex,
      ...over,
    });
  const reqRow = (id: string) => prisma.programSessionRequest.findUniqueOrThrow({ where: { id } });
  const deskTask = (id: string) => prisma.smartTask.findUnique({ where: { dedupeKey: `content-session-request-${id}` } });
  const writes = (m: string, p: string) => fake.count(m, p);
  const committed = (m: string, p: string) => fake.count(m, p, true);

  // ======================================================================
  c.head("0 · OLD: the driver refused every booking, and a cancel read as a booking");
  {
    const old = (await import(base.sessionRequests)) as typeof sr;
    const f = await world("Accelerator", { authorise: false });
    await setSwitch("session_booking", true);
    const q = await prisma.programSessionRequest.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, slotStart: at("2026-10-05", 10), slotEnd: at("2026-10-05", 14), status: "REQUESTED", bookingState: "QUEUED", dedupeKey: `${f.enrollmentId}:${f.monthId}:old-q` } });
    const before = fake.writes.length;
    await old.driveSessionBookings({ max: 10 });
    const after = await reqRow(q.id);
    c.ok("OLD: a QUEUED request became RECONCILE", after.bookingState === "RECONCILE", after.bookingState);
    c.ok("OLD: with the sentence that the create is not verified", /not verified/.test(after.lastError ?? ""), after.lastError ?? "");
    c.ok("OLD: and not one call reached Aryeo", fake.writes.length === before, `${fake.writes.length - before} writes`);
    const conf = await prisma.programSessionRequest.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, slotStart: at("2026-10-07", 10), slotEnd: at("2026-10-07", 14), status: "CONFIRMED", aryeoAppointmentId: "hand-booked-1", dedupeKey: `${f.enrollmentId}:${f.monthId}:old-c` } });
    await old.cancelSessionRequest(conf.id, "drill", "client asked");
    const t = await deskTask(conf.id);
    c.ok("OLD: a client's cancel reopened Kyle's row titled \"Book content session\"", !!t && t.title.startsWith("Book content session"), t?.title ?? "(no task)");
    c.ok("OLD: telling him to \"Book it in Aryeo\"", !!t?.description?.includes("Book it in Aryeo"), (t?.description ?? "").slice(-90));
    await dropSwitch("session_booking");
  }

  // ======================================================================
  c.head("1 · switch missing: nothing is attempted; the desk books it");
  {
    const f = await world("Accelerator", { authorise: false });
    await dropSwitch("session_booking");
    const before = fake.writes.length;
    const r = await request(f, at("2026-10-05", 10));
    const row = r.ok ? await reqRow(r.id) : null;
    c.ok("the request is written, desk-assisted (bookingState NONE)", row?.bookingState === "NONE", row?.bookingState ?? JSON.stringify(r));
    c.ok("Kyle has the booking task", !!(row && (await deskTask(row.id))?.title.startsWith("Book content session")), (row && (await deskTask(row.id))?.title) ?? "");
    c.ok("the client is told a person books it", r.ok && /Kyle books it/.test(r.message), r.ok ? r.message : "");
    const d = await sb.driveSessionBookings({});
    c.ok("the driver reports skipped", "skipped" in d, JSON.stringify(d));
    c.ok("zero calls to Aryeo", fake.writes.length === before, `${fake.writes.length - before}`);
  }

  // ======================================================================
  c.head("2 · switch ON, client not authorised: still desk-assisted, zero writes");
  {
    const f = await world("Accelerator", { authorise: false });
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [...authorised] });
    const before = fake.writes.length;
    const r = await request(f, at("2026-10-05", 11));
    const row = r.ok ? await reqRow(r.id) : null;
    c.ok("not queued for the adapter (bookingState NONE)", row?.bookingState === "NONE", row?.bookingState ?? "");
    c.ok("the refusal reason is on the row", /desk-assisted: .*authorizedFixtureClientIds/.test(row?.lastError ?? ""), row?.lastError ?? "");
    c.ok("one desk task", !!(row && (await deskTask(row.id))), "");
    // A row QUEUED before the client left the list is refused by the guard itself.
    await prisma.programSessionRequest.update({ where: { id: row!.id }, data: { bookingState: "QUEUED" } });
    const o = await sb.bookSessionRequest(row!.id, {});
    const after = await reqRow(row!.id);
    c.ok("the adapter hands it to the desk (RECONCILE) instead of writing", o.outcome === "desk" && after.bookingState === "RECONCILE", `${o.outcome}: ${o.detail}`);
    c.ok("zero writes reached Aryeo", fake.writes.length === before, `${fake.writes.length - before}`);
    const g = await aryeo.hubWritePermit({ switchKey: "session_booking", client: { id: f.clientId, name: "Real Person" }, operation: "orders.create" });
    c.ok("and the guard refuses a non-TEST name even when listed", !g.ok, g.ok ? "allowed!" : g.reason.slice(0, 80));
    let threw = "";
    try { await aryeo.AryeoBooking.createOrder({ switchKey: "session_booking", clientId: f.clientId, clientName: "x", operation: "orders.create", issuedAt: Date.now() }, { customer_id: "c", address_id: "a", variantId: "v", internal_notes: "n" }); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    c.ok("a hand-made permit is refused before any socket opens", /no write permit/.test(threw) && fake.writes.length === before, threw);
  }

  // ======================================================================
  c.head("3 · happy path: one address, one order, one appointment, read back");
  let happy: { f: ContentMonthFixture; id: string } | null = null;
  {
    const f = await world("Accelerator");
    const start = at("2026-10-05", 10);
    const before = { a: writes("POST", "/addresses"), o: writes("POST", "/orders"), s: writes("POST", "/appointments/store") };
    const r = await request(f, start);
    const queued = r.ok ? await reqRow(r.id) : null;
    c.ok("an authorised fixture is QUEUED for the adapter", queued?.bookingState === "QUEUED", queued?.bookingState ?? JSON.stringify(r));
    c.ok("and NO desk task is raised while the hub books it", queued ? !(await deskTask(queued.id)) : false);
    const o = await sb.bookSessionRequest(queued!.id, {});
    const row = await reqRow(queued!.id);
    c.ok("CONFIRMED", o.outcome === "confirmed" && row.status === "CONFIRMED", `${o.outcome}: ${o.detail}`);
    c.ok("on the provider's own id", row.matchState === "PROVIDER_ID" && row.bookingState === "SUCCEEDED" && !!row.aryeoAppointmentId && !!row.providerConfirmedAt, `${row.matchState} ${row.bookingState}`);
    const addr = fake.writes.filter((w) => w.method === "POST" && w.path === "/addresses").slice(before.a);
    const ab = addr[0]?.body as Record<string, unknown> | undefined;
    c.ok("exactly 1 POST /addresses", addr.length === 1, `${addr.length}`);
    // FLIPPED in batch 3 (§3 "an exact address is required … this supersedes
    // earlier area-only booking"): this line used to assert "the area only …
    // and NO street" as a PASS.
    c.ok("the plan's EXACT street (number, name, unit) + city/state/zip + lat/lng", ab?.street_number === "117" && ab?.street_name === "Kyle Lane" && ab?.unit_number === "Unit 2" && ab?.city === "West Chester" && ab?.state_or_province === "PA" && ab?.postal_code === "19382" && typeof ab?.latitude === "number", JSON.stringify(ab));
    const ord = fake.writes.filter((w) => w.method === "POST" && w.path === "/orders").slice(before.o);
    const ob = ord[0]?.body as { product_items?: { variant_id: string }[]; internal_notes?: string; notify?: boolean; customer_id?: string } | undefined;
    c.ok("exactly 1 POST /orders", ord.length === 1, `${ord.length}`);
    c.ok("for the Accelerator variant", ob?.product_items?.[0]?.variant_id === ARYEO_CONTENT_PRODUCTS.Accelerator.variantId, ob?.product_items?.[0]?.variant_id);
    c.ok("carrying the marker hub-session:<id>:1 in the team-only notes", !!ob?.internal_notes?.includes(`hub-session:${row.id}:1`), ob?.internal_notes);
    c.ok("with customer notifications off (notify false)", ob?.notify === false, String(ob?.notify));
    const st = fake.writes.filter((w) => w.method === "POST" && w.path === "/appointments/store").slice(before.s);
    const sbody = st[0]?.body as { order_id?: string; start_at?: string; end_at?: string; company_team_member_ids?: string[]; notifyCustomer?: boolean; notifyCompany?: boolean; notify?: boolean } | undefined;
    c.ok("exactly 1 POST /appointments/store", st.length === 1, `${st.length}`);
    c.ok("on our order, at our times, with James", sbody?.order_id === row.aryeoOrderId && sbody?.start_at === "2026-10-05T14:00:00Z" && sbody?.end_at === "2026-10-05T18:00:00Z" && sbody?.company_team_member_ids?.[0] === DRILL_TEAM.james.tm, JSON.stringify(sbody));
    c.ok("customer notice off, our team's on", sbody?.notifyCustomer === false && sbody?.notify === false && sbody?.notifyCompany === true, JSON.stringify({ c: sbody?.notifyCustomer, n: sbody?.notify, co: sbody?.notifyCompany }));
    const att = await prisma.programBookingAttempt.findMany({ where: { requestId: row.id } });
    c.ok("the attempt row is CONFIRMED with its marker", att.length === 1 && att[0].state === "CONFIRMED" && att[0].marker === `hub-session:${row.id}:1`, JSON.stringify(att.map((a) => [a.state, a.marker])));
    c.ok("no open desk task", !(await deskTask(row.id)) || (await deskTask(row.id))!.status !== "OPEN");
    const cap = await sr.sessionCapacity(f.enrollmentId, f.monthId);
    c.ok("the month reads fully scheduled", cap.fullyScheduled && cap.confirmedSessions === 1, JSON.stringify({ full: cap.fullyScheduled, confirmed: cap.confirmedSessions }));
    c.ok("the client label is \"Booked\"", sr.sessionRequestLabel(row.status, row.bookingState) === "Booked");
    const proj = await prisma.project.findFirst({ where: { aryeoOrderId: row.aryeoOrderId } });
    console.log(`    (best-effort import of the new order: ${proj ? `project ${proj.id}, contentMonthId ${proj.contentMonthId === f.monthId ? "= this month" : proj.contentMonthId}` : "not imported by the one-order sync against the fake; the hourly sync would"})`);
    happy = { f, id: row.id };
  }

  // ======================================================================
  c.head("4 · double submit: one request, one order, one appointment");
  {
    const f = await world("Accelerator");
    const start = at("2026-10-06", 10);
    const o0 = committed("POST", "/orders"), s0 = committed("POST", "/appointments/store");
    const [a, b] = [await request(f, start), await request(f, start)];
    c.ok("the second click is the same request", a.ok && b.ok && a.id === b.id && b.duplicate, JSON.stringify([a.ok && a.id, b.ok && b.id, b.ok && b.duplicate]));
    await Promise.all([sb.driveSessionBookings({}), sb.driveSessionBookings({})]);
    await sb.driveSessionBookings({});
    c.ok("exactly one order", committed("POST", "/orders") - o0 === 1, `${committed("POST", "/orders") - o0}`);
    c.ok("exactly one appointment", committed("POST", "/appointments/store") - s0 === 1, `${committed("POST", "/appointments/store") - s0}`);
    c.ok("one request row for the slot", (await prisma.programSessionRequest.count({ where: { enrollmentId: f.enrollmentId } })) === 1);
  }

  // ======================================================================
  c.head("5 · the order times out AFTER Aryeo committed it");
  {
    const f = await world("Accelerator");
    const r = await request(f, at("2026-10-07", 10));
    if (!r.ok) throw new Error(r.reason);
    fake.script("POST /orders", "abort-after-commit");
    const o0 = committed("POST", "/orders"), s0 = writes("POST", "/appointments/store");
    const t0 = now();
    const first = await sb.bookSessionRequest(r.id, { now: t0 });
    const row1 = await reqRow(r.id);
    c.ok("UNKNOWN — it may exist", first.outcome === "unknown" && row1.bookingState === "UNKNOWN", `${first.outcome} ${row1.bookingState}`);
    c.ok("and no appointment was attempted", writes("POST", "/appointments/store") === s0);
    c.ok("the request is not shown as booked", sr.sessionRequestLabel(row1.status, row1.bookingState) === "Confirming with the calendar", sr.sessionRequestLabel(row1.status, row1.bookingState));
    const early = await sb.bookSessionRequest(r.id, { now: new Date(t0.getTime() + 2 * MIN) });
    c.ok("an early tick does nothing (not due)", early.outcome === "busy", early.outcome);
    const second = await sb.bookSessionRequest(r.id, { now: new Date(t0.getTime() + 11 * MIN) });
    const row2 = await reqRow(r.id);
    c.ok("the marker scan found the order and finished the booking", second.outcome === "confirmed" && row2.status === "CONFIRMED", `${second.outcome}: ${second.detail}`);
    c.ok("in total: ONE order", committed("POST", "/orders") - o0 === 1, `${committed("POST", "/orders") - o0}`);
    c.ok("and ONE appointment", writes("POST", "/appointments/store") - s0 === 1);
  }

  // ======================================================================
  c.head("6 · the order times out BEFORE Aryeo committed it");
  {
    const f = await world("Accelerator");
    const r = await request(f, at("2026-10-08", 10));
    if (!r.ok) throw new Error(r.reason);
    fake.script("POST /orders", "abort-before-commit");
    const o0 = writes("POST", "/orders"), oc0 = committed("POST", "/orders");
    const t0 = now();
    await sb.bookSessionRequest(r.id, { now: t0 });
    const s1 = await sb.bookSessionRequest(r.id, { now: new Date(t0.getTime() + 11 * MIN) });
    c.ok("scan 1 (+10 min): not found, waits", s1.outcome === "pending", `${s1.outcome}: ${s1.detail}`);
    const s2 = await sb.bookSessionRequest(r.id, { now: new Date(t0.getTime() + 36 * MIN) });
    const row = await reqRow(r.id);
    c.ok("scan 2 (+35 min): handed to Kyle as RECONCILE", s2.outcome === "desk" && row.bookingState === "RECONCILE", `${s2.outcome} ${row.bookingState}`);
    const t = await deskTask(r.id);
    c.ok("Kyle's task names the marker to search for", !!t?.description?.includes(`hub-session:${r.id}`) && t.title.startsWith("Check Aryeo for a hub booking"), t?.title);
    c.ok("and the hub made NO second order on its own", writes("POST", "/orders") - o0 === 1, `${writes("POST", "/orders") - o0} sent`);
    const refused = await sb.retrySessionBooking(r.id, { confirmedNoOrder: false, by: "drill" });
    c.ok("Retry without the person's confirmation is refused", !refused.ok && /hub-session/.test(refused.message), refused.message);
    const ok = await sb.retrySessionBooking(r.id, { confirmedNoOrder: true, by: "drill" });
    c.ok("with it, the request is queued again", ok.ok, ok.message);
    const b = await sb.bookSessionRequest(r.id, { now: new Date(t0.getTime() + 40 * MIN) });
    const att = await prisma.programBookingAttempt.findMany({ where: { requestId: r.id }, orderBy: { attemptNo: "asc" } });
    c.ok("attempt 2 booked it", b.outcome === "confirmed" && att.length === 2 && att[0].state === "ABANDONED" && att[1].state === "CONFIRMED" && att[1].marker.endsWith(":2"), JSON.stringify(att.map((a) => [a.attemptNo, a.state])));
    c.ok("exactly one order exists", committed("POST", "/orders") - oc0 === 1, `${committed("POST", "/orders") - oc0}`);
  }

  // ======================================================================
  c.head("7 · the appointment store times out after Aryeo committed it");
  {
    const f = await world("Accelerator");
    const r = await request(f, at("2026-10-09", 10));
    if (!r.ok) throw new Error(r.reason);
    fake.script("POST /appointments/store", "abort-after-commit");
    const s0 = writes("POST", "/appointments/store");
    const t0 = now();
    const a = await sb.bookSessionRequest(r.id, { now: t0 });
    c.ok("UNKNOWN after the store", a.outcome === "unknown", `${a.outcome}: ${a.detail}`);
    const b = await sb.bookSessionRequest(r.id, { now: new Date(t0.getTime() + 11 * MIN) });
    c.ok("the order readback adopted the appointment → CONFIRMED", b.outcome === "confirmed", `${b.outcome}: ${b.detail}`);
    c.ok("with no second store call", writes("POST", "/appointments/store") - s0 === 1, `${writes("POST", "/appointments/store") - s0}`);
  }

  // ======================================================================
  c.head("8 · Aryeo refuses the appointment: the order stands, Kyle books on it");
  {
    const f = await world("Accelerator");
    const r = await request(f, at("2026-10-12", 10));
    if (!r.ok) throw new Error(r.reason);
    fake.script("POST /appointments/store", { status: 422, message: "The start at is not available." });
    const o = await sb.bookSessionRequest(r.id, {});
    const row = await reqRow(r.id);
    c.ok("REJECTED, still a request", o.outcome === "rejected" && row.bookingState === "REJECTED" && row.status === "REQUESTED", `${o.outcome} ${row.bookingState}`);
    const t = await deskTask(r.id);
    c.ok("Kyle's task: the order exists without an appointment — book on THAT order", !!t && /exists in Aryeo without an appointment/.test(t.description ?? "") && t.title.startsWith("Fix a hub booking"), t?.title);
    // Kyle books it by hand on our order; the sync brings it home.
    const p = await prisma.project.create({ data: { clientId: f.clientId, title: "Hand-booked on the hub's order", status: "SCHEDULED", aryeoOrderId: row.aryeoOrderId, contentMonthId: null }, select: { id: true } });
    await prisma.appointment.create({ data: { projectId: p.id, aryeoId: "kyle-by-hand-1", startAt: at("2026-10-12", 13), endAt: at("2026-10-12", 17), status: "SCHEDULED" } });
    await sr.reconcileSessionRequests();
    const after = await reqRow(r.id);
    c.ok("the reconcile confirms on the ORDER id (PROVIDER_ORDER), at Kyle's time", after.status === "CONFIRMED" && after.matchState === "PROVIDER_ORDER" && after.aryeoAppointmentId === "kyle-by-hand-1", `${after.status} ${after.matchState}`);
  }

  // ======================================================================
  c.head("9 · the slot was taken between the pick and the booking");
  {
    const f = await world("Accelerator");
    const start = at("2026-10-13", 10);
    fake.taken.add(start.toISOString().replace(".000Z", "Z"));
    const r = await request(f, start);
    if (!r.ok) throw new Error(r.reason);
    const w0 = fake.writes.length;
    const o = await sb.bookSessionRequest(r.id, {});
    const row = await reqRow(r.id);
    c.ok("CONFLICT", o.outcome === "conflict" && row.bookingState === "CONFLICT", o.outcome);
    c.ok("zero writes", fake.writes.length === w0, `${fake.writes.length - w0}`);
    c.ok("the client reads \"That time was just taken. Pick another time.\"", sr.sessionRequestLabel(row.status, row.bookingState) === "That time was just taken. Pick another time.");
    const cap = await sr.sessionCapacity(f.enrollmentId, f.monthId);
    c.ok("and the dead ask does not hold the month's place", cap.remaining === 1, JSON.stringify(cap));
    const again = await request(f, at("2026-10-13", 11));
    c.ok("picking again is allowed, and closes the conflicted ask", again.ok && (await reqRow(r.id)).status === "CANCELLED", again.ok ? "" : again.reason);
  }

  // ======================================================================
  c.head("10 · Aryeo's copy does not match what was asked");
  {
    const f = await world("Accelerator");
    const r = await request(f, at("2026-10-14", 10));
    if (!r.ok) throw new Error(r.reason);
    fake.script("POST /appointments/store", "shift-start-30");
    const o = await sb.bookSessionRequest(r.id, {});
    const row = await reqRow(r.id);
    c.ok("MISMATCH, never CONFIRMED", o.outcome === "mismatch" && row.status === "REQUESTED" && row.bookingState === "MISMATCH", `${o.outcome} ${row.status}`);
    const t = await deskTask(r.id);
    c.ok("Kyle has a FIX task saying what differs", !!t && t.title.startsWith("Fix a hub booking") && /starts/.test(t.description ?? ""), t?.title);
    await sr.reconcileSessionRequests();
    c.ok("and the reconcile does not confirm it behind his back", (await reqRow(r.id)).status === "REQUESTED");
  }

  // ======================================================================
  c.head("11 · reconcile safety: a half-made booking is never expired or guessed");
  {
    const f = await world("Accelerator");
    const past = new Date(Date.now() - 3 * 864e5);
    const q = await prisma.programSessionRequest.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, slotStart: past, slotEnd: new Date(past.getTime() + 4 * HOUR), status: "REQUESTED", bookingState: "UNKNOWN", dedupeKey: `${f.enrollmentId}:${f.monthId}:unknown-past` } });
    // A content appointment right at the slot — what inference would have taken.
    const p = await prisma.project.create({ data: { clientId: f.clientId, title: "Nearby content job", status: "SCHEDULED", contentMonthId: f.monthId }, select: { id: true } });
    await prisma.appointment.create({ data: { projectId: p.id, aryeoId: "nearby-1", startAt: past, endAt: new Date(past.getTime() + 4 * HOUR), status: "SCHEDULED" } });
    await sr.reconcileSessionRequests();
    const row = await reqRow(q.id);
    c.ok("not EXPIRED", row.status === "REQUESTED", row.status);
    c.ok("not inference-matched to the nearby appointment", !row.aryeoAppointmentId && row.matchState === null, `${row.aryeoAppointmentId} ${row.matchState}`);
    const t = await deskTask(q.id);
    c.ok("handed to Kyle as RECOVER", !!t && t.title.startsWith("Check Aryeo for a hub booking"), t?.title);
    await sr.reconcileSessionRequests();
    c.ok("once — the next hour does not re-raise it", (await prisma.smartTask.count({ where: { dedupeKey: `content-session-request-${q.id}` } })) === 1);
  }

  // ======================================================================
  c.head("12 · Pro: two distinct bookings, full only after both");
  {
    const f = await world("Pro");
    const o0 = committed("POST", "/orders"), s0 = committed("POST", "/appointments/store");
    const a = await request(f, at("2026-10-15", 10));
    if (!a.ok) throw new Error(a.reason);
    await sb.bookSessionRequest(a.id, {});
    const mid = await sr.sessionCapacity(f.enrollmentId, f.monthId);
    c.ok("after one booking: NOT fully scheduled, one remaining", !mid.fullyScheduled && mid.remaining === 1 && mid.confirmedSessions === 1, JSON.stringify({ full: mid.fullyScheduled, rem: mid.remaining }));
    const b = await request(f, at("2026-10-16", 10), {}, 2);
    if (!b.ok) throw new Error(b.reason);
    await sb.bookSessionRequest(b.id, {});
    const full = await sr.sessionCapacity(f.enrollmentId, f.monthId);
    c.ok("after the second: fully scheduled", full.fullyScheduled && full.confirmedSessions === 2, JSON.stringify({ full: full.fullyScheduled, c: full.confirmedSessions }));
    c.ok("two orders (one per session)", committed("POST", "/orders") - o0 === 2);
    c.ok("two appointments", committed("POST", "/appointments/store") - s0 === 2);
    const [ra, rb] = [await reqRow(a.id), await reqRow(b.id)];
    c.ok("on two different orders", !!ra.aryeoOrderId && !!rb.aryeoOrderId && ra.aryeoOrderId !== rb.aryeoOrderId);
    const third = await request(f, at("2026-10-19", 10));
    c.ok("a third package session is refused as full", !third.ok && /already booked or requested/.test(third.ok ? "" : third.reason), third.ok ? "accepted!" : third.reason);
  }

  // ======================================================================
  c.head("13 · portal rules, server-side, before any call");
  {
    const f = await world("Accelerator");
    const w0 = fake.writes.length;
    const auth = { token: f.portalToken };
    const sat = await pa.portalRequestSession(auth, { monthId: f.monthId, slotISO: at("2026-10-10", 10).toISOString(), location: "West Chester, PA", creativeTeamMemberId: DRILL_TEAM.james.tm });
    c.ok("a Saturday slot POSTed straight at the action is refused", !sat.ok && /Monday through Friday/.test(sat.message), sat.message);
    // Pinned to Tue Oct 6, 18:00 ET, so "20 hours out" is Wed 14:00 ET — a
    // weekday. On the real clock it failed every Friday morning: 20 hours out
    // is a Saturday, and the weekend rule (correctly) answers first.
    const PINNED_NOW = Date.parse("2026-10-06T22:00:00Z");
    const soon = new Date(PINNED_NOW + 20 * HOUR);
    const RealDate = Date;
    class PinnedDate extends RealDate {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) { if (args.length === 0) super(PINNED_NOW); else super(...(args as [number])); }
      static now(): number { return PINNED_NOW; }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = PinnedDate;
    let tomorrow: Awaited<ReturnType<typeof pa.portalRequestSession>>;
    try {
      tomorrow = await pa.portalRequestSession(auth, { monthId: f.monthId, slotISO: soon.toISOString(), location: "West Chester, PA", creativeTeamMemberId: DRILL_TEAM.james.tm });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = RealDate;
    }
    c.ok("a slot 20 hours out is refused with Kyle's number", !tomorrow.ok && tomorrow.message.includes("(215) 645-4889"), tomorrow.message);
    c.ok("zero calls to Aryeo for either", fake.writes.length === w0);
    c.ok("and no request row was written", (await prisma.programSessionRequest.count({ where: { enrollmentId: f.enrollmentId } })) === 0);
  }

  // ======================================================================
  c.head("14 · cancel a session the hub booked");
  {
    if (!happy) throw new Error("happy path did not run");
    const w0 = writes("PUT", "/appointments/");
    const row0 = await reqRow(happy.id);
    const res = await sr.cancelSessionRequest(happy.id, "client-drill", "can't make it", { actor: "CLIENT" });
    const row = await reqRow(happy.id);
    const put = fake.writes.filter((w) => w.method === "PUT" && w.path.endsWith("/cancel")).slice(-1)[0];
    c.ok("one PUT /cancel", writes("PUT", "/appointments/") - w0 === 1 && !!put && put.path.includes(row0.aryeoAppointmentId!), `${writes("PUT", "/appointments/") - w0}`);
    c.ok("with the documented `notify` key (false) and no `notify_customer`", !!put && (put.body as Record<string, unknown>).notify === false && !("notify_customer" in (put.body as Record<string, unknown>)), JSON.stringify(put?.body));
    c.ok("read back CANCELED → the request is CANCELLED", res.ok && row.status === "CANCELLED", `${res.status}: ${res.message}`);
    c.ok("confirmedAt is kept (the reminders' loss stamp reads it)", !!row.confirmedAt && !!row.cancelledAt);
    const cap = await sr.sessionCapacity(happy.f.enrollmentId, happy.f.monthId);
    c.ok("the month is back to one session missing", !cap.fullyScheduled && cap.remaining === 1, JSON.stringify({ full: cap.fullyScheduled, rem: cap.remaining }));
    const { evaluateReminders } = await import("@/lib/programReminders");
    const ev = await evaluateReminders({ dryRun: true, enrollmentIds: [happy.f.enrollmentId], now: new Date("2026-10-02T15:00:00Z") });
    const prim = ev.candidates.find((x) => x.lane === "PRIMARY");
    // (The fixture month has no strategy call, so the PRIMARY action it asks
    // for is the call; what matters here is that the evaluator's session count
    // — the one BOOK_SESSION keys off — has the session missing again.)
    c.ok("and the reminder evaluator counts the session missing again", prim?.state.sessionsMissing === 1 && prim.state.fullyScheduled === false, `${prim?.action} missing=${prim?.state.sessionsMissing}`);

    // inside 24 hours (the clock is moved to 20 hours before the session)
    const f = await world("Accelerator");
    const soon = at("2026-10-29", 10);
    const q = await request(f, soon);
    if (!q.ok) throw new Error(q.reason);
    await sb.bookSessionRequest(q.id, {});
    const booked = await reqRow(q.id);
    const w1 = fake.writes.length;
    const late = await sr.cancelSessionRequest(q.id, "client-drill", "", { actor: "CLIENT", now: new Date(soon.getTime() - 20 * HOUR) });
    c.ok(`(the near session booked: ${booked.status})`, booked.status === "CONFIRMED", booked.bookingState);
    c.ok("a client cancel inside 24 hours is refused with Kyle's number", !late.ok && late.message.includes("(215) 645-4889"), late.message);
    c.ok("with zero writes", fake.writes.length === w1);
  }

  // ======================================================================
  c.head("15 · cancel a hand-booked session: Kyle's row says CANCEL");
  {
    const f = await world("Accelerator", { authorise: false });
    const q = await prisma.programSessionRequest.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, slotStart: at("2026-10-20", 10), slotEnd: at("2026-10-20", 14), status: "CONFIRMED", aryeoAppointmentId: "hand-2", dedupeKey: `${f.enrollmentId}:${f.monthId}:hand` } });
    const w0 = fake.writes.length;
    const res = await sr.cancelSessionRequest(q.id, "client-drill", "", { actor: "CLIENT" });
    const t = await deskTask(q.id);
    c.ok("CANCEL_REQUESTED", res.status === "CANCEL_REQUESTED" && (await reqRow(q.id)).status === "CANCEL_REQUESTED", res.status);
    c.ok("Kyle's task is titled \"Cancel content session\"", !!t && t.title.startsWith("Cancel content session"), t?.title);
    c.ok("and tells him to cancel, not book", !!t?.description?.includes("cancel it in Aryeo") || !!t?.description?.includes("Cancel appointment"), (t?.description ?? "").slice(-120));
    c.ok("the hub wrote nothing to Aryeo for a hand booking", fake.writes.length === w0);
  }

  // ======================================================================
  c.head("16 · reschedule a session the hub booked");
  {
    const f = await world("Accelerator");
    const r = await request(f, at("2026-10-21", 10));
    if (!r.ok) throw new Error(r.reason);
    await sb.bookSessionRequest(r.id, {});
    const before = await reqRow(r.id);
    const p0 = fake.count("PUT", "/appointments/");
    const moved = await sr.requestReschedule(r.id, { startISO: at("2026-10-22", 11).toISOString(), endISO: null }, null, { kind: "CLIENT", clientUserId: f.clientUserId });
    const after = await reqRow(r.id);
    c.ok("moved in Aryeo and read back", moved.ok && after.slotStart?.toISOString() === at("2026-10-22", 11).toISOString(), moved.message);
    c.ok("one PUT /reschedule, same appointment, still CONFIRMED", fake.count("PUT", "/appointments/") - p0 === 1 && after.aryeoAppointmentId === before.aryeoAppointmentId && after.status === "CONFIRMED");
    c.ok("its identity moved with it", after.dedupeKey === `${f.enrollmentId}:${f.monthId}:${at("2026-10-22", 11).toISOString()}`, after.dedupeKey ?? "");
    // A reschedule that times out after landing: settled by readback, no second PUT.
    fake.script("PUT /appointments/:id/reschedule", "abort-after-commit");
    const p1 = fake.count("PUT", "/appointments/");
    const t0 = now();
    const m2 = await sr.requestReschedule(r.id, { startISO: at("2026-10-23", 10).toISOString(), endISO: null }, null, { kind: "CLIENT", clientUserId: f.clientUserId }, { now: t0 });
    c.ok("the timed-out move reads as pending, not done", m2.ok && /Moving/.test(m2.message), m2.message);
    await sb.driveSessionBookings({ now: new Date(t0.getTime() + 11 * MIN) });
    const settled = await reqRow(r.id);
    c.ok("the next tick's readback settles it at the new time", settled.slotStart?.toISOString() === at("2026-10-23", 10).toISOString() && !settled.pendingChangeJson, settled.slotStart?.toISOString());
    c.ok("with no second PUT", fake.count("PUT", "/appointments/") - p1 === 1, `${fake.count("PUT", "/appointments/") - p1}`);
    // A hand-booked (desk) session moved from the portal: a new request, Kyle's row says MOVE.
    const g = await world("Accelerator", { authorise: false });
    const hand = await prisma.programSessionRequest.create({ data: { enrollmentId: g.enrollmentId, clientId: g.clientId, monthId: g.monthId, slotStart: at("2026-10-26", 10), slotEnd: at("2026-10-26", 14), status: "CONFIRMED", aryeoAppointmentId: "hand-3", dedupeKey: `${g.enrollmentId}:${g.monthId}:hand3` } });
    const mv = await sr.requestReschedule(hand.id, { startISO: at("2026-10-27", 10).toISOString(), endISO: null }, JAMES, { kind: "CLIENT", clientUserId: g.clientUserId });
    const t = mv.id ? await deskTask(mv.id) : null;
    c.ok("a desk session's move is a new request that replaces it", mv.ok && !!mv.id && mv.id !== hand.id && (await reqRow(hand.id)).status === "RESCHEDULE_REQUESTED", mv.message);
    c.ok("and Kyle's row says MOVE, naming the old appointment", !!t && t.title.startsWith("Move content session") && /hand-3/.test(t.description ?? ""), t?.title);
  }

  // ======================================================================
  c.head("17 · the staff appointment buttons refuse a TEST client's appointment");
  {
    const { cancelAppointmentAction } = await import("@/app/actions");
    const f = await world("Accelerator", { authorise: false });
    const p = await prisma.project.create({ data: { clientId: f.clientId, title: "TEST appointment", status: "SCHEDULED" }, select: { id: true } });
    const a = await prisma.appointment.create({ data: { projectId: p.id, aryeoId: "test-appt-1", startAt: at("2026-10-28", 10), status: "SCHEDULED", canCancel: true } });
    const w0 = fake.writes.length;
    const r = await cancelAppointmentAction(a.id, false);
    c.ok("refused by the provider-write guard", !r.ok && /Refusing provider write/.test(r.message), r.message);
    c.ok("with zero writes", fake.writes.length === w0);
  }

  // ======================================================================
  // REVIEW FIXES (Sep 24 2026). These defects were in this batch's own new
  // code (HEAD has no reschedule at all), so the OLD behaviour is shown where
  // it can be — the matcher with the old claimed set — and otherwise the new
  // rule is asserted directly.
  const handBooked = async (pkg: "Accelerator" | "Pro", start: Date, label: string) => {
    const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: `${label} ${++n} TEST`, package: pkg, monthKey: "2026-10", appointments: [{ startAt: start, durationMin: 240 }], owner: { email: `handmove${n}@realtourpilot.com` } });
    const x = await prisma.appointment.findUniqueOrThrow({ where: { id: f.appointmentIds[0] } });
    const r1 = await prisma.programSessionRequest.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, slotStart: start, slotEnd: new Date(start.getTime() + 4 * HOUR), status: "CONFIRMED", projectId: f.projectId, aryeoAppointmentId: x.aryeoId, confirmedAt: new Date(), confirmedBy: "aryeo-reconcile", matchState: "MONTH_LINK", dedupeKey: `${f.enrollmentId}:${f.monthId}:${start.toISOString()}` } });
    return { f, x, r1 };
  };
  const clientActor = (f: ContentMonthFixture) => ({ kind: "CLIENT" as const, clientUserId: f.clientUserId });

  c.head("19 · a hand-booked session moved by under two hours does NOT confirm on its old time");
  {
    await dropSwitch("session_booking");
    const oldStart = at("2026-10-20", 10);
    const newStart = at("2026-10-20", 11, 30);
    const { f, x, r1 } = await handBooked("Accelerator", oldStart, "Hand Move");
    const mv = await sr.requestReschedule(r1.id, { startISO: newStart.toISOString(), endISO: null }, null, clientActor(f));
    const r2 = await reqRow(mv.id!);
    const asRow = { id: x.id, aryeoId: x.aryeoId, startAt: x.startAt, projectId: x.projectId, project: { contentMonthId: f.monthId, aryeoOrderId: null, deliverables: [] } };
    const old = sr.chooseSessionAppointment({ monthId: f.monthId, monthKey: "2026-10", slotStart: r2.slotStart, createdAt: r2.createdAt }, [asRow], new Set());
    c.ok("OLD: with only CONFIRMED rows claimed, the ±2h window matched the booking still at 10:00", old.verdict === "CONFIRM", old.verdict);
    await sr.reconcileSessionRequests();
    const a2 = await reqRow(r2.id);
    const t = await deskTask(r2.id);
    c.ok("NEW: the move stays REQUESTED while Aryeo shows the old time", a2.status === "REQUESTED" && !a2.aryeoAppointmentId, `${a2.status} ${a2.aryeoAppointmentId ?? ""}`);
    c.ok("  the booked session waits as RESCHEDULE_REQUESTED", (await reqRow(r1.id)).status === "RESCHEDULE_REQUESTED");
    c.ok("  and Kyle's MOVE task stays open", t?.status === "OPEN" && t.title.startsWith("Move content session"), `${t?.status} ${t?.title}`);
    // Kyle moves it in Aryeo; the hourly sync writes the new start.
    await prisma.appointment.update({ where: { id: x.id }, data: { startAt: newStart, endAt: new Date(newStart.getTime() + 4 * HOUR) } });
    await sr.reconcileSessionRequests();
    const b2 = await reqRow(r2.id);
    c.ok("once Aryeo shows 11:30, the move confirms on that same appointment (MOVED)", b2.status === "CONFIRMED" && b2.aryeoAppointmentId === x.aryeoId && b2.matchState === "MOVED", `${b2.status} ${b2.matchState}`);
    c.ok("  the old row closes as moved and the task completes", (await reqRow(r1.id)).status === "CANCELLED" && (await deskTask(r2.id))?.status === "COMPLETED");
    c.ok("  the portal says Booked", sr.sessionRequestLabel(b2.status, b2.bookingState) === "Booked");
  }

  c.head("20 · a pending move changed again follows the chain; withdrawn, the booking comes back");
  {
    const { f, x, r1 } = await handBooked("Pro", at("2026-10-13", 10), "Chain Move");
    const cap0 = await sr.sessionCapacity(f.enrollmentId, f.monthId);
    const mv1 = await sr.requestReschedule(r1.id, { startISO: at("2026-10-15", 10).toISOString(), endISO: null }, null, clientActor(f));
    const cap1 = await sr.sessionCapacity(f.enrollmentId, f.monthId);
    c.ok("a pending move holds the place of the session it moves, not a second one (Pro: 1 remaining)", cap0.remaining === 1 && cap1.remaining === 1 && cap1.used === 1, `before ${cap0.used}/${cap0.allowed}, during ${cap1.used}/${cap1.allowed}`);
    const second = await sr.createSessionRequest({ enrollmentId: f.enrollmentId, monthId: f.monthId, slot: { startISO: at("2026-10-21", 10).toISOString(), endISO: null, locationText: "West Chester, PA" }, actor: clientActor(f) });
    c.ok("  so the Pro client can still ask for their second session", second.ok, second.ok ? second.message : second.reason);
    const mv2 = await sr.requestReschedule(mv1.id!, { startISO: at("2026-10-16", 10).toISOString(), endISO: null }, null, clientActor(f));
    const r3 = await reqRow(mv2.id!);
    const t3 = await deskTask(r3.id);
    c.ok("changing the pending move replaces it and points at the BOOKED row", r3.supersedesId === r1.id && (await reqRow(mv1.id!)).status === "CANCELLED" && (await reqRow(r1.id)).status === "RESCHEDULE_REQUESTED", `supersedes ${r3.supersedesId === r1.id ? "R1" : r3.supersedesId}`);
    c.ok("  and Kyle's task says MOVE, naming the booked appointment (not \"Book … 2 of 2\")", !!t3 && t3.title.startsWith("Move content session") && (t3.description ?? "").includes(x.aryeoId), t3?.title);
    const back = await sr.cancelSessionRequest(r3.id, "client-drill", "", { actor: "CLIENT" });
    const b1 = await reqRow(r1.id);
    const t3b = await deskTask(r3.id);
    c.ok("withdrawing the move puts the booked session back to CONFIRMED", back.ok && b1.status === "CONFIRMED" && /Move withdrawn/.test(back.message), `${b1.status}: ${back.message}`);
    c.ok("  and the move task becomes a check (he may already have moved it)", t3b?.status === "OPEN" && t3b.title.startsWith("Check a withdrawn move"), `${t3b?.status} ${t3b?.title}`);
    const again = await sr.requestReschedule(r1.id, { startISO: at("2026-10-19", 10).toISOString(), endISO: null }, null, clientActor(f));
    c.ok("  the restored session can be moved again", again.ok && !!again.id, again.message);
    // The office declines that new time: the booking stands again.
    await sr.declineSessionRequest(again.id!, "drill", "not available");
    c.ok("a declined new time restores the booked session too", (await reqRow(r1.id)).status === "CONFIRMED");
    // A move that expired: the hourly reconcile restores what nobody is pursuing.
    const mv4 = await sr.requestReschedule(r1.id, { startISO: at("2026-10-22", 10).toISOString(), endISO: null }, null, clientActor(f));
    await prisma.programSessionRequest.update({ where: { id: mv4.id! }, data: { status: "EXPIRED" } });
    await sr.reconcileSessionRequests();
    c.ok("a move whose replacement expired is restored by the reconcile", (await reqRow(r1.id)).status === "CONFIRMED");
  }

  c.head("21 · switch ON, authorised: moving a HAND-booked session is a desk move, never a second order");
  {
    const { f, x, r1 } = await handBooked("Accelerator", at("2026-10-26", 10), "Auth Move");
    await prisma.client.update({ where: { id: f.clientId }, data: { aryeoCustomerId: `0197cccc-0000-4000-8000-${String(900 + n).padStart(12, "0")}` } });
    await authorise(f.clientId);
    const w0 = fake.writes.length;
    const mv = await sr.requestReschedule(r1.id, { startISO: at("2026-10-28", 10).toISOString(), endISO: null }, JAMES, clientActor(f));
    const r2 = await reqRow(mv.id!);
    c.ok("the replacement is desk-assisted (bookingState NONE), not QUEUED", r2.bookingState === "NONE" && /moves a session already on the calendar/.test(r2.lastError ?? ""), `${r2.bookingState}: ${r2.lastError}`);
    c.ok("  with Kyle's MOVE task naming the booking", (await deskTask(r2.id))?.title.startsWith("Move content session") === true && ((await deskTask(r2.id))?.description ?? "").includes(x.aryeoId));
    const o = await sb.bookSessionRequest(r2.id, {});
    c.ok("  and the adapter will not pick it up: nothing written", o.outcome === "busy" && fake.writes.length === w0, `${o.outcome}; ${fake.writes.length - w0} writes`);
    // Kyle BOOKS the new time instead of moving the old one: the old appointment still stands.
    const y = await prisma.appointment.create({ data: { projectId: f.projectId!, aryeoId: `new-booking-${n}`, startAt: at("2026-10-28", 10), endAt: at("2026-10-28", 14), status: "SCHEDULED" } });
    await sr.reconcileSessionRequests();
    const c2 = await reqRow(r2.id);
    const c1 = await reqRow(r1.id);
    const t1 = await deskTask(r1.id);
    c.ok("the new time confirms on the NEW booking", c2.status === "CONFIRMED" && c2.aryeoAppointmentId === y.aryeoId, `${c2.status} ${c2.aryeoAppointmentId}`);
    c.ok("  but the old row is not closed over a live appointment: CANCEL_REQUESTED", c1.status === "CANCEL_REQUESTED", c1.status);
    c.ok("  and Kyle is told to cancel the old appointment", !!t1 && t1.status === "OPEN" && t1.title.startsWith("Cancel content session") && (t1.description ?? "").includes(x.aryeoId), t1?.title);
    await prisma.appointment.update({ where: { id: x.id }, data: { status: "CANCELED" } });
    await sr.reconcileSessionRequests();
    c.ok("  once Aryeo shows it cancelled, the old row is CANCELLED", (await reqRow(r1.id)).status === "CANCELLED");
    await dropSwitch("session_booking");
  }

  c.head("22 · 'Change time' on a desk ask Kyle may already have booked says MOVE, with the old time in words");
  {
    const f = await world("Accelerator", { authorise: false });
    await dropSwitch("session_booking");
    const a = await request(f, at("2026-10-13", 10));
    if (!a.ok) throw new Error(a.reason);
    c.ok("(the ask is desk-assisted with Kyle's BOOK task open)", (await deskTask(a.id))?.status === "OPEN");
    const mv = await sr.requestReschedule(a.id, { startISO: at("2026-10-15", 10).toISOString(), endISO: null }, JAMES, { kind: "CLIENT", clientUserId: f.clientUserId });
    const t = mv.id ? await deskTask(mv.id) : null;
    c.ok("the first ask is replaced", mv.ok && (await reqRow(a.id)).status === "CANCELLED");
    c.ok("NEW: Kyle's task for the new time says MOVE, not BOOK", !!t && t.title.startsWith("Move content session"), t?.title);
    c.ok("  and says the first time may already be booked, in words", /may already|already booked/.test(t?.description ?? "") && /Tuesday, October 13/.test(t?.description ?? ""), (t?.description ?? "").slice(0, 220));
  }

  c.head("23 · turning session_booking OFF hands everything stranded to the desk");
  {
    const HUB_MOVE_NEW = at("2026-10-27", 11);
    // A: QUEUED, never sent (no desk task by design).
    const fa = await world("Accelerator");
    const qa = await request(fa, at("2026-10-19", 10));
    if (!qa.ok) throw new Error(qa.reason);
    const qaRow = await reqRow(qa.id);
    c.ok("(A is QUEUED with no desk task)", qaRow.bookingState === "QUEUED" && !(await deskTask(qa.id)), qaRow.bookingState);
    // B: a hub booking whose cancel timed out after Aryeo committed it.
    const fb = await world("Accelerator");
    const qb = await request(fb, at("2026-10-20", 13));
    if (!qb.ok) throw new Error(qb.reason);
    await sb.bookSessionRequest(qb.id, {});
    fake.script("PUT /appointments/:id/cancel", "abort-after-commit");
    const cb = await sr.cancelSessionRequest(qb.id, "client-drill", "", { actor: "CLIENT" });
    c.ok("(B's cancel is pending)", /Cancelling/.test(cb.message) && !!(await reqRow(qb.id)).pendingChangeJson, cb.message);
    // C: a hub booking whose move timed out after Aryeo committed it.
    const fc = await world("Accelerator");
    const qc = await request(fc, at("2026-10-26", 10));
    if (!qc.ok) throw new Error(qc.reason);
    await sb.bookSessionRequest(qc.id, {});
    fake.script("PUT /appointments/:id/reschedule", "abort-after-commit");
    const mc = await sr.requestReschedule(qc.id, { startISO: HUB_MOVE_NEW.toISOString(), endISO: null }, null, { kind: "CLIENT", clientUserId: fc.clientUserId });
    c.ok("(C's move is pending: \"Moving your session\")", /Moving/.test(mc.message) && !!(await reqRow(qc.id)).pendingChangeJson, mc.message);
    await dropSwitch("session_booking");
    const w0 = fake.writes.length;
    const d = await sb.driveSessionBookings({});
    c.ok("the driver still reports skipped, and says what it handed over", "skipped" in d && d.handedToDesk >= 3, JSON.stringify(d));
    c.ok("  with zero calls to Aryeo", fake.writes.length === w0);
    const a1 = await reqRow(qa.id);
    const ta = await deskTask(qa.id);
    c.ok("A: no longer 'Booking your session' — desk-assisted, with Kyle's BOOK task", a1.bookingState === "RECONCILE" && sr.sessionRequestLabel(a1.status, a1.bookingState) === "Requested, awaiting confirmation" && ta?.status === "OPEN" && ta.title.startsWith("Book content session"), `${a1.bookingState} ${ta?.title}`);
    const b1 = await reqRow(qb.id);
    const tb = await deskTask(qb.id);
    c.ok("B: the unknown cancel goes to Kyle as CANCEL, naming the appointment", !b1.pendingChangeJson && tb?.status === "OPEN" && tb.title.startsWith("Cancel content session") && (tb.description ?? "").includes(b1.aryeoAppointmentId ?? "~"), tb?.title);
    const c1 = await reqRow(qc.id);
    const moveReq = await prisma.programSessionRequest.findFirst({ where: { supersedesId: qc.id, status: "REQUESTED" } });
    c.ok("C: the unknown move becomes a desk MOVE — the booking waits, the new time is a request", c1.status === "RESCHEDULE_REQUESTED" && !c1.pendingChangeJson && !!moveReq && moveReq.slotStart?.getTime() === HUB_MOVE_NEW.getTime(), `${c1.status} → ${moveReq?.id ?? "none"}`);
    const tc = moveReq ? await deskTask(moveReq.id) : null;
    c.ok("  with Kyle's MOVE task on it", tc?.status === "OPEN" && tc.title.startsWith("Move content session"), tc?.title);
    // Aryeo DID move it (abort-after-commit); the hourly sync brings the new start.
    const local = await prisma.appointment.findUnique({ where: { aryeoId: c1.aryeoAppointmentId! } });
    if (local) await prisma.appointment.update({ where: { id: local.id }, data: { startAt: HUB_MOVE_NEW, endAt: new Date(HUB_MOVE_NEW.getTime() + 4 * HOUR), status: "SCHEDULED" } });
    else {
      const p = await prisma.project.create({ data: { clientId: fc.clientId, title: "hub order (synced)", status: "SCHEDULED", aryeoOrderId: c1.aryeoOrderId, contentMonthId: fc.monthId }, select: { id: true } });
      await prisma.appointment.create({ data: { projectId: p.id, aryeoId: c1.aryeoAppointmentId!, startAt: HUB_MOVE_NEW, endAt: new Date(HUB_MOVE_NEW.getTime() + 4 * HOUR), status: "SCHEDULED" } });
    }
    await sr.reconcileSessionRequests();
    const moved = moveReq ? await reqRow(moveReq.id) : null;
    c.ok("  and it confirms once the appointment shows the new time; the old row closes", moved?.status === "CONFIRMED" && moved.matchState === "MOVED" && (await reqRow(qc.id)).status === "CANCELLED", `${moved?.status} ${moved?.matchState}`);
    const w1 = fake.writes.length;
    const retry = await sb.retrySessionBooking(qa.id, { confirmedNoOrder: true, by: "drill" });
    c.ok("staff Retry with the switch off refuses instead of claiming \"Queued\"", !retry.ok && /switched off/.test(retry.message) && (await reqRow(qa.id)).bookingState === "RECONCILE", retry.message);
    c.ok("  and writes nothing", fake.writes.length === w1);
    const d2 = await sb.driveSessionBookings({});
    c.ok("a second tick hands nothing over twice", "skipped" in d2 && d2.handedToDesk === 0, JSON.stringify(d2));
  }

  // ======================================================================
  // BATCH 3 (§6.6 A23 + R03, Sep 25 2026). The adapter's own guards at the
  // moment of the write, and the prepaid money rule. These run on JORDAN's
  // calendar (James's is busy with the sections above).
  const JORDAN = { teamMemberId: DRILL_TEAM.jordan.tm, name: DRILL_TEAM.jordan.name };
  const jordanReq = (f: ContentMonthFixture, start: Date, sessionIndex = 1) => request(f, start, { creative: JORDAN }, sessionIndex);
  const ACC_VARIANT = ARYEO_CONTENT_PRODUCTS.Accelerator.variantId;
  const setPrice = (cents: number) => { variantPrices[ACC_VARIANT] = cents; aryeo.resetVariantPriceCache(); };
  const tasksFor = (clientId: string) => prisma.smartTask.findMany({ where: { clientId, status: { notIn: ["COMPLETED", "CANCELLED"] } } });

  c.head("24 · R03: Aryeo now prices the product → NOTHING is created, the desk books it");
  {
    const f = await world("Accelerator");
    const r = await jordanReq(f, at("2026-10-30", 10));
    if (!r.ok) throw new Error(r.reason);
    setPrice(150000);
    const w0 = { a: writes("POST", "/addresses"), o: writes("POST", "/orders") };
    const o = await sb.bookSessionRequest(r.id, {});
    const row = await reqRow(r.id);
    c.ok("the request lands on the desk as REJECTED", o.outcome === "rejected" && row.bookingState === "REJECTED" && row.status === "REQUESTED", `${o.outcome} ${row.bookingState}`);
    c.ok("zero POST /orders", writes("POST", "/orders") === w0.o, `${writes("POST", "/orders") - w0.o}`);
    c.ok("and zero POST /addresses (nothing at all was created)", writes("POST", "/addresses") === w0.a);
    const t = await deskTask(r.id);
    c.ok("Kyle's BOOK task names the price and says nothing was created", !!t && t.title.startsWith("Book content session") && /\$1500\.00/.test(t.description ?? "") && /Nothing was created/.test(t.description ?? ""), (t?.description ?? "").slice(0, 200));
    c.ok("exactly one open task for the client", (await tasksFor(f.clientId)).length === 1, `${(await tasksFor(f.clientId)).length}`);
    const hold = await prisma.programCreativeHold.findUnique({ where: { requestId: r.id } });
    c.ok("the creative-day hold was released (REJECTED)", !!hold?.releasedAt && hold.state === "REJECTED", JSON.stringify(hold && { s: hold.state, r: !!hold.releasedAt }));
    setPrice(0);
  }

  c.head("25 · R03: the ORDER reads back with money owed → no appointment, RECONCILE, one PAYMENT_MISMATCH task");
  {
    const f = await world("Accelerator");
    const r = await jordanReq(f, at("2026-10-29", 9));
    if (!r.ok) throw new Error(r.reason);
    fake.setOrderMoney({ total: 150000, balance: 150000 });
    const o0 = committed("POST", "/orders"), s0 = writes("POST", "/appointments/store");
    const o = await sb.bookSessionRequest(r.id, {});
    fake.setOrderMoney(null);
    const row = await reqRow(r.id);
    c.ok("one order was made (the price guard read $0)", committed("POST", "/orders") - o0 === 1);
    c.ok("NO appointment was stored", writes("POST", "/appointments/store") === s0, `${writes("POST", "/appointments/store") - s0}`);
    c.ok("the request waits in RECONCILE, not booked", row.status === "REQUESTED" && row.bookingState === "RECONCILE" && /PAYMENT_MISMATCH/.test(row.lastError ?? ""), `${o.outcome} ${row.bookingState}: ${row.lastError}`);
    const pm = await prisma.smartTask.findMany({ where: { clientId: f.clientId, title: { startsWith: "PAYMENT_MISMATCH" } } });
    c.ok("exactly one PAYMENT_MISMATCH task for Kyle, naming the amount", pm.length === 1 && pm[0].assignedKey === "kyle" && /\$1500\.00 owed/.test(pm[0].title), pm.map((x) => x.title).join(" | "));
    c.ok("and it says the order was NOT voided, refunded or changed", /did NOT void, refund or change it/.test(pm[0]?.description ?? ""));
    c.ok("no generic desk row besides it", !(await deskTask(r.id)));
    const att = await prisma.programBookingAttempt.findFirst({ where: { requestId: r.id }, orderBy: { attemptNo: "desc" } });
    c.ok("the attempt carries Aryeo's figures as evidence", att?.orderTotalCents === 150000 && att.orderBalanceCents === 150000 && att.orderPaymentStatus === "UNPAID", JSON.stringify({ t: att?.orderTotalCents, b: att?.orderBalanceCents, p: att?.orderPaymentStatus }));
    const order = fake.orders.get(row.aryeoOrderId!);
    c.ok("the hub did not touch the order (no void/refund/edit call)", !!order && fake.writes.filter((w) => w.path.includes(row.aryeoOrderId!) && w.method !== "GET").length === 0);
    const retry = await sb.retrySessionBooking(r.id, { confirmedNoOrder: true, by: "drill" });
    const again = await sb.bookSessionRequest(r.id, {});
    c.ok("Retry adopts the SAME order by its marker — no second order", retry.ok && committed("POST", "/orders") - o0 === 1, `${retry.message} → ${again.outcome}`);
    c.ok("and, still owing, it parks again with the one task", (await reqRow(r.id)).bookingState === "RECONCILE" && (await prisma.smartTask.count({ where: { clientId: f.clientId, title: { startsWith: "PAYMENT_MISMATCH" } } })) === 1);
  }

  c.head("26 · R03: the $0 path — evidence on the attempt, provenance in the team notes, the address row SYNCED");
  {
    const f = await world("Accelerator");
    await prisma.programSignup.create({ data: { checkoutId: `cs_drill_${n}`, subscriptionId: `sub_drill_${n}`, email: "info@realtourpilot.com", productId: "prod_drill", productName: "Video Accelerator", amount: 1500, recurring: true, paidAt: new Date(), clientId: f.clientId, enrollmentId: f.enrollmentId } });
    const r = await jordanReq(f, at("2026-10-28", 13));
    if (!r.ok) throw new Error(r.reason);
    const o = await sb.bookSessionRequest(r.id, {});
    const row = await reqRow(r.id);
    const att = await prisma.programBookingAttempt.findFirst({ where: { requestId: r.id, state: "CONFIRMED" } });
    c.ok("CONFIRMED", o.outcome === "confirmed" && row.status === "CONFIRMED", `${o.outcome}: ${o.detail}`);
    c.ok("attempt: orderTotalCents 0, orderBalanceCents 0, permitScope FIXTURE", att?.orderTotalCents === 0 && att.orderBalanceCents === 0 && att.permitScope === "FIXTURE", JSON.stringify({ t: att?.orderTotalCents, b: att?.orderBalanceCents, s: att?.permitScope }));
    const notes = (fake.writes.filter((w) => w.method === "POST" && w.path === "/orders").slice(-1)[0]?.body as { internal_notes?: string } | undefined)?.internal_notes ?? "";
    c.ok("the team-only note carries the marker and the Stripe provenance", notes.includes(`hub-session:${r.id}:1`) && notes.includes(`Prepaid: Content Program Accelerator via Stripe sub_drill_${n} (no charge on this order)`), notes);
    c.ok("and no dollar amount", !/\$/.test(notes), notes);
    const addr = await prisma.programSessionAddress.findUnique({ where: { sessionKey: `appt:${row.aryeoAppointmentId}` } });
    c.ok("the session's address row is written SYNCED from the plan (the missing-address lane never asks)", addr?.syncState === "SYNCED" && addr.streetNumber === "117" && addr.submittedBy === "hub-booking" && !!addr.submittedAt, JSON.stringify(addr && { s: addr.syncState, n: addr.streetNumber }));
    const hold = await prisma.programCreativeHold.findUnique({ where: { requestId: r.id } });
    c.ok("the hold is released as CONFIRMED", hold?.state === "CONFIRMED" && !!hold.releasedAt, hold?.state);
    const plan = await prisma.programSessionPlan.findUnique({ where: { id: row.planId! } });
    c.ok("the plan remembers the request and reads BOOKED", plan?.requestId === r.id && plan.lastStep === "BOOKED", `${plan?.requestId === r.id} ${plan?.lastStep}`);
  }

  c.head("27 · A23: the order's ADDRESS reads back different → MISMATCH, never Booked");
  {
    const f = await world("Accelerator");
    const r = await jordanReq(f, at("2026-10-27", 9));
    if (!r.ok) throw new Error(r.reason);
    fake.script("POST /appointments/store", "move-order-address");
    const o = await sb.bookSessionRequest(r.id, {});
    const row = await reqRow(r.id);
    c.ok("MISMATCH", o.outcome === "mismatch" && row.bookingState === "MISMATCH" && row.status === "REQUESTED", `${o.outcome} ${row.bookingState}`);
    const t = await deskTask(r.id);
    c.ok("Kyle's FIX task says the order's address reads back as another street", !!t && t.title.startsWith("Fix a hub booking") && /address reads back as 999 Kyle Lane/.test(t.description ?? ""), (t?.description ?? "").slice(0, 260));
  }

  c.head("28 · A23: capacity changed between the request and the booking → the desk, zero writes");
  {
    const f = await world("Accelerator");
    const r = await jordanReq(f, at("2026-10-26", 13));
    if (!r.ok) throw new Error(r.reason);
    // Kyle books a session for this month by hand meanwhile (the hourly sync brings it in).
    const p = await prisma.project.create({ data: { clientId: f.clientId, title: "Hand-booked meanwhile", status: "SCHEDULED", contentMonthId: f.monthId, shootDate: at("2026-10-21", 9) }, select: { id: true } });
    await prisma.appointment.create({ data: { projectId: p.id, aryeoId: `meanwhile-${n}`, startAt: at("2026-10-21", 9), endAt: at("2026-10-21", 13), status: "SCHEDULED" } });
    // OLD (810b29f): the adapter never re-read capacity, so it booked a second session.
    const oldSb = (await import(base.sessionBooking)) as typeof sb;
    const clone = await prisma.programSessionRequest.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, slotStart: at("2026-10-22", 9), slotEnd: at("2026-10-22", 13), locationText: "117 Kyle Lane, Unit 2, West Chester, PA 19382", status: "REQUESTED", bookingState: "QUEUED", creativeTeamMemberId: JORDAN.teamMemberId, creativeName: JORDAN.name, dedupeKey: `${f.enrollmentId}:${f.monthId}:old-capacity` } });
    const oc0 = committed("POST", "/orders");
    const old = await oldSb.bookSessionRequest(clone.id, {});
    c.ok("OLD (810b29f): with the month already full, the adapter booked ANOTHER session anyway", old.outcome === "confirmed" && committed("POST", "/orders") - oc0 === 1, `${old.outcome}: ${old.detail}`);
    const w0 = fake.writes.length;
    const o = await sb.bookSessionRequest(r.id, {});
    const row = await reqRow(r.id);
    c.ok("NEW: over capacity → desk (RECONCILE), with the count", o.outcome === "desk" && row.bookingState === "RECONCILE" && /already booked or requested/.test(row.lastError ?? ""), row.lastError ?? "");
    c.ok("NEW: zero writes", fake.writes.length === w0, `${fake.writes.length - w0}`);
  }

  c.head("29 · A23: the plan's address changed after the pick → the desk, zero writes");
  {
    const f = await world("Accelerator");
    const r = await jordanReq(f, at("2026-10-23", 13));
    if (!r.ok) throw new Error(r.reason);
    const row0 = await reqRow(r.id);
    await prisma.programSessionPlan.update({ where: { id: row0.planId! }, data: { addressVersion: { increment: 1 }, streetNumber: "200" } });
    const w0 = fake.writes.length;
    const o = await sb.bookSessionRequest(r.id, {});
    c.ok("desk, naming the changed address", o.outcome === "desk" && /filming address changed/.test((await reqRow(r.id)).lastError ?? ""), (await reqRow(r.id)).lastError ?? "");
    c.ok("zero writes", fake.writes.length === w0);
  }

  c.head("30 · A23: the gate's ANCHOR moved (the call it was measured from is gone) → the desk; no snapshot → not rechecked");
  {
    const f = await world("Accelerator");
    const r = await jordanReq(f, at("2026-10-22", 13));
    if (!r.ok) throw new Error(r.reason);
    await prisma.programSessionRequest.update({ where: { id: r.id }, data: { gateRoute: "CALL", gateAnchorRef: "CALL_END:gone-call:1759000000000", gateAnchorAt: new Date("2026-09-28T18:30:00Z"), gateWindowHours: 72, gateEarliestAt: new Date("2026-10-01T18:30:00Z") } });
    const w0 = fake.writes.length;
    const o = await sb.bookSessionRequest(r.id, {});
    c.ok("desk: what the session was measured from has changed", o.outcome === "desk" && /measured from has changed/.test((await reqRow(r.id)).lastError ?? ""), (await reqRow(r.id)).lastError ?? "");
    c.ok("zero writes", fake.writes.length === w0);
    // (Every earlier section's request carries no snapshot and booked normally:
    // a request with nothing to compare is never refused by a rule change.)
  }

  c.head("31 · A23: a hub-booked session moved into an occupied slot, or one with no room for the drive → refused, zero PUT");
  {
    const f = await world("Accelerator");
    const r = await jordanReq(f, at("2026-10-20", 9));
    if (!r.ok) throw new Error(r.reason);
    const b = await sb.bookSessionRequest(r.id, {});
    c.ok("(booked)", b.outcome === "confirmed", b.detail);
    fake.seedNeighbour({ tm: JORDAN.teamMemberId, start: at("2026-10-19", 13), end: at("2026-10-19", 17), lat: 40.3, lng: -75.1 });
    const p0 = fake.count("PUT", "/appointments/");
    const occ = await sr.requestReschedule(r.id, { startISO: at("2026-10-19", 13).toISOString(), endISO: null }, null, { kind: "CLIENT", clientUserId: f.clientUserId });
    c.ok("into an occupied slot: refused with the re-pick words", !occ.ok && /no longer free/.test(occ.message), occ.message);
    c.ok("  zero PUT, the booking unchanged", fake.count("PUT", "/appointments/") === p0 && (await reqRow(r.id)).slotStart?.getTime() === at("2026-10-20", 9).getTime());
    c.ok("  and no desk MOVE request was created instead", (await prisma.programSessionRequest.count({ where: { supersedesId: r.id } })) === 0);
    // A neighbour 9:00-12:00 somewhere else: 20 minutes' drive + 15 buffer.
    fake.seedNeighbour({ tm: JORDAN.teamMemberId, start: at("2026-10-16", 9), end: at("2026-10-16", 12), lat: 40.3, lng: -75.1 });
    const tight = await sr.requestReschedule(r.id, { startISO: at("2026-10-16", 12, 30).toISOString(), endISO: null }, null, { kind: "CLIENT", clientUserId: f.clientUserId });
    c.ok("12:30 after a 12:00 finish (20 min drive + 15): Aryeo offers it, the hub refuses it", !tight.ok && /no longer free/.test(tight.message) && /travel: no room for the drive/.test((await reqRow(r.id)).lastError ?? ""), `${tight.message} | ${(await reqRow(r.id)).lastError}`);
    c.ok("  zero PUT", fake.count("PUT", "/appointments/") === p0);
    const ok = await sr.requestReschedule(r.id, { startISO: at("2026-10-16", 13).toISOString(), endISO: null }, null, { kind: "CLIENT", clientUserId: f.clientUserId });
    const moved = await reqRow(r.id);
    c.ok("13:00 fits: moved with one PUT, read back (start, end and creative)", ok.ok && moved.slotStart?.getTime() === at("2026-10-16", 13).getTime() && fake.count("PUT", "/appointments/") - p0 === 1, ok.message);
    const ev = JSON.parse(moved.travelEvidenceJson ?? "{}") as { at?: string; fits?: boolean; prev?: { driveMinutes?: number } };
    c.ok("  with the travel evidence on the request (reschedule, fits, 20-minute drive)", ev.at === "reschedule" && ev.fits === true && ev.prev?.driveMinutes === 20, moved.travelEvidenceJson ?? "");
  }

  c.head("32 · A23: the creative-day hold — two bookings for one creative at overlapping times, one wins");
  {
    const f1 = await world("Accelerator");
    const f2 = await world("Accelerator");
    const r1 = await jordanReq(f1, at("2026-10-15", 9));
    const r2 = await jordanReq(f2, at("2026-10-15", 10));
    if (!r1.ok || !r2.ok) throw new Error("setup");
    const o0 = committed("POST", "/orders");
    const both = await Promise.all([sb.bookSessionRequest(r1.id, {}), sb.bookSessionRequest(r2.id, {})]);
    const rows = [await reqRow(r1.id), await reqRow(r2.id)];
    c.ok("exactly one CONFIRMED", rows.filter((x) => x.status === "CONFIRMED").length === 1, both.map((x) => `${x.outcome}: ${x.detail.slice(0, 70)}`).join(" | "));
    c.ok("exactly one order between them", committed("POST", "/orders") - o0 === 1, `${committed("POST", "/orders") - o0}`);
    // The hold on its own: a live hold blocks an overlap; a dead request's does not.
    const x = await prisma.programSessionRequest.create({ data: { enrollmentId: f1.enrollmentId, clientId: f1.clientId, monthId: f1.monthId, slotStart: at("2026-10-14", 9), slotEnd: at("2026-10-14", 13), status: "REQUESTED", bookingState: "RUNNING", creativeTeamMemberId: JORDAN.teamMemberId, dedupeKey: `hold-x-${n}` } });
    const y = await prisma.programSessionRequest.create({ data: { enrollmentId: f2.enrollmentId, clientId: f2.clientId, monthId: f2.monthId, slotStart: at("2026-10-14", 11), slotEnd: at("2026-10-14", 15), status: "REQUESTED", bookingState: "RUNNING", creativeTeamMemberId: JORDAN.teamMemberId, dedupeKey: `hold-y-${n}` } });
    const hx = await sb.takeCreativeHold({ requestId: x.id, creativeTeamMemberId: JORDAN.teamMemberId, start: at("2026-10-14", 9), end: at("2026-10-14", 13) });
    const hy = await sb.takeCreativeHold({ requestId: y.id, creativeTeamMemberId: JORDAN.teamMemberId, start: at("2026-10-14", 11), end: at("2026-10-14", 15) });
    c.ok("a live hold refuses an overlapping one", hx.ok && !hy.ok, JSON.stringify(hy));
    await prisma.programSessionRequest.update({ where: { id: x.id }, data: { status: "CANCELLED" } });
    const hy2 = await sb.takeCreativeHold({ requestId: y.id, creativeTeamMemberId: JORDAN.teamMemberId, start: at("2026-10-14", 11), end: at("2026-10-14", 15) });
    c.ok("a hold whose request is over (a missed release) never blocks", hy2.ok, JSON.stringify(hy2));
  }

  // ======================================================================
  // BATCH 3 REVIEW FIXES (Sep 25 2026). Both defects were in this batch's own
  // uncommitted code (810b29f has no PAYMENT_MISMATCH and no post-store money
  // read), so there is no OLD tree to load: the new rule is asserted directly,
  // on Jordan's calendar, with the adapter's clock pinned to a Monday.
  const MON = at("2026-09-28", 10);
  const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");
  const storesOn = (orderId: string) => fake.writes.filter((w) => w.method === "POST" && w.path === "/appointments/store" && (w.body as { order_id?: string } | undefined)?.order_id === orderId).length;
  const slotReads = () => fake.reads.filter((x) => x.startsWith("/scheduling/available-timeslots")).length;
  const parkOnMoney = async (f: ContentMonthFixture, start: Date) => {
    const r = await jordanReq(f, start);
    if (!r.ok) throw new Error(r.reason);
    fake.setOrderMoney({ total: 150000, balance: 150000 });
    const o = await sb.bookSessionRequest(r.id, { now: MON });
    fake.setOrderMoney(null);
    const row = await reqRow(r.id);
    if (o.outcome !== "desk" || row.bookingState !== "RECONCILE" || !row.aryeoOrderId) throw new Error(`setup: ${o.outcome} ${row.bookingState}`);
    return { id: r.id, orderId: row.aryeoOrderId };
  };
  const payUp = (orderId: string) => { const o = fake.orders.get(orderId)!; o.total = 0; o.balance = 0; o.payment_status = "PAID"; };

  c.head("33 · A23 on Retry: an order that waited with the desk is rechecked before its appointment is stored");
  {
    // A: Mon Oct 12 9:00 with Jordan; the order reads back owing money.
    const fA = await world("Accelerator");
    const A = await parkOnMoney(fA, at("2026-10-12", 9));
    const holdA = await prisma.programCreativeHold.findUnique({ where: { requestId: A.id } });
    c.ok("(A parks on PAYMENT_MISMATCH: the order exists, the hold is let go)", holdA?.state === "PAYMENT_MISMATCH" && !!holdA.releasedAt, holdA?.state);
    // Meanwhile B, another client, gets the same creative at 10:00.
    const fB = await world("Accelerator");
    const B = await jordanReq(fB, at("2026-10-12", 10));
    if (!B.ok) throw new Error(B.reason);
    const bOut = await sb.bookSessionRequest(B.id, { now: MON });
    c.ok("meanwhile B is booked for Jordan at 10:00 (A's time was free to the hub)", bOut.outcome === "confirmed", `${bOut.outcome}: ${bOut.detail}`);
    // Kyle fixes the balance and presses Retry the evening before: Sun Oct 11, 6 PM ET.
    payUp(A.orderId);
    const sunday = at("2026-10-11", 18);
    const s0 = storesOn(A.orderId);
    const retry = await sb.retrySessionBooking(A.id, { confirmedNoOrder: true, by: "drill", now: sunday });
    c.ok("Retry adopts the SAME order by its marker", retry.ok && /already exists/.test(retry.message), retry.message);
    const again = await sb.bookSessionRequest(A.id, { now: sunday });
    const a2 = await reqRow(A.id);
    c.ok("15 hours out: the resumed drive refuses (inside 24 hours) and hands it to the desk", again.outcome === "desk" && a2.bookingState === "RECONCILE" && /inside 24 hours/.test(a2.lastError ?? ""), `${again.outcome}: ${a2.lastError}`);
    c.ok("  naming the order it already made", (a2.lastError ?? "").includes(A.orderId) && /do not make a new one/.test(a2.lastError ?? ""));
    c.ok("  and NO appointment was stored on it (it used to be, overlapping B)", storesOn(A.orderId) === s0 && a2.status === "REQUESTED", `${storesOn(A.orderId) - s0} store(s), ${a2.status}`);
    const t = await deskTask(A.id);
    c.ok("  Kyle's FIX task says to book on THAT order", !!t && t.title.startsWith("Fix a hub booking") && /THAT order/.test(t.description ?? ""), t?.title ?? "(none)");
    // The same Retry days before (outside 24 hours): B's booking is what stops it.
    await sb.retrySessionBooking(A.id, { confirmedNoOrder: true, by: "drill", now: MON });
    const again2 = await sb.bookSessionRequest(A.id, { now: MON });
    const a3 = await reqRow(A.id);
    c.ok("outside 24 hours, the hub's own booking of B stops it (overlapping)", again2.outcome === "desk" && /overlapping/.test(a3.lastError ?? ""), `${again2.outcome}: ${a3.lastError}`);
    c.ok("  still no appointment on A's order; ONE order in total for A", storesOn(A.orderId) === s0 && [...fake.orders.values()].filter((o) => (o.internal_notes ?? "").includes(`hub-session:${A.id}:`)).length === 1);
  }

  c.head("33b · the slot taken in Aryeo alone (no hub booking): the resumed drive re-reads it and refuses");
  {
    const f = await world("Accelerator");
    const C = await parkOnMoney(f, at("2026-10-13", 9));
    fake.seedNeighbour({ tm: JORDAN.teamMemberId, start: at("2026-10-13", 11), end: at("2026-10-13", 15), lat: 39.96, lng: -75.6 });
    payUp(C.orderId);
    await sb.retrySessionBooking(C.id, { confirmedNoOrder: true, by: "drill", now: MON });
    const r0 = slotReads();
    const s0 = storesOn(C.orderId);
    const o = await sb.bookSessionRequest(C.id, { now: MON });
    const row = await reqRow(C.id);
    c.ok("Aryeo's timeslots were read again on the resumed drive", slotReads() > r0, `${slotReads() - r0} read(s)`);
    c.ok("the slot is no longer free → the desk with the order named, zero stores", o.outcome === "desk" && /no longer free/.test(row.lastError ?? "") && (row.lastError ?? "").includes(C.orderId) && storesOn(C.orderId) === s0, `${o.outcome}: ${row.lastError}`);
  }

  c.head("33c · the order carried forward after a missed marker scan is rechecked too; once the slot is free it books on THAT order");
  {
    const f = await world("Accelerator");
    const E = await parkOnMoney(f, at("2026-10-01", 9));
    payUp(E.orderId);
    // The scan misses it (older than two pages): modelled by the note being gone.
    const kept = fake.orders.get(E.orderId)!.internal_notes;
    fake.orders.get(E.orderId)!.internal_notes = null;
    const q = await sb.retrySessionBooking(E.id, { confirmedNoOrder: true, by: "drill", now: MON });
    c.ok("(Retry finds no order by marker → re-queued; the old attempt is ABANDONED)", q.ok && /Queued/.test(q.message), q.message);
    fake.taken.add(iso(at("2026-10-01", 9)));
    const o0 = fake.count("POST", "/orders", true);
    const s0 = storesOn(E.orderId);
    const blocked = await sb.bookSessionRequest(E.id, { now: MON });
    const row = await reqRow(E.id);
    c.ok("the carried order's slot is rechecked: taken → the desk, zero stores, no new order", blocked.outcome === "desk" && /no longer free/.test(row.lastError ?? "") && storesOn(E.orderId) === s0 && fake.count("POST", "/orders", true) === o0, `${blocked.outcome}: ${row.lastError}`);
    fake.taken.delete(iso(at("2026-10-01", 9)));
    fake.orders.get(E.orderId)!.internal_notes = kept;
    const retry = await sb.retrySessionBooking(E.id, { confirmedNoOrder: true, by: "drill", now: MON });
    const booked = await sb.bookSessionRequest(E.id, { now: MON });
    const done = await reqRow(E.id);
    const hold = await prisma.programCreativeHold.findUnique({ where: { requestId: E.id } });
    c.ok("free again: Retry → CONFIRMED on THAT order", retry.ok && booked.outcome === "confirmed" && done.aryeoOrderId === E.orderId && storesOn(E.orderId) - s0 === 1, `${booked.outcome}: ${booked.detail}`);
    c.ok("  with a fresh hold taken for it (released as CONFIRMED) and no second order", hold?.state === "CONFIRMED" && fake.count("POST", "/orders", true) === o0, JSON.stringify({ h: hold?.state, o: fake.count("POST", "/orders", true) - o0 }));
  }

  c.head("33d · …but an appointment Kyle already put on THAT order at our time is adopted, even inside 24 hours (adopting writes nothing)");
  {
    const f = await world("Accelerator");
    const start = at("2026-10-02", 9);
    const K = await parkOnMoney(f, start);
    payUp(K.orderId);
    // Kyle books it by hand on the hub's order (Aryeo's own UI).
    const handId = `0199ffff-0000-4000-8000-${String(n).padStart(12, "0")}`;
    fake.appts.set(handId, { id: handId, status: "SCHEDULED", start_at: iso(start), end_at: iso(new Date(start.getTime() + 4 * HOUR)), orderId: K.orderId, tmIds: [JORDAN.teamMemberId], updated_at: new Date().toISOString() });
    fake.orders.get(K.orderId)!.appointmentIds.push(handId);
    const evening = at("2026-10-01", 18);
    await sb.retrySessionBooking(K.id, { confirmedNoOrder: true, by: "drill", now: evening });
    const s0 = storesOn(K.orderId);
    const o = await sb.bookSessionRequest(K.id, { now: evening });
    const row = await reqRow(K.id);
    c.ok("adopted and CONFIRMED on Kyle's appointment, no store by the hub", o.outcome === "confirmed" && row.aryeoAppointmentId === handId && storesOn(K.orderId) === s0, `${o.outcome}: ${o.detail}`);
  }

  c.head("34 · R03 after the store: a fee Aryeo adds with the appointment → still booked, ONE PAYMENT_MISMATCH task, the figures updated");
  {
    const f = await world("Accelerator");
    const r = await jordanReq(f, at("2026-10-06", 9));
    if (!r.ok) throw new Error(r.reason);
    fake.script("POST /appointments/store", "add-fee-on-store");
    const o = await sb.bookSessionRequest(r.id, { now: MON });
    const row = await reqRow(r.id);
    const att = await prisma.programBookingAttempt.findFirst({ where: { requestId: r.id, state: "CONFIRMED" } });
    c.ok("the booking is real and stays: CONFIRMED", o.outcome === "confirmed" && row.status === "CONFIRMED", `${o.outcome}: ${o.detail}`);
    c.ok("the attempt's figures are Aryeo's AFTER the store ($75.00 owed), not the $0 read before it", att?.orderTotalCents === 7500 && att.orderBalanceCents === 7500 && att.orderPaymentStatus === "UNPAID", JSON.stringify({ t: att?.orderTotalCents, b: att?.orderBalanceCents, p: att?.orderPaymentStatus }));
    const pm = await prisma.smartTask.findMany({ where: { clientId: f.clientId, title: { startsWith: "PAYMENT_MISMATCH" } } });
    c.ok("exactly one PAYMENT_MISMATCH task for Kyle, saying the session IS booked", pm.length === 1 && /\$75\.00 owed/.test(pm[0].title) && /IS booked/.test(pm[0].description ?? "") && /Nothing needs retrying/.test(pm[0].description ?? ""), pm.map((x) => x.title).join(" | "));
    c.ok("and the hub made no void, refund or edit call", !fake.writes.some((w) => w.path.includes(row.aryeoOrderId!) && w.method !== "GET"));
  }

  // ======================================================================
  c.head("18 · nothing left the machine but the fake Aryeo and the stub geocoder");
  {
    const other = fence.faked.filter((u) => !u.startsWith("https://api.aryeo.com/") && !u.startsWith("https://geocoding.geo.census.gov/") && !u.startsWith("https://nominatim.openstreetmap.org/") && !u.startsWith("https://router.project-osrm.org/"));
    c.ok("no other destination was answered", other.length === 0, other.join(", "));
    c.ok("and nothing was blocked (no real provider was even tried)", fence.blocked.length === 0, fence.blocked.slice(0, 5).join(", "));
    const w = fake.writes.filter((x) => x.committed);
    console.log(`    fake Aryeo committed writes: ${w.length} (${[...new Set(w.map((x) => `${x.method} ${x.path.replace(/\/[0-9a-f-]{20,}|\/fixture[^/]*/g, "/:id")}`))].join(", ")}); geocodes: ${geocodes.length}; OSRM (stub) calls: ${osrmCalls}`);
    c.ok("the database was never production", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/`));
  }

  c.summary();
  quiet.restore();
  try { fs.unlinkSync(path.join(base.dir, "node_modules")); fs.rmSync(base.dir, { recursive: true, force: true }); } catch { /* harmless */ }
  await stop();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  fence.restore();
  process.exit(process.exitCode ?? 0);
});
