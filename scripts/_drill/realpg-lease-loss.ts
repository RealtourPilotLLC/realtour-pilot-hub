// @drill-run: needs=tools/realpg timeout=900
// ---------------------------------------------------------------------------
// DRILL: R04 — a worker that loses its lease after an external write
// (Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/realpg-lease-loss.ts
//
// A lease is a promise that one worker owns a row for a while. It is broken by
// a process that freezes (a suspended function, a paused VM) for longer than
// the lease while a provider holds its call: the next worker takes the row
// over, and then the first one wakes up holding an answer. On a disposable
// Postgres 18 (the harness's real engine), with the provider FAKE and HELD at
// the exact moment, this drives that for each place the hub writes out:
//
//   1. BOOKING (sessionBooking, lease 5 min). Worker A is held inside Aryeo's
//      POST /orders (the order committed); B at t0+5m+1s takes the lease and
//      waits for the marker scan; B at t0+10m+1s finds the order by its marker,
//      stores the appointment and confirms. Then A wakes up.
//        OLD (3de6023): A wrote ORDER_CREATED over the CONFIRMED attempt and
//        the request, and when its read of the order then failed, the booking
//        was left CONFIRMED with an unsettled attempt — nothing ever drives a
//        confirmed request again. NEW: A's late answer lands only on an attempt
//        still ORDER_SENT; A stops, 'pending', without reading anything.
//      The same when A wakes to a TIMEOUT instead (OLD wrote ORDER_UNKNOWN /
//      APPT_UNKNOWN over the confirmed booking; NEW leaves it).
//      Commit AFTER the hold (NEW): B's scans find nothing and never write; A's
//      late order lands, A stops at the lease check before the appointment, and
//      the next tick books on A's order. One order, one appointment.
//      The same for POST /appointments/store (OLD, then NEW).
//   2. TOPAZ (topazJobs, lease 12 min). Six estimated jobs over a 100-credit
//      cap, two ticks at once (one here, one in a child process), 20 times: the
//      credits committed never pass the cap, three renders accepted each time,
//      and the budget lock was contended (server-logged). Then a lease expired
//      mid-accept: the second tick asks Topaz, takes fresh upload URLs (accept
//      is free; the first tick's URLs were never stored), and the first tick's
//      holdLease returns false — one reservation, one set of targets.
//   3. AI RUN ZOMBIE (aiRuns, lease 10 min). A is held in the model, its lease
//      backdated; B drafts the same topic. OLD: A's late answer flipped its
//      FAILED run back to SUCCEEDED and added a SECOND version to B's script.
//      NEW: A's run stays FAILED with its cost kept, A throws LeaseLostError,
//      one version; the owed-script sweep counts it as raced, not failed.
//      3a: the same freeze one step later — AFTER the model answered, the run
//      SUCCEEDED with its key held, before the version is written (review,
//      Sep 28). OLD: a second version. NEW: claimRunWrite refuses A's write.
//   4. CRASH (cron-route-journey §5, on real Postgres): a child process running
//      the owed-script sweep is SIGKILLed inside the model; the server ends its
//      session; the lease holds; backdated, it is drafted exactly once.
//
// ISOLATION: a disposable real Postgres on 127.0.0.1:${DRILL_PORT ?? 5876}; the
// fake Aryeo, the fake Topaz and the fake model are in-process; every .env
// secret is blanked and fetch AND raw sockets are fenced in every process.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { attachDrillChild, bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";
import { createFakeAryeo, DRILL_TEAM } from "./_fake-aryeo";

const PORT = Number(process.env.DRILL_PORT ?? 5876);
const REPO = path.resolve(__dirname, "../..");
/** Pinned: the tree batch 6 started from. Never HEAD. */
const BASE = "3de6023";
const ITER = Math.max(1, Number(process.env.RACE_ITERATIONS ?? 20));
const ROLE = process.env.DRILL_CHILD ? process.argv[2] : null;
const MIN = 60_000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
const has = (key: string) => (m: unknown) => !!m && typeof m === "object" && key in (m as object);
/** A door the drill opens: `wait` blocks until `open()` is called. */
const door = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; };

/** A file from BASE, its `@/` and relative imports pointed at this tree. */
function oldCopy(rel: string, dir: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  const from = path.dirname(path.join(REPO, rel));
  const pointed = src.replace(/((?:from|import)\s*\(?\s*)(["'])(@\/|\.\.?\/)([^"']+)\2/g, (_m, pre: string, q: string, head: string, rest: string) =>
    `${pre}${q}${head === "@/" ? path.join(REPO, "src", rest) : path.resolve(from, head + rest)}${q}`);
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, ".base.ts"));
  fs.writeFileSync(file, pointed);
  return file;
}

installNextStubs();

// ---- the model boundary (every process) ------------------------------------
// One function is fake: aiJsonWithUsage. runAiJson's ledger, lease and dedupe
// key around it are the shipped ones (the OLD copy's, when it is the one in use).
let draftCalls = 0;
let onDraft: (() => void | Promise<void>) | null = null;
interceptModule(
  // "@/lib/integrations/ai" from this tree; the OLD copy's absolute path.
  (r) => r === "@/lib/integrations/ai" || /[\\/]integrations[\\/]ai(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { prompt: string; schema?: { properties?: Record<string, unknown> } }) => {
        const props = opts.schema?.properties ?? {};
        if (!("hook" in props && "points" in props)) throw new Error("the drill's model only drafts scripts");
        draftCalls++;
        const hook = onDraft;
        onDraft = null; // one-shot: only the call it was set for
        if (hook) await hook();
        const title = (/TOPIC:\s*(.+)/.exec(opts.prompt)?.[1] ?? "Drafted topic").trim().slice(0, 90);
        return {
          result: {
            title, category: "Market Authority", hook: "The first weekend is the whole negotiation.",
            points: [
              { role: "PROOF", text: "Every listing that sat past the first weekend sold for less." },
              { role: "CONTEXT", text: "Buyers read days on market as a discount signal." },
              { role: "ACTION", text: "Price it right before the photos go live." },
            ],
            close: "That is why the first weekend decides your price.", captionCta: "DM me the word PRICE.", filmingNotes: null, gaps: [],
          },
          usage: { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: "claude-sonnet-4-6",
        };
      };
    },
  }),
);

