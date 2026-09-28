// ---------------------------------------------------------------------------
// DRILL: THE HARNESS PROVES ITSELF (batch A, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/harness-selftest.ts
//
// Two things every earlier drill had to write down as "not proven", because
// PGlite's socket server died on the first unique violation:
//
//   · a genuine race on a unique key — the database, not the application,
//     choosing the winner, with the loser getting P2002 and carrying on;
//   · the HOURLY CRON ROUTE ITSELF — GET /api/cron/sync, bearer token and all,
//     executing its whole step list against a database, not the one step a
//     drill could safely lift out of it.
//
// Both are proven here, on the patched server in _harness.ts, after the OLD
// behaviour is shown on the stock one. Port 5500 only.
//
// WHAT IS ASSERTED, IN ORDER:
//   0. PGlite itself answers an Execute that hit 23505 with ErrorResponse AND
//      ReadyForQuery — the premature 'Z' that desynchronises the client.
//   1. OLD: through the stock PGLiteSocketServer, the next query after a unique
//      violation fails with "Server has closed the connection" (P1017).
//   2. NEW (a): through the harness, P2002 reaches the caller and the very
//      next query on the same client succeeds.
//   3. NEW (b): two — then eight — concurrent inserts on one unique key: one
//      wins, every loser gets P2002, and every pooled connection still works.
//   4. NEW (c): the real cron GET runs end to end — every step reports, the
//      scriptDrafting step drafts a ContentScriptVersion for the fixture
//      month, the CronRun row is finished, and nothing left the machine.
//  4b. The same GET again with every provider holding a (fake) credential, so
//      the provider steps really reach for the network and fail at the fence
//      as an outage would — and the second tick's dedupe keys collide with the
//      first's, the exact collision that killed the Sep 23 attempt.
//
// ISOLATION. PGlite in-process, DATABASE_URL pinned to 127.0.0.1 before any
// Prisma client exists, every .env secret blanked, fetch AND raw sockets fenced
// to loopback. The model is stubbed at aiJsonWithUsage only.
//
// ---------------------------------------------------------------------------
// POSTGRES MODE (R04, Sep 28 2026):
//
//   DRILL_ENGINE=postgres NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/harness-selftest.ts
//
// proves the real-Postgres engine instead (ports 5873, and 5874 for the PGlite
// control and the orphan). Needs `npm install --prefix tools/realpg` once.
// The six checks the R04 design asked for, each after the PGlite behaviour it
// replaces where that can be shown:
//   A. two Prisma sessions report different pg_backend_pid() (PGlite: the same);
//   B. lockAdvisory in B blocks until A commits — Postgres itself reports the
//      wait (pg_locks, then its lock-wait log line) and B locks only after A;
//   C. a 23505 leaves the pool usable: SELECT 1 answers on every connection;
//   D. a child process SIGKILLed inside a transaction leaves no session idle in
//      a transaction within 1 s, and its lock and uncommitted row go with it;
//   E. 0 non-loopback sockets: the server listens on 127.0.0.1 only, every
//      session came from there, lsof agrees, and the child's fence reports into
//      the parent's;
//   F. stop() frees the port and removes the directory; a re-boot on it works.
// And, because the harness depends on them: a unique-key race between two
// PROCESSES where the loser waits on the winner's uncommitted row, and the
// reaper that clears a cluster orphaned by a SIGKILLed drill.
// ---------------------------------------------------------------------------
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertLoopbackDbUrl, attachDrillChild, bootDrillDb, bootRealPostgres, DrillSocketServer, fenceFetch, installNextStubs, interceptModule,
  makeChecker, pinDrillEnv, portFree, PRODUCTION_PG_MAJOR, quietPrismaErrors, resolveDrillEngine,
} from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { barrier } from "../_fixtures/barrier";

const ENGINE = resolveDrillEngine();
const PORT = Number(process.env.DRILL_PORT ?? (ENGINE === "postgres" ? 5873 : 5500));
const c = makeChecker();
installNextStubs();
const fence = fenceFetch();

// ---- the model boundary: the tokens are fake, everything around them is real
let aiCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { prompt: string }) => {
        aiCalls++;
        const title = (/TOPIC:\s*(.+)/.exec(opts.prompt)?.[1] ?? "Drafted topic").trim().slice(0, 90);
        return {
          result: {
            title,
            category: "Market Authority",
            hook: "The first weekend is the whole negotiation.",
            points: [
              { role: "PROOF", text: "Every listing that sat past the first weekend sold for less." },
              { role: "CONTEXT", text: "Buyers read days on market as a discount signal." },
              { role: "ACTION", text: "Price it right before the photos go live." },
            ],
            close: "That is why the first weekend decides your price.",
            captionCta: "DM me the word PRICE.",
            filmingNotes: null,
            gaps: [],
          },
          usage: { inputTokens: 1200, outputTokens: 400 },
          model: "drill-stub",
        };
      };
    },
  }),
);

// ---- wire-protocol helpers for section 0 -----------------------------------
const enc = new TextEncoder();
const cstr = (s: string) => [...enc.encode(s), 0];
const i16 = (n: number) => [(n >> 8) & 255, n & 255];
const i32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const frame = (type: string, body: number[]) => Uint8Array.from([type.charCodeAt(0), ...i32(body.length + 4), ...body]);
const types = (reply: Uint8Array) => {
  const out: string[] = [];
  const v = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  for (let at = 0; at + 5 <= reply.length; at += 1 + v.getInt32(at + 1)) out.push(String.fromCharCode(reply[at]));
  return out;
};
const errCode = (e: unknown) => (e as { code?: string })?.code ?? String(e).slice(0, 80);

