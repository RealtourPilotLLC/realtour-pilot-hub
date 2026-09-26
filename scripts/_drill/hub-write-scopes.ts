// ---------------------------------------------------------------------------
// DRILL: R02 / A26 — HUB WRITE SCOPES: FIXTURE, PILOT, and everybody else.
// Unified handoff batch 3, Sep 25 2026.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/hub-write-scopes.ts
//
// OLD behaviour first: integrations/aryeo.ts at 810b29f (pinned — the tree
// batch 3 starts from, never HEAD) is loaded for real and asked the same
// questions. It had no pilot mode at all, and it let a real inbox through as
// long as the row said TEST.
//
//    0. OLD: a real client in an approved pilot is refused; a "TEST" row on a
//       real inbox is ALLOWED (the renamed-real-row hole).
//    1. Switch off (and a missing row): nobody, whatever the lists say.
//    2. FIXTURE: listed + both inboxes the test inbox → FIXTURE, sandbox:true.
//       A real client inbox, a real Aryeo customer, no customer, an unreadable
//       customer, not listed, a caller-supplied TEST name on a real row → no.
//    3. PILOT: real client, approved, unexpired, operation named → PILOT,
//       sandbox:false. Fixture-listed real client, missing operation, no
//       approver, expired, unrelated client, never-synthetic row renamed TEST
//       → no.
//    4. Writes through the fake Aryeo: the pilot's own customer only; a fixture
//       can never reach a real customer id; a book permit cannot cancel; team
//       notices only (notify false to the customer).
//    5. A26 journey: the fixture and the pilot client are queued for the hub
//       and the adapter books both through the fake (attempts recorded FIXTURE
//       and PILOT, each order on the client's own customer); an unrelated real
//       client stays desk-assisted with the same portal booking mode it had
//       with the switch off.
//    6. The pilot editor: typed name, owner only, audited, never switches
//       anything on; the scope read-out per switch. (Batch-3 review) Adding a
//       second client keeps the pilot's end date unless it is changed on
//       purpose, and the result says when it changes.
//    7. (batch-3 review) The fixture list's one audited writer (the settings
//       Remove, scripts/_ops/hub-write-fixture.ts): only that field changes,
//       never the pilot or the mode; real clients and real inboxes refused;
//       --on refused while a pilot with real clients is on file.
//
// ISOLATION: PGlite on 127.0.0.1:5663. Every non-loopback call is fenced;
// Aryeo is the stateful fake (plus a canned GET /customers/{id}); nothing real
// is contacted and nothing is sent.
// THE CLOCK IS PINNED to Fri Oct 2 2026 14:00 ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import { createFakeAryeo, DRILL_TEAM } from "./_fake-aryeo";
import { createFixtureCustomers } from "./_fixtures/fixtureIdentity";

const PORT = Number(process.env.DRILL_PORT ?? 5663);
const BASE = "810b29f"; // pinned: the tree batch 3 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 2, 18, 0, 0); // Fri Oct 2 2026, 14:00 EDT
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
/** An ET wall clock in October 2026 (EDT = UTC-4). */
const et = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));

installNextStubs();

let fake: ReturnType<typeof createFakeAryeo>;
const ids = createFixtureCustomers();
const fence = fenceFetch(async (url, init) => {
  const c = ids.route(url, init);
  if (c) return c;
  if (url.startsWith("https://geocoding.geo.census.gov/")) return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -75.6055, y: 39.9607 }, matchedAddress: "117 KYLE LN" }] } }), { status: 200 });
  return fake ? fake.handle(url, init) : null;
});