// ---- which aiRuns the generators get: this tree's, or the OLD one ----------
let aiRunsOld: Record<string | symbol, unknown> | null = null;
let useOldAiRuns = false;
/** One-shot: held right AFTER runAiJson returns — the model answered, the run
 *  is SUCCEEDED with its key held, the output not yet written (§3a). */
let afterRun: (() => Promise<void>) | null = null;
interceptModule(
  (r) => r === "@/lib/aiRuns",
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      const old = useOldAiRuns && aiRunsOld;
      // A name the OLD file does not have is the review's write fence
      // (claimRunWrite, Sep 28): the OLD tree had no such call, so it is a no-op.
      const v = old ? (k in aiRunsOld! ? aiRunsOld![k] : k === "claimRunWrite" ? async () => {} : t[k]) : t[k];
      if (k === "runAiJson" && afterRun) {
        const hook = afterRun;
        afterRun = null;
        return async (...args: unknown[]) => {
          const r = await (v as (...a: unknown[]) => Promise<unknown>)(...args);
          await hook();
          return r;
        };
      }
      return v;
    },
  }),
);

// ---- Topaz, faked at its client (every process) -----------------------------
const topaz = { accept: 0, status: 0, cancelEstimate: 0, cancelRequest: 0 };
let acceptHold: (() => Promise<void>) | null = null;
const TOPAZ_LIMITS = { enabled: true, maxCreditsPerMonth: 100, maxCreditsPerVideo: 100, maxRendersPerDay: 100, maxRendersPerMonth: 100, maxConcurrent: 50, maxAttempts: 3, minBalanceCredits: 0 };
interceptModule(
  (r) => r === "@/lib/integrations/topaz",
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      switch (k) {
        case "acceptVideoRequest":
          return async () => {
            const n = ++topaz.accept;
            const hold = acceptHold;
            acceptHold = null;
            if (hold) await hold();
            return [{ partNum: 1, url: `https://drill.invalid/put/${process.pid}/${n}` }];
          };
        case "videoStatus":
          return async () => { topaz.status++; return { status: "accepted", downloadUrl: null, credits: null, progress: null, message: null, raw: {} }; };
        case "cancelEstimate":
          return async () => { topaz.cancelEstimate++; return true; };
        case "cancelVideoRequest":
          return async () => { topaz.cancelRequest++; return true; };
        case "topazConnected":
          return async () => true;
        case "topazBalance":
          return async () => ({ available_credits: 400, reserved_credits: 0, total_credits: 400 });
        default:
          return t[k];
      }
    },
  }),
);
interceptModule(
  (r) => r === "@/lib/settings",
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "topazSettings") return t[k];
      return async () => ({ ...(await (t[k] as () => Promise<Record<string, unknown>>)()), ...TOPAZ_LIMITS });
    },
  }),
);

// ===========================================================================
// THE CHILDREN
// ===========================================================================
async function childMain(role: string) {
  const ctx = attachDrillChild();
  quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  if (role === "topaz-tick") {
    const tj = await import("@/lib/topazJobs");
    await ctx.send({ ready: true, pid: process.pid });
    for (let k = 1; ; k++) {
      const m = await ctx.waitFor<{ run: number } | { exit: true }>((x) => !!x && typeof x === "object" && ((x as { run?: number }).run === k || "exit" in (x as object)), 600_000);
      if ("exit" in m) break;
      const claimed = await tj.claimTopazJobs(3, `tick-child-${k}`);
      const states: string[] = [];
      for (const id of claimed) states.push(await tj.advanceTopazJob(id));
      await ctx.send({ run: k, claimed, states, accepts: topaz.accept });
    }
    await ctx.exit(0);
  }
  if (role === "draft-and-die") {
    const { draftOwedScriptsForMonth } = await import("@/lib/contentDrafting");
    const m = await ctx.waitFor<{ monthId: string }>(has("monthId"), 120_000);
    onDraft = async () => {
      await ctx.send({ inModel: true, pid: process.pid });
      process.kill(process.pid, "SIGKILL"); // dies holding the run's lease and dedupe key
    };
    await draftOwedScriptsForMonth(m.monthId, { requestedBy: "cron", unattended: true });
    await ctx.send({ finished: true }); // must never be reached
    await prisma.$disconnect();
    await ctx.exit(3);
  }
  throw new Error(`unknown child role ${role}`);
}

