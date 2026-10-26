// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE BRIEF WRITER, v4 (Oct 26 2026). Jordan's own two-step workflow:
// the topic's summary of what the agent said (topicBrief.ts), then ONE script
// from it the way his Scripting GPT writes: his GPT's instructions word for
// word, then his additional rules (55 to 70 words; they win), his GPT's Erica
// scripts as how a script reads, the script in his GPT's own output format.
// Then his rule 6: an independent check (structure, word count, source
// accuracy, spoken delivery) returns it as it was (PASS) or fixed (FIXED).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct26-brief-writer.ts --logs <dir>
//
//   1. the switch: off, a pilot list without this client, no month, a skit:
//      the other writers; on for this client, a month's direct topic: the
//      brief writer
//   2. a draft: only his GPT's instructions and his rules (no old files, no
//      hub notes); the summary with her own words; his five GPT scripts in
//      his format; the answer read out of his format (markdown and all);
//      the check reads what it was written from, the script and the hub's
//      count, and PASS keeps it word for word; the version carries the check
//   3. the office's edited summary is what the writer reads; 84 words: the
//      check is told to tighten and its FIXED 68 is kept, one check
//   4. a topic the call never covered: refused before any model call
//   5. the check: a second one only while still over 80; a fix that runs
//      100 or more and longer is refused; a failed or unreadable check keeps
//      the script; an answer not in his format is refused, its key released
//   6. leave one out: the GPT script written for this very topic is never
//      shown, the other four are
//   7. a revision of a brief-written script: the same writer, the summary,
//      the script in his format, the change asked for; then checked
//   8. counting and reading his format; no dash anywhere in the rules
//
// ISOLATION: PGlite via the shared harness, every outbound call fenced; the
// model is faked at aiStructuredWithUsage. The summaries are seeded rows.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5611);
installNextStubs();
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: () => {} }));
const fence = fenceFetch(async () => null);

