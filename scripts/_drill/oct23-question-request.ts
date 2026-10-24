// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: SEND QUESTION REQUEST (Oct 23 2026).
//
// Jordan: "on the monthly content scripting - allow me to have a button that
// says 'Send Question Request', that removes the script, and sends the topic
// to the client to request questions based on the topic so we have enough
// information for the script. Then the client gets an email with a link and
// says we need them to answer a few questions on the topic so we can finish
// scripting. AI creates the questions based on the topic, the client, and
// what we know about them, and anything they talked about on the strategy
// call for that month, if applicable."
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-question-request.ts --logs <dir>
//
//   1. who may press it: owner, admin, creative manager; never an editor, a
//      photographer, a signed-out caller or an owner previewing as someone
//   2. refused, in words, on a shared, a client-approved and a filmed script
//      (nothing changes, no model call, no email)
//   3. the press: the draft is withdrawn (every version kept, nothing
//      deleted), the topic stays the month's pick on WRITTEN answers, three to
//      five AI questions (faked) are its questions, built from the topic, the
//      client file and this month's call (the confidential line held back),
//      no em dash; ONE email (faked) with a one-tap link to that topic's
//      questions, on the month's reminder ledger; the office card and the
//      portal say so; a second press sends nothing
//   4. the cadence: no follow-up the same day; one follow-up three weekdays
//      later ("A quick nudge"); Resend is a new email with a new link; no
//      more after the house maximum
//   5. Undo: the draft is the topic's script again exactly as it was, and no
//      further email goes
//   6. answering drafts a new script (the old writer, faked) from the answers;
//      the withdrawn draft stays in its history; Undo is refused after
//   7. the new writer (Bernadette's switch, faked at its steps) drafts from
//      the answers too, and reads them
//   8. the email's words: no em dash anywhere, the topic's own taken out
//
// ISOLATION: PGlite via the shared harness; the model is stubbed at
// aiJsonWithUsage, the new writer at its pipeline steps, the email at Gmail
// (oauth2/gmail faked at the fence); nothing else leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { isJudgeCall, passingJudge, isIdentityCall, plainIdentity } from "./_judge";

const PORT = Number(process.env.DRILL_PORT ?? 7381);
const REPO = path.resolve(__dirname, "../..");
installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown };
navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {} });
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: () => {} }));

// ---- the email: Gmail, faked at the fence -------------------------------------
const mails: { to: string; text: string }[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    mails.push({ to: /^To: (.+)$/m.exec(text)?.[1] ?? "", text });
    return json({ id: `gm-${mails.length}` });
  }
  return null;
});

// ---- the model: faked at aiJsonWithUsage ----------------------------------------
const usage = { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };
const qPrompts: { system: string; prompt: string }[] = [];
const scriptPrompts: { system: string; prompt: string }[] = [];
let modelCalls = 0;
/** What the fake question writer answers: five, one duplicate id, one unknown id, one em dash, one too short. */
const AI_QUESTIONS = [
  { id: "audienceProblem", ask: "When buyers write off Malvern, what do they usually assume about it?" },
  { id: "pointOfView", ask: "What do you honestly tell a buyer who thinks Malvern is only for empty nesters — and why?" },
  { id: "pointOfView", ask: "A second stance question that must be dropped as a duplicate." },
  { id: "talkingPoints", ask: "What are the three things you'd show a buyer on a Saturday in Malvern?" },
  { id: "budget", ask: "What is your commission on a Malvern sale these days?" },
  { id: "story", ask: "Ok?" },
  { id: "evidence", ask: "Which of your own clients chose Malvern last year, and what won them over?" },
];
const DRAFT = {
  title: "Why Malvern Is Underrated", category: "Local Life", hook: "Most buyers skip Malvern, and that is their mistake.",
  points: [{ role: "re-hook", text: "It is not just for empty nesters." }, { role: "build-up", text: "Saturday on King Street tells you everything." }, { role: "payoff", text: "You get the Main Line for less." }],
  close: "Call me before you rule it out.", captionCta: null, filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [],
};
/** The new writer's steps, faked at aiStructuredWithUsage (its engine): which ran, and what each was shown. */
const writerSteps: { step: string; system: string; prompt: string }[] = [];
let checks = 0;
const stepOf = (system: string) =>
  /^You read call transcripts for ONE video topic/.test(system) ? "retrieval"
  : /^You write the TOPIC BRIEF/.test(system) ? "brief"
  : /^You write FIVE hooks/.test(system) ? "hooks"
  : /^You write ONE monthly personal-brand video script/.test(system) ? "draft"
  : /^You write ONE short video script/.test(system) ? "draft" // writer v2.6 (Oct 23 2026)
  : /^You are the INDEPENDENT CREATIVE REVIEWER/.test(system) ? "review"
  : /^You read ONE short video script the way a viewer would hear it/.test(system) ? "review26" // v2.6's viewer-first review
  : "other";
