// ---------------------------------------------------------------------------
// DRILL: OCT 13 2026 — SCHEDULED-JOB RELIABILITY AND DEAD-FEATURE CLEANUP
// (Jordan approved B6–B8 and C12; "the aryeo sync should be every 15 minutes,
// not every hour"; automation-audit item 13).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct13-cron-reliability.ts --logs /private/tmp/oct13-cron
//
// Drives the SHIPPED routes and libraries on an isolated PGlite:
//
//   1  THE SCHEDULE, read from the source: a 15-minute Aryeo job at
//      :10/:25/:40/:55 and the AI work job at :07/:22/:37/:52 in vercel.json
//      (and in cronHealth's expected list); the hourly sync no longer reads
//      orders/appointments, runs sessions, the Ready-to-send pass, any model
//      call, the legacy call sweeps, the transcript auto-analysis or the
//      booking-link tasks; daily no longer pulls QuickBooks; the unscheduled
//      relabel route and the "sync calls" action are gone.
//   2  GET /api/cron/aryeo: 200, its five steps in order, one CronRun "aryeo",
//      Aryeo only ever READ (every non-GET is refused and counted).
//   3  GET /api/cron/topics: 200, the AI queue first, the three sweeps after
//      it in a rotation that is a permutation, one CronRun "topics", no step
//      skipped for budget.
//   4  START ONLY WITH TIME TO FINISH: with less time left than one call
//      needs, the transcript queue, the AI queue, the drafting sweep and a
//      month's own draft loop START NOTHING (the work stays queued / owed);
//      with the time, the same call does the work.
//   5  ERRORS THAT STOPPED HAPPENING CLOSE THEMSELVES: a cron step's error
//      after three clean runs of that step; a server error after 24 h quiet;
//      a retired step's error; never a browser error, a fresh one, or a daily
//      step's that has not run since. A closed-by-itself error that comes back
//      is OPEN again but does not page ("is back" is for a person's fix).
//   6  THE 5-MINUTE RECOVERY DRAIN asks a PROGRAM email's switch before it
//      sends: switched off → held, still pending, nothing sent.
//   7  THE BOOKING-LINK TASKS are cancelled once (never completed), then the
//      step writes nothing.
//   8  RETIRED SWITCHES (cut_transcripts, publishing) are not listed.
//
// ISOLATION: PGlite on 127.0.0.1:6981; production is never opened; every
// non-loopback request is fenced (Aryeo/Stripe GETs answer an empty page);
// the model is a stub. Nothing is sent.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { NextRequest as NextRequestT } from "next/server";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = 6981;
const REPO = path.resolve(__dirname, "../..");
installNextStubs();

const requests: string[] = [];
const emptyPage = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  requests.push(`${method} ${url}`);
  if (method !== "GET") return null;
  if (url.startsWith("https://api.aryeo.com/")) return emptyPage({ data: [], meta: { current_page: 1, last_page: 1 } });
  if (url.startsWith("https://api.stripe.com/")) return emptyPage({ object: "list", data: [], has_more: false });
  return null;
});

// The model: one stubbed function (aiJsonWithUsage); every ledger, lease and
// switch around it is the shipped one.
let aiCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { prompt: string; schema?: { properties?: Record<string, unknown> } }) => {
        aiCalls++;
        const props = opts.schema?.properties ?? {};
        const result = "hook" in props && "points" in props
          ? {
              title: (/TOPIC:\s*(.+)/.exec(opts.prompt)?.[1] ?? "Drafted topic").trim().slice(0, 90), category: "Market Authority", hook: "The first weekend is the whole negotiation.",
              points: [
                { role: "PROOF", text: "Every listing that sat past the first weekend sold for less." },
                { role: "CONTEXT", text: "Buyers read days on market as a discount signal." },
                { role: "ACTION", text: "Price it right before the photos go live." },
              ],
              close: "That is why the first weekend decides your price.", captionCta: "DM me the word PRICE.", filmingNotes: null, gaps: [],
            }
          : "callKind" in props
            ? { callKind: "planning", plannedMonthKey: null, selectedTopics: [], discussedTopics: [], rejectedIdeas: [], facts: [], strategyProposals: [], priorities: [], todos: [] }
            : {};
        return { result, usage: { inputTokens: 100, outputTokens: 50 }, model: "drill-stub" };
      };
    },
  }),
);

