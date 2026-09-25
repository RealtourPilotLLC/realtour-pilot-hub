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
//  18. Fence: nothing reached anything but the fake Aryeo and the stub geocoder.
//
// NOT DRILLED, said plainly: the race between the immediate syncAryeoOrders
// ({ orderId }) and Aryeo's ORDER_CREATED webhook importing the same order
// (P2002 on Project.aryeoOrderId) — it is caught and left to the hourly sync.
// And none of this is Aryeo: the fake is the DOCUMENTED contract. The eight
// provider unknowns are Jordan's supervised test.
//
// ISOLATION: PGlite on 127.0.0.1:5516 via the shared harness.
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
const BASE = "HEAD";

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
  return fake ? fake.handle(url, init) : null;
});

// The bell: counted, never sent anywhere.

function writeBaseCopy(): { dir: string; sessionRequests: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp04-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const src = execFileSync("git", ["show", `${BASE}:src/lib/sessionRequests.ts`], { cwd: REPO, encoding: "utf8" });
  const pointed = src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const file = path.join(dir, "sessionRequests.base.ts");
  fs.writeFileSync(file, pointed);
  return { dir, sessionRequests: file };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
  fake = createFakeAryeo({
    products: {
      [ARYEO_CONTENT_PRODUCTS.Starter.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
      [ARYEO_CONTENT_PRODUCTS.Accelerator.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
      [ARYEO_CONTENT_PRODUCTS.Pro.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
    },
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
    await prisma.client.update({ where: { id: f.clientId }, data: { aryeoCustomerId: `0197cccc-0000-4000-8000-${String(n).padStart(12, "0")}` } });
    if (opts.authorise !== false) await authorise(f.clientId);
    return f;
  };
  const request = async (f: ContentMonthFixture, start: Date, over: Partial<Parameters<typeof sr.createSessionRequest>[0]> = {}) =>
    sr.createSessionRequest({
      enrollmentId: f.enrollmentId, monthId: f.monthId,
      slot: { startISO: start.toISOString(), endISO: new Date(start.getTime() + 4 * HOUR).toISOString(), locationText: "West Chester, PA 19382" },
      actor: { kind: "STAFF", userId: null }, creative: JAMES, ...over,
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
    c.ok("the area only: city/state/zip + lat/lng, and NO street", ab?.city === "West Chester" && ab?.state_or_province === "PA" && ab?.postal_code === "19382" && typeof ab?.latitude === "number" && !("street_number" in (ab ?? {})), JSON.stringify(ab));
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
    const b = await request(f, at("2026-10-16", 10));
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
    const soon = new Date(Date.now() + 20 * HOUR);
    const tomorrow = await pa.portalRequestSession(auth, { monthId: f.monthId, slotISO: soon.toISOString(), location: "West Chester, PA", creativeTeamMemberId: DRILL_TEAM.james.tm });
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
  c.head("18 · nothing left the machine but the fake Aryeo and the stub geocoder");
  {
    const other = fence.faked.filter((u) => !u.startsWith("https://api.aryeo.com/") && !u.startsWith("https://geocoding.geo.census.gov/") && !u.startsWith("https://nominatim.openstreetmap.org/"));
    c.ok("no other destination was answered", other.length === 0, other.join(", "));
    c.ok("and nothing was blocked (no real provider was even tried)", fence.blocked.length === 0, fence.blocked.slice(0, 5).join(", "));
    const w = fake.writes.filter((x) => x.committed);
    console.log(`    fake Aryeo committed writes: ${w.length} (${[...new Set(w.map((x) => `${x.method} ${x.path.replace(/\/[0-9a-f-]{20,}|\/fixture[^/]*/g, "/:id")}`))].join(", ")}); geocodes: ${geocodes.length}`);
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
