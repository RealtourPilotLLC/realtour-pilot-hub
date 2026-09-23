// ---------------------------------------------------------------------------
// DRILL: THE SCHEDULED JOURNEY, ACTUALLY RUN (Sep 23 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/scheduled-journey.ts
//
// THE GAP THIS CLOSES. Three documents in a row have had to say the same thing:
// "no scheduled journey has been proven." Everything in batch 3 was exercised by
// a person pressing a button. The hourly cron — the thing that will actually run
// this program once Jordan turns it on — has never been shown to take a month
// that owes scripts and leave it with scripts. A manual click proves the
// generator. It proves nothing at all about the sweep, the switches, the budget,
// the dedupe, or the route step that calls them.
//
// So this runs the SCHEDULED PATH — the body of the hourly route's
// `scriptDrafting` step, with the arguments the route passes it, against a real
// Postgres, with the switches thrown the way Jordan would throw them.
//
// WHAT IT DOES NOT DO, AND WHY. It does not execute the route's HTTP shell. I
// tried; the 33-step body cannot survive this harness. PGlite's socket server
// closes the connection on ANY unique violation (SQLSTATE 23505), and a cron
// run hits them routinely by design — the notification dedupe key collided on
// the first attempt and every later query in the process failed with "Server
// has closed the connection". Production Postgres handles those collisions;
// PGlite's wire server does not. So the shell is proven by READING the route
// (section 8, at runtime, not from memory) and by exercising its auth gate,
// and the behaviour is proven by running what the step runs. Where the two meet
// is an assertion about source text, and it is labelled as one.
//
// WHAT IS ASSERTED, IN ORDER (each one states the OLD behaviour first):
//   1. Production's state today — no ProgramAutomation rows — draws no work at
//      all, through the route. The gate is the absence of a row.
//   2. script_drafting ON but ai_runs OFF writes NO script. Two gates, not one.
//   3. Both ON: the route drafts. The written-answers topic takes the answers
//      path, the call topic takes the excerpt path, PROPOSED and THIN are left.
//   4. A second run of the route drafts nothing — no duplicate versions.
//   5. A run in flight holds the exact dedupe key the next sweep would claim,
//      and an abandoned lease is reclaimed rather than blocking the topic forever.
//   6. The switch going off mid-sweep stops it; it does not burn the month.
//   7. The route's scriptDrafting step is wired to these two functions, read
//      from the route source at runtime rather than asserted from memory.
//
// ISOLATION. PGlite in-process Postgres, pinned to DATABASE_URL before any app
// module loads. Production Neon is never opened. Every outbound HTTP call is
// fenced to loopback and counted. The MODEL is stubbed at aiJsonWithUsage —
// the boundary inside runAiJson — so the real run ledger, lease, dedupe and
// ai_runs gate all execute; only the tokens are fake.
// ---------------------------------------------------------------------------
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";

// ---- the model boundary, stubbed before anything resolves it ---------------
let aiCalls = 0;
const aiPrompts: { system: string; prompt: string }[] = [];
let aiFailNext: string | null = null;
/** Runs INSIDE the model call, i.e. while the run row is RUNNING and holding
 *  its dedupe key. That is the only moment the key is observable. */
let aiHook: ((n: number) => Promise<void>) | null = null;
const generated = (title: string, tag: string) => ({
  title,
  category: "Market Authority",
  hook: `Hook for ${tag} — the thing nobody tells you first.`,
  points: [
    { role: "PROOF", text: `A concrete ${tag} example from the last month.` },
    { role: "CONTEXT", text: `Why ${tag} decides what the buyer offers.` },
    { role: "ACTION", text: `What to do about ${tag} before you list.` },
  ],
  close: `That is ${tag}, in short.`,
  captionCta: "DM me the word PRICE.",
  filmingNotes: null,
  gaps: [],
});

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
  const loaded = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
  // The model, and ONLY the model. runAiJson's ledger, lease, dedupeKey and the
  // ai_runs gate above it are the real ones — this replaces the tokens.
  if (request.endsWith("/integrations/ai") || request === "@/lib/integrations/ai") {
    return new Proxy(loaded, {
      get(t, k) {
        if (k === "aiJsonWithUsage") {
          return async (opts: { system: string; prompt: string }) => {
            aiCalls++;
            aiPrompts.push({ system: opts.system, prompt: opts.prompt });
            if (aiHook) await aiHook(aiCalls);
            if (aiFailNext) { const m = aiFailNext; aiFailNext = null; throw new Error(m); }
            const m = /TOPIC:\s*(.+)/.exec(opts.prompt) ?? /topic[^\n]*?[:—-]\s*(.+)/i.exec(opts.prompt);
            const title = (m?.[1] ?? "Drafted topic").trim().slice(0, 90);
            return { result: generated(title, title.toLowerCase().slice(0, 24)), usage: { inputTokens: 1200, outputTokens: 400 }, model: "drill-stub" };
          };
        }
        return (t as Record<string | symbol, unknown>)[k];
      },
    });
  }
  return loaded;
};

