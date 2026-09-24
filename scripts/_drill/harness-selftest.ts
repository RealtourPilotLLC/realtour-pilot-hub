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
// ---------------------------------------------------------------------------
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "@prisma/client";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, pinDrillEnv, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5500);
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
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_drillfake_0000000000000000",
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

  quiet.restore();
  console.log(`    (${quiet.count} expected prisma:error log lines suppressed)`);
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
