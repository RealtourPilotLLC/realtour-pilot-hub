// ---------------------------------------------------------------------------
// DRILL: A01-cron-health — every scheduled job on Sync health, including the
// one that never recorded a run (unified handoff §12 A01, batch 6, Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/a01-cron-health.ts
//
// What it proves, the OLD behaviour first (BASE pinned to 3de6023, the tree
// batch 6 starts from — never HEAD):
//   0. The schedule: every vercel.json path maps to the job name its route
//      passes to cronBudget, and each job's cadence is read from its cron
//      expressions (the evening route's four UTC firings: longest gap 20 h).
//      OLD: the evening route passed no job name, so it wrote no CronRun.
//   1. 70 gmail + 30 topaz rows and ONE daily row 20 h old. OLD (/connections'
//      "60 newest rows across all jobs"): daily is not on the panel. NEW:
//      daily is there, not stale for a daily cadence; each job capped at 5;
//      evening says "never recorded"; a job nobody schedules is shown but
//      never called stale.
//   2. Without its row, daily says "never recorded"; an hourly job 3 h late
//      is stale; a five-minute job one tick late is not.
//   3. An evening GET at a non-acting ET hour writes one finished, ok CronRun
//      with an `idle` note and NO `skipped` entry (cron.ts would page on it).
//   4. At the digest hour with the reminder switched off: 200, ok, the
//      coaching step recorded. With it on and a total digest failure: 500 as
//      before, and the row is NOT ok, naming the step. A quiet day: 200, ok.
//      The chaser hour runs the chaser as a step.
//  4b. (review, Sep 28) A 7 PM digest that FAILED, then its DST twin an hour
//      later: the twin is a no-op dot, lastOk/lastRunAt stay the failed run's
//      (the one-row reader too), not stale; the digest step now runs before
//      coaching; readiness judges each evening alert by its own step's last
//      run, so the failed digest (and later a failed chaser) reads unhealthy.
//   5. The Sync health panel says "never recorded a run" and "stale:" in words.
//
// ISOLATION: PGlite on 127.0.0.1:5866 (DRILL_PORT overrides) through the shared
// harness; production is never opened; every non-loopback call is fenced and
// the digest/nag senders are replaced at the module boundary, so nothing is
// sent. THE CLOCK IS PINNED (Mon Sep 28 2026, moved per section).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5866);
const BASE = "3de6023"; // pinned: never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
let offset = 0;
const pinClock = (iso: string) => { offset = new RealDate(iso).getTime() - RealDate.now(); };
pinClock("2026-09-28T15:00:00Z"); // Mon Sep 28 2026, 11:00 EDT
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
const nowMs = () => RealDate.now() + offset;

// ---- the senders, replaced at the module boundary --------------------------
type SendResult = { sent: number; skipped: number; notes: string[] };
let digestImpl: (() => Promise<SendResult>) | null = null;
let nagImpl: (() => Promise<SendResult>) | null = null;
let digestCalls = 0, nagCalls = 0;
interceptModule(
  (r) => r === "@/lib/uploadDigest",
  (loaded) => {
    const real = loaded as Record<string, unknown>;
    return {
      ...real,
      sendEveningUploadDigests: async () => { digestCalls++; return digestImpl ? digestImpl() : { sent: 0, skipped: 0, notes: ["no shoots today"] }; },
      sendNightlyUploadNags: async () => { nagCalls++; return nagImpl ? nagImpl() : { sent: 0, skipped: 0, notes: ["nothing unsubmitted today"] }; },
    };
  },
);

installNextStubs();
const fence = fenceFetch();
const c = makeChecker();
const show = (file: string) => execFileSync("git", ["show", `${BASE}:${file}`], { cwd: REPO, encoding: "utf8" });