const exec = promisify(execFile);
const PORT = 5494;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
process.env.CRON_SECRET = "drill-secret";
delete process.env.AUTH_ENFORCE;
delete process.env.SLACK_ALERT_CHANNEL;
delete process.env.VERCEL;

const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(url)) return realFetch(input as string, init as RequestInit);
  outbound.push(url);
  throw new Error(`OUTBOUND BLOCKED BY DRILL: ${url}`);
}) as typeof fetch;

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const head = (s: string) => console.log(`\n${s}\n${"─".repeat(s.length)}`);

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 30 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { sweepOwedScripts, sweepInterviewPlans, scriptWorkForMonth } = await import("@/lib/contentDrafting");

  const setSwitch = async (key: string, enabled: boolean) => {
    await prisma.programAutomation.upsert({
      where: { key },
      create: { key, enabled, enabledBy: enabled ? "drill" : null, enabledAt: enabled ? new Date() : null },
      update: { enabled, enabledBy: enabled ? "drill" : null, enabledAt: enabled ? new Date() : null },
    });
  };
  const scriptCount = () => prisma.contentScript.count();
  const versionCount = () => prisma.contentScriptVersion.count();

  // ---- the fixture: one live client, one open month, four readiness states --
  const client = await prisma.client.create({ data: { name: "Marisol Reyes TEST" }, select: { id: true } });
  const enrollment = await prisma.contentEnrollment.create({
    data: { clientId: client.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4 },
    select: { id: true },
  });
  const month = await prisma.contentMonth.create({
    data: { enrollmentId: enrollment.id, clientId: client.id, monthKey: "2026-10", videosOwed: 4, status: "PLANNING" },
    select: { id: true },
  });
  // A month on a PAUSED enrollment, to prove the sweep does not reach it.
  const paused = await prisma.client.create({ data: { name: "Paused Co TEST" }, select: { id: true } });
  const pausedEnrollment = await prisma.contentEnrollment.create({
    data: { clientId: paused.id, status: "PAUSED", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2 },
    select: { id: true },
  });
  const pausedMonth = await prisma.contentMonth.create({
    data: { enrollmentId: pausedEnrollment.id, clientId: paused.id, monthKey: "2026-10", videosOwed: 2, status: "PLANNING" },
    select: { id: true },
  });

  const mkTopic = async (title: string) =>
    prisma.contentTopic.create({ data: { enrollmentId: enrollment.id, clientId: client.id, monthId: month.id, title, status: "SELECTED" }, select: { id: true, title: true } });

  const tAnswers = await mkTopic("What a pre-listing inspection actually saves you");
  const tCall = await mkTopic("Why the first weekend decides your price");
  const tProposed = await mkTopic("The three repairs buyers always notice");
  const tThin = await mkTopic("A month in this market, in one minute");

  const select = async (topicId: string, status: string, evidence: string | null = null) =>
    prisma.contentTopicSelection.create({
      data: { topicId, monthId: month.id, enrollmentId: enrollment.id, clientId: client.id, status, source: "staff", evidenceJson: evidence },
    });
  await select(tAnswers.id, "SELECTED");
  await select(tCall.id, "RECONCILED", JSON.stringify({ excerpts: [
    { speaker: "client", source: "call", text: "Every listing I have taken that sat past the first weekend ended up selling for less than the one that went in priced right." },
    { speaker: "client", source: "call", text: "I tell sellers the first weekend is the whole negotiation, and they never believe me until they live it." },
  ] }));
  await select(tProposed.id, "PROPOSED");
  await select(tThin.id, "SELECTED");
  // The paused client's month owes a script too — and must never be touched.
  const pausedTopic = await prisma.contentTopic.create({ data: { enrollmentId: pausedEnrollment.id, clientId: paused.id, monthId: pausedMonth.id, title: "Paused topic", status: "SELECTED" }, select: { id: true } });
  await prisma.contentTopicSelection.create({ data: { topicId: pausedTopic.id, monthId: pausedMonth.id, enrollmentId: pausedEnrollment.id, clientId: paused.id, status: "SELECTED", source: "staff", evidenceJson: JSON.stringify({ excerpts: [{ speaker: "client", source: "call", text: "Something the paused client said on a call last quarter." }] }) } });

  // The written-answers path: a real interview with real answer rows, submitted.
  const { getOrCreateInterview } = await import("@/lib/contentInterview");
  const interviewId = await getOrCreateInterview(tAnswers.id, month.id, {});
  const answers: [string, string, string][] = [
    ["audienceProblem", "AUDIENCE_PROBLEM", "Sellers who think an inspection before listing is money thrown away, and then lose four weeks to a buyer's inspector finding the same thing."],
    ["pointOfView", "POINT_OF_VIEW", "You are paying for the report either way. The only question is whether you read it first or negotiate against it."],
    ["talkingPoints", "TALKING_POINT", "It moves the discovery to before the offer; it removes the buyer's best renegotiation lever; it lets you price with the roof already known."],
    ["evidence", "EVIDENCE", "The Cedar Street listing in June — inspection first, three offers, none of them reopened price."],
    ["story", "STORY", "A seller last spring refused, the buyer's inspector found a water heater, and we gave back eleven hundred dollars at the table."],
    ["nextAction", "NEXT_STEP", "Call me before you book the photographer and I will tell you whether your house needs one."],
  ];
  for (const [key, role, text] of answers) {
    await prisma.contentInterviewAnswer.create({
      data: { interviewId, questionKey: key, questionRole: role, questionText: `House question: ${key}`, answerText: text, answerKind: "TYPED", sourceKind: "CLIENT" },
    });
  }
  await prisma.contentInterview.update({ where: { id: interviewId }, data: { status: "SUBMITTED", submittedAt: new Date(), answeredCount: answers.length } });

  head("0 · the fixture reads the way the month workspace reads it");
  const work0 = await scriptWorkForMonth(month.id);
  const readiness = new Map(work0.map((w) => [w.topicId, w.readiness]));
  ok("the answered topic is FROM_ANSWERS", readiness.get(tAnswers.id) === "FROM_ANSWERS", String(readiness.get(tAnswers.id)));
  ok("the call topic is FROM_CALL", readiness.get(tCall.id) === "FROM_CALL", String(readiness.get(tCall.id)));
  ok("the PROPOSED topic is WAITING_ON_PLANNING", readiness.get(tProposed.id) === "WAITING_ON_PLANNING", String(readiness.get(tProposed.id)));
  ok("the bare topic is THIN", readiness.get(tThin.id) === "THIN", String(readiness.get(tThin.id)));

  // The step body, verbatim from src/app/api/cron/sync/route.ts. Section 8
  // reads the route and asserts these are the same two calls with the same
  // bounds, so this stays honest if the route ever changes.
  const scriptDraftingStep = async () => {
    const plans = await sweepInterviewPlans({ max: 4, budgetMs: 30_000 });
    const drafts = await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
    return { plans, drafts };
  };

  head("1 · production's state today — no rows at all — draws no work");
  ok("no ProgramAutomation rows exist, which is what production looks like now", (await prisma.programAutomation.count()) === 0);
  const r1 = await scriptDraftingStep();
  ok("the drafting sweep refuses on the missing row", "skipped" in r1.drafts && r1.drafts.skipped === "script_drafting is off", JSON.stringify(r1.drafts));
  ok("the question sweep refuses on the same row", "skipped" in r1.plans, JSON.stringify(r1.plans));
  ok("no script was written", (await scriptCount()) === 0);
  ok("the model was never called", aiCalls === 0, `${aiCalls} calls`);
  ok("no run ledger row was opened", (await prisma.programAiRun.count()) === 0);

  head("2 · script_drafting ON, ai_runs OFF — the second gate holds");
  await setSwitch("script_drafting", true);
  const r2 = await scriptDraftingStep();
  // NOTE: the success shape carries a NUMERIC `skipped`, so `"skipped" in x` is
  // not the refusal test — `months` is the field only a run that happened has.
  ok("the sweep ran this time", "months" in r2.drafts, JSON.stringify(r2.drafts).slice(0, 200));
  ok("it SAW the work it could not do", "drafted" in r2.drafts && r2.drafts.months === 1, JSON.stringify(r2.drafts).slice(0, 200));
  ok("NO script was written — ai_runs is still off", (await scriptCount()) === 0, `${await scriptCount()} scripts`);
  ok("the model was still never called", aiCalls === 0, `${aiCalls} calls`);
  ok("no run row was opened either — the gate is above the ledger", (await prisma.programAiRun.count()) === 0, `${await prisma.programAiRun.count()} runs`);
  ok("it stopped on the first refusal rather than burning the month", "skipped" in r2.drafts && typeof r2.drafts.skipped === "number" && r2.drafts.skipped === 1, JSON.stringify(r2.drafts).slice(0, 200));
  // THE OLD BEHAVIOUR, STATED FIRST. An AutomationDisabledError was classified
  // as a FAILURE. That made `failed: 1`, put the gate's message in `lastError`,
  // and recordAutomationRun stamped it on the script_drafting row — which
  // programMonitoring.ts:112 turns into `Automation "script_drafting" last run
  // failed`, retryable:false. Every hour, for as long as Jordan held the stop.
  const oldWouldHaveFailed = (msg: string) => !/already (running|in progress)|Unique constraint|dedupe/i.test(msg);
  ok("OLD: the gate's own message would have counted as a failure", oldWouldHaveFailed("AI runs are switched off for unattended jobs (Settings → AI Assistants)."));
  ok("NEW: the sweep reports zero failures", "failed" in r2.drafts && r2.drafts.failed === 0, `${"failed" in r2.drafts ? r2.drafts.failed : "?"}`);
  ok("NEW: it says WHY it stopped", "paused" in r2.drafts && /switched off/i.test(String(r2.drafts.paused)), String("paused" in r2.drafts ? r2.drafts.paused : "").slice(0, 90));
  ok("NEW: the question sweep says the same", "paused" in r2.plans && !!r2.plans.paused, String("paused" in r2.plans ? r2.plans.paused : "").slice(0, 60));
  const pausedRow = await prisma.programAutomation.findUnique({ where: { key: "script_drafting" }, select: { lastError: true, lastErrorAt: true, lastRunAt: true } });
  ok("NEW: nothing was stamped as an error on the switch", !pausedRow?.lastError && !pausedRow?.lastErrorAt, pausedRow?.lastError ?? "clean");
  ok("NEW: but the run itself is still recorded", !!pausedRow?.lastRunAt);
  // programMonitoring.failedAutomations already PROMISED this in its docstring —
  // "a QUEUED job waiting for its switch is not a failure and is not listed
  // here" — while the drivers underneath made it untrue. Now it holds.
  const { failedAutomations } = await import("@/lib/programMonitoring");
  const alerts2 = await failedAutomations({ sinceDays: 1 });
  ok("NEW: the monitoring screen raises no alert for a stop Jordan asked for", !alerts2.some((a) => a.kind === "automation"), JSON.stringify(alerts2.map((a) => a.title)));

  head("3 · both switches ON — the scheduled path drafts, unattended");
  await setSwitch("ai_runs", true);
  const before = aiCalls;
  const r3 = await scriptDraftingStep();
  console.log(`    drafts: ${JSON.stringify(r3.drafts).slice(0, 260)}`);
  const scripts = await prisma.contentScript.findMany({ select: { id: true, topicId: true, monthId: true, clientId: true } });
  const versions = await prisma.contentScriptVersion.findMany({ select: { id: true, scriptId: true, status: true, interviewId: true, source: true, body: true } });
  ok("scripts were drafted by the scheduled run", scripts.length === 2, `${scripts.length} scripts`);
  ok("the model was called by the cron, not by a person", aiCalls > before, `${aiCalls - before} calls`);
  const scriptPrompts = aiPrompts.slice(before).filter((p) => /Target 20.30 seconds/.test(p.system));
  ok("exactly the script prompts carried the house policy, and its timing target", scriptPrompts.length === 2, `${scriptPrompts.length} of ${aiPrompts.length - before} prompts`);
  ok("the client's own answers reached the prompt that used them", scriptPrompts.some((p) => /pre-listing inspection|water heater|Cedar Street/i.test(p.prompt)));
  ok("the call excerpts reached the other one", scriptPrompts.some((p) => /first weekend/i.test(p.prompt)));
  const byTopic = new Map(scripts.map((s2) => [s2.topicId, s2]));
  ok("the answered topic has a script", byTopic.has(tAnswers.id));
  ok("the call topic has a script", byTopic.has(tCall.id));
  ok("the PROPOSED topic does NOT — nobody has agreed it is the plan", !byTopic.has(tProposed.id));
  ok("the THIN topic does NOT — a person has to ask for that one", !byTopic.has(tThin.id));
  ok("the PAUSED client's month was never touched", !scripts.some((s2) => s2.clientId === paused.id));
  const answersVersion = versions.find((v) => v.interviewId === interviewId);
  ok("the answers path produced a DRAFT version tied to the interview", !!answersVersion && answersVersion.status === "DRAFT", answersVersion?.status ?? "none");
  const callScript = byTopic.get(tCall.id);
  const callVersion = versions.find((v) => v.scriptId === callScript?.id);
  ok("the call path produced an INTERNAL_REVIEW version", !!callVersion && callVersion.status === "INTERNAL_REVIEW", callVersion?.status ?? "none");
  ok("both versions carry real body text", versions.every((v) => (v.body ?? "").length > 40));
  ok("neither version was shared with the client by the sweep", (await prisma.contentScript.count({ where: { sharedVersionId: { not: null } } })) === 0);
  const runs = await prisma.programAiRun.findMany({ where: { kind: "script_draft" }, select: { status: true, dedupeKey: true, requestedBy: true, outputRef: true } });
  ok("every run finished and released its dedupe key", runs.every((r) => r.status === "SUCCEEDED" && r.dedupeKey === null), JSON.stringify(runs.map((r) => r.status)));
  ok("the run ledger records the cron as the requester", runs.every((r) => r.requestedBy === "cron"), JSON.stringify([...new Set(runs.map((r) => r.requestedBy))]));
  ok("each run points at the version it produced", runs.every((r) => (r.outputRef ?? "").startsWith("ContentScriptVersion:")));
  const stamp = await prisma.programAutomation.findUnique({ where: { key: "script_drafting" }, select: { lastRunAt: true, lastError: true } });
  ok("the automation row was stamped with its run", !!stamp?.lastRunAt && !stamp.lastError, stamp?.lastError ?? "no error");
  const topicsNow = await prisma.contentTopic.findMany({ where: { id: { in: [tAnswers.id, tCall.id, tThin.id] } }, select: { id: true, status: true } });
  ok("the drafted topics moved to SCRIPTED and the thin one did not", topicsNow.filter((t) => t.status === "SCRIPTED").length === 2, JSON.stringify(topicsNow.map((t) => t.status)));

  head("4 · the next hourly tick drafts nothing — no duplicate versions");
  const vBefore = await versionCount();
  const aiBefore = aiCalls;
  const r4 = await scriptDraftingStep();
  ok("no new script", (await scriptCount()) === 2, `${await scriptCount()}`);
  ok("no new version", (await versionCount()) === vBefore, `${await versionCount()} vs ${vBefore}`);
  ok("no new model call — HAS_SCRIPT is not re-drafted", aiCalls === aiBefore, `${aiCalls - aiBefore} calls`);
  ok("the sweep reports zero drafted rather than erroring", "drafted" in r4.drafts && r4.drafts.drafted === 0 && r4.drafts.failed === 0, JSON.stringify(r4.drafts).slice(0, 160));

  head("5 · the claim a run holds while it is in flight, and the lease that reclaims it");
  // Observed LIVE: the hook runs inside the model call, while the row is RUNNING.
  const tRace = await mkTopic("What an appraisal gap really costs you");
  await select(tRace.id, "SELECTED", JSON.stringify({ excerpts: [{ speaker: "client", source: "call", text: "Buyers hear appraisal gap and think it is paperwork; it is cash out of their pocket on closing day." }] }));
  let heldKey: string | null = null;
  let heldLease: Date | null = null;
  aiHook = async () => {
    const row = await prisma.programAiRun.findFirst({ where: { status: "RUNNING" }, select: { dedupeKey: true, leaseUntil: true } });
    heldKey = row?.dedupeKey ?? null;
    heldLease = row?.leaseUntil ?? null;
  };
  await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
  aiHook = null;
  ok("a run in flight holds a dedupe key naming the topic and the month", heldKey === `script:${tRace.id}:${month.id}`, String(heldKey));
  ok("and it holds a lease, so a crashed run cannot hold it forever", !!heldLease);
  ok("the key is released once the run finishes", (await prisma.programAiRun.count({ where: { dedupeKey: { not: null } } })) === 0);
  // Uniqueness is Postgres', not the code's — assert the constraint itself.
  const schema = fs.readFileSync(path.resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
  const aiRunModel = /model ProgramAiRun \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
  ok("the database — not the application — enforces one run per key", /dedupeKey\s+String\?\s+@unique/.test(aiRunModel));
  // NOT ASSERTED HERE, and the file says so: the live collision. PGlite's socket
  // server closes the connection on 23505, so a genuine race cannot be run in
  // this harness. What is asserted is the identity of the claim, the lease, the
  // release, and that Postgres holds the constraint.
  const tLease = await mkTopic("The inspection contingency people waive too fast");
  await select(tLease.id, "SELECTED", JSON.stringify({ excerpts: [{ speaker: "client", source: "call", text: "Waiving the inspection to win a bid is the most expensive sentence in this market." }] }));
  await prisma.programAiRun.create({
    data: {
      kind: "script_draft", status: "RUNNING", promptKey: "script", requestedBy: "cron",
      enrollmentId: enrollment.id, clientId: client.id, attempts: 1, startedAt: new Date(Date.now() - 3_600_000),
      dedupeKey: `script:${tLease.id}:${month.id}`, leaseUntil: new Date(Date.now() - 1_800_000), leaseBy: "cron",
    },
  });
  const sBeforeLease = await scriptCount();
  await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
  ok("an abandoned run does not block its topic forever", (await scriptCount()) === sBeforeLease + 1, `${(await scriptCount()) - sBeforeLease} drafted`);
  const expired = await prisma.programAiRun.findFirst({ where: { error: { contains: "Lease expired" } }, select: { status: true, dedupeKey: true } });
  ok("the abandoned run is marked failed and gives its key back", expired?.status === "FAILED" && expired?.dedupeKey === null, JSON.stringify(expired));

  head("6 · the switch going off mid-sweep stops the sweep");
  const tStop1 = await mkTopic("How to read a comparable that is not comparable");
  const tStop2 = await mkTopic("The listing photo that costs you showings");
  await select(tStop1.id, "SELECTED", JSON.stringify({ excerpts: [{ speaker: "client", source: "call", text: "Half the comps agents hand sellers are not comparable to anything." }] }));
  await select(tStop2.id, "SELECTED", JSON.stringify({ excerpts: [{ speaker: "client", source: "call", text: "One bad exterior photo and the showing never gets booked." }] }));
  const sBefore6 = await scriptCount();
  // Jordan presses stop while the first of the two is with the model.
  aiHook = async () => { await setSwitch("ai_runs", false); aiHook = null; };
  const r6 = await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
  const madeIn6 = (await scriptCount()) - sBefore6;
  ok("the one already with the model still completes", madeIn6 === 1, `${madeIn6} of 2 owed`);
  ok("the second is NOT attempted — the sweep breaks on the closed gate", "drafted" in r6 && r6.drafted === 1, JSON.stringify(r6).slice(0, 180));
  ok("pressing stop is not recorded as a failure", "failed" in r6 && r6.failed === 0, `failed=${"failed" in r6 ? r6.failed : "?"}`);
  ok("it says it was paused, and by what", "paused" in r6 && /switched off/i.test(String(r6.paused)), String("paused" in r6 ? r6.paused : "").slice(0, 80));
  const row6 = await prisma.programAutomation.findUnique({ where: { key: "script_drafting" }, select: { lastError: true } });
  ok("the switch row carries no error after a deliberate stop", !row6?.lastError, row6?.lastError ?? "clean");
  const leaked = await prisma.programAiRun.count({ where: { dedupeKey: { not: null }, status: { in: ["SUCCEEDED", "FAILED"] } } });
  ok("no finished run is still holding a dedupe key", leaked === 0, `${leaked} holding`);
  await setSwitch("ai_runs", true);

  head("7 · the questions are phrased ahead of the client, on the same schedule");
  const planned = await sweepInterviewPlans({ max: 3 });
  ok("the plan sweep ran under the same switch", !("skipped" in planned), JSON.stringify(planned).slice(0, 160));
  const withPlans = await prisma.contentInterview.count({ where: { questionPlanJson: { not: null } } });
  ok("at least one interview now carries a generated plan", withPlans >= 1, `${withPlans} planned`);
  const planRuns = await prisma.programAiRun.count({ where: { kind: "interview_plan" } });
  ok("each plan is identified by its RUN, not by reading the sentences", planRuns >= 1, `${planRuns} runs`);
  await setSwitch("script_drafting", false);
  const offAgain = await sweepInterviewPlans({ max: 3 });
  ok("turning the switch off stops the plan sweep too", "skipped" in offAgain, JSON.stringify(offAgain));

  head("7b · a paused transcript job goes back on the queue, not to a person");
  // The worse half of the same defect. An AutomationDisabledError came back as
  // `reviewReason`, which parked the job in NEEDS_REVIEW *and* stamped the CALL
  // RECORD transcriptState NEEDS_REVIEW. Holding the stop for three hourly
  // ticks exhausted maxAttempts, and NEEDS_REVIEW does not resume when the
  // switch comes back — so pressing stop manufactured manual work that stayed.
  const call = await prisma.programCallRecord.create({
    data: {
      enrollmentId: enrollment.id, clientId: client.id, callType: "MONTHLY_STRATEGY", status: "COMPLETED",
      matchState: "MATCHED", scheduledStart: new Date(Date.now() - 864e5), targetMonthKey: "2026-10", monthId: month.id,
    },
    select: { id: true },
  });
  await prisma.programTranscriptSource.create({
    data: {
      callRecordId: call.id, provider: "paste", contentHash: "drill-hash-1", matchState: "CONFIRMED",
      text: "Jordan: what is landing for you this month? Client: the first-weekend conversation, every time.",
    },
  });
  const job = await prisma.programTranscriptJob.create({
    data: { callRecordId: call.id, enrollmentId: enrollment.id, kind: "ANALYZE", state: "QUEUED", dedupeKey: `${call.id}:ANALYZE`, requestedBy: "cron" },
    select: { id: true, attempts: true },
  });
  await setSwitch("transcript_jobs", true);
  await setSwitch("ai_runs", false);
  const { driveTranscriptJobs } = await import("@/lib/transcriptJobs");
  const jr = await driveTranscriptJobs({ max: 3, budgetMs: 20_000 });
  const after = await prisma.programTranscriptJob.findUnique({ where: { id: job.id }, select: { state: true, attempts: true, lastError: true, reviewReason: true, leaseUntil: true } });
  ok("the job is back on the QUEUE, not parked for review", after?.state === "QUEUED", after?.state ?? "gone");
  ok("its attempt was given back — three ticks of stop cannot exhaust it", after?.attempts === job.attempts, `${after?.attempts} vs ${job.attempts}`);
  ok("no error was written on the job", !after?.lastError && !after?.reviewReason, after?.lastError ?? after?.reviewReason ?? "clean");
  ok("its lease was released", after?.leaseUntil === null);
  const callAfter = await prisma.programCallRecord.findUnique({ where: { id: call.id }, select: { transcriptState: true, lastError: true } });
  ok("the CALL RECORD was not marked as needing a person", callAfter?.transcriptState !== "NEEDS_REVIEW", callAfter?.transcriptState ?? "none");
  ok("and carries no error either", !callAfter?.lastError, callAfter?.lastError ?? "clean");
  ok("the sweep reports a pause, not a failure", "paused" in jr && !!jr.paused && jr.failed === 0 && jr.needsReview === 0, JSON.stringify(jr).slice(0, 200));
  const tjRow = await prisma.programAutomation.findUnique({ where: { key: "transcript_jobs" }, select: { lastError: true } });
  ok("the transcript_jobs switch carries no error", !tjRow?.lastError, tjRow?.lastError ?? "clean");
  const alerts7 = await failedAutomations({ sinceDays: 1 });
  // Section 5 deliberately abandoned a run, and THAT is a real alert — it
  // should be here. What must not be here is anything caused by the stop.
  const fromTheStop = alerts7.filter((a) => /switched off|AI Assistants/i.test(`${a.title} ${a.error ?? ""}`) || a.kind === "automation" || a.kind === "transcript_job");
  ok("and the monitoring screen raises nothing because of the stop", fromTheStop.length === 0, JSON.stringify(fromTheStop.map((a) => a.title)));
  ok("while a genuinely abandoned run IS still reported", alerts7.some((a) => /failed/i.test(a.title)), JSON.stringify(alerts7.map((a) => a.title)));
  // And it RESUMES the moment the switch returns — the thing NEEDS_REVIEW never did.
  await setSwitch("ai_runs", true);
  const jr2 = await driveTranscriptJobs({ max: 3, budgetMs: 20_000 });
  const after2 = await prisma.programTranscriptJob.findUnique({ where: { id: job.id }, select: { state: true } });
  ok("with the switch back on, the same job runs — no person needed", after2?.state === "SUCCEEDED", `${after2?.state} · ${JSON.stringify(jr2).slice(0, 120)}`);

  const aiCallsAtSection8 = aiCalls;
  head("8 · the hourly route's step is wired to exactly this — read from the source");
  const routeSrc = fs.readFileSync(path.resolve(__dirname, "../../src/app/api/cron/sync/route.ts"), "utf8");
  const stepBody = /await step\("scriptDrafting",([\s\S]*?)\}, \{ maxMs/.exec(routeSrc)?.[1] ?? "";
  ok("the step exists in the hourly route", stepBody.length > 0);
  ok("it calls sweepInterviewPlans", /sweepInterviewPlans\(/.test(stepBody));
  ok("it calls sweepOwedScripts", /sweepOwedScripts\(/.test(stepBody));
  ok("questions are phrased BEFORE scripts are drafted", stepBody.indexOf("sweepInterviewPlans(") < stepBody.indexOf("sweepOwedScripts("));
  ok("with the same bounds this drill ran", /max: 4, budgetMs: 30_000/.test(stepBody) && /max: 6, budgetMs: 45_000/.test(stepBody), "plans 4/30s, drafts 6/45s");
  ok("the step itself is bounded", /await step\("scriptDrafting"[\s\S]*?maxMs: 90_000/.test(routeSrc));
  ok("nothing in the step writes to a provider", !/openphone|gmail|aryeo|stripe|dropbox/i.test(stepBody));
  ok("the route is on the hourly schedule", /"\/api\/cron\/sync"/.test(fs.readFileSync(path.resolve(__dirname, "../../vercel.json"), "utf8")));

  // The shell's own rule, executed: a cron route that loses its secret refuses.
  const { GET } = await import("@/app/api/cron/sync/route");
  const { NextRequest } = await import("next/server");
  const unauth = await GET(new NextRequest("http://127.0.0.1/api/cron/sync"));
  ok("the route refuses a request with no bearer token", unauth.status === 401, `${unauth.status}`);
  const wrong = await GET(new NextRequest("http://127.0.0.1/api/cron/sync", { headers: { authorization: "Bearer not-the-secret" } }));
  ok("and refuses a wrong one", wrong.status === 401, `${wrong.status}`);
  ok("no work was done by either refusal", aiCalls === aiCallsAtSection8, `${aiCalls - aiCallsAtSection8} calls`);

  head("9 · nothing left production, and nothing reached a client");
  ok("the scheduled drafting path made NO outbound call of its own", outbound.length === 0, `${outbound.length} attempted`);
  ok("and never opened production", !/neon|\.tech/i.test(process.env.DATABASE_URL ?? ""), process.env.DATABASE_URL?.replace(/:[^:@]*@/, ":***@") ?? "");
  const outboxRows = await prisma.outboxMessage.count();
  ok("the scheduled run enqueued no outbound message at all", outboxRows === 0, `${outboxRows} rows`);
  const hosts = [...new Set(outbound.map((u) => { try { return new globalThis.URL(u).host; } catch { return u.slice(0, 40); } }))];
  console.log(`    blocked hosts: ${hosts.join(", ") || "(none — nothing tried to leave)"}`);
  const suggestions = await prisma.scriptSuggestion.count();
  ok("the sweep opened no work item for staff either — it only drafts", suggestions === 0, `${suggestions}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await server.stop();
  await db.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
