// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: OCT 23 2026, "WRITE IT AGAIN" ON A SCRIPT CARD, AND A MORE MENU THE
// CARD CAN'T CUT OFF.
//
// Jordan: "Give me an option to re-run the script write on the scripts." And,
// with a screenshot: the More menu on a monthly content script card opened
// past the card's bottom edge and only "Approve only (send later)" showed.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-script-rewrite.ts --logs <dir>
//
//   0. the rule (scriptRewriteRule): refused in plain words for history, a
//      filmed video, a client-approved script, one that has gone to the
//      client (now or ever), a bulk plan's own words, no topic, no month
//   1. the press: one queued AI run, attributed, answered at once; the card
//      says "writing again…"; a second press is refused while it waits
//   2. the run: generateScriptForTopic (the hub's own path) writes the next
//      version on the SAME script; every earlier version stays; one run
//   3. refused, nothing queued, nothing touched: shared, pulled back from the
//      portal, client-approved, filmed, imported history, two scripts on one
//      topic; the card greys the item and says why
//   4. shared while it waited: the queued job checks again before the writer
//      and stops with the reason; no model call, no version; Try again is
//      refused the same way
//   5. exactly as the first draft: a skit topic is written by the skit
//      writer; a client switched on to the new writer goes to the new writer
//   6. limits: the client's daily AI limit refuses it exactly as a revise
//   7. who: owner, office and creative manager (the revise guard); editors
//      and photographers refused, word for word as the revise
//   8. the More menu: placed against the screen (never inside the card's
//      clipped box), upward when there is no room below; items in the page
//      when closed (Tab reaches them), Escape and a press elsewhere close it
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness; every outbound call
// is fenced; the model is stubbed at aiJsonWithUsage; nothing is sent.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { isJudgeCall, passingJudge, isIdentityCall, plainIdentity } from "./_judge";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 7323);
const REPO = path.resolve(__dirname, "../..");
installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown };
navigation.useRouter = () => ({ refresh() {} });
const fence = fenceFetch(async () => null);

// ---- after(): captured, so the drill decides when the queue's worker runs ----
const pendingAfter: (() => Promise<unknown> | unknown)[] = [];
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: (fn: () => Promise<unknown> | unknown) => { pendingAfter.push(fn); } }));
async function flushAfter() { while (pendingAfter.length) await pendingAfter.shift()!(); }

