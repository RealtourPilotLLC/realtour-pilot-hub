// @drill-run: needs=tools/realpg timeout=900
// ---------------------------------------------------------------------------
// DRILL: R04 — duplicate jobs and bookings under REAL concurrency (Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/realpg-duplicate-jobs.ts
//
// Every earlier race drill ran on PGlite, which is ONE database session: two
// "concurrent" imports took turns, a second insert never waited on the first's
// uncommitted row, and an advisory lock was never contended. This one runs on a
// disposable Postgres 18 (the harness's real engine, pool 5 like one Vercel
// function) with racers in this process AND in two child processes, and every
// race proves it overlapped (distinct backends, server-logged lock waits).
// Providers are FAKE: Aryeo is the documented-contract fake, served over
// loopback so the children share its state.
//
//   1. ORDER IMPORT. A new agent's first order imported by six syncAryeoOrders
//      at once (4 here, 2 in children), all held at the order read until all six
//      have preloaded the client list. OLD (aryeo.ts at 3de6023): five of six
//      throw P2002 on Client.aryeoCustomerId, and each loser marks the Aryeo
//      CONNECTION as errored (the Sep 28 finding; a webhook burst for one new
//      order is exactly this). NEW, 20 times: no loser throws, the connection is
//      never marked ERROR, and there is one client, one project, its deliverables,
//      line items and per-video rows, one "Imported from Aryeo", one new-client
//      bell, no orphan client, no text.
//   1b. The per-video rows materialised by six callers at once: rows = owed.
//   2. CAPACITY. A month with one session left: eight asks for DIFFERENT slots →
//      one created, seven "full"; the same slot eight times → one created, seven
//      duplicates. The month lock is contended (server-logged) and no P2028/P2024
//      at pool 5.
//   3. BOOKING DRIVE. The portal's inline booking beside two cron drivers on one
//      queued request: one CONFIRMED attempt, one address, one order, one
//      appointment committed at the fake; every other worker "busy" or never
//      picked it.
//   4. PRO. Both sessions asked for and booked at once: two requests, two orders
//      on two markers, fully scheduled only when both are confirmed, a third ask
//      refused.
//
// ISOLATION: a disposable real Postgres on 127.0.0.1:${DRILL_PORT ?? 5875}
// (harness engine "postgres"); the fake Aryeo on a loopback port. Every .env
// secret is blanked and fetch AND raw sockets are fenced in all three
// processes; nothing leaves the machine and nothing is sent.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { attachDrillChild, bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors, type DrillChild } from "./_harness";
import { barrier } from "../_fixtures/barrier";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import { aryeoOverLoopback, createFakeAryeo, DRILL_TEAM } from "./_fake-aryeo";

const PORT = Number(process.env.DRILL_PORT ?? 5875);
const REPO = path.resolve(__dirname, "../..");
/** Pinned: the tree batch 6 started from. Never HEAD. */
const BASE = "3de6023";
const ITER = Math.max(1, Number(process.env.RACE_ITERATIONS ?? 20));
const OLD_ITER = Math.min(ITER, 5);
const ROLE = process.env.DRILL_CHILD ? process.argv[2] : null;

type Outcome = { who: string; ok: boolean; code: string | null; message: string };
const errCode = (e: unknown) => (e as { code?: string } | null)?.code ?? null;
/** A unique violation by the constraint it names; anything else by its last words. */
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return /Unique constraint failed on the fields: \([^)]*\)/.exec(m)?.[0] ?? m.replace(/\s+/g, " ").slice(-160);
};
const has = (key: string) => (m: unknown) => !!m && typeof m === "object" && key in (m as object);

/** A file from BASE, its `@/` and relative imports pointed at this tree, so
 *  the OLD function runs against the same database and the same helpers. */