// ---- the old code, runnable ------------------------------------------------------
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-write-scopes-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
async function loadBase<T>(rel: string): Promise<T> {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8" });
  const dir = path.dirname(path.join(REPO, rel));
  const pointed = src
    .replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`)
    .replace(/(from\s+|import\()(["'])\.\/([^"']+)\2/g, (_m, pre: string, q: string, p: string) => `${pre}${q}${path.join(dir, p)}${q}`);
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  fs.writeFileSync(file, pointed);
  return (await import(file)) as T;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
  fake = createFakeAryeo({
    products: {
      [ARYEO_CONTENT_PRODUCTS.Starter.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
      [ARYEO_CONTENT_PRODUCTS.Accelerator.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
      [ARYEO_CONTENT_PRODUCTS.Pro.productId]: [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm],
    },
    // R03: each program product's one variant at $0, as Phase 0 read the catalogue.
    variants: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.productId, p.variantId])),
    variantPrices: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.variantId, 0])),
  });
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo", "drill-key-not-a-real-one");
  const aryeo = await import("@/lib/integrations/aryeo");
  const scopeLib = await import("@/lib/hubWritePermit");
  const tc = await import("@/lib/testClients");

  const setSwitch = async (key: string, enabled: boolean, config: Record<string, unknown> | null) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(), configJson: config ? JSON.stringify(config) : null }, update: { enabled, configJson: config ? JSON.stringify(config) : null } });
  const dropSwitch = (key: string) => prisma.programAutomation.deleteMany({ where: { key } });
  const permit = (clientId: string, name: string | null, operation = "orders.create", switchKey: "session_booking" | "address_sync" = "session_booking") =>
    aryeo.hubWritePermit({ switchKey, client: { id: clientId, name }, operation });
  const approved = (clientIds: string[], operations: string[], extra: Record<string, unknown> = {}) =>
    ({ clientIds, operations, approvedBy: "jordan@realtourpilot.com", approvedAt: et(10, 1, 9).toISOString(), expiresAt: null, ...extra });
  const BOOK = scopeLib.HUB_WRITE_OPERATION_GROUPS.session_booking.find((g) => g.key === "book")!.operations;
  let seq = 0;
  const realCustomer = () => `0197eeee-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const world = async (name: string): Promise<ContentMonthFixture> => {
    // buildContentMonth insists on the word TEST; a real client is renamed after.
    const f = await buildContentMonth(db, { name: `${name.replace(/\bTEST\b/, "").trim() || "Drill"} TEST`, package: "Accelerator", topics: [] });
    if (!tc.isTestClientName(name)) await prisma.client.update({ where: { id: f.clientId }, data: { name } });
    return { ...f, clientName: name };
  };

  // Fixtures used throughout.
  const fixture = await world("Jordan Spackman TEST");
  const fixtureCustomer = await ids.makeFixture(db, fixture.clientId);
  const realInboxTest = await world("Bobby TEST");
  await ids.makeFixture(db, realInboxTest.clientId, { clientEmail: "bobby.realperson@gmail.com" });
  const realCustomerTest = await world("Cara TEST");
  await ids.makeFixture(db, realCustomerTest.clientId, { customerEmail: "cara.agent@kw.com" });
  const noCustomerTest = await world("Dana TEST");
  await prisma.client.update({ where: { id: noCustomerTest.clientId }, data: { email: "info+dana@realtourpilot.com" } });
  const pilotClient = await world("Marcee Realagent");
  const pilotCustomer = realCustomer();
  await prisma.client.update({ where: { id: pilotClient.clientId }, data: { email: "marcee@realagent.com", aryeoCustomerId: pilotCustomer } });
  const unrelated = await world("Joe Unrelated");
  const unrelatedCustomer = realCustomer();
  await prisma.client.update({ where: { id: unrelated.clientId }, data: { email: "joe@unrelated.com", aryeoCustomerId: unrelatedCustomer } });
  // A never-synthetic id (one of the two real "Jordan Spackman" rows), renamed.
  const NEVER = tc.NEVER_SYNTHETIC_CLIENT_IDS[0];
  await prisma.client.create({ data: { id: NEVER, name: "Jordan Spackman TEST", email: "info@realtourpilot.com", aryeoCustomerId: realCustomer() } });
  ids.setCustomer((await prisma.client.findUniqueOrThrow({ where: { id: NEVER } })).aryeoCustomerId!, "info@realtourpilot.com");

  // ======================================================================
  c.head("0 · OLD (810b29f): no pilot mode, and a TEST name on a real inbox was enough");
  {
    const old = await loadBase<typeof import("@/lib/integrations/aryeo")>("src/lib/integrations/aryeo.ts");
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [realInboxTest.clientId], pilot: approved([pilotClient.clientId], BOOK) });
    const p = await old.hubWritePermit({ switchKey: "session_booking", client: { id: pilotClient.clientId, name: pilotClient.clientName }, operation: "orders.create" });
    c.ok("OLD refuses a real client even inside an approved pilot (no pilot mode existed)", !p.ok, p.ok ? "allowed" : p.reason.slice(0, 90));
    const q = await old.hubWritePermit({ switchKey: "session_booking", client: { id: realInboxTest.clientId, name: realInboxTest.clientName }, operation: "orders.create" });
    c.ok("OLD ALLOWS a listed 'TEST' row whose inbox is a real person's (the hole)", q.ok, q.ok ? "allowed" : q.reason);
    const n = await aryeo.hubWritePermit({ switchKey: "session_booking", client: { id: realInboxTest.clientId, name: realInboxTest.clientName }, operation: "orders.create" });
    c.ok("NEW refuses it: the row's own inbox is not the test inbox", !n.ok && /not the verified test inbox/.test(n.ok ? "" : n.reason), n.ok ? "allowed" : n.reason.slice(0, 100));
  }

  // ======================================================================
  c.head("1 · switch off: nobody, whatever the lists say");
  {
    const cfg = { authorizedFixtureClientIds: [fixture.clientId], pilot: approved([pilotClient.clientId], BOOK) };
    await setSwitch("session_booking", false, cfg);
    const a = await permit(fixture.clientId, fixture.clientName);
    const b = await permit(pilotClient.clientId, pilotClient.clientName);
    c.ok("a listed fixture is refused while the switch is off", !a.ok && /switch is off/.test(a.ok ? "" : a.reason));
    c.ok("an approved pilot client is refused while the switch is off", !b.ok && /switch is off/.test(b.ok ? "" : b.reason));
    await dropSwitch("session_booking");
    const d = await permit(fixture.clientId, fixture.clientName);
    c.ok("a missing row is off", !d.ok && /switch is off/.test(d.ok ? "" : d.reason));
    const x = await permit(fixture.clientId, fixture.clientName, "addresses.patch", "address_sync");
    c.ok("address_sync (never configured) refuses too", !x.ok);
  }

  // ======================================================================
  c.head("2 · FIXTURE: a listed TEST client whose two inboxes are the test inbox");
  {
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [fixture.clientId, realInboxTest.clientId, realCustomerTest.clientId, noCustomerTest.clientId], pilot: null });
    aryeo.resetFixtureIdentityCache();
    const readsBefore = ids.reads.length;
    const g = await permit(fixture.clientId, fixture.clientName);
    c.ok("FIXTURE permit issued", g.ok && g.scope === "FIXTURE", g.ok ? g.scope : g.reason);
    c.ok("the permit carries sandbox:true and the fixture's OWN Aryeo customer", g.ok && g.permit.sandbox === true && g.permit.aryeoCustomerId === fixtureCustomer);
    c.ok("the Aryeo customer was read once to prove it", ids.reads.length - readsBefore === 1 && ids.reads.at(-1) === fixtureCustomer);
    await permit(fixture.clientId, fixture.clientName, "addresses.create");
    c.ok("…and cached for the next ask in the same booking", ids.reads.length - readsBefore === 1, `${ids.reads.length - readsBefore} reads`);

    const reads0 = ids.reads.length;
    const r1 = await permit(realInboxTest.clientId, realInboxTest.clientName);
    c.ok("a TEST row with a real person's email is refused", !r1.ok && /bobby\.realperson@gmail\.com/.test(r1.ok ? "" : r1.reason));
    c.ok("…without even asking Aryeo", ids.reads.length === reads0);
    const r2 = await permit(realCustomerTest.clientId, realCustomerTest.clientName);
    c.ok("a TEST row linked to a real Aryeo customer is refused", !r2.ok && /cara\.agent@kw\.com/.test(r2.ok ? "" : r2.reason), r2.ok ? "allowed" : r2.reason.slice(0, 120));
    const r3 = await permit(noCustomerTest.clientId, noCustomerTest.clientName);
    c.ok("a TEST row with no linked Aryeo customer is refused", !r3.ok && /no linked Aryeo customer/.test(r3.ok ? "" : r3.reason));
    aryeo.resetFixtureIdentityCache();
    ids.failReads(3); // a GET is tried three times; all three fail
    const r4 = await permit(fixture.clientId, fixture.clientName);
    c.ok("an Aryeo customer that cannot be read (500 ×3) refuses — never a pass", !r4.ok && /could not be read/.test(r4.ok ? "" : r4.reason), r4.ok ? "allowed" : r4.reason.slice(0, 100));
    const saved = ids.customers.get(fixtureCustomer)!;
    ids.customers.delete(fixtureCustomer); // Aryeo answers 404 for it now
    const r4b = await permit(fixture.clientId, fixture.clientName);
    ids.setCustomer(fixtureCustomer, saved.email, saved.name);
    c.ok("a customer Aryeo does not know (404) refuses", !r4b.ok, r4b.ok ? "allowed" : r4b.reason.slice(0, 100));
    const r4c = await permit(fixture.clientId, fixture.clientName);
    c.ok("…and a failed read is not cached: the next ask proves it again", r4c.ok && r4c.scope === "FIXTURE");
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [], pilot: null });
    const r5 = await permit(fixture.clientId, fixture.clientName);
    c.ok("an unlisted TEST client is refused (reason names authorizedFixtureClientIds)", !r5.ok && /authorizedFixtureClientIds/.test(r5.ok ? "" : r5.reason));
    // The caller's label is not the fact: a real row passed in as "... TEST".
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [unrelated.clientId], pilot: null });
    const r6 = await aryeo.hubWritePermit({ switchKey: "session_booking", client: { id: unrelated.clientId, name: "Joe Unrelated TEST" }, operation: "orders.create" });
    c.ok("a caller-supplied TEST name on a real row is ignored — the row is read, and refused", !r6.ok && /real client/.test(r6.ok ? "" : r6.reason), r6.ok ? "allowed" : r6.reason.slice(0, 100));
  }

  // ======================================================================
  c.head("3 · PILOT: a real client Jordan approved, for named writes, until an end date");
  {
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [fixture.clientId], pilot: approved([pilotClient.clientId], BOOK) });
    const readsBefore = ids.reads.length;
    const g = await permit(pilotClient.clientId, pilotClient.clientName);
    c.ok("PILOT permit issued for orders.create", g.ok && g.scope === "PILOT", g.ok ? g.scope : g.reason);
    c.ok("a pilot permit NEVER carries sandbox:true", g.ok && g.permit.sandbox === false);
    c.ok("no fixture identity read for a real client", ids.reads.length === readsBefore);
    const noOp = await permit(pilotClient.clientId, pilotClient.clientName, "appointments.cancel");
    c.ok("an operation the pilot does not name is refused", !noOp.ok && /does not include appointments\.cancel/.test(noOp.ok ? "" : noOp.reason));
    const unrelatedP = await permit(unrelated.clientId, unrelated.clientName);
    c.ok("an unrelated real client is refused", !unrelatedP.ok && /not in an approved session_booking pilot/.test(unrelatedP.ok ? "" : unrelatedP.reason));

    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [pilotClient.clientId], pilot: approved([pilotClient.clientId], BOOK) });
    const fixtureListed = await permit(pilotClient.clientId, pilotClient.clientName);
    c.ok("a real client on the FIXTURE list is refused as a misconfiguration (even inside a pilot)", !fixtureListed.ok && /fixture list/.test(fixtureListed.ok ? "" : fixtureListed.reason));

    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [], pilot: approved([pilotClient.clientId], BOOK, { approvedBy: null }) });
    const unapproved = await permit(pilotClient.clientId, pilotClient.clientName);
    c.ok("a pilot with no recorded approver covers nobody", !unapproved.ok && /no recorded approval/.test(unapproved.ok ? "" : unapproved.reason));

    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [], pilot: approved([pilotClient.clientId], BOOK, { expiresAt: et(10, 2, 13).toISOString() }) });
    const expired = await permit(pilotClient.clientId, pilotClient.clientName);
    c.ok("an expired pilot (ended an hour ago) is refused", !expired.ok && /expired/.test(expired.ok ? "" : expired.reason));
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [], pilot: approved([pilotClient.clientId], BOOK, { expiresAt: et(10, 2, 15).toISOString() }) });
    const live = await permit(pilotClient.clientId, pilotClient.clientName);
    c.ok("…and one ending in an hour still covers them", live.ok && live.scope === "PILOT");

    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [NEVER], pilot: approved([NEVER], BOOK) });
    const never = await permit(NEVER, "Jordan Spackman TEST");
    c.ok("a never-synthetic row renamed '… TEST' is refused, listed as fixture AND pilot", !never.ok && /never-synthetic/.test(never.ok ? "" : never.reason), never.ok ? "allowed" : never.reason.slice(0, 90));
  }

  // ======================================================================
  c.head("4 · writes through the fake Aryeo: own customer only, team notices only");
  {
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [fixture.clientId], pilot: approved([pilotClient.clientId], BOOK) });
    aryeo.resetFixtureIdentityCache();
    const before = fake.writes.length;
    const pa = await permit(pilotClient.clientId, pilotClient.clientName, "addresses.create");
    const po = await permit(pilotClient.clientId, pilotClient.clientName, "orders.create");
    const ps = await permit(pilotClient.clientId, pilotClient.clientName, "appointments.store");
    if (!pa.ok || !po.ok || !ps.ok) throw new Error("pilot permits refused");
    const addr = await aryeo.AryeoBooking.createAddress(pa.permit, { street_number: "117", street_name: "Kyle Ln", city: "West Chester", state_or_province: "PA", postal_code: "19380", country: "US", latitude: 39.96, longitude: -75.6 });
    const order = await aryeo.AryeoBooking.createOrder(po.permit, { customer_id: pilotCustomer, address_id: addr.id, variantId: ARYEO_CONTENT_PRODUCTS.Accelerator.variantId, internal_notes: "hub-session:drill:1" });
    await aryeo.AryeoBooking.storeAppointment(ps.permit, { order_id: order.id, start: et(10, 12, 10), end: et(10, 12, 14), teamMemberId: DRILL_TEAM.james.tm, itemIds: order.itemIds, notifyCompany: true });
    const mine = fake.writes.slice(before);
    c.ok("a pilot booking made exactly 3 committed writes (address, order, appointment)", mine.length === 3 && mine.every((w) => w.committed), mine.map((w) => `${w.method} ${w.path}`).join(", "));
    const orderBody = mine.find((w) => w.path === "/orders")?.body as { customer_id?: string; notify?: boolean } | undefined;
    c.ok("the order is for the pilot client's own Aryeo customer", orderBody?.customer_id === pilotCustomer);
    c.ok("the order tells Aryeo not to notify (customer/creator): notify false", orderBody?.notify === false);
    const apptBody = mine.find((w) => w.path === "/appointments/store")?.body as { notifyCustomer?: boolean; notifyCompany?: boolean } | undefined;
    c.ok("the appointment notifies our team only (notifyCustomer false, notifyCompany true)", apptBody?.notifyCustomer === false && apptBody?.notifyCompany === true);

    const w0 = fake.writes.length;
    let threw = "";
    const po2 = await permit(pilotClient.clientId, pilotClient.clientName, "orders.create");
    try { if (po2.ok) await aryeo.AryeoBooking.createOrder(po2.permit, { customer_id: unrelatedCustomer, address_id: addr.id, variantId: "v", internal_notes: "x" }); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    c.ok("a pilot permit cannot order for somebody else's customer (0 writes)", /not the permitted client's own Aryeo customer/.test(threw) && fake.writes.length === w0, threw);

    threw = "";
    const fo = await permit(fixture.clientId, fixture.clientName, "orders.create");
    try { if (fo.ok) await aryeo.AryeoBooking.createOrder(fo.permit, { customer_id: pilotCustomer, address_id: addr.id, variantId: "v", internal_notes: "x" }); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    c.ok("a FIXTURE permit can never reach a real customer id (0 writes)", fo.ok && /not the permitted client's own Aryeo customer/.test(threw) && fake.writes.length === w0, threw || (fo.ok ? "no refusal" : fo.reason));

    threw = "";
    const bookPermit = await permit(pilotClient.clientId, pilotClient.clientName, "orders.create");
    const apptId = [...fake.appts.keys()][0];
    try { if (bookPermit.ok) await aryeo.AryeoBooking.cancelAppointment(bookPermit.permit, apptId); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    c.ok("a 'book' pilot permit cannot be spent on a cancel (0 writes)", /pilot approval does not cover it/.test(threw) && fake.writes.length === w0, threw);
  }

  // ======================================================================
  c.head("5 · A26 journey: fixture and pilot are the hub's to book; everyone else is the desk's, as before");
  {
    const sr = await import("@/lib/sessionRequests");
    const portal = await import("@/lib/portal");
    const plan = async (f: ContentMonthFixture) => prisma.programSessionPlan.create({
      data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, sessionIndex: 1, streetNumber: "117", streetName: "Kyle Ln", city: "West Chester", stateCode: "PA", postalCode: "19380", latitude: 39.96, longitude: -75.6, geocodeSource: "drill", addressValidatedAt: new Date(), addressVersion: 1 },
    });
    const ask = async (f: ContentMonthFixture, day: number) => {
      const p = await plan(f);
      return sr.createSessionRequest({
        enrollmentId: f.enrollmentId, monthId: f.monthId,
        slot: { startISO: et(10, day, 10).toISOString(), endISO: et(10, day, 14).toISOString(), timezone: "America/New_York" },
        actor: { kind: "CLIENT", clientUserId: f.clientUserId }, creative: { teamMemberId: DRILL_TEAM.james.tm, name: DRILL_TEAM.james.name },
        plan: { planId: p.id, addressVersion: 1 }, sessionIndex: 1, travel: { check: "HUB_DRIVE", evidenceJson: "{}" },
      });
    };
    const modeOf = async (f: ContentMonthFixture) => (await portal.portalScheduleMonths({ id: f.enrollmentId, clientId: f.clientId })).find((m) => m.monthId === f.monthId)?.bookingMode ?? null;
    // The unrelated client's portal with the switch OFF — the "before".
    await setSwitch("session_booking", false, { authorizedFixtureClientIds: [fixture.clientId], pilot: approved([pilotClient.clientId], BOOK) });
    const offMode = await modeOf(unrelated);
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [fixture.clientId], pilot: approved([pilotClient.clientId], BOOK) });
    aryeo.resetFixtureIdentityCache();
    const w0 = fake.writes.length;
    const a = await ask(fixture, 13);
    const b = await ask(pilotClient, 14);
    const u = await ask(unrelated, 15);
    const row = async (r: Awaited<ReturnType<typeof ask>>) => (r.ok ? prisma.programSessionRequest.findUniqueOrThrow({ where: { id: r.id } }) : null);
    const [ra, rb, ru] = [await row(a), await row(b), await row(u)];
    c.ok("the TEST fixture's ask is QUEUED for the hub", ra?.bookingState === "QUEUED", ra?.bookingState ?? (a.ok ? "" : a.reason));
    c.ok("the pilot client's ask is QUEUED for the hub", rb?.bookingState === "QUEUED", rb?.bookingState ?? (b.ok ? "" : b.reason));
    c.ok("the unrelated real client's ask stays desk-assisted (NONE) with the reason on the row", ru?.bookingState === "NONE" && /not in an approved session_booking pilot/.test(ru?.lastError ?? ""), ru?.lastError ?? "");
    c.ok("asking wrote nothing to Aryeo", fake.writes.length === w0);
    c.ok("portal booking mode: fixture SELF, pilot SELF", (await modeOf(fixture)) === "SELF" && (await modeOf(pilotClient)) === "SELF");
    const onMode = await modeOf(unrelated);
    c.ok("the unrelated client's portal booking mode is DESK — identical to the switch-off portal", offMode === "DESK" && onMode === offMode, `${offMode} → ${onMode}`);
    // The adapter itself, through the fake: each attempt records its scope.
    const sb = await import("@/lib/sessionBooking");
    const oa = ra ? await sb.bookSessionRequest(ra.id, {}) : null;
    const ob = rb ? await sb.bookSessionRequest(rb.id, {}) : null;
    const att = async (id: string | undefined) => (id ? prisma.programBookingAttempt.findFirst({ where: { requestId: id, kind: "CREATE" }, orderBy: { attemptNo: "desc" } }) : null);
    const [aa, ab] = [await att(ra?.id), await att(rb?.id)];
    c.ok("the fixture's booking confirms, its attempt recorded as FIXTURE", oa?.outcome === "confirmed" && aa?.permitScope === "FIXTURE", `${oa?.outcome}: ${oa?.detail} · ${aa?.permitScope}`);
    c.ok("the pilot's booking confirms, its attempt recorded as PILOT", ob?.outcome === "confirmed" && ab?.permitScope === "PILOT", `${ob?.outcome}: ${ob?.detail} · ${ab?.permitScope}`);
    const orderFor = (attempt: typeof aa) => (attempt?.aryeoOrderId ? fake.orders.get(attempt.aryeoOrderId) ?? null : null);
    c.ok("each order is on the booking client's OWN Aryeo customer", orderFor(aa)?.customer.id === fixtureCustomer && orderFor(ab)?.customer.id === pilotCustomer);
  }

  // ======================================================================
  c.head("6 · the pilot editor: typed name, owner only, audited, never switches anything on");
  {
    const actions = await import("@/app/settings/pilotActions");
    await dropSwitch("address_sync");
    const wrong = await actions.addPilotClientAction({ switchKey: "address_sync", clientId: pilotClient.clientId, typedName: "Marcee", groups: ["address"] });
    c.ok("a name that does not match is refused", !wrong.ok && /Type the client's name/.test(wrong.message), wrong.message);
    c.ok("…and nothing was written", (await prisma.programAutomation.count({ where: { key: "address_sync" } })) === 0);
    const test = await actions.addPilotClientAction({ switchKey: "address_sync", clientId: fixture.clientId, typedName: fixture.clientName, groups: ["address"] });
    c.ok("a TEST client cannot join a pilot (it is a fixture)", !test.ok && /fixtures, not pilot clients/.test(test.message));
    const none = await actions.addPilotClientAction({ switchKey: "address_sync", clientId: pilotClient.clientId, typedName: "marcee   REALAGENT", groups: [] });
    c.ok("a pilot must name at least one kind of write", !none.ok);
    const past = await actions.addPilotClientAction({ switchKey: "address_sync", clientId: pilotClient.clientId, typedName: pilotClient.clientName, groups: ["address"], expiresOnET: "2026-10-01" });
    c.ok("an end date in the past is refused", !past.ok && /future/.test(past.message));
    const audits0 = await prisma.auditLog.count({ where: { action: "automation_pilot_change" } });
    const ok = await actions.addPilotClientAction({ switchKey: "address_sync", clientId: pilotClient.clientId, typedName: "marcee   REALAGENT", groups: ["address"], expiresOnET: "2026-10-31", note: "first address pilot" });
    c.ok("the typed name (case and spacing aside) approves the pilot", ok.ok, ok.message);
    const rowA = await prisma.programAutomation.findUniqueOrThrow({ where: { key: "address_sync" } });
    const stored = scopeLib.parseHubWriteConfig(JSON.parse(rowA.configJson ?? "{}"));
    c.ok("the switch was created OFF — approving a pilot never turns writes on", rowA.enabled === false);
    c.ok("the pilot names the client, the operation, the approver and time", !!stored.pilot && stored.pilot.clientIds[0] === pilotClient.clientId && stored.pilot.operations.join() === "addresses.patch" && stored.pilot.approvedBy === "dev@local" && !!stored.pilot.approvedAt);
    c.ok("the end date is the END of Oct 31 ET (Nov 1 00:00 EDT)", stored.pilot?.expiresAt === et(11, 1, 0).toISOString(), stored.pilot?.expiresAt ?? "");
    const audit = await prisma.auditLog.findFirst({ where: { action: "automation_pilot_change" }, orderBy: { createdAt: "desc" } });
    c.ok("one audit row, before → after", (await prisma.auditLog.count({ where: { action: "automation_pilot_change" } })) === audits0 + 1 && audit?.target === "automation:address_sync" && /pilot: null ->/.test(audit?.detail ?? ""), audit?.detail.slice(0, 80) ?? "");
    const blocked = await aryeo.hubWritePermit({ switchKey: "address_sync", client: { id: pilotClient.clientId, name: pilotClient.clientName }, operation: "addresses.patch" });
    c.ok("with the switch still off, the approved pilot still writes nothing", !blocked.ok && /switch is off/.test(blocked.ok ? "" : blocked.reason));
    await prisma.programAutomation.update({ where: { key: "address_sync" }, data: { enabled: true } });
    const open = await aryeo.hubWritePermit({ switchKey: "address_sync", client: { id: pilotClient.clientId, name: pilotClient.clientName }, operation: "addresses.patch" });
    c.ok("switch on + pilot → PILOT for addresses.patch", open.ok && open.scope === "PILOT");
    const view = await actions.loadHubWriteScopes();
    const addr = "error" in view ? null : view.switches.find((s) => s.switchKey === "address_sync");
    c.ok("the settings read-out shows the scope per switch", !!addr && addr.enabled && addr.pilot?.state === "ACTIVE" && addr.pilot.clients[0]?.name === pilotClient.clientName && addr.headline.includes("approved pilot"), addr ? `${addr.headline} · ${addr.pilot?.state}` : JSON.stringify(view).slice(0, 80));
    c.ok("…every scoped switch is listed (call_booking included)", !("error" in view) && view.switches.map((s) => s.switchKey).join() === "session_booking,address_sync,call_booking");
    c.ok("…and the candidate list holds no TEST client", !("error" in view) && view.candidates.every((x) => !tc.isTestClientName(x.name)) && view.candidates.some((x) => x.id === pilotClient.clientId));
    const rm = await actions.removePilotClientAction({ switchKey: "address_sync", clientId: pilotClient.clientId });
    const after = scopeLib.parseHubWriteConfig(JSON.parse((await prisma.programAutomation.findUniqueOrThrow({ where: { key: "address_sync" } })).configJson ?? "{}"));
    c.ok("removing the last client ends the pilot (and is audited)", rm.ok && after.pilot === null && (await prisma.auditLog.count({ where: { action: "automation_pilot_change" } })) === audits0 + 2);
    const gone = await aryeo.hubWritePermit({ switchKey: "address_sync", client: { id: pilotClient.clientId, name: pilotClient.clientName }, operation: "addresses.patch" });
    c.ok("…and the guard refuses them the moment it is gone", !gone.ok);
    const d = scopeLib.describeHubWriteScope("session_booking", { enabled: false, missing: false, config: scopeLib.parseHubWriteConfig({ authorizedFixtureClientIds: [fixture.clientId], pilot: approved([pilotClient.clientId], BOOK) }) }, new Map([[fixture.clientId, fixture.clientName], [pilotClient.clientId, pilotClient.clientName]]), new Date());
    c.ok("the probe line says an off switch writes for nobody, whatever the lists", /^off — no hub writes for anyone/.test(d.headline) && d.fixtures === fixture.clientName && d.pilot.startsWith("active"), `${d.headline} | ${d.pilot}`);
    process.env.AUTH_ENFORCE = "true";
    const anon = await actions.addPilotClientAction({ switchKey: "address_sync", clientId: pilotClient.clientId, typedName: pilotClient.clientName, groups: ["address"] });
    delete process.env.AUTH_ENFORCE;
    c.ok("with sign-in enforced, nobody signed in cannot approve a pilot", !anon.ok && /sign in/i.test(anon.message), anon.message);

    // Batch-3 review (Sep 25 2026): the end date is ONE date for the whole
    // pilot, and adding a second client with the field blank used to write
    // expiresAt null — the first client's approved end date gone, silently.
    const pilotOf = async () => scopeLib.parseHubWriteConfig(JSON.parse((await prisma.programAutomation.findUniqueOrThrow({ where: { key: "address_sync" } })).configJson ?? "{}")).pilot;
    const first = await actions.addPilotClientAction({ switchKey: "address_sync", clientId: pilotClient.clientId, typedName: pilotClient.clientName, groups: ["address"], expiresOnET: "2026-10-31" });
    c.ok("(a pilot for Marcee, ending Oct 31)", first.ok && (await pilotOf())?.expiresAt === et(11, 1, 0).toISOString() && /ends Oct 31, 2026/.test(first.message), first.message);
    const second = await actions.addPilotClientAction({ switchKey: "address_sync", clientId: unrelated.clientId, typedName: unrelated.clientName, groups: ["address"], expiresOnET: null });
    const p2 = await pilotOf();
    c.ok("adding a second client with the end date left blank KEEPS Oct 31 for everyone", second.ok && p2?.expiresAt === et(11, 1, 0).toISOString() && p2.clientIds.length === 2, `${p2?.expiresAt} · ${second.message}`);
    c.ok("…and says so", /still ends Oct 31, 2026/.test(second.message), second.message);
    const cleared = await actions.addPilotClientAction({ switchKey: "address_sync", clientId: unrelated.clientId, typedName: unrelated.clientName, groups: ["address"], clearExpiry: true });
    c.ok("removing the end date is an explicit choice, and the result names the change", cleared.ok && (await pilotOf())?.expiresAt === null && /end date changed from Oct 31, 2026 to none, for every client in it/.test(cleared.message), cleared.message);
    const panel = fs.readFileSync(path.join(REPO, "src/components/settings/HubWriteScopePanel.tsx"), "utf8");
    c.ok("the form starts on the saved end date and sends clearExpiry only when that date was emptied", /useState\(savedUntil\)/.test(panel) && /clearExpiry: !until && !!savedUntil/.test(panel));
    await actions.endPilotAction({ switchKey: "address_sync" });
  }

  // ======================================================================
  c.head("7 · the fixture list: one audited writer that never touches the pilot (the supervised tests' arm/disarm)");
  {
    const { hubWriteFixture } = await import("../_ops/hub-write-fixture");
    const actions = await import("@/app/settings/pilotActions");
    const lines: string[] = [];
    const log = (l: string) => { lines.push(l); };
    const pilot = approved([pilotClient.clientId], ["invitees.create"]);
    await setSwitch("call_booking", false, { mode: "EMBED", pilot });
    const cfgNow = async () => JSON.parse((await prisma.programAutomation.findUniqueOrThrow({ where: { key: "call_booking" } })).configJson ?? "{}") as Record<string, unknown>;
    const onWithPilot = await hubWriteFixture(["--switch", "call_booking", "--add", fixture.clientId, "--on", "--apply"], log);
    c.ok("--on is refused while the switch carries a pilot with real clients (it would write for them too)", onWithPilot.code === 2 && /pilot/.test(onWithPilot.refused ?? "") && (await cfgNow()).authorizedFixtureClientIds === undefined, onWithPilot.refused);
    const dry = await hubWriteFixture(["--switch", "call_booking", "--add", fixture.clientId], log);
    c.ok("a dry run writes nothing", dry.code === 0 && dry.mode === "dry-run" && (await cfgNow()).authorizedFixtureClientIds === undefined);
    const audits0 = await prisma.auditLog.count({ where: { action: "automation_fixture_change" } });
    const added = await hubWriteFixture(["--switch", "call_booking", "--add", fixture.clientId, "--apply"], log);
    const cfgA = await cfgNow();
    c.ok("--add --apply: the fixture list changes and NOTHING else (the pilot and the mode survive; still off)", added.code === 0 && JSON.stringify(cfgA.authorizedFixtureClientIds) === JSON.stringify([fixture.clientId]) && JSON.stringify(cfgA.pilot) === JSON.stringify(pilot) && cfgA.mode === "EMBED" && (await prisma.programAutomation.findUniqueOrThrow({ where: { key: "call_booking" } })).enabled === false, JSON.stringify(cfgA));
    const audit = await prisma.auditLog.findFirst({ where: { action: "automation_fixture_change" }, orderBy: { createdAt: "desc" } });
    c.ok("…recorded in AuditLog, before → after", (await prisma.auditLog.count({ where: { action: "automation_fixture_change" } })) === audits0 + 1 && audit?.target === "automation:call_booking" && /authorizedFixtureClientIds: null ->/.test(audit.detail), audit?.detail);
    for (const [label, f] of [["a real client", pilotClient], ["a TEST name on a real inbox", realInboxTest]] as const) {
      const r = await hubWriteFixture(["--switch", "call_booking", "--add", f.clientId, "--apply"], log);
      c.ok(`${label} cannot be made a fixture (nothing written)`, r.code === 2 && JSON.stringify((await cfgNow()).authorizedFixtureClientIds) === JSON.stringify([fixture.clientId]), r.refused);
    }
    const never = await hubWriteFixture(["--switch", "call_booking", "--add", tc.NEVER_SYNTHETIC_CLIENT_IDS[0], "--apply"], log);
    c.ok("…nor a real client renamed TEST (never-synthetic id)", never.code === 2 && /real client carrying a TEST name/.test(never.refused ?? ""), never.refused);
    await setSwitch("call_booking", false, { mode: "EMBED", authorizedFixtureClientIds: [fixture.clientId] });
    const on = await hubWriteFixture(["--switch", "call_booking", "--on", "--apply"], log);
    c.ok("with no pilot, --on flips ONLY the switch (config untouched) and is audited", on.code === 0 && on.enabled === true && JSON.stringify(await cfgNow()) === JSON.stringify({ mode: "EMBED", authorizedFixtureClientIds: [fixture.clientId] }) && (await prisma.auditLog.count({ where: { action: "automation_switch_change", target: "automation:call_booking" } })) === 1);
    const off = await hubWriteFixture(["--switch", "call_booking", "--remove", fixture.clientId, "--off", "--apply"], log);
    const rowOff = await prisma.programAutomation.findUniqueOrThrow({ where: { key: "call_booking" } });
    c.ok("the disarm: --remove --off → off, the fixture off the list, the mode kept", off.code === 0 && rowOff.enabled === false && JSON.stringify(JSON.parse(rowOff.configJson ?? "{}")) === JSON.stringify({ mode: "EMBED", authorizedFixtureClientIds: [] }), rowOff.configJson ?? "");
    await setSwitch("session_booking", false, { authorizedFixtureClientIds: [fixture.clientId], pilot: approved([pilotClient.clientId], BOOK) });
    const rmFx = await actions.removeFixtureClientAction({ switchKey: "session_booking", clientId: fixture.clientId });
    const sbCfg = scopeLib.parseHubWriteConfig(JSON.parse((await prisma.programAutomation.findUniqueOrThrow({ where: { key: "session_booking" } })).configJson ?? "{}"));
    c.ok("Settings (owner): Remove takes a fixture off, audited, the pilot kept", rmFx.ok && sbCfg.authorizedFixtureClientIds.length === 0 && sbCfg.pilot?.clientIds[0] === pilotClient.clientId, rmFx.message);
    void lines;
  }

  c.ok("fence: nothing left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  c.summary();
  quiet.restore();
  fence.restore();
  fs.rmSync(baseDir, { recursive: true, force: true });
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  fs.rmSync(baseDir, { recursive: true, force: true });
  process.exit(1);
});