/** Every string a server component renders, walking function components too. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof el.type === "function") return textOf((el.type as (p: unknown) => unknown)(el.props));
  return textOf(el.props?.children);
}

async function main() {
  // Boot first: lib/cronHealth imports @/lib/prisma, which must never bind
  // before DATABASE_URL points at this drill's database.
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");

  // =========================================================================
  c.head("0 · the schedule, and what the old evening route recorded");
  const oldEvening = show("src/app/api/cron/evening/route.ts");
  c.ok("OLD: the evening route never called cronBudget, so no CronRun row was ever written", !/cronBudget\(/.test(oldEvening));
  const oldPage = show("src/app/connections/page.tsx");
  c.ok("OLD: /connections read the 60 newest CronRun rows across ALL jobs", /orderBy: \{ startedAt: "desc" \},\s*take: 60/.test(oldPage));

  const { expectedCrons, cadenceLabel, staleAfterMs, firingMinutes } = await import("@/lib/cronHealth");
  const exp = expectedCrons();
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8")) as { crons: { path: string }[] };
  c.ok("every vercel.json path is an expected job, once", new Set(vercel.crons.map((x) => x.path)).size === exp.length);
  const mismatched = exp.filter((e) => {
    const src = fs.readFileSync(path.join(REPO, "src/app", e.path, "route.ts"), "utf8");
    return !new RegExp(`cronBudget\\([^;]*?"${e.job}"\\)`).test(src);
  });
  c.ok("each scheduled route records under the job name the health reader expects", mismatched.length === 0, mismatched.map((e) => e.path).join(", ") || exp.map((e) => e.job).join(" "));
  const cad = Object.fromEntries(exp.map((e) => [e.job, e]));
  c.ok("gmail and topaz: every 5 min", cad.gmail?.cadenceMs === 5 * 60_000 && cad.topaz?.cadenceMs === 5 * 60_000 && cadenceLabel(cad.gmail) === "every 5 min");
  c.ok("sync and reconcile: hourly", cad.sync?.cadenceMs === 3600_000 && cad.reconcile?.cadenceMs === 3600_000 && cadenceLabel(cad.sync) === "hourly");
  c.ok("the three daily jobs: 24 h", ["daily", "daily-clients", "daily-reconcile"].every((j) => cad[j]?.cadenceMs === 24 * 3600_000 && cadenceLabel(cad[j]) === "daily"));
  c.ok("evening: four firings a day, longest gap 20 h (03:00 → 23:00 UTC)", cad.evening?.firingsPerDay === 4 && cad.evening.cadenceMs === 20 * 3600_000, cadenceLabel(cad.evening));
  c.ok("a five-minute job is not stale inside 15 minutes (one late tick is jitter)", staleAfterMs(5 * 60_000) === 15 * 60_000 && staleAfterMs(3600_000) === 2 * 3600_000);
  c.ok("an unreadable schedule is refused, not guessed", firingMinutes("0 8 * * 1") === null && firingMinutes("*/5 * * * *")?.length === 288);

  const { cronHealthByJob } = await import("@/lib/cronHealth");

  // =========================================================================
  c.head("1 · five-minute jobs no longer push the daily ones off the panel");
  const rows: { job: string; startedAt: Date; finishedAt: Date; ok: boolean; summary: string }[] = [];
  for (let i = 0; i < 70; i++) rows.push({ job: "gmail", startedAt: new RealDate(nowMs() - i * 5 * 60_000 - 60_000), finishedAt: new RealDate(nowMs() - i * 5 * 60_000), ok: true, summary: "{}" });
  for (let i = 0; i < 30; i++) rows.push({ job: "topaz", startedAt: new RealDate(nowMs() - i * 5 * 60_000 - 90_000), finishedAt: new RealDate(nowMs() - i * 5 * 60_000), ok: true, summary: "{}" });
  rows.push({ job: "daily", startedAt: new RealDate(nowMs() - 20 * 3600_000), finishedAt: new RealDate(nowMs() - 20 * 3600_000 + 200_000), ok: true, summary: JSON.stringify({ skipped: [], ms: { booksSync: 120_000, trends: 30_000 } }) });
  rows.push({ job: "sync", startedAt: new RealDate(nowMs() - 20 * 60_000), finishedAt: new RealDate(nowMs() - 19 * 60_000), ok: true, summary: "{}" });
  rows.push({ job: "relabel-legacy", startedAt: new RealDate(nowMs() - 30 * 24 * 3600_000), finishedAt: new RealDate(nowMs() - 30 * 24 * 3600_000), ok: true, summary: "{}" });
  await prisma.cronRun.createMany({ data: rows });

  // The OLD page query, verbatim in shape.
  const old60 = await prisma.cronRun.findMany({ orderBy: { startedAt: "desc" }, take: 60, select: { job: true } });
  c.ok("OLD: the 60 newest rows hold no daily run — it had fallen off the panel", !old60.some((r) => r.job === "daily"), [...new Set(old60.map((r) => r.job))].join(", "));

  let h = await cronHealthByJob(5);
  const job = (j: string) => h.find((x) => x.job === j)!;
  c.ok("NEW: daily is reported, with its one run", job("daily")?.runs.length === 1 && job("daily").lastOk === true);
  c.ok("…and is not stale 20 h into a daily cadence", job("daily").stale === false && job("daily").neverRecorded === false);
  c.ok("…its slowest step is still read from the summary", job("daily").runs[0].slowest === "booksSync 120s");
  c.ok("each job carries at most 5 runs, newest first", h.every((x) => x.runs.length <= 5) && job("gmail").runs.length === 5 && job("gmail").runs[0].at > job("gmail").runs[1].at);
  c.ok("every expected job is present even with no rows", exp.every((e) => h.some((x) => x.job === e.job && x.expected)));
  c.ok("evening, which never recorded, says so", job("evening").neverRecorded === true && job("evening").runs.length === 0 && job("evening").stale === false);
  c.ok("a recorded job nobody schedules is shown, never paged as stale", job("relabel-legacy")?.expected === false && job("relabel-legacy").stale === false && job("relabel-legacy").neverRecorded === false);

  // =========================================================================
  c.head("2 · never recorded, stale, and jitter");
  await prisma.cronRun.deleteMany({ where: { job: "daily" } });
  await prisma.cronRun.updateMany({ where: { job: "sync" }, data: { startedAt: new RealDate(nowMs() - 3 * 3600_000) } });
  await prisma.cronRun.updateMany({ where: { job: "topaz" }, data: { startedAt: new RealDate(nowMs() - 10 * 60_000) } });
  h = await cronHealthByJob(5);
  c.ok("daily without its row: never recorded, not stale, no last run", job("daily").neverRecorded && !job("daily").stale && job("daily").lastRunAt === null);
  c.ok("sync three hours late on an hourly cadence: stale", job("sync").stale === true);
  c.ok("topaz ten minutes since its last start: not stale (inside the 15-minute floor)", job("topaz").stale === false);
  const unfinished = await prisma.cronRun.create({ data: { job: "reconcile", startedAt: new RealDate(nowMs() - 5 * 60_000) } });
  h = await cronHealthByJob(5);
  c.ok("a run with no finishedAt is unknown (null), not failed", job("reconcile").lastOk === null && job("reconcile").runs[0].id === unfinished.id);

  // =========================================================================
  c.head("3 · the evening DST twin: recorded, ok, idle — not skipped");
  const { NextRequest } = await import("next/server");
  const evening = await import("@/app/api/cron/evening/route");
  const call = () => evening.GET(new NextRequest("http://127.0.0.1/api/cron/evening", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  const lastEvening = () => prisma.cronRun.findFirst({ where: { job: "evening" }, orderBy: { startedAt: "desc" } });
  const denied = await evening.GET(new NextRequest("http://127.0.0.1/api/cron/evening"));
  c.ok("without the bearer: 401, and no row", denied.status === 401 && (await prisma.cronRun.count({ where: { job: "evening" } })) === 0);

  pinClock("2026-09-28T16:00:00Z"); // 12:00 EDT — not an acting hour
  let res = await call();
  type Body = { skipped?: boolean; reason?: string; coaching?: { dayKey?: string } };
  let body = (await res.json()) as Body;
  let row = await lastEvening();
  let sum = JSON.parse(row?.summary ?? "{}") as { idle?: string; skipped?: string[]; deploy?: string };
  c.ok("the response is what it always was: 200, skipped:true, with the reason", res.status === 200 && body.skipped === true && /ET hour is 12/.test(body.reason ?? ""));
  c.ok("one CronRun row, finished and ok", !!row && !!row.finishedAt && row.ok === true && (await prisma.cronRun.count({ where: { job: "evening" } })) === 1);
  c.ok("…with an idle note and NO skipped entry (a skip would page twice a day)", /ET hour is 12/.test(sum.idle ?? "") && Array.isArray(sum.skipped) && sum.skipped.length === 0);
  c.ok("…and neither sender was called", digestCalls === 0 && nagCalls === 0);

  // =========================================================================
  c.head("4 · the acting hours: the coaching, digest and chaser steps");
  const { putSetting } = await import("@/lib/settings");
  const { DEFAULT_INTERNAL_ALERTS } = await import("@/lib/settings");
  await putSetting("internal_alerts", { ...DEFAULT_INTERNAL_ALERTS, uploadReminder: { enabled: false, hour: 19 } });
  pinClock("2026-09-28T23:00:00Z"); // 19:00 EDT — digest and coaching hour
  res = await call();
  body = (await res.json()) as Body;
  row = await lastEvening();
  sum = JSON.parse(row?.summary ?? "{}");
  const sumAny = sum as unknown as Record<string, unknown> & { ms?: Record<string, number> };
  c.ok("reminder OFF at 19:00: 200, the digest is not sent", res.status === 200 && digestCalls === 0 && body.skipped === true);
  c.ok("…the coaching step ran for the ET day and is recorded on the row (with its timing)", "coaching" in sumAny && typeof sumAny.ms?.coaching === "number" && (body.coaching as { dayKey?: string } | undefined)?.dayKey === "2026-09-28");
  c.ok("…and the row is finished and ok", !!row?.finishedAt && row.ok === true);

  await putSetting("internal_alerts", { ...DEFAULT_INTERNAL_ALERTS });
  digestImpl = async () => ({ sent: 0, skipped: 0, notes: ["Harrison: OpenPhone refused the send"] });
  pinClock("2026-09-28T23:00:30Z");
  res = await call();
  const failBody = (await res.json()) as { digests?: SendResult };
  row = await lastEvening();
  c.ok("reminder ON, every digest failed: 500, exactly as before", res.status === 500 && failBody.digests?.sent === 0 && /OpenPhone refused/.test(failBody.digests?.notes[0] ?? ""));
  c.ok("…and the CronRun row is NOT ok and names the step", row?.ok === false && /^digests: sent nothing/.test(row?.error ?? ""), row?.error ?? "");

  digestImpl = async () => ({ sent: 0, skipped: 0, notes: ["no shoots today"] });
  pinClock("2026-09-28T23:01:00Z");
  res = await call();
  row = await lastEvening();
  c.ok("a quiet day at 19:00: 200, the row ok", res.status === 200 && row?.ok === true && "digests" in (JSON.parse(row?.summary ?? "{}") as object));

  nagImpl = async () => ({ sent: 2, skipped: 0, notes: [] });
  pinClock("2026-09-29T02:00:00Z"); // 22:00 EDT — the chaser
  res = await call();
  const nagBody = (await res.json()) as { nags?: SendResult };
  row = await lastEvening();
  c.ok("22:00: the chaser runs as a recorded step, 200, ok", res.status === 200 && nagBody.nags?.sent === 2 && nagCalls === 1 && row?.ok === true && "nags" in (JSON.parse(row?.summary ?? "{}") as object));
  c.ok("five firings, five rows — every one finished", (await prisma.cronRun.count({ where: { job: "evening" } })) === 5 && (await prisma.cronRun.count({ where: { job: "evening", finishedAt: null } })) === 0);
  h = await cronHealthByJob(5, new RealDate(nowMs()));
  c.ok("Sync health now has evening, with its newest run", job("evening").neverRecorded === false && job("evening").runs.length === 5 && job("evening").lastOk === true);

  // =========================================================================
  c.head("4b · a failed acting firing stays failed after its DST twin (review, Sep 28)");
  // All through EDT the twin fires an hour AFTER the firing that acts, and it
  // records an ok `idle` row. As "the newest run" it turned a failed 7 PM
  // digest green by 8 PM on /connections, in readiness and in the probe.
  digestImpl = async () => ({ sent: 0, skipped: 0, notes: ["Harrison: OpenPhone refused the send"] });
  pinClock("2026-09-29T23:00:00Z"); // Tue 19:00 EDT — every digest fails
  res = await call();
  const failed = await lastEvening();
  c.ok("19:00: every digest failed — 500, the row not ok", res.status === 500 && failed?.ok === false, failed?.error ?? "");
  const order = Object.keys((JSON.parse(failed?.summary ?? "{}") as { ms?: Record<string, number> }).ms ?? {});
  c.ok("finding 15: the digest step ran BEFORE coaching, so a slow coaching run can no longer spend the digest's budget", order.includes("digests") && order.indexOf("coaching") > order.indexOf("digests"), order.join(" → "));
  const routeSrc = fs.readFileSync(path.join(REPO, "src/app/api/cron/evening/route.ts"), "utf8");
  c.ok("…the route places both send steps before the coaching step", routeSrc.indexOf('runSend("digests"') > 0 && routeSrc.indexOf('runSend("nags"') > 0 && Math.max(routeSrc.indexOf('runSend("digests"'), routeSrc.indexOf('runSend("nags"')) < routeSrc.indexOf('step("coaching"'));
  pinClock("2026-09-30T00:00:00Z"); // 20:00 EDT — the idle twin, an hour later
  res = await call();
  const twin = await lastEvening();
  c.ok("20:00: the twin idles — 200, ok", res.status === 200 && twin?.ok === true);
  h = await cronHealthByJob(5, new RealDate(nowMs()));
  const ev = job("evening");
  c.ok("the twin is the newest row, read as a no-op dot", ev.runs[0].id === twin?.id && ev.runs[0].noop === true && ev.runs[0].ok === true);
  c.ok("…but the job's last run is still the FAILED 7 PM one: lastOk false, its error kept", ev.lastOk === false && ev.lastRunAt === failed!.startedAt.toISOString() && /^digests: sent nothing/.test(ev.lastActing?.error ?? ""), `${ev.lastOk} · ${ev.lastActing?.error}`);
  const h1 = await cronHealthByJob(1, new RealDate(nowMs()));
  c.ok("…the one-row reader (readiness, the probe) looks past the twin too", h1.find((x) => x.job === "evening")?.lastOk === false);
  c.ok("…and the job is not stale: the twin proves the schedule fires", ev.stale === false);

  // Readiness: each evening alert reads its OWN step's last run (13 / 23).
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("openphone", ["op", "drill", "key"].join("-"));
  const { readinessReport } = await import("@/lib/readiness");
  let rep = await readinessReport({ now: new RealDate(nowMs()) });
  const rowOf = (k: string) => rep.rows.find((r) => r.key === k)!;
  c.ok("findings 13/23: the Upload reminder row is UNHEALTHY after the failed digest, with the error — not \"healthy yes\"", rowOf("internal_alerts.uploadReminder").healthy.ok === false && /sent nothing/.test(rowOf("internal_alerts.uploadReminder").healthy.lastError ?? ""), rowOf("internal_alerts.uploadReminder").healthy.detail);
  c.ok("…the chaser row reads its own step (last night's 22:00 chaser sent): healthy", rowOf("internal_alerts.uploadChaser").healthy.ok === true, rowOf("internal_alerts.uploadChaser").healthy.detail);
  nagImpl = async () => ({ sent: 0, skipped: 0, notes: ["Kyle: OpenPhone refused the send"] });
  pinClock("2026-09-30T02:00:00Z"); // 22:00 EDT — the chaser fails
  await call();
  pinClock("2026-09-30T03:00:00Z"); // 23:00 EDT — its twin idles
  await call();
  rep = await readinessReport({ now: new RealDate(nowMs()) });
  c.ok("the chaser fails at 22:00 and its twin idles at 23:00: the chaser row is unhealthy", rowOf("internal_alerts.uploadChaser").healthy.ok === false && /sent nothing/.test(rowOf("internal_alerts.uploadChaser").healthy.lastError ?? ""), rowOf("internal_alerts.uploadChaser").healthy.detail);
  digestImpl = async () => ({ sent: 3, skipped: 0, notes: [] });
  pinClock("2026-09-30T23:00:00Z"); // Wed 19:00 EDT — the digest goes out
  await call();
  rep = await readinessReport({ now: new RealDate(nowMs()) });
  c.ok("a good digest the next evening: the reminder row is healthy again", rowOf("internal_alerts.uploadReminder").healthy.ok === true, rowOf("internal_alerts.uploadReminder").healthy.detail);
  const { SyncHealth: SyncHealthPanel } = await (async () => {
    const id = require.resolve("lucide-react");
    if (!require.cache[id]) {
      const stub = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
      const mod = new (Module as unknown as { new (id: string): NodeModule })(id);
      Object.assign(mod, { filename: id, loaded: true, exports: stub });
      require.cache[id] = mod;
    }
    return import("@/components/connections/SyncHealth");
  })();
  pinClock("2026-10-01T00:00:00Z"); // its twin again
  await call();
  h = await cronHealthByJob(5, new RealDate(nowMs()));
  const evText = textOf(SyncHealthPanel({ crons: h.filter((x) => x.job === "evening"), webhooks: [], unsignedProviders: [], cronLogReady: true, reconcile: null }));
  c.ok("the panel's evening line is the 7 PM run's (ok now), not the twin's", /last run Wed, Sep 30, 7:00 PM/.test(evText), evText.slice(0, 160));

  // =========================================================================
  c.head("5 · the panel says it in words");
  // lucide-react's client context cannot load under the react-server
  // condition; its icons render nothing here, so a stub stands in for them.
  {
    const id = require.resolve("lucide-react");
    const stub = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
    const mod = new (Module as unknown as { new (id: string): NodeModule })(id);
    Object.assign(mod, { filename: id, loaded: true, exports: stub });
    require.cache[id] = mod;
  }
  const { SyncHealth } = await import("@/components/connections/SyncHealth");
  await prisma.cronRun.deleteMany({ where: { job: "daily-clients" } });
  h = await cronHealthByJob(5, new RealDate(nowMs()));
  const text = textOf(SyncHealth({ crons: h, webhooks: [], unsignedProviders: [], cronLogReady: true, reconcile: null }));
  c.ok("a job with no row reads \"never recorded a run\"", /daily-clients.*?never recorded a run/.test(text));
  c.ok("a late job reads \"stale:\" and says how often it should run", /stale: last run .*it should run hourly/.test(text), text.match(/sync[^|]{0,160}/)?.[0]);
  c.ok("each job shows its cadence", /every 5 min/.test(text) && /4× a day/.test(text) && /not scheduled any more/.test(text));

  // =========================================================================
  c.head("6 · nothing left the machine");
  c.ok("no outbound call reached the network", fence.blocked.every((u) => /slack\.com|openphone|quo/i.test(u)), fence.blocked.join(", ") || "none attempted");
  c.ok("the database was this drill's", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/`));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