function oldCopy(rel: string, dir: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  const from = path.dirname(path.join(REPO, rel));
  const pointed = src.replace(/((?:from|import)\s*\(?\s*)(["'])(@\/|\.\.?\/)([^"']+)\2/g, (_m, pre: string, q: string, head: string, rest: string) =>
    `${pre}${q}${head === "@/" ? path.join(REPO, "src", rest) : path.resolve(from, head + rest)}${q}`);
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, ".base.ts"));
  fs.writeFileSync(file, pointed);
  return file;
}

// ===========================================================================
// THE CHILD: an importer that runs syncAryeoOrders when the parent says go.
// ===========================================================================
async function childMain(role: string) {
  if (role !== "importer") throw new Error(`unknown child role ${role}`);
  // The fence first, so attachDrillChild keeps it: Aryeo goes to the parent's
  // fake over loopback, everything else is blocked and reported to the parent.
  fenceFetch(aryeoOverLoopback(Number(process.env.FAKE_ARYEO_PORT)));
  const ctx = attachDrillChild();
  quietPrismaErrors();
  await import("@/lib/prisma");
  const NEW = await import("@/lib/integrations/aryeo");
  const OLD = (await import(process.env.OLD_ARYEO as string)) as typeof NEW;
  await ctx.send({ ready: true, pid: process.pid });
  for (let k = 1; ; k++) {
    const m = await ctx.waitFor<{ run: number; orderId: string; variant: "old" | "new" } | { exit: true }>(
      (x) => !!x && typeof x === "object" && ((x as { run?: number }).run === k || "exit" in (x as object)),
      600_000,
    );
    if ("exit" in m) break;
    const mod = m.variant === "old" ? OLD : NEW;
    const res = await mod.syncAryeoOrders({ orderId: m.orderId }).then(
      () => ({ ok: true, code: null, message: "" }),
      (e: unknown) => ({ ok: false, code: errCode(e), message: errText(e) }),
    );
    await ctx.send({ run: k, ...res });
  }
  await ctx.exit(0);
}

// ===========================================================================
// THE PARENT
// ===========================================================================
installNextStubs();
let fake: ReturnType<typeof createFakeAryeo> | null = null;
// The parent's fence (a child puts up its own, in childMain).
const fence = ROLE ? null : fenceFetch(async (url, init) => {
  if (url.startsWith("https://geocoding.geo.census.gov/")) {
    const q = decodeURIComponent(new URL(url).searchParams.get("address") ?? "");
    return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -75.6055, y: 39.9607 }, matchedAddress: q.toUpperCase() }] } }), { status: 200 });
  }
  if (url.startsWith("https://nominatim.openstreetmap.org/")) return new Response("[]", { status: 200 });
  if (url.startsWith("https://router.project-osrm.org/")) return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 16_000, duration: 20 * 60 }] }), { status: 200 });
  return fake ? fake.handle(url, init) : null;
});

