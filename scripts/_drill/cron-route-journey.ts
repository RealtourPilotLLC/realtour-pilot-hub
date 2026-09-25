// ---------------------------------------------------------------------------
// DRILL: THE HOURLY CRON ROUTE ON A REPRESENTATIVE MONTH (CP-15, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cron-route-journey.ts
//
// The REAL `GET /api/cron/sync` — bearer token, every step, the shipped code
// around one stubbed function (the model call) — against the full-tier
// representative month (scripts/_fixtures/representativeMonth.ts, Pro), on an
// isolated Postgres. What harness-selftest.ts proved for one tick, this drives
// through the shapes production will actually meet:
//
//   0. The deploy stamp. OLD (cron.ts at 7d0d5c9): a run records no build, even
//      with VERCEL_GIT_COMMIT_SHA set. NEW: the first 12 characters of
//      VERCEL_GIT_COMMIT_SHA, else HUB_COMMIT_SHA (CLI deploys), else nothing;
//      lastRunDeploy (what /content/monitoring shows) reads it back.
//   1. No bearer, a wrong bearer: 401, and no run recorded.
//   Aryeo and Stripe are connected with fake keys and every GET to them gets an
//   empty page (the quiet hour), so a run can finish ok; any other method is
//   refused and counted.
//   2. Production's switch state (no ProgramAutomation rows): 200, the program
//      steps report skipped, no OutboxMessage and no ProgramAiRun, the owed
//      topic undrafted, the pasted transcript's jobs still QUEUED.
//   3. script_drafting + ai_runs + transcript_jobs ON: ONE GET drafts exactly
//      what scriptWorkForMonth says the month owes, runs the transcript jobs,
//      and the CronRun row is ok with the deploy stamp.
//   4. Providers configured and unreachable, TWO CONCURRENT GETs, the first to
//      reach the model held there until the other finishes: both 200; a topic
//      both runs claim at once is drafted once; no outbox message, signup or
//      doubled notification. And a run whose work list went stale while the
//      other run drafted a topic start to finish does NOT draft it again (it
//      used to: a second version and a second paid run, because runAiJson
//      freed the dedupe key when the model returned and nothing re-checked).
//      Now the sweep re-checks before claiming, holds the key until the
//      version is written, and skips it as raced — no second AI run at all.
//   5. CRASH RECOVERY: a GET in a child process, killed (SIGKILL) from inside
//      the model stub mid-draft, leaves a CronRun with no finishedAt and a
//      RUNNING AI run holding its lease and dedupe key. The next GET does NOT
//      draft over it (the lease holds); with the lease backdated, the next GET
//      reclaims it and drafts the topic exactly once.
//   6. A switch turned OFF between runs (ai_runs, the Sep 23 regression): the
//      transcript and drafting steps report PAUSED, the job goes back to QUEUED
//      with its attempt returned, and no error is stamped anywhere. Back ON,
//      both resume.
//   7. Across every run, parent and child: zero non-GET requests to
//      api.aryeo.com (the GETs it did try are counted, so this is not vacuous).
//
// NOT PROVEN HERE — and NOT to be reported as covered (CP-15 item 6 / §8
// "normal Postgres duplicate races"): anything that needs TWO database
// sessions. PGlite is one session behind the harness socket, and the harness
// serves one transaction at a time (processQueue pins the handler that holds
// it), so in this drill two runs never hold overlapping transactions and
// pg_advisory_xact_lock is never CONTENDED (the same session may take it
// twice). The route does take such locks — brand-ack (brandProfile), Topaz's
// spend slot (topazJobs), lockFilmingForProject (deliverableOutputs) — so a
// missing or mis-keyed lock, or a lost update between two overlapping
// transactions, would pass here. What IS proven: unique-key and
// compare-and-set claims interleaved at statement boundaries, lease reclaim
// after a SIGKILL, and (because PGlite is real Postgres) that every lock call
// the route reaches has a valid signature — a 42883 like Sep 18's missing
// ::int4 cast would fail here. Closing the gap needs this journey against a
// disposable REAL Postgres (a local server or a throwaway Neon branch, never
// production) with two separate processes; that has not been run.
//
// ISOLATION. _harness.ts: PGlite on 127.0.0.1:5532 (DRILL_PORT overrides); the
// child process connects to the SAME socket and never boots or pushes
// anything. Every .env secret is blanked, fetch AND raw sockets are fenced in
// both processes. Provider credentials in section 4+ are fakes the fence
// refuses. Nothing is sent.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import type { NextRequest as NextRequestT } from "next/server";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, pinDrillEnv, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5532);
const REPO = path.resolve(__dirname, "../..");
const CHILD = process.env.CRON_JOURNEY_CHILD === "1";
/** Requests (method + url) the fence saw, appended by BOTH processes: a
 *  SIGKILLed child cannot report at exit, so it writes as it goes. */
