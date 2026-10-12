// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs engine=postgres needs=tools/realpg timeout=900
// ---------------------------------------------------------------------------
// DRILL: OCT 12 2026 — "DRAFT SCRIPT" ANSWERS AT ONCE; THE AI RUNS IN THE
// BACKGROUND, THREE AT A TIME (Jordan: "When I click Draft Script on a video
// topic, I want a message to pop up to confirm it's been sent for scripting.
// Right now, it makes me wait till it's done. I want it done in the background
// so I can continue clicking Draft Script for all of the other topics. It can
// add them to the queue."). Plus his same-day rule: "Make sure no em dashes
// are ever written into the scripts."
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct12-queued-drafts.ts --logs <dir>
//
//   0  OLD: generateScriptForTopicAction does not return until the model
//      answers (held here), and the panel's one shared `busy` froze every row.
//   1  Auth: signed out and an EDITOR are refused by every queue action and
//      the poll; nothing is written.
//   2  Instant: "Draft script" answers "Sent for scripting — <topic>. It'll
//      appear on the Scripts tab when it's ready." with the model untouched —
//      one QUEUED ProgramAiRun (the generator's own key, Jordan's name), the AI
//      still waiting in after(); the topic reads "Drafting…" (disabled, spinner)
//      from the server's own state while every other topic's button is live.
//   3  No duplicates: a second click, and two clicks at once on another topic,
//      leave one row each and say "already being drafted".
//   4  Eight topics at once: eight workers start, THREE claim, five rows stay
//      QUEUED; never more than three model calls in flight; as each finishes,
//      its worker takes the next; eight scripts, ONE run row each (the
//      generator adopted the queued row — no second run), every topic SCRIPTED.
//   5  Done: the queue state is empty and the topic shows "Script drafted →
//      View", linking to the month's Scripts tab.
//   6  Failure: the model fails → FAILED with the reason; the topic shows
//      "Drafting failed — Try again" and "Why it failed: …"; Try again drafts.
//   7  Quota: a client whose daily AI limit is spent is refused at the click.
//   8  Stranded work comes back: another caller's lease cleanup leaves a queue
//      row alone; a dead worker's row is re-queued and drafted by the hourly
//      cron's drain (attempt 2); a third interruption stops with the reason;
//      the poll restarts the queue when work is waiting.
//   9  Zombie: a worker whose lease ran out and whose row another worker
//      re-claimed answers late — its answer is NOT applied (one version).
//  10  The other buttons: "Draft what's ready" queues each owed topic on its
//      own path; "Ask AI to revise" queues a revision (the script reads
//      "revising…", every other script stays usable) and a failed one offers
//      Try again; Tighten on a short script refuses at once; "Draft from the
//      discovery call" queues the strategy; "Refresh topics" answers while the
//      run is still RUNNING.
//  11  No dashes: the policy rule is in every prompt (version bumped); the
//      sanitizer's cases; an AI draft, a revision and a staff edit are stored
//      without one; an imported historical record keeps its words; the format
//      check reports one that gets through.
//  12  Nothing reached a client; no network.
//
// ISOLATION: PGlite on 127.0.0.1:6934 (and, second run, a disposable real
// Postgres — the cap's advisory lock contended for real); production is never
// opened; the model is stubbed at aiJsonWithUsage and can be HELD; after() is
// captured so the drill decides when (and how many at once) the workers run.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6934);
const REPO = path.resolve(__dirname, "..", "..");
const RealDate = Date;

installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown };
navigation.useRouter = () => ({ refresh() {} });

// ---- after(): captured, so the drill decides when the background work runs ----
const pendingAfter: (() => Promise<unknown> | unknown)[] = [];
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: (fn: () => Promise<unknown> | unknown) => { pendingAfter.push(fn); } }));
async function flushAfter() { while (pendingAfter.length) await pendingAfter.shift()!(); }