async function main() {
  const drill = await bootDrillDb({ port: PORT, engine: "postgres", pool: 5, env: { PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r04-dup-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"));
  let kids: DrillChild[] = [];
  let served: { port: number; stop: () => Promise<void> } | null = null;
  try {
    const { prisma } = await import("@/lib/prisma");
    const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
    const everyone = [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm, DRILL_TEAM.harrison.tm];
    fake = createFakeAryeo({
      products: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.productId, everyone])),
      variants: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.productId, p.variantId])),
      variantPrices: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.variantId, 0])),
      defaultCustomerEmail: "info@realtourpilot.com",
    });
    const fk = fake;
    served = await fk.serveOverLoopback();
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("aryeo", "drill-key-not-a-real-one");
    const aryeoNew = await import("@/lib/integrations/aryeo");
    const oldAryeoPath = oldCopy("src/lib/integrations/aryeo.ts", tmp);
    const aryeoOld = (await import(oldAryeoPath)) as typeof aryeoNew;

    // Every write to the Connection row, by any process, as the SERVER saw it.
    await drill.sql(`CREATE TABLE drill_conn_log (at timestamptz NOT NULL DEFAULT clock_timestamp(), status text, last_error text)`);
    await drill.sql(`CREATE FUNCTION drill_conn_log_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO drill_conn_log(status, last_error) VALUES (NEW.status, NEW."lastError"); RETURN NEW; END $$`);
    await drill.sql(`CREATE TRIGGER drill_conn_log_t AFTER INSERT OR UPDATE ON "Connection" FOR EACH ROW EXECUTE FUNCTION drill_conn_log_fn()`);
    const connErrors = async () => (await drill.sql<{ n: number }>(`SELECT count(*)::int AS n FROM drill_conn_log WHERE status = 'ERROR'`))[0].n;
    // Drill-only: attached AFTER INSERT on a table, a row that has been inserted
    // stays uncommitted for 60 ms, so a racer inserting the same unique key
    // WAITS on it (and the server logs the wait) before it gets its P2002 —
    // the slowest honest shape of the race, used for half the iterations below.
    await drill.sql(`CREATE FUNCTION drill_slow_after() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.06); RETURN NULL; END $$`);
    const settle = () => new Promise((r) => setTimeout(r, 80)); // the server's log line lands after the wait ends

    kids = [0, 1].map(() => drill.runChild(__filename, { args: ["importer"], env: { FAKE_ARYEO_PORT: String(served!.port), OLD_ARYEO: oldAryeoPath } }));
    await Promise.all(kids.map((k) => k.waitFor(has("ready"), 180_000)));

    // ======================================================================
    // 1 · ORDER IMPORT
    // ======================================================================
    let orderNo = 7000;
    let seq = 0;
    const ITEMS = [{ title: "Listing Video" }, { title: "Social Media Reel" }];
    const newOrder = (tag: string) => {
      const n = ++seq;
      const customerId = `0198dddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const orderId = `0198eeee-0000-4000-8000-${String(n).padStart(12, "0")}`;
      fk.seedOrder({
        id: orderId, number: ++orderNo, customerId,
        customer: { name: `Race Agent ${tag} ${n}`, email: `race-agent-${n}@drill.invalid`, phone: null },
        address: { id: `0198ffff-0000-4000-8000-${String(n).padStart(12, "0")}`, street_number: String(100 + n), street_name: "Race Ln", unit_number: null, city: "West Chester", state_or_province: "PA", postal_code: "19382", country: "US", latitude: 39.96, longitude: -75.6, unparsed_address: `${100 + n} Race Ln, West Chester, PA 19382` },
        appointments: [], items: ITEMS,
      });
      return { customerId, orderId };
    };
    let run = 0;
    /** Six imports of one order; the four here and the two children are all
     *  held at the order read until the sixth arrives. */
    let heldTogether = 0;
    const importRace = async (variant: "old" | "new", orderId: string, racers = 6): Promise<Outcome[]> => {
      const mod = variant === "old" ? aryeoOld : aryeoNew;
      const b = barrier(racers, { timeoutMs: 60_000, label: `import race on ${orderId}` });
      for (let i = 0; i < racers; i++) fk.script("GET /orders/:id", { hold: () => b.wait() });
      const k = ++run;
      for (const kid of kids) kid.send({ run: k, orderId, variant });
      const local = Array.from({ length: racers - kids.length }, (_, i) =>
        mod.syncAryeoOrders({ orderId }).then(
          (): Outcome => ({ who: `here#${i + 1}`, ok: true, code: null, message: "" }),
          (e: unknown): Outcome => ({ who: `here#${i + 1}`, ok: false, code: errCode(e), message: errText(e) }),
        ),
      );
      const remote = kids.map((kid) =>
        kid.waitFor<{ ok: boolean; code: string | null; message: string }>((m) => (m as { run?: number } | null)?.run === k, 120_000)
          .then((m): Outcome => ({ who: `child ${kid.pid}`, ok: m.ok, code: m.code, message: m.message })),
      );
      const all = await Promise.all([...local, ...remote]);
      // Every racer was inside syncAryeoOrders, past its preload, at once.
      if (b.released && b.arrived === racers && b.late === 0) heldTogether++;
      return all;
    };
    const snapshot = async (customerId: string, orderId: string) => {
      const clients = await prisma.client.findMany({ where: { aryeoCustomerId: customerId }, select: { id: true } });
      const projects = await prisma.project.findMany({ where: { aryeoOrderId: orderId }, select: { id: true, clientId: true } });
      const pid = projects[0]?.id ?? "none";
      const cid = clients[0]?.id ?? "none";
      const [deliverables, items, outputs, imported, greeted, outbox, orphans] = await Promise.all([
        prisma.deliverable.count({ where: { projectId: pid } }),
        prisma.orderItem.count({ where: { projectId: pid } }),
        prisma.deliverableOutput.count({ where: { projectId: pid } }),
        prisma.activity.count({ where: { projectId: pid, type: "SYSTEM", body: { startsWith: "Imported from Aryeo" } } }),
        prisma.notification.count({ where: { kind: "new_client", dedupeKey: { startsWith: `new-client-${cid}` } } }),
        prisma.outboxMessage.count({ where: { clientId: cid } }),
        prisma.client.count({ where: { firstSeenVia: "order", name: { startsWith: "Race Agent" }, projects: { none: {} } } }),
      ]);
      return { clients: clients.length, projects: projects.length, sameClient: projects[0]?.clientId === clients[0]?.id, deliverables, items, outputs, imported, greeted, outbox, orphans };
    };

    c.head("1 · the control: one import on its own says what one order owes");
    const ctl = newOrder("control");
    const alone = await aryeoNew.syncAryeoOrders({ orderId: ctl.orderId });
    const expect = await snapshot(ctl.customerId, ctl.orderId);
    const owedDeliverables = aryeoNew.orderDeliverables(ITEMS as never).length;
    c.ok("one order, imported alone: one client, one project", alone.imported === 1 && expect.clients === 1 && expect.projects === 1, JSON.stringify({ alone, expect }));
    c.ok("its deliverables are orderDeliverables(items), its line items the order's", expect.deliverables === owedDeliverables && expect.items === ITEMS.length, `${expect.deliverables} deliverables · ${expect.items} items`);
    c.ok("and it owes per-video rows (the race below must make exactly these)", expect.outputs >= 2, `${expect.outputs} rows`);
    // Warm the children (their first import loads the modules it imports lazily),
    // so the race below is decided by the database, not by a cold start.
    for (const variant of ["old", "new"] as const) {
      const w = newOrder(`warm-${variant}`);
      const k = ++run;
      for (const kid of kids) kid.send({ run: k, orderId: w.orderId, variant });
      await Promise.all(kids.map((kid) => kid.waitFor((m) => (m as { run?: number } | null)?.run === k, 180_000)));
    }

    c.head(`1 · OLD (aryeo.ts @ ${BASE}): six imports of one new order, ${OLD_ITER} times`);
    {
      const oldLosers: Outcome[] = [];
      const oldRows: Awaited<ReturnType<typeof snapshot>>[] = [];
      const errorsBefore = await connErrors();
      let backends = 0;
      const held0 = heldTogether;
      for (let i = 0; i < OLD_ITER; i++) {
        const o = newOrder("old");
        const { result, distinctBackends } = await drill.backendsDuring(() => importRace("old", o.orderId));
        backends = Math.max(backends, distinctBackends);
        oldLosers.push(...result.filter((x) => !x.ok));
        oldRows.push(await snapshot(o.customerId, o.orderId));
      }
      const markedError = (await connErrors()) - errorsBefore;
      c.ok("non-vacuous: in every race all six were held together at the order read, then let go at once", heldTogether - held0 === OLD_ITER, `${heldTogether - held0}/${OLD_ITER}`);
      c.ok("non-vacuous: the racers ran on several backends at once", backends >= 2, `peak ${backends} distinct backends`);
      c.ok("the unique keys held even so: one client and one project per order", oldRows.every((r) => r.clients === 1 && r.projects === 1), JSON.stringify(oldRows.map((r) => [r.clients, r.projects])));
      c.ok("OLD: five of six imports FAILED every time", oldLosers.length === 5 * OLD_ITER, `${oldLosers.length} failed of ${6 * OLD_ITER}`);
      c.ok("OLD: every failure was P2002 (the client's Aryeo customer id), nothing else", oldLosers.length > 0 && oldLosers.every((x) => x.code === "P2002" && /aryeoCustomerId/.test(x.message)), [...new Set(oldLosers.map((x) => `${x.code}: ${x.message.slice(-70)}`))].join(" | "));
      c.ok("OLD: and each failed import marked the Aryeo CONNECTION as errored", markedError === oldLosers.length, `${markedError} ERROR writes to the Connection row`);
    }

    c.head(`1 · NEW: six imports of one new order, ${ITER} times (4 here, 2 in child processes)`);
    {
      const errorsBefore = await connErrors();
      const outboxBefore = await prisma.outboxMessage.count();
      const smsBefore = await prisma.pendingSms.count();
      const failures: Outcome[] = [];
      const rows: Awaited<ReturnType<typeof snapshot>>[] = [];
      let backends = 0;
      let minBackends = Infinity;
      const slowFrom = Math.floor(ITER / 2);
      let slowWaits = 0;
      const held0 = heldTogether;
      for (let i = 0; i < ITER; i++) {
        if (i === slowFrom) await drill.sql(`CREATE TRIGGER drill_slow_client AFTER INSERT ON "Client" FOR EACH ROW EXECUTE FUNCTION drill_slow_after()`);
        const w0 = drill.lockWaits();
        const o = newOrder("new");
        const { result, distinctBackends } = await drill.backendsDuring(() => importRace("new", o.orderId));
        backends = Math.max(backends, distinctBackends);
        minBackends = Math.min(minBackends, distinctBackends);
        failures.push(...result.filter((x) => !x.ok));
        rows.push(await snapshot(o.customerId, o.orderId));
        if (i >= slowFrom) { await settle(); slowWaits += drill.lockWaits() - w0; }
      }
      await drill.sql(`DROP TRIGGER drill_slow_client ON "Client"`);
      const bad = (pred: (r: Awaited<ReturnType<typeof snapshot>>) => boolean) => rows.map((r, i) => (pred(r) ? null : `#${i + 1} ${JSON.stringify(r)}`)).filter(Boolean).slice(0, 2).join(" · ");
      c.ok("non-vacuous: in every race all six were held together at the order read, then let go at once", heldTogether - held0 === ITER, `${heldTogether - held0}/${ITER}`);
      c.ok("non-vacuous: the racers ran on several backends at once", backends >= 2, `peak ${backends} distinct backends (${minBackends} in the quietest race: the 5 ms sampler misses statements that finish between samples)`);
      c.ok(`non-vacuous: with the winner's client row held uncommitted (${ITER - slowFrom} races), the losers WAITED on it — server-logged`, slowWaits >= 1, `${slowWaits} lock waits logged`);
      c.ok("no import failed — the losers took the winner's client and left the order to it", failures.length === 0, failures.slice(0, 3).map((x) => `${x.who} ${x.code}: ${x.message}`).join(" | "));
      c.ok("the Aryeo connection was never marked ERROR", (await connErrors()) === errorsBefore, `${(await connErrors()) - errorsBefore} ERROR writes`);
      c.ok("exactly 1 client (by Aryeo customer id) and 1 project (by order id), the project on that client", rows.every((r) => r.clients === 1 && r.projects === 1 && r.sameClient), bad((r) => r.clients === 1 && r.projects === 1 && r.sameClient));
      c.ok(`deliverables = orderDeliverables(items) = ${owedDeliverables}, line items = ${ITEMS.length}`, rows.every((r) => r.deliverables === owedDeliverables && r.items === ITEMS.length), bad((r) => r.deliverables === owedDeliverables && r.items === ITEMS.length));
      c.ok(`per-video rows = what one import makes (${expect.outputs})`, rows.every((r) => r.outputs === expect.outputs), bad((r) => r.outputs === expect.outputs));
      // (The "Booked" bell is emitted right after that line by the same caller,
      // and only by it; it is silenced by policy — BELL_RULES order_booked "off"
      // — and deduped per project, so there is no row to count.)
      c.ok("one \"Imported from Aryeo\" line per order (written in the project's own create)", rows.every((r) => r.imported === 1), bad((r) => r.imported === 1));
      c.ok("the new client was announced once", rows.every((r) => r.greeted === 1), bad((r) => r.greeted === 1));
      c.ok("no orphan client (a client made by a loser, with no project)", rows.every((r) => r.orphans === 0), bad((r) => r.orphans === 0));
      c.ok("no text or outbox row from any of it", (await prisma.outboxMessage.count()) === outboxBefore && (await prisma.pendingSms.count()) === smsBefore);
    }

    c.head(`1b · per-video rows made by six callers at once, ${ITER} times`);
    {
      const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
      const template = await prisma.project.findUniqueOrThrow({ where: { aryeoOrderId: ctl.orderId }, select: { clientId: true, deliverables: { select: { type: true, label: true, quantity: true, productTitle: true, videoStyle: true } } } });
      const counts: number[] = [];
      const failed: string[] = [];
      let minBackends = Infinity;
      let maxBackends = 0;
      await drill.sql(`CREATE TRIGGER drill_slow_output AFTER INSERT ON "DeliverableOutput" FOR EACH ROW EXECUTE FUNCTION drill_slow_after()`);
      const w0 = drill.lockWaits();
      for (let i = 0; i < ITER; i++) {
        const p = await prisma.project.create({ data: { title: `${200 + i} Output Race Rd`, status: "BOOKED", clientId: template.clientId, deliverables: { create: template.deliverables } }, select: { id: true } });
        const { result, distinctBackends } = await drill.backendsDuring(() => Promise.all(Array.from({ length: 6 }, () => ensureOutputsSafely(p.id, "r04-drill"))));
        minBackends = Math.min(minBackends, distinctBackends);
        maxBackends = Math.max(maxBackends, distinctBackends);
        failed.push(...result.filter((r) => !r.ok).map((r) => r.error ?? "?"));
        counts.push(await prisma.deliverableOutput.count({ where: { projectId: p.id } }));
      }
      await settle();
      await drill.sql(`DROP TRIGGER drill_slow_output ON "DeliverableOutput"`);
      c.ok("non-vacuous: several backends at once", maxBackends >= 2, `peak ${maxBackends} (quietest race ${minBackends})`);
      c.ok("non-vacuous: callers waited on each other's uncommitted rows (server-logged)", drill.lockWaits() - w0 >= 1, `${drill.lockWaits() - w0} lock waits logged`);
      c.ok("every caller succeeded", failed.length === 0, failed.slice(0, 2).join(" | "));
      c.ok(`rows = owed (${expect.outputs}) every time`, counts.every((n) => n === expect.outputs), counts.join(","));
    }

    // ======================================================================
    // THE PROGRAM WORLD (sections 2-4)
    // ======================================================================
    const sr = await import("@/lib/sessionRequests");
    const sb = await import("@/lib/sessionBooking");
    const sa = await import("@/lib/sessionAddress");
    const HOUR = 3_600_000;
    const at = (day: string, hourET: number) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hourET + 4));
    // October 2026 weekdays (EDT all month), and three creatives assigned to
    // every program product: 66 (creative, day) places, one booking each, so no
    // two bookings in this drill share a creative's day or a drive.
    const days: string[] = [];
    for (let d = 1; d <= 30; d++) {
      const iso = `2026-10-${String(d).padStart(2, "0")}`;
      const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
      if (wd !== 0 && wd !== 6) days.push(iso);
    }
    const creatives = [DRILL_TEAM.james, DRILL_TEAM.jordan, DRILL_TEAM.harrison].map((t) => ({ teamMemberId: t.tm, name: t.name }));
    const places = creatives.flatMap((cr) => days.map((day) => ({ creative: cr, day })));
    let placeAt = 0;
    const nextPlace = () => {
      const p = places[placeAt++];
      if (!p) throw new Error("the drill ran out of (creative, day) places");
      return p;
    };
    let n = 0;
    const setSwitch = async (key: string, enabled: boolean, config: Record<string, unknown> | null = null) =>
      prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(), configJson: config ? JSON.stringify(config) : null }, update: { enabled, configJson: config ? JSON.stringify(config) : null } });
    const authorised = new Set<string>();
    const world = async (pkg: "Accelerator" | "Pro", authorise: boolean): Promise<ContentMonthFixture> => {
      const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: `Race Drill ${++n} TEST`, package: pkg, monthKey: "2026-10", project: false, owner: { email: `race${n}@realtourpilot.com` } });
      await prisma.client.update({ where: { id: f.clientId }, data: { email: "info@realtourpilot.com", aryeoCustomerId: `0197dddd-0000-4000-8000-${String(n).padStart(12, "0")}` } });
      if (authorise) {
        authorised.add(f.clientId);
        await setSwitch("session_booking", true, { authorizedFixtureClientIds: [...authorised] });
      }
      return f;
    };
    const planFor = async (f: ContentMonthFixture, sessionIndex = 1) => {
      const saved = await sa.saveSessionPlanAddress({ enrollmentId: f.enrollmentId, monthId: f.monthId, sessionIndex, input: { street: "117 Kyle Lane", unit: "Unit 2", city: "West Chester", state: "PA", zip: "19382" }, by: "drill" });
      if (!saved.ok || !saved.planId) throw new Error(`plan: ${saved.message}`);
      return { planId: saved.planId, addressVersion: saved.addressVersion! };
    };
    type Plan = Awaited<ReturnType<typeof planFor>>;
    const ask = (f: ContentMonthFixture, start: Date, plan: Plan, creative: { teamMemberId: string; name: string }, sessionIndex = 1) =>
      sr.createSessionRequest({
        enrollmentId: f.enrollmentId, monthId: f.monthId,
        slot: { startISO: start.toISOString(), endISO: new Date(start.getTime() + 4 * HOUR).toISOString() },
        actor: { kind: "STAFF", userId: null }, creative, plan, travel: { check: "HUB_DRIVE", evidenceJson: null }, sessionIndex,
      });
    const committed = (m: string, p: string) => fk.count(m, p, true);
    // A drill-only trigger: the one insert a capacity race makes takes 80 ms,
    // inside the month's advisory lock, so every racer queued behind it waits
    // past deadlock_timeout (50 ms) and the SERVER logs the wait. Without it the
    // lock is still contended, just too briefly for the log to prove it.
    await drill.sql(`CREATE FUNCTION drill_slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.08); RETURN NEW; END $$`);
    await drill.sql(`CREATE TRIGGER drill_slow_request BEFORE INSERT ON "ProgramSessionRequest" FOR EACH ROW EXECUTE FUNCTION drill_slow_insert()`);

    // ======================================================================
    c.head(`2 · capacity: one session left, eight asks at once, ${ITER} times each way`);
    // ======================================================================
    {
      await prisma.programAutomation.deleteMany({ where: { key: "session_booking" } }); // desk-assisted: this is about the ask, not the booking
      const txErrors: string[] = [];
      const noteTx = (rs: PromiseSettledResult<unknown>[]) => { for (const r of rs) if (r.status === "rejected") txErrors.push(`${errCode(r.reason) ?? "?"}: ${errText(r.reason)}`); };
      const diff: string[] = [];
      const same: string[] = [];
      let minBackends = Infinity;
      let maxBackends = 0;
      const waits0 = drill.lockWaits();
      let diffWaits = 0;
      for (let i = 0; i < ITER; i++) {
        const f = await world("Accelerator", false);
        const plan = await planFor(f);
        const w0 = drill.lockWaits();
        const { result, distinctBackends } = await drill.backendsDuring(() => Promise.allSettled(days.slice(0, 8).map((d) => ask(f, at(d, 10), plan, creatives[0]))));
        minBackends = Math.min(minBackends, distinctBackends);
        maxBackends = Math.max(maxBackends, distinctBackends);
        noteTx(result);
        const vals = result.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        const created = vals.filter((v) => v.ok && !v.duplicate).length;
        const full = vals.filter((v) => !v.ok && /already booked or requested/.test(v.reason)).length;
        const rows = await prisma.programSessionRequest.count({ where: { monthId: f.monthId } });
        if (!(created === 1 && full === 7 && rows === 1)) diff.push(`#${i + 1}: ${created} created, ${full} full, ${rows} rows`);
        await new Promise((r) => setTimeout(r, 60)); // let the server's log line land
        diffWaits += drill.lockWaits() - w0;
      }
      for (let i = 0; i < ITER; i++) {
        const f = await world("Accelerator", false);
        const plan = await planFor(f);
        const { result, distinctBackends } = await drill.backendsDuring(() => Promise.allSettled(Array.from({ length: 8 }, () => ask(f, at("2026-10-14", 10), plan, creatives[0]))));
        minBackends = Math.min(minBackends, distinctBackends);
        maxBackends = Math.max(maxBackends, distinctBackends);
        noteTx(result);
        const vals = result.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        const created = vals.filter((v) => v.ok && !v.duplicate);
        const dups = vals.filter((v) => v.ok && v.duplicate);
        const rows = await prisma.programSessionRequest.count({ where: { monthId: f.monthId } });
        const oneId = created.length === 1 && dups.every((d) => d.ok && created[0].ok && d.id === created[0].id);
        if (!(created.length === 1 && dups.length === 7 && rows === 1 && oneId)) same.push(`#${i + 1}: ${created.length} created, ${dups.length} duplicates, ${rows} rows`);
      }
      await new Promise((r) => setTimeout(r, 100));
      c.ok("non-vacuous: several backends at once", maxBackends >= 2, `peak ${maxBackends} (quietest race ${minBackends})`);
      c.ok("non-vacuous: the month lock was contended — waits the SERVER logged", diffWaits >= 1 && drill.lockWaits() - waits0 >= 1, `${diffWaits} logged in the different-slot races, ${drill.lockWaits() - waits0} in all`);
      c.ok("eight DIFFERENT slots: exactly 1 created, 7 \"full\", 1 row — every time", diff.length === 0, diff.slice(0, 3).join(" · ") || `${ITER}/${ITER}`);
      c.ok("the SAME slot eight times: 1 created, 7 duplicates of it, 1 row — every time", same.length === 0, same.slice(0, 3).join(" · ") || `${ITER}/${ITER}`);
      c.ok("no transaction error at pool 5 (no P2028 timeout, no P2024 pool wait)", txErrors.length === 0, txErrors.slice(0, 3).join(" | "));
    }

    // ======================================================================
    c.head(`3 · the portal's inline booking beside two cron drivers, ${ITER} times`);
    // ======================================================================
    {
      const bad: string[] = [];
      const losers: string[] = [];
      let minBackends = Infinity;
      let maxBackends = 0;
      const c0 = { a: committed("POST", "/addresses"), o: committed("POST", "/orders"), s: committed("POST", "/appointments/store") };
      // Drill-only: the claim that takes a free lease holds the row for 60 ms,
      // so a worker that reaches the same row meanwhile WAITS on its row lock
      // (server-logged) and then re-reads it under Postgres's own rules — the
      // lease is a compare-and-set, and this is the moment it must hold.
      await drill.sql(`CREATE FUNCTION drill_slow_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."leaseBy" IS NULL AND NEW."leaseBy" IS NOT NULL THEN PERFORM pg_sleep(0.06); END IF; RETURN NEW; END $$`);
      await drill.sql(`CREATE TRIGGER drill_slow_claim_t BEFORE UPDATE ON "ProgramSessionRequest" FOR EACH ROW EXECUTE FUNCTION drill_slow_claim()`);
      const waits0 = drill.lockWaits();
      for (let i = 0; i < ITER; i++) {
        const f = await world("Accelerator", true);
        const plan = await planFor(f);
        const place = nextPlace();
        const r = await ask(f, at(place.day, 10), plan, place.creative);
        if (!r.ok) throw new Error(`setup: ${r.reason}`);
        const d0 = { a: committed("POST", "/addresses"), o: committed("POST", "/orders"), s: committed("POST", "/appointments/store") };
        const { result, distinctBackends } = await drill.backendsDuring(() =>
          Promise.all([
            sb.bookSessionRequest(r.id, { worker: "portal", budgetMs: sb.INLINE_BOOKING_BUDGET_MS }),
            sb.driveSessionBookings({}),
            sb.driveSessionBookings({}),
          ]),
        );
        minBackends = Math.min(minBackends, distinctBackends);
        maxBackends = Math.max(maxBackends, distinctBackends);
        const [portal, cronA, cronB] = result;
        const cronOutcomes = [cronA, cronB].flatMap((x) => ("outcomes" in x ? x.outcomes : []));
        const all = [portal, ...cronOutcomes].filter((x) => x.requestId === r.id);
        const confirmed = all.filter((x) => x.outcome === "confirmed").length;
        const others = all.filter((x) => x.outcome !== "confirmed");
        losers.push(...others.map((x) => x.outcome));
        const attempts = await prisma.programBookingAttempt.findMany({ where: { requestId: r.id }, select: { state: true } });
        const row = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: r.id }, select: { status: true } });
        const d = { a: committed("POST", "/addresses") - d0.a, o: committed("POST", "/orders") - d0.o, s: committed("POST", "/appointments/store") - d0.s };
        const good = confirmed === 1 && others.every((x) => x.outcome === "busy") && attempts.length === 1 && attempts[0].state === "CONFIRMED" && row.status === "CONFIRMED" && d.a === 1 && d.o === 1 && d.s === 1;
        if (!good) bad.push(`#${i + 1}: ${all.map((x) => x.outcome).join("/")} · attempts ${attempts.map((a) => a.state).join(",")} · ${row.status} · writes ${JSON.stringify(d)}`);
      }
      await settle();
      await drill.sql(`DROP TRIGGER drill_slow_claim_t ON "ProgramSessionRequest"`);
      c.ok("non-vacuous: several backends at once", maxBackends >= 2, `peak ${maxBackends} (quietest race ${minBackends})`);
      c.ok("non-vacuous: a loser waited on the winner's claim of the row (server-logged)", drill.lockWaits() - waits0 >= 1, `${drill.lockWaits() - waits0} lock waits logged`);
      c.ok("exactly one worker booked it; every other that reached it was \"busy\"", bad.length === 0, bad.slice(0, 2).join(" · ") || `${losers.length} losers reached the claim, all busy; the rest found it already leased`);
      c.ok("one CONFIRMED attempt, and at the fake exactly 1 address, 1 order, 1 appointment per booking", bad.length === 0 && committed("POST", "/addresses") - c0.a === ITER && committed("POST", "/orders") - c0.o === ITER && committed("POST", "/appointments/store") - c0.s === ITER, `${committed("POST", "/addresses") - c0.a}/${committed("POST", "/orders") - c0.o}/${committed("POST", "/appointments/store") - c0.s} over ${ITER} bookings`);
    }

    // ======================================================================
    c.head(`4 · Pro: both sessions asked for and booked at once, ${ITER} times`);
    // ======================================================================
    {
      const bad: string[] = [];
      let minBackends = Infinity;
      let maxBackends = 0;
      const waits0 = drill.lockWaits();
      for (let i = 0; i < ITER; i++) {
        const f = await world("Pro", true);
        const [p1, p2] = [await planFor(f, 1), await planFor(f, 2)];
        const [s1, s2] = [nextPlace(), nextPlace()];
        const asked = await drill.backendsDuring(() => Promise.all([ask(f, at(s1.day, 10), p1, s1.creative, 1), ask(f, at(s2.day, 10), p2, s2.creative, 2)]));
        const [a, b] = asked.result;
        if (!a.ok || !b.ok) { bad.push(`#${i + 1}: asks ${a.ok ? "ok" : a.reason} / ${b.ok ? "ok" : b.reason}`); continue; }
        const capAsked = await sr.sessionCapacity(f.enrollmentId, f.monthId);
        const o0 = committed("POST", "/orders");
        const booked = await drill.backendsDuring(() => Promise.all([sb.bookSessionRequest(a.id, { worker: "portal" }), sb.bookSessionRequest(b.id, { worker: "portal" }), sb.driveSessionBookings({})]));
        minBackends = Math.min(minBackends, asked.distinctBackends, booked.distinctBackends);
        maxBackends = Math.max(maxBackends, asked.distinctBackends, booked.distinctBackends);
        const rows = await prisma.programSessionRequest.findMany({ where: { monthId: f.monthId }, select: { id: true, status: true, aryeoOrderId: true } });
        const attempts = await prisma.programBookingAttempt.findMany({ where: { requestId: { in: [a.id, b.id] } }, select: { marker: true, state: true, aryeoOrderId: true } });
        const full = await sr.sessionCapacity(f.enrollmentId, f.monthId);
        const third = await ask(f, at(days[0], 15), p1, creatives[0], 1); // refused before anything is booked
        const markers = new Set(attempts.map((x) => x.marker));
        const orders = new Set(rows.map((x) => x.aryeoOrderId).filter(Boolean));
        const good = rows.length === 2 && rows.every((x) => x.status === "CONFIRMED") && committed("POST", "/orders") - o0 === 2 && orders.size === 2 &&
          attempts.length === 2 && markers.size === 2 && markers.has(sb.bookingMarker(a.id, 1)) && markers.has(sb.bookingMarker(b.id, 1)) &&
          capAsked.remaining === 0 && !capAsked.fullyScheduled && full.fullyScheduled && full.confirmedSessions === 2 && !third.ok;
        if (!good) bad.push(`#${i + 1}: ${JSON.stringify({ rows: rows.map((x) => x.status), orders: orders.size, markers: [...markers].length, capAsked: [capAsked.remaining, capAsked.fullyScheduled], full: [full.fullyScheduled, full.confirmedSessions], third: third.ok })}`);
      }
      await new Promise((r) => setTimeout(r, 100));
      c.ok("non-vacuous: several backends at once", maxBackends >= 2, `peak ${maxBackends} (quietest race ${minBackends})`);
      c.ok("non-vacuous: the two asks queued on the month lock (server-logged)", drill.lockWaits() - waits0 >= 1, `${drill.lockWaits() - waits0} logged`);
      c.ok("two requests, two orders on two markers, both CONFIRMED — every time", bad.length === 0, bad.slice(0, 2).join(" · ") || `${ITER}/${ITER}`);
      c.ok("fully scheduled only once both are confirmed, and a third ask refused", bad.length === 0);
    }

    // ======================================================================
    c.head("5 · nothing left the machine");
    // ======================================================================
    for (const kid of kids) kid.send({ exit: true });
    await Promise.all(kids.map((k) => Promise.race([k.exited, new Promise((r) => setTimeout(r, 10_000))])));
    c.ok("0 attempts to reach anything but the fake Aryeo and the stubbed geocoder/router, in any of the three processes", fence!.blocked.length === 0, fence!.blocked.slice(0, 5).join(", ") || "none");
    c.ok("the database was this drill's own", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/drill?`));
    console.log(`\n    ${await drill.evidence()}`);
    console.log(`    (${quiet.count} expected prisma:error log lines suppressed in this process)`);
  } finally {
    quiet.restore();
    c.summary();
    await served?.stop().catch(() => {});
    await drill.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}

(ROLE ? childMain(ROLE) : main()).catch((e) => { console.error(e); process.exit(1); });