// ---- the model: faked at aiStructuredWithUsage --------------------------------
const usage = { inputTokens: 9000, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0 };
const WORDS = "buyers keep telling me the town feels quiet until they walk King Street on a Saturday morning and see every table full near the train".split(" ");
const said = (n: number, from: number) => Array.from({ length: n }, (_, i) => WORDS[(from + i) % WORDS.length]).join(" ");
/** A script of exactly n spoken words in his GPT's format: a hook, three points, the rest in the close. */
const scriptOf = (n: number, o: { markdown?: boolean; title?: string } = {}) => {
  const [h, p] = n >= 60 ? [11, 15] : [8, 10];
  const title = o.title ?? "Malvern Is Underrated";
  const md = (l: string) => (o.markdown ? `**${l}**` : l);
  return [
    o.markdown ? `### Video 1: ${title}` : `Video 1: ${title}`, "CATEGORY: Local Life",
    md("HOOK"), `${said(h, 0)}.`,
    md("TALKING POINT 1: REHOOK"), `${said(p, 3)}.`,
    md("TALKING POINT 2: BUILD"), `${said(p, 7)}.`,
    md("TALKING POINT 3: PAYOFF"), `${said(p, 11)}.`,
    md("CLOSE"), `${said(n - h - 3 * p, 2)}.`,
    "Caption CTA: Send me a message \u2014 today.", "Production: None",
    ...(o.markdown ? ["", "Strategic Batch Notes", "This batch leans on local life."] : []),
  ].join("\n");
};
type WriterAnswer = number | "throw" | { raw: string };
type CheckAnswer = "PASS" | number | "throw" | { raw: string };
let writerQueue: WriterAnswer[] = [];
let checkQueue: CheckAnswer[] = [];
const calls: { who: "writer" | "check"; system: string; prompt: string }[] = [];
const writerCalls = () => calls.filter((x) => x.who === "writer");
const checkCalls = () => calls.filter((x) => x.who === "check");
let otherCalls = 0;
const GPT = "You are Realtour Pilot's Scripting GPT, as configured by Jordan Spackman.";
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiStructuredWithUsage" && k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        const who = opts.system.startsWith(`${GPT} This time you are checking`) ? "check" : opts.system.startsWith(`${GPT} These are your instructions.`) ? "writer" : null;
        if (!who) { otherCalls++; throw new Error(`unexpected model call: ${opts.system.slice(0, 80)}`); }
        calls.push({ who, ...opts });
        const next = (who === "writer" ? writerQueue : checkQueue).shift();
        if (next === undefined) throw new Error(`the drill queued no ${who} answer for this call`);
        if (next === "throw") throw new Error("model overloaded (drill)");
        const done = (result: unknown) => ({ result, usage, model: "claude-opus-5-5", stopReason: "end_turn" });
        if (who === "writer") return done({ script: typeof next === "object" ? next.raw : scriptOf(next as number, { markdown: true }) });
        if (next === "PASS") return done({ verdict: "PASS", issues: [], script: opts.prompt.split("THE SCRIPT TO CHECK:\n")[1].split("\n\nTHE HUB'S COUNT")[0] });
        if (typeof next === "object") return done({ verdict: "FIXED", issues: ["Unreadable (drill)"], script: next.raw });
        return done({ verdict: "FIXED", issues: [`Tightened to ${next} (drill)`], script: scriptOf(next) });
      };
    },
  }),
);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "isolated-oct26-brief-writer", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const gen = await import("@/lib/contentGeneration");
  const bw = await import("@/lib/scriptWriter/briefWriter");
  const P = await import("@/lib/scriptWriter/briefWriterPrompt");
  const { LENGTH } = P;
  const { JORDAN_GPT_SCRIPTS, JORDAN_SCRIPT_RULES, PERSONAL_BRANDING_GENERATOR } = await import("@/lib/scriptWriter/houseReference");
  const { createPillar } = await import("@/lib/contentPillars");
  type TopicBrief = import("@/lib/scriptWriter/briefFormat").TopicBrief;
  const versionOf = (id: string) => prisma.contentScriptVersion.findUniqueOrThrow({ where: { id } });
  const bagOf = async (id: string) => JSON.parse((await versionOf(id)).validationJson ?? "{}") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const spoken = async (id: string) => { const v = await versionOf(id); return bw.briefSpokenWords({ hook: v.hook ?? "", points: (JSON.parse(v.pointsJson ?? "[]") as { text: string }[]).map((p) => p.text), close: v.close ?? "" }, false); };
  const runsOf = (enrollmentId: string) => prisma.programAiRun.findMany({ where: { enrollmentId }, orderBy: { createdAt: "asc" } });
  const reset = () => { calls.length = 0; writerQueue = []; checkQueue = []; };
  const owner = "jordan@oct26-bw.test";

  try {
    // ==================================================================
    c.head("0 · the world: Marcee's October, chosen on her call");
    await prisma.appUser.create({ data: { email: owner, name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const M = await buildContentMonth(prisma, {
      name: "Marcee Writer TEST", package: "Pro", project: false, owner: { email: "info+marcee-bw@realtourpilot.com", name: "Marcee Writer TEST" },
      topics: [
        { title: "Malvern is underrated", selection: "SELECTED", source: "call" },
        { title: "Get pre-approved before you tour", selection: "SELECTED", source: "call" },
        { title: "A topic the call skipped", selection: "SELECTED", source: "call" },
        { title: "Why spring listings sit", selection: "SELECTED", source: "call" },
        { title: "The inspection that saved a deal", selection: "SELECTED", source: "call" },
        { title: "Open houses still work", selection: "SELECTED", source: "call" },
        { title: "What a buyer's agent costs", selection: "SELECTED", source: "call" },
      ],
    });
    const [tA, tB, tC, tD, tE, tF, tG] = M.topicIds;
    // The topic his GPT wrote "Prove your listing price" for: its own id, so the writer must leave that script out.
    const tP = JORDAN_GPT_SCRIPTS[0].topicId;
    await prisma.contentTopic.create({ data: { id: tP, enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, title: "Prove your listing price", source: "call", status: "SELECTED", clientVisible: false } });
    await prisma.contentTopicSelection.create({ data: { topicId: tP, monthId: M.monthId, enrollmentId: M.enrollmentId, clientId: M.clientId, status: "SELECTED", source: "call", rank: 8 } });
    const all = [...M.topicIds, tP];
    const pillar = await createPillar({ enrollmentId: M.enrollmentId, clientId: M.clientId, name: "Local Life", createdBy: owner });
    await prisma.contentTopic.updateMany({ where: { id: { in: all } }, data: { pillarId: pillar, approvalState: "APPROVED" } });
    const brief = (topicId: string, title: string, over: Partial<TopicBrief> = {}): TopicBrief => ({
      topicId, title, discussed: true, audience: "Buyers", where: "12:04 to 18:30",
      summary: `Marcee's point on ${title}: King Street on Saturday mornings sells Malvern.`, details: ["King Street on Saturday mornings"], examples: [{ text: "A couple from Center City bought on Woodland Avenue last spring.", kind: "real" }],
      herWords: ["Malvern is the Main Line without the Main Line price"], fromStrategist: [], notEstablished: ["No sale price was given"], overlap: null, ...over,
    });
    const seed = (topicId: string, b: TopicBrief, extra: Record<string, unknown> = {}) => prisma.contentTopicBrief.create({ data: {
      enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, topicId, route: "CALL", briefJson: JSON.stringify(b), createdBy: "drill", ...extra,
    } });
    await seed(null as unknown as string, { opening: "Marcee chose eight videos.", mainRequest: "More listings this spring", held: [] } as never, { topicId: null });
    const bA = await seed(tA, brief(tA, "Malvern is underrated"));
    await seed(tB, brief(tB, "Get pre-approved before you tour"), { editedText: "EDITED BY KYLE: Marcee wants first-time buyers pre-approved with her lender in a day.", editedBy: "Kyle", editedAt: new Date() });
    await seed(tC, brief(tC, "A topic the call skipped", { discussed: false, summary: "Not discussed on the call and no written answers yet.", details: [], examples: [], herWords: [], notEstablished: [] }));
    for (const [t, title] of [[tD, "Why spring listings sit"], [tE, "The inspection that saved a deal"], [tF, "Open houses still work"], [tG, "What a buyer's agent costs"], [tP, "Prove your listing price"]] as const) await seed(t, brief(t, title));
    c.ok("seeded: eight chosen topics, a header and eight summaries (one edited, one never discussed)", (await prisma.contentTopicBrief.count({ where: { monthId: M.monthId } })) === 9);

    // ==================================================================
    c.head("1 · the switch");
    const { ctx } = await gen.buildClientContext(M.enrollmentId, { monthId: M.monthId });
    const routeOf = (monthId: string | null) => gen.routeScriptDraft({ topicId: tA, enrollmentId: M.enrollmentId, ctx, monthId });
    c.ok("no switch row: not the brief writer", (await routeOf(M.monthId)).route !== "brief");
    await prisma.appSetting.create({ data: { key: bw.BRIEF_WRITER_SWITCH, value: JSON.stringify({ on: false }) } });
    c.ok("switched off: not the brief writer", (await routeOf(M.monthId)).route !== "brief");
    await prisma.appSetting.update({ where: { key: bw.BRIEF_WRITER_SWITCH }, data: { value: JSON.stringify({ on: true, enrollmentIds: ["someone-else"] }) } });
    c.ok("a pilot list without this client: not the brief writer", (await routeOf(M.monthId)).route !== "brief");
    await prisma.appSetting.update({ where: { key: bw.BRIEF_WRITER_SWITCH }, data: { value: JSON.stringify({ on: true, enrollmentIds: [M.enrollmentId] }) } });
    c.ok("on for this client, but no month (a bank topic): not the brief writer", (await routeOf(null)).route !== "brief");
    c.ok("on for this client, a month's topic: the brief writer", (await routeOf(M.monthId)).route === "brief");
    const { withTopicFormat } = await import("@/lib/contentPolicy/videoFormat");
    const scoresA = (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tA } })).scoresJson;
    await prisma.contentTopic.update({ where: { id: tA }, data: { scoresJson: withTopicFormat(scoresA, "SKIT") } });
    c.ok("…but a skit topic stays on the skit writer (direct to camera only)", (await routeOf(M.monthId)).route === "skit", (await routeOf(M.monthId)).route);
    await prisma.contentTopic.update({ where: { id: tA }, data: { scoresJson: scoresA } });
    c.ok("…and the topic back to direct: the brief writer again", (await routeOf(M.monthId)).route === "brief");
    await prisma.appSetting.update({ where: { key: bw.BRIEF_WRITER_SWITCH }, data: { value: "not json" } });
    c.ok("an unreadable switch: off", (await routeOf(M.monthId)).route !== "brief");
    await prisma.appSetting.update({ where: { key: bw.BRIEF_WRITER_SWITCH }, data: { value: JSON.stringify({ on: true }) } });

    // ==================================================================
    c.head("2 · a draft: his GPT's instructions, his rules, her summary; checked, PASS");
    reset();
    writerQueue = [72];
    checkQueue = ["PASS"];
    const rA = await gen.generateScriptForTopic({ topicId: tA, monthId: M.monthId, requestedBy: owner, unattended: false });
    const [draftCall, checkCall] = calls;
    c.ok("two calls: the writer, then the check, nothing else", calls.length === 2 && draftCall.who === "writer" && checkCall.who === "check" && otherCalls === 0, calls.map((x) => x.who).join());
    const sys = draftCall.system;
    c.ok("its instructions: his GPT's word for word, then his additional rules, which win", sys.includes(`=== YOUR INSTRUCTIONS ===\n${PERSONAL_BRANDING_GENERATOR}\n\n=== JORDAN'S ADDITIONAL RULES (where these differ from the instructions above, these win) ===\n${JORDAN_SCRIPT_RULES}`));
    c.ok("…his rules: 55 to 70 words, nothing invented, her strongest language kept, a memorable close, repetition before personality, the check", /approximately 55 to 70 spoken words, targeting 20 to 30 seconds/.test(JORDAN_SCRIPT_RULES) && /Do not invent professional experience, transaction details, market statistics, or client stories/.test(JORDAN_SCRIPT_RULES) && /Preserve the strongest authentic language/.test(JORDAN_SCRIPT_RULES) && /memorable ending, not an obligatory sales pitch/.test(JORDAN_SCRIPT_RULES) && /remove repetition before removing personality/.test(JORDAN_SCRIPT_RULES) && /independently check structure, word count, source accuracy, and spoken delivery/.test(JORDAN_SCRIPT_RULES) && LENGTH.min === 55 && LENGTH.max === 70);
    c.ok("…and nothing else: no old GPT files, no hub notes, no JSON part fields", !/=== FILE:/.test(sys) && !/HOW THE HUB HANDS YOU THE WORK/.test(sys) && !/ANATOMY OF THE SCRIPT|TEN LAWS|SCRIPTING SUCCESS/i.test(sys) && /in your exact output format from section 3, from "Video 1:" to "Production:"/.test(sys));
    const pr = draftCall.prompt;
    c.ok("the prompt: his five GPT scripts in his own format, as how his scripts read", /^SCRIPTS YOU WROTE THAT JORDAN LOVED \(for Erica Walker\)\. This is how your scripts read/.test(pr) && JORDAN_GPT_SCRIPTS.every((g) => pr.includes(g.hook)) && /\nTALKING POINT 1: REHOOK\n/.test(pr) && (pr.match(/^Video \d: /gm) ?? []).length === 5);
    c.ok("…who she is and the month: her name, this month's priority, the other videos", /THE AGENT: Marcee Writer TEST/.test(pr) && /Their stated priority this month: More listings this spring/.test(pr) && /- Get pre-approved before you tour/.test(pr) && !/- Malvern is underrated/.test(pr));
    c.ok("…the summary, her own words included (his rule 2), what's not established", /THE SUMMARY OF WHAT MARCEE WRITER TEST SAID ABOUT THIS VIDEO:/.test(pr) && /King Street on Saturday mornings sells Malvern/.test(pr) && /In her words: "Malvern is the Main Line without the Main Line price"/.test(pr) && /Not established: No sale price was given/.test(pr));
    c.ok("…and it ends: Write Video 1: <the topic>", /\n\nWrite Video 1: Malvern is underrated\.$/.test(pr));
    c.ok("the check: his GPT again, checking independently, the four checks", checkCall.system.includes(`=== YOUR INSTRUCTIONS ===\n${PERSONAL_BRANDING_GENERATOR}`) && checkCall.system.includes(JORDAN_SCRIPT_RULES) && /1\. STRUCTURE:[\s\S]*2\. WORD COUNT:[\s\S]*3\. SOURCE ACCURACY:[\s\S]*4\. SPOKEN DELIVERY:/.test(checkCall.system) && /independently of whoever wrote it/.test(checkCall.system));
    c.ok("…it reads what the script was written from (not the 'Write' line), the script in his format, the hub's count", checkCall.prompt.startsWith(`WHAT THE SCRIPT WAS WRITTEN FROM:\n${pr.replace(/\n\nWrite Video 1: [^\n]*$/, "")}\n\nTHE SCRIPT TO CHECK:\nVideo 1: Malvern Is Underrated\nCATEGORY: Local Life\nHOOK\n`) && /THE HUB'S COUNT: 72 spoken words \(hook, three talking points and close\)\.\n\nCheck it\.$/.test(checkCall.prompt) && !/tighten it/.test(checkCall.prompt));
    c.ok("the saved script is the 72-word one, read out of his format (markdown and the batch notes ignored)", (await spoken(rA.versionId)) === 72);
    const vA = await versionOf(rA.versionId);
    c.ok("…its parts landed: title, hook, three points, close, and the caption with no dash", vA.title === "Malvern Is Underrated" && vA.hook.startsWith("buyers keep telling me") && (JSON.parse(vA.pointsJson) as unknown[]).length === 3 && !!vA.close && !!vA.captionCta && !/[—–]/.test(vA.captionCta) && /Send me a message/.test(vA.captionCta), `${vA.title} | ${vA.captionCta}`);
    const bag = await bagOf(rA.versionId);
    c.ok("the version carries briefWriter: v4, the summary it read, the check (PASS, 72 to 72, one run, no issues)", bag.briefWriter?.briefId === bA.id && bag.briefWriter?.version === "brief-writer.v4" && bag.briefWriter?.check?.from === 72 && bag.briefWriter?.check?.to === 72 && bag.briefWriter?.check?.verdicts?.join() === "PASS" && bag.briefWriter?.check?.runIds?.length === 1 && bag.briefWriter?.check?.issues?.length === 0, JSON.stringify(bag.briefWriter));
    c.ok("…no judge and no v2 writer record (Jordan reviews the draft)", !("judge" in bag) && !("writer" in bag));
    c.ok("written for review (INTERNAL_REVIEW), from the AI, the topic SCRIPTED", vA.status === "INTERNAL_REVIEW" && vA.source === "AI" && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tA } })).status === "SCRIPTED");
    const runs = await runsOf(M.enrollmentId);
    c.ok("the runs: the draft (script_draft), then the check (script_review, its own cap)", runs.length === 2 && runs[0].promptKey === "script.brief_writer" && runs[0].kind === "script_draft" && runs[1].promptKey === "script.brief_writer.check" && runs[1].kind === "script_review", runs.map((r) => `${r.promptKey}/${r.kind}`).join());
    c.ok("…the version points at the draft's run, and no run still holds a key", vA.aiRunId === runs[0].id && runs.every((r) => r.dedupeKey === null));

    // ==================================================================
    c.head("3 · the office's edited summary; 84 words: the check tightens it");
    reset();
    writerQueue = [84];
    checkQueue = [68];
    const rB = await gen.generateScriptForTopic({ topicId: tB, monthId: M.monthId, requestedBy: owner, unattended: false });
    c.ok("the writer read the office's wording, not the AI's", writerCalls().length === 1 && /EDITED BY KYLE: Marcee wants first-time buyers pre-approved/.test(writerCalls()[0].prompt) && !/Marcee's point on Get pre-approved/.test(writerCalls()[0].prompt));
    c.ok("the check was told: 84, over 75, tighten toward 55 to 70, repetition first", checkCalls().length === 1 && /THE HUB'S COUNT: 84 spoken words \(hook, three talking points and close\)\. That is over 75: tighten it toward 55 to 70, repetition first, personality last\./.test(checkCalls()[0].prompt));
    const bagB = await bagOf(rB.versionId);
    c.ok("its FIXED 68 is saved; one check (68 is not over 80); the issue it named is kept", (await spoken(rB.versionId)) === 68 && bagB.briefWriter?.check?.from === 84 && bagB.briefWriter?.check?.to === 68 && bagB.briefWriter?.check?.verdicts?.join() === "FIXED" && bagB.briefWriter?.check?.issues?.[0] === "Tightened to 68 (drill)" && bagB.briefWriter?.briefEdited === true, JSON.stringify(bagB.briefWriter));

    // ==================================================================
    c.head("4 · a topic the call never covered");
    reset();
    writerQueue = [71];
    let refused: unknown = null;
    try { await gen.generateScriptForTopic({ topicId: tC, monthId: M.monthId, requestedBy: owner, unattended: false }); } catch (e) { refused = e; }
    c.ok("refused: nothing of the agent's to write it from", refused instanceof bw.NothingToWriteFromError && /was not discussed on the call/.test(String((refused as Error).message)), String(refused));
    c.ok("…before any model call, no script, the topic still SELECTED", calls.length === 0 && (await prisma.contentScript.count({ where: { topicId: tC } })) === 0 && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tC } })).status === "SELECTED");

    // ==================================================================
    c.head("5 · the check's edges");
    reset();
    writerQueue = [120];
    checkQueue = [104, 90];
    const rD = await gen.generateScriptForTopic({ topicId: tD, monthId: M.monthId, requestedBy: owner, unattended: false });
    const bagD = await bagOf(rD.versionId);
    c.ok("120 checked to 104, still over 80: a second check, to 90; never a third", checkCalls().length === 2 && (await spoken(rD.versionId)) === 90 && bagD.briefWriter?.check?.from === 120 && bagD.briefWriter?.check?.to === 90 && bagD.briefWriter?.check?.runIds?.length === 2, JSON.stringify(bagD.briefWriter?.check));
    c.ok("…the second check read the 104, and was told it is still long", /THE HUB'S COUNT: 104 spoken words/.test(checkCalls()[1].prompt) && /It was checked once and is still long: bring it inside the range this time\./.test(checkCalls()[1].prompt) && /^Video 1: Malvern Is Underrated\nCATEGORY: Local Life\nHOOK\n/m.test(checkCalls()[1].prompt.split("THE SCRIPT TO CHECK:\n")[1]));
    reset();
    writerQueue = [90];
    checkQueue = [110, "throw"];
    const rE = await gen.generateScriptForTopic({ topicId: tE, monthId: M.monthId, requestedBy: owner, unattended: false });
    c.ok("90 'fixed' to 110 (100 or more, and longer): refused, the 90 stands; the second check failed: the 90 is saved", checkCalls().length === 2 && (await spoken(rE.versionId)) === 90 && (await bagOf(rE.versionId)).briefWriter?.check?.to === 90, String(await spoken(rE.versionId)));
    reset();
    writerQueue = [72];
    checkQueue = [{ raw: "Looks good to me." }];
    const rF = await gen.generateScriptForTopic({ topicId: tF, monthId: M.monthId, requestedBy: owner, unattended: false });
    c.ok("a check that answers with no script: the draft is kept as written", checkCalls().length === 1 && (await spoken(rF.versionId)) === 72 && (await bagOf(rF.versionId)).briefWriter?.check?.to === 72);
    reset();
    writerQueue = [{ raw: "Here is a thought about buyer's agents: they cost less than you think." }];
    let notFormat: unknown = null;
    try { await gen.generateScriptForTopic({ topicId: tG, monthId: M.monthId, requestedBy: owner, unattended: false }); } catch (e) { notFormat = e; }
    c.ok("a writer's answer not in his format: refused with a plain message, no check called", notFormat instanceof bw.ScriptFormatError && /wasn't a script in the usual format/.test(String((notFormat as Error).message)) && checkCalls().length === 0, String(notFormat));
    const gRun = (await runsOf(M.enrollmentId)).filter((r) => r.promptKey === "script.brief_writer").at(-1);
    c.ok("…no script saved, the topic still SELECTED, and its run's key released (it can be drafted again)", (await prisma.contentScript.count({ where: { topicId: tG } })) === 0 && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tG } })).status === "SELECTED" && !!gRun && gRun.dedupeKey === null);
    reset();
    writerQueue = [70];
    checkQueue = ["PASS"];
    const rG = await gen.generateScriptForTopic({ topicId: tG, monthId: M.monthId, requestedBy: owner, unattended: false });
    c.ok("…and drafting it again works", (await spoken(rG.versionId)) === 70);

    // ==================================================================
    c.head("6 · leave one out: never the GPT script written for this topic");
    reset();
    writerQueue = [71];
    checkQueue = ["PASS"];
    await gen.generateScriptForTopic({ topicId: tP, monthId: M.monthId, requestedBy: owner, unattended: false });
    const pP = writerCalls()[0]?.prompt ?? "";
    c.ok("drafting 'Prove your listing price': his GPT's script for it is not shown", !pP.includes(JORDAN_GPT_SCRIPTS[0].hook) && !pP.includes(JORDAN_GPT_SCRIPTS[0].close));
    c.ok("…the other four are", JORDAN_GPT_SCRIPTS.slice(1).every((g) => pP.includes(g.hook)) && (pP.match(/^Video \d: /gm) ?? []).length === 4);

    // ==================================================================
    c.head("7 · a revision of a brief-written script");
    reset();
    writerQueue = [72];
    checkQueue = ["PASS"];
    c.ok("the script is known as brief-written", await bw.briefWrittenScript(rA.scriptId));
    const rev = await gen.reviseScript(rA.scriptId, "Make the hook about the train.", owner, "REVISION", {});
    const revCall = writerCalls()[0];
    c.ok("one call to the same writer, then the check", calls.map((x) => x.who).join() === "writer,check" && revCall.system === draftCall.system);
    c.ok("…the summary, the current script in his format, Jordan's ask, then 'write it again'", /King Street on Saturday mornings sells Malvern/.test(revCall.prompt) && /THE CURRENT SCRIPT:\nVideo 1: Malvern Is Underrated\nCATEGORY: Local Life\nHOOK\n/.test(revCall.prompt) && /JORDAN ASKED FOR THIS CHANGE:\nMake the hook about the train\./.test(revCall.prompt) && /Write it again with that change, in your exact output format\./.test(revCall.prompt) && !/Write Video 1:/.test(revCall.prompt));
    const bagR = await bagOf(rev.versionId);
    c.ok("the revision carries briefWriter (revision, the summary, checked PASS)", bagR.briefWriter?.revision === true && bagR.briefWriter?.briefId === bA.id && bagR.briefWriter?.check?.verdicts?.join() === "PASS", JSON.stringify(bagR.briefWriter));
    const revRuns = (await runsOf(M.enrollmentId)).slice(-2);
    c.ok("…its runs: the brief writer's revise, then a check; keys released", revRuns[0].promptKey === "script.brief_writer.revise" && revRuns[1].promptKey === "script.brief_writer.check" && revRuns.every((r) => r.dedupeKey === null), revRuns.map((r) => r.promptKey).join());
    reset();
    writerQueue = [{ raw: "Sure! The train hook is a great idea." }];
    let badRev: unknown = null;
    try { await gen.reviseScript(rA.scriptId, "Warmer close.", owner, "REVISION", {}); } catch (e) { badRev = e; }
    c.ok("a revision answer not in his format: refused, the current version untouched", badRev instanceof bw.ScriptFormatError && (await prisma.contentScript.findUniqueOrThrow({ where: { id: rA.scriptId } })).currentVersionId === rev.versionId, String(badRev));

    // ==================================================================
    c.head("8 · counting, reading his format, and the words");
    c.ok("a skit: speaker names and stage directions are not spoken", bw.briefSpokenWords({ hook: "Bernadette (in the sheep pen): Every morning starts the same.", points: ["Husband (stepping into frame): You think she does this? Bernadette: Fine."], close: "He handles the farm." }, true) === 5 + 5 + 1 + 4);
    c.ok("…a talking-to-camera script counts every word", bw.briefSpokenWords({ hook: "Here's the truth: pricing matters.", points: [], close: "" }, false) === 5);
    c.ok("Jordan's five GPT scripts are 69 to 73 spoken words each", JORDAN_GPT_SCRIPTS.length === 5 && JORDAN_GPT_SCRIPTS.every((g) => { const n = bw.briefSpokenWords(g, false); return n >= 69 && n <= 73; }), JORDAN_GPT_SCRIPTS.map((g) => bw.briefSpokenWords(g, false)).join());
    const g0 = JORDAN_GPT_SCRIPTS[1];
    const back = P.parseScriptFormat(P.scriptInFormat(g0));
    c.ok("his format round-trips: written out and read back, every part the same", !!back && back.title === g0.title && back.category === g0.category && back.hook === g0.hook && back.points.join("|") === g0.points.join("|") && back.close === g0.close && back.captionCta === g0.captionCta && back.production === null);
    const loose = P.parseScriptFormat("**Video 1:** A Title\n**HOOK:** The hook line.\n**Talking Point 1 (Rehook):** One.\n**TALKING POINT 2: BUILD-UP**\nTwo.\n### TALKING POINT 3: PAYOFF\nThree.\n**CLOSE:**\nThe end.\nCaption CTA: N/A");
    c.ok("…read loosely: parts on their marker's line, markdown, 'N/A' as none", !!loose && loose.hook === "The hook line." && loose.points[1] === "Two." && loose.points[2] === "Three." && loose.close === "The end." && loose.captionCta === null, JSON.stringify(loose));
    c.ok("…no third talking point: not a script (null)", P.parseScriptFormat("Video 1: X\nHOOK\nA.\nTALKING POINT 1: REHOOK\nB.\nTALKING POINT 2: BUILD\nC.\nCLOSE\nD.") === null);
    c.ok("…an em dash in a part comes out", !/[—–]/.test(JSON.stringify(bw.readBriefScript("Video 1: X\nHOOK\nPrice it right — or wait.\nTALKING POINT 1: REHOOK\nB.\nTALKING POINT 2: BUILD\nC.\nTALKING POINT 3: PAYOFF\nD.\nCLOSE\nE.", "X"))));
    c.ok("no em or en dash in his GPT's instructions, his rules, the writer's or the check's words, or his scripts", ![PERSONAL_BRANDING_GENERATOR, JORDAN_SCRIPT_RULES, P.briefWriterSystem(), P.checkerSystem(), P.SKIT_NOTE, JSON.stringify(JORDAN_GPT_SCRIPTS)].some((t) => /[—–]/.test(t)));
    c.ok("nothing left the drill", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    quiet.restore();
    fence.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