const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { CRON_SECRET: "drill-secret" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { NextRequest } = await import("next/server");
  const auth = { authorization: "Bearer drill-secret" };
  const setSwitch = (key: string, enabled: boolean) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date() }, update: { enabled } });

  // =========================================================================
  c.head("1 · the schedule, read from the source");
  // =========================================================================
  {
    const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    const sched = (p: string) => vercel.crons.filter((x) => x.path === p).map((x) => x.schedule);
    c.ok("the Aryeo job runs every 15 minutes at :10 :25 :40 :55", JSON.stringify(sched("/api/cron/aryeo")) === JSON.stringify(["10,25,40,55 * * * *"]), JSON.stringify(sched("/api/cron/aryeo")));
    c.ok("the AI work job stays at :07 :22 :37 :52; the sync on the hour; the reconcile at :30", JSON.stringify(sched("/api/cron/topics")) === JSON.stringify(["7,22,37,52 * * * *"]) && JSON.stringify(sched("/api/cron/sync")) === JSON.stringify(["0 * * * *"]) && JSON.stringify(sched("/api/cron/reconcile")) === JSON.stringify(["30 * * * *"]));
    const { expectedCrons } = await import("@/lib/cronHealth");
    const aryeo = expectedCrons().find((e) => e.job === "aryeo");
    c.ok("cronHealth expects the job: 'aryeo', 15-minute cadence, 96 firings a day", aryeo?.cadenceMs === 15 * 60_000 && aryeo.firingsPerDay === 96, JSON.stringify(aryeo));
    const sync = read("src/app/api/cron/sync/route.ts").replace(/^\s*\/\/.*$/gm, "");
    const gone = ["syncAryeoOrders", "syncAryeoAppointments", "reconcileSessionRequests", "driveSessionBookings", "sweepReadyToSendAgainstAryeo", "driveTranscriptJobs", "drainAiQueueInParallel", "sweepOwedScripts", "sweepInterviewPlans", "sweepTopicBanks", "processMonthTranscript", "generateScriptsForMonth", "mintStrategyCallInvites", "sweepDriveTranscripts", "syncStrategyCallsFromCalendly"];
    const still = gone.filter((f) => sync.includes(f));
    c.ok("the hourly sync's code calls none of the moved or retired work", still.length === 0, still.join(", ") || "none");
    c.ok("…and closes stale errors and the old booking-link tasks instead", /step\("errorAutoResolve"/.test(sync) && /step\("retireCallInvites"/.test(sync));
    const ary = read("src/app/api/cron/aryeo/route.ts");
    const order = ["step(\"orders\"", "step(\"appointments\"", "step(\"sessionRequests\"", "step(\"sessionBookings\"", "step(\"readyToSendAryeo\""].map((s) => ary.indexOf(s));
    c.ok("the Aryeo job runs orders → appointments → session requests → bookings → Ready-to-send", order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), JSON.stringify(order));
    c.ok("the Aryeo job keeps the hourly's bounds (21-day appointments, ≤12 listings, 60 s of bookings)", /recentOnlyDays: 21/.test(ary) && /max: 12, budgetMs: 25_000/.test(ary) && /driveSessionBookings\(\{ budgetMs: 60_000 \}\)/.test(ary));
    const ai = read("src/app/api/cron/topics/route.ts");
    c.ok("the AI work job: AI queue first, every sweep with a start-only-with-time-to-finish floor", ai.indexOf('step("aiQueue"') > 0 && (ai.match(/minStartMs:/g) ?? []).length >= 5 && /TOPIC_REFRESH_MAX = 2;/.test(ai));
    const daily = read("src/app/api/cron/daily/route.ts").replace(/^\s*\/\/.*$/gm, "");
    c.ok("daily no longer pulls or re-sorts QuickBooks", !/syncQuickBooks|categoriseBooks/.test(daily));
    c.ok("the unscheduled relabel-deliverables route is gone", !fs.existsSync(path.join(REPO, "src/app/api/cron/relabel-deliverables/route.ts")));
    c.ok("the staff 'sync calls' action is gone", !/export async function syncCallsNow/.test(read("src/app/content/actions.ts")));
  }

  // ---- a month that owes work -----------------------------------------------
  const { encryptSecret } = await import("@/lib/integrations/crypto");
  const connect = (provider: string) => prisma.connection.upsert({ where: { provider }, create: { provider, status: "CONNECTED", secretEncrypted: encryptSecret(`drill-fake-${provider}`) }, update: { status: "CONNECTED", secretEncrypted: encryptSecret(`drill-fake-${provider}`) } });
  await connect("aryeo");
  const fx = await import("../_fixtures/representativeMonth");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const ct = await import("@/lib/contentTopics");
  const { scriptWorkForMonth } = await import("@/lib/contentDrafting");
  const MK = etMonthKey(new Date());
  const shell = await fx.createTestClientShell(prisma, { name: "Reliability TEST", slug: "reliability" });
  const seed = await fx.seedRepresentativeMonth(prisma, { clientId: shell.clientId, monthKey: MK, tier: "full", variant: "pro" });
  const owe = async (title: string, line: string) => {
    const id = (await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: seed.enrollmentId, title } })).id;
    await ct.selectTopicForMonth(id, seed.monthId, { source: "call", actor: { kind: "STAFF", staffUserId: null }, callRecordId: seed.callRecordId, status: "SELECTED", evidence: { excerpts: [{ speaker: "client", source: "call", text: line }] } });
    return id;
  };
  const scriptsFor = (topicId: string) => prisma.contentScript.count({ where: { topicId } });

  // =========================================================================
  c.head("2 · GET /api/cron/aryeo — the 15-minute Aryeo sync");
  // =========================================================================
  {
    const { GET } = await import("@/app/api/cron/aryeo/route");
    const denied = await GET(new NextRequest("http://127.0.0.1/api/cron/aryeo") as NextRequestT);
    c.ok("no bearer → 401", denied.status === 401);
    const before = requests.length;
    const res = await GET(new NextRequest("http://127.0.0.1/api/cron/aryeo", { headers: auth }) as NextRequestT);
    const body = (await res.json()) as Record<string, unknown> & { ms?: Record<string, number>; skipped?: string[] };
    const steps = Object.keys(body.ms ?? {});
    c.ok("200, ok", res.status === 200 && body.ok === true, `${res.status}`);
    c.ok("its five steps ran, in order", steps.join() === "orders,appointments,sessionRequests,sessionBookings,readyToSendAryeo", steps.join());
    c.ok("none skipped for budget, none errored", (body.skipped ?? []).length === 0 && !Object.keys(body).some((k) => k.endsWith("Error")), Object.keys(body).filter((k) => k.endsWith("Error")).map((k) => `${k}: ${String(body[k]).slice(0, 80)}`).join(" | ") || "clean");
    c.ok("session booking stays behind its switch (off → skipped, zero calls)", /session_booking is off/.test(JSON.stringify(body.sessionBookings)), JSON.stringify(body.sessionBookings).slice(0, 120));
    const run = await prisma.cronRun.findFirst({ where: { job: "aryeo" }, orderBy: { startedAt: "desc" } });
    c.ok("one CronRun 'aryeo', finished ok", !!run?.finishedAt && run.ok === true, `${run?.ok} ${run?.error ?? ""}`);
    const mine = requests.slice(before).filter((r) => r.includes("api.aryeo.com"));
    c.ok("Aryeo was asked (the count is not vacuous) and only ever READ", mine.length > 0 && mine.every((r) => r.startsWith("GET ")), `${mine.length} request(s): ${[...new Set(mine.map((r) => r.split("?")[0]))].join(", ").slice(0, 200)}`);
  }

  // =========================================================================
  c.head("3 · GET /api/cron/topics — the AI work job");
  // =========================================================================
  {
    const { GET } = await import("@/app/api/cron/topics/route");
    const res = await GET(new NextRequest("http://127.0.0.1/api/cron/topics", { headers: auth }) as NextRequestT);
    const body = (await res.json()) as Record<string, unknown> & { ms?: Record<string, number>; skipped?: string[]; order?: string[] };
    const steps = Object.keys(body.ms ?? {});
    c.ok("200", res.status === 200);
    c.ok("the AI queue ran first, then the three sweeps", steps[0] === "aiQueue" && steps.length === 4 && ["transcriptJobs", "scriptDrafting", "topicBanks"].every((s) => steps.includes(s)), steps.join());
    c.ok("in this tick's rotation (a permutation of the three)", JSON.stringify(body.order) === JSON.stringify(steps.slice(1)) && new Set(body.order).size === 3, JSON.stringify(body.order));
    c.ok("with every switch off (no rows) the sweeps report skipped", /transcript_jobs is off/.test(JSON.stringify(body.transcriptJobs)) && /script_drafting is off/.test(JSON.stringify(body.scriptDrafting)) && /topic_refresh is off/.test(JSON.stringify(body.topicBanks)));
    c.ok("nothing skipped for budget", (body.skipped ?? []).length === 0);
    const run = await prisma.cronRun.findFirst({ where: { job: "topics" }, orderBy: { startedAt: "desc" } });
    c.ok("one CronRun 'topics', finished ok", !!run?.finishedAt && run.ok === true, `${run?.ok} ${run?.error ?? ""}`);
  }

  // =========================================================================
  c.head("4 · start only with time to finish");
  // =========================================================================
  {
    for (const k of ["script_drafting", "ai_runs", "transcript_jobs"]) await setSwitch(k, true);
    const tj = await import("@/lib/transcriptJobs");
    const { setAutomationConfigField } = await import("@/lib/programAutomation");
    await setAutomationConfigField("transcript_jobs", tj.BACKLOG_FIELD, tj.INCLUDE_BACKLOG, "drill", "transcript_backlog_choice");
    const queued = await prisma.programTranscriptJob.count({ where: { state: "QUEUED" } });
    c.ok("precondition: the fixture's pasted transcript has jobs QUEUED", queued >= 2, `${queued}`);
    const short = await tj.driveTranscriptJobs({ max: 3, budgetMs: 60_000, minStartMs: tj.TRANSCRIPT_JOB_MIN_START_MS, leaseBy: "drill" });
    c.ok("transcript queue, 60 s left of a 120 s floor: starts NOTHING, every job still QUEUED", "ran" in short && short.ran === 0 && (await prisma.programTranscriptJob.count({ where: { state: "QUEUED" } })) === queued, JSON.stringify(short).slice(0, 160));
    const long = await tj.driveTranscriptJobs({ max: 3, budgetMs: 200_000, minStartMs: tj.TRANSCRIPT_JOB_MIN_START_MS, leaseBy: "drill" });
    c.ok("…with 200 s left: the same call runs them", "ran" in long && long.ran >= 1 && long.failed === 0, JSON.stringify(long).slice(0, 160));

    const drafting = await import("@/lib/contentDrafting");
    const F = await owe("Three numbers to read before you list", "I make every seller look at three numbers before we talk about a list price.");
    const owedF = (await scriptWorkForMonth(seed.monthId)).some((w) => w.topicId === F && (w.readiness === "FROM_CALL" || w.readiness === "FROM_ANSWERS"));
    c.ok("precondition: F is owed a draft", owedF);
    const aiBefore = aiCalls;
    const s1 = await drafting.sweepOwedScripts({ max: 6, budgetMs: 60_000, minStartMs: drafting.SCRIPT_DRAFT_MIN_START_MS });
    c.ok("drafting sweep, 60 s left of a 90 s floor: drafts nothing, says it ran out of time, no model call", "months" in s1 && s1.drafted === 0 && s1.outOfTime === true && aiCalls === aiBefore && (await scriptsFor(F)) === 0, JSON.stringify(s1).slice(0, 160));
    const m1 = await drafting.draftOwedScriptsForMonth(seed.monthId, { requestedBy: "cron", unattended: true, deadline: Date.now() + 30_000, minStartMs: drafting.SCRIPT_DRAFT_MIN_START_MS });
    c.ok("a month's own loop checks the clock before EACH script: 30 s to a 90 s floor → none started", m1.drafted === 0 && m1.outOfTime === true && m1.outcomes.length === 0 && aiCalls === aiBefore, JSON.stringify({ d: m1.drafted, t: m1.outOfTime }));
    const s2 = await drafting.sweepOwedScripts({ max: 6, budgetMs: 200_000, minStartMs: drafting.SCRIPT_DRAFT_MIN_START_MS });
    c.ok("…with 200 s left the sweep drafts F, once", "months" in s2 && s2.drafted >= 1 && s2.outOfTime === false && (await scriptsFor(F)) === 1, JSON.stringify(s2).slice(0, 160));
    const m2 = await drafting.draftOwedScriptsForMonth(seed.monthId, { requestedBy: "drill", unattended: false });
    c.ok("a person's click passes no deadline and is never stopped for time", m2.outOfTime === false);

    const q = await import("@/lib/aiQueue");
    const G = await owe("Why the list price is a marketing decision", "The list price is an ad, not a valuation, and I say that to every seller.");
    const enq = await q.enqueueAiJob({ job: { job: "script_topic", topicId: G, monthId: seed.monthId }, enrollmentId: seed.enrollmentId, clientId: shell.clientId, requestedBy: "drill@realtourpilot.com" });
    c.ok("a person's queued draft is waiting", enq.ok === true && !!enq.runId, JSON.stringify(enq));
    const d1 = await q.drainAiQueueInParallel({ origin: "cron", budgetMs: 60_000, minStartMs: 90_000, maxPerWorker: 2 });
    const row1 = await prisma.programAiRun.findUniqueOrThrow({ where: { id: enq.runId! } });
    c.ok("AI queue, 60 s left of a 90 s floor: claims nothing — the draft stays QUEUED, attempts untouched", d1.ran === 0 && row1.status === "QUEUED" && row1.attempts === 0 && d1.waiting === 1, `${JSON.stringify(d1)} · ${row1.status}/${row1.attempts}`);
    const d2 = await q.drainAiQueueInParallel({ origin: "cron", budgetMs: 200_000, minStartMs: 90_000, maxPerWorker: 2 });
    const row2 = await prisma.programAiRun.findUniqueOrThrow({ where: { id: enq.runId! } });
    c.ok("…with 200 s left it drafts it, attempt 1", d2.done === 1 && row2.status === "SUCCEEDED" && row2.attempts === 1 && (await scriptsFor(G)) === 1, `${JSON.stringify(d2)} · ${row2.status}/${row2.attempts}`);
  }

  // =========================================================================
  c.head("5 · errors that stopped happening close themselves");
  // =========================================================================
  {
    const tracker = await import("@/lib/errorTracker");
    const { cronBudget } = await import("@/lib/cron");
    tracker.setErrorTrackingForTests(true);
    const run = (s: string) => ({ startedAt: new Date(), summary: s, error: null });
    const seen = new Date(Date.now() - 60_000);
    const ok = JSON.stringify({ ms: { s1: 5 } });
    const failed = JSON.stringify({ s1Error: "boom", ms: { s1: 5 } });
    const absent = JSON.stringify({ ms: { other: 5 } });
    const now = new Date();
    c.ok("pure: three clean runs → closed", /ran cleanly 3 times/.test(tracker.cronStepResolution("s1", seen, [run(ok), run(ok), run(ok)], now) ?? ""));
    c.ok("pure: two clean runs, an hour later → still open", tracker.cronStepResolution("s1", seen, [run(ok), run(ok)], now) === null);
    c.ok("pure: one clean run and 24 h quiet → closed", /no recurrence in 24 h/.test(tracker.cronStepResolution("s1", new Date(Date.now() - 25 * 3_600_000), [run(ok)], now) ?? ""));
    c.ok("pure: a failure since stops the count", tracker.cronStepResolution("s1", seen, [run(ok), run(failed), run(ok), run(ok)], now) === null);
    c.ok("pure: a daily step not run since, 25 h on → still open", tracker.cronStepResolution("s1", new Date(Date.now() - 25 * 3_600_000), [], now) === null);
    c.ok("pure: a step absent from three runs of its job, 25 h on → closed as retired", /no longer runs/.test(tracker.cronStepResolution("s1", new Date(Date.now() - 25 * 3_600_000), [run(absent), run(absent), run(absent)], now) ?? ""));

    const bells = () => prisma.notification.count({ where: { kind: "error_report" } });
    const tick = async (fail: boolean) => {
      await sleep(5);
      const r = cronBudget(150_000, Date.now(), "drilljob");
      await r.step("s1", async () => { if (fail) throw new TypeError("drill: a real bug in s1"); return { fine: true }; });
      await r.finish();
      await sleep(5);
    };
    const row = () => prisma.errorEvent.findFirst({ where: { route: "cron:drilljob/s1" } });
    await tick(true);
    const r0 = await row();
    const bellsAfterNew = await bells();
    c.ok("a step that throws a real bug: one OPEN row, and the owner is told (a NEW error)", r0?.status === "OPEN" && bellsAfterNew >= 1, `${r0?.status} · ${bellsAfterNew} bell(s)`);
    await tick(false);
    await tick(false);
    c.ok("two clean runs later it is still OPEN", (await row())?.status === "OPEN");
    await tick(false);
    const r3 = await row();
    c.ok("the third clean run closes it: FIXED, resolvedBy says why (auto:)", r3?.status === "FIXED" && tracker.isAutoResolved(r3.resolvedBy) && /3 times/.test(r3.resolvedBy ?? ""), `${r3?.status} · ${r3?.resolvedBy}`);
    // Past the 6-hour per-error dedupe, so an alert WOULD be claimed if one
    // were attempted: the claim stamps lastAlertedAt, which is the witness.
    const longAgo = new Date(Date.now() - 7 * 3_600_000);
    await prisma.errorEvent.update({ where: { id: r3!.id }, data: { lastAlertedAt: longAgo } });
    await tick(true);
    const r4 = await row();
    c.ok("it happens again: OPEN, reopened, counted — but NO 'is back' page (nobody claimed a fix)", r4?.status === "OPEN" && r4.reopenCount === 1 && r4.count === 2 && r4.lastAlertedAt?.getTime() === longAgo.getTime() && (await bells()) === bellsAfterNew, `${r4?.status} reopen ${r4?.reopenCount} · alerted ${r4?.lastAlertedAt?.toISOString()} · bells ${await bells()} vs ${bellsAfterNew}`);
    // …whereas a PERSON's fix that fails still pages, exactly as before.
    await tracker.setErrorStatus(r4!.id, "FIXED", "jordan@drill.invalid");
    await prisma.errorEvent.update({ where: { id: r4!.id }, data: { lastAlertedAt: longAgo } });
    await tick(true);
    const r5 = await row();
    c.ok("a person's FIXED that fails again still pages 'is back' (the alert is claimed)", r5?.status === "OPEN" && r5.reopenCount === 2 && (r5.lastAlertedAt?.getTime() ?? 0) > Date.now() - 60_000, `${r5?.status} · alerted ${r5?.lastAlertedAt?.toISOString()}`);

    const old = new Date(Date.now() - 25 * 3_600_000);
    const mk = (message: string, source: "server-action" | "background" | "client" | "cron", route: string, at: Date) =>
      tracker.recordError({ error: new Error(message), source, route, path: null, at, alert: false });
    const sa = await mk("drill: server action broke yesterday", "server-action", "/app/content/actions", old);
    const bg = await mk("drill: background area quiet a day", "background", "review:approve/dropboxCopy", old);
    const cl = await mk("drill: a browser error yesterday", "client", "/portal/[token]", old);
    const fresh = await mk("drill: a server action broke just now", "server-action", "/app/clients/actions", new Date());
    const retired = await mk("drill: a step that no longer exists", "cron", "cron:drilljob/goneStep", old);
    const daily = await mk("drill: yesterday's daily step", "cron", "cron:dailydrill/booksSync", old);
    const res = await tracker.autoResolveQuietErrors();
    const st = async (id: string | undefined) => (await prisma.errorEvent.findUnique({ where: { id: id ?? "" } }))?.status;
    c.ok("hourly sweep: a server action's and a background area's errors quiet 24 h → FIXED", (await st(sa?.id)) === "FIXED" && (await st(bg?.id)) === "FIXED", JSON.stringify(res));
    c.ok("…a browser error is left alone, and so is a fresh server error", (await st(cl?.id)) === "OPEN" && (await st(fresh?.id)) === "OPEN");
    c.ok("…a retired step's error (its job ran since, without it) → FIXED", (await st(retired?.id)) === "FIXED");
    c.ok("…a daily step that has not run since stays OPEN", (await st(daily?.id)) === "OPEN");
    tracker.setErrorTrackingForTests(false);
    c.ok("off the production deployment the sweep does nothing", "skipped" in (await tracker.autoResolveQuietErrors()));
  }

  // =========================================================================
  c.head("6 · the 5-minute recovery drain asks a program email's switch first");
  // =========================================================================
  {
    const sent = requests.length;
    const msg = await prisma.outboxMessage.create({ data: { channel: "email", toRef: "seat@drill.invalid", clientId: shell.clientId, body: "Kyle replied to your message.", state: "pending", dedupeKey: `program_message:drill-seat:${Date.now()}`, requestedBy: "drill" } });
    c.ok("precondition: program_message_notice has no row (off)", !(await prisma.programAutomation.findUnique({ where: { key: "program_message_notice" } })));
    const { GET } = await import("@/app/api/cron/gmail/route");
    const res = await GET(new NextRequest("http://127.0.0.1/api/cron/gmail", { headers: auth }) as NextRequestT);
    const body = (await res.json()) as Record<string, unknown>;
    const rec = body.outboxRecover as { drained?: { held?: number; refused?: number; sent?: number }; heldSwitchedOff?: string[] } | undefined;
    const after = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: msg.id } });
    c.ok("the row is HELD for its switch, not attempted", (rec?.heldSwitchedOff ?? []).some((s) => /program_message: program_message_notice is off/.test(s)) && (rec?.drained?.held ?? 0) >= 1 && (rec?.drained?.sent ?? 0) === 0, JSON.stringify(rec).slice(0, 220));
    c.ok("…still pending, never attempted, nothing refused-as-failed", after.state === "pending" && after.attempts === 0 && after.leaseBy === null, `${after.state} attempts ${after.attempts}`);
    c.ok("…and nothing left for Google", !requests.slice(sent).some((r) => /gmail\.googleapis|googleapis\.com\/gmail/.test(r) && r.startsWith("POST")));
  }

  // =========================================================================
  c.head("7 · the booking-link tasks retire once");
  // =========================================================================
  {
    const { retireStrategyCallInvites } = await import("@/lib/contentCalls");
    await prisma.smartTask.createMany({
      data: [
        { title: "Send Reliability TEST their October strategy-call booking link", taskType: "comms_followup", status: "OPEN", source: "content_program", dedupeKey: "content-call-invite-drill-open" },
        { title: "Send … link (sent)", taskType: "comms_followup", status: "COMPLETED", source: "content_program", dedupeKey: "content-call-invite-drill-done", completedAt: new Date() },
      ],
    });
    const r1 = await retireStrategyCallInvites();
    const open = await prisma.smartTask.findFirstOrThrow({ where: { dedupeKey: "content-call-invite-drill-open" } });
    const done = await prisma.smartTask.findFirstOrThrow({ where: { dedupeKey: "content-call-invite-drill-done" } });
    c.ok("the open one is CANCELLED (never COMPLETED — no link was sent); the sent one keeps its history", r1.cancelled === 1 && open.status === "CANCELLED" && done.status === "COMPLETED", `${JSON.stringify(r1)} ${open.status}/${done.status}`);
    c.ok("the next tick finds nothing and writes nothing", (await retireStrategyCallInvites()).cancelled === 0);
  }

  // =========================================================================
  c.head("8 · retired switches are not listed");
  // =========================================================================
  {
    const pa = await import("@/lib/programAutomation");
    await setSwitch("cut_transcripts", true);
    const listed = (await pa.allAutomations()).map((a) => a.key);
    c.ok("cut_transcripts (ON in the database) and publishing are not in the listing", !listed.includes("cut_transcripts") && !listed.includes("publishing") && listed.length === pa.AUTOMATION_KEYS.length - 2, `${listed.length} of ${pa.AUTOMATION_KEYS.length}`);
    c.ok("the keys themselves remain (stored rows and the library still name them)", pa.isAutomationKey("cut_transcripts") && pa.isAutomationKey("publishing") && pa.isRetiredAutomation("publishing"));
  }

  c.head("9 · nothing left the machine");
  c.ok("every outbound attempt was stopped at the fence", fence.blocked.every((u) => !/^https?:\/\/(127\.|localhost)/.test(u)), `${fence.blocked.length} blocked`);
  c.ok("no non-GET reached Aryeo in the whole drill", !requests.some((r) => r.includes("api.aryeo.com") && !r.startsWith("GET ")));
  c.ok("the database was this drill's", (process.env.DATABASE_URL ?? "").includes(`127.0.0.1:${PORT}`));

  quiet.restore();
  c.summary();
  await drill.stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