async function main() {
  c.head("0 · what PGlite puts on the wire when an Execute hits a unique key");
  {
    const raw = await PGlite.create();
    await raw.exec("CREATE TABLE k (v text UNIQUE); INSERT INTO k VALUES ('a');");
    const sql = "INSERT INTO k VALUES ('a')";
    const send = async (m: Uint8Array) => types(await raw.execProtocolRaw(m));
    const parse = await send(frame("P", [...cstr(""), ...cstr(sql), ...i16(0)]));
    const bind = await send(frame("B", [...cstr(""), ...cstr(""), ...i16(0), ...i16(0), ...i16(0)]));
    const execute = await send(frame("E", [...cstr(""), ...i32(0)]));
    const sync = await send(frame("S", []));
    c.ok("Parse and Bind are acknowledged normally", parse.join() === "1" && bind.join() === "2", `${parse} / ${bind}`);
    c.ok("OLD: the Execute reply is ErrorResponse followed by ReadyForQuery", execute.join() === "E,Z", execute.join());
    c.ok("and the Sync that follows sends a SECOND ReadyForQuery — Postgres sends only this one", sync.join() === "Z", sync.join());
    const ok = types(await raw.execProtocolRaw(frame("Q", cstr("SELECT count(*) FROM k"))));
    c.ok("the in-process session itself is fine afterwards — the fault is on the wire", ok.includes("D") && ok[ok.length - 1] === "Z", ok.join());
    await raw.close();
  }

  // Pin before ANY Prisma client exists: constructing one loads .env, and an
  // unpinned DATABASE_URL would be filled with production's.
  const url = pinDrillEnv(PORT);

  c.head("1 · OLD: the stock socket server, one unique violation, then nothing");
  {
    const db = await PGlite.create();
    const stock = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
    await stock.start();
    const p = new PrismaClient({ datasources: { db: { url } } });
    await p.$executeRawUnsafe("CREATE TABLE k (v text UNIQUE)");
    await p.$executeRawUnsafe("INSERT INTO k VALUES ('a')");
    const dup = await p.$executeRawUnsafe("INSERT INTO k VALUES ('a')").then(() => "no error", errCode);
    c.ok("the duplicate is refused (raw query → P2010 carrying 23505)", dup === "P2010", dup);
    const next = await p.$queryRawUnsafe("SELECT 1").then(() => "ok", errCode);
    c.ok("OLD: the very next query fails — P1017, server has closed the connection", next === "P1017", next);
    await p.$disconnect();
    await stock.stop();
    await db.close();
  }

  const t0 = Date.now();
  const { server, stop } = await bootDrillDb({ port: PORT });
  console.log(`    schema pushed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const { prisma } = await import("@/lib/prisma");
  // Every deliberate violation below would otherwise print Prisma's stack.
  const quiet = quietPrismaErrors();

  c.head("2 · NEW (a): a unique violation reaches the caller and the client carries on");
  const aiRun = (key: string, n = 0) =>
    prisma.programAiRun.create({ data: { kind: "script_draft", promptKey: "script", requestedBy: `racer-${n}`, status: "RUNNING", dedupeKey: key } });
  await aiRun("selftest:a");
  const strippedBefore = server.patchStats.strippedReady;
  const dupA = await aiRun("selftest:a").then(() => "no error", errCode);
  c.ok("the second insert of the same dedupeKey raises P2002", dupA === "P2002", dupA);
  const after = await prisma.programAiRun.count({ where: { dedupeKey: "selftest:a" } }).then((n) => n, errCode);
  c.ok("the very next query on the same client succeeds", after === 1, String(after));
  c.ok("the patch did it: the premature ReadyForQuery was stripped", server.patchStats.strippedReady > strippedBefore, JSON.stringify(server.patchStats));
  const bad = await prisma.$queryRawUnsafe("SELEC 1").then(() => "no error", errCode);
  const afterBad = await prisma.$queryRawUnsafe<{ n: number }[]>("SELECT 2::int AS n").then((r) => r[0]?.n, errCode);
  c.ok("a failed Parse (syntax error) is survived too", bad === "P2010" && afterBad === 2, `${bad} then ${afterBad}`);
  c.ok("and the Describe queued behind it was discarded, as Postgres does", server.patchStats.discardedAfterError >= 1, JSON.stringify(server.patchStats));
  const txErr = await prisma.$transaction(async (tx) => {
    await tx.programAiRun.create({ data: { kind: "script_draft", promptKey: "script", requestedBy: "tx", dedupeKey: "selftest:tx" } });
    await tx.programAiRun.create({ data: { kind: "script_draft", promptKey: "script", requestedBy: "tx", dedupeKey: "selftest:a" } });
  }).then(() => "no error", errCode);
  const txLeft = await prisma.programAiRun.count({ where: { dedupeKey: "selftest:tx" } });
  c.ok("a violation inside a transaction rolls the whole transaction back", txErr === "P2002" && txLeft === 0, `${txErr}, ${txLeft} left`);

  c.head("3 · NEW (b): a real race on one unique key");
  const pair = await Promise.allSettled([aiRun("selftest:race", 1), aiRun("selftest:race", 2)]);
  const won = pair.filter((r) => r.status === "fulfilled").length;
  const lost = pair.filter((r) => r.status === "rejected").map((r) => errCode((r as PromiseRejectedResult).reason));
  c.ok("two concurrent inserts: exactly one wins", won === 1, `${won} won`);
  c.ok("and the loser gets P2002 — the database chose, not the code", lost.length === 1 && lost[0] === "P2002", lost.join());
  const eight = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => aiRun("selftest:race8", i + 1)));
  const won8 = eight.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ requestedBy: string }>[];
  const lost8 = eight.filter((r) => r.status === "rejected").map((r) => errCode((r as PromiseRejectedResult).reason));
  c.ok("eight concurrent inserts: exactly one wins", won8.length === 1, `${won8.length} won`);
  c.ok("seven losers, every one P2002", lost8.length === 7 && lost8.every((x) => x === "P2002"), lost8.join());
  const row8 = await prisma.programAiRun.findMany({ where: { dedupeKey: "selftest:race8" }, select: { requestedBy: true } });
  c.ok("the stored row is the winner's own", row8.length === 1 && row8[0].requestedBy === won8[0]?.value.requestedBy, JSON.stringify(row8));
  c.ok("the race really spread over several connections", server.getStats().activeConnections >= 2, JSON.stringify(server.getStats()));
  const poolCheck = await Promise.allSettled(Array.from({ length: 12 }, () => prisma.programAiRun.count()));
  c.ok("every pooled connection still answers afterwards", poolCheck.every((r) => r.status === "fulfilled"), poolCheck.map((r) => r.status).join(","));

  c.head("4 · NEW (c): the hourly cron route, run for real");
  const setSwitch = (key: string) =>
    prisma.programAutomation.upsert({
      where: { key },
      create: { key, enabled: true, enabledBy: "drill", enabledAt: new Date() },
      update: { enabled: true, enabledBy: "drill", enabledAt: new Date() },
    });
  await setSwitch("script_drafting");
  await setSwitch("ai_runs");
  const f = await buildContentMonth(prisma, {
    name: "Cron Shell TEST",
    package: "Pro",
    monthKey: "2026-10",
    topics: [
      {
        title: "Why the first weekend decides your price",
        selection: "RECONCILED",
        excerpts: [
          "Every listing I have taken that sat past the first weekend ended up selling for less than the one that went in priced right.",
          "I tell sellers the first weekend is the whole negotiation, and they never believe me until they live it.",
        ],
      },
      { title: "A month in this market, in one minute", selection: "SELECTED" },
    ],
  });
  const fx = await prisma.contentEnrollment.findUnique({ where: { id: f.enrollmentId }, select: { videosPerMonth: true, sessionsPerMonth: true, package: true } });
  c.ok("the fixture is a Pro month: 8 videos, 2 sessions", fx?.package === "Pro" && fx.videosPerMonth === 8 && fx.sessionsPerMonth === 2, JSON.stringify(fx));
  const versionsBefore = await prisma.contentScriptVersion.count();
  const aiBefore = aiCalls;

  const { GET } = await import("@/app/api/cron/sync/route");
  const { NextRequest } = await import("next/server");
  const started = Date.now();
  const res = await GET(new NextRequest("http://127.0.0.1/api/cron/sync", { headers: { authorization: "Bearer drill-secret" } }));
  const wall = Date.now() - started;
  const body = (await res.json()) as Record<string, unknown>;
  const ms = (body.ms ?? {}) as Record<string, number>;
  const steps = Object.keys(ms);
  const errored = Object.keys(body).filter((k) => k.endsWith("Error")).map((k) => `${k.slice(0, -5)}: ${String(body[k]).slice(0, 90)}`);
  const skipped = (body.skipped ?? []) as string[];
  const timedOut = (body.timedOut ?? []) as string[];
  console.log(`    route returned ${res.status} in ${(wall / 1000).toFixed(1)}s · ${steps.length} steps ran`);
  console.log(`    slowest: ${Object.entries(ms).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}ms`).join(", ")}`);
  console.log(`    errored (${errored.length}):${errored.length ? "\n      " + errored.join("\n      ") : " none"}`);
  console.log(`    skipped: ${skipped.join(", ") || "none"} · timed out: ${timedOut.join(", ") || "none"}`);

  c.ok("the route answered 200 with ok:true", res.status === 200 && body.ok === true, `${res.status}`);
  c.ok("every step reported — none skipped for budget", skipped.length === 0 && steps.length >= 30, `${steps.length} steps, skipped: ${skipped.join(",") || "none"}`);
  c.ok("no step hung to its cap", timedOut.length === 0, timedOut.join(",") || "none");
  c.ok("the run finished well inside the 250 s budget", wall < 120_000, `${(wall / 1000).toFixed(1)}s`);
  const sd = body.scriptDrafting as { plans?: unknown; drafts?: { drafted?: number; failed?: number } } | undefined;
  c.ok("the scriptDrafting step ran without error", !!sd && !("scriptDraftingError" in body), JSON.stringify(sd ?? body.scriptDraftingError).slice(0, 160));
  c.ok("and it drafted", (sd?.drafts?.drafted ?? 0) >= 1 && sd?.drafts?.failed === 0, JSON.stringify(sd?.drafts).slice(0, 160));
  const versions = await prisma.contentScriptVersion.findMany({ where: { clientId: f.clientId }, select: { status: true, body: true, scriptId: true } });
  c.ok("a ContentScriptVersion now exists for the fixture month", versions.length >= 1 && (await prisma.contentScriptVersion.count()) > versionsBefore, `${versions.length} versions`);
  const scripts = await prisma.contentScript.findMany({ where: { monthId: f.monthId }, select: { topicId: true } });
  c.ok("drafted from the call topic, not the thin one", scripts.some((s) => s.topicId === f.topicIds[0]) && !scripts.some((s) => s.topicId === f.topicIds[1]), JSON.stringify(scripts));
  c.ok("the model was reached through the cron, via the stub", aiCalls > aiBefore, `${aiCalls - aiBefore} calls`);
  const cronRun = await prisma.cronRun.findFirst({ where: { job: "sync" }, orderBy: { startedAt: "desc" }, select: { finishedAt: true, ok: true, error: true } });
  c.ok("the shell's own bookkeeping ran: the CronRun row is finished", !!cronRun?.finishedAt, JSON.stringify(cronRun).slice(0, 200));

  // The pass above proves the shell, but it proves it against providers that
  // are simply absent: their credentials live in Connection rows and this
  // database has none, so every provider step refused before reaching the
  // network. Production's normal failure is the other one — credentials on
  // file, provider down. So: give every provider a fake credential, encrypted
  // the way the app stores one, and run the route again with the network gone.
  c.head("4b · the same route with every provider configured and unreachable");
  const { encryptSecret } = await import("@/lib/integrations/crypto");
  const providers = ["aryeo", "aryeo_webhook", "stripe", "dropbox", "calendly", "openphone", "openphone_webhook", "slack", "slack_user", "gmail", "quickbooks", "ai"];
  for (const provider of providers) {
    await prisma.connection.upsert({
      where: { provider },
      create: { provider, status: "CONNECTED", secretEncrypted: encryptSecret(`drill-fake-${provider}`) },
      update: { status: "CONNECTED", secretEncrypted: encryptSecret(`drill-fake-${provider}`) },
    });
  }
  // The .env-configured providers, likewise: present, fake, unreachable.
  Object.assign(process.env, {
    DROPBOX_APP_KEY: "drill-fake", DROPBOX_APP_SECRET: "drill-fake",
    SCRIPTING_BASE_URL: "https://scripting.drill.invalid", SCRIPTING_API_KEY: "drill-fake",
    BLOB_READ_WRITE_TOKEN: [["vercel", "blob", "rw"].join("_"), "drillfake", "0".repeat(16)].join("_"), // built at run time: a token-shaped literal trips GitHub push protection and GitGuardian (a false alarm on Sep 26)
  });
  const blockedBefore = fence.blocked.length;
  const strippedBefore4b = server.patchStats.strippedReady;
  const versions2Before = await prisma.contentScriptVersion.count();
  const started2 = Date.now();
  const res2 = await GET(new NextRequest("http://127.0.0.1/api/cron/sync", { headers: { authorization: "Bearer drill-secret" } }));
  const wall2 = Date.now() - started2;
  const body2 = (await res2.json()) as Record<string, unknown>;
  const ms2 = (body2.ms ?? {}) as Record<string, number>;
  const errored2 = Object.keys(body2).filter((k) => k.endsWith("Error")).map((k) => `${k.slice(0, -5)}: ${String(body2[k]).slice(0, 90)}`);
  const skipped2 = (body2.skipped ?? []) as string[];
  const timedOut2 = (body2.timedOut ?? []) as string[];
  const newlyBlocked = fence.blocked.slice(blockedBefore);
  const hosts2 = [...new Set(newlyBlocked.map((u) => { try { return new URL(u).host; } catch { return u.slice(0, 50); } }))];
  console.log(`    route returned ${res2.status} in ${(wall2 / 1000).toFixed(1)}s · ${Object.keys(ms2).length} steps ran`);
  console.log(`    slowest: ${Object.entries(ms2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}ms`).join(", ")}`);
  console.log(`    errored (${errored2.length}):${errored2.length ? "\n      " + errored2.join("\n      ") : " none"}`);
  console.log(`    skipped: ${skipped2.join(", ") || "none"} · timed out: ${timedOut2.join(", ") || "none"}`);
  console.log(`    blocked at the fence (${newlyBlocked.length}): ${hosts2.join(", ")}`);
  c.ok("the route still answers 200 — a provider outage degrades steps, not the run", res2.status === 200 && body2.ok === true, `${res2.status}`);
  // The Sep 23 attempt died exactly here: the second tick's notification and
  // alert-claim dedupe keys collide with the first tick's, by design.
  c.ok("this tick collided with the last one's dedupe keys, and carried on", server.patchStats.strippedReady > strippedBefore4b, `${server.patchStats.strippedReady - strippedBefore4b} unique violations survived`);
  c.ok("the providers really did try the network this time", newlyBlocked.length > 0, `${newlyBlocked.length} attempts`);
  c.ok("no step was skipped for budget", skipped2.length === 0, skipped2.join(",") || "none");
  c.ok("no step hung to its cap", timedOut2.length === 0, timedOut2.join(",") || "none");
  c.ok("the whole outage run stayed well inside the budget", wall2 < 120_000, `${(wall2 / 1000).toFixed(1)}s`);
  c.ok("scriptDrafting ran again, untouched by the outage", !!body2.scriptDrafting && !("scriptDraftingError" in body2));
  c.ok("and drafted NOTHING twice — the second tick adds no version", (await prisma.contentScriptVersion.count()) === versions2Before, `${await prisma.contentScriptVersion.count()} vs ${versions2Before}`);

  c.head("5 · nothing left the machine");
  const hosts = [...new Set(fence.blocked.map((u) => { try { return new URL(u).host; } catch { return u.slice(0, 50); } }))];
  console.log(`    blocked destinations (${fence.blocked.length}): ${hosts.join(", ") || "none — nothing tried to leave"}`);
  c.ok("every outbound attempt was stopped at the fence", fence.blocked.every((u) => !/^https?:\/\/(127\.|localhost)/.test(u)));
  // Everything the route tried went through fetch, so the socket layer has not
  // been exercised yet. An SDK on node:https (Stripe's, Plaid's) never calls
  // fetch. A .invalid host, so a fence that failed would still reach nothing.
  const https = await import("node:https");
  const viaHttps = await new Promise<string>((resolve) => {
    const req = https.get("https://fence-probe.drill.invalid/", () => resolve("connected — NOT fenced"));
    req.on("error", (e) => resolve(e.message));
  });
  c.ok("node:https is fenced too, below fetch", /OUTBOUND BLOCKED/.test(viaHttps) && fence.blocked.some((u) => u.includes("fence-probe.drill.invalid")), viaHttps);
  const net = await import("node:net");
  const viaLoopback = await new Promise<string>((resolve) => {
    const s = net.connect(PORT, "127.0.0.1", () => { s.destroy(); resolve("connected"); });
    s.on("error", (e) => resolve(e.message));
  });
  c.ok("while a loopback socket still connects", viaLoopback === "connected", viaLoopback);
  c.ok("the database was never production", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/`));
  const outbox = await prisma.outboxMessage.count();
  c.ok("no outbound message was even queued", outbox === 0, `${outbox} rows`);
  c.ok("and no query was ever lost at the socket layer", server.patchStats.rejected === 0, JSON.stringify(server.patchStats));

  // Sep 28 2026: twice a file here that only MENTIONED PGlite was taken for a
  // drill and read production (read-only, so nothing was written). This folder
  // now holds isolated drills only; anything that opens the live database lives
  // in scripts/_live/. A drill file must boot its own database.
  c.head("H · every drill in this folder boots its own database");
  {
    const dir = path.dirname(__filename);
    // A file may need no database at all (a pure rule). One that reaches a
    // database must make its own: bootDrillDb/bootDemoDb, PGlite.create, or
    // DATABASE_URL pinned to a loopback URL in the file. The production shape
    // (take DATABASE_URL from .env, add the read-only option) has none of these.
    const shape = (src: string) => {
      const touchesDb = /@\/lib\/prisma|@prisma\/client|PrismaClient|DATABASE_URL/.test(src);
      const own =
        /\bbootDrillDb\(|\bbootDemoDb\(|PGlite\.create\(/.test(src) ||
        (/process\.env\.DATABASE_URL\s*=/.test(src) && /postgresql:\/\/[^\s"'`]*@127\.0\.0\.1/.test(src));
      return touchesDb && !own;
    };
    const offenders = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && !f.startsWith("zz-scratch-"))
      .filter((f) => shape(fs.readFileSync(path.join(dir, f), "utf8")));
    c.ok("no file in scripts/_drill/ can reach a database it did not create (production scripts go in scripts/_live/)", offenders.length === 0, offenders.join(", ") || "none");
  }

  quiet.restore();
  console.log(`    (${quiet.count} expected prisma:error log lines suppressed)`);
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

// ===========================================================================
// POSTGRES MODE
// ===========================================================================
const SPARE_PORT = PORT + 1; // the PGlite control, then the orphaned cluster
const POOL = 5;
const PROBE_HOST = "fence-probe.drill.invalid";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const threw = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const has = (key: string) => (m: unknown) => !!m && typeof m === "object" && key in m;
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function mainPostgres() {
  c.head("0 · choosing the engine, and the guard in front of every schema push");
  c.ok("no engine and no DRILL_ENGINE → PGlite, so every existing drill runs as before", resolveDrillEngine(undefined, {}) === "pglite" && resolveDrillEngine(undefined, { DRILL_ENGINE: "" }) === "pglite");
  c.ok("DRILL_ENGINE=postgres selects the real server", resolveDrillEngine(undefined, { DRILL_ENGINE: "postgres" }) === "postgres");
  c.ok("an explicit engine wins over DRILL_ENGINE", resolveDrillEngine("pglite", { DRILL_ENGINE: "postgres" }) === "pglite");
  c.ok("a typo throws instead of quietly running PGlite", threw(() => resolveDrillEngine(undefined, { DRILL_ENGINE: "postgress" })));
  c.ok("a Neon-shaped database URL is refused", threw(() => assertLoopbackDbUrl("postgresql://ep-drill-probe.us-east-2.aws.neon.tech/neondb?sslmode=require")));
  c.ok("only 127.0.0.1 passes — not even localhost by name", threw(() => assertLoopbackDbUrl("postgresql://localhost:5873/drill")) && !threw(() => assertLoopbackDbUrl("postgresql://127.0.0.1:5873/drill")));
  const lonely = barrier(2, { timeoutMs: 50, label: "lonely" });
  const unfilled = await lonely.wait().then(() => "released", (e: Error) => e.message);
  c.ok("barrier: one that never fills rejects by name instead of hanging the drill", /^lonely: only 1 of 2 arrived/.test(unfilled), unfilled);
  const pair = barrier(2);
  const orders = await Promise.all([pair.wait(), pair.wait()]);
  const extra = await pair.wait();
  c.ok("barrier: a filled one releases both; a late arrival passes and is counted", orders.join() === "1,2" && pair.late === 1 && extra === 3, `${orders} · late ${pair.late}`);

  c.head("1 · boot: a disposable Postgres, the major production runs");
  const t0 = Date.now();
  const drill = await bootDrillDb({ port: PORT, engine: "postgres", pool: POOL });
  const version = await drill.serverVersion();
  console.log(`    booted, schema pushed, in ${((Date.now() - t0) / 1000).toFixed(1)}s · Postgres ${version} · postmaster ${drill.postmasterPid}`);
  c.ok(`the server is Postgres ${PRODUCTION_PG_MAJOR}.x, production's major`, Number.parseInt(version, 10) === PRODUCTION_PG_MAJOR, version);
  c.ok("DATABASE_URL is the loopback `drill` database with a pool of 5", process.env.DATABASE_URL === drill.url && new URL(drill.url).hostname === "127.0.0.1" && new URL(drill.url).pathname === "/drill" && new URL(drill.url).searchParams.get("connection_limit") === "5");
  const tables = (await drill.sql<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"))[0].n;
  c.ok("the schema is in it", tables > 50, `${tables} tables`);
  const { prisma } = await import("@/lib/prisma");
  const { lockAdvisory, advisoryKeyPair } = await import("@/lib/dbLocks");
  const quiet = quietPrismaErrors();

  c.head("2 · OLD: under PGlite every connection is the same session");
  {
    const db = await PGlite.create();
    const server = new DrillSocketServer({ db, port: SPARE_PORT, host: "127.0.0.1", maxConnections: 20 });
    await server.start();
    const liteUrl = `postgresql://postgres:postgres@127.0.0.1:${SPARE_PORT}/postgres?sslmode=disable`;
    const clients = [new PrismaClient({ datasources: { db: { url: liteUrl } } }), new PrismaClient({ datasources: { db: { url: liteUrl } } })];
    const pids = await Promise.all(clients.map(async (p) => (await p.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0].pid));
    c.ok("OLD: two separate clients get ONE backend pid — nothing can overlap", pids[0] === pids[1], pids.join(" = "));
    for (const p of clients) await p.$disconnect();
    await server.stop();
    await db.close();
  }

  c.head("A · two Prisma sessions are two backends");
  {
    const meet = barrier(2, { label: "two open transactions" });
    const openAndMeet = () => prisma.$transaction(async (tx) => {
      const pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0].pid;
      await meet.wait(); // both transactions are open at this instant…
      await sleep(50); // …and stay open long enough for the 5 ms sampler to see it
      return pid;
    });
    const { result: pids, distinctBackends } = await drill.backendsDuring(() => Promise.all([openAndMeet(), openAndMeet()]));
    c.ok("NEW: two sessions report different pg_backend_pid()", pids[0] !== pids[1], pids.join(" vs "));
    c.ok("both transactions were open at the same moment (the barrier filled)", meet.released && meet.arrived === 2);
    c.ok("the sampler saw both backends busy at once", distinctBackends >= 2, `${distinctBackends} distinct`);
  }

  c.head("B · a contended advisory lock: B waits for A's commit");
  {
    const order: string[] = [];
    const logged = drill.lockWaits();
    let waiting = 0;
    let bAskedAt = 0;
    const a = prisma.$transaction(async (tx) => {
      await lockAdvisory(tx, "selftest:advisory");
      order.push("A locked");
      // Hold until Postgres itself says B is waiting — not a guess with sleep.
      for (const until = Date.now() + 5_000; waiting < 1 && Date.now() < until; ) {
        waiting = await drill.waitingLocks();
        if (waiting < 1) await sleep(10);
      }
      await sleep(150); // past deadlock_timeout (50 ms), so the server logs the wait
      order.push("A commits");
    }, { timeout: 15_000 });
    while (!order.includes("A locked")) await sleep(5);
    const b = prisma.$transaction(async (tx) => {
      order.push("B asks");
      bAskedAt = Date.now();
      await lockAdvisory(tx, "selftest:advisory");
      order.push("B locked");
      return Date.now() - bAskedAt;
    }, { timeout: 15_000 });
    const [, bWaited] = await Promise.all([a, b]);
    for (const until = Date.now() + 1_000; drill.lockWaits() === logged && Date.now() < until; ) await sleep(20);
    c.ok("while A held it, Postgres listed B's request as not granted", waiting >= 1, `${waiting} waiting`);
    c.ok("the server logged the wait itself (log_lock_waits): lockWaits ≥ 1", drill.lockWaits() - logged >= 1, `${drill.lockWaits() - logged} logged`);
    c.ok("B got the lock only after A committed", order.join(" → ") === "A locked → B asks → A commits → B locked", order.join(" → "));
    c.ok("and B really was held (≥ 150 ms)", bWaited >= 150, `${bWaited} ms`);
  }

  c.head("C · a unique violation leaves the pool usable");
  {
    const aiRun = (key: string, n = 0) =>
      prisma.programAiRun.create({ data: { kind: "script_draft", promptKey: "script", requestedBy: `racer-${n}`, status: "RUNNING", dedupeKey: key } });
    await aiRun("selftest:pg-a");
    const dup = await aiRun("selftest:pg-a").then(() => "no error", errCode);
    c.ok("a duplicate dedupeKey raises P2002", dup === "P2002", dup);
    await prisma.$executeRawUnsafe("CREATE TABLE selftest_k (v text UNIQUE)");
    await prisma.$executeRawUnsafe("INSERT INTO selftest_k VALUES ('a')");
    const raw = await prisma.$executeRawUnsafe("INSERT INTO selftest_k VALUES ('a')").then(() => "no error", errCode);
    const next = await prisma.$queryRawUnsafe<{ n: number }[]>("SELECT 1::int AS n").then((r) => r[0]?.n, errCode);
    c.ok("the raw 23505 that killed PGlite's socket (P2010), then SELECT 1 answers", raw === "P2010" && next === 1, `${raw} then ${next}`);
    const txErr = await prisma.$transaction(async (tx) => {
      await tx.programAiRun.create({ data: { kind: "script_draft", promptKey: "script", requestedBy: "tx", dedupeKey: "selftest:pg-tx" } });
      await tx.programAiRun.create({ data: { kind: "script_draft", promptKey: "script", requestedBy: "tx", dedupeKey: "selftest:pg-a" } });
    }).then(() => "no error", errCode);
    c.ok("a violation inside a transaction rolls all of it back", txErr === "P2002" && (await prisma.programAiRun.count({ where: { dedupeKey: "selftest:pg-tx" } })) === 0, txErr);
    const eight = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => aiRun("selftest:pg-race8", i + 1)));
    const lost = eight.filter((r) => r.status === "rejected").map((r) => errCode((r as PromiseRejectedResult).reason));
    c.ok("eight concurrent inserts over the pool: one wins, seven P2002", lost.length === 7 && lost.every((x) => x === "P2002"), lost.join(","));
    const { result: answers, distinctBackends } = await drill.backendsDuring(() =>
      Promise.allSettled(Array.from({ length: 12 }, () => prisma.$queryRaw<{ n: number }[]>`SELECT n FROM (SELECT 1::int AS n, pg_sleep(0.02)) AS held`)),
    );
    c.ok("SELECT 1 answers on every pooled connection afterwards (12 at once)", answers.every((r) => r.status === "fulfilled"), answers.map((r) => r.status).join(","));
    const open = await drill.distinctBackends();
    c.ok(`and Prisma kept to its pool of ${POOL}: several backends, never more than ${POOL}`, distinctBackends >= 2 && open <= POOL, `${distinctBackends} busy at once, ${open} open`);
  }

  c.head("D · a child SIGKILLed inside a transaction leaves nothing behind");
  const holder = drill.runChild(__filename, { args: ["hold"] });
  {
    const held = await holder.waitFor<{ pid: number }>(has("holding"), 90_000);
    const [k1, k2] = advisoryKeyPair("selftest:child-lock");
    const lockFree = async () => (await drill.sql<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1::int4, $2::int4) AS ok", [k1, k2]))[0].ok;
    const idleBefore = await drill.idleInTransaction();
    c.ok("OLD state, shown first: the child sits idle in an open transaction", idleBefore >= 1, `${idleBefore} idle in transaction (child backend ${held.pid})`);
    c.ok("holding its advisory lock", (await lockFree()) === false);
    const killedAt = Date.now();
    holder.kill("SIGKILL");
    const exit = await holder.exited;
    let idle = await drill.idleInTransaction();
    while (idle > 0 && Date.now() - killedAt < 1_000) {
      await sleep(10);
      idle = await drill.idleInTransaction();
    }
    const took = Date.now() - killedAt;
    c.ok("the child died by SIGKILL, mid-transaction", exit.signal === "SIGKILL", JSON.stringify(exit));
    c.ok("within 1 s, idleInTransaction() is 0", idle === 0 && took < 1_000, `${took} ms`);
    c.ok("its lock went with it", (await lockFree()) === true);
    c.ok("and its uncommitted row never existed", (await prisma.programAiRun.count({ where: { dedupeKey: "selftest:child-row" } })) === 0);
  }

  c.head("D2 · a race between two PROCESSES: the loser waits on the winner's row");
  {
    const racers = [drill.runChild(__filename, { args: ["race"] }), drill.runChild(__filename, { args: ["race"] })];
    const ready = await Promise.all(racers.map((r) => r.waitFor<{ pid: number }>(has("ready"), 90_000)));
    const connected = await drill.distinctBackends();
    c.ok("two processes, two backends", ready[0].pid !== ready[1].pid && connected >= 2, `${ready.map((r) => r.pid).join(" vs ")} · ${connected} connected`);
    const logged = drill.lockWaits();
    for (const r of racers) r.send("go");
    const first = await Promise.race(racers.map((r, i) => r.waitFor(has("inserted"), 30_000).then(() => i)));
    let waiting = 0;
    for (const until = Date.now() + 5_000; waiting < 1 && Date.now() < until; ) {
      waiting = await drill.waitingLocks();
      if (waiting < 1) await sleep(10);
    }
    await sleep(150); // past deadlock_timeout, so the server logs it
    for (const r of racers) r.send("commit");
    const results = await Promise.all(racers.map((r) => r.waitFor<{ result: string }>(has("result"), 30_000)));
    await Promise.all(racers.map((r) => r.exited));
    const outcomes = results.map((r) => r.result);
    for (const until = Date.now() + 1_000; drill.lockWaits() === logged && Date.now() < until; ) await sleep(20);
    c.ok("while the winner's insert was uncommitted, the loser's was waiting on it", waiting >= 1, `${waiting} waiting`);
    c.ok("exactly one process won; the other got P2002 once the winner committed", outcomes.filter((o) => o === "won").length === 1 && outcomes.filter((o) => o === "P2002").length === 1, outcomes.join(", "));
    c.ok("the winner is the process that inserted first", outcomes[first] === "won", `racer ${first} inserted first`);
    const row = await prisma.programAiRun.findMany({ where: { dedupeKey: "selftest:xrace" }, select: { requestedBy: true } });
    c.ok("one row, the winner's", row.length === 1 && row[0].requestedBy === `child-${racers[first].pid}`, JSON.stringify(row));
    c.ok("the server logged that wait too", drill.lockWaits() > logged, `${drill.lockWaits() - logged} logged`);
  }

  c.head("E · 0 non-loopback sockets");
  {
    const setting = async (name: string) => (await drill.sql<{ v: string }>("SELECT current_setting($1) AS v", [name]))[0].v;
    const listen = await setting("listen_addresses");
    const unix = await setting("unix_socket_directories");
    c.ok("the server listens on 127.0.0.1 only, with no unix socket", listen === "127.0.0.1" && unix === "", `listen_addresses=${listen} · unix_socket_directories='${unix}'`);
    const clients = await drill.sql<{ addr: string | null; n: number }>("SELECT host(client_addr) AS addr, count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1");
    const offBox = clients.filter((r) => r.addr !== "127.0.0.1").reduce((n, r) => n + r.n, 0);
    c.ok("every client session came from 127.0.0.1", clients.length > 0 && offBox === 0, JSON.stringify(clients));
    let lsof = "";
    try {
      lsof = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`], { encoding: "utf8" });
    } catch (e) {
      lsof = (e as { stdout?: string }).stdout ?? "";
    }
    const lines = lsof.split("\n").slice(1).filter(Boolean);
    const addrs = lines.flatMap((l) => [...l.matchAll(/(\[[0-9a-f:]+\]|\d+\.\d+\.\d+\.\d+|\*):\d+/gi)].map((m) => m[1]));
    const nonLoop = addrs.filter((a) => !/^(127\.\d+\.\d+\.\d+|\[::1\])$/.test(a));
    c.ok("lsof on the port: a listener and live connections, 0 of them off loopback", lines.some((l) => l.includes("(LISTEN)")) && lines.some((l) => l.includes("(ESTABLISHED)")) && nonLoop.length === 0, `${lines.length} sockets, non-loopback: ${nonLoop.join(",") || "none"}`);
    const probes = fence.blocked.filter((u) => u.includes(PROBE_HOST));
    const others = fence.blocked.filter((u) => !u.includes(PROBE_HOST));
    c.ok("the child's fence reports into this one (its deliberate probe is recorded here)", holder.blocked.some((u) => u.includes(PROBE_HOST)) && probes.length >= 1, probes.join(", "));
    c.ok("apart from that probe, 0 attempts to leave the machine, in any process", others.length === 0, others.join(", ") || "none");
  }

  c.head("F · stop() frees the port and removes the directory; a re-boot works");
  const evidence = await drill.evidence();
  const guard = path.join(os.tmpdir(), `rtp-realpg-${PORT}.json`);
  await drill.stop();
  c.ok("the port is free", await portFree(PORT));
  c.ok("the postmaster is gone", !pidAlive(drill.postmasterPid), `pid ${drill.postmasterPid}`);
  c.ok("the data directory and the reaper's record are removed", !fs.existsSync(drill.dataDir) && !fs.existsSync(guard));
  const again = await bootRealPostgres(PORT, POOL);
  const fresh = await prisma.programAiRun.count().then((n) => n, errCode);
  c.ok("a re-boot on the same port comes up with a fresh schema", fresh === 0 && again.dataDir !== drill.dataDir, `${fresh} rows`);

  c.head("G · a cluster orphaned by a SIGKILLed drill is reaped by the next boot");
  {
    const maker = again.runChild(__filename, { args: ["orphan"] });
    const up = await maker.waitFor<{ dir: string; postmasterPid: number }>(has("orphanUp"), 90_000);
    maker.kill("SIGKILL");
    await maker.exited;
    c.ok("OLD hazard, shown first: the drill is dead, its postmaster lives on holding the port", pidAlive(up.postmasterPid) && !(await portFree(SPARE_PORT)) && fs.existsSync(up.dir), `postmaster ${up.postmasterPid}`);
    const next = await bootRealPostgres(SPARE_PORT, 2, { pushSchema: false });
    c.ok("the next boot on that port stopped the leftover and removed its directory", !pidAlive(up.postmasterPid) && !fs.existsSync(up.dir));
    c.ok("and came up itself", Number.parseInt(await next.serverVersion(), 10) === PRODUCTION_PG_MAJOR && next.postmasterPid !== up.postmasterPid);
    await next.stop();
    c.ok("which stop() then frees as well", await portFree(SPARE_PORT));
  }
  await again.stop();
  c.ok("the re-booted cluster stops cleanly too", await portFree(PORT) && !fs.existsSync(again.dataDir));

  quiet.restore();
  console.log(`\n    ${evidence}`);
  console.log(`    (${quiet.count} expected prisma:error log lines suppressed)`);
  c.summary();
  process.exit(process.exitCode ?? 0);
}

/** The parts a child process plays in postgres mode (argv[2]). */
async function childMain(role: string) {
  const ctx = attachDrillChild();
  if (role === "orphan") {
    // Boot a cluster and be killed before stopping it: the SIGKILLed drill.
    const orphan = await bootRealPostgres(SPARE_PORT, 2, { pushSchema: false });
    await ctx.send({ orphanUp: true, dir: orphan.dataDir, postmasterPid: orphan.postmasterPid });
    await new Promise(() => {});
  }
  const { prisma } = await import("@/lib/prisma");
  if (role === "hold") {
    const { lockAdvisory } = await import("@/lib/dbLocks");
    // A deliberate attempt to leave, so the parent can see this fence report to its own.
    await fetch(`https://${PROBE_HOST}/child`).catch(() => null);
    await prisma.$transaction(async (tx) => {
      await lockAdvisory(tx, "selftest:child-lock");
      await tx.programAiRun.create({ data: { kind: "script_draft", promptKey: "script", requestedBy: "child", dedupeKey: "selftest:child-row" } });
      const pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0].pid;
      await ctx.send({ holding: true, pid });
      await new Promise(() => {}); // until the parent's SIGKILL
    }, { maxWait: 10_000, timeout: 120_000 });
  }
  if (role === "race") {
    const pid = (await prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0].pid;
    await ctx.send({ ready: true, pid });
    await ctx.waitFor((m) => m === "go");
    const result = await prisma.$transaction(async (tx) => {
      await tx.programAiRun.create({ data: { kind: "script_draft", promptKey: "script", requestedBy: `child-${process.pid}`, status: "RUNNING", dedupeKey: "selftest:xrace" } });
      await ctx.send({ inserted: true });
      await ctx.waitFor((m) => m === "commit");
    }, { maxWait: 10_000, timeout: 60_000 }).then(() => "won", errCode);
    await ctx.send({ result });
    await prisma.$disconnect();
    await ctx.exit(0);
  }
  throw new Error(`unknown child role ${role}`);
}

const ROLE = process.env.DRILL_CHILD ? process.argv[2] : null;
(ROLE ? childMain(ROLE) : ENGINE === "postgres" ? mainPostgres() : main()).catch((e) => { console.error(e); process.exit(1); });