const hookScores = { relevance: 5, curiosity: 5, tension: 5, specificity: 5, naturalDelivery: 5, accuracy: 5, herVoice: 5, payoffConnection: 5 };
function writerAnswer(step: string): unknown {
  switch (step) {
    case "retrieval": return { overview: "No call this month.", passages: [] };
    case "brief": return { centralMessage: "Pick your Saturday before your street.", viewer: "A buyer new to the Lehigh Valley", whyChosen: "Her topic.", pillar: "Local Life", whatSheSaid: [], mustKeep: [], herPhrases: [], optional: [], excluded: [], contradictions: [], verifiedFacts: [], opinions: [], creativeIdeas: [], ourAssumptions: [], closeType: "cta", closeWhy: "A natural next step." };
    case "hooks": return { hooks: [
      { text: "Most buyers pick a street before they pick a Saturday.", rehook: "That is backwards.", lever: "belief", scores: hookScores, note: "" },
      { text: "Your Saturday tells you where to live.", rehook: "Here is mine.", lever: "contrast", scores: { ...hookScores, curiosity: 4 }, note: "" },
      { text: "I can tell you where to live by your Saturday.", rehook: "Really.", lever: "her moment", scores: { ...hookScores, tension: 4 }, note: "" },
      { text: "Emmaus on a Saturday morning sells itself.", rehook: "Come see.", lever: "her moment", scores: { ...hookScores, tension: 3 }, note: "" },
      { text: "Before you tour, plan your Saturday.", rehook: "Seriously.", lever: "advice", scores: { ...hookScores, curiosity: 3 }, note: "" },
    ] };
    case "draft": return { title: "My Actual Saturday", hook: "A hook the code replaces with the winner.", rehook: "Buyers think the valley is quiet on weekends.", buildup: "Coffee in Emmaus, then the trail, then the farmers market.", payoff: "Pick the Saturday you want, then the street.", close: "Call me and I will show you my Saturday, before you pick a street.", closeType: "cta", captionCta: "", filmingNotes: "", rationale: { hook: "h", takeaway: "t", strategy: "s" }, sourcesUsed: [], gaps: [] };
    case "review": {
      checks++;
      const keys = ["on_topic", "her_meaning", "hook", "rehook", "story", "substance", "payoff", "close", "her_voice", "claims", "length", "nothing_extra"];
      return { checks: keys.map((key) => ({ key, pass: true, reason: "ok" })), craft: Object.fromEntries(["hook", "rehook", "buildup", "payoff", "close"].map((k) => [k, { score: 4, note: "it does its job" }])), fixInstruction: "", summary: "Strong." };
    }
    case "review26": {
      checks++;
      const yes = { pass: true, reason: "ok" };
      return { sense: yes, voice: yes, hook: yes, invented: yes, reads: 8, note: "", summary: "Strong." };
    }
    default: throw new Error("unexpected writer call");
  }
}
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "aiStructuredWithUsage") {
        return async (opts: { system: string; prompt: string }) => {
          modelCalls++;
          const step = stepOf(opts.system);
          writerSteps.push({ step, system: opts.system, prompt: opts.prompt });
          return { result: writerAnswer(step), usage, model: "claude-opus-5-5", stopReason: "end_turn" };
        };
      }
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        modelCalls++;
        if (isJudgeCall(opts.system)) { checks++; return passingJudge(); }
        if (isIdentityCall(opts.system)) return plainIdentity();
        if (/You write the few questions a Realtour Pilot client answers/.test(opts.system)) {
          qPrompts.push({ system: opts.system, prompt: opts.prompt });
          return { result: { questions: AI_QUESTIONS }, usage, model: "drill-stub" };
        }
        if (/personal-branding video script/.test(opts.system)) {
          scriptPrompts.push({ system: opts.system, prompt: opts.prompt });
          return { result: DRAFT, usage, model: "drill-stub" };
        }
        throw new Error(`unexpected model call: ${opts.system.slice(0, 90)}`);
      };
    },
  }),
);