// ---- the model: answers, fails on request, and can be HELD -----------------
type Call = { kind: "script" | "revise" | "strategy" | "other"; topic: string; system: string; prompt: string };
const modelCalls: Call[] = [];
let hold = false;
const held: { release: () => void; call: Call }[] = [];
let inFlight = 0, maxInFlight = 0;
let failScripts = 0;
let dashOutput = false;
const STRATEGY = {
  clientName: "Sam Strategy", subtitle: "Built around Trust, Value, Credibility, and Entertainment",
  brandOverview: { coreValues: "Honesty", brandMessage: "Calm, clear pricing advice", shortBrandStatement: "Clear advice", brandVoice: "Warm and direct" },
  targetAudience: { primaryServiceAreas: "Chester County", pricePositioning: "Move-up homes", primaryClientTypes: "Move-up sellers", longTermPositioningGoal: "The local name" },
  contentGoals: ["Two listing leads a month"],
  contentPillars: { preamble: "Every video builds Trust.", pillars: [{ name: "Seller Strategy", purpose: "Help sellers price", focusAreas: "Pricing", contentApproach: null }, { name: "Local Life", purpose: "Show the town", focusAreas: "Places", contentApproach: null }] },
  framework: "policy", captionCtaExamples: ["DM me PRICE for my guide"], strategicDirection: "Lead with pricing clarity.", gaps: [],
};
interceptModule((r) => r === "@/lib/integrations/ai" || /[\\/]integrations[\\/]ai(\.ts)?$/.test(r), (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get(target, key) {
    if (key !== "aiJsonWithUsage") return target[key];
    return async (input: { system: string; prompt: string }) => {
      const kind: Call["kind"] = /writing ONE personal-branding video script/.test(input.system) ? (/REVIEWER'S INSTRUCTION/.test(input.prompt) ? "revise" : "script") : /Social Content Strategy for Realtour Pilot using the house template/.test(input.system) ? "strategy" : "other";
      const topic = (/TOPIC:\s*(.+)/.exec(input.prompt)?.[1] ?? "").trim();
      const call: Call = { kind, topic, system: input.system, prompt: input.prompt };
      modelCalls.push(call);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (hold) await new Promise<void>((release) => held.push({ release, call }));
        if (kind === "other") throw new Error(`unexpected model call in this drill: ${input.system.slice(0, 80)}`);
        if ((kind === "script" || kind === "revise") && failScripts > 0) { failScripts--; throw new Error("503 isolated fake model unavailable"); }
        if (kind === "strategy") return { result: STRATEGY, usage: { inputTokens: 9000, outputTokens: 2500, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "isolated-fake-model" };
        const d = dashOutput ? " — " : ", ";
        return {
          result: {
            title: kind === "revise" ? "Revised draft" : topic || "Drafted topic", category: "Seller Strategy",
            hook: `The first weekend decides your price${d}and most sellers miss it.`,
            points: [{ role: "re-hook", text: `Buyers read every week on the market as a signal${dashOutput ? "—" : ","} loud and clear.` }, { role: "build-up", text: "A stale listing invites the low offers you were hoping to avoid." }, { role: "payoff", text: "Price it right on day one and the buyers compete for you." }],
            close: `Planning to sell this spring${dashOutput ? " —" : "?"} Call me before you pick a price.`, captionCta: dashOutput ? "DM me PRICE — I'll send the guide" : null, filmingNotes: null,
            contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [],
          },
          usage: { inputTokens: 4000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "isolated-fake-model",
        };
      } finally { inFlight--; }
    };
  },
}));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const until = RealDate.now() + ms;
  while (RealDate.now() < until) { if (await cond()) return true; await sleep(15); }
  return !!(await cond());
}
const releaseAll = () => { while (held.length) held.shift()!.release(); };

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct12-queued-drafts" } });
  const fence = fenceFetch();
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  console.log(`engine: ${drill.engine}`);
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const A = await import("@/app/content/actions");
    const q = await import("@/lib/aiQueue");
    const aiRuns = await import("@/lib/aiRuns");
    const policy = await import("@/lib/contentPolicy");
    const scripts = await import("@/lib/contentScripts");
    const { loadTopicsTab, loadScriptsTab, loadStrategyTab } = await import("@/app/content/[id]/programData");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { TopicsPanel, draftStateOf } = await import("@/components/content/TopicsPanel");
    const { ScriptsPanel } = await import("@/components/content/ScriptsPanel");
    const { StrategyPanel } = await import("@/components/content/StrategyPanel");
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rsquo;/g, "’").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
    const ser = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

    const jordan = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@oct12q.test", role: "OWNER", status: "ACTIVE" } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@oct12q.test", role: "ADMIN", status: "ACTIVE" } });
    const kim = await prisma.appUser.create({ data: { name: "Kim", email: "kim@oct12q.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const as = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });

    const TITLES = ["Why spring listings sell faster", "Three questions before you price", "The first weekend decides it", "What buyers read into days on market", "Staging that pays for itself", "When to cut the price", "Open houses still matter", "Inspection surprises to avoid", "The appraisal gap, explained", "Moving up without selling first", "Pricing a home with no comps"];
    const F = await buildContentMonth(prisma, { name: "Queue Client TEST", package: "Pro", project: false, owner: false, topics: TITLES.map((title) => ({ title, selection: "SELECTED" as const })) });
    const T = (i: number) => ({ id: F.topicIds[i], title: TITLES[i] });
    const monthUi = { id: F.monthId, label: "October 2026", short: "October", key: F.monthKey };
    const runsFor = (topicId: string) => prisma.programAiRun.findMany({ where: { scopeJson: { contains: `"topicId":"${topicId}"` } }, orderBy: { createdAt: "asc" } });
    const scriptOf = (topicId: string) => prisma.contentScript.findFirst({ where: { topicId, monthId: F.monthId, historical: false } });
    const topicsHtml = async () => {
      const d = await loadTopicsTab(F.enrollmentId, { id: F.monthId, monthKey: F.monthKey });
      return { d, html: renderToStaticMarkup(createElement(TopicsPanel, ser({ enrollmentId: F.enrollmentId, month: monthUi, capacity: d.capacity, groups: d.groups, proposed: d.proposed, monthTopics: d.monthTopics, suggestions: d.suggestions, recommended: d.recommended, runs: d.runs, interviews: d.interviews, histories: d.histories, pillars: d.pillars, topicsPerPillar: d.topicsPerPillar, isOwner: true, archivedCount: d.archivedCount, declined: d.declined, stock: d.stock, held: d.held, drafts: d.drafts, queueActive: d.queueActive }))) };
    };
    /** The HTML of one topic row: from its title to the next month topic's title. */
    const rowOf = (html: string, i: number) => {
      const at = html.indexOf(`>${TITLES[i]}<`);
      const next = TITLES.map((t, j) => (j === i ? -1 : html.indexOf(`>${t}<`, at + 1))).filter((x) => x > at).sort((a, b) => a - b)[0] ?? html.length;
      return at < 0 ? "" : html.slice(at, next);
    };
    const DRAFTING_BTN = /<button disabled=""[^>]*aria-busy="true"[^>]*>(?:(?!<\/button>).)*Drafting…<\/button>/;
    const LIVE_DRAFT_BTN = /<button class="[^"]*"><svg(?:(?!<\/button>).)*Draft script<\/button>/;

    // =========================================================================
    c.head("0 · OLD: the click waited for the model, and froze the panel");
    {
      await as(jordan);
      hold = true;
      let settled = false;
      const p = A.generateScriptForTopicAction(T(10).id, F.monthId).then((r) => { settled = true; return r; });
      await waitFor(() => held.length === 1);
      await sleep(200);
      c.ok("OLD: generateScriptForTopicAction is still waiting while the model works (it returns only when the draft is done)", !settled && held.length === 1 && modelCalls.length === 1);
      releaseAll(); hold = false;
      const r = await p;
      c.ok("…and only then answers \"Drafted as v1 …\"", settled && r.ok && /^Drafted as v1/.test(r.message), r.message);
      const panelSrc = fs.readFileSync(path.join(REPO, "src/components/content/TopicsPanel.tsx"), "utf8");
      const draftBtn = panelSrc.slice(panelSrc.indexOf("function DraftButton"), panelSrc.indexOf("function TopicRow"));
      c.ok("NEW: the Draft script control takes no shared `busy` (each topic has its own state)", draftBtn.length > 100 && !/disabled=\{[^}]*\bbusy\b/.test(draftBtn) && !/generateScriptForTopicAction/.test(panelSrc) && /queueScriptDraftAction/.test(panelSrc));
      await clearSession();
    }

    // =========================================================================
    c.head("1 · auth");
    {
      const before = await prisma.programAiRun.count();
      const calls = () => Promise.all([
        A.queueScriptDraftAction(T(0).id, F.monthId), A.queueOwedScriptsAction(F.monthId), A.queueScriptRevisionAction("x", "revise", "shorter"),
        A.queueStrategyDraftAction(F.enrollmentId), A.retryAiJobAction("x"), A.aiQueueStatusAction(F.enrollmentId),
      ]);
      const out = await calls();
      await as(kim);
      const ed = await calls();
      c.ok("signed out: every queue action and the poll refuse", out.every((r) => !r.ok), out.map((r) => r.message).join(" | ").slice(0, 200));
      c.ok("an EDITOR: refused too", ed.every((r) => !r.ok), ed.map((r) => r.message).join(" | ").slice(0, 200));
      c.ok("…nothing written, nothing scheduled, no model call", (await prisma.programAiRun.count()) === before && pendingAfter.length === 0 && modelCalls.length === 1);
      await clearSession();
    }

    // =========================================================================
    c.head("2 · instant: \"Sent for scripting\", the AI still waiting in after()");
    let firstRun = "";
    {
      await as(jordan);
      const r = await A.queueScriptDraftAction(T(0).id, F.monthId);
      const rows = await runsFor(T(0).id);
      c.ok("the click answers at once with Jordan's words", r.ok && r.message === `Sent for scripting — ${TITLES[0]}. It'll appear on the Scripts tab when it's ready.`, r.message);
      c.ok("…the model untouched, one worker waiting in after()", modelCalls.length === 1 && pendingAfter.length === 1);
      const row = rows[0];
      firstRun = row?.id ?? "";
      c.ok("one QUEUED ProgramAiRun: the generator's own key, Jordan's name, no attempt spent", rows.length === 1 && row.status === "QUEUED" && row.dedupeKey === `script:${T(0).id}:${F.monthId}` && row.requestedBy === jordan.email && row.attempts === 0 && row.kind === "script_draft" && r.runId === row.id, JSON.stringify({ s: row?.status, k: row?.dedupeKey, by: row?.requestedBy }));
      const st = await q.queueStateFor(F.enrollmentId, { monthId: F.monthId });
      c.ok("the queue state says topic 1 is queued; the poll's list is the same list the page renders", st.topics[T(0).id]?.state === "queued" && JSON.stringify(st.active) === JSON.stringify(await q.activeQueueRuns(F.enrollmentId)) && st.active.includes(firstRun));
      const { html } = await topicsHtml();
      const row0 = rowOf(html, 0);
      c.ok("the topic reads \"Drafting…\" — disabled, with a spinner — from the server's own state (survives a refresh)", DRAFTING_BTN.test(row0) && /animate-spin/.test(row0), text(row0).slice(0, 200));
      const others = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => rowOf(html, i));
      c.ok("…and every OTHER month topic keeps a live \"Draft script\" button", others.every((h) => LIVE_DRAFT_BTN.test(h) && !/Drafting…/.test(h)), String(others.filter((h) => !LIVE_DRAFT_BTN.test(h)).length));
      c.ok("…the topic drafted the old way already says \"Script drafted → View\"", /Script drafted → View/.test(rowOf(html, 10)));
      const poll = await A.aiQueueStatusAction(F.enrollmentId);
      c.ok("the poll answers with the in-flight list (and starts a worker: work waits and a slot is free)", poll.ok && JSON.stringify(poll.active) === JSON.stringify(st.active) && pendingAfter.length === 2, JSON.stringify(poll));
      pendingAfter.length = 0; // the drill runs the workers itself below
    }

    // =========================================================================
    c.head("3 · no duplicates");
    {
      const again = await A.queueScriptDraftAction(T(0).id, F.monthId);
      c.ok("a second click on the same topic: \"already being drafted\", the same run, no second row", !again.ok && again.runId === firstRun && /already being drafted/.test(again.message) && (await runsFor(T(0).id)).length === 1, again.message);
      const [a, b] = await Promise.all([A.queueScriptDraftAction(T(1).id, F.monthId), A.queueScriptDraftAction(T(1).id, F.monthId)]);
      c.ok("two clicks at once on another topic: one queued, one told it is already drafting, ONE row", [a, b].filter((x) => x.ok).length === 1 && [a, b].some((x) => !x.ok && /already being drafted/.test(x.message)) && (await runsFor(T(1).id)).length === 1, `${a.message} / ${b.message}`);
      c.ok("draftStateOf: a click still on its way reads drafting; a retry beats the old failure; a script wins", draftStateOf({ scriptId: null }, { server: null, sent: { runId: null } }) === "drafting"
        && draftStateOf({ scriptId: null }, { server: { state: "failed", runId: "old", error: "x", at: "" }, sent: { runId: "new" } }) === "drafting"
        && draftStateOf({ scriptId: null }, { server: { state: "failed", runId: "new", error: "x", at: "" }, sent: { runId: "new" } }) === "failed"
        && draftStateOf({ scriptId: "s" }, { server: { state: "running", runId: "r", error: null, at: "" }, sent: null }) === "drafted"
        && draftStateOf({ scriptId: null }, { server: null, sent: null }) === "idle");
      pendingAfter.length = 0;
    }

    // =========================================================================
    c.head("4 · eight topics at once: three run, five wait, each worker takes the next");
    {
      for (let i = 2; i < 8; i++) {
        const r = await A.queueScriptDraftAction(T(i).id, F.monthId);
        if (!r.ok) c.ok(`queue topic ${i + 1}`, false, r.message);
      }
      const queued = await prisma.programAiRun.count({ where: { status: "QUEUED", scopeJson: { contains: '"via":"queue"' } } });
      c.ok("eight topics queued → eight QUEUED rows; the six new clicks each handed a worker to after()", queued === 8 && pendingAfter.length === 6, `${queued} queued, ${pendingAfter.length} workers`);
      // Two more workers stand in for the first two clicks' (cleared above): eight in all.
      pendingAfter.push(() => q.drainAiQueue({ origin: "click" }), () => q.drainAiQueue({ origin: "click" }));
      hold = true; maxInFlight = 0;
      const modelBefore = modelCalls.length;
      const workers = pendingAfter.splice(0).map((fn) => Promise.resolve(fn()));
      let doneWorkers = 0;
      for (const w of workers) void w.then(() => { doneWorkers++; });
      await waitFor(() => held.length === 3);
      await sleep(300); // give the other five every chance to (wrongly) start
      const running = await prisma.programAiRun.count({ where: { status: "RUNNING", leaseBy: { startsWith: "queue:" } } });
      const waiting = await prisma.programAiRun.count({ where: { status: "QUEUED", scopeJson: { contains: '"via":"queue"' } } });
      c.ok("exactly THREE model calls in flight, three rows RUNNING under queue leases, five still QUEUED", held.length === 3 && inFlight === 3 && running === 3 && waiting === 5, `held ${held.length} running ${running} queued ${waiting}`);
      c.ok("…the five workers that found the cap full have already left", doneWorkers === 5, String(doneWorkers));
      const st = await q.queueStateFor(F.enrollmentId, { monthId: F.monthId });
      c.ok("the page: three topics 'running', five 'queued' (both read \"Drafting…\")", Object.values(st.topics).filter((x) => x.state === "running").length === 3 && Object.values(st.topics).filter((x) => x.state === "queued").length === 5);
      // Let them through one at a time; each finished worker takes the next.
      let released = 0;
      while (released < 8) {
        if (!(await waitFor(() => held.length > 0, 20_000))) break;
        held.shift()!.release(); released++;
        await sleep(30);
      }
      hold = false; releaseAll();
      await Promise.all(workers);
      c.ok("never more than three at once, all eight drafted by the model exactly once", maxInFlight === 3 && modelCalls.length - modelBefore === 8, `max ${maxInFlight}, calls ${modelCalls.length - modelBefore}`);
      const per = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(async (i) => ({ runs: await runsFor(T(i).id), script: await scriptOf(T(i).id), topic: await prisma.contentTopic.findUniqueOrThrow({ where: { id: T(i).id } }) })));
      c.ok("eight scripts, each from ONE run row — the queued row itself (adopted, never a second run)", per.every((p) => p.runs.length === 1 && p.runs[0].status === "SUCCEEDED" && !!p.script && p.runs[0].outputRef?.startsWith("ContentScriptVersion:")), per.map((p) => `${p.runs.length}:${p.runs[0]?.status}`).join(","));
      const r0 = per[0].runs[0];
      c.ok("…the run carries the prompt it was built from, Jordan's name, one attempt, the key freed", r0.promptKey === "script" && r0.promptVersion === "script.v4-no-dashes" && r0.requestedBy === jordan.email && r0.attempts === 1 && r0.dedupeKey === null && r0.leaseBy === null && (r0.costCents ?? 0) > 0, JSON.stringify({ pk: r0.promptKey, pv: r0.promptVersion, a: r0.attempts, by: r0.requestedBy, k: r0.dedupeKey, l: r0.leaseBy, cost: r0.costCents }));
      c.ok("…every topic SCRIPTED, each script INTERNAL_REVIEW (nothing approved or shared)", per.every((p) => p.topic.status === "SCRIPTED" && p.script?.status === "INTERNAL_REVIEW" && !p.script?.approvedVersionId && !p.script?.sharedVersionId));
    }

    // =========================================================================
    c.head("5 · done: \"Script drafted → View\" without a manual refresh");
    {
      const st = await q.queueStateFor(F.enrollmentId, { monthId: F.monthId });
      c.ok("nothing left in flight — the poll's list changes, which is what refreshes the page", st.active.length === 0 && Object.keys(st.topics).length === 0 && (await A.aiQueueStatusAction(F.enrollmentId)).active?.length === 0);
      const { html } = await topicsHtml();
      const row0 = rowOf(html, 0);
      c.ok("topic 1 now reads \"Script drafted → View\", linking to the month's Scripts tab", /Script drafted → View/.test(row0) && row0.includes(`href="/content/${F.enrollmentId}?tab=plan&amp;view=scripts`), text(row0).slice(0, 160));
      const watch = fs.readFileSync(path.join(REPO, "src/components/content/useAiQueueWatch.ts"), "utf8");
      c.ok("the page's watcher polls only while something is in flight, and refreshes when the list changes", /if \(!rendered \|\| !enrollmentId\) return;/.test(watch) && /router\.refresh\(\)/.test(watch) && /QUEUE_POLL_MS = 5000/.test(watch));
    }

    // =========================================================================
    c.head("6 · failure: the reason on the topic, and Try again");
    {
      failScripts = 1;
      const r = await A.queueScriptDraftAction(T(8).id, F.monthId);
      await flushAfter();
      const run = (await runsFor(T(8).id))[0];
      c.ok("the model fails → the run is FAILED with the reason, the key freed, no script", r.ok && run.status === "FAILED" && /503 isolated fake model unavailable/.test(run.error ?? "") && run.dedupeKey === null && !(await scriptOf(T(8).id)), `${run.status} ${run.error}`);
      const { html } = await topicsHtml();
      const row = rowOf(html, 8);
      c.ok("the topic: \"Drafting failed — Try again\" (a live button) and \"Why it failed: …\"", /Drafting failed — Try again/.test(row) && !/<button disabled=""[^>]*>(?:(?!<\/button>).)*Drafting failed/.test(row) && /Why it failed: 503 isolated fake model unavailable/.test(text(row)), text(row).slice(0, 220));
      const again = await A.queueScriptDraftAction(T(8).id, F.monthId);
      c.ok("Try again queues a new run at once", again.ok && again.runId !== run.id && (await q.queueStateFor(F.enrollmentId, { monthId: F.monthId })).topics[T(8).id]?.state === "queued");
      await flushAfter();
      c.ok("…which drafts it", !!(await scriptOf(T(8).id)) && (await q.queueStateFor(F.enrollmentId, { monthId: F.monthId })).topics[T(8).id] === undefined);
    }

    // =========================================================================
    c.head("7 · quota: refused at the click, not after a wait");
    {
      const used = await prisma.programAiRun.count({ where: { enrollmentId: F.enrollmentId, status: { in: ["RUNNING", "SUCCEEDED", "FAILED"] } } });
      await prisma.programAiQuota.create({ data: { scope: "ENROLLMENT", scopeRef: F.enrollmentId, period: "DAY", maxRuns: used, setBy: "drill" } });
      const r = await A.queueScriptDraftAction(T(9).id, F.monthId);
      c.ok("this client's daily AI limit is spent → refused with the reason, nothing queued", !r.ok && /this client's daily AI limit/.test(r.message) && (await runsFor(T(9).id)).length === 0 && pendingAfter.length === 0, r.message);
      await prisma.programAiQuota.deleteMany({ where: { scope: "ENROLLMENT", scopeRef: F.enrollmentId } });
    }

    // =========================================================================
    c.head("8 · stranded work comes back");
    {
      const r = await A.queueScriptDraftAction(T(9).id, F.monthId);
      pendingAfter.length = 0; // the worker "dies" before it runs
      const id = r.runId!;
      // A worker claimed it and was killed mid-draft (after()'s ceiling, a deploy).
      await prisma.programAiRun.update({ where: { id }, data: { status: "RUNNING", leaseBy: "queue:click:dead0001", leaseUntil: new RealDate(RealDate.now() - 60_000), attempts: 1, startedAt: new RealDate(RealDate.now() - 11 * 60_000) } });
      await aiRuns.expireStaleRuns();
      const afterCleanup = await prisma.programAiRun.findUniqueOrThrow({ where: { id } });
      c.ok("another caller's lease cleanup leaves the queue's row alone (it is not failed)", afterCleanup.status === "RUNNING" && afterCleanup.dedupeKey === `script:${T(9).id}:${F.monthId}`);
      const st = await q.queueStateFor(F.enrollmentId, { monthId: F.monthId });
      c.ok("…and the page still says it is drafting", st.topics[T(9).id]?.state === "running");
      const poll = await A.aiQueueStatusAction(F.enrollmentId);
      const requeued = await prisma.programAiRun.findUniqueOrThrow({ where: { id } });
      c.ok("the poll re-queues the dead worker's row (the reason on it) and starts a worker", poll.ok && requeued.status === "QUEUED" && /Interrupted on try 1/.test(requeued.error ?? "") && requeued.leaseBy === null && pendingAfter.length === 1, `${requeued.status} ${requeued.error}`);
      pendingAfter.length = 0; // nobody has the page open: the hourly cron finds it
      const cronSrc = fs.readFileSync(path.join(REPO, "src/app/api/cron/sync/route.ts"), "utf8");
      c.ok("the hourly cron/sync has an aiQueue step that drains it", /step\("aiQueue"/.test(cronSrc) && /drainAiQueueInParallel/.test(cronSrc));
      const drained = await q.drainAiQueueInParallel({ origin: "cron", budgetMs: 30_000 });
      const done = await prisma.programAiRun.findUniqueOrThrow({ where: { id } });
      c.ok("the cron's drain drafts it — attempt 2, ONE run row, one script", drained.done === 1 && done.status === "SUCCEEDED" && done.attempts === 2 && (await runsFor(T(9).id)).length === 1 && !!(await scriptOf(T(9).id)), JSON.stringify(drained));
      // Third interruption: stop, with the reason, and free the key.
      const T2 = await prisma.contentTopic.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, title: "Interrupted three times", source: "staff", status: "SELECTED" } });
      const r3 = await A.queueScriptDraftAction(T2.id, F.monthId);
      pendingAfter.length = 0;
      await prisma.programAiRun.update({ where: { id: r3.runId! }, data: { status: "RUNNING", leaseBy: "queue:cron:dead0003", leaseUntil: new RealDate(RealDate.now() - 1000), attempts: 3 } });
      const rec = await q.recoverStaleQueuedRuns();
      const gaveUp = await prisma.programAiRun.findUniqueOrThrow({ where: { id: r3.runId! } });
      c.ok("a third interruption stops: FAILED \"Interrupted 3 times …\", key freed — the page offers Try again", rec.failed === 1 && gaveUp.status === "FAILED" && /Interrupted 3 times/.test(gaveUp.error ?? "") && gaveUp.dedupeKey === null && (await q.queueStateFor(F.enrollmentId, { monthId: F.monthId })).topics[T2.id]?.state === "failed");
    }

    // =========================================================================
    c.head("9 · a zombie's late answer is not applied");
    {
      const Z = await prisma.contentTopic.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, title: "The zombie topic", source: "staff", status: "SELECTED" } });
      await A.queueScriptDraftAction(Z.id, F.monthId);
      pendingAfter.length = 0;
      hold = true;
      const a = q.drainAiQueue({ origin: "zombie", max: 1 });
      await waitFor(() => held.length === 1);
      const row = (await runsFor(Z.id))[0];
      const leaseA = row.leaseBy;
      // A freezes past its lease; the queue takes the row back and B claims it.
      await prisma.programAiRun.update({ where: { id: row.id }, data: { leaseUntil: new RealDate(RealDate.now() - 1000) } });
      await q.recoverStaleQueuedRuns();
      const b = q.drainAiQueue({ origin: "second", max: 1 });
      await waitFor(() => held.length === 2);
      const claimedB = await prisma.programAiRun.findUniqueOrThrow({ where: { id: row.id } });
      c.ok("B re-claimed the same row under its own lease (attempt 2)", claimedB.status === "RUNNING" && claimedB.leaseBy !== leaseA && claimedB.attempts === 2);
      held.shift()!.release(); // A answers late
      const ra = await a;
      held.shift()!.release(); hold = false;
      const rb = await b;
      const versions = await prisma.contentScriptVersion.count({ where: { scriptId: (await scriptOf(Z.id))?.id ?? "-" } });
      const finalRow = await prisma.programAiRun.findUniqueOrThrow({ where: { id: row.id } });
      c.ok("A's late answer is refused (lost), B's is written: ONE script with ONE version, one SUCCEEDED run", ra.lost === 1 && rb.done === 1 && versions === 1 && finalRow.status === "SUCCEEDED" && (await runsFor(Z.id)).length === 1, JSON.stringify({ ra, rb, versions }));
    }

    // =========================================================================
    c.head("10 · the other AI buttons on the workspace");
    {
      // "Draft what's ready" — a call-excerpt topic and a thin one.
      const O = await buildContentMonth(prisma, { name: "Owed Client TEST", package: "Accelerator", project: false, owner: false, topics: [
        { title: "Why sellers overprice", selection: "SELECTED", excerpts: ["I want to talk about why sellers overprice their homes every spring."] },
        { title: "My favourite coffee shop", selection: "SELECTED" },
      ] });
      const ready = await A.queueOwedScriptsAction(O.monthId, false);
      const owedRows = await prisma.programAiRun.findMany({ where: { enrollmentId: O.enrollmentId } });
      const scope = owedRows[0] ? JSON.parse(owedRows[0].scopeJson ?? "{}") as { job?: string; selectedOnCall?: boolean } : {};
      c.ok("\"Draft what's ready\" answers at once: one sent (the call-excerpt topic, on the topic path, selected on the call)", ready.ok && ready.queued === 1 && owedRows.length === 1 && scope.job === "script_topic" && scope.selectedOnCall === true && /^Sent 1 for scripting/.test(ready.message), ready.message);
      const twice = await A.queueOwedScriptsAction(O.monthId, false);
      c.ok("…pressed again while it runs: \"1 already being drafted\", nothing new", twice.queued === 0 && twice.already === 1 && (await prisma.programAiRun.count({ where: { enrollmentId: O.enrollmentId } })) === 1, twice.message);
      await flushAfter();
      const thin = await A.queueOwedScriptsAction(O.monthId, true);
      await flushAfter();
      c.ok("\"Draft from the topic alone\" queues the thin one; both drafted", thin.ok && thin.queued === 1 && (await prisma.contentScript.count({ where: { monthId: O.monthId } })) === 2, thin.message);

      // "Ask AI to revise" / "Tighten".
      const s0 = (await scriptOf(T(0).id))!;
      const s1 = (await scriptOf(T(1).id))!;
      const rev = await A.queueScriptRevisionAction(s0.id, "revise", "Make the hook punchier");
      const revRow = await prisma.programAiRun.findFirstOrThrow({ where: { dedupeKey: `revise:${s0.id}` } });
      c.ok("\"Ask AI to revise\" answers at once; one QUEUED script_revise row on the script's key", rev.ok && /Sent for revision/.test(rev.message) && revRow.status === "QUEUED" && revRow.kind === "script_revise" && pendingAfter.length === 1, rev.message);
      const rev2 = await A.queueScriptRevisionAction(s0.id, "revise", "Again");
      c.ok("…a second ask while it runs is refused (\"already being revised\")", !rev2.ok && /already being revised/.test(rev2.message));
      const sd = await loadScriptsTab(F.enrollmentId, { id: F.monthId });
      const sHtml = renderToStaticMarkup(createElement(ScriptsPanel, ser({ enrollmentId: F.enrollmentId, scripts: sd.scripts, queueCount: sd.queueCount, scriptOwner: sd.scriptOwner, owed: sd.owed, revising: sd.revising, drafting: sd.drafting, queueActive: sd.queueActive })));
      const seg = (id: string) => { const i = sHtml.indexOf(`>${sd.scripts.find((x) => x.id === id)!.title}<`); return sHtml.slice(i, sHtml.indexOf("</details>", i)); };
      c.ok("the Scripts tab: that script reads \"revising…\" with its Ask-AI button disabled", /revising…/.test(seg(s0.id)) && /<button disabled=""[^>]*>(?:(?!<\/button>).)*Ask AI to revise/.test(seg(s0.id)), text(seg(s0.id)).slice(0, 200));
      c.ok("…every other script keeps a live \"Ask AI to revise\"", !/revising…/.test(seg(s1.id)) && /<button class="[^"]*"><svg(?:(?!<\/button>).)*Ask AI to revise/.test(seg(s1.id)));
      dashOutput = true;
      await flushAfter();
      dashOutput = false;
      const v2 = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: s0.id }, orderBy: { versionNo: "desc" } });
      const revCall = modelCalls.filter((m) => m.kind === "revise").at(-1);
      c.ok("…the worker writes v2 (REVISION) from the queued row; v1 is kept", v2.versionNo === 2 && v2.source === "REVISION" && (await prisma.programAiRun.findUniqueOrThrow({ where: { id: revRow.id } })).status === "SUCCEEDED");
      c.ok("…the revise prompt told the model to take dashes out", /PUNCTUATION: the new version has no em dash or en dash anywhere/.test(revCall?.prompt ?? ""));
      failScripts = 1;
      const rev3 = await A.queueScriptRevisionAction(s1.id, "revise", "Warmer close");
      await flushAfter();
      const sd2 = await loadScriptsTab(F.enrollmentId, { id: F.monthId });
      const html2 = renderToStaticMarkup(createElement(ScriptsPanel, ser({ enrollmentId: F.enrollmentId, scripts: sd2.scripts, queueCount: sd2.queueCount, scriptOwner: sd2.scriptOwner, owed: sd2.owed, revising: sd2.revising, drafting: sd2.drafting, queueActive: sd2.queueActive })));
      c.ok("a failed revision: \"The revision failed: <reason>\" with Try again on that script", rev3.ok && sd2.revising[s1.id]?.state === "failed" && /The revision failed: 503 isolated fake model unavailable/.test(text(html2)) && /Try again/.test(html2));
      const retry = await A.retryAiJobAction(sd2.revising[s1.id].runId);
      await flushAfter();
      c.ok("…Try again re-asks the same instruction and writes v2", retry.ok && (await prisma.contentScriptVersion.count({ where: { scriptId: s1.id } })) === 2 && (await loadScriptsTab(F.enrollmentId, { id: F.monthId })).revising[s1.id] === undefined, retry.message);
      const tight = await A.queueScriptRevisionAction(s1.id, "tighten");
      c.ok("Tighten on a short script refuses at once (nothing queued)", !tight.ok && /UNDER the 30–50 s target/.test(tight.message) && pendingAfter.length === 0, tight.message);

      // "Draft from the discovery call".
      const S = await buildContentMonth(prisma, { name: "Sam Strategy TEST", package: "Accelerator", project: false, owner: false });
      const none = await A.queueStrategyDraftAction(S.enrollmentId);
      c.ok("no discovery call → refused at once with the reason", !none.ok && /No brand-discovery call/.test(none.message), none.message);
      const call = await prisma.programCallRecord.create({ data: { enrollmentId: S.enrollmentId, clientId: S.clientId, callType: "BRAND_DISCOVERY", status: "COMPLETED", scheduledStart: new RealDate("2026-10-08T14:00:00Z"), scheduledEnd: new RealDate("2026-10-08T14:45:00Z"), matchState: "MATCHED", transcriptState: "CONFIRMED" } });
      await prisma.programOnboarding.upsert({ where: { enrollmentId: S.enrollmentId }, create: { enrollmentId: S.enrollmentId, clientId: S.clientId, discoveryCallRecordId: call.id, status: "DISCOVERY_HELD" }, update: { discoveryCallRecordId: call.id } });
      const words = "Jordan: Tell me about your business.\nSam: I sell move-up homes in Chester County and I want calm, clear videos about pricing. " + "We talked about pricing, the town and the first weekend. ".repeat(8);
      await prisma.programTranscriptSource.create({ data: { callRecordId: call.id, provider: "paste", text: words, contentHash: "oct12q-strategy", matchState: "CONFIRMED", confirmedBy: "drill", confirmedAt: new RealDate(), createdBy: "drill" } });
      const sq = await A.queueStrategyDraftAction(S.enrollmentId);
      c.ok("with the call: \"Sent for drafting …\" at once, one QUEUED strategy_draft on the call's key", sq.ok && /^Sent for drafting/.test(sq.message) && (await prisma.programAiRun.findFirst({ where: { dedupeKey: `strategy:${call.id}`, status: "QUEUED" } })) !== null && modelCalls.filter((m) => m.kind === "strategy").length === 0, sq.message);
      const stTab = await loadStrategyTab(S.enrollmentId, null);
      const stHtml = text(renderToStaticMarkup(createElement(StrategyPanel, ser({ enrollmentId: S.enrollmentId, versions: stTab.versions, proposals: stTab.proposals, pillars: stTab.pillars, mapping: stTab.mapping, owners: stTab.owners, staff: stTab.staff, isOwner: true, month: null, discovery: stTab.discovery, queueActive: stTab.queueActive }))));
      c.ok("the Strategy tab reads \"Drafting the strategy…\"", /Drafting the strategy…/.test(stHtml), stHtml.slice(stHtml.indexOf("Discovery"), stHtml.indexOf("Discovery") + 200));
      await flushAfter();
      const sv = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: S.enrollmentId } });
      const ob = await prisma.programOnboarding.findUniqueOrThrow({ where: { enrollmentId: S.enrollmentId } });
      c.ok("…the worker drafts it: a DRAFT version from the call, the onboarding pointed at it", !!sv && sv.status === "DRAFT" && sv.callRecordId === call.id && ob.strategyDraftVersionId === sv.id);
      await as(kyle);
      const notOwner = await A.queueStrategyDraftAction(S.enrollmentId);
      c.ok("an ADMIN who is not the strategy owner is refused, as before", !notOwner.ok && /strategy approval is assigned/.test(notOwner.message), notOwner.message);
      const kyleDraft = await A.queueScriptDraftAction(F.topicIds[10], F.monthId);
      c.ok("an ADMIN may queue a script draft (\"already has a script\" here — checked before anything is written)", !kyleDraft.ok && /already has a script/.test(kyleDraft.message), kyleDraft.message);
      await as(jordan);

      // "Refresh topics" — answers while its run is still RUNNING.
      const rr = await A.runTopicRefresh(F.enrollmentId, "REFRESH");
      const refreshRun = await prisma.contentTopicRefreshRun.findFirstOrThrow({ where: { enrollmentId: F.enrollmentId, kind: "REFRESH" }, orderBy: { createdAt: "desc" } });
      const active = await q.activeQueueRuns(F.enrollmentId);
      c.ok("\"Refresh topics\" answers \"Refreshing topics in the background …\" with its run RUNNING and on the poll's list", rr.ok && /in the background/.test(rr.message) && refreshRun.status === "RUNNING" && active.includes(`refresh:${refreshRun.id}`) && pendingAfter.length === 1, rr.message);
      const { html: tHtml } = await topicsHtml();
      c.ok("…the panel says \"Refreshing topics…\" instead of the button", /Refreshing topics…/.test(text(tHtml)));
      await flushAfter();
      const finished = await prisma.contentTopicRefreshRun.findUniqueOrThrow({ where: { id: refreshRun.id } });
      c.ok("…and its outcome lands on the run (no approved strategy here → NEEDS_INPUT), off the poll's list", finished.status === "NEEDS_INPUT" && !(await q.activeQueueRuns(F.enrollmentId)).includes(`refresh:${refreshRun.id}`), finished.status);
    }

    // =========================================================================
    c.head("11 · no dashes in a script (Jordan, Oct 12)");
    {
      c.ok("the policy version was bumped and every prompt's rules carry the punctuation rule", policy.GENERATION_POLICY_VERSION === "2026-10-12.1" && policy.policyRulesText().includes("=== PUNCTUATION (Jordan, Oct 12 2026) ===") && policy.policyRulesText().includes(policy.SCRIPT_PUNCTUATION_RULE));
      const scriptCall = modelCalls.filter((m) => m.kind === "script").at(-1)!;
      c.ok("the script prompt repeats it beside its own rules; the strategy prompt carries it too", scriptCall.system.includes(`PUNCTUATION: ${policy.SCRIPT_PUNCTUATION_RULE}`) && (modelCalls.find((m) => m.kind === "strategy")?.system ?? "").includes(policy.SCRIPT_PUNCTUATION_RULE));
      c.ok("the rule names the dashes but uses neither as punctuation", !/\w\s*[—–]\s*\w/.test(policy.SCRIPT_PUNCTUATION_RULE));
      const ti = policy.tightenInstruction({ seconds: 70, words: 154, wordsPerSec: policy.GENERATION_POLICY.timing.wordsPerSec, target: policy.GENERATION_POLICY.timing.targetSec });
      c.ok("the Tighten instruction has no em dash (beyond the rule naming one) and restates the rule", !ti.replace(policy.SCRIPT_PUNCTUATION_RULE, "").includes("—") && ti.includes(policy.SCRIPT_PUNCTUATION_RULE), ti);
      const cases: [string, string][] = [
        ["The price — not the photos — sells it.", "The price, not the photos, sells it."],
        ["A 30–50 second video", "A 30 to 50 second video"],
        ["Budget $400–$500 a month", "Budget $400 to $500 a month"],
        ["Wait, — here's why.", "Wait, here's why."],
        ["Here's the thing —", "Here's the thing."],
        ["Want to know why? —", "Want to know why?"],
        ["— a first point", "a first point"],
        ["word—word", "word, word"],
        ["It worked — Buyers lined up.", "It worked. Buyers lined up."],
        ["two -- dashes", "two, dashes"],
        ["first-time buyers stay hyphenated", "first-time buyers stay hyphenated"],
        ["Line one —\nLine two — ends", "Line one.\nLine two, ends"],
      ];
      const bad = cases.filter(([i, o]) => policy.stripScriptDashes(i) !== o);
      c.ok("stripScriptDashes: a comma mid-sentence, \"to\" in a range, gone beside punctuation, a period at a line's end; hyphens untouched", bad.length === 0, bad.map(([i, o]) => `${JSON.stringify(i)} → ${JSON.stringify(policy.stripScriptDashes(i))} (want ${JSON.stringify(o)})`).join(" | "));
      c.ok("…and idempotent", cases.every(([i]) => policy.stripScriptDashes(policy.stripScriptDashes(i)) === policy.stripScriptDashes(i)));
      c.ok("a TITLE takes a colon", policy.stripScriptDashes("Spring Market — What Sellers Miss", { title: true }) === "Spring Market: What Sellers Miss");

      // An AI draft whose model output is full of dashes.
      const D = await prisma.contentTopic.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, title: "Dashes — everywhere", source: "staff", status: "SELECTED" } });
      dashOutput = true;
      await A.queueScriptDraftAction(D.id, F.monthId);
      await flushAfter();
      dashOutput = false;
      const ds = (await scriptOf(D.id))!;
      const dv = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: ds.currentVersionId! } });
      const spoken = [dv.title, dv.hook, dv.pointsJson, dv.close, dv.captionCta ?? "", dv.body, ds.title, ds.body].join("\n");
      c.ok("an AI draft is stored with NO dash — title, hook, points, close, caption CTA, body", !/[—–]/.test(spoken) && dv.title === "Dashes: everywhere" && dv.hook === "The first weekend decides your price, and most sellers miss it." && dv.close === "Planning to sell this spring. Call me before you pick a price." && dv.captionCta === "DM me PRICE, I'll send the guide", `${dv.title} | ${dv.hook} | ${dv.close} | ${dv.captionCta}`);
      c.ok("…and its stored findings carry no dash finding (they describe the words written)", !/punctuation\.dash/.test(dv.validationJson ?? ""));
      const v2 = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: (await scriptOf(T(0).id))!.id, versionNo: 2 } });
      c.ok("the queued revision (model output with dashes) is stored with none too", !/[—–]/.test([v2.hook, v2.pointsJson, v2.close, v2.captionCta ?? "", v2.body].join("\n")));
      const edit = await A.saveScriptText(ds.id, "Edited title\nHOOK\nThe market moved — fast.\nTalking Point 1: Re-hook\nBuyers noticed — sellers didn't.\nTalking Point 2: Build up\nPrices held.\nTalking Point 3: Payoff\nTiming is everything.\nClose / Call to action\nCall me — today.");
      const ev = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: ds.id }, orderBy: { versionNo: "desc" } });
      c.ok("a staff edit typed with dashes is saved without them (MANUAL version)", edit.ok && ev.source === "MANUAL" && ev.hook === "The market moved, fast." && ev.close === "Call me, today." && !/[—–]/.test(ev.body), `${ev.hook} | ${ev.close}`);
      const imp = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: null, parts: { title: "Filmed in 2025 — as delivered", hook: "We filmed this — exactly.", points: [{ role: null, text: "One — two." }], close: "Done — thanks." }, source: "IMPORT", createdBy: "drill", historical: true });
      const iv = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: imp.versionId } });
      c.ok("an IMPORTED historical record keeps its words exactly (dashes and all) — stored versions are never rewritten", iv.hook === "We filmed this — exactly." && iv.close === "Done — thanks.");
      const val = policy.validateNewScript(scripts.canonicalFromParts({ title: "T", hook: "A hook — with a dash.", points: [{ role: "re-hook", text: "One." }, { role: "build-up", text: "Two." }, { role: "payoff", text: "Three – four." }], close: "Close.", categoryLabel: "Seller Strategy" }), { requirePillar: false });
      const f = val.findings.find((x) => x.code === "punctuation.dash");
      c.ok("the format check reports one that gets through: a WARNING naming where (never a block)", !!f && f.severity === "warn" && /hook, talking point 3/.test(f.message) && val.ok, f?.message);
      const uploadSrc = fs.readFileSync(path.join(REPO, "src/lib/scriptUpload.ts"), "utf8");
      const actionsSrc = fs.readFileSync(path.join(REPO, "src/app/content/actions.ts"), "utf8");
      c.ok("the upload and an applied client suggestion write through the same choke point (createScriptVersion / reviseScript)", /createScriptVersion\(\{/.test(uploadSrc) && /reviseScriptWithInstructions\(sugg\.scriptId|reviseScriptWithInstructions\(/.test(actionsSrc));
    }

    // =========================================================================
    c.head("12 · nothing reached a client");
    {
      c.ok("no email queued, no program message, nothing approved, released or client-visible", (await prisma.outboxMessage.count()) === 0 && (await prisma.programMessage.count()) === 0 && (await prisma.contentScript.count({ where: { OR: [{ approvedVersionId: { not: null } }, { sharedVersionId: { not: null } }] } })) === 0 && (await prisma.contentTopic.count({ where: { clientVisible: true } })) === 0);
      c.ok("no network: nothing left the box", fence.blocked.length === 0, JSON.stringify(fence.blocked.slice(0, 3)));
    }
    await clearSession();
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
