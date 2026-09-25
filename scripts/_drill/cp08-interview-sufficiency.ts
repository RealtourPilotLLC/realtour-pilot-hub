// ---------------------------------------------------------------------------
// DRILL: CP-08 — finishing the questions is not the same as having enough
// (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp08-interview-sufficiency.ts
//
// The OLD behaviour is asserted first wherever it can be observed: the old
// contentInterview.ts, contentDrafting.ts and the portal sign-in route are
// loaded for real from e26cacd (where this batch starts), their `@/` imports
// pointed at this tree.
//
//   P. The pure rule: six skips are not sufficient; exactly two targeted gap
//      questions, never one the approved topic already answers; a gap answer
//      rescues a skipped question.
//   1. All skipped. OLD: submitted, and drafted from the topic line. NEW:
//      refused; sent-with-gaps is its own state (no submittedAt, no prep clock,
//      no draft, zero model calls) and Kyle gets the follow-up task. Answering
//      the gaps afterwards sends it properly, closes the task, and ONE draft is
//      made (not two).
//   2. A legacy SUBMITTED row that stored "not sufficient" is not drafted.
//   3. A gap answer rescues a skipped talking-points question.
//   4. A call-selected topic: one typed answer + the client's words on the call
//      = a script, drafted from both, with nobody retyping the call. OLD: it
//      waited on answers.
//   5. Suggested answers: client-spoken, confidential-scrubbed, with their
//      source; used verbatim → EXTRACTED with the call; edited → TYPED with the
//      suggestion it started from.
//   6. Confidentiality end to end: no captured prompt carries a confidential
//      fact or a scrubbed excerpt; the question plan builds on approved facts.
//   7. Shorter drafts at the prompt: part budgets + "evidence, not copy" in the
//      system prompt, the prompt version stamped; an over-long draft is a
//      WARNING and approval is not blocked.
//   8. The follow-up link: the deep link, the sign-in route's allow-list (the
//      old route ignored `next`), the reminder body with the open questions,
//      reminders OFF still refuses to send, and a stalled gap question becomes
//      Kyle's after two business days.
//
// ISOLATION: PGlite on 127.0.0.1:5514 via the shared harness. Production is
// never opened; every outbound call is fenced and counted; the model is
// stubbed at aiJsonWithUsage (the ledger, dedupe and switches are real).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5514);
const REPO = path.resolve(__dirname, "../..");
const BASE = "e26cacd"; // the commit batch B starts from

installNextStubs();
const fence = fenceFetch();

// ---- the model boundary ----------------------------------------------------
let aiCalls = 0;
const prompts: { system: string; prompt: string }[] = [];
const LONG_TITLE = "Why the listing photos decide your first weekend";
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        aiCalls++;
        prompts.push({ system: opts.system, prompt: opts.prompt });
        const usage = { inputTokens: 900, outputTokens: 300 };
        if (/You phrase the questions/.test(opts.system)) {
          return { result: { questions: [{ id: "audienceProblem", ask: "What do sellers here get wrong about pricing for the first weekend?" }], followUps: [] }, usage, model: "drill-stub" };
        }
        const title = (/TOPIC:\s*(.+)/.exec(opts.prompt)?.[1] ?? "Drafted topic").trim().slice(0, 90);
        const long = title === LONG_TITLE;
        const w = (n: number, word: string) => Array.from({ length: n }, () => word).join(" ");
        return {
          result: {
            title, category: "Market Authority",
            hook: long ? `Your photos decide the first weekend ${w(14, "really")}.` : "The first weekend decides your price.",
            points: long
              ? [{ role: "re-hook", text: `Buyers scroll past dark rooms ${w(13, "quickly")}.` }, { role: "build-up", text: `Bright wide shots bring showings ${w(13, "reliably")}.` }, { role: "payoff", text: `More showings mean stronger offers ${w(13, "usually")}.` }]
              : [{ role: "re-hook", text: "Buyers read days on market." }, { role: "build-up", text: "A stale listing invites low offers." }, { role: "payoff", text: "Price it right on day one." }],
            close: long ? `Book the photographer before anything else ${w(6, "please")}.` : "Plan the first weekend first.",
            captionCta: null, filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [],
          },
          usage, model: "drill-stub",
        };
      };
    },
  }),
);

function writeBaseCopies(): { dir: string; interview: string; drafting: string; route: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp08-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const out = { dir, interview: path.join(dir, "contentInterview.base.ts"), drafting: path.join(dir, "contentDrafting.base.ts"), route: path.join(dir, "authRoute.base.ts") };
  fs.writeFileSync(out.interview, point(show("src/lib/contentInterview.ts")));
  fs.writeFileSync(out.drafting, point(show("src/lib/contentDrafting.ts")));
  fs.writeFileSync(out.route, point(show("src/app/portal/auth/[token]/route.ts")));
  return out;
}
function removeBaseCopies(dir: string) {
  try { fs.unlinkSync(path.join(dir, "node_modules")); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* harmless */ }
}