// ---- the model boundary -------------------------------------------------------
const SKIT = {
  hook: "[Dana sits alone at a folding table with a microphone.]\nREPORTER (off camera): Your buyers just got their keys. How do you feel?\nDANA: Tired. Proud. Mostly tired.",
  rehook: "REPORTER (off camera): That inspection report was long. Worried?\nDANA: Long reports scare people. They shouldn't.",
  build: "DANA: You don't fight every play. Ask about the big ones: roof, foundation, systems.",
  payoff: "REPORTER (off camera): Advice for buyers?\nDANA: Read the report for safety and big costs.",
  close: "DANA: Call me before your inspection, not after.",
};
const usage = { inputTokens: 700, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0 };
const scriptPrompts: { system: string; prompt: string }[] = [];
const otherCalls: string[] = [];
let draftNo = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || /[\\/]integrations[\\/]ai(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        if (isJudgeCall(opts.system)) return passingJudge();
        if (isIdentityCall(opts.system)) return plainIdentity();
        // Anything else (the new writer's steps among them) is not answered: it is recorded and stopped.
        if (!/personal-branding video script/.test(opts.system)) { otherCalls.push(opts.system.slice(0, 120)); throw new Error(`MODEL_NOT_STUBBED: ${opts.system.slice(0, 80)}`); }
        scriptPrompts.push({ system: opts.system, prompt: opts.prompt });
        const n = ++draftNo;
        const base = { title: "Price it for the first weekend", category: "Seller Strategy", captionCta: "DM me PRICE.", filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [] };
        if (/VIDEO STYLE: SKITS/.test(opts.system)) return { result: { ...base, title: "The Postgame Closing Interview", hook: SKIT.hook, points: [{ role: "re-hook", text: SKIT.rehook }, { role: "build-up", text: SKIT.build }, { role: "payoff", text: `${SKIT.payoff} Take ${n}.` }], close: SKIT.close }, usage, model: "drill-stub" };
        return { result: { ...base, hook: `Draft ${n}: the first weekend decides your price.`, points: [{ role: "re-hook", text: "Buyers read every week on the market as a signal." }, { role: "build-up", text: "A stale listing invites the low offers you wanted to avoid." }, { role: "payoff", text: "Price it right on day one and buyers compete for you." }], close: "Selling this spring? Call me before you pick a price." }, usage, model: "drill-stub" };
      };
    },
  }),
);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-script-rewrite", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession } = await import("@/lib/auth/session");
  const A = await import("@/app/content/actions");
  const scripts = await import("@/lib/contentScripts");
  const gen = await import("@/lib/contentGeneration");
  const vf = await import("@/lib/contentPolicy/videoFormat");
  const rule = await import("@/lib/scriptRewriteRule");
  const { queueStateFor } = await import("@/lib/aiQueue");
  const { placeMenu } = await import("@/components/ui/useDetailsMenu");
  const { loadScriptsTab } = await import("@/app/content/[id]/programData");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { ScriptsPanel } = await import("@/components/content/ScriptsPanel");
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rsquo;/g, "’").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
  const ser = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
  const R = rule.REWRITE_REFUSED;

  try {
    // =======================================================================
    c.head("0 · the rule, in plain words");
    const ok: import("@/lib/scriptRewriteRule").RewriteFacts = { historical: false, filmed: false, clientApproved: false, everShared: false, bulkBank: false, hasTopic: true, hasMonth: true };
    c.ok("a draft on a topic and a month may be written again", rule.rewriteRefusal(ok) === null);
    c.ok("history, filmed, client-approved, sent to the client, a bulk plan's words, no topic, no month: each refused with its reason", rule.rewriteRefusal({ ...ok, historical: true }) === R.historical && rule.rewriteRefusal({ ...ok, filmed: true }) === R.filmed && rule.rewriteRefusal({ ...ok, clientApproved: true }) === R.clientApproved && rule.rewriteRefusal({ ...ok, everShared: true }) === R.everShared && rule.rewriteRefusal({ ...ok, bulkBank: true }) === R.bulkBank && rule.rewriteRefusal({ ...ok, hasTopic: false }) === R.noTopic && rule.rewriteRefusal({ ...ok, hasMonth: false }) === R.noMonth);
    c.ok("the reasons are plain sentences (no codes, no em dashes)", Object.values(R).every((m) => /^[A-Z]/.test(m) && m.endsWith(".") && !/—/.test(m) && !/[A-Z_]{5,}/.test(m)));

    // ---- people and the month --------------------------------------------
    const mk = (email: string, name: string, role: string) => prisma.appUser.create({ data: { email, name, role, status: "ACTIVE" } });
    const jordan = await mk("jordan@oct23-rewrite.test", "Jordan", "OWNER");
    const kyle = await mk("kyle@oct23-rewrite.test", "Kyle", "ADMIN");
    const james = await mk("james@oct23-rewrite.test", "James", "CREATIVE_MANAGER");
    const kim = await mk("kim@oct23-rewrite.test", "Kim", "EDITOR");
    const harrison = await mk("harrison@oct23-rewrite.test", "Harrison", "PHOTOGRAPHER");
    const as = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    await as(jordan);
    await prisma.programAutomation.upsert({ where: { key: "ai_runs" }, create: { key: "ai_runs", enabled: true, enabledBy: "drill", enabledAt: new Date() }, update: { enabled: true } });
    const staff = { email: jordan.email, appUserId: jordan.id };
    const F = await buildContentMonth(prisma, { name: "Rewrite Drill TEST", package: "Pro", topics: [
      { title: "Price it for the first weekend", selection: "SELECTED", excerpts: ["Sellers who price right on day one get the weekend rush."] },
      { title: "Already shared", selection: "SELECTED" },
      { title: "The postgame closing interview", selection: "SELECTED", excerpts: ["My husband plays the reporter, I'm the tired agent."] },
      { title: "Pulled back from the portal", selection: "SELECTED" },
      { title: "The client approved it", selection: "SELECTED" },
      { title: "Already filmed", selection: "SELECTED" },
      { title: "On the new writer", selection: "SELECTED" },
      { title: "Kyle presses", selection: "SELECTED" },
      { title: "James presses", selection: "SELECTED" },
      { title: "Imported history", selection: "SELECTED" },
      { title: "Two scripts, one topic", selection: "SELECTED" },
    ] });
    const T = (i: number) => F.topicIds[i];
    const { createPillar } = await import("@/lib/contentPillars");
    const pillarId = await createPillar({ enrollmentId: F.enrollmentId, clientId: F.clientId, name: "Seller Strategy", createdBy: jordan.email });
    const head = (id: string) => prisma.contentScript.findUniqueOrThrow({ where: { id } });
    const versionsOf = (id: string) => prisma.contentScriptVersion.findMany({ where: { scriptId: id }, orderBy: { versionNo: "asc" } });
    const handMade = (i: number, title: string) => scripts.createScriptVersion({
      enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: T(i), source: "AI", status: "INTERNAL_REVIEW", createdBy: jordan.email,
      parts: { title, hook: `${title}: the first weekend decides it.`, points: [{ role: "re-hook", text: "Buyers decide in two days." }, { role: "build-up", text: "Price it right and they compete." }, { role: "payoff", text: "That is how you win the weekend." }], close: "Call me before you list.", pillarId, categoryLabel: "Seller Strategy" },
    });
    const runsNow = () => prisma.programAiRun.count({ where: { enrollmentId: F.enrollmentId } });
    const tab = async () => {
      const sd = await loadScriptsTab(F.enrollmentId, { id: F.monthId });
      const html = renderToStaticMarkup(createElement(ScriptsPanel, ser({ enrollmentId: F.enrollmentId, scripts: sd.scripts, queueCount: sd.queueCount, scriptOwner: sd.scriptOwner, owed: [], revising: sd.revising, drafting: sd.drafting, queueActive: sd.queueActive })));
      const cardOf = (id: string) => { const i = html.indexOf(`data-script-card="${id}"`); const j = html.indexOf("data-script-card=", i + 20); return i < 0 ? "" : html.slice(i, j < 0 ? html.length : j); };
      const moreOf = (id: string) => { const card = cardOf(id); const i = card.indexOf("data-more-menu"); return i < 0 ? "" : card.slice(i, card.indexOf("</details>", i)); };
      return { sd, html, cardOf, moreOf };
    };
    const rewriteBtn = (more: string) => more.match(/<button[^>]*data-rewrite="true"[^>]*>((?:(?!<\/button>).)*)<\/button>/)?.[0] ?? "";

    // =======================================================================
    c.head("1 · the press: one queued run, answered at once");
    const first = await gen.generateScriptForTopic({ topicId: T(0), monthId: F.monthId, requestedBy: jordan.email, unattended: false });
    const S0 = first.scriptId;
    const v1 = (await versionsOf(S0))[0];
    c.ok("the first draft, as the hub writes one (generateScriptForTopic): v1 on the topic's script", first.versionNo === 1 && !!v1 && scriptPrompts.length === 1);
    const promptsBefore = scriptPrompts.length;
    const runsBefore = await runsNow();
    const pressed = await A.queueScriptRewriteAction(S0);
    const queued = await prisma.programAiRun.findMany({ where: { enrollmentId: F.enrollmentId, status: "QUEUED" } });
    const scope = JSON.parse(queued[0]?.scopeJson ?? "{}") as Record<string, unknown>;
    c.ok("answered at once: \"Sent to be written again\", v1 kept", pressed.ok && /^Sent to be written again/.test(pressed.message) && /v1 and the rest of the history are kept/.test(pressed.message), pressed.message);
    c.ok("ONE queued AI run (like a revise): the topic's draft, landing on this script, attributed to Jordan", (await runsNow()) === runsBefore + 1 && queued.length === 1 && queued[0].id === pressed.runId && scope.job === "script_topic" && scope.rewriteOf === S0 && scope.topicId === T(0) && scope.monthId === F.monthId && queued[0].requestedBy === jordan.email && queued[0].kind === "script_draft", JSON.stringify(scope));
    c.ok("…holding the topic's own draft key (a draft of the same topic can't run beside it)", queued[0].dedupeKey === `script:${T(0)}:${F.monthId}`);
    c.ok("…the worker waits in after(); no model call, no version yet", pendingAfter.length === 1 && scriptPrompts.length === promptsBefore && (await versionsOf(S0)).length === 1);
    const again = await A.queueScriptRewriteAction(S0);
    c.ok("a second press while it waits is refused (already being written), nothing more queued", !again.ok && /already being written/.test(again.message) && (await runsNow()) === runsBefore + 1, again.message);
    const st = await queueStateFor(F.enrollmentId, { monthId: F.monthId });
    c.ok("the page's queue state shows it ON the script, labelled rewrite", st.scripts[S0]?.state === "queued" && st.scripts[S0]?.label === "rewrite" && !st.topics[T(0)], JSON.stringify(st.scripts[S0]));
    {
      const { cardOf, moreOf } = await tab();
      c.ok("the card says \"writing again…\" and \"Writing it again from the topic\"", /writing again…/.test(cardOf(S0)) && /Writing it again from the topic in the background/.test(text(cardOf(S0))));
      c.ok("…and Write it again is greyed while it runs", /disabled=""/.test(rewriteBtn(moreOf(S0))), rewriteBtn(moreOf(S0)));
    }

    // =======================================================================
    c.head("2 · the run: the hub's own path writes the next version, same script");
    await flushAfter();
    const vs = await versionsOf(S0);
    const h0 = await head(S0);
    const done = await prisma.programAiRun.findUniqueOrThrow({ where: { id: pressed.runId! } });
    const queueSrc = read("src/lib/aiQueue.ts");
    const topicCase = queueSrc.slice(queueSrc.indexOf('case "script_topic": {'), queueSrc.indexOf('case "script_interview": {', queueSrc.indexOf('case "script_topic": {')));
    c.ok("the queued job runs the hub's own path: generateScriptForTopic, attended, as the presser, onlyIfUnscripted off for a rewrite (checked again first)", /assertRewritable\(scope\.rewriteOf\)/.test(topicCase) && /generateScriptForTopic\(\{ topicId: scope\.topicId, monthId: scope\.monthId, requestedBy: by, unattended: false,[^\n]*onlyIfUnscripted: !scope\.rewriteOf, claimedRun: claimed/.test(topicCase) && topicCase.indexOf("assertRewritable") < topicCase.indexOf("await generateScriptForTopic("));
    c.ok("one model draft (the stub), no other draft run made", scriptPrompts.length === promptsBefore + 1 && (await prisma.programAiRun.count({ where: { enrollmentId: F.enrollmentId, kind: "script_draft", createdAt: { gte: queued[0].createdAt } } })) === 1);
    c.ok("v2 on the SAME script (one script for the topic), and it is current", vs.length === 2 && vs[1].versionNo === 2 && h0.currentVersionId === vs[1].id && (await prisma.contentScript.count({ where: { topicId: T(0), monthId: F.monthId } })) === 1);
    c.ok("…a fresh draft in generateScriptForTopic's own words (\"Drafted from the call excerpts\"), source AI, by Jordan, not a revision of v1", vs[1].source === "AI" && vs[1].createdBy === jordan.email && /^Drafted from the call excerpts/.test(vs[1].changeSummary ?? "") && vs[1].changeSummary?.replace(/\(.*$/, "") === v1.changeSummary?.replace(/\(.*$/, "") && !vs[1].basedOnVersionId && vs[1].hook !== v1.hook, vs[1].changeSummary ?? "");
    c.ok("…written by the queued run itself (the version's AI run is the press's run)", vs[1].aiRunId === pressed.runId);
    c.ok("v1 stays in the history, word for word", vs[0].id === v1.id && vs[0].body === v1.body && vs[0].hook === v1.hook && vs[0].status === v1.status);
    c.ok("the queued run is the run that wrote it (SUCCEEDED → v2)", done.status === "SUCCEEDED" && done.outputRef === `ContentScriptVersion:${vs[1].id}`, `${done.status} ${done.outputRef}`);
    {
      const { cardOf, moreOf } = await tab();
      c.ok("the card now shows v2 and offers Write it again again", cardOf(S0).includes("Draft 2: the first weekend decides your price.") && !/disabled=""/.test(rewriteBtn(moreOf(S0))) && /Write it again/.test(rewriteBtn(moreOf(S0))));
      c.ok("…version history (2) keeps v1 under More", /Show version history \(2\)/.test(text(moreOf(S0))));
    }

    // =======================================================================
    c.head("3 · refused in words; nothing queued, nothing touched");
    // Shared (approved and on the portal).
    const sh = await handMade(1, "Already shared");
    await scripts.approveScriptVersion(sh.versionId, staff);
    await scripts.releaseScriptVersion(sh.scriptId, staff);
    // Shared, then pulled back to the queue (the version keeps its sharedAt).
    const pb = await handMade(3, "Pulled back from the portal");
    await scripts.approveScriptVersion(pb.versionId, staff);
    await scripts.releaseScriptVersion(pb.scriptId, staff);
    await scripts.returnScriptToQueue(pb.scriptId, staff, "Drill: back to the queue");
    // The client approved it.
    const ca = await handMade(4, "The client approved it");
    await prisma.contentScript.update({ where: { id: ca.scriptId }, data: { clientApprovedVersionId: ca.versionId, clientApprovedAt: new Date() } });
    // Filmed (the topic says so).
    const fi = await handMade(5, "Already filmed");
    await prisma.contentTopic.update({ where: { id: T(5) }, data: { status: "FILMED" } });
    // Imported history.
    const hi = await handMade(9, "Imported history");
    await prisma.contentScript.update({ where: { id: hi.scriptId }, data: { historical: true, releaseState: "historical" } });
    // Two scripts on one topic this month.
    const d1 = await handMade(10, "Two scripts, one topic");
    await handMade(10, "Two scripts, one topic (again)");
    const before3 = await runsNow();
    const shBefore = await head(sh.scriptId);
    const rSh = await A.queueScriptRewriteAction(sh.scriptId);
    const rPb = await A.queueScriptRewriteAction(pb.scriptId);
    const rCa = await A.queueScriptRewriteAction(ca.scriptId);
    const rFi = await A.queueScriptRewriteAction(fi.scriptId);
    const rHi = await A.queueScriptRewriteAction(hi.scriptId);
    const rD = await A.queueScriptRewriteAction(d1.scriptId);
    c.ok("on the client's portal: refused, \"already gone to the client\"", !rSh.ok && rSh.message === R.everShared, rSh.message);
    c.ok("pulled back from the portal (it was pushed once): refused the same way", !rPb.ok && rPb.message === R.everShared, rPb.message);
    c.ok("the client approved it: refused", !rCa.ok && rCa.message === R.clientApproved, rCa.message);
    c.ok("its video is filmed: refused", !rFi.ok && rFi.message === R.filmed, rFi.message);
    c.ok("imported history: refused", !rHi.ok && rHi.message === R.historical, rHi.message);
    c.ok("two live scripts on one topic this month: refused rather than guessed", !rD.ok && /more than one script this month/.test(rD.message), rD.message);
    const shAfter = await head(sh.scriptId);
    c.ok("nothing queued, no model call, and the shared script is exactly as it was", (await runsNow()) === before3 && pendingAfter.length === 0 && (await versionsOf(sh.scriptId)).length === 1 && shAfter.sharedVersionId === shBefore.sharedVersionId && shAfter.currentVersionId === shBefore.currentVersionId && shAfter.updatedAt.getTime() === shBefore.updatedAt.getTime());
    c.ok("a missing script is refused in words", (await A.queueScriptRewriteAction("nope")).message === "That script no longer exists.");
    {
      const { cardOf, moreOf } = await tab();
      const shBtn = rewriteBtn(moreOf(sh.scriptId));
      c.ok("the released card greys Write it again and says why, under it", /disabled=""/.test(shBtn) && new RegExp(`aria-describedby="rewrite-why-${sh.scriptId}"`).test(shBtn) && text(moreOf(sh.scriptId)).includes(R.everShared), text(moreOf(sh.scriptId)).slice(0, 300));
      c.ok("…the filmed and client-approved cards too (their own reasons)", text(moreOf(fi.scriptId)).includes(R.filmed) && text(moreOf(ca.scriptId)).includes(R.clientApproved));
      c.ok("an imported history card has no Write it again at all", !/Write it again/.test(cardOf(hi.scriptId)));
    }

    // =======================================================================
    c.head("4 · shared while it waited: checked again before the writer, nothing spent");
    const p2 = await A.queueScriptRewriteAction(S0);
    c.ok("pressed on v2: queued", p2.ok && !!p2.runId, p2.message);
    const cur2 = (await head(S0)).currentVersionId!;
    await scripts.approveScriptVersion(cur2, staff);
    await scripts.releaseScriptVersion(S0, staff);
    const prompts4 = scriptPrompts.length;
    const others4 = otherCalls.length;
    const runs4 = await runsNow();
    await flushAfter();
    const stopped = await prisma.programAiRun.findUniqueOrThrow({ where: { id: p2.runId! } });
    c.ok("the job stopped with the plain reason, before the writer ran", stopped.status === "FAILED" && stopped.error === R.everShared, `${stopped.status}: ${stopped.error}`);
    c.ok("…no model call of any kind, no other run, no v3, the shared v2 untouched", scriptPrompts.length === prompts4 && otherCalls.length === others4 && (await runsNow()) === runs4 && (await versionsOf(S0)).length === 2 && (await head(S0)).sharedVersionId === cur2);
    {
      const { cardOf } = await tab();
      c.ok("the card says the fresh draft didn't finish, with the reason, and offers Try again", /The fresh draft didn.t finish/.test(text(cardOf(S0))) && text(cardOf(S0)).includes("already gone to the client") && /Try again/.test(text(cardOf(S0))));
    }
    const retried = await A.retryAiJobAction(p2.runId!);
    c.ok("Try again asks the same question: refused, nothing queued", !retried.ok && retried.message === R.everShared && pendingAfter.length === 0, retried.message);

    // =======================================================================
    c.head("5 · exactly as the first draft: the skit writer, the new writer");
    // A skit topic (the topic's own format) on this talking-to-camera account.
    const t2 = await prisma.contentTopic.findUniqueOrThrow({ where: { id: T(2) } });
    await prisma.contentTopic.update({ where: { id: T(2) }, data: { scoresJson: vf.withTopicFormat(t2.scoresJson, "SKIT") } });
    const sk1 = await gen.generateScriptForTopic({ topicId: T(2), monthId: F.monthId, requestedBy: jordan.email, unattended: false });
    const skPrompts = scriptPrompts.length;
    const pSk = await A.queueScriptRewriteAction(sk1.scriptId);
    await flushAfter();
    const skVs = await versionsOf(sk1.scriptId);
    c.ok("a skit topic: written again by the skit writer (the skit prompt), as v2 of the skit", pSk.ok && skVs.length === 2 && scriptPrompts.length === skPrompts + 1 && /VIDEO STYLE: SKITS/.test(scriptPrompts[scriptPrompts.length - 1].system));
    c.ok("…stored as a skit, speakers kept, like its first draft", vf.versionFormatOf(skVs[1]) === "SKIT" && !!skVs[1].speakerLabelsJson && vf.versionFormatOf(skVs[0]) === "SKIT");
    // A client switched on to the new writer: the rewrite goes to the new writer.
    const nw = await handMade(6, "On the new writer");
    await prisma.appSetting.create({ data: { key: "script_writer_v2", value: JSON.stringify({ on: true, enrollmentIds: [F.enrollmentId] }) } });
    const others5 = otherCalls.length;
    const prompts5 = scriptPrompts.length;
    const pNw = await A.queueScriptRewriteAction(nw.scriptId);
    const pressedAt = new Date();
    await flushAfter();
    const nwRun = await prisma.programAiRun.findUniqueOrThrow({ where: { id: pNw.runId! } });
    // The writer's steps are not stubbed here (they are drilled in the writer's own drills): its first step is
    // recorded as a run of the writer's own kind and stops the job, which is the proof of the route.
    const steps = await prisma.programAiRun.findMany({ where: { enrollmentId: F.enrollmentId, createdAt: { gte: new Date(pressedAt.getTime() - 5_000) }, kind: { in: ["script_retrieval", "script_brief", "script_hooks"] } }, select: { kind: true, scopeJson: true } });
    c.ok("switched on to the new writer: the rewrite went to the new writer (its own step ran for this topic; the old prompt did not)", pNw.ok && steps.length >= 1 && steps.every((s) => (s.scopeJson ?? "").includes(T(6))) && scriptPrompts.length === prompts5 && otherCalls.slice(others5).every((s) => !/personal-branding video script/.test(s)) && nwRun.status === "FAILED", `${steps.map((s) => s.kind).join()} · ${nwRun.error}`);
    c.ok("…and nothing was written for it", (await versionsOf(nw.scriptId)).length === 1);
    await prisma.appSetting.delete({ where: { key: "script_writer_v2" } });

    // =======================================================================
    c.head("6 · the client's daily AI limit: refused exactly as a revise");
    const ky = await handMade(7, "Kyle presses");
    await prisma.programAiQuota.create({ data: { scope: "ENROLLMENT", scopeRef: F.enrollmentId, period: "DAY", maxRuns: 0, enabled: true, setBy: "drill" } });
    const capRw = await A.queueScriptRewriteAction(ky.scriptId);
    const capRv = await A.queueScriptRevisionAction(ky.scriptId, "revise", "Shorter hook.");
    c.ok("at the client's daily limit: Write it again is refused with the same words as Ask AI to revise", !capRw.ok && !capRv.ok && /this client's daily AI limit/.test(capRw.message) && capRw.message === capRv.message, `${capRw.message} | ${capRv.message}`);
    await prisma.programAiQuota.deleteMany({ where: { scope: "ENROLLMENT", scopeRef: F.enrollmentId } });

    // =======================================================================
    c.head("7 · who may press it: the revise guard (owner, office, creative manager)");
    const jm = await handMade(8, "James presses");
    await as(kim);
    const kimRw = await A.queueScriptRewriteAction(ky.scriptId);
    const kimRv = await A.queueScriptRevisionAction(ky.scriptId, "revise", "Shorter hook.");
    await as(harrison);
    const harRw = await A.queueScriptRewriteAction(ky.scriptId);
    const harRv = await A.queueScriptRevisionAction(ky.scriptId, "revise", "Shorter hook.");
    c.ok("an editor is refused, word for word as the revise", !kimRw.ok && kimRw.message === kimRv.message && /don't have access/.test(kimRw.message), kimRw.message);
    c.ok("a photographer is refused, word for word as the revise", !harRw.ok && harRw.message === harRv.message, harRw.message);
    const before7 = await runsNow();
    await as(kyle);
    const kyRw = await A.queueScriptRewriteAction(ky.scriptId);
    await as(james);
    const jmRw = await A.queueScriptRewriteAction(jm.scriptId);
    const kyRow = kyRw.runId ? await prisma.programAiRun.findUnique({ where: { id: kyRw.runId } }) : null;
    const jmRow = jmRw.runId ? await prisma.programAiRun.findUnique({ where: { id: jmRw.runId } }) : null;
    c.ok("the office (Kyle) may: queued, his name on it", kyRw.ok && kyRow?.requestedBy === kyle.email, kyRw.message);
    c.ok("the creative manager (James) may, as he may revise: queued, his name on it", jmRw.ok && jmRow?.requestedBy === james.email, jmRw.message);
    c.ok("…two presses, two runs, nothing else", (await runsNow()) === before7 + 2);
    // The revise guard and this one are the same call.
    const src = read("src/app/content/actions.ts");
    const fnOf = (name: string) => src.slice(src.indexOf(`export async function ${name}(`), src.indexOf("\n}\n", src.indexOf(`export async function ${name}(`)));
    const guardOf = (name: string) => fnOf(name).match(/try \{ await (require\w+)\(\); \} catch/)?.[1];
    c.ok("the action's guard is the revise action's guard (requireCreativeLead)", guardOf("queueScriptRewriteAction") === "requireCreativeLead" && guardOf("queueScriptRewriteAction") === guardOf("queueScriptRevisionAction"));
    pendingAfter.length = 0; // these two are not run here

    // =======================================================================
    c.head("8 · the More menu: never cut off by the card");
    await as(jordan);
    {
      const { cardOf, moreOf } = await tab();
      const more = moreOf(jm.scriptId);
      c.ok("Write it again sits in More, after Ask AI to revise (the card keeps two actions up front)", text(more).indexOf("Ask AI to revise") >= 0 && text(more).indexOf("Write it again") > text(more).indexOf("Ask AI to revise") && /Approve only/.test(text(more)));
      c.ok("closed, every item is already in the page after More (Tab reaches them; no portal)", /<summary[^>]*aria-expanded="false"[^>]*>More/.test(more) && !/<details[^>]* open=""[^>]*data-more-menu/.test(cardOf(jm.scriptId)));
      c.ok("…drawn as a dropdown until it is placed (its own classes, above the page's sticky header)", /class="absolute left-0 z-40 mt-1 w-64/.test(more));
    }
    const screen = { width: 390, height: 800 };
    const list = { width: 256, height: 300 };
    const low = placeMenu({ top: 700, bottom: 736, left: 40 }, list, screen);
    c.ok("near the bottom of the screen (Jordan's case): it opens UPWARD, against the screen, full height", low.placement === "above" && low.style.position === "fixed" && low.style.bottom === 800 - 700 + 4 && low.style.top === "auto" && low.style.maxHeight === 700 - 12, JSON.stringify(low));
    const high = placeMenu({ top: 120, bottom: 156, left: 40 }, list, screen);
    c.ok("with room below it opens downward, under the button", high.placement === "below" && high.style.position === "fixed" && high.style.top === 160 && high.style.maxHeight === 800 - 156 - 12, JSON.stringify(high));
    c.ok("never off the side of a phone (left clamped inside the 8 px edge)", placeMenu({ top: 120, bottom: 156, left: 300 }, list, screen).style.left === 390 - 256 - 8 && placeMenu({ top: 120, bottom: 156, left: 2 }, list, screen).style.left === 8);
    const tall = placeMenu({ top: 300, bottom: 336, left: 40 }, { width: 256, height: 2000 }, screen);
    c.ok("taller than both sides: the roomier side, scrolling inside itself", tall.placement === "below" && tall.style.maxHeight === 800 - 336 - 12 && tall.style.overflowY === "auto");
    const hook = read("src/components/ui/useDetailsMenu.ts");
    const panel = read("src/components/content/ScriptsPanel.tsx");
    c.ok("the card's Section clips (overflow-hidden), which is why the list is placed against the screen", /overflow-hidden rounded-2xl/.test(read("src/components/ui/Section.tsx")) && /<div \{\.\.\.menu\.panelProps\} className="absolute/.test(panel) && /<details \{\.\.\.menu\.detailsProps\}[^>]*data-more-menu/.test(panel));
    c.ok("placed before it paints (layout effect), from the button's own box", /useLayoutEffect\(\(\) => \{\s*if \(!open\) return;/.test(hook) && /getBoundingClientRect\(\)/.test(hook) && /placeMenu\(r, \{ width: panel\.offsetWidth, height: panel\.scrollHeight \}/.test(hook));
    c.ok("keyboard and pointer: Enter/Space on More toggle it, Escape closes it back to More, a press elsewhere closes it", /e\.key === "Escape" && open/.test(hook) && /close\(true\)/.test(hook) && /document\.addEventListener\("pointerdown", outside\)/.test(hook) && /onClick: onSummaryClick/.test(hook));
    c.ok("a page scroll or resize closes it rather than leave it floating; its own scroll does not", /window\.addEventListener\("scroll", moved, true\)/.test(hook) && /panelRef\.current\?\.contains\(e\.target\)\) return;/.test(hook));
    c.ok("every item still closes the menu first (closeMenu → back to More)", /const closeMenu = \(\) => menu\.close\(true\)/.test(panel) && !/removeAttribute\("open"\)/.test(panel));

    // =======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
