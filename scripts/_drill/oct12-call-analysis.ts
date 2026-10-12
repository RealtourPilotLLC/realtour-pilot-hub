// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: OCT 12 2026 — CALL TRANSCRIPTS ARE FIRST-CLASS ON THE MONTH.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct12-call-analysis.ts --logs <scratch dir>
//
// Jordan: "I want to make sure the call transcript analyses are working. I had
// a call with Janice Pigga and a call with John Collins last week, but I don't
// see that they came through on the content program platform." The Drive notes
// WERE confirmed on each call record with INGEST + ANALYZE queued, but every
// switch was off, the rollout held real clients' AI work, and the month's call
// card read only the month's own pasted text ("Paste the transcript…").
//
//   0  OLD: the card with only the month's own text says "Paste the transcript
//      to propose topics from the call" over John's held call.
//   1  The reader + the card: John's catch-up month has TWO calls (Oct 6 held,
//      transcript in from Drive; Oct 12 booked) — per-call lines, the Oct 6 one
//      "Transcript in from Drive (Gemini notes, Oct 6)" with "Analyze the call"
//      and "Automatic analysis is off — Settings → Automations: Transcript
//      processing + AI runs"; the Oct 12 one "comes in after the call".
//   2  The Overview's next step names it and opens the call card (#call).
//   3  The Strategy calls desk: a Transcript block per filed call, the count.
//   4  Settings → Calendly & calls: "Transcripts in, not analyzed", the reason,
//      "Analyze on the month" (a link — Settings' page has a 60 s ceiling).
//   5  Auth: signed out / EDITOR refused, nothing written.
//   6  ATTENDED analyze with every switch OFF: the click answers at once (the
//      AI is still waiting in after()), the job is held under the person's
//      lease, a second click is refused; then the work runs: PROPOSED topics,
//      PROPOSED facts, analysisRunId, job SUCCEEDED with the run, INGEST done;
//      the reader says "Analyzed Oct 12 — 2 topic proposals · 1 fact to review".
//   7  Re-analyze: a topic staff confirmed stays confirmed, a rejected one stays
//      rejected; a new run id.
//   8  The automatic run's reasons, read-only, on Joe's call: both off · AI runs
//      off · the backlog cutoff · "Queued — the next hourly run picks it up".
//   9  Janice: the Drive words are pulled on the click; a model failure puts
//      the job back with "Analyze now failed …" and the line says so; with the
//      processor ON, a claimed call is never picked up by the hourly tick (one
//      model call, not two); "Try again" succeeds.
//  10  THE ROLLOUT NO LONGER HOLDS INTERNAL WORK (scope addition, Oct 12): with
//      the rollout TEST_ONLY, the processor analyses Joe (a real client); a
//      client-reaching op (reminders) is still refused for him.
//  11  The legacy paste path still works on a month with no call record.
//  12  Nothing reached a client: no email, no message, no script, no approved
//      or client-visible topic; no network.
//
// ISOLATION: PGlite on 127.0.0.1:6912; production is never opened; the model is
// stubbed at aiJsonWithUsage and Drive's export at readTranscript; after() is
// captured so the drill decides when the background work runs.
// THE CLOCK IS PINNED: Mon Oct 12 2026 10:00 EDT.
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6912);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const edt = (m: number, d: number, h: number, min = 0) => new RealDate(RealDate.UTC(2026, m - 1, d, h + 4, min));
const offset = edt(10, 12, 10).getTime() - RealDate.now();
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
const now = () => new RealDate(RealDate.now() + offset);

installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown };
navigation.useRouter = () => ({ refresh() {} });

// ---- after(): captured, so the drill decides when the background work runs ----
const pendingAfter: (() => Promise<unknown> | unknown)[] = [];
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: (fn: () => Promise<unknown> | unknown) => { pendingAfter.push(fn); } }));
async function flushAfter() { while (pendingAfter.length) await pendingAfter.shift()!(); }

