// Signed first-month CALL journey: discovery -> approved strategy -> monthly
// call -> reconciled topics -> exact released scripts. Only the model output
// is fake; queue gates, actions, readers, source records and attribution are real.
// Disposable database behind the mandatory preload. No external provider calls.
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

// Oct 5 2026: the sign-in button's POST must prove it came from our own page —
// a same-origin Origin or Sec-Fetch-Site: same-origin, which is what a browser
// sends when the "Continue to your portal" button on that page is pressed (a
// POST with neither is now refused). The drill presses it as a browser would.
const SAME_SITE_PRESS = { "sec-fetch-site": "same-origin" };

installNextStubs();
let clientCookie: string | null = null;
interceptModule((r) => r === "@/lib/portal" || /[\\/]src[\\/]lib[\\/]portal$/.test(r), (loaded) => {
  const m = loaded as typeof import("@/lib/portal");
  return { ...m, resolvePortalViewer: (input: Parameters<typeof m.resolvePortalViewer>[0]) =>
    m.resolvePortalViewer({ ...input, cookies: input.cookies ?? { get: (name: string) => name === "rtp_client" ? clientCookie ?? undefined : undefined } }) };
});

const modelCalls: { kind: string; prompt: string }[] = [];
let analysisPhase: "discovery" | "monthly" = "discovery";
let failNextAnalysis = false;
let beforeModelResponse: (() => Promise<void>) | null = null;
let monthKey = "";
const topics = ["Price for the first weekend", "Prepare for a buyer's first visit"];
const words = [
  "The first weekend decides your price. Buyers compare competing homes, read days on market and look for a clear reason to make an offer. Price it correctly from the start.",
  "Before buyers arrive, open the blinds, clear the entry and finish the small repairs. The visit should make it easy to picture living there. Prepare the house before launch.",
];
const excerpt = (text: string) => ({ speaker: "client", speakerName: "Maya Grove", time: null, text });
const strategyOutput = {
  clientName: "Maya Grove", subtitle: "Built around Trust, Value, Credibility, and Entertainment",
  brandOverview: { coreValues: "Honesty and preparation", brandMessage: "Calm advice for West Chester sellers", shortBrandStatement: "Clear advice, calm process", brandVoice: "Warm, calm, direct" },
  targetAudience: { primaryServiceAreas: "West Chester", pricePositioning: "Move-up homes", primaryClientTypes: "Move-up buyers and sellers", longTermPositioningGoal: "Be the local name for a well-prepared move" },
  contentGoals: ["Explain pricing clearly", "Help sellers prepare", "Show local knowledge", "Publish useful video advice"],
  contentPillars: { preamble: "Build Trust through empathy, provide Value with a practical takeaway, establish Credibility with clear reasoning, and create Entertainment through curiosity.", pillars: ["Seller Strategy", "Buyer Guidance", "Local Life", "Behind the Scenes"].map((name) => ({ name, purpose: `Useful ${name.toLowerCase()} advice`, focusAreas: `Real decisions in ${name.toLowerCase()}`, contentApproach: "One useful idea at a time" })) },
  framework: "policy", captionCtaExamples: ["Save this before you list.", "Ask me about your next move.", "Share this with a seller."],
  strategicDirection: "Lead with pricing clarity and preparation.", gaps: [],
};
interceptModule((r) => r === "@/lib/integrations/ai" || /[\\/]integrations[\\/]ai(\.ts)?$/.test(r), (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get(target, key) {
    if (key !== "aiJsonWithUsage") return target[key];
    return async (input: { system: string; prompt: string }) => {
      const kind = /processing a call transcript/.test(input.system) ? "analysis" : /building a client's 2026 Social Content Strategy/.test(input.system) ? "strategy" : "script";
      modelCalls.push({ kind, prompt: input.prompt });
      if (kind === "analysis" && failNextAnalysis) { failNextAnalysis = false; throw new Error("503 isolated fake model unavailable"); }
      if (beforeModelResponse) { const callback = beforeModelResponse; beforeModelResponse = null; await callback(); }
      const result = kind === "analysis" ? {
        callKind: analysisPhase, plannedMonthKey: monthKey,
        selectedTopics: analysisPhase === "monthly" ? topics.map((title, i) => ({ title, concept: words[i], pillar: "Seller Strategy", excerpts: [excerpt(words[i])] })) : [],
        discussedTopics: analysisPhase === "discovery" ? [{ title: "How I guide a prepared move", concept: "The client's working style", pillar: null, excerpts: [excerpt("I explain each step so clients can prepare calmly.")] }] : [],
        rejectedIdeas: [], facts: [], strategyProposals: [], priorities: analysisPhase === "monthly" ? ["Lead with useful seller advice"] : [], todos: [],
      } : kind === "strategy" ? strategyOutput : {
        title: topics.find((title) => input.prompt.includes(title)) ?? topics[0], category: "Seller Strategy",
        hook: "The first weekend decides your price.",
        points: [{ role: "re-hook", text: "Buyers compare competing homes." }, { role: "build-up", text: "Days on market shape their expectations." }, { role: "payoff", text: "Prepare well and price clearly from the start." }],
        close: "Plan the first weekend first.", captionCta: null, filmingNotes: "Speak naturally.",
        contentPillarCheck: { Trust: "Calm advice", Value: "A practical step", Credibility: "Clear reasoning", Entertainment: "A focused question" }, sourceExcerpts: [words[0]], gaps: [],
      };
      return { result, usage: { inputTokens: 900, outputTokens: 300 }, model: "isolated-fake-model" };
    };
  },
}));

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5796), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-call-journey-signing-secret" } });
  const fence = fenceFetch();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const portal = await import("@/lib/portal");
    const clientActions = await import("@/app/portal/actions");
    const staff = await import("@/app/content/actions");
    const callActions = await import("@/app/settings/calendlyActions");
    const { createManualCallRecord } = await import("@/lib/contentCallRecords");
    const { driveTranscriptJobs, enqueueTranscriptJob } = await import("@/lib/transcriptJobs");
    const { advanceOnboarding } = await import("@/lib/programOnboarding");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { PROGRAM_ROLLOUT_SETTING_KEY, serializeProgramRollout } = await import("@/lib/programRolloutCore");
    const { mintLoginLink } = await import("@/lib/portalAccess");
    const { POST } = await import("@/app/portal/auth/[token]/route"); // Oct 5: the press (POST) signs in; opening the link does not
    const { NextRequest } = await import("next/server");
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    monthKey = next.toISOString().slice(0, 7);
    const f = await buildContentMonth(prisma, { name: "Grove Call Journey TEST", package: "Starter", videosPerMonth: 2, project: false, monthKey, owner: { email: "maya-call@example.test", name: "Maya Grove" } });
    await prisma.client.update({ where: { id: f.clientId }, data: { name: "Grove Call Realty" } });
    const jordan = await prisma.appUser.create({ data: { name: "Jordan", email: "owner-call@example.test", role: "OWNER", status: "ACTIVE" } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle-call@example.test", role: "ADMIN", status: "ACTIVE" } });
    const as = (u: typeof jordan) => setSession({ uid: u.id, email: u.email, role: u.role });
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: serializeProgramRollout({ mode: "PILOT", modeSince: since, pilot: { clientIds: [f.clientId], operations: ["portal_sign_in", "portal_layout_v2"], approvedBy: "isolated-fixture", approvedAt: since, expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), joinedAt: { [f.clientId]: since }, note: "Disposable first-call journey" } }) } });
    const setSwitch = (key: string, enabled: boolean) => prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledAt: now, enabledBy: "isolated-fixture", ...(key === "transcript_jobs" ? { configJson: JSON.stringify({ onlyQueuedAfter: "ALL" }) } : {}) }, update: { enabled } });
    await setSwitch("portal_login_email", true);
    await setSwitch("portal_layout_v2", true);
    const link = await mintLoginLink(f.membershipId!, null);
    const login = await POST(new NextRequest(link.url, { method: "POST", headers: SAME_SITE_PRESS }), { params: Promise.resolve({ token: new URL(link.url).pathname.split("/").pop()! }) });
    clientCookie = login.cookies.get("rtp_client")?.value ?? null;
    const auth = { enrollmentId: f.enrollmentId };
    const resolve = () => portal.resolvePortalViewer({ ...auth, cookies: { get: (name) => name === "rtp_client" ? clientCookie ?? undefined : undefined } });
    const clientView = await resolve();
    if (!clientView.ok) throw new Error(`Client sign-in failed: ${clientView.reason}`);
    c.ok("normal client signs in through one-time route", login.status === 303 && clientView.viewer.actor.kind === "CLIENT" && clientView.viewer.via === "LOGIN");
    c.ok("first month remains CALL and refuses written bypass", (await portal.portalPlanning(clientView.viewer.enrollment, f.monthId))?.callMode === "REQUIRED" && !(await clientActions.portalPlanWithoutCall(auth, f.monthId)).ok);

    // This completed call is a fixture input, not a provider booking assertion.
    const discovery = await createManualCallRecord({ clientId: f.clientId, callType: "BRAND_DISCOVERY", scheduledStart: new Date(now.getTime() - 3 * 86_400_000), by: jordan.email });
    const discoveryText = `Jordan: Tell me about your business and the clients you help.\nMaya Grove: I guide move-up buyers and sellers in West Chester. I explain each step so clients can prepare calmly. I value honesty, preparation and clear advice. I want useful videos about pricing and preparing a home.\nJordan: How should those videos sound?\nMaya Grove: Warm, calm and direct. Each should teach one practical idea, with a clear next step. This is my brand discovery call.`;
    await as(kyle);
    c.ok("Kyle cannot use the owner's transcript decision endpoint", !(await callActions.pasteTranscript(discovery, discoveryText)).ok);
    await as(jordan);
    const pasted = await callActions.pasteTranscript(discovery, discoveryText);
    c.ok("signed owner preserves discovery words and queues ingest plus analysis", pasted.ok && await prisma.programTranscriptSource.count({ where: { callRecordId: discovery, text: discoveryText, createdBy: jordan.email } }) === 1 && await prisma.programTranscriptJob.count({ where: { callRecordId: discovery } }) === 2, pasted.message);
    const drive = (at = new Date()) => driveTranscriptJobs({ max: 8, budgetMs: 30_000, leaseBy: "isolated-call-journey", now: at });
    await drive();
    c.ok("processor OFF retains both queued jobs and calls no model", await prisma.programTranscriptJob.count({ where: { callRecordId: discovery, state: "QUEUED" } }) === 2 && modelCalls.length === 0);
    await setSwitch("transcript_jobs", true);
    await drive();
    c.ok("ingest runs while AI OFF leaves analysis waiting without spending an attempt", (await prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId: discovery, kind: "INGEST" } })).state === "SUCCEEDED" && (await prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId: discovery, kind: "ANALYZE" } })).attempts === 0 && modelCalls.length === 0);
    await setSwitch("ai_runs", true);
    failNextAnalysis = true;
    await drive();
    const failed = await prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId: discovery, kind: "ANALYZE" } });
    c.ok("fake model failure keeps transcript and queues one retry with visible reason", failed.state === "QUEUED" && failed.attempts === 1 && !!failed.nextAttemptAt && failed.lastError?.includes("fake model unavailable") === true && (await prisma.programCallRecord.findUniqueOrThrow({ where: { id: discovery } })).transcriptState === "CONFIRMED");
    await drive(new Date(Date.now() + 6 * 60_000));
    const recovered = await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: failed.id } });
    const discoveryRow = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: discovery } });
    c.ok("next eligible sweep recovers the same analysis job", recovered.state === "SUCCEEDED" && recovered.attempts === 2 && recovered.lastError === null && discoveryRow.transcriptState === "ANALYZED");
    c.ok("recovered call clears its current error while failed run history stays", discoveryRow.lastError === null && discoveryRow.lastErrorAt === null && await prisma.programAiRun.count({ where: { enrollmentId: f.enrollmentId, status: "FAILED" } }) === 1, String(discoveryRow.lastError));
    c.ok("discovery analysis creates held bank ideas without monthly selections", await prisma.contentTopicSelection.count({ where: { monthId: f.monthId } }) === 0 && await prisma.contentMonth.count({ where: { enrollmentId: f.enrollmentId } }) === 1 && await prisma.contentTopic.count({ where: { enrollmentId: f.enrollmentId, source: "discovery_call", approvalState: "PROPOSED", monthId: null } }) === 1);
    await setSwitch("strategy_generation", true);
    await advanceOnboarding(f.enrollmentId, { enqueue: true, requestedBy: jordan.email });
    await drive();
    const strategy = await prisma.contentStrategyVersion.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId }, orderBy: { versionNo: "desc" } });
    c.ok("queued strategy is a draft pinned to the discovery call", strategy.status === "DRAFT" && strategy.callRecordId === discovery && strategy.sourceKind === "discovery_call" && !(await portal.portalStrategy(clientView.viewer.enrollment)));
    const approved = await staff.approveStrategy(strategy.id);
    const released = await staff.releaseStrategy(strategy.id);
    c.ok("signed owner approves and releases strategy with notice suppressed", approved.ok && released.ok && /suppressed/i.test(released.message) && !!(await portal.portalStrategy(clientView.viewer.enrollment)), `${approved.message} / ${released.message}`);
    await clearSession();
    c.ok("released brand strategy does not stand in for first monthly planning call", !(await clientActions.portalPlanWithoutCall(auth, f.monthId)).ok && (await portal.sessionGate(f.enrollmentId, f.monthId)).locked);

    analysisPhase = "monthly";
    const monthly = await createManualCallRecord({ clientId: f.clientId, callType: "MONTHLY_STRATEGY", scheduledStart: new Date(now.getTime() - 2 * 3_600_000), scheduledEnd: new Date(now.getTime() - 90 * 60_000), targetMonthKey: monthKey, by: jordan.email });
    await as(jordan);
    const monthlyText = `Jordan: Let's choose the two videos for ${monthKey}.\nMaya Grove: First, ${topics[0]}. ${words[0]}\nJordan: What else would help your sellers?\nMaya Grove: ${topics[1]}. ${words[1]}\nJordan: We will prepare these two scripts for your read-through.\nMaya Grove: Yes, these are my two videos for this month.`;
    c.ok("owner attaches the distinct monthly transcript", (await callActions.pasteTranscript(monthly, monthlyText)).ok);
    await driveTranscriptJobs({ max: 1, budgetMs: 30_000, leaseBy: "isolated-call-journey" });
    await prisma.programCallRecord.update({ where: { id: monthly }, data: { lastError: "ANALYZE: old error", lastErrorAt: new Date(Date.now() - 1000) } });
    beforeModelResponse = async () => { await prisma.programCallRecord.update({ where: { id: monthly }, data: { lastError: "ANALYZE: newer source needs review", lastErrorAt: new Date() } }); };
    await drive();
    c.ok("successful analysis cannot erase a newer error written while it runs", (await prisma.programCallRecord.findUniqueOrThrow({ where: { id: monthly } })).lastError === "ANALYZE: newer source needs review");
    const selections = await prisma.contentTopicSelection.findMany({ where: { monthId: f.monthId }, orderBy: { rank: "asc" } });
    c.ok("monthly analysis proposes exactly two source-backed topics for the requested month", selections.length === 2 && selections.every((s) => s.status === "PROPOSED" && s.source === "call" && words.some((text) => s.evidenceJson?.includes(text))) && (await prisma.programCallRecord.findUniqueOrThrow({ where: { id: monthly } })).transcriptState === "ANALYZED");
    const stillReleased = await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: strategy.id } });
    c.ok("monthly analysis leaves the released brand strategy intact", stillReleased.status === "APPROVED" && !!stillReleased.releasedAt && await prisma.contentStrategyVersion.count({ where: { enrollmentId: f.enrollmentId } }) === 1);
    await as(kyle);
    let reconciled = true;
    for (const selection of selections) {
      reconciled &&= (await staff.reconcileTopicSelection(selection.topicId, f.monthId, true)).ok;
      reconciled &&= (await staff.topicDecision(selection.topicId, "APPROVE", "Confirmed from the client's monthly call")).ok;
    }
    c.ok("signed Kyle confirms call selections without client retyping", reconciled && await prisma.contentInterview.count({ where: { monthId: f.monthId } }) === 0 && await prisma.contentTopicSelection.count({ where: { monthId: f.monthId, status: "RECONCILED" } }) === 2);
    await enqueueTranscriptJob({ callRecordId: monthly, enrollmentId: f.enrollmentId, kind: "SCRIPT_DRAFT", requestedBy: kyle.email });
    await drive();
    c.ok("script job respects its own OFF switch", await prisma.contentScript.count({ where: { monthId: f.monthId } }) === 0 && (await prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId: monthly, kind: "SCRIPT_DRAFT" } })).attempts === 0);
    await setSwitch("script_drafting", true);
    await drive();
    const scripts = await prisma.contentScript.findMany({ where: { monthId: f.monthId } });
    const scriptScope = { scriptId: { in: scripts.map((s) => s.id) } };
    c.ok("successful drafting does not clear another job kind's error", (await prisma.programCallRecord.findUniqueOrThrow({ where: { id: monthly } })).lastError === "ANALYZE: newer source needs review");
    c.ok("worker drafts both reconciled topics from the monthly call", scripts.length === 2 && await prisma.contentScriptVersion.count({ where: { ...scriptScope, callRecordId: monthly, status: "INTERNAL_REVIEW" } }) === 2 && modelCalls.filter((m) => m.kind === "script").every((m) => words.some((text) => m.prompt.includes(text))));
    await as(jordan);
    let scriptsReleased = scripts.length === 2;
    for (const script of scripts) {
      const approve = await staff.approveScriptVersionAction(script.currentVersionId!);
      const release = await staff.releaseScriptAction(script.id);
      scriptsReleased &&= approve.ok && release.ok;
      if (!approve.ok || !release.ok) console.log(`Script action refusal: ${approve.message} / ${release.message}`);
    }
    c.ok("signed owner releases exact reviewed scripts with client sends OFF", scriptsReleased && await prisma.contentScriptRelease.count({ where: { ...scriptScope, action: "SHARE", notificationState: "SUPPRESSED" } }) === 2);
    await clearSession();
    let clientApproved = scripts.length === 2;
    for (const script of scripts) {
      const live = await prisma.contentScript.findUniqueOrThrow({ where: { id: script.id } });
      clientApproved &&= (await clientActions.portalApproveScript(auth, script.id, live.sharedVersionId!)).ok;
    }
    c.ok("normal signed client approves both exact released versions", clientApproved && await prisma.contentScript.count({ where: { monthId: f.monthId, clientApprovedByUserId: f.clientUserId, clientApprovedVersionId: { not: null } } }) === 2);
    const countBefore = await prisma.contentScriptVersion.count({ where: scriptScope });
    await drive();
    c.ok("another worker pass does not redraft or add a planning interview", await prisma.contentScriptVersion.count({ where: scriptScope }) === countBefore && await prisma.contentInterview.count({ where: { monthId: f.monthId } }) === 0);
    c.ok("no invitation, message, provider booking or outbound request occurred", await prisma.outboxMessage.count() === 0 && await prisma.programSessionRequest.count() === 0 && fence.blocked.length === 0 && fence.faked.length === 0, fence.blocked.join(", "));
    console.log(`Model evidence: ${modelCalls.length} fake calls; no real model acceptance or provider booking proof.`);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