const shiftKey = (key: string, n: number) => { const [y, m] = key.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

const MAIN = ["audienceProblem", "pointOfView", "talkingPoints", "evidence", "story", "nextAction"] as const;
const CANNED: Record<string, string> = {
  audienceProblem: "Sellers who think the first offer is the floor and wait for a better one that never comes.",
  pointOfView: "The first weekend is the whole negotiation, so price for it and you set the terms.",
  talkingPoints: "For example, a seller last year priced high and sat for a month. Second, buyers read days on market as a discount signal. Finally, the right price on day one brings competing offers.",
  evidence: "Last year a seller on Oak Street took this advice and had three offers by Sunday.",
  story: "A before and after of two houses on the same street, one priced right and one not.",
  nextAction: "Call me before you book the photographer so we can plan the first weekend together.",
};
const FOLLOW = "A client last year had exactly this: we priced for the first weekend and got three offers. Another thing: buyers compare everything. Also: timing matters most in spring.";

async function main() {
  const { server, stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const policy = await import("@/lib/contentPolicy");
  const ci = await import("@/lib/contentInterview");
  const { scriptWorkForMonth, sweepOwedScripts } = await import("@/lib/contentDrafting");
  const { recalcProgramMonth } = await import("@/lib/programMonths");
  const { reconcileAnswerGapTasks } = await import("@/lib/programDeskTasks");
  const { portalInterview } = await import("@/lib/portal");
  const { approveScriptVersion } = await import("@/lib/contentScripts");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const base = writeBaseCopies();
  const oldIv = (await import(base.interview)) as { answerQuestion: typeof ci.answerQuestion; submitInterview: (id: string, a: { clientUserId?: string | null }) => Promise<void> };
  const oldDraft = (await import(base.drafting)) as { scriptWorkForMonth: typeof scriptWorkForMonth };
  const NEXT = shiftKey(etMonthKey(new Date()), 1);
  const setSwitch = async (key: string, enabled: boolean) => {
    await prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date() }, update: { enabled } });
  };
  const readiness = async (monthId: string, topicId: string) => (await scriptWorkForMonth(monthId)).find((w) => w.topicId === topicId)?.readiness;

  try {
    // ======================================================================
    c.head("P · the pure rule");
    const topic = policy.makeTopic({ title: "Pricing for the first weekend", pillarName: "Market Authority", clientId: "client-x" });
    type Answer = import("@/lib/contentPolicy").InterviewAnswer & { followUps: NonNullable<import("@/lib/contentPolicy").InterviewAnswer["followUps"]> };
    const skipped: Answer[] = MAIN.map((id) => ({ questionId: id, status: "skipped", text: null, followUps: [] }));
    const none = { topicAudienceNeed: null, callExcerpts: [] };
    const e0 = policy.evaluateSufficiency(skipped, none);
    c.ok("six skipped answers are not ready", !e0.ready);
    c.ok("…missing premise, stance and points", JSON.stringify(e0.missing) === JSON.stringify(["premise", "stance", "points"]), JSON.stringify(e0.missing));
    const ctxBase = { topic, audience: null, clientName: "Client X" };
    c.ok("OLD (no sufficiency context): the sequence is simply done", policy.nextQuestion(skipped, ctxBase).kind === "done");
    const served: string[] = [];
    const ans = JSON.parse(JSON.stringify(skipped)) as typeof skipped;
    for (let i = 0; i < 5; i++) {
      const n = policy.nextQuestion(ans, { ...ctxBase, sufficiency: none });
      if (n.kind !== "follow-up") break;
      served.push(n.condition);
      ans.find((a) => a.questionId === n.question.id)!.followUps.push({ condition: n.condition, ask: n.prompt, text: null, status: "skipped" });
    }
    c.ok("NEW: exactly two gap questions, then done", served.length === 2 && policy.nextQuestion(ans, { ...ctxBase, sufficiency: none }).kind === "done", served.join(","));
    c.ok("…premise first, then stance", JSON.stringify(served) === JSON.stringify(["gap-premise", "gap-stance"]));
    const served2: string[] = [];
    const ans2 = JSON.parse(JSON.stringify(skipped)) as typeof skipped;
    const withNeed = { topicAudienceNeed: "Sellers deciding when to list", callExcerpts: [] };
    for (let i = 0; i < 5; i++) {
      const n = policy.nextQuestion(ans2, { ...ctxBase, sufficiency: withNeed });
      if (n.kind !== "follow-up") break;
      served2.push(n.condition);
      ans2.find((a) => a.questionId === n.question.id)!.followUps.push({ condition: n.condition, ask: n.prompt, text: null, status: "skipped" });
    }
    c.ok("with an approved audience need: the premise is never asked", !served2.includes("gap-premise") && served2.length === 2, served2.join(","));
    c.ok("…and it is still not ready (topic text alone is not a script)", !policy.evaluateSufficiency(ans2, withNeed).ready);
    const rescued = JSON.parse(JSON.stringify(skipped)) as typeof skipped;
    rescued[0] = { questionId: "audienceProblem", status: "answered", text: CANNED.audienceProblem, followUps: [] };
    rescued[1] = { questionId: "pointOfView", status: "answered", text: CANNED.pointOfView, followUps: [] };
    rescued[2].followUps.push({ condition: "gap-points", ask: "…", text: "Price for the weekend buyers. Show the house at its brightest. Answer every inquiry within the hour.", status: "answered" });
    const er = policy.evaluateSufficiency(rescued, none);
    c.ok("a gap answer rescues a skipped talking-points question (3 seeds, ready)", er.ready && er.seeds.length === 3, JSON.stringify(er.seeds));

    // ======================================================================
    c.head("1 · all skipped — OLD submitted and drafted it; NEW refuses, then follows up");
    const G = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Gap Drill TEST", package: "Accelerator", monthKey: NEXT, project: false, topics: [
      { title: "Skipped everything", selection: "SELECTED" },
      { title: "Legacy skipped everything", selection: "SELECTED" },
      { title: "Rescued by a gap answer", selection: "SELECTED" },
      { title: "Stalled on a gap question", selection: "SELECTED" },
    ] });
    // A desk task is never raised for a TEST client — the one thing here that
    // needs a real-looking name.
    await prisma.client.update({ where: { id: G.clientId }, data: { name: "Gapfill Realty" } });
    const [tSkip, tLegacy, tRescue, tStall] = G.topicIds;
    const client = { clientUserId: G.clientUserId };
    // OLD path, on its own topic.
    const ivLegacy = await ci.getOrCreateInterview(tLegacy, G.monthId, client);
    for (const k of MAIN) await oldIv.answerQuestion(ivLegacy, k, { kind: "SKIPPED", actor: client });
    await oldIv.submitInterview(ivLegacy, client);
    const leg = await prisma.contentInterview.findUnique({ where: { id: ivLegacy } });
    c.ok("OLD: six skips submitted as SUBMITTED, with a submittedAt", leg?.status === "SUBMITTED" && !!leg.submittedAt);
    c.ok("OLD: the old drafting read called it FROM_ANSWERS", (await oldDraft.scriptWorkForMonth(G.monthId)).find((w) => w.topicId === tLegacy)?.readiness === "FROM_ANSWERS");
    // NEW path.
    const ivSkip = await ci.getOrCreateInterview(tSkip, G.monthId, client);
    for (const k of MAIN) await ci.answerQuestion(ivSkip, k, { kind: "SKIPPED", actor: client });
    let st = await ci.interviewState(ivSkip);
    c.ok("NEW: after six skips the next step is a GAP question", st.nextIsGap && st.nextKey === "audienceProblem:fu:gap-premise", `${st.nextKey}`);
    c.ok("…and the gap clock is stamped", !!(await prisma.contentInterview.findUnique({ where: { id: ivSkip } }))?.gapQuestionsAskedAt);
    await ci.answerQuestion(ivSkip, st.nextKey!, { kind: "SKIPPED", actor: client });
    st = await ci.interviewState(ivSkip);
    c.ok("a second gap question (the stance)", st.nextKey === "pointOfView:fu:gap-stance", `${st.nextKey}`);
    await ci.answerQuestion(ivSkip, st.nextKey!, { kind: "SKIPPED", actor: client });
    st = await ci.interviewState(ivSkip);
    c.ok("then done — NEEDS_FOLLOWUP, not ready", st.next.kind === "done" && st.status === "NEEDS_FOLLOWUP" && !st.sufficiency.ready, st.status);
    let refused = "";
    try { await ci.submitInterview(ivSkip, client); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    c.ok("submit is refused with a plain reason", /Not enough to write this one yet/.test(refused), refused);
    const sent = await ci.submitInterview(ivSkip, client, { acknowledgeGaps: true });
    const row1 = await prisma.contentInterview.findUnique({ where: { id: ivSkip } });
    c.ok("sending what they have → SUBMITTED_WITH_GAPS, no submittedAt", sent.status === "SUBMITTED_WITH_GAPS" && row1?.status === "SUBMITTED_WITH_GAPS" && !row1.submittedAt && !!row1.sentWithGapsAt);
    c.ok("a re-render keeps it", (await ci.interviewState(ivSkip)).status === "SUBMITTED_WITH_GAPS");
    c.ok("drafting readiness is THIN_ANSWERS", (await readiness(G.monthId, tSkip)) === "THIN_ANSWERS");
    c.ok("the legacy SUBMITTED-but-insufficient row is THIN_ANSWERS too (section 2)", (await readiness(G.monthId, tLegacy)) === "THIN_ANSWERS");
    const task = await prisma.smartTask.findUnique({ where: { dedupeKey: `program-answer-gaps:${ivSkip}` } });
    c.ok("Kyle's follow-up task is OPEN, with the open questions in it", task?.status === "OPEN" && task.assignedKey === "kyle" && /Still open/.test(task.description ?? ""), task?.title ?? "none");
    await setSwitch("script_drafting", true);
    await setSwitch("ai_runs", true);
    const calls1 = aiCalls;
    await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
    c.ok("with drafting AND ai_runs ON: zero model calls, zero scripts", aiCalls === calls1 && (await prisma.contentScript.count({ where: { topicId: { in: [tSkip, tLegacy] } } })) === 0, `${aiCalls - calls1} calls`);
    const rc1 = await recalcProgramMonth(G.monthId, { dryRun: true });
    c.ok("the preparation clock has not started", rc1?.after.preparationCompletedAt === null && !(rc1?.after.sessions ?? []).some((s) => s.readyTopicIds.includes(tSkip) || s.readyTopicIds.includes(tLegacy)));
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
    // The client comes back and answers.
    await ci.answerQuestion(ivSkip, "audienceProblem", { text: CANNED.audienceProblem, kind: "TYPED", actor: client });
    const back = await prisma.contentInterview.findUnique({ where: { id: ivSkip } });
    // Both gap questions were already asked, so with the stance and points
    // still missing the honest state is NEEDS_FOLLOWUP — no longer "sent".
    c.ok("answering again leaves 'sent with gaps' (and clears its note)", back?.status === "NEEDS_FOLLOWUP" && !back.sentWithGapsAt && !back.submittedAt, back?.status);
    await ci.answerQuestion(ivSkip, "pointOfView", { text: CANNED.pointOfView, kind: "TYPED", actor: client });
    await ci.answerQuestion(ivSkip, "talkingPoints", { text: CANNED.talkingPoints, kind: "TYPED", actor: client });
    for (let i = 0; i < 12; i++) {
      const s = await ci.interviewState(ivSkip);
      if (s.next.kind === "done") break;
      await ci.answerQuestion(ivSkip, s.nextKey!, { text: s.nextKey!.includes(":fu:") ? FOLLOW : CANNED[s.nextKey!], kind: "TYPED", actor: client });
    }
    const good = await ci.submitInterview(ivSkip, client);
    c.ok("now sufficient: SUBMITTED", good.status === "SUBMITTED" && (await prisma.contentInterview.findUnique({ where: { id: ivSkip } }))?.status === "SUBMITTED");
    c.ok("…and Kyle's task closed itself", (await prisma.smartTask.findUnique({ where: { dedupeKey: `program-answer-gaps:${ivSkip}` } }))?.status === "COMPLETED");
    c.ok("readiness FROM_ANSWERS", (await readiness(G.monthId, tSkip)) === "FROM_ANSWERS");
    const calls1b = aiCalls;
    await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
    c.ok("the sweep drafts exactly one script", aiCalls === calls1b + 1 && (await prisma.contentScriptVersion.count({ where: { interviewId: ivSkip } })) === 1, `${aiCalls - calls1b}`);
    await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
    c.ok("a second sweep drafts nothing", aiCalls === calls1b + 1 && (await readiness(G.monthId, tSkip)) === "HAS_SCRIPT");

    // ======================================================================
    // Review fix (Sep 24 2026): the legacy row above reads THIN_ANSWERS — no
    // draft, and on a written-planning month no booking — but nothing opened a
    // follow-up for a SUBMITTED row, so nobody would ever chase it.
    c.head("1b · answers sent before CP-08 that stop short are followed up, and the page does not contradict itself");
    const legBefore = await prisma.contentInterview.findUnique({ where: { id: ivLegacy } });
    const gapKey = `program-answer-gaps:${ivLegacy}`;
    c.ok("OLD state: SUBMITTED over its own stored 'not sufficient', and no follow-up task", legBefore?.status === "SUBMITTED" && /"sufficient":false/.test(legBefore.sufficiencyJson ?? "") && !(await prisma.smartTask.findUnique({ where: { dedupeKey: gapKey } })), legBefore?.status);
    const viewBefore = await portalInterview({ id: G.enrollmentId, clientId: G.clientId }, ivLegacy);
    c.ok("the page never offers a SUBMITTED row a second 'send what I have'", viewBefore?.canSendWithGaps === false, `${viewBefore?.status} next=${viewBefore?.next.kind}`);
    const r1b = await reconcileAnswerGapTasks({ now: new Date() });
    const legAfter = await prisma.contentInterview.findUnique({ where: { id: ivLegacy } });
    c.ok("NEW: the hourly pass calls it SUBMITTED_WITH_GAPS, sent when it was sent", r1b.reclassified >= 1 && legAfter?.status === "SUBMITTED_WITH_GAPS" && !legAfter.submittedAt && legAfter.sentWithGapsAt?.getTime() === legBefore?.submittedAt?.getTime(), JSON.stringify(r1b));
    const legTask = await prisma.smartTask.findUnique({ where: { dedupeKey: gapKey } });
    c.ok("  and Kyle's follow-up task opens for it, with the open questions", legTask?.status === "OPEN" && legTask.assignedKey === "kyle" && /Still open/.test(legTask.description ?? ""), legTask?.title ?? "none");
    c.ok("  drafting still waits for the answers (THIN_ANSWERS)", (await readiness(G.monthId, tLegacy)) === "THIN_ANSWERS");
    c.ok("  and the page shows it as sent with gaps", (await portalInterview({ id: G.enrollmentId, clientId: G.clientId }, ivLegacy))?.status === "SUBMITTED_WITH_GAPS");
    const r1c = await reconcileAnswerGapTasks({ now: new Date() });
    c.ok("a second pass reclassifies nothing and opens nothing new", r1c.reclassified === 0 && (await prisma.smartTask.count({ where: { dedupeKey: gapKey } })) === 1, JSON.stringify(r1c));

    // ======================================================================
    c.head("3 · a gap answer rescues a skipped question");
    const ivRescue = await ci.getOrCreateInterview(tRescue, G.monthId, client);
    await ci.answerQuestion(ivRescue, "audienceProblem", { text: CANNED.audienceProblem, kind: "TYPED", actor: client });
    await ci.answerQuestion(ivRescue, "pointOfView", { text: CANNED.pointOfView, kind: "TYPED", actor: client });
    for (const k of ["talkingPoints", "evidence", "story", "nextAction"]) {
      const s = await ci.interviewState(ivRescue);
      if (s.nextKey && s.nextKey.includes(":fu:") && !s.nextIsGap) await ci.answerQuestion(ivRescue, s.nextKey, { text: FOLLOW, kind: "TYPED", actor: client });
      await ci.answerQuestion(ivRescue, k, { kind: "SKIPPED", actor: client });
    }
    const s3 = await ci.interviewState(ivRescue);
    c.ok("only the talking points are missing, so that is the one gap asked", s3.nextKey === "talkingPoints:fu:gap-points", `${s3.nextKey}`);
    await ci.answerQuestion(ivRescue, "talkingPoints:fu:gap-points", { text: "Price for the weekend buyers. Show the house at its brightest. Answer every inquiry within the hour.", kind: "TYPED", actor: client });
    const s3b = await ci.interviewState(ivRescue);
    c.ok("now ready, from the gap answer", s3b.next.kind === "done" && s3b.sufficiency.ready, JSON.stringify(s3b.sufficiency.missing));
    c.ok("…and it submits as SUBMITTED", (await ci.submitInterview(ivRescue, client)).status === "SUBMITTED");

    // ======================================================================
    c.head("8a · a stalled gap question becomes Kyle's after two business days");
    const ivStall = await ci.getOrCreateInterview(tStall, G.monthId, client);
    for (const k of MAIN) await ci.answerQuestion(ivStall, k, { kind: "SKIPPED", actor: client });
    await ci.interviewState(ivStall);
    const r8a = await reconcileAnswerGapTasks({ now: new Date() });
    c.ok("not yet: the grace period has not run", r8a.opened === 0 && !(await prisma.smartTask.findUnique({ where: { dedupeKey: `program-answer-gaps:${ivStall}` } })));
    await prisma.contentInterview.update({ where: { id: ivStall }, data: { gapQuestionsAskedAt: new Date(Date.now() - 6 * 86_400_000) } });
    const r8b = await reconcileAnswerGapTasks({ now: new Date() });
    c.ok("after it: the follow-up task opens (STALLED)", r8b.opened === 1 && (await prisma.smartTask.findUnique({ where: { dedupeKey: `program-answer-gaps:${ivStall}` } }))?.status === "OPEN", JSON.stringify(r8b));
    await prisma.contentInterview.update({ where: { id: ivStall }, data: { status: "ABANDONED" } });
    const r8c = await reconcileAnswerGapTasks({ now: new Date() });
    c.ok("and closes when the interview is gone", r8c.closed >= 1 && (await prisma.smartTask.findUnique({ where: { dedupeKey: `program-answer-gaps:${ivStall}` } }))?.status === "COMPLETED");

    // ======================================================================
    c.head("4 · a call-selected topic scripts from the call — nobody retypes it");
    const E1 = "Every seller I talk to thinks the first offer is the floor, and it almost never is in this market.";
    const E2 = "I always tell people to price for the first weekend because that is when the serious buyers look.";
    const E3 = "[CONFIDENTIAL] I am leaving my brokerage in November and nobody at the office knows yet.";
    const E4 = "Honestly my partner and I are buying the brokerage across town next spring, keep that quiet.";
    const E5 = "I learned this from Priya Castellano when she listed her house last year and it sat for ages.";
    const K = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Call Path TEST", package: "Accelerator", monthKey: NEXT, project: false, topics: [
      { title: "Pricing for the first weekend", selection: "RECONCILED", excerpts: [E1, E2, E3, E4, E5] },
      { title: LONG_TITLE, selection: "RECONCILED", excerpts: [E1] },
    ] });
    const [tCall, tLong] = K.topicIds;
    const call = await prisma.programCallRecord.create({ data: { clientId: K.clientId, enrollmentId: K.enrollmentId, callType: "MONTHLY_STRATEGY", status: "COMPLETED", scheduledStart: new Date("2026-09-20T15:00:00Z") } as never, select: { id: true } });
    await prisma.contentTopicSelection.updateMany({ where: { topicId: { in: [tCall, tLong] } }, data: { callRecordId: call.id } });
    // Another enrolled client (the other-client scrub) and two facts on file.
    const other = await prisma.client.create({ data: { name: "Priya Castellano" }, select: { id: true } });
    await prisma.contentEnrollment.create({ data: { clientId: other.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2 } });
    const SECRET = "Buying the brokerage across town next spring with my partner";
    await prisma.clientFact.create({ data: { clientId: K.clientId, enrollmentId: K.enrollmentId, category: "DECISION", body: SECRET, source: "call", callRecordId: call.id, excerptJson: JSON.stringify([{ speaker: "client", text: E4 }]), status: "ACCEPTED", aiContext: "ALLOWED", confidential: true } });
    const KNOWN = "Films best at the Doylestown office in the morning";
    await prisma.clientFact.create({ data: { clientId: K.clientId, enrollmentId: K.enrollmentId, category: "PRODUCTION_PREFERENCE", body: KNOWN, source: "call", status: "ACCEPTED", aiContext: "ALLOWED", confidential: false } });
    const kClient = { clientUserId: K.clientUserId };
    const ivCall = await ci.getOrCreateInterview(tCall, K.monthId, kClient);
    await ci.answerQuestion(ivCall, "talkingPoints", { text: "Price for the first weekend, not the first month.", kind: "TYPED", actor: kClient });
    const stCall = await ci.interviewState(ivCall);
    c.ok("the interview is still in progress (five questions unanswered)", stCall.status === "IN_PROGRESS" && stCall.next.kind !== "done");
    c.ok("OLD: an opened interview blocked the call path (WAITING_ON_ANSWERS)", (await oldDraft.scriptWorkForMonth(K.monthId)).find((w) => w.topicId === tCall)?.readiness === "WAITING_ON_ANSWERS");
    const wCall = (await scriptWorkForMonth(K.monthId)).find((w) => w.topicId === tCall);
    c.ok("NEW: the answer plus the client's call lines is enough (FROM_ANSWERS)", wCall?.readiness === "FROM_ANSWERS", `${wCall?.readiness} — ${wCall?.why}`);
    c.ok("…and staff can see it leaned on the call", /from the call/.test(wCall?.why ?? ""), wCall?.why);
    const promptsBefore = prompts.length;
    await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
    const scriptPrompt = prompts.slice(promptsBefore).find((p) => p.prompt.includes("TOPIC: Pricing for the first weekend"));
    c.ok("the draft was made", (await readiness(K.monthId, tCall)) === "HAS_SCRIPT" && !!scriptPrompt);
    c.ok("its prompt carries both clean call lines", !!scriptPrompt && scriptPrompt.prompt.includes(E1) && scriptPrompt.prompt.includes(E2));
    c.ok("…the client's typed answer", !!scriptPrompt?.prompt.includes("Price for the first weekend, not the first month."));
    c.ok("…under CALL EXCERPTS, as evidence not copy", !!scriptPrompt?.prompt.includes("CALL EXCERPTS (speaker-tagged; evidence, not copy"));
    c.ok("no staff-authored answer rows were needed", (await prisma.contentInterviewAnswer.count({ where: { interviewId: ivCall, sourceKind: "STAFF" } })) === 0);

    // ======================================================================
    c.head("5 · suggested answers — client-spoken, scrubbed, with their source");
    const sugg = await ci.suggestedAnswersFor(ivCall);
    c.ok("the two clean client lines are offered", sugg.length === 2 && sugg.some((s) => s.text === E1) && sugg.some((s) => s.text === E2), sugg.map((s) => s.text.slice(0, 30)).join(" | "));
    c.ok("the [CONFIDENTIAL] line, the confidential-fact overlap and the other client's name are not", !sugg.some((s) => [E3, E4, E5].includes(s.text)));
    c.ok("each carries its provenance (the call and its date)", sugg.every((s) => s.provenance.callRecordId === call.id && !!s.provenance.callDateISO));
    const view = await portalInterview({ id: K.enrollmentId, clientId: K.clientId }, ivCall);
    c.ok("the portal view offers the same two", view?.suggestions.length === 2 && !view.suggestions.some((s) => [E3, E4, E5].includes(s.text)));
    const s1 = sugg.find((s) => s.text === E1)!;
    const s2 = sugg.find((s) => s.text === E2)!;
    await ci.answerQuestion(ivCall, "pointOfView", { text: E1, kind: "TYPED", actor: kClient, suggestionId: s1.id });
    const a1 = await prisma.contentInterviewAnswer.findFirst({ where: { interviewId: ivCall, questionKey: "pointOfView" }, orderBy: { version: "desc" } });
    c.ok("used as is → EXTRACTED, with the call and the excerpt", a1?.answerKind === "EXTRACTED" && a1.callRecordId === call.id && (a1.excerptJson ?? "").includes(E1));
    await ci.answerQuestion(ivCall, "audienceProblem", { text: `${E2} Especially first-time sellers.`, kind: "TYPED", actor: kClient, suggestionId: s2.id });
    const a2 = await prisma.contentInterviewAnswer.findFirst({ where: { interviewId: ivCall, questionKey: "audienceProblem" }, orderBy: { version: "desc" } });
    c.ok("edited → TYPED, noting the suggestion it started from", a2?.answerKind === "TYPED" && (a2.flagsJson ?? "").includes(`"basedOnSuggestion"`) && (a2.flagsJson ?? "").includes(s2.id));
    await ci.answerQuestion(ivCall, "evidence", { text: "Made up words", kind: "TYPED", actor: kClient, suggestionId: "ffffffffffffffffffffffff" });
    c.ok("an unknown suggestion id is ignored (plain TYPED, no provenance)", (await prisma.contentInterviewAnswer.findFirst({ where: { interviewId: ivCall, questionKey: "evidence" }, orderBy: { version: "desc" } }))?.flagsJson === null);

    // ======================================================================
    c.head("6 · confidentiality end to end");
    const { planInterviewQuestions } = await import("@/lib/contentGeneration");
    const pBefore = prompts.length;
    await planInterviewQuestions(ivCall, { requestedBy: "drill", unattended: false });
    const planPrompt = prompts.slice(pBefore).find((p) => /You phrase the questions/.test(p.system));
    c.ok("the question plan builds on the approved fact on file", !!planPrompt?.prompt.includes("ALREADY ESTABLISHED") && planPrompt.prompt.includes(KNOWN));
    const leaked = prompts.filter((p) => [SECRET, E3, E4, E5, "leaving my brokerage"].some((x) => p.prompt.includes(x) || p.system.includes(x)));
    c.ok("no captured prompt carries a confidential fact or a scrubbed excerpt", leaked.length === 0, `${leaked.length} of ${prompts.length}`);

    // ======================================================================
    c.head("7 · shorter drafts at the prompt; length stays a warning");
    const sys = scriptPrompt?.system ?? "";
    c.ok("the system prompt carries the part budgets", /PART BUDGETS \(spoken words\): hook ≤12/.test(sys) && /each talking point ≤14/.test(sys) && /close ≤10/.test(sys));
    c.ok("…and 'evidence, not copy'", /EVIDENCE, NOT COPY/.test(sys));
    const runs7 = await prisma.programAiRun.findMany({ where: { kind: "script_draft" }, select: { promptVersion: true } });
    c.ok("every script draft is stamped script.v2-budgets", runs7.length > 0 && runs7.every((r) => r.promptVersion === "script.v2-budgets"), JSON.stringify([...new Set(runs7.map((r) => r.promptVersion))]));
    const longV = await prisma.contentScriptVersion.findFirst({ where: { title: LONG_TITLE } });
    const val = JSON.parse(longV?.validationJson ?? "{}") as { ok?: boolean; findings?: { code: string; severity: string }[] };
    const timing = (val.findings ?? []).filter((f) => f.code === "timing.out-of-range");
    c.ok("an over-long draft is flagged timing.out-of-range as a WARNING", timing.length === 1 && timing[0].severity === "warn", JSON.stringify(timing));
    c.ok("…the format check still passes (ok)", val.ok === true, JSON.stringify((val.findings ?? []).filter((f) => f.severity === "block")));
    let blocked = "";
    try { await approveScriptVersion(longV!.id, { email: "jordan-drill@example.com" }); } catch (e) { blocked = e instanceof Error ? e.message : String(e); }
    c.ok("…and Jordan can approve it (length is not a hard block)", !blocked && (await prisma.contentScript.findFirst({ where: { topicId: tLong } }))?.approvedVersionId === longV!.id, blocked);

    // ======================================================================
    c.head("8 · the follow-up link");
    const L = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Link Drill TEST", package: "Starter", monthKey: NEXT, project: false, topics: [{ title: "A topic they skipped", selection: "SELECTED" }] });
    await prisma.contentEnrollment.update({ where: { id: L.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN", noCallEligible: true } });
    await prisma.contentMonth.update({ where: { id: L.monthId }, data: { planningMode: "WRITTEN" } });
    const lClient = { clientUserId: L.clientUserId };
    const ivL = await ci.getOrCreateInterview(L.topicIds[0], L.monthId, lClient);
    for (const k of MAIN) await ci.answerQuestion(ivL, k, { kind: "SKIPPED", actor: lClient });
    const { resolvePortalLink, copyReminderLink, sendReminderNow } = await import("@/lib/programReminders");
    const eRow = (await prisma.contentEnrollment.findUnique({ where: { id: L.enrollmentId }, select: { id: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true } }))!;
    const path8 = `?tab=topics&iv=${ivL}`;
    const tokenLink = await resolvePortalLink(eRow, null, null, new Date(), { path: path8 });
    c.ok("the token link lands on the open questions", tokenLink?.kind === "token" && tokenLink.url.endsWith(`/portal/${L.portalToken}${path8}`), tokenLink?.url);
    const badLink = await resolvePortalLink(eRow, null, null, new Date(), { path: "?tab=topics&iv=../../x" });
    c.ok("any other path is dropped (plain link)", badLink?.url.endsWith(`/portal/${L.portalToken}`) === true, badLink?.url);
    const loginLink = await resolvePortalLink(eRow, { membershipId: L.membershipId, clientUserId: L.clientUserId }, null, new Date(), { path: path8 });
    c.ok("the sign-in link carries it as ?next=", loginLink?.kind === "login" && loginLink.url.includes(`?next=${encodeURIComponent(`/portal/me${path8}`)}`), loginLink?.url);
    const { mintLoginLink } = await import("@/lib/portalAccess");
    const { NextRequest } = await import("next/server");
    const route = await import("@/app/portal/auth/[token]/route");
    const oldRoute = (await import(base.route)) as typeof route;
    const hit = async (r: typeof route, next: string | null) => {
      const { url } = await mintLoginLink(L.membershipId!, null);
      const raw = url.split("/portal/auth/")[1];
      const req = new NextRequest(`https://drill.invalid/portal/auth/${raw}${next === null ? "" : `?next=${encodeURIComponent(next)}`}`);
      const res = await r.GET(req, { params: Promise.resolve({ token: raw }) });
      return new URL(res.headers.get("location") ?? "", "https://drill.invalid").pathname + new URL(res.headers.get("location") ?? "", "https://drill.invalid").search;
    };
    c.ok("OLD: the sign-in route ignored where to land", (await hit(oldRoute, `/portal/me${path8}`)) === "/portal/me");
    c.ok("NEW: an exact interview address is honoured", (await hit(route, `/portal/me${path8}`)) === `/portal/me${path8}`);
    c.ok("//evil.com is not", (await hit(route, "//evil.com")) === "/portal/me");
    c.ok("a traversal is not", (await hit(route, "/portal/me?tab=topics&iv=../x")) === "/portal/me");
    c.ok("anything appended is not", (await hit(route, `/portal/me${path8}&x=1`)) === "/portal/me");
    const copy = await copyReminderLink(L.monthId, { email: "kyle-drill@example.com" });
    c.ok("the reminder copy names the open questions", copy.ok && /quick question/i.test(copy.body ?? "") && /what do people usually get wrong about/i.test(copy.body ?? ""), copy.message);
    c.ok("…and its link opens them", (copy.body ?? "").includes(encodeURIComponent(`/portal/me${path8}`)) || (copy.body ?? "").includes(path8));
    const send = await sendReminderNow(L.monthId, { email: "kyle-drill@example.com" });
    c.ok("with reminders OFF, sending is refused", !send.ok && /switched off/i.test(send.message), send.message);
    const { answerFollowUpLinkAction } = await import("@/app/content/actions");
    const kyle = await answerFollowUpLinkAction(ivL);
    c.ok("Kyle's 'copy follow-up link' gives the questions and the lasting page link", kyle.ok && (kyle.url ?? "").endsWith(`/portal/${L.portalToken}${path8}`) && /what do people usually get wrong/i.test(kyle.body ?? ""), kyle.message);

    // ======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
  } finally {
    removeBaseCopies(base.dir);
    quiet.restore();
    c.summary();
    void server;
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