// ---- the model ---------------------------------------------------------------
const modelCalls: { prompt: string }[] = [];
let failNextAnalysis = false;
const TOPICS = ["Why spring listings sell faster", "Three questions before you price"];
const excerpt = (text: string) => ({ speaker: "client", speakerName: "Client", time: null, text });
interceptModule((r) => r === "@/lib/integrations/ai" || /[\\/]integrations[\\/]ai(\.ts)?$/.test(r), (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
  get(target, key) {
    if (key !== "aiJsonWithUsage") return target[key];
    return async (input: { system: string; prompt: string }) => {
      if (!/processing a call transcript/.test(input.system)) throw new Error(`unexpected model call in this drill: ${input.system.slice(0, 80)}`);
      modelCalls.push({ prompt: input.prompt });
      if (failNextAnalysis) { failNextAnalysis = false; throw new Error("503 isolated fake model unavailable"); }
      return {
        result: {
          callKind: "planning", plannedMonthKey: "2026-10",
          selectedTopics: TOPICS.map((title) => ({ title, concept: `${title} — the client's angle`, pillar: "Seller Strategy", excerpts: [excerpt(`I want a video on ${title.toLowerCase()}.`)] })),
          discussedTopics: [{ title: "A day in the life on the Main Line", concept: "Local life", pillar: null, excerpts: [excerpt("Maybe something about my day.")] }],
          rejectedIdeas: [],
          facts: [{ body: "Prefers filming on Tuesday mornings", category: "PRODUCTION_PREFERENCE", fieldKey: null, scope: "PERMANENT", speaker: "client", confidential: false, confidence: 0.9, excerpt: null, proposedValue: null }],
          strategyProposals: [], priorities: ["Lead with spring listing advice"], todos: ["Send the shot list"],
        },
        usage: { inputTokens: 12_000, outputTokens: 1_900 }, model: "isolated-fake-model",
      };
    };
  },
}));

// ---- Drive's export ------------------------------------------------------------
const driveReads: string[] = [];
const JANICE_WORDS = "Jordan: Thanks for jumping on, Janice. What should October focus on?\nJanice Pigga: I want to talk about spring listings and how sellers should price. " + "We covered pricing, staging and the first weekend in detail. ".repeat(12);
interceptModule((r) => r === "@/lib/integrations/googleDrive" || /[\\/]integrations[\\/]googleDrive(\.ts)?$/.test(r), (loaded) => ({
  ...(loaded as Record<string, unknown>),
  readTranscript: async (fileId: string) => { driveReads.push(fileId); return JANICE_WORDS; },
}));