const TRACE = process.env.CRON_JOURNEY_TRACE ?? path.join(os.tmpdir(), `cron-route-journey-${PORT}-${process.pid}.log`);
/** cron.ts before CP-15. */
const BASE = "7d0d5c9";

installNextStubs();
// Aryeo and Stripe are CONNECTED (fake keys) and answer every GET with an empty
// page — the quiet hour the route normally meets, so a run can finish ok. Any
// other method, and every other host, is refused and counted.
const emptyPage = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  fs.appendFileSync(TRACE, `REQ ${method} ${url}\n`);
  if (method !== "GET") return null;
  if (url.startsWith("https://api.aryeo.com/")) return emptyPage({ data: [], meta: { current_page: 1, last_page: 1 } });
  if (url.startsWith("https://api.stripe.com/")) return emptyPage({ object: "list", data: [], has_more: false });
  return null;
});

// ---- the model boundary ---------------------------------------------------
// One function is fake: aiJsonWithUsage. runAiJson's ledger, lease, dedupeKey
// and the ai_runs gate around it are the shipped ones. The answer is shaped by
// the schema it was asked for, so every generator in the route gets something
// it can parse: a script for a draft, an empty analysis for a call, the house
// templates for an interview plan.
let aiCalls = 0;
let draftCalls = 0;
let onDraft: (() => void | Promise<void>) | null = null;
type Schema = { type?: string | string[]; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; minItems?: number; minimum?: number };
function fromSchema(s: Schema | undefined, key = ""): unknown {
  if (!s) return null;
  if (Array.isArray(s.enum)) return s.enum[0];
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (t === "object" || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, fromSchema(v, k)]));
  if (t === "array") return Array.from({ length: s.minItems ?? 0 }, () => fromSchema(s.items, key));
  if (t === "string") return `Drill ${key}`;
  if (t === "number" || t === "integer") return s.minimum ?? 1;
  if (t === "boolean") return false;
  return null;
}
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { prompt: string; schema?: Schema }) => {
        aiCalls++;
        const props = opts.schema?.properties ?? {};
        let result: unknown;
        if ("hook" in props && "points" in props) {
          draftCalls++;
          if (onDraft) await onDraft();
          const title = (/TOPIC:\s*(.+)/.exec(opts.prompt)?.[1] ?? "Drafted topic").trim().slice(0, 90);
          result = {
            title, category: "Market Authority", hook: "The first weekend is the whole negotiation.",
            points: [
              { role: "PROOF", text: "Every listing that sat past the first weekend sold for less." },
              { role: "CONTEXT", text: "Buyers read days on market as a discount signal." },
              { role: "ACTION", text: "Price it right before the photos go live." },
            ],
            close: "That is why the first weekend decides your price.", captionCta: "DM me the word PRICE.", filmingNotes: null, gaps: [],
          };
        } else if ("callKind" in props) {
          result = { callKind: "planning", plannedMonthKey: null, selectedTopics: [], discussedTopics: [], rejectedIdeas: [], facts: [], strategyProposals: [], priorities: [], todos: [] };
        } else {
          result = fromSchema(opts.schema);
        }
        return { result, usage: { inputTokens: 1200, outputTokens: 400 }, model: "drill-stub" };
      };
    },
  }),
);

const requestLines = () => (fs.existsSync(TRACE) ? fs.readFileSync(TRACE, "utf8").split("\n").filter((l) => l.startsWith("REQ ")) : []);