const EM = /[—–]/;
/** Tuesday Oct 27 2026, 10:30 AM ET (EDT): inside the send window. */
const TUE = new Date(Date.UTC(2026, 9, 27, 14, 30));
const at = (base: Date, days: number, hours = 0) => new Date(base.getTime() + days * 86_400_000 + hours * 3_600_000);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-question-request", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession, clearSession } = await import("@/lib/auth/session");
  const A = await import("@/app/content/actions");
  const qr = await import("@/lib/questionRequests");
  const R = await import("@/lib/programReminders");
  const scripts = await import("@/lib/contentScripts");
  const lib = await import("@/lib/contentInterview");
  const { scriptWorkForMonth, draftOwedScriptsForMonth } = await import("@/lib/contentDrafting");
  const { portalTopics } = await import("@/lib/portal");
  const portalActions = await import("@/app/portal/actions");
  const { createPillar } = await import("@/lib/contentPillars");
  const { PROGRAM_ROLLOUT_SETTING_KEY } = await import("@/lib/programRolloutCore");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { createFact, acceptFact } = await import("@/lib/clientFacts");
  const { loadScriptsTab } = await import("@/app/content/[id]/programData");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { ScriptsPanel } = await import("@/components/content/ScriptsPanel");
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rsquo;/g, "’").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
  const ser = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
  const pts = (a: string, b: string, d: string) => [{ role: "re-hook" as const, text: a }, { role: "build-up" as const, text: b }, { role: "payoff" as const, text: d }];
  const qrRows = () => prisma.programReminder.findMany({ where: { action: "QUESTION_REQUEST" }, orderBy: { createdAt: "asc" } });
  const qrMails = () => prisma.outboxMessage.findMany({ where: { dedupeKey: { startsWith: "program_reminder:QUESTION_REQUEST:" } }, orderBy: { createdAt: "asc" }, select: { body: true, toRef: true, state: true, dedupeKey: true } });

  try {
    // ==================================================================
    c.head("0 · the world: Marcee (old writer) and Bernadette (new writer), October planned on a call");
    const now0 = new Date();
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: JSON.stringify({ mode: "ALL", modeSince: now0.toISOString(), pilot: null }) } });
    const sw = (key: string, enabled: boolean, configJson: string | null = null) => prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(now0.getTime() - 30 * 86_400_000), configJson }, update: { enabled, configJson } });
    await sw("reminders", true, JSON.stringify({ testClientsOnly: false }));
    for (const k of ["ai_runs", "portal_login_email", "portal_sign_in"]) await sw(k, true);
    const owner = await prisma.appUser.create({ data: { email: "jordan@oct23-qr.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { email: "kyle@oct23-qr.test", name: "Kyle", role: "ADMIN", status: "ACTIVE" } });
    const james = await prisma.appUser.create({ data: { email: "james@oct23-qr.test", name: "James", role: "CREATIVE_MANAGER", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { email: "kim@oct23-qr.test", name: "Kim", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const shooter = await prisma.appUser.create({ data: { email: "harrison@oct23-qr.test", name: "Harrison", role: "PHOTOGRAPHER", status: "ACTIVE" } });
    const as = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    const MALVERN = "Malvern — One of the Most Underrated Towns Near Philadelphia";
    const M = await buildContentMonth(prisma, {
      name: "Marcee Question TEST", package: "Pro", project: false, owner: { email: "info+marcee@realtourpilot.com", name: "Marcee Question TEST" },
      topics: [
        { title: MALVERN, selection: "SELECTED", source: "client" },
        { title: "Shared already", selection: "SELECTED" },
        { title: "She approved it", selection: "SELECTED" },
        { title: "Already filmed", selection: "SELECTED" },
      ],
    });
    const [tMal, tShared, tApproved, tFilmed] = M.topicIds;
    await prisma.contentTopic.update({ where: { id: tMal }, data: { concept: "Malvern has a walkable downtown and the Main Line for less, but buyers write it off." } });
    const pillarM = await createPillar({ enrollmentId: M.enrollmentId, clientId: M.clientId, name: "Local Life", createdBy: owner.email });
    // This month's strategy call, held and transcribed: one confidential line among hers.
    const call = await prisma.programCallRecord.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", monthId: M.monthId, targetMonthKey: M.monthKey, scheduledStart: new Date(now0.getTime() - 3 * 86_400_000), scheduledEnd: new Date(now0.getTime() - 3 * 86_400_000 + 1_800_000), transcriptState: "CONFIRMED" } });
    await prisma.programTranscriptSource.create({ data: { callRecordId: call.id, provider: "paste", contentHash: "drill-qr-call-1", matchState: "CONFIRMED", text: [
      "Jordan: Tell me about Malvern.",
      "Marcee: Malvern buyers always think the town shuts down at six, but King Street is packed on Saturday mornings.",
      "Marcee: [CONFIDENTIAL] Between us, I am thinking about leaving my brokerage at the end of the year.",
      "Jordan: Good, that's a video.",
    ].join("\n") } });
    await prisma.contentMonth.update({ where: { id: M.monthId }, data: { callRecordId: call.id, strategyCallStatus: "COMPLETED" } });
    const fact = await createFact({ clientId: M.clientId, enrollmentId: M.enrollmentId, category: "BRAND_PREFERENCE", body: "Marcee grew up in Chester County and walks her dog on the Malvern trail every morning.", source: "staff", sourceRef: owner.email, factDate: new Date(), confidential: false });
    await acceptFact(fact.id, owner.email);
    const staff = { email: owner.email, appUserId: owner.id };
    const draft = (topicId: string, title: string) => scripts.createScriptVersion({ enrollmentId: M.enrollmentId, monthId: M.monthId, topicId, source: "AI", status: "INTERNAL_REVIEW", createdBy: "cron", parts: { title, hook: "Most buyers skip this town.", points: pts("They think it is quiet.", "It is not.", "Come see on Saturday."), close: "Call me.", pillarId: pillarM, categoryLabel: "Local Life" } });
    const s1 = await draft(tMal, "Malvern draft");
    const s1v2 = await scripts.editScriptFromBody(s1.scriptId, "HOOK\nMost buyers skip Malvern.\nRE-HOOK\nThey think it is quiet.\nBUILD UP\nKing Street on Saturday.\nPAYOFF\nThe Main Line for less.\nCLOSE\nCall me.", owner.email);
    await prisma.contentTopic.update({ where: { id: tMal }, data: { status: "SCRIPTED" } });
    const sShared = await draft(tShared, "Shared draft");
    await scripts.approveScriptVersion(sShared.versionId, staff);
    await scripts.releaseScriptVersion(sShared.scriptId, staff);
    const sApproved = await draft(tApproved, "Client approved draft");
    await scripts.approveScriptVersion(sApproved.versionId, staff);
    await scripts.releaseScriptVersion(sApproved.scriptId, staff);
    await prisma.contentScript.update({ where: { id: sApproved.scriptId }, data: { clientApprovedVersionId: sApproved.versionId, clientApprovedAt: new Date(), clientApprovedByUserId: M.clientUserId } });
    await prisma.contentScriptRelease.create({ data: { scriptId: sApproved.scriptId, scriptVersionId: sApproved.versionId, enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, action: "CLIENT_APPROVED", actorClientUserId: M.clientUserId } });
    const sFilmed = await draft(tFilmed, "Filmed draft");
    const video = await prisma.contentVideo.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, topicId: tFilmed, title: "Filmed draft", status: "FILMED", filmedConfirmedAt: new Date() } });
    await prisma.contentScript.update({ where: { id: sFilmed.scriptId }, data: { videoId: video.id } });
    c.ok("Marcee's month: four drafts, Malvern on v2 waiting for an OK", (await prisma.contentScript.count({ where: { monthId: M.monthId } })) === 4 && s1v2.versionNo === 2);

    // ==================================================================
    c.head("1 · who may press it");
    const before = { ai: modelCalls, mails: (await qrMails()).length };
    await clearSession();
    const anon = await A.sendQuestionRequestAction(s1.scriptId);
    await as(editor);
    const ed = await A.sendQuestionRequestAction(s1.scriptId);
    await as(shooter);
    const ph = await A.sendQuestionRequestAction(s1.scriptId);
    await as(owner, admin.id);
    const viewAs = await A.sendQuestionRequestAction(s1.scriptId);
    c.ok("signed out: refused", !anon.ok, anon.message);
    c.ok("an editor and a photographer: refused (no access)", !ed.ok && /access/i.test(ed.message) && !ph.ok && /access/i.test(ph.message), `${ed.message} | ${ph.message}`);
    c.ok("an owner previewing as someone else: refused", !viewAs.ok && /previewing/i.test(viewAs.message), viewAs.message);
    const s1Now = await prisma.contentScript.findUnique({ where: { id: s1.scriptId } });
    c.ok("…nothing changed: the draft is still the month's, no model call, no email", s1Now?.status === "INTERNAL_REVIEW" && s1Now.monthId === M.monthId && modelCalls === before.ai && (await qrMails()).length === before.mails);
    c.ok("the guard is the revise guard (requireCreativeLead), on all three actions", ["sendQuestionRequestAction", "undoQuestionRequestAction", "resendQuestionRequestAction"].every((fn) => new RegExp(`export async function ${fn}[\\s\\S]{0,200}requireCreativeLead\\(\\)`).test(read("src/app/content/actions.ts"))) && /export async function queueScriptRevisionAction[\s\S]{0,200}requireCreativeLead\(\)/.test(read("src/app/content/actions.ts")));

    // ==================================================================
    c.head("2 · refused on a shared, a client-approved and a filmed script");
    await as(admin);
    const rShared = await A.sendQuestionRequestAction(sShared.scriptId);
    await as(james);
    const rApproved = await A.sendQuestionRequestAction(sApproved.scriptId);
    await as(owner);
    const rFilmed = await A.sendQuestionRequestAction(sFilmed.scriptId);
    c.ok("shared (the admin may press; the script is refused): it stays as it is", !rShared.ok && /already sent to Marcee/.test(rShared.message), rShared.message);
    c.ok("client-approved (the creative manager may press; refused)", !rApproved.ok && /Marcee already approved this script/.test(rApproved.message), rApproved.message);
    c.ok("filmed: refused", !rFilmed.ok && /already filmed/.test(rFilmed.message), rFilmed.message);
    const untouched = await prisma.contentScript.findMany({ where: { id: { in: [sShared.scriptId, sApproved.scriptId, sFilmed.scriptId] } }, select: { status: true, monthId: true } });
    c.ok("…none of them touched, no model call, no email", untouched.every((x) => x.status !== "WITHDRAWN" && x.monthId === M.monthId) && modelCalls === before.ai && (await qrMails()).length === before.mails);

    // ==================================================================
    c.head("3 · the press: withdrawn, asked in writing, AI questions, one email");
    const versionsBefore = await prisma.contentScriptVersion.findMany({ where: { scriptId: s1.scriptId }, orderBy: { versionNo: "asc" } });
    await as(owner);
    const pre = await loadScriptsTab(M.enrollmentId, { id: M.monthId });
    const preHtml = renderToStaticMarkup(createElement(ScriptsPanel, ser({ enrollmentId: M.enrollmentId, scripts: pre.scripts, queueCount: pre.queueCount, scriptOwner: pre.scriptOwner, owed: [], revising: pre.revising, drafting: pre.drafting, queueActive: pre.queueActive, questionRequests: pre.questionRequests })));
    const cardOf = (h: string, id: string) => { const i = h.indexOf(`data-script-card="${id}"`); const j = h.indexOf("data-script-card=", i + 20); return i < 0 ? "" : h.slice(i, j < 0 ? h.length : j); };
    const actionsOf = (h: string) => h.slice(h.indexOf("data-card-actions"), h.indexOf("data-more-menu"));
    c.ok("the button: up front on the draft the client has not seen (beside Edit, not in More)", /Send Question Request/.test(actionsOf(cardOf(preHtml, s1.scriptId))) && /Edit/.test(actionsOf(cardOf(preHtml, s1.scriptId))), text(actionsOf(cardOf(preHtml, s1.scriptId))));
    c.ok("…and not on the shared, client-approved or filmed ones", [sShared.scriptId, sApproved.scriptId, sFilmed.scriptId].every((id) => !!cardOf(preHtml, id) && !/Send Question Request/.test(cardOf(preHtml, id))));
    const sent = await qr.sendQuestionRequest(s1.scriptId, staff, { now: TUE });
    const req1 = sent.requestId;
    c.ok("the press answers in words", /^Withdrew the draft \(kept in its history\) and asked Marcee \d questions about "Malvern, One of the Most/.test(sent.message) && /Marcee has the email now/.test(sent.message), sent.message);
    const w = await prisma.contentScript.findUnique({ where: { id: s1.scriptId } });
    const wv = await prisma.contentScriptVersion.findMany({ where: { scriptId: s1.scriptId }, orderBy: { versionNo: "asc" } });
    c.ok("the draft is withdrawn: off the month and the topic, WITHDRAWN, nothing deleted", w?.status === "WITHDRAWN" && w.monthId === null && w.topicId === null && w.currentVersionId === s1v2.versionId && wv.length === versionsBefore.length && wv.every((v) => v.status === "WITHDRAWN") && wv.map((v) => v.body).join() === versionsBefore.map((v) => v.body).join());
    // Audit, Oct 23 2026: the month's own answers ask leaves an open request's topic to the request (one chase per topic).
    c.ok("audit: the open request's topic is the one the month's answers ask leaves to the request", [...(await (await import("@/lib/questionRequests")).openQuestionRequestTopicIds(M.monthId))].join() === tMal);
    const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tMal, monthId: M.monthId } } });
    const topicRow = await prisma.contentTopic.findUnique({ where: { id: tMal } });
    c.ok("the topic stays the month's pick, asked in WRITING, back to SELECTED", sel?.status === "SELECTED" && sel.answerRoute === "WRITTEN" && topicRow?.status === "SELECTED" && topicRow.monthId === M.monthId);
    const facts = await import("@/lib/planningFacts").then((m) => m.planningForMonth(M.monthId));
    const work = await scriptWorkForMonth(M.monthId);
    c.ok("…its step is NEEDS_ANSWERS and its script WAITING_ON_ANSWERS", facts?.planning.topics.find((t) => t.topicId === tMal)?.step === "NEEDS_ANSWERS" && work.find((x) => x.topicId === tMal)?.readiness === "WAITING_ON_ANSWERS", `${facts?.planning.topics.find((t) => t.topicId === tMal)?.step} ${work.find((x) => x.topicId === tMal)?.readiness}`);
    const iv = await prisma.contentInterview.findUnique({ where: { topicId_monthId: { topicId: tMal, monthId: M.monthId } } });
    const meta = lib.planMeta(iv?.questionPlanJson);
    c.ok("the questions are stored as the topic's questions (the interview's plan, an AI run on it)", !!iv && iv.id === sent.interviewId && iv.sourceKind === "WRITTEN" && iv.status === "NOT_STARTED" && !!iv.aiRunId && meta.asked?.join() === sent.questions.map((q) => q.key).join(), JSON.stringify(meta));
    c.ok("three to five, house roles only, each once; the unknown and duplicate dropped; stance and points always asked", sent.questions.length >= 3 && sent.questions.length <= 5 && new Set(sent.questions.map((q) => q.key)).size === sent.questions.length && !sent.questions.some((q) => q.key === "budget") && ["pointOfView", "talkingPoints"].every((k) => sent.questions.some((q) => q.key === k)), sent.questions.map((q) => q.key).join(","));
    c.ok("…a too-short one dropped, no em dash in any of them", !sent.questions.some((q) => q.key === "story") && sent.questions.every((q) => !EM.test(q.text)) && sent.questions.find((q) => q.key === "pointOfView")!.text.includes("empty nesters, and why"), sent.questions.map((q) => q.text).join(" | "));
    console.log("  sample AI questions (faked model, as stored):");
    for (const q of sent.questions) console.log(`    · [${q.key}] ${q.text}`);
    const qp = qPrompts[0]?.prompt ?? "";
    c.ok("the AI was given the topic (title and concept)", qPrompts.length === 1 && qp.includes("Malvern") && qp.includes("walkable downtown and the Main Line for less"));
    c.ok("…what we know about her (an accepted fact from her file)", qp.includes("walks her dog on the Malvern trail"));
    c.ok("…this month's strategy call, the topic's part of it", qp.includes("King Street is packed on Saturday mornings") && /THIS MONTH'S STRATEGY CALL/.test(qp));
    c.ok("…and never the confidential line", !qp.includes("leaving my brokerage") && !/CONFIDENTIAL\]/.test(qp));
    c.ok("…told to use the call and the file and never quote or mention them", /Never quote them, never mention a call/.test(qPrompts[0]?.system ?? ""));
    const run = await prisma.programAiRun.findUnique({ where: { id: iv!.aiRunId! } });
    c.ok("…one run on the ledger (interview_plan, question-request), pointing at the request", run?.kind === "interview_plan" && run.promptKey === "question-request" && run.outputRef === `ContentScriptRelease:${req1}`);

    const rel = await prisma.contentScriptRelease.findUnique({ where: { id: req1 } });
    const ledger = qr.readQuestionRequestLedger(rel?.note);
    c.ok("the request's ledger: QUESTION_REQUEST on the withdrawn script, OPEN, with what Undo needs", rel?.action === "QUESTION_REQUEST" && rel.scriptId === s1.scriptId && rel.scriptVersionId === s1v2.versionId && ledger?.state === "OPEN" && ledger.prior.script.monthId === M.monthId && ledger.prior.topicStatus === "SCRIPTED" && Object.keys(ledger.prior.versions).length === 2);
    const rows1 = await qrRows();
    const out1 = await qrMails();
    c.ok("ONE email, on the month's reminder ledger (QUESTION_REQUEST, attempt 1, SENT)", rows1.length === 1 && rows1[0].monthId === M.monthId && rows1[0].attempt === 1 && rows1[0].state === "SENT" && rows1[0].manual && out1.length === 1 && out1[0].state === "accepted" && rel?.notificationState === "SENT", JSON.stringify(rows1.map((r) => [r.state, r.suppressionReason, r.lastError])));
    const body1 = out1[0]?.body ?? "";
    const mail1 = mails.find((m) => /info\+marcee@realtourpilot\.com/.test(m.to));
    const subject = (() => { const m = /^Subject: =\?UTF-8\?B\?([^?]+)\?=$/m.exec(mail1?.text ?? ""); return m ? Buffer.from(m[1], "base64").toString("utf8") : /^Subject: (.+)$/m.exec(mail1?.text ?? "")?.[1] ?? ""; })();
    c.ok("…to her portal seat's address, under its own subject", out1[0]?.toRef === "info+marcee@realtourpilot.com" && subject === "A few quick questions so we can finish your script", subject);
    c.ok("the words: \"We need you to answer a few questions about <topic> so we can finish your script.\"", body1.includes(`We need you to answer a few questions about "Malvern, One of the Most Underrated Towns Near Philadelphia" so we can finish your script.`), body1);
    const link1 = /(https:\/\/hub\.example\.test\/portal\/auth\/[A-Za-z0-9_-]+)\?next=([^\s]+)/.exec(body1);
    const next1 = link1 ? decodeURIComponent(link1[2]) : "";
    c.ok("…a one-tap sign-in link straight to THAT topic's questions", !!link1 && next1 === `/portal/me?e=${M.enrollmentId}&tab=topics&iv=${iv!.id}`, next1);
    const { portalNextPath } = await import("@/lib/portalLanding");
    c.ok("…a landing the sign-in route honours", portalNextPath(next1) === next1);
    c.ok("no em dash anywhere in the email", !EM.test(body1));
    console.log("  the email as sent:\n" + body1.split("\n").map((l) => `    | ${l}`).join("\n"));

    const page = await portalTopics({ id: M.enrollmentId, clientId: M.clientId });
    const pt = page.groups.flatMap((g) => g.topics).find((t) => t.id === tMal);
    c.ok("the portal: the topic's questions are the AI's, in writing, no script on it", pt?.questions?.route === "WRITTEN" && pt.questions.interviewId === iv!.id && pt.questions.items.map((i) => i.text).join("|") === sent.questions.map((q) => q.text).join("|") && !pt.script && pt.state === "SELECTED", JSON.stringify({ route: pt?.questions?.route, n: pt?.questions?.items.length, state: pt?.state }));
    const st0 = await lib.interviewState(iv!.id, { readOnly: true });
    c.ok("…and the guided questions (the email's link) ask exactly these, first one first", st0.next.kind === "question" && st0.next.question.id === sent.questions[0].key && st0.next.prompt === sent.questions[0].text);

    const sd = await loadScriptsTab(M.enrollmentId, { id: M.monthId });
    c.ok("the Scripts tab: the withdrawn draft is not a script of the month; the request is", !sd.scripts.some((s) => s.id === s1.scriptId) && sd.questionRequests.length === 1 && sd.questionRequests[0].stage === "WAITING" && sd.questionRequests[0].email.state === "sent");
    const html = renderToStaticMarkup(createElement(ScriptsPanel, ser({ enrollmentId: M.enrollmentId, scripts: sd.scripts, queueCount: sd.queueCount, scriptOwner: sd.scriptOwner, owed: [], revising: sd.revising, drafting: sd.drafting, queueActive: sd.queueActive, questionRequests: sd.questionRequests })));
    const card = text(html.slice(html.indexOf(`data-question-request-card="${req1}"`)));
    const sentDay = new Date(sd.questionRequests[0].email.at!).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
    c.ok("the card: \"Questions sent <date> · waiting on Marcee\", the questions, Undo and Resend", card.includes(`Questions sent ${sentDay} · waiting on Marcee`) && card.includes(sent.questions[0].text) && /Undo/.test(card) && /Resend/.test(card) && /View the withdrawn draft \(v2\)/.test(card), card.slice(0, 260));
    c.ok("the withdrawn draft has no card of its own any more (the request's card took its place)", !cardOf(html, s1.scriptId));
    c.ok("…the button sits beside Edit in the source, with one short confirm", /Edit<\/button>\}\n\s+\{canAsk && <button[^\n]*Send Question Request<\/button>\}/.test(read("src/components/content/ScriptsPanel.tsx")) && /Withdraw this draft and email the client a few questions about this topic\? The draft stays in its history, and Undo puts it back\./.test(read("src/components/content/ScriptsPanel.tsx")));

    const again = await A.sendQuestionRequestAction(s1.scriptId);
    c.ok("a second press: refused, nothing sent twice", !again.ok && /Already withdrawn/.test(again.message) && (await qrMails()).length === 1, again.message);
    const sameDay = await R.evaluateReminders({ dryRun: false, now: at(TUE, 0, 2), enrollmentIds: [M.enrollmentId] });
    c.ok("the hourly pass the same day: no follow-up yet", sameDay.questionRequestLane.some((l) => l.requestId === req1 && l.decision === "wait") && (await qrMails()).length === 1, JSON.stringify(sameDay.questionRequestLane.map((l) => [l.decision, l.reason])));

    // ==================================================================
    c.head("4 · the cadence: one follow-up three weekdays later, Resend, then no more");
    let followUp = false;
    for (let d = 3; d <= 6 && !followUp; d++) {
      const day = at(TUE, d, 1); // Fri Oct 30 … (11:30 ET)
      if ([0, 6].includes(new Date(day.toLocaleString("en-US", { timeZone: "America/New_York" })).getDay())) continue;
      await R.evaluateReminders({ dryRun: false, now: day, enrollmentIds: [M.enrollmentId] });
      followUp = (await qrMails()).length === 2;
    }
    const out2 = await qrMails();
    const rows2 = await qrRows();
    c.ok("one follow-up went (attempt 2, automatic), on the month's ledger", followUp && rows2.length === 2 && rows2[1].attempt === 2 && !rows2[1].manual && rows2[1].state === "SENT" && rows2[1].monthId === M.monthId, JSON.stringify(rows2.map((r) => [r.attempt, r.state, r.suppressionReason])));
    c.ok("…its words: \"A quick nudge\", the same topic, a link to the questions, no em dash", /A quick nudge: we still need your answers to a few questions about "Malvern, One of the Most Underrated Towns Near Philadelphia"/.test(out2[1]?.body ?? "") && /tab%3Dtopics%26iv%3D/.test(out2[1]?.body ?? "") && !EM.test(out2[1]?.body ?? ""), out2[1]?.body);
    const fri = (await qrRows())[1].sentAt!;
    const resend = await qr.resendQuestionRequest(req1, staff, { now: at(fri, 0, 1) });
    const out3 = await qrMails();
    const rows3 = await qrRows();
    const tok = (b: string) => /\/portal\/auth\/([A-Za-z0-9_-]+)/.exec(b)?.[1] ?? "";
    c.ok("Resend (the same day as the follow-up: a person's press, not the cadence): a new email, attempt 3, manual, a NEW sign-in link", resend.outcome === "sent" && out3.length === 3 && rows3[2]?.attempt === 3 && rows3[2].manual && !!tok(out3[2].body) && tok(out3[2].body) !== tok(out3[0].body) && tok(out3[2].body) !== tok(out3[1].body), resend.message);
    c.ok("…its words are the first email's (not the nudge)", /We need you to answer a few questions about/.test(out3[2]?.body ?? "") && !/quick nudge/.test(out3[2]?.body ?? ""));
    await as(editor);
    const edResend = await A.resendQuestionRequestAction(req1);
    const edUndo = await A.undoQuestionRequestAction(req1);
    await as(owner, james.id);
    const vaUndo = await A.undoQuestionRequestAction(req1);
    await as(owner);
    c.ok("Resend and Undo: refused for an editor and in view-as, nothing sent or undone", !edResend.ok && !edUndo.ok && !vaUndo.ok && /previewing/.test(vaUndo.message) && (await qrMails()).length === 3 && (await prisma.contentScript.findUnique({ where: { id: s1.scriptId } }))?.status === "WITHDRAWN", `${edResend.message} | ${vaUndo.message}`);
    const later = await R.evaluateReminders({ dryRun: false, now: at(fri, 0, 3), enrollmentIds: [M.enrollmentId] });
    const mailsAfterMax = (await qrMails()).filter((m) => m.state === "accepted").length;
    c.ok("after the house maximum (three in all): no more emails", mailsAfterMax === 3 && later.questionRequestLane.some((l) => l.requestId === req1 && l.decision === "none" && /asked 3 times/.test(l.reason)), JSON.stringify(later.questionRequestLane.map((l) => [l.kind, l.decision, l.reason])));

    // ==================================================================
    c.head("5 · Undo: the draft back exactly as it was, no further email");
    const undo = await A.undoQuestionRequestAction(req1);
    const back = await prisma.contentScript.findUnique({ where: { id: s1.scriptId } });
    const backV = await prisma.contentScriptVersion.findMany({ where: { scriptId: s1.scriptId }, orderBy: { versionNo: "asc" } });
    c.ok("Undo answers in words", undo.ok && /draft \(v2\) is back/.test(undo.message), undo.message);
    c.ok("the draft is the topic's script again: same row, same current version, statuses as before", back?.status === "INTERNAL_REVIEW" && back.monthId === M.monthId && back.topicId === tMal && back.currentVersionId === s1v2.versionId && backV.map((v) => v.status).join() === versionsBefore.map((v) => v.status).join());
    const selBack = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tMal, monthId: M.monthId } } });
    c.ok("…the topic's route and status as they were; the request's interview gone (nothing was answered)", selBack?.answerRoute === null && (await prisma.contentTopic.findUnique({ where: { id: tMal } }))?.status === "SCRIPTED" && !(await prisma.contentInterview.findUnique({ where: { id: iv!.id } })));
    c.ok("…the month has its script for it again (HAS_SCRIPT) and the card is gone", (await scriptWorkForMonth(M.monthId)).find((x) => x.topicId === tMal)?.readiness === "HAS_SCRIPT" && (await qr.questionRequestsForMonth(M.monthId)).length === 0);
    const pendingAfterUndo = (await qrRows()).filter((r) => r.state === "PENDING" || r.state === "FAILED");
    const afterUndo = await R.evaluateReminders({ dryRun: false, now: at(fri, 1, 0), enrollmentIds: [M.enrollmentId] });
    const afterUndo2 = await R.evaluateReminders({ dryRun: false, now: at(fri, 3, 1), enrollmentIds: [M.enrollmentId] });
    c.ok("no further email after Undo (anything held is cancelled; the passes send nothing for it)", pendingAfterUndo.length === 0 && (await qrMails()).filter((m) => m.state === "accepted").length === mailsAfterMax && !afterUndo.questionRequestLane.some((l) => l.requestId === req1) && !afterUndo2.questionRequestLane.some((l) => l.requestId === req1), JSON.stringify((await qrRows()).map((r) => [r.attempt, r.state, r.suppressionReason])));
    c.ok("audit: after Undo no open request covers it (the month's own asks apply again)", (await (await import("@/lib/questionRequests")).openQuestionRequestTopicIds(M.monthId)).size === 0);
    const undoAgain = await A.undoQuestionRequestAction(req1);
    c.ok("Undo twice: refused", !undoAgain.ok && /Already undone/.test(undoAgain.message));

    // ==================================================================
    c.head("6 · answering drafts a new script from the answers (the old writer)");
    const sent2 = await qr.sendQuestionRequest(s1.scriptId, staff, { now: at(fri, 0, 3.5) });
    const iv2 = await prisma.contentInterview.findUnique({ where: { id: sent2.interviewId } });
    const auth = { token: M.portalToken! };
    const ANSWERS: Record<string, string> = {
      audienceProblem: "Buyers moving from the city think Malvern shuts down at six and only suits empty nesters.",
      pointOfView: "Malvern gives you a walkable downtown on the Main Line for less, and young families are finding it.",
      talkingPoints: "For example, King Street on a Saturday morning is packed. Second, the trail where I walk my dog every day. Finally, the train gets you into the city in forty minutes.",
      evidence: "Last year a young couple I worked with chose Malvern over Ardmore and saved a lot on the same size house.",
      nextAction: "Call me and come walk King Street with me on a Saturday before you rule it out.",
      story: "A before and after of a Saturday morning on King Street.",
    };
    const FOLLOW = "For example, a client last year did exactly this and loved it. Another thing: buyers compare everything. Also: spring is when it matters most.";
    /** The client answers the request's questions under the topic, then any follow-up the guided questions ask, then sends. */
    const answerAll = async (token: string, topicId: string, monthId: string, interviewId: string, keys: string[], swap: (t: string) => string = (t) => t) => {
      const au = { token };
      for (const k of keys) {
        const r = await portalActions.portalSaveTopicAnswer(au, topicId, monthId, k, swap(ANSWERS[k]));
        if (!r.ok) console.log("  save refused:", k, r.message);
      }
      let r = await portalActions.portalSendTopicAnswers(au, topicId, monthId);
      for (let i = 0; i < 6 && !r.ok && r.followUp; i++) {
        const st = await lib.interviewState(interviewId, { readOnly: true });
        if (st.next.kind === "done" || !st.nextKey) break;
        await portalActions.portalAnswerInterview(au, interviewId, st.nextKey, FOLLOW, "TYPED");
        r = await portalActions.portalSendTopicAnswers(au, topicId, monthId);
      }
      return r;
    };
    const sentAns = await answerAll(auth.token, tMal, M.monthId, sent2.interviewId, sent2.questions.map((q) => q.key));
    c.ok("the client answers the questions in the portal and sends them", sentAns.ok && sentAns.status === "SUBMITTED", sentAns.message);
    const work2 = await scriptWorkForMonth(M.monthId);
    c.ok("…the topic is ready from her answers (FROM_ANSWERS)", work2.find((x) => x.topicId === tMal)?.readiness === "FROM_ANSWERS", work2.find((x) => x.topicId === tMal)?.why);
    const lane2 = await R.evaluateReminders({ dryRun: false, now: at(fri, 0, 4), enrollmentIds: [M.enrollmentId] });
    c.ok("…no reminder chases answers already sent (the request settles as answered)", !lane2.questionRequestLane.some((l) => l.requestId === sent2.requestId && l.decision === "send") && qr.readQuestionRequestLedger((await prisma.contentScriptRelease.findUnique({ where: { id: sent2.requestId } }))?.note)?.state === "ANSWERED");
    const dr = await draftOwedScriptsForMonth(M.monthId, { requestedBy: "drill", unattended: false });
    const fresh = await prisma.contentScript.findFirst({ where: { topicId: tMal, monthId: M.monthId, historical: false } });
    const freshV = fresh ? await prisma.contentScriptVersion.findFirst({ where: { scriptId: fresh.id } }) : null;
    c.ok("the existing flow drafts it: a NEW script from the interview's answers", dr.drafted >= 1 && !!fresh && fresh.id !== s1.scriptId && fresh.interviewId === iv2?.id && freshV?.interviewId === iv2?.id && JSON.parse(freshV?.answerIdsJson ?? "[]").length >= sent2.questions.length, JSON.stringify(dr.outcomes.map((o) => [o.title.slice(0, 20), o.result, o.note])));
    c.ok("…the old writer (no new-writer step ran), and its prompt carries her answers", writerSteps.length === 0 && scriptPrompts.some((p) => p.prompt.includes("chose Malvern over Ardmore") || p.prompt.includes("walkable downtown on the Main Line for less")));
    const old = await prisma.contentScript.findUnique({ where: { id: s1.scriptId } });
    c.ok("the withdrawn draft stays in its history (WITHDRAWN, both versions kept)", old?.status === "WITHDRAWN" && (await prisma.contentScriptVersion.count({ where: { scriptId: s1.scriptId } })) === 2);
    c.ok("one script for the video: the card is gone, Undo now refused", (await qr.questionRequestsForMonth(M.monthId)).length === 0 && !(await A.undoQuestionRequestAction(sent2.requestId)).ok);
    let blocked = "";
    try { await scripts.createScriptVersion({ scriptId: s1.scriptId, enrollmentId: M.enrollmentId, source: "MANUAL", createdBy: owner.email, parts: { title: "x", hook: "x", points: pts("a b c", "d e f", "g h i"), close: "x" } }); } catch (e) { blocked = e instanceof Error ? e.message : String(e); }
    c.ok("a withdrawn draft takes no new version (nothing can revive it behind the request)", /withdrawn while the client answers/.test(blocked), blocked);

    // ==================================================================
    c.head("7 · the new writer (Bernadette's switch) drafts from the answers too");
    const B = await buildContentMonth(prisma, { name: "Bernadette Question TEST", package: "Accelerator", project: false, owner: { email: "info+bern@realtourpilot.com", name: "Bernadette Question TEST" }, topics: [{ title: "My Actual Saturday in the Lehigh Valley", selection: "SELECTED" }] });
    const pillarB = await createPillar({ enrollmentId: B.enrollmentId, clientId: B.clientId, name: "Local Life", createdBy: owner.email });
    await prisma.appSetting.create({ data: { key: "script_writer_v2", value: JSON.stringify({ on: true, enrollmentIds: [B.enrollmentId] }) } });
    const sb = await scripts.createScriptVersion({ enrollmentId: B.enrollmentId, monthId: B.monthId, topicId: B.topicIds[0], source: "AI", status: "INTERNAL_REVIEW", createdBy: "cron", parts: { title: "Saturday draft", hook: "My Saturday starts early.", points: pts("Coffee in Emmaus.", "Then the trail.", "Then the market."), close: "Come see it.", pillarId: pillarB, categoryLabel: "Local Life" } });
    const { writerOnFor } = await import("@/lib/scriptWriter/pipeline");
    c.ok("the switch: on for Bernadette, off for Marcee", (await writerOnFor(B.enrollmentId)) && !(await writerOnFor(M.enrollmentId)));
    await as(james);
    const bSent = await A.sendQuestionRequestAction(sb.scriptId);
    c.ok("the creative manager sends Bernadette's questions", bSent.ok && !!bSent.requestId, bSent.message);
    const bReq = await prisma.contentScriptRelease.findUnique({ where: { id: bSent.requestId! } });
    const bLedger = qr.readQuestionRequestLedger(bReq?.note)!;
    const bAns = await answerAll(B.portalToken!, B.topicIds[0], B.monthId, bLedger.interviewId, bLedger.questions.map((q) => q.key), (t) => t.replace(/Malvern/g, "Emmaus"));
    const bDr = await draftOwedScriptsForMonth(B.monthId, { requestedBy: "drill", unattended: false });
    const bFresh = await prisma.contentScript.findFirst({ where: { topicId: B.topicIds[0], monthId: B.monthId, historical: false } });
    const bV = bFresh ? await prisma.contentScriptVersion.findFirst({ where: { scriptId: bFresh.id } }) : null;
    const steps = writerSteps.map((x) => x.step);
    c.ok("her answers are in, and the sweep drafts on the NEW writer (brief, draft; v2.6 has no hooks step)", bAns.ok && bDr.drafted === 1 && !!bFresh && bFresh.id !== sb.scriptId && ["brief", "draft"].every((x) => steps.includes(x)) && !steps.includes("hooks") && /Drafted by the new writer/.test(bV?.changeSummary ?? "") && !!JSON.parse(bV?.validationJson ?? "{}").writer, JSON.stringify({ steps, out: bDr.outcomes.map((o) => [o.result, o.note]) }));
    const briefPrompt = writerSteps.find((x) => x.step === "brief")?.prompt ?? "";
    c.ok("…the writer read her written answers (in its brief's material), and the version names the interview", /chose Emmaus over Ardmore/.test(briefPrompt) && bV?.interviewId === bLedger.interviewId && JSON.parse(bV?.answerIdsJson ?? "[]").length >= bLedger.questions.length, briefPrompt.slice(0, 200));
    c.ok("…Marcee's draft never touched the new writer", !writerSteps.some((x) => /Malvern/.test(x.prompt)));

    // ==================================================================
    c.head("8 · the words, and the rules around them");
    const tpl = (await import("@/lib/reminderTemplates")).reminderTemplate("question_request.v1");
    const vars = { firstName: "Sam", month: "October", portalLink: "https://x/portal/auth/abc", bookCallLink: null, noCallEligible: false, answersStarted: false, sessionNote: null, earliestSession: null, itemCount: 0, titles: [], updatedTitles: [], deadline: null, topicTitle: "Bucks County — Why It Wins – Every Time", questionCount: 4 };
    const first = tpl.render(vars);
    const nudge = tpl.render({ ...vars, followUp: true });
    c.ok("no em or en dash in either email, the topic's own taken out", !EM.test(first) && !EM.test(nudge) && first.includes(`"Bucks County, Why It Wins, Every Time"`), first);
    c.ok("short: under 90 words, one link, the house sign-off", first.split(/\s+/).length < 90 && (first.match(/https:\/\//g) ?? []).length === 1 && /Jordan and the Realtour Pilot team/.test(first));
    c.ok("script_auto_share is not touched by this feature", !/script_auto_share/.test(read("src/lib/questionRequests.ts")));
    c.ok("the automatic check ran on the two new drafts only (never on a withdrawn one)", checks === 2, String(checks));

    c.head("isolation");
    c.ok("nothing left the drill but the faked Gmail", fence.blocked.length === 0, fence.blocked.join(" "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