const WORDS = (who: string) => `Jordan: Let's plan October, ${who}.\n${who}: I want to cover why spring listings sell faster and three questions before you price. ` + "We talked through the market, the calendar and what sellers ask. ".repeat(10);

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct12-call-analysis" } });
  const fence = fenceFetch();
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const ca = await import("@/lib/callAnalysis");
    const A = await import("@/app/content/callAnalysisActions");
    const legacy = await import("@/app/content/actions");
    const tj = await import("@/lib/transcriptJobs");
    const { programOverview } = await import("@/lib/programOverview");
    const { strategyCallDesk } = await import("@/lib/strategyCallDesk");
    const { reconcileSelection, rejectTopic } = await import("@/lib/contentTopics");
    const { programReach } = await import("@/lib/programRollout");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { StrategyCallCard } = await import("@/components/content/Workspace");
    const { StrategyCallsDesk } = await import("@/components/content/StrategyCallsDesk");
    const { CalendlyMappingsPanel } = await import("@/components/settings/CalendlyMappingsPanel");
    const { loadCalendlyPanelState } = await import("@/app/settings/calendlyActions");
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rsquo;/g, "’").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

    const jordan = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@oct12.test", role: "OWNER", status: "ACTIVE" } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@oct12.test", role: "ADMIN", status: "ACTIVE" } });
    const kim = await prisma.appUser.create({ data: { name: "Kim", email: "kim@oct12.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const as = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });

    // ---- three real clients' October, as production holds them ------------------
    const J = await buildContentMonth(prisma, { name: "John Collins TEST", package: "Accelerator", monthKey: "2026-10", project: false, owner: false });
    const Ja = await buildContentMonth(prisma, { name: "Janice Pigga TEST", package: "Accelerator", monthKey: "2026-10", project: false, owner: false });
    const Jo = await buildContentMonth(prisma, { name: "Joseph Sutow TEST", package: "Accelerator", monthKey: "2026-10", project: false, owner: false });
    for (const [f, name] of [[J, "John Collins"], [Ja, "Janice Pigga"], [Jo, "Joseph Sutow"]] as const) {
      await prisma.client.update({ where: { id: f.clientId }, data: { name } }); // real names: the rollout reads them as REAL clients
      await prisma.contentMonth.update({ where: { id: f.monthId }, data: { strategyCallStatus: "COMPLETED" } });
    }
    let hashN = 0;
    const heldCall = async (f: typeof J, at: Date, title: string, words: string | null, externalId: string) => {
      const call = await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, targetMonthKey: "2026-10", callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "CONFIRMED_BY_STAFF", transcriptState: "CONFIRMED", scheduledStart: at, scheduledEnd: new RealDate(at.getTime() + 30 * 60_000), inviteeName: f.clientId } });
      const src = await prisma.programTranscriptSource.create({ data: { callRecordId: call.id, provider: "drive", externalId, sourceUrl: `https://docs.google.com/document/d/${externalId}/edit`, title, recordedAt: at, text: words, contentHash: `oct12-${++hashN}`, matchState: "CONFIRMED", confirmedBy: "drive-sweep", confirmedAt: at, createdBy: "drive-sweep" } });
      const queuedAt = new RealDate(at.getTime() + 20 * 3600_000);
      await prisma.programTranscriptJob.create({ data: { callRecordId: call.id, transcriptSourceId: src.id, enrollmentId: f.enrollmentId, kind: "INGEST", dedupeKey: `${call.id}:${src.id}:INGEST`, requestedBy: "drive-sweep", createdAt: queuedAt } });
      await prisma.programTranscriptJob.create({ data: { callRecordId: call.id, enrollmentId: f.enrollmentId, kind: "ANALYZE", dedupeKey: `${call.id}:ANALYZE`, requestedBy: "drive-sweep", createdAt: queuedAt } });
      return call.id;
    };
    const john = await heldCall(J, edt(10, 6, 16), "John P. Collins and Jordan Spackman - 2026/10/06 16:00 EDT - Notes by Gemini", WORDS("John"), "drive-john");
    // John's catch-up month: a second call is booked for later today.
    const johnNext = (await prisma.programCallRecord.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthId: J.monthId, targetMonthKey: "2026-10", callType: "MONTHLY_STRATEGY", status: "SCHEDULED", matchState: "CONFIRMED_BY_STAFF", transcriptState: "NONE", scheduledStart: edt(10, 12, 14), scheduledEnd: edt(10, 12, 14, 30) } })).id;
    await prisma.contentMonth.update({ where: { id: J.monthId }, data: { callRecordId: johnNext, strategyCallAt: edt(10, 6, 16) } });
    const janice = await heldCall(Ja, edt(10, 8, 14), "Janice Pigga and Jordan Spackman - 2026/10/08 14:00 EDT - Notes by Gemini", null, "drive-janice");
    const joe = await heldCall(Jo, edt(9, 24, 10), "Joe Sutow and Jordan Spackman - 2026/09/24 10:00 EDT - Notes by Gemini", WORDS("Joe"), "drive-joe");
    const job = (callRecordId: string, kind: "INGEST" | "ANALYZE") => prisma.programTranscriptJob.findFirstOrThrow({ where: { callRecordId, kind } });
    const setSwitch = (key: string, enabled: boolean, configJson?: string | null) =>
      prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledAt: now(), enabledBy: "drill", configJson: configJson ?? null }, update: { enabled, enabledAt: now(), ...(configJson !== undefined ? { configJson } : {}) } });
    const card = (calls: Awaited<ReturnType<typeof ca.loadCallTranscripts>>, m = J) => text(renderToStaticMarkup(createElement(StrategyCallCard, {
      monthId: m.monthId, status: "COMPLETED", at: edt(10, 6, 16).toISOString(), hasTranscript: false, transcriptProcessed: false, required: true, bookingUrl: "https://calendly.example/strategy", calls,
    })));

    // =========================================================================
    c.head("0 · OLD: the card read only the month's own pasted text");
    {
      const old = card([]);
      c.ok("OLD: over John's held call the card says \"Paste the transcript to propose topics from the call\" and offers no Analyze", old.includes("Paste the transcript to propose topics from the call") && !old.includes("Analyze the call") && !old.includes("Transcript in from Drive"), old.slice(0, 300));
    }

    // =========================================================================
    c.head("1 · the reader and the card: two calls on John's month, per-call lines");
    let monthCalls = await ca.loadCallTranscripts({ monthId: J.monthId });
    {
      const oct6 = monthCalls.find((x) => x.callRecordId === john);
      const oct12 = monthCalls.find((x) => x.callRecordId === johnNext);
      c.ok("both calls are on the month, oldest first", monthCalls.length === 2 && monthCalls[0].callRecordId === john && monthCalls[1].callRecordId === johnNext, JSON.stringify(monthCalls.map((x) => x.callRecordId)));
      c.ok("Oct 6: state in, \"Transcript in from Drive (Gemini notes, Oct 6)\", may run", oct6?.state === "in" && oct6.sourceLine === "Transcript in from Drive (Gemini notes, Oct 6)" && oct6.canAnalyze && !oct6.blocked, JSON.stringify(oct6));
      c.ok("…and WHY the automatic run waits: \"Automatic analysis is off — Settings → Automations: Transcript processing + AI runs.\"", oct6?.autoLine === "Automatic analysis is off — Settings → Automations: Transcript processing + AI runs.", oct6?.autoLine ?? "");
      c.ok("Oct 12 (booked, later today): no transcript yet, \"comes in after the call\", no button", oct12?.state === "none" && oct12.waitLine === "The transcript comes in after the call." && !oct12.canAnalyze, JSON.stringify(oct12));
      c.ok("the line links to the month's call card", oct6?.href === `/content/${J.enrollmentId}?tab=plan&view=calls#call`, oct6?.href ?? "");
      const now1 = card(monthCalls);
      c.ok("NEW card: \"Strategy call held — transcript in, not analyzed yet\", the Drive line, Analyze the call, the reason", now1.includes("Strategy call held — transcript in, not analyzed yet") && now1.includes("Transcript in from Drive (Gemini notes, Oct 6)") && now1.includes("Analyze the call") && now1.includes("Automatic analysis is off — Settings → Automations: Transcript processing + AI runs."), now1.slice(0, 600));
      c.ok("…the paste path stays, quietly (\"Or paste a transcript instead\")", now1.includes("Or paste a transcript instead") && !now1.includes("Paste the transcript to propose topics from the call"));
      c.ok("…and the Oct 12 call reads \"The transcript comes in after the call.\"", now1.includes("The transcript comes in after the call."));
    }

    // =========================================================================
    c.head("2 · the Overview's next step");
    const rowOf = async (f: typeof J) => (await programOverview({ monthKey: "2026-10", enrollmentIds: [f.enrollmentId], includeTest: true, now: now() })).rows.find((r) => r.monthId === f.monthId)!;
    {
      const row = await rowOf(J);
      c.ok("next step: \"Transcript in from Drive (Gemini notes, Oct 6) — not analyzed yet …\", CTA \"Analyze the call\"", row.nextAction.text.startsWith("Transcript in from Drive (Gemini notes, Oct 6) — not analyzed yet") && row.nextAction.cta === "Analyze the call", `${row.nextAction.text} | ${row.nextAction.cta}`);
      c.ok("…it opens the month's call card, not the queue", row.nextAction.href === `/content/${J.enrollmentId}?tab=plan&view=calls#call`, row.nextAction.href);
      c.ok("…it says the automatic run is off and offers the manual way", /automatic analysis is off/.test(row.nextAction.text) && /Analyze the call to do it now/.test(row.nextAction.text), row.nextAction.text);
    }

    // =========================================================================
    c.head("3 · the Strategy calls desk");
    {
      const d = await strategyCallDesk({ now: now() });
      const r6 = d.rows.find((r) => r.id === john), r12 = d.rows.find((r) => r.id === johnNext);
      c.ok("each filed call carries its transcript state (in / none)", r6?.transcript?.state === "in" && r12?.transcript?.state === "none", `${r6?.transcript?.state} / ${r12?.transcript?.state}`);
      const html = text(renderToStaticMarkup(createElement(StrategyCallsDesk, { data: JSON.parse(JSON.stringify(d)) })));
      c.ok("the page: a Transcript block with the Drive line and Analyze the call", html.includes("Transcript Transcript in from Drive (Gemini notes, Oct 6)") && html.includes("Analyze the call"), html.slice(0, 800));
      c.ok("the page counts the transcripts in, not analyzed (John, Janice, Joe)", /3 transcripts in, not analyzed/.test(html), html.slice(0, 300));
      c.ok("…and does not offer Analyze on the booked Oct 12 call (its transcript comes later)", (html.match(/Analyze the call/g) ?? []).length === 3, String((html.match(/Analyze the call/g) ?? []).length));
    }

    // =========================================================================
    c.head("4 · Settings → Calendly & calls");
    {
      await as(jordan);
      const aw = await ca.awaitingAnalysis(now());
      c.ok("awaitingAnalysis: John, Janice, Joe — newest first — and the off line", aw.calls.map((x) => x.callRecordId).join(",") === [janice, john, joe].join(",") && aw.offLine === "Automatic analysis is off — Settings → Automations: Transcript processing + AI runs.", JSON.stringify({ ids: aw.calls.map((x) => x.clientName), off: aw.offLine }));
      const state = await loadCalendlyPanelState();
      const html = text(renderToStaticMarkup(createElement(CalendlyMappingsPanel, { state, canOpenOperations: true })));
      c.ok("the panel: \"Transcripts in, not analyzed\" 3, the reason, each client, \"Analyze on the month\"", html.includes("Transcripts in, not analyzed 3") && html.includes("Automatic analysis is off — Settings → Automations: Transcript processing + AI runs.") && html.includes("John Collins") && html.includes("Janice Pigga") && html.includes("Analyze on the month"), html.slice(html.indexOf("Transcripts in"), html.indexOf("Transcripts in") + 600));
      c.ok("…Settings links to the month rather than running a minute of AI under its 60-second ceiling", !html.includes("Analyze the call"));
      c.ok("…and the job lane says the processor works through every client's calls", html.includes("It works through every client’s calls (the rollout only limits what reaches clients)"));
      await clearSession();
    }

    // =========================================================================
    c.head("5 · auth");
    {
      const before = JSON.stringify(await job(john, "ANALYZE"));
      const out = await A.analyzeCallAction(john);
      await as(kim);
      const ed = await A.analyzeCallAction(john);
      const st = await A.callAnalysisStatusAction(john);
      c.ok("signed out and an EDITOR are refused; nothing claimed, no model call", !out.ok && !ed.ok && !st.ok && JSON.stringify(await job(john, "ANALYZE")) === before && modelCalls.length === 0 && pendingAfter.length === 0, `${out.message} / ${ed.message}`);
      await clearSession();
    }

    // =========================================================================
    c.head("6 · Analyze the call — attended, with every switch OFF, instant");
    let firstRun = "";
    {
      await as(kyle);
      const r = await A.analyzeCallAction(john);
      const claimed = await job(john, "ANALYZE");
      c.ok("the click answers at once: \"Analyzing the call…\", the AI still waiting in after()", r.ok && r.message === "Analyzing the call…" && pendingAfter.length === 1 && modelCalls.length === 0, r.message);
      c.ok("the ANALYZE job is claimed under Kyle's lease (no attempt spent)", claimed.state === "RUNNING" && claimed.leaseBy === `attended:${kyle.email}` && claimed.attempts === 0 && !!claimed.leaseUntil, JSON.stringify({ s: claimed.state, b: claimed.leaseBy, a: claimed.attempts }));
      const st = await A.callAnalysisStatusAction(john);
      c.ok("status while it runs: analyzing", st.ok && st.call?.state === "analyzing");
      const again = await A.analyzeCallAction(john);
      c.ok("a second click is refused: \"It is being analyzed right now — give it a minute.\"", !again.ok && again.message === "It is being analyzed right now — give it a minute." && pendingAfter.length === 1, again.message);
      await flushAfter();
      const rec = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: john } });
      const done = await job(john, "ANALYZE");
      const ingest = await job(john, "INGEST");
      c.ok("ONE model call, with ai_runs and transcript_jobs OFF (attended)", modelCalls.length === 1 && modelCalls[0].prompt.includes("I want to cover why spring listings sell faster") && !(await prisma.programAutomation.findFirst({ where: { enabled: true } })));
      c.ok("the call: ANALYZED, analysisRunId set, analysisJson with 2 proposed selections", rec.transcriptState === "ANALYZED" && !!rec.analysisRunId && (JSON.parse(rec.analysisJson ?? "{}") as { proposedSelections?: number }).proposedSelections === 2, `${rec.transcriptState} ${rec.analysisRunId}`);
      firstRun = rec.analysisRunId!;
      c.ok("the job: SUCCEEDED with the same run, lease released, marked attended", done.state === "SUCCEEDED" && done.aiRunId === rec.analysisRunId && !done.leaseBy && !done.leaseUntil && /"attended":true/.test(done.resultJson ?? ""), JSON.stringify({ s: done.state, run: done.aiRunId }));
      c.ok("the waiting INGEST is closed too (the words were already in)", ingest.state === "SUCCEEDED");
      const run = await prisma.programAiRun.findUniqueOrThrow({ where: { id: rec.analysisRunId! } });
      c.ok("the run ledger: call_analysis, SUCCEEDED, requested by Kyle, dedupe key free again", run.kind === "call_analysis" && run.status === "SUCCEEDED" && run.requestedBy === kyle.email && run.dedupeKey === null, JSON.stringify({ k: run.kind, s: run.status, by: run.requestedBy }));
      const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: J.monthId } });
      const topics = await prisma.contentTopic.findMany({ where: { enrollmentId: J.enrollmentId } });
      c.ok("topics: 2 PROPOSED selections on October, 3 topics all PROPOSED, none client-visible", sels.length === 2 && sels.every((s) => s.status === "PROPOSED" && s.callRecordId === john) && topics.length === 3 && topics.every((t) => t.approvalState === "PROPOSED" && !t.clientVisible), JSON.stringify(sels.map((s) => s.status)));
      const facts = await prisma.clientFact.findMany({ where: { clientId: J.clientId } });
      c.ok("the fact is PROPOSED for staff review (an attended run never auto-accepts)", facts.length === 1 && facts[0].status === "PROPOSED" && !facts[0].autoAccepted, JSON.stringify(facts.map((f) => [f.status, f.autoAccepted])));
      const after1 = await A.callAnalysisStatusAction(john);
      c.ok("status: \"Analyzed Oct 12 — 2 topic proposals · 1 fact to review\", Re-analyze offered", after1.call?.state === "analyzed" && after1.call.resultLine === "Analyzed Oct 12 — 2 topic proposals · 1 fact to review" && after1.call.canAnalyze, after1.call?.resultLine ?? "");
      monthCalls = await ca.loadCallTranscripts({ monthId: J.monthId });
      const html = card(monthCalls);
      c.ok("the card: \"its topics are proposed on Video Topics\", the result, Re-analyze", html.includes("Strategy call held — its topics are proposed on Video Topics") && html.includes("Analyzed Oct 12 — 2 topic proposals · 1 fact to review — confirm them on Video Topics") && html.includes("Re-analyze") && !html.includes("Analyze the call"), html.slice(0, 500));
      const row = await rowOf(J);
      c.ok("the Overview no longer reports the call: evidence \"transcript analysed\", no problem", row.strategyCall.evidence === "transcript analysed" && row.strategyCall.problem === null && !/Transcript in/.test(row.nextAction.text), `${row.strategyCall.evidence} | ${row.nextAction.text}`);
    }

    // =========================================================================
    c.head("7 · Re-analyze keeps what a person decided");
    {
      const [keepT, dropT] = await Promise.all(TOPICS.map((t) => prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: J.enrollmentId, title: t } })));
      await reconcileSelection(keepT.id, J.monthId, true, { kind: "STAFF", staffUserId: kyle.id });
      await rejectTopic(dropT.id, kyle.email, "Not for this client");
      const r = await A.analyzeCallAction(john);
      c.ok("\"Re-analyzing the call…\"", r.ok && r.message === "Re-analyzing the call…", r.message);
      await flushAfter();
      const rec = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: john } });
      const keep = await prisma.contentTopicSelection.findUniqueOrThrow({ where: { topicId_monthId: { topicId: keepT.id, monthId: J.monthId } } });
      const drop = await prisma.contentTopic.findUniqueOrThrow({ where: { id: dropT.id } });
      const dropSel = await prisma.contentTopicSelection.findUniqueOrThrow({ where: { topicId_monthId: { topicId: dropT.id, monthId: J.monthId } } });
      c.ok("a second model call and a NEW run on the call", modelCalls.length === 2 && rec.analysisRunId !== firstRun && rec.transcriptState === "ANALYZED");
      c.ok("the confirmed topic stays RECONCILED; the rejected one stays REJECTED and off the month", keep.status === "RECONCILED" && drop.status === "REJECTED" && drop.approvalState === "REJECTED" && dropSel.status === "REMOVED", `${keep.status} / ${drop.status} ${dropSel.status}`);
      const st = await A.callAnalysisStatusAction(john);
      c.ok("status: \"Analyzed Oct 12 — 0 topic proposals · 1 already decided, kept · …\"", st.call?.state === "analyzed" && /^Analyzed Oct 12 — 0 topic proposals · 1 already decided, kept/.test(st.call.resultLine ?? ""), st.call?.resultLine ?? "");
    }

    // =========================================================================
    c.head("8 · why the automatic run has not done Joe's call (read-only)");
    {
      const line = async () => (await ca.loadCallTranscripts({ callRecordIds: [joe] }))[0].autoLine;
      const before = JSON.stringify(await prisma.programTranscriptJob.findMany({ orderBy: { id: "asc" } }));
      c.ok("both off → \"…: Transcript processing + AI runs.\"", (await line()) === "Automatic analysis is off — Settings → Automations: Transcript processing + AI runs.");
      await setSwitch("transcript_jobs", true, JSON.stringify({ onlyQueuedAfter: now().toISOString(), firstSwitchedOnAt: now().toISOString() }));
      c.ok("processor on, AI runs off → \"…: AI runs.\"", (await line()) === "Automatic analysis is off — Settings → Automations: AI runs.");
      await setSwitch("ai_runs", true);
      const bl = await line();
      c.ok("both on, queued before the first switch-on → the backlog, and the manual way", bl === "Automatic analysis skips it: it was queued Sep 25, before Transcript processing was first switched on. Include older jobs in Settings → Calendly & calls, or analyze it now.", bl ?? "");
      await setSwitch("transcript_jobs", true, JSON.stringify({ onlyQueuedAfter: "ALL", firstSwitchedOnAt: now().toISOString() }));
      c.ok("older jobs included → \"Queued — the next hourly run picks it up.\"", (await line()) === "Queued — the next hourly run picks it up.");
      c.ok("reading wrote nothing", JSON.stringify(await prisma.programTranscriptJob.findMany({ orderBy: { id: "asc" } })) === before);
      await setSwitch("transcript_jobs", false);
      await setSwitch("ai_runs", false);
    }

    // =========================================================================
    c.head("9 · Janice: Drive words on the click, a failure, the processor never doubles it");
    {
      failNextAnalysis = true;
      const r1 = await A.analyzeCallAction(janice);
      await flushAfter();
      const j1 = await job(janice, "ANALYZE");
      const src = await prisma.programTranscriptSource.findFirstOrThrow({ where: { callRecordId: janice } });
      c.ok("the Drive export was read once and saved on the source", r1.ok && driveReads.join(",") === "drive-janice" && src.text === JANICE_WORDS.trim());
      c.ok("…and her INGEST is closed", (await job(janice, "INGEST")).state === "SUCCEEDED");
      c.ok("the model failed: the job is back to QUEUED with \"Analyze now failed (Oct 12): 503 …\", no attempt spent", j1.state === "QUEUED" && j1.attempts === 0 && !j1.leaseBy && /^Analyze now failed \(Oct 12\): 503 isolated fake model unavailable/.test(j1.lastError ?? ""), `${j1.state} ${j1.lastError}`);
      const st1 = await A.callAnalysisStatusAction(janice);
      c.ok("the line: state failed, the error shown, \"Try again\" offered", st1.call?.state === "failed" && /Analyze now failed/.test(st1.call.error ?? "") && st1.call.canAnalyze && (await prisma.programCallRecord.findUniqueOrThrow({ where: { id: janice } })).transcriptState === "CONFIRMED", JSON.stringify(st1.call));
      const html = text(renderToStaticMarkup(createElement(StrategyCallCard, { monthId: Ja.monthId, status: "COMPLETED", at: null, hasTranscript: false, transcriptProcessed: false, required: true, bookingUrl: "https://calendly.example/strategy", calls: [st1.call!] })));
      c.ok("…the card says \"analysis failed\" and offers \"Try again\"", html.includes("analysis failed") && html.includes("Try again"), html.slice(0, 400));

      // The processor on (older jobs included) while a click holds the call.
      await setSwitch("ai_runs", true);
      await setSwitch("transcript_jobs", true, JSON.stringify({ onlyQueuedAfter: "ALL", firstSwitchedOnAt: now().toISOString() }));
      const calls0 = modelCalls.length;
      const r2 = await A.analyzeCallAction(janice);
      c.ok("\"Try again\" claims it", r2.ok && (await job(janice, "ANALYZE")).state === "RUNNING");
      const tick = await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill-tick", now: now() });
      const jMid = await job(janice, "ANALYZE");
      c.ok("the hourly tick does not claim Janice's analysis while the click holds it", jMid.state === "RUNNING" && jMid.leaseBy === `attended:${kyle.email}`, JSON.stringify(tick));
      // (the same tick analysed Joe — section 10)
      await flushAfter();
      const j2 = await job(janice, "ANALYZE");
      c.ok("…then the click's run finishes: SUCCEEDED, ANALYZED", j2.state === "SUCCEEDED" && (await prisma.programCallRecord.findUniqueOrThrow({ where: { id: janice } })).transcriptState === "ANALYZED");
      await tj.driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "drill-tick", now: now() });
      const janiceRuns = await prisma.programAiRun.count({ where: { kind: "call_analysis", clientId: Ja.clientId, status: "SUCCEEDED" } });
      c.ok("exactly ONE successful analysis of Janice's call (one failed try, one success; the tick added none)", janiceRuns === 1 && modelCalls.length === calls0 + 2, `${janiceRuns} runs, +${modelCalls.length - calls0} model calls (Joe's queued run is one of them)`);
    }

    // =========================================================================
    c.head("10 · the rollout no longer holds internal work (scope addition)");
    {
      const rollout = await (await import("@/lib/programRollout")).loadProgramRollout();
      const jr = await job(joe, "ANALYZE");
      const jRec = await prisma.programCallRecord.findUniqueOrThrow({ where: { id: joe } });
      const run = jRec.analysisRunId ? await prisma.programAiRun.findUnique({ where: { id: jRec.analysisRunId } }) : null;
      c.ok("rollout TEST_ONLY, and the processor analysed Joe Sutow (a REAL client) on the hourly tick", rollout.rollout.mode === "TEST_ONLY" && jr.state === "SUCCEEDED" && jr.attempts === 1 && jRec.transcriptState === "ANALYZED" && run?.requestedBy === "drive-sweep", `${rollout.rollout.mode} ${jr.state} ${jr.lastError}`);
      const reach = await programReach("reminders", Jo.clientId);
      c.ok("…while what REACHES him is still gated: reminders refused by the rollout", !reach.ok, JSON.stringify(reach));
      const batch = await tj.transcriptQueueBatch(now());
      c.ok("the queue summary no longer speaks of a rollout hold", !/outside the rollout/.test(batch.line) && !("heldScope" in batch), batch.line);
      await setSwitch("transcript_jobs", false);
      await setSwitch("ai_runs", false);
    }

    // =========================================================================
    c.head("11 · the legacy paste path still works");
    {
      const L = await buildContentMonth(prisma, { name: "Legacy Paste TEST", monthKey: "2026-10", project: false, owner: false });
      await prisma.contentMonth.update({ where: { id: L.monthId }, data: { strategyCallStatus: "COMPLETED" } });
      const calls = await ca.loadCallTranscripts({ monthId: L.monthId });
      const html = card(calls, L);
      c.ok("a month with no call record keeps \"Paste the transcript to propose topics from the call\"", calls.length === 0 && html.includes("Paste the transcript to propose topics from the call"));
      const saved = await legacy.saveMonthTranscript(L.monthId, WORDS("Lee"));
      const before = modelCalls.length;
      const an = await legacy.analyzeTranscript(L.monthId);
      const m = await prisma.contentMonth.findUniqueOrThrow({ where: { id: L.monthId } });
      c.ok("save + Analyze (the month's own path): one model call, the month stamped, its topics proposed", saved.ok && an.ok && modelCalls.length === before + 1 && !!m.transcriptProcessedAt && (await prisma.contentTopicSelection.count({ where: { monthId: L.monthId, status: "PROPOSED" } })) === 2, an.message);
    }

    // =========================================================================
    c.head("12 · nothing reached a client");
    {
      c.ok("no email queued, no program message, no script, no approved or client-visible topic", (await prisma.outboxMessage.count()) === 0 && (await prisma.programMessage.count()) === 0 && (await prisma.contentScript.count()) === 0 && (await prisma.contentTopic.count({ where: { OR: [{ clientVisible: true }, { approvalState: "APPROVED" }] } })) === 0);
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