// ===========================================================================
// THE PARENT
// ===========================================================================
let fake: ReturnType<typeof createFakeAryeo> | null = null;
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r04-lease-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"));
  const settle = () => new Promise((r) => setTimeout(r, 100)); // the server's log line lands after a wait ends
  try {
    const { prisma } = await import("@/lib/prisma");
    const setSwitch = async (key: string, enabled: boolean, config: Record<string, unknown> | null = null) =>
      prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(), configJson: config ? JSON.stringify(config) : null }, update: { enabled, configJson: config ? JSON.stringify(config) : null } });

    // ======================================================================
    // 1 · BOOKING
    // ======================================================================
    // THE CLOCK, for section 1 only (Oct 5 2026). The bookings below are fixed
    // October 2026 weekdays drawn in late September; on the real clock the
    // first one (Mon Oct 5 10:00 ET) became "That time has passed — pick a
    // later one." and the drill stopped with 0 checks run. Pinned to Mon Sep 28
    // 2026 10:00 ET (running forward in real time) while the bookings run, and
    // put back before the Topaz section, which reads this month's real caps.
    const RealDate = Date;
    const offset = RealDate.UTC(2026, 8, 28, 14, 0, 0) - RealDate.now(); // Mon Sep 28 2026 10:00 EDT
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
    try {
      const { ARYEO_CONTENT_PRODUCTS } = await import("@/lib/contentProgram");
      const everyone = [DRILL_TEAM.james.tm, DRILL_TEAM.jordan.tm, DRILL_TEAM.harrison.tm];
      fake = createFakeAryeo({
        products: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.productId, everyone])),
        variants: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.productId, p.variantId])),
        variantPrices: Object.fromEntries(Object.values(ARYEO_CONTENT_PRODUCTS).map((p) => [p.variantId, 0])),
        defaultCustomerEmail: "info@realtourpilot.com",
      });
      const fk = fake;
      const { saveSecret } = await import("@/lib/integrations/connections");
      await saveSecret("aryeo", "drill-key-not-a-real-one");
      const sbNew = await import("@/lib/sessionBooking");
      const sbOld = (await import(oldCopy("src/lib/sessionBooking.ts", tmp))) as typeof sbNew;
      const sr = await import("@/lib/sessionRequests");
      const sa = await import("@/lib/sessionAddress");
      const at = (day: string, hourET: number) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hourET + 4));
      const places = [
        { tm: DRILL_TEAM.james, day: "2026-10-05" }, { tm: DRILL_TEAM.jordan, day: "2026-10-06" }, { tm: DRILL_TEAM.harrison, day: "2026-10-07" },
        { tm: DRILL_TEAM.james, day: "2026-10-08" }, { tm: DRILL_TEAM.jordan, day: "2026-10-09" }, { tm: DRILL_TEAM.harrison, day: "2026-10-12" },
        { tm: DRILL_TEAM.james, day: "2026-10-13" }, { tm: DRILL_TEAM.jordan, day: "2026-10-14" }, { tm: DRILL_TEAM.harrison, day: "2026-10-15" },
        { tm: DRILL_TEAM.james, day: "2026-10-16" },
      ];
      let n = 0;
      const authorised: string[] = [];
      /** A fixture month with one QUEUED request the hub books, on its own creative-day. */
      const queued = async (): Promise<{ f: ContentMonthFixture; id: string }> => {
        const place = places[n];
        const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: `Lease Drill ${++n} TEST`, package: "Accelerator", monthKey: "2026-10", project: false, owner: { email: `lease${n}@realtourpilot.com` } });
        await prisma.client.update({ where: { id: f.clientId }, data: { email: "info@realtourpilot.com", aryeoCustomerId: `0197ffff-0000-4000-8000-${String(n).padStart(12, "0")}` } });
        authorised.push(f.clientId);
        await setSwitch("session_booking", true, { authorizedFixtureClientIds: authorised });
        const plan = await sa.saveSessionPlanAddress({ enrollmentId: f.enrollmentId, monthId: f.monthId, sessionIndex: 1, input: { street: "117 Kyle Lane", unit: "Unit 2", city: "West Chester", state: "PA", zip: "19382" }, by: "drill" });
        if (!plan.ok || !plan.planId) throw new Error(`plan: ${plan.message}`);
        const start = at(place.day, 10);
        const r = await sr.createSessionRequest({
          enrollmentId: f.enrollmentId, monthId: f.monthId,
          slot: { startISO: start.toISOString(), endISO: new Date(start.getTime() + 4 * 60 * MIN).toISOString() },
          actor: { kind: "STAFF", userId: null }, creative: { teamMemberId: place.tm.tm, name: place.tm.name },
          plan: { planId: plan.planId, addressVersion: plan.addressVersion! }, travel: { check: "HUB_DRIVE", evidenceJson: null }, sessionIndex: 1,
        });
        if (!r.ok) throw new Error(`request: ${r.reason}`);
        const row = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: r.id } });
        if (row.bookingState !== "QUEUED") throw new Error(`not queued: ${row.bookingState} ${row.lastError}`);
        return { f, id: r.id };
      };
      const state = async (id: string) => {
        const r = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id }, select: { status: true, bookingState: true, aryeoOrderId: true, aryeoAppointmentId: true, currentAttemptId: true } });
        const a = r.currentAttemptId ? await prisma.programBookingAttempt.findUnique({ where: { id: r.currentAttemptId }, select: { state: true, aryeoOrderId: true, aryeoAppointmentId: true } }) : null;
        const desk = await prisma.smartTask.findUnique({ where: { dedupeKey: `content-session-request-${id}` }, select: { status: true, title: true } });
        return { ...r, attempt: a, deskOpen: desk?.status === "OPEN" ? desk.title : null };
      };
      const committed = (m: string, p: string) => fk.count(m, p, true);
      const HOLD_KEY = { order: "POST /orders", appt: "POST /appointments/store" } as const;
      const READ_KEY = { order: "GET /orders/:id", appt: "GET /appointments/:id" } as const;

      /**
       * A is held inside the provider write `which`; B takes over at +5m1s and
       * +10m1s and settles it; then A wakes — to the answer, or to a timeout.
       * For OLD, the read A makes next is made to fail (three 503s — a GET
       * retries twice), which is what strands the booking; NEW never reaches it.
       */
      const takeover = async (sb: typeof sbNew, which: "order" | "appt", label: "OLD" | "NEW", wakeTo: "answer" | "timeout" = "answer") => {
        const { id } = await queued();
        const inside = door();
        const wake = door();
        fk.script(HOLD_KEY[which], { hold: () => { inside.open(); return wake.wait; }, commit: "before-hold", ...(wakeTo === "timeout" ? { answer: "abort" as const } : {}) });
        const w0 = { o: committed("POST", "/orders"), s: committed("POST", "/appointments/store") };
        const t0 = new Date();
        const a = sb.bookSessionRequest(id, { now: t0, worker: "A" });
        await inside.wait;
        const aCall = await state(id);
        const b1 = await sb.bookSessionRequest(id, { now: new Date(t0.getTime() + 5 * MIN + 1000), worker: "B" });
        const b2 = await sb.bookSessionRequest(id, { now: new Date(t0.getTime() + 10 * MIN + 1000), worker: "B" });
        const settled = await state(id);
        for (let i = 0; i < 3; i++) fk.script(READ_KEY[which], { status: 503, message: "drill: Aryeo is having a moment" });
        wake.open();
        const aOut = await a;
        const unread = fk.clearScripts(READ_KEY[which]);
        const final = await state(id);
        return {
          label, id, aCall, b1, b2, settled, aOut, unread, final,
          orders: committed("POST", "/orders") - w0.o, appts: committed("POST", "/appointments/store") - w0.s,
        };
      };

      for (const [which, wakeTo] of [["order", "answer"], ["appt", "answer"], ["order", "timeout"], ["appt", "timeout"]] as const) {
        const what = which === "order" ? "POST /orders" : "POST /appointments/store";
        const tag = `${wakeTo === "answer" ? (which === "order" ? "1a" : "1c") : which === "order" ? "1d" : "1e"}`;
        c.head(`${tag} · booking: A held inside ${what} (committed), B takes the lease over, A wakes to ${wakeTo === "answer" ? "the answer" : "a TIMEOUT"}`);
        const old = await takeover(sbOld, which, "OLD", wakeTo);
        const sent = which === "order" ? "ORDER_SENT" : "APPT_SENT";
        c.ok(`the shape: A was inside the call with the attempt at ${sent}`, old.aCall.attempt?.state === sent, JSON.stringify(old.aCall.attempt));
        c.ok("B at +5m1s took the lease and waited for its recheck time (no write)", old.b1.outcome === "pending" && /waiting/.test(old.b1.detail), `${old.b1.outcome}: ${old.b1.detail}`);
        c.ok("B at +10m1s found A's write and CONFIRMED the booking", old.b2.outcome === "confirmed" && old.settled.status === "CONFIRMED" && old.settled.attempt?.state === "CONFIRMED", `${old.b2.outcome}: ${old.b2.detail}`);
        const dragged = wakeTo === "timeout" ? (which === "order" ? "UNKNOWN, attempt ORDER_UNKNOWN" : "UNKNOWN, attempt APPT_UNKNOWN") : which === "order" ? "ORDER_CREATED, attempt ORDER_CREATED" : "APPT_PENDING, attempt APPT_CREATED";
        c.ok(`OLD (sessionBooking.ts @ ${BASE}): A's late ${wakeTo} dragged the settled booking back — request CONFIRMED but ${dragged}`,
          old.final.status === "CONFIRMED" && old.final.bookingState !== "SUCCEEDED" && old.final.attempt?.state !== "CONFIRMED",
          `request ${old.final.status}/${old.final.bookingState}, attempt ${old.final.attempt?.state} (A: ${old.aOut.outcome}: ${old.aOut.detail})`);
        await sbOld.driveSessionBookings({});
        const later = await state(old.id);
        c.ok("OLD: …and it stays that way after the next driver tick (it only picks up REQUESTED rows)", later.bookingState === old.final.bookingState && later.attempt?.state === old.final.attempt?.state, `${later.status}/${later.bookingState}, attempt ${later.attempt?.state}`);

        const neu = await takeover(sbNew, which, "NEW", wakeTo);
        c.ok("NEW: the same interleaving (A inside, B waited, then B confirmed)", neu.aCall.attempt?.state === sent && neu.b1.outcome === "pending" && neu.b2.outcome === "confirmed", `${neu.b1.outcome} → ${neu.b2.outcome}`);
        c.ok(`NEW: A's late ${wakeTo} is not written; A stops 'pending', naming the worker that settles it`, neu.aOut.outcome === "pending" && /another worker/.test(neu.aOut.detail), `${neu.aOut.outcome}: ${neu.aOut.detail}`);
        c.ok("NEW: A read nothing after waking (all three scripted reads unused)", neu.unread === 3, `${neu.unread} unused`);
        c.ok("NEW: the booking stays settled — CONFIRMED / SUCCEEDED, attempt CONFIRMED", neu.final.status === "CONFIRMED" && neu.final.bookingState === "SUCCEEDED" && neu.final.attempt?.state === "CONFIRMED", JSON.stringify({ r: [neu.final.status, neu.final.bookingState], a: neu.final.attempt?.state }));
        c.ok("NEW: on A's order — the only order", !!neu.final.aryeoOrderId && neu.final.attempt?.aryeoOrderId === neu.final.aryeoOrderId);
        c.ok("NEW: exactly 1 order and 1 appointment committed at the fake, no desk task", neu.orders === 1 && neu.appts === 1 && !neu.final.deskOpen, `${neu.orders} order · ${neu.appts} appointment · desk ${neu.final.deskOpen ?? "none"}`);
      }

      c.head("1b · booking: A held BEFORE Aryeo commits the order (NEW)");
      {
        const { id } = await queued();
        const inside = door();
        const wake = door();
        fk.script("POST /orders", { hold: () => { inside.open(); return wake.wait; }, commit: "after-hold" });
        const w0 = { o: committed("POST", "/orders"), s: committed("POST", "/appointments/store") };
        const t0 = new Date();
        const a = sbNew.bookSessionRequest(id, { now: t0, worker: "A" });
        await inside.wait;
        // Oct 5 2026: the attempt's createdAt is the database's now() — the REAL
        // clock — while section 1's clock is pinned to Sep 28. The marker-scan
        // schedule (next scan no earlier than createdAt + 35 min) measures from
        // it, so restamp it on the drill's clock: the instant A made it, t0.
        await prisma.programBookingAttempt.updateMany({ where: { requestId: id }, data: { createdAt: t0 } });
        const wB = fk.writes.length; // A's address is already written; its order is not
        const b1 = await sbNew.bookSessionRequest(id, { now: new Date(t0.getTime() + 5 * MIN + 1000), worker: "B" });
        const b2 = await sbNew.bookSessionRequest(id, { now: new Date(t0.getTime() + 10 * MIN + 1000), worker: "B" });
        const mid = await state(id);
        const bWrites = fk.writes.length - wB;
        wake.open();
        const aOut = await a;
        const afterA = await state(id);
        const cOut = await sbNew.bookSessionRequest(id, { now: new Date(t0.getTime() + 40 * MIN), worker: "C" });
        const final = await state(id);
        c.ok("B's marker scan found nothing and B wrote nothing to Aryeo (the order was not made yet)", b1.outcome === "pending" && b2.outcome === "pending" && /marker scan 1/.test(b2.detail) && bWrites === 0, `${b1.detail} · ${b2.detail} · ${bWrites} writes`);
        c.ok("the request waits, ORDER_SENT, for the next scan — not the desk", mid.attempt?.state === "ORDER_SENT" && !mid.deskOpen, JSON.stringify(mid.attempt));
        c.ok("A's late ORDER_CREATED lands (nobody had moved the attempt on)", afterA.attempt?.state === "ORDER_CREATED" && !!afterA.attempt?.aryeoOrderId, JSON.stringify(afterA.attempt));
        c.ok("…and A stops at the lease check, before the appointment write", aOut.outcome === "pending" && /before the appointment write/.test(aOut.detail), `${aOut.outcome}: ${aOut.detail}`);
        c.ok("the next tick confirms on A's order", cOut.outcome === "confirmed" && final.status === "CONFIRMED" && final.attempt?.state === "CONFIRMED" && final.aryeoOrderId === afterA.attempt?.aryeoOrderId, `${cOut.outcome}: ${cOut.detail}`);
        c.ok("exactly 1 order and 1 appointment committed, no desk task", committed("POST", "/orders") - w0.o === 1 && committed("POST", "/appointments/store") - w0.s === 1 && !final.deskOpen);
      }
      await prisma.programAutomation.deleteMany({ where: { key: "session_booking" } });
    } finally {
      globalThis.Date = RealDate;
    }

    // ======================================================================
    c.head(`2 · Topaz: two ticks (one a child process) over a 100-credit cap, ${ITER} times`);
    // ======================================================================
    {
      const tj = await import("@/lib/topazJobs");
      const client = await prisma.client.create({ data: { name: "Topaz Drill TEST" }, select: { id: true } });
      const project = await prisma.project.create({ data: { title: "1 Drill Way, West Chester, PA", status: "REVIEW", clientId: client.id }, select: { id: true } });
      let seqJob = 0;
      const job = async (credits: number) => {
        const id = `lease-job-${++seqJob}`;
        const sub = await prisma.reviewSubmission.create({
          data: { projectId: project.id, kind: "video", round: 1, status: "APPROVED", source: "upload", fileName: `${id}.mp4`, blobUrl: "https://drill.invalid/source.mp4", sizeBytes: 12_000_000 },
          select: { id: true },
        });
        await prisma.topazJob.create({ data: { id, projectId: project.id, submissionId: sub.id, state: "estimated", requestId: `req-${id}`, estimateCredits: credits, sourceSizeBytes: 12_000_000 } });
        return id;
      };
      // Retire an iteration: its renders fall out of this month's caps and out of the lane.
      const retire = (ids: string[]) =>
        prisma.topazJob.updateMany({ where: { id: { in: ids } }, data: { state: "skipped", acceptedAt: new Date("2026-08-15T12:00:00Z"), leaseBy: null, leaseUntil: null } });
      // Drill-only: the reservation holds the budget lock for 80 ms, so the other
      // tick's reservation queues on it long enough for the server to log it.
      await drill.sql(`CREATE FUNCTION drill_slow_reserve() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."acceptedAt" IS NULL AND NEW."acceptedAt" IS NOT NULL THEN PERFORM pg_sleep(0.08); END IF; RETURN NEW; END $$`);
      await drill.sql(`CREATE TRIGGER drill_slow_reserve_t BEFORE UPDATE ON "TopazJob" FOR EACH ROW EXECUTE FUNCTION drill_slow_reserve()`);
      const kid = drill.runChild(__filename, { args: ["topaz-tick"] });
      await kid.waitFor(has("ready"), 180_000);
      const waits0 = drill.lockWaits();
      const bad: string[] = [];
      let maxBackends = 0;
      let childAccepts = 0;
      for (let k = 1; k <= ITER; k++) {
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) ids.push(await job(30));
        const here0 = topaz.accept;
        const { result, distinctBackends } = await drill.backendsDuring(async () => {
          kid.send({ run: k });
          const mine = await tj.claimTopazJobs(3, `tick-here-${k}`);
          const states: string[] = [];
          for (const id of mine) states.push(await tj.advanceTopazJob(id));
          const theirs = await kid.waitFor<{ claimed: string[]; states: string[]; accepts: number }>((m) => (m as { run?: number } | null)?.run === k && has("claimed")(m), 120_000);
          return { mine, states, theirs };
        });
        maxBackends = Math.max(maxBackends, distinctBackends);
        const accepts = topaz.accept - here0 + (result.theirs.accepts - childAccepts);
        childAccepts = result.theirs.accepts;
        const rows = await prisma.topazJob.findMany({ where: { id: { in: ids } }, select: { state: true, acceptedAt: true, estimateCredits: true } });
        const accepted = rows.filter((r) => r.acceptedAt);
        const credits = accepted.reduce((s, r) => s + (r.estimateCredits ?? 0), 0);
        const disjoint = result.mine.every((id) => !result.theirs.claimed.includes(id));
        const good = credits <= 100 && accepted.length === 3 && accepts === 3 && disjoint && result.mine.length + result.theirs.claimed.length === 6 &&
          rows.filter((r) => r.state === "uploading").length === 3;
        if (!good) bad.push(`#${k}: ${accepted.length} accepted = ${credits} credits · ${accepts} accepts · here ${result.mine.length} ${result.states.join("/")} · child ${result.theirs.claimed.length} ${result.theirs.states.join("/")}`);
        await retire(ids);
      }
      kid.send({ exit: true });
      await settle();
      await drill.sql(`DROP TRIGGER drill_slow_reserve_t ON "TopazJob"`);
      c.ok("non-vacuous: two processes, several backends at once", maxBackends >= 2, `peak ${maxBackends}`);
      c.ok("non-vacuous: the budget lock was contended — waits the SERVER logged", drill.lockWaits() - waits0 >= 1, `${drill.lockWaits() - waits0} logged`);
      c.ok("committed credits never passed the 100 cap; exactly three renders accepted, three accepts, each job claimed by one tick — every time", bad.length === 0, bad.slice(0, 2).join(" · ") || `${ITER}/${ITER}`);

      c.head("2b · Topaz: the lease expires while Topaz holds the accept");
      {
        const x = await job(30);
        const inside = door();
        const wake = door();
        acceptHold = () => { inside.open(); return wake.wait; };
        const a0 = topaz.accept, s0 = topaz.status, c0 = topaz.cancelEstimate + topaz.cancelRequest;
        const [claimA] = await tj.claimTopazJobs(1, "tick-A");
        const a = tj.advanceTopazJob(claimA);
        await inside.wait;
        const reserved = await prisma.topazJob.findUniqueOrThrow({ where: { id: x }, select: { acceptedAt: true, leaseBy: true } });
        await drill.sql(`UPDATE "TopazJob" SET "leaseUntil" = now() - interval '1 minute' WHERE id = $1`, [x]);
        const [claimB] = await tj.claimTopazJobs(1, "tick-B");
        const bOut = await tj.advanceTopazJob(claimB);
        const afterB = await prisma.topazJob.findUniqueOrThrow({ where: { id: x }, select: { state: true, acceptedAt: true, uploadUrlsJson: true } });
        wake.open();
        const aOut = await a;
        const final = await prisma.topazJob.findUniqueOrThrow({ where: { id: x }, select: { state: true, acceptedAt: true, uploadUrlsJson: true, leaseBy: true } });
        const credits = await prisma.topazJob.aggregate({ where: { id: x, acceptedAt: { not: null } }, _sum: { estimateCredits: true } });
        c.ok("the shape: tick A reserved the slot and was inside Topaz's accept", claimA === x && !!reserved.acceptedAt && reserved.leaseBy === "tick-A");
        c.ok("tick B took the expired lease, ASKED Topaz what happened, and moved the job on", claimB === x && bOut === "uploading" && topaz.status - s0 === 1, `${bOut} · ${topaz.status - s0} status read`);
        c.ok("…on the SAME reservation: acceptedAt untouched, credits counted once", afterB.acceptedAt?.getTime() === reserved.acceptedAt?.getTime() && credits._sum.estimateCredits === 30);
        c.ok("A woke: its holdLease returned false, so it wrote nothing and returned the state it read", aOut === "estimated" && final.state === "uploading", `A returned ${aOut}; row ${final.state}`);
        const aUrl = `/put/${process.pid}/${a0 + 1}"`;
        const bUrl = `/put/${process.pid}/${a0 + 2}"`;
        c.ok("the stored upload targets are B's; A's were never written", final.uploadUrlsJson === afterB.uploadUrlsJson && (final.uploadUrlsJson ?? "").includes(bUrl) && !(final.uploadUrlsJson ?? "").includes(aUrl), final.uploadUrlsJson ?? "");
        c.ok("two accept calls (A's, then B's for fresh upload URLs — accept is free and starts nothing), no cancel of the paid slot", topaz.accept - a0 === 2 && topaz.cancelEstimate + topaz.cancelRequest === c0, `${topaz.accept - a0} accepts · ${topaz.cancelEstimate + topaz.cancelRequest - c0} cancels`);
        await retire([x]);
      }
    }

    // ======================================================================
    // 3 · AI RUN ZOMBIE — and 4 · CRASH (the representative month)
    // ======================================================================
    const fx = await import("../_fixtures/representativeMonth");
    const { etMonthKey } = await import("@/lib/contentProgram");
    const ct = await import("@/lib/contentTopics");
    const gen = await import("@/lib/contentGeneration");
    const { draftOwedScriptsForMonth } = await import("@/lib/contentDrafting");
    const { LeaseLostError } = await import("@/lib/aiRuns");
    aiRunsOld = (await import(oldCopy("src/lib/aiRuns.ts", tmp))) as Record<string | symbol, unknown>;
    const shell = await fx.createTestClientShell(prisma as unknown as PrismaClient, { name: "Lease Journey TEST", slug: "leasejourney" });
    const seed = await fx.seedRepresentativeMonth(prisma as unknown as PrismaClient, { clientId: shell.clientId, monthKey: etMonthKey(new Date()), tier: "full", variant: "pro" });
    // Room for every topic this drill owes (the allowance is the office's to raise, §3).
    await prisma.contentMonth.update({ where: { id: seed.monthId }, data: { videosOwed: { increment: 10 } } });
    const owe = async (title: string) => {
      const t = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: seed.enrollmentId, title }, select: { id: true } });
      await ct.selectTopicForMonth(t.id, seed.monthId, { source: "call", actor: { kind: "STAFF", staffUserId: null }, callRecordId: seed.callRecordId, status: "SELECTED", evidence: { excerpts: [{ speaker: "client", source: "call", text: `I want to talk about ${title.toLowerCase()}.` }] } });
      return t.id;
    };
    const versionsFor = async (topicId: string) => {
      const scripts = await prisma.contentScript.findMany({ where: { topicId }, select: { id: true } });
      return { scripts: scripts.length, versions: await prisma.contentScriptVersion.count({ where: { scriptId: { in: scripts.map((s) => s.id) } } }) };
    };
    const runsFor = (topicId: string) => prisma.programAiRun.findMany({ where: { kind: "script_draft", scopeJson: { contains: topicId } }, orderBy: { startedAt: "asc" }, select: { id: true, status: true, error: true, costCents: true, requestedBy: true, outputJson: true, outputRef: true } });
    const backdate = () => drill.sql(`UPDATE "ProgramAiRun" SET "leaseUntil" = now() - interval '1 minute' WHERE status = 'RUNNING'`);

    /** A is held inside the model; its lease runs out; B drafts the same topic; A wakes. */
    const zombie = async (topicId: string, old: boolean) => {
      useOldAiRuns = old;
      const inside = door();
      const wake = door();
      onDraft = () => { inside.open(); return wake.wait; };
      const a = gen.generateScriptForTopic({ topicId, monthId: seed.monthId, requestedBy: "staff-a", unattended: false }).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
      await inside.wait;
      await backdate();
      const b = await gen.generateScriptForTopic({ topicId, monthId: seed.monthId, requestedBy: "staff-b", unattended: false });
      wake.open();
      const aOut = await a;
      useOldAiRuns = false;
      return { aOut, b, v: await versionsFor(topicId), runs: await runsFor(topicId) };
    };

    c.head("3 · AI run: A held in the model past its lease, B drafts the same topic");
    {
      const old = await zombie(await owe("Why the list price is a marketing decision"), true);
      const aRun = old.runs.find((r) => r.requestedBy === "staff-a");
      c.ok(`OLD (aiRuns.ts @ ${BASE}): A's late answer flipped its expired run back to SUCCEEDED`, aRun?.status === "SUCCEEDED", JSON.stringify(old.runs.map((r) => [r.requestedBy, r.status])));
      c.ok("OLD: two SUCCEEDED runs for one topic's draft", old.runs.filter((r) => r.status === "SUCCEEDED").length === 2);
      c.ok("OLD: and A added a SECOND version to the script B had just drafted", old.aOut.ok && old.v.scripts === 1 && old.v.versions === 2, JSON.stringify(old.v));

      const neu = await zombie(await owe("How spring inventory changes your pricing"), false);
      const aNew = neu.runs.find((r) => r.requestedBy === "staff-a");
      c.ok("NEW: A throws LeaseLostError", !neu.aOut.ok && neu.aOut.e instanceof LeaseLostError, neu.aOut.ok ? "A succeeded!" : errText(neu.aOut.e));
      c.ok("NEW: A's run stays FAILED, with what it cost and what it said kept on it", aNew?.status === "FAILED" && (aNew.costCents ?? 0) > 0 && !!aNew.outputJson && /after its lease expired/.test(aNew.error ?? ""), JSON.stringify(aNew && { s: aNew.status, cost: aNew.costCents, err: aNew.error }));
      c.ok("NEW: exactly one SUCCEEDED run (B's) for the topic", neu.runs.filter((r) => r.status === "SUCCEEDED").length === 1 && neu.runs.find((r) => r.status === "SUCCEEDED")?.requestedBy === "staff-b");
      c.ok("NEW: one script, ONE version", neu.v.scripts === 1 && neu.v.versions === 1, JSON.stringify(neu.v));
    }

    // 3a · THE SAME, ONE STEP LATER (review, Sep 28). R04 fenced RUNNING →
    // SUCCEEDED, but a holdDedupeKey run sits SUCCEEDED with its key held until
    // its caller writes the version. A frozen in THAT gap past the lease: the
    // next caller's cleanup freed A's key, B drafted, and A woke to write a
    // second version onto B's script. claimRunWrite fences the write too.
    const zombieAfterAnswer = async (topicId: string, old: boolean) => {
      useOldAiRuns = old;
      const answered = door();
      const wake = door();
      afterRun = () => { answered.open(); return wake.wait; };
      const a = gen.generateScriptForTopic({ topicId, monthId: seed.monthId, requestedBy: "staff-a", unattended: false }).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
      await answered.wait;
      const aHeld = await prisma.programAiRun.findFirst({ where: { requestedBy: "staff-a", scopeJson: { contains: topicId } }, select: { status: true, dedupeKey: true } });
      await drill.sql(`UPDATE "ProgramAiRun" SET "leaseUntil" = now() - interval '1 minute' WHERE status = 'SUCCEEDED' AND "dedupeKey" IS NOT NULL`);
      const b = await gen.generateScriptForTopic({ topicId, monthId: seed.monthId, requestedBy: "staff-b", unattended: false });
      wake.open();
      const aOut = await a;
      useOldAiRuns = false;
      return { aHeld, aOut, b, v: await versionsFor(topicId), runs: await runsFor(topicId) };
    };
    c.head("3a · AI run: A frozen AFTER the model answered (SUCCEEDED, key held) past its lease, B drafts the same topic");
    {
      const old = await zombieAfterAnswer(await owe("What a price cut costs you after week two"), true);
      c.ok("A was held with its run SUCCEEDED and its dedupe key still held", old.aHeld?.status === "SUCCEEDED" && !!old.aHeld.dedupeKey, JSON.stringify(old.aHeld));
      c.ok(`OLD (aiRuns.ts @ ${BASE}, no write fence): A wrote a SECOND version onto the script B had just drafted`, old.aOut.ok && old.v.scripts === 1 && old.v.versions === 2, JSON.stringify(old.v));
      const neu = await zombieAfterAnswer(await owe("What rates are doing to move-up buyers"), false);
      const aRun = neu.runs.find((r) => r.requestedBy === "staff-a");
      const bRun = neu.runs.find((r) => r.requestedBy === "staff-b");
      c.ok("NEW: A throws LeaseLostError at the write", !neu.aOut.ok && neu.aOut.e instanceof LeaseLostError, neu.aOut.ok ? "A succeeded!" : errText(neu.aOut.e));
      c.ok("NEW: one script, ONE version — B's", neu.v.scripts === 1 && neu.v.versions === 1 && !!bRun?.outputRef, JSON.stringify(neu.v));
      c.ok("NEW: A's run keeps its paid output but points at nothing (never applied)", aRun?.status === "SUCCEEDED" && !!aRun.outputJson && !aRun.outputRef, JSON.stringify(aRun && { s: aRun.status, ref: aRun.outputRef }));
    }

    c.head("3b · the owed-script sweep: a zombie run is counted as raced, never as a failure (NEW)");
    {
      await setSwitch("ai_runs", true);
      const t2 = await owe("Reading a comparable sale like an appraiser");
      const inside = door();
      const wake = door();
      onDraft = () => { inside.open(); return wake.wait; };
      const a = draftOwedScriptsForMonth(seed.monthId, { requestedBy: "cron-a", unattended: true });
      await inside.wait;
      await backdate();
      const b = await draftOwedScriptsForMonth(seed.monthId, { requestedBy: "cron-b", unattended: true });
      wake.open();
      const aRes = await a;
      const runs = await runsFor(t2);
      const aOutcome = aRes.outcomes.find((o) => o.topicId === t2);
      c.ok("the second sweep drafted the topic", b.outcomes.find((o) => o.topicId === t2)?.result === "drafted", JSON.stringify(b.outcomes.map((o) => [o.title, o.result])));
      c.ok("the first sweep reports it SKIPPED (raced), not failed", aOutcome?.result === "skipped" && aRes.failed === 0, JSON.stringify(aOutcome));
      c.ok("one version; one SUCCEEDED run, the zombie FAILED with its cost", (await versionsFor(t2)).versions === 1 && runs.filter((r) => r.status === "SUCCEEDED").length === 1 && runs.filter((r) => r.status === "FAILED" && (r.costCents ?? 0) > 0).length === 1, JSON.stringify(runs.map((r) => [r.requestedBy, r.status, r.costCents])));
      c.ok("no desk task for a failed draft", (await prisma.smartTask.count({ where: { status: "OPEN", title: { contains: "Reading a comparable sale" } } })) === 0);
    }

    c.head("4 · crash: the sweep SIGKILLed inside the model in a child process, then reclaimed once");
    {
      const t3 = await owe("When a bidding war is not a good sign");
      const kid = drill.runChild(__filename, { args: ["draft-and-die"] });
      kid.send({ monthId: seed.monthId });
      const inModel = await kid.waitFor<{ pid: number }>(has("inModel"), 180_000);
      const exit = await kid.exited;
      let idle = await drill.idleInTransaction();
      for (const until = Date.now() + 2000; idle > 0 && Date.now() < until; ) { await new Promise((r) => setTimeout(r, 20)); idle = await drill.idleInTransaction(); }
      const held = await prisma.programAiRun.findMany({ where: { status: "RUNNING" }, select: { kind: true, leaseUntil: true, dedupeKey: true, scopeJson: true } });
      c.ok("the child died by SIGKILL inside the model", exit.signal === "SIGKILL" && inModel.pid > 0 && !kid.messages.some(has("finished")), JSON.stringify(exit));
      c.ok("the server ended its session: nothing left idle in a transaction", idle === 0, `${idle}`);
      c.ok("…leaving one RUNNING draft run for the topic, holding its lease and dedupe key", held.length === 1 && !!held[0].dedupeKey && (held[0].leaseUntil?.getTime() ?? 0) > Date.now() && (held[0].scopeJson ?? "").includes(t3), JSON.stringify(held));
      const r1 = await draftOwedScriptsForMonth(seed.monthId, { requestedBy: "cron", unattended: true });
      c.ok("a sweep while the lease holds does NOT draft over it (skipped as raced)", r1.outcomes.find((o) => o.topicId === t3)?.result === "skipped" && (await versionsFor(t3)).scripts === 0, JSON.stringify(r1.outcomes.map((o) => [o.title, o.result])));
      await backdate();
      const r2 = await draftOwedScriptsForMonth(seed.monthId, { requestedBy: "cron", unattended: true });
      const runs = await runsFor(t3);
      c.ok("with the lease run out, the next sweep drafts it", r2.outcomes.find((o) => o.topicId === t3)?.result === "drafted", JSON.stringify(r2.outcomes.map((o) => [o.title, o.result])));
      c.ok("…exactly once: one script, one version", JSON.stringify(await versionsFor(t3)) === JSON.stringify({ scripts: 1, versions: 1 }));
      c.ok("the dead run is FAILED (lease expired), one SUCCEEDED, none RUNNING", runs.filter((r) => r.status === "FAILED" && /Lease expired/.test(r.error ?? "")).length === 1 && runs.filter((r) => r.status === "SUCCEEDED").length === 1 && !runs.some((r) => r.status === "RUNNING"), JSON.stringify(runs.map((r) => [r.status, (r.error ?? "").slice(0, 30)])));
      const r3 = await draftOwedScriptsForMonth(seed.monthId, { requestedBy: "cron", unattended: true });
      c.ok("one more sweep drafts nothing more", !r3.outcomes.some((o) => o.topicId === t3 && o.result === "drafted") && (await versionsFor(t3)).versions === 1);
    }

    c.head("5 · nothing left the machine");
    c.ok("0 attempts to reach anything but the fakes, in any process", fence!.blocked.length === 0, fence!.blocked.slice(0, 5).join(", ") || "none");
    c.ok("the database was this drill's own", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/drill?`));
    console.log(`\n    ${await drill.evidence()} · model calls=${draftCalls} (fake)`);
    console.log(`    (${quiet.count} expected prisma:error log lines suppressed in this process)`);
  } finally {
    quiet.restore();
    c.summary();
    await drill.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}

(ROLE ? childMain(ROLE) : main()).catch((e) => { console.error(e); process.exit(1); });