// ===========================================================================
// THE CHILD: one GET against the parent's database, killed mid-draft.
// ===========================================================================
async function child() {
  pinDrillEnv(PORT, { HUB_COMMIT_SHA: process.env.HUB_COMMIT_SHA ?? "" });
  // The parent's own reason, from this side: one session, unnamed statements.
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}&pgbouncer=true`;
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  onDraft = () => {
    fs.appendFileSync(TRACE, "CHILD KILLED IN MODEL STUB\n");
    process.kill(process.pid, "SIGKILL");
  };
  const { GET } = await import("@/app/api/cron/sync/route");
  const { NextRequest } = await import("next/server");
  fs.appendFileSync(TRACE, "CHILD GET START\n");
  const res = await GET(new NextRequest("http://127.0.0.1/api/cron/sync", { headers: { authorization: "Bearer drill-secret" } }));
  const body = (await res.json()) as Record<string, unknown>;
  fs.appendFileSync(TRACE, `CHILD GET FINISHED (should not happen): ${JSON.stringify({ scriptDrafting: body.scriptDrafting, err: body.scriptDraftingError })}\n`);
  process.exit(3);
}

// ===========================================================================
// THE PARENT
// ===========================================================================
async function main() {
  fs.writeFileSync(TRACE, "");
  const c = makeChecker();
  const { db, stop, url } = await bootDrillDb({ port: PORT, env: { HUB_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567" } });
  // Two processes share this ONE PGlite session in section 5. Prisma names its
  // prepared statements s0, s1, … per engine, so the two engines collide
  // (42P05), and a pgbouncer-mode engine's DEALLOCATE ALL erases the other's
  // (26000). Both engines therefore run unnamed statements (pgbouncer=true),
  // before any Prisma client exists.
  process.env.DATABASE_URL = `${url}&pgbouncer=true`;
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { GET } = await import("@/app/api/cron/sync/route");
  const { NextRequest } = await import("next/server");
  const fx = await import("../_fixtures/representativeMonth");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const { scriptWorkForMonth } = await import("@/lib/contentDrafting");
  const ct = await import("@/lib/contentTopics");
  const MK = etMonthKey(new Date());

  type Body = Record<string, unknown> & { ok?: boolean; ms?: Record<string, number>; skipped?: string[]; timedOut?: string[]; deploy?: string };
  const get = async (auth: string | null = "Bearer drill-secret"): Promise<{ status: number; body: Body; wall: number }> => {
    const t0 = Date.now();
    const res = await GET(new NextRequest("http://127.0.0.1/api/cron/sync", { headers: auth ? { authorization: auth } : {} }) as NextRequestT);
    return { status: res.status, body: (await res.json()) as Body, wall: Date.now() - t0 };
  };
  const errorsOf = (b: Body) => Object.keys(b).filter((k) => k.endsWith("Error")).map((k) => `${k.slice(0, -5)}: ${String(b[k]).slice(0, 100)}`);
  const describe = (label: string, r: { status: number; body: Body; wall: number }) => {
    const errs = errorsOf(r.body);
    console.log(`    ${label}: ${r.status} in ${(r.wall / 1000).toFixed(1)}s · ${Object.keys(r.body.ms ?? {}).length} steps · errored ${errs.length}${errs.length ? `\n      ${errs.join("\n      ")}` : ""}`);
  };
  const setSwitch = (key: string, enabled: boolean) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date() }, update: { enabled, enabledBy: "drill", enabledAt: new Date() } });
  const latestRun = () => prisma.cronRun.findFirst({ where: { job: "sync" }, orderBy: { startedAt: "desc" } });
  const summaryOf = (s: string | null | undefined) => { try { return JSON.parse(s ?? "{}") as Body; } catch { return {} as Body; } };

  // =========================================================================
  c.head("0 · the deploy stamp: OLD cron.ts records no build; NEW records it");
  // =========================================================================
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp15-cron-base-"));
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
    const file = path.join(dir, "cron.base.ts");
    const src = execFileSync("git", ["show", `${BASE}:src/lib/cron.ts`], { cwd: REPO, encoding: "utf8" })
      .replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
    fs.writeFileSync(file, src);
    const old = (await import(file)) as { cronBudget: (b: number, s: number, j?: string) => { finish: () => Promise<void> } };
    const cron = await import("@/lib/cron");
    const stampOf = async (job: string) => summaryOf((await prisma.cronRun.findFirst({ where: { job }, orderBy: { startedAt: "desc" } }))?.summary).deploy;
    const envSaved = { V: process.env.VERCEL_GIT_COMMIT_SHA, H: process.env.HUB_COMMIT_SHA };

    process.env.VERCEL_GIT_COMMIT_SHA = "fedcba9876543210fedcba9876543210fedcba98";
    await old.cronBudget(250_000, Date.now(), "stamp-old").finish();
    c.ok("OLD: with VERCEL_GIT_COMMIT_SHA set, the run's summary carries no deploy", (await stampOf("stamp-old")) === undefined);
    await cron.cronBudget(250_000, Date.now(), "stamp-vercel").finish();
    c.ok("NEW: VERCEL_GIT_COMMIT_SHA → its first 12 characters", (await stampOf("stamp-vercel")) === "fedcba987654", String(await stampOf("stamp-vercel")));
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.HUB_COMMIT_SHA = "abcdef0123456789abcdef0123456789abcdef01";
    await cron.cronBudget(250_000, Date.now(), "stamp-hub").finish();
    c.ok("NEW: a CLI deploy's HUB_COMMIT_SHA when Vercel sets none", (await stampOf("stamp-hub")) === "abcdef012345", String(await stampOf("stamp-hub")));
    process.env.VERCEL_GIT_COMMIT_SHA = "";
    process.env.HUB_COMMIT_SHA = "   ";
    await cron.cronBudget(250_000, Date.now(), "stamp-none").finish();
    c.ok("NEW: neither set (or blank) → no stamp at all, never a guess", (await stampOf("stamp-none")) === undefined && cron.deployStamp() === null);
    const lr = await cron.lastRunDeploy("stamp-hub");
    c.ok("lastRunDeploy — what /content/monitoring shows — reads it back", lr?.deploy === "abcdef012345" && !!lr.finishedAt, JSON.stringify(lr));
    c.ok("…and says null for a run without one", (await cron.lastRunDeploy("stamp-old"))?.deploy === null);
    process.env.VERCEL_GIT_COMMIT_SHA = envSaved.V ?? "";
    process.env.HUB_COMMIT_SHA = envSaved.H ?? "";
    await prisma.cronRun.deleteMany({ where: { job: { startsWith: "stamp-" } } });
    try { fs.unlinkSync(path.join(dir, "node_modules")); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover temp file is harmless */ }
  }

  // =========================================================================
  c.head("1 · no bearer, wrong bearer → 401, nothing recorded");
  // =========================================================================
  {
    const none = await get(null);
    const wrong = await get("Bearer not-the-secret");
    c.ok("no Authorization header → 401", none.status === 401, JSON.stringify(none.body));
    c.ok("a wrong bearer → 401", wrong.status === 401, JSON.stringify(wrong.body));
    c.ok("no CronRun row was started for either", (await prisma.cronRun.count({ where: { job: "sync" } })) === 0);
  }

  // ---- the month ----------------------------------------------------------
  const { encryptSecret } = await import("@/lib/integrations/crypto");
  const connect = (provider: string) => prisma.connection.upsert({ where: { provider }, create: { provider, status: "CONNECTED", secretEncrypted: encryptSecret(`drill-fake-${provider}`) }, update: { status: "CONNECTED", secretEncrypted: encryptSecret(`drill-fake-${provider}`) } });
  await connect("aryeo");
  await connect("stripe");
  const shell = await fx.createTestClientShell(prisma, { name: "Cron Journey TEST", slug: "cronjourney" });
  const seed = await fx.seedRepresentativeMonth(prisma, { clientId: shell.clientId, monthKey: MK, tier: "full", variant: "pro" });
  const bankTopic = async (title: string) => (await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: seed.enrollmentId, title } })).id;
  /** A bank topic the client picked on the call, with their own words: owed a draft. */
  const owe = async (title: string, line: string) => {
    const id = await bankTopic(title);
    await ct.selectTopicForMonth(id, seed.monthId, { source: "call", actor: { kind: "STAFF", staffUserId: null }, callRecordId: seed.callRecordId, status: "SELECTED", evidence: { excerpts: [{ speaker: "client", source: "call", text: line }] } });
    return id;
  };
  const scriptsFor = async (topicId: string) => {
    const rows = await prisma.contentScript.findMany({ where: { topicId }, select: { id: true } });
    return Promise.all(rows.map(async (r) => ({ id: r.id, versions: await prisma.contentScriptVersion.count({ where: { scriptId: r.id } }) })));
  };
  const owedNow = async () => (await scriptWorkForMonth(seed.monthId)).filter((w) => w.readiness === "FROM_CALL" || w.readiness === "FROM_ANSWERS").map((w) => w.topicId).sort();
  // Bank topics the fixture has not used (A–E are the first two of each pillar).
  const F = await owe("Three numbers to read before you list", "I make every seller look at three numbers before we talk about a list price.");

  // =========================================================================
  c.head("2 · production's switches (no rows): everything program-side stands still");
  // =========================================================================
  {
    c.ok("the month owes exactly one draft (F, from the call)", JSON.stringify(await owedNow()) === JSON.stringify([F]), JSON.stringify(await owedNow()));
    const jobsQueued = await prisma.programTranscriptJob.count({ where: { state: "QUEUED" } });
    const r = await get();
    describe("GET", r);
    const sd = r.body.scriptDrafting as { plans?: { skipped?: string }; drafts?: { skipped?: string } } | undefined;
    c.ok("200, ok", r.status === 200 && r.body.ok === true);
    c.ok("transcriptJobs reports skipped", /transcript_jobs is off/.test(JSON.stringify(r.body.transcriptJobs)), JSON.stringify(r.body.transcriptJobs));
    c.ok("scriptDrafting reports skipped (plans and drafts)", /off/.test(sd?.plans?.skipped ?? "") && /off/.test(sd?.drafts?.skipped ?? ""), JSON.stringify(sd));
    c.ok("programReminders and shareNotices report skipped", /skip|off/i.test(JSON.stringify(r.body.programReminders)) && /skip|off/i.test(JSON.stringify(r.body.shareNotices)), `${JSON.stringify(r.body.programReminders).slice(0, 80)} · ${JSON.stringify(r.body.shareNotices).slice(0, 80)}`);
    c.ok("no OutboxMessage, no ProgramAiRun", (await prisma.outboxMessage.count()) === 0 && (await prisma.programAiRun.count()) === 0);
    c.ok("F is still undrafted", (await scriptsFor(F)).length === 0);
    c.ok("the pasted transcript's jobs are still QUEUED", jobsQueued >= 2 && (await prisma.programTranscriptJob.count({ where: { state: "QUEUED" } })) === jobsQueued, `${jobsQueued} queued`);
    const run = await latestRun();
    c.ok("the CronRun row finished ok, stamped with the deploy", !!run?.finishedAt && run.ok === true && summaryOf(run.summary).deploy === "0123456789ab" && r.body.deploy === "0123456789ab", `${run?.ok} ${summaryOf(run?.summary).deploy} ${run?.error ?? ""}`);
  }

  // =========================================================================
  c.head("3 · the three switches ON: one GET drafts what the month owes");
  // =========================================================================
  {
    for (const k of ["script_drafting", "ai_runs", "transcript_jobs"]) await setSwitch(k, true);
    const versionsBefore = await prisma.contentScriptVersion.count();
    const r = await get();
    describe("GET", r);
    const sd = r.body.scriptDrafting as { drafts?: { drafted?: number; failed?: number } } | undefined;
    c.ok("200, ok", r.status === 200 && r.body.ok === true);
    c.ok("drafted exactly one — the one owed", sd?.drafts?.drafted === 1 && sd.drafts.failed === 0, JSON.stringify(sd?.drafts).slice(0, 200));
    const fs1 = await scriptsFor(F);
    c.ok("F has one script, one version", fs1.length === 1 && fs1[0].versions === 1, JSON.stringify(fs1));
    c.ok("and only F: exactly one version was added in the whole database", (await prisma.contentScriptVersion.count()) === versionsBefore + 1);
    c.ok("nothing is owed now", (await owedNow()).length === 0, JSON.stringify(await owedNow()));
    const jobs = await prisma.programTranscriptJob.findMany({ select: { kind: true, state: true } });
    c.ok("the transcript jobs ran: INGEST and ANALYZE SUCCEEDED", jobs.length >= 2 && jobs.every((j) => j.state === "SUCCEEDED"), JSON.stringify(jobs));
    const run = await latestRun();
    c.ok("the CronRun row is ok, with the deploy stamp", !!run?.finishedAt && run.ok === true && summaryOf(run.summary).deploy === "0123456789ab", `${run?.ok} ${run?.error ?? ""}`);
    c.ok("still nothing queued to send", (await prisma.outboxMessage.count()) === 0);
  }

  // Every other provider from here on holds a credential the fence refuses —
  // the shape of a provider outage, which the route must ride out.
  for (const provider of ["aryeo_webhook", "dropbox", "calendly", "openphone", "openphone_webhook", "slack", "slack_user", "gmail", "quickbooks", "ai"]) await connect(provider);

  // =========================================================================
  c.head("4 · two GETs at once: both 200, nothing twice");
  // =========================================================================
  // Two owed topics, X then G (the sweep's order). Whichever run reaches the
  // model FIRST is held there until the other run has finished, so both
  // interleavings happen, every time, not by luck of the scheduler:
  //   · X — both runs claim it while the first is still in the model. The
  //     unique dedupeKey refuses the second: drafted once. The case the
  //     sweep's own comment promises.
  //   · G — the second run drafts G start to finish while the first is still
  //     held on X; the first then reaches G with the list it read BEFORE G had
  //     a script. It used to draft G again (the key had been freed when the
  //     other run's model call returned): a second version and a second paid
  //     run. Now the sweep re-checks before it claims and skips G as raced.
  {
    const X = await owe("How spring inventory changes your pricing", "Spring doubles the inventory on my streets, so the price has to be sharper in April.");
    const G = await owe("Why the list price is a marketing decision", "The list price is an ad, not a valuation, and I say that to every seller.");
    c.ok("the month owes X then G, in that order", JSON.stringify((await scriptWorkForMonth(seed.monthId)).filter((w) => w.readiness === "FROM_CALL").map((w) => w.topicId)) === JSON.stringify([X, G]));
    const before = {
      versions: await prisma.contentScriptVersion.count(), outbox: await prisma.outboxMessage.count(),
      signups: await prisma.programSignup.count(), since: new Date(),
    };
    let release!: () => void;
    const otherFinished = new Promise<void>((r) => { release = r; });
    let holding = false;
    onDraft = async () => { if (!holding) { holding = true; await otherFinished; } };
    const [r1, r2] = await Promise.all([get().finally(() => release()), get().finally(() => release())]);
    onDraft = null;
    describe("GET #1", r1);
    describe("GET #2", r2);
    c.ok("both answered 200", r1.status === 200 && r2.status === 200, `${r1.status} ${r2.status}`);
    const runsFor = async (t: string) => prisma.programAiRun.findMany({ where: { kind: "script_draft", createdAt: { gte: before.since }, scopeJson: { contains: t } }, select: { status: true, dedupeKey: true } });
    const xs = await scriptsFor(X);
    c.ok("X (claimed by both at once): one script, one version", xs.length === 1 && xs[0].versions === 1, JSON.stringify(xs));
    c.ok("X: one SUCCEEDED run — the second claim was refused by the dedupe key", (await runsFor(X)).filter((r) => r.status === "SUCCEEDED").length === 1, JSON.stringify(await runsFor(X)));
    const gs = await scriptsFor(G);
    const gRuns = (await runsFor(G)).filter((r) => r.status === "SUCCEEDED").length;
    const added = (await prisma.contentScriptVersion.count()) - before.versions;
    c.ok("G (a stale work list meets a finished draft): drafted once — one version, one paid run", gs.length === 1 && gs[0].versions === 1 && gRuns === 1,
      `${gs.length} script(s), ${gs[0]?.versions ?? 0} version(s), ${gRuns} SUCCEEDED run(s); ${added} version(s) added in all`);
    c.ok("  …the stale run never even started a model run for G (re-checked before claiming)", (await runsFor(G)).length === 1, JSON.stringify(await runsFor(G)));
    const tallyOf = (r: { body: Body }) => (r.body.scriptDrafting as { drafts?: { drafted?: number; skipped?: number; failed?: number } } | undefined)?.drafts ?? {};
    const t1 = tallyOf(r1), t2 = tallyOf(r2);
    c.ok("  …both races are counted as SKIPS, not failures: 2 drafted, 2 skipped (X's key, G already drafted), 0 failed", (t1.drafted ?? 0) + (t2.drafted ?? 0) === 2 && (t1.skipped ?? 0) + (t2.skipped ?? 0) === 2 && (t1.failed ?? 0) + (t2.failed ?? 0) === 0, JSON.stringify([t1, t2]));
    c.ok("every script run's dedupe key was released once its version was written (none left held)", (await prisma.programAiRun.count({ where: { dedupeKey: { not: null } } })) === 0);
    c.ok("G never got a second SCRIPT row (a duplicate is a version, not a script)", gs.length === 1);
    c.ok("no outbox message, no signup", (await prisma.outboxMessage.count()) === before.outbox && (await prisma.programSignup.count()) === before.signups);
    const fresh = await prisma.notification.findMany({ where: { createdAt: { gte: before.since } }, select: { kind: true, title: true, body: true, audience: true, userKey: true } });
    const seen = new Map<string, number>();
    for (const n of fresh) { const k = JSON.stringify(n); seen.set(k, (seen.get(k) ?? 0) + 1); }
    const twice = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    c.ok("no notification was raised twice by the pair", twice.length === 0, `${fresh.length} new${twice.length ? `, twice: ${twice.join(" | ").slice(0, 200)}` : ""}`);
    const runs = await prisma.cronRun.findMany({ where: { job: "sync", startedAt: { gte: before.since } }, select: { finishedAt: true, ok: true } });
    c.ok("two CronRun rows, both finished", runs.length === 2 && runs.every((x) => !!x.finishedAt));
  }

  // =========================================================================
  c.head("5 · crash recovery: killed mid-draft, then reclaimed exactly once");
  // =========================================================================
  {
    const H = await owe("What a price cut costs you after week two", "Every price cut after week two costs more than the cut itself, because buyers smell it.");
    // R01 (batch 2): X and G filled the Pro month's allowance, so H is an
    // EXTRA — kept, shown, never drafted unattended. That is the rule, and it
    // is asserted here on purpose; then the office raises the month's
    // allowance (§3: staff may change it immediately) so H is owed, which is
    // what this section's crash recovery is about.
    const hBefore = (await scriptWorkForMonth(seed.monthId)).find((w) => w.topicId === H)?.readiness;
    c.ok("R01: a topic past the month's allowance is an EXTRA, not owed", hBefore === "EXTRA", String(hBefore));
    const owedBefore = (await prisma.contentMonth.findUniqueOrThrow({ where: { id: seed.monthId }, select: { videosOwed: true } })).videosOwed;
    await prisma.contentMonth.update({ where: { id: seed.monthId }, data: { videosOwed: owedBefore + 4 } });
    c.ok("…the office raises the allowance, and H is owed (FROM_CALL)", (await scriptWorkForMonth(seed.monthId)).find((w) => w.topicId === H)?.readiness === "FROM_CALL");
    const t0 = new Date();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const p = spawn(process.execPath, [...process.execArgv, __filename], {
        cwd: REPO,
        env: { ...process.env, CRON_JOURNEY_CHILD: "1", CRON_JOURNEY_TRACE: TRACE, DRILL_PORT: String(PORT) },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      p.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
      p.on("exit", (code, signal) => { if (err.trim() && signal !== "SIGKILL") console.log(`    child stderr: ${err.slice(-600)}`); resolve({ code, signal }); });
    });
    const trace = fs.readFileSync(TRACE, "utf8");
    c.ok("the child was SIGKILLed from inside the model stub", exit.signal === "SIGKILL" && trace.includes("CHILD KILLED IN MODEL STUB"), JSON.stringify(exit) + (trace.match(/CHILD GET FINISHED.*$/m)?.[0] ?? ""));
    // Postgres ends a dead connection's transaction; PGlite is one session and
    // cannot know. If the child died inside one, end it the way Postgres would.
    const hung = db.isInTransaction();
    if (hung) await db.exec("ROLLBACK");
    c.ok("the child died outside any transaction (nothing had to be rolled back for it)", !hung);
    const dead = await prisma.cronRun.findFirst({ where: { job: "sync", startedAt: { gte: t0 } }, orderBy: { startedAt: "asc" } });
    c.ok("it left a CronRun with no finishedAt", !!dead && dead.finishedAt === null, JSON.stringify({ id: dead?.id, finishedAt: dead?.finishedAt }));
    c.ok("…whose checkpoint names the steps it finished before it died", Object.keys(summaryOf(dead?.summary).ms ?? {}).length > 10, `${Object.keys(summaryOf(dead?.summary).ms ?? {}).length} steps recorded`);
    const held = await prisma.programAiRun.findMany({ where: { status: "RUNNING" }, select: { id: true, kind: true, leaseUntil: true, dedupeKey: true, scopeJson: true } });
    c.ok("…and a RUNNING draft run for H holding its lease and dedupe key", held.length === 1 && held[0].kind === "script_draft" && !!held[0].dedupeKey && (held[0].leaseUntil?.getTime() ?? 0) > Date.now() && (held[0].scopeJson ?? "").includes(H), JSON.stringify(held));
    c.ok("H has no script", (await scriptsFor(H)).length === 0);

    const r1 = await get();
    describe("GET while the lease is held", r1);
    c.ok("200 — and it does NOT draft over a run that may still be alive", r1.status === 200 && (await scriptsFor(H)).length === 0 && (await prisma.programAiRun.count({ where: { status: "RUNNING" } })) === 1);

    await prisma.programAiRun.updateMany({ where: { status: "RUNNING" }, data: { leaseUntil: new Date(Date.now() - 60_000) } });
    await prisma.programTranscriptJob.updateMany({ where: { state: "RUNNING" }, data: { leaseUntil: new Date(Date.now() - 60_000) } });
    const r2 = await get();
    describe("GET after the lease is backdated", r2);
    const hs = await scriptsFor(H);
    c.ok("200 — the lease is reclaimed and H is drafted exactly once", r2.status === 200 && hs.length === 1 && hs[0].versions === 1, JSON.stringify(hs));
    const hRuns = await prisma.programAiRun.findMany({ where: { kind: "script_draft", scopeJson: { contains: H } }, select: { status: true, error: true } });
    c.ok("the dead run is FAILED (lease expired), one run SUCCEEDED, none RUNNING", hRuns.filter((x) => x.status === "FAILED" && /Lease expired/.test(x.error ?? "")).length === 1 && hRuns.filter((x) => x.status === "SUCCEEDED").length === 1 && !hRuns.some((x) => x.status === "RUNNING"), JSON.stringify(hRuns));
    const again = await get();
    c.ok("one more GET drafts nothing more", again.status === 200 && (await scriptsFor(H))[0].versions === 1 && (await scriptsFor(H)).length === 1);
  }

  // =========================================================================
  c.head("6 · ai_runs OFF between runs: paused, no error stamped; ON: resumes");
  // =========================================================================
  {
    const I = await owe("Reading a comparable sale like an appraiser", "I read every comparable the way an appraiser will, before the appraiser ever does.");
    const calls = await import("@/lib/contentCallRecords");
    const nextKey = (() => { const [y, m] = MK.split("-").map(Number); return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`; })();
    const rec = await calls.createManualCallRecord({ clientId: seed.clientId, callType: "MONTHLY_STRATEGY", scheduledStart: new Date(Date.now() - 86_400_000), targetMonthKey: nextKey, by: "drill", note: "drill: a second planning call" });
    await calls.attachPastedTranscript(rec, `Planning call for ${nextKey}. Client: I want to talk about open houses and how buyers behave when they walk in, and what they look at first. Jordan: good, and what else? Client: staging, and why the empty rooms feel smaller on video than in person.`, "drill");
    // A paste is a PERSON's request (requestedBy = who pasted), and
    // runTranscriptJob runs a person's request attended — past ai_runs. The
    // unattended shape is the one the Drive discovery queues, requestedBy
    // "cron"; that is the job the switch governs, so that is the job here.
    await prisma.programTranscriptJob.updateMany({ where: { callRecordId: rec }, data: { requestedBy: "cron" } });
    const analyze = await prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId: rec, kind: "ANALYZE" } });
    await setSwitch("ai_runs", false);
    const r = await get();
    describe("GET with ai_runs off", r);
    const tj = r.body.transcriptJobs as { paused?: string | null; failed?: number } | undefined;
    const sd = r.body.scriptDrafting as { drafts?: { paused?: string | null; failed?: number; drafted?: number } } | undefined;
    c.ok("200, and neither step errored", r.status === 200 && !("transcriptJobsError" in r.body) && !("scriptDraftingError" in r.body), errorsOf(r.body).join(" | "));
    c.ok("transcriptJobs reports PAUSED (the INGEST needs no model and ran)", !!tj?.paused && tj.failed === 0, JSON.stringify(tj));
    const a1 = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: analyze.id } });
    c.ok("the ANALYZE job is back to QUEUED with its attempt returned — not NEEDS_REVIEW", a1.state === "QUEUED" && a1.attempts === analyze.attempts && a1.lastError === null && a1.reviewReason === null, `${a1.state} attempts ${a1.attempts} ${a1.lastError ?? ""} ${a1.reviewReason ?? ""}`);
    c.ok("scriptDrafting reports PAUSED, drafted nothing, failed nothing", !!sd?.drafts?.paused && sd.drafts.failed === 0 && (sd.drafts.drafted ?? 0) === 0, JSON.stringify(sd?.drafts).slice(0, 200));
    c.ok("I is undrafted", (await scriptsFor(I)).length === 0);
    const autos = await prisma.programAutomation.findMany({ where: { key: { in: ["transcript_jobs", "script_drafting", "ai_runs"] } }, select: { key: true, lastError: true } });
    c.ok("no switch carries a stamped error (the Sep 23 regression)", autos.every((a) => a.lastError === null), JSON.stringify(autos));
    c.ok("and no job was parked with a 'disabled' reason", (await prisma.programTranscriptJob.count({ where: { OR: [{ reviewReason: { contains: "disabled" } }, { state: "NEEDS_REVIEW" }] } })) === 0);

    await setSwitch("ai_runs", true);
    const back = await get();
    describe("GET with ai_runs back on", back);
    const a2 = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: analyze.id } });
    c.ok("back ON: the ANALYZE job SUCCEEDED", a2.state === "SUCCEEDED", a2.state);
    c.ok("back ON: I is drafted, once", (await scriptsFor(I)).length === 1 && (await scriptsFor(I))[0].versions === 1);
  }

  // =========================================================================
  c.head("7 · Aryeo was only ever read");
  // =========================================================================
  {
    const lines = requestLines();
    const aryeo = lines.filter((l) => /^REQ \S+ https:\/\/api\.aryeo\.com\//.test(l));
    const writes = aryeo.filter((l) => !l.startsWith("REQ GET "));
    console.log(`    fence saw ${lines.length} request(s) across both processes; Aryeo: ${aryeo.length} (${[...new Set(aryeo.map((l) => l.split(" ")[1]))].join(", ") || "none"})`);
    c.ok("the Aryeo client did try the network (the count below is not vacuous)", aryeo.length > 0, `${aryeo.length}`);
    c.ok("zero non-GET requests to api.aryeo.com, parent and child", writes.length === 0, writes.slice(0, 5).join(" | ") || "none");
    c.ok("the child's requests are in the count too", fs.readFileSync(TRACE, "utf8").includes("CHILD GET START"));
  }

  c.head("8 · nothing left the machine");
  c.ok("every outbound attempt was stopped at the fence", fence.blocked.every((u) => !/^https?:\/\/(127\.|localhost)/.test(u)), `${fence.blocked.length} blocked in this process`);
  c.ok("no message was ever queued", (await prisma.outboxMessage.count()) === 0);
  c.ok("the database was this drill's", (process.env.DATABASE_URL ?? "").startsWith(`postgresql://postgres:postgres@127.0.0.1:${PORT}/`));
  console.log(`    model calls in this process: ${aiCalls} (${draftCalls} drafts)`);

  quiet.restore();
  c.summary();
  await stop();
  try { fs.rmSync(TRACE, { force: true }); } catch { /* harmless */ }
  process.exit(process.exitCode ?? 0);
}

(CHILD ? child() : main()).catch((e) => { console.error(e); process.exit(1); });
