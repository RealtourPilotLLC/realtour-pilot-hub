// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE BRIEF WRITER (Oct 26 2026). Jordan's own two-step workflow: the
// topic's summary of what the agent said (topicBrief.ts), then ONE script from
// it with his Scripting GPT's standard (briefWriter.ts), near his length:
// "that's not a firm rule; I just want them to be less than 100 words" (his
// GPT scripts, about 70, are the feel; only 100 or more goes back to be cut).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct26-brief-writer.ts --logs <dir>
//
//   1. the switch: off, a pilot list without this client, no month: the other
//      writers; on for this client with a month: the brief writer
//   2. a draft: the summary and Jordan's GPT scripts in the prompt; 110 words
//      goes back once with its count and comes back 71; the version carries
//      briefWriter (summary id, length fit), no judge, no v2 writer record;
//      INTERNAL_REVIEW, the topic SCRIPTED, every run key released
//   3. the office's edited summary is what the writer reads; 95 words is
//      fine as it is (under 100) = no second call
//   4. a topic the call never covered: refused before any model call
//   5. the length pass: two tries at most, the shortest kept; a failed pass
//      keeps the draft
//   6. a revision of a brief-written script: the same writer, the summary,
//      the change asked for; Jordan's GPT scripts never shown for Erica herself
//   7. counting: a skit's speaker names and stage directions are not spoken;
//      no dash in the writer's rules or Jordan's examples
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
/** A script of exactly n spoken words: a hook, three points, the rest in the close. */
const scriptOf = (n: number, title = "Malvern Is Underrated") => {
  const [h, p] = n >= 60 ? [11, 15] : [8, 10];
  return { title, category: "Local Life", hook: `${said(h, 0)}.`, points: [`${said(p, 3)}.`, `${said(p, 7)}.`, `${said(p, 11)}.`], close: `${said(n - h - 3 * p, 2)}.`, captionCta: "Send me a message.", production: null };
};
let writerQueue: (number | "throw")[] = [];
const writerCalls: { system: string; prompt: string }[] = [];
let otherCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiStructuredWithUsage" && k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        if (!/^You are Realtour Pilot's Scripting GPT/.test(opts.system)) { otherCalls++; throw new Error(`unexpected model call: ${opts.system.slice(0, 80)}`); }
        writerCalls.push(opts);
        const next = writerQueue.shift();
        if (next === undefined) throw new Error("the drill queued no answer for this call");
        if (next === "throw") throw new Error("model overloaded (drill)");
        return { result: scriptOf(next), usage, model: "claude-opus-5-5", stopReason: "end_turn" };
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
  const { LENGTH } = await import("@/lib/scriptWriter/briefWriterPrompt");
  const { JORDAN_GPT_SCRIPTS } = await import("@/lib/scriptWriter/houseReference");
  const { createPillar } = await import("@/lib/contentPillars");
  type TopicBrief = import("@/lib/scriptWriter/briefFormat").TopicBrief;
  const versionOf = (id: string) => prisma.contentScriptVersion.findUniqueOrThrow({ where: { id } });
  const bagOf = async (id: string) => JSON.parse((await versionOf(id)).validationJson ?? "{}") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const spoken = async (id: string) => { const v = await versionOf(id); return bw.briefSpokenWords({ hook: v.hook ?? "", points: (JSON.parse(v.pointsJson ?? "[]") as { text: string }[]).map((p) => p.text), close: v.close ?? "" }, false); };
  const owner = "jordan@oct26-bw.test";

  try {
    // ==================================================================
    c.head("0 · the world: Marcee's October, five topics chosen on her call");
    await prisma.appUser.create({ data: { email: owner, name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const M = await buildContentMonth(prisma, {
      name: "Marcee Writer TEST", package: "Pro", project: false, owner: { email: "info+marcee-bw@realtourpilot.com", name: "Marcee Writer TEST" },
      topics: [
        { title: "Malvern is underrated", selection: "SELECTED", source: "call" },
        { title: "Get pre-approved before you tour", selection: "SELECTED", source: "call" },
        { title: "A topic the call skipped", selection: "SELECTED", source: "call" },
        { title: "Why spring listings sit", selection: "SELECTED", source: "call" },
        { title: "The inspection that saved a deal", selection: "SELECTED", source: "call" },
      ],
    });
    const [tA, tB, tC, tD, tE] = M.topicIds;
    const pillar = await createPillar({ enrollmentId: M.enrollmentId, clientId: M.clientId, name: "Local Life", createdBy: owner });
    await prisma.contentTopic.updateMany({ where: { id: { in: M.topicIds } }, data: { pillarId: pillar, approvalState: "APPROVED" } });
    const brief = (topicId: string, title: string, over: Partial<TopicBrief> = {}): TopicBrief => ({
      topicId, title, discussed: true, audience: "Buyers", where: "12:04 to 18:30",
      summary: `Marcee's point on ${title}: King Street on Saturday mornings sells Malvern.`, details: ["King Street on Saturday mornings"], examples: [{ text: "A couple from Center City bought on Woodland Avenue last spring.", kind: "real" }],
      herWords: ["Malvern is the Main Line without the Main Line price"], fromStrategist: [], notEstablished: ["No sale price was given"], overlap: null, ...over,
    });
    const seed = (topicId: string, b: TopicBrief, extra: Record<string, unknown> = {}) => prisma.contentTopicBrief.create({ data: {
      enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, topicId, route: "CALL", briefJson: JSON.stringify(b), createdBy: "drill", ...extra,
    } });
    await seed(null as unknown as string, { opening: "Marcee chose five videos.", mainRequest: null, held: [] } as never, { topicId: null });
    const bA = await seed(tA, brief(tA, "Malvern is underrated"));
    const bB = await seed(tB, brief(tB, "Get pre-approved before you tour"), { editedText: "EDITED BY KYLE: Marcee wants first-time buyers pre-approved with her lender in a day.", editedBy: "Kyle", editedAt: new Date() });
    await seed(tC, brief(tC, "A topic the call skipped", { discussed: false, summary: "Not discussed on the call and no written answers yet.", details: [], examples: [], herWords: [], notEstablished: [] }));
    await seed(tD, brief(tD, "Why spring listings sit"));
    await seed(tE, brief(tE, "The inspection that saved a deal"));
    c.ok("seeded: five chosen topics, a header and five summaries (one edited, one never discussed)", (await prisma.contentTopicBrief.count({ where: { monthId: M.monthId } })) === 6);

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
    await prisma.appSetting.update({ where: { key: bw.BRIEF_WRITER_SWITCH }, data: { value: "not json" } });
    c.ok("an unreadable switch: off", (await routeOf(M.monthId)).route !== "brief");
    await prisma.appSetting.update({ where: { key: bw.BRIEF_WRITER_SWITCH }, data: { value: JSON.stringify({ on: true }) } });

    // ==================================================================
    c.head("2 · a draft: 110 words goes back once with its count, 71 is kept");
    writerQueue = [110, 71];
    const rA = await gen.generateScriptForTopic({ topicId: tA, monthId: M.monthId, requestedBy: owner, unattended: false });
    const [draftCall, fitCall] = writerCalls;
    c.ok("two calls to the writer, both Jordan's Scripting GPT, nothing else", writerCalls.length === 2 && otherCalls === 0, `${writerCalls.length} / ${otherCalls}`);
    c.ok("the draft read the topic's summary (her point, her words, what's not established)", /King Street on Saturday mornings sells Malvern/.test(draftCall.prompt) && /Main Line without the Main Line price/.test(draftCall.prompt) && /Not established: No sale price was given/.test(draftCall.prompt));
    c.ok("…and Jordan's GPT scripts as what good looks like, with their counts", /WHAT GOOD LOOKS LIKE/.test(draftCall.prompt) && draftCall.prompt.includes(JORDAN_GPT_SCRIPTS[1].hook) && /\(7\d spoken words\)/.test(draftCall.prompt));
    c.ok("…and under 100 in the standard, not a set count", /Length: under 100 spoken words/.test(draftCall.system) && /it is not a set count/.test(draftCall.system) && LENGTH.aim === 70 && LENGTH.max === 99);
    c.ok("the second call: its own script back, its count and 'cut it'", /YOUR SCRIPT:\nTitle: [^\n]+\nHOOK:/.test(fitCall.prompt) && /YOUR SCRIPT ABOVE IS 110 spoken words/.test(fitCall.prompt) && /It must be under 100, nearer 70 like Jordan's\. Cut it/.test(fitCall.prompt) && !/Write the script for this topic\.$/.test(fitCall.prompt));
    c.ok("the saved script is the 71-word one", (await spoken(rA.versionId)) === 71, String(await spoken(rA.versionId)));
    const bag = await bagOf(rA.versionId);
    c.ok("the version carries briefWriter: the summary it read and the length pass (110 to 71, one run)", bag.briefWriter?.briefId === bA.id && bag.briefWriter?.version === bw.BRIEF_WRITER_VERSION && bag.briefWriter?.lengthFit?.from === 110 && bag.briefWriter?.lengthFit?.to === 71 && bag.briefWriter?.lengthFit?.runIds?.length === 1, JSON.stringify(bag.briefWriter));
    c.ok("…no review owed and no v2 writer record (Jordan reviews the draft)", !("judge" in bag) && !("writer" in bag));
    const vA = await versionOf(rA.versionId);
    c.ok("written for review (INTERNAL_REVIEW), from the AI, the topic SCRIPTED", vA.status === "INTERNAL_REVIEW" && vA.source === "AI" && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tA } })).status === "SCRIPTED");
    const runs = await prisma.programAiRun.findMany({ where: { enrollmentId: M.enrollmentId }, orderBy: { createdAt: "asc" } });
    c.ok("the runs: the draft, then the length pass, both recorded", runs.length === 2 && runs[0].promptKey === "script.brief_writer" && runs[1].promptKey === "script.brief_writer.fit", runs.map((r) => r.promptKey).join());
    c.ok("…the version points at the draft's run, and no run still holds a key", vA.aiRunId === runs[0].id && runs.every((r) => r.dedupeKey === null));

    // ==================================================================
    c.head("3 · the office's edited summary; 95 words is fine as it is");
    writerCalls.length = 0;
    writerQueue = [95];
    const rB = await gen.generateScriptForTopic({ topicId: tB, monthId: M.monthId, requestedBy: owner, unattended: false });
    c.ok("the writer read the office's wording, not the AI's", writerCalls.length === 1 && /EDITED BY KYLE: Marcee wants first-time buyers pre-approved/.test(writerCalls[0].prompt) && !/Marcee's point on Get pre-approved/.test(writerCalls[0].prompt));
    const bagB = await bagOf(rB.versionId);
    c.ok("95 words the first time: kept, one call, no length pass (under 100)", (await spoken(rB.versionId)) === 95 && bagB.briefWriter?.lengthFit === null && bagB.briefWriter?.briefEdited === true, JSON.stringify(bagB.briefWriter));

    // ==================================================================
    c.head("4 · a topic the call never covered");
    writerCalls.length = 0;
    writerQueue = [71];
    let refused: unknown = null;
    try { await gen.generateScriptForTopic({ topicId: tC, monthId: M.monthId, requestedBy: owner, unattended: false }); } catch (e) { refused = e; }
    c.ok("refused: nothing of the agent's to write it from", refused instanceof bw.NothingToWriteFromError && /was not discussed on the call/.test(String((refused as Error).message)), String(refused));
    c.ok("…before any model call, no script, the topic still SELECTED", writerCalls.length === 0 && (await prisma.contentScript.count({ where: { topicId: tC } })) === 0 && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tC } })).status === "SELECTED");
    writerQueue = [];

    // ==================================================================
    c.head("5 · the length pass: two tries at most, the shortest kept; a failed pass keeps the draft");
    writerCalls.length = 0;
    writerQueue = [120, 112, 104];
    const rD = await gen.generateScriptForTopic({ topicId: tD, monthId: M.monthId, requestedBy: owner, unattended: false });
    const bagD = await bagOf(rD.versionId);
    c.ok("120, then 112, then 104: three calls at most, the 104 kept (the shortest)", writerCalls.length === 3 && (await spoken(rD.versionId)) === 104 && bagD.briefWriter?.lengthFit?.from === 120 && bagD.briefWriter?.lengthFit?.to === 104 && bagD.briefWriter?.lengthFit?.runIds?.length === 2);
    c.ok("…the second pass worked from the shorter script (112), not the first", /YOUR SCRIPT ABOVE IS 112 spoken words/.test(writerCalls[2].prompt));
    writerCalls.length = 0;
    writerQueue = [130, "throw"];
    const rE = await gen.generateScriptForTopic({ topicId: tE, monthId: M.monthId, requestedBy: owner, unattended: false });
    c.ok("130 words: the pass was asked for (two calls)", writerCalls.length === 2 && /YOUR SCRIPT ABOVE IS 130 spoken words/.test(writerCalls[1]?.prompt ?? ""));
    c.ok("…the pass failed: the 130-word draft is saved, not lost (the card shows its length)", (await spoken(rE.versionId)) === 130 && !!(await bagOf(rE.versionId)).briefWriter?.briefId);

    // ==================================================================
    c.head("6 · a revision of a brief-written script");
    writerCalls.length = 0;
    writerQueue = [72];
    c.ok("the script is known as brief-written", await bw.briefWrittenScript(rA.scriptId));
    const rev = await gen.reviseScript(rA.scriptId, "Make the hook about the train.", owner, "REVISION", {});
    const revCall = writerCalls[0];
    c.ok("one call to the same writer: the summary, the current script, Jordan's ask", writerCalls.length === 1 && /King Street on Saturday mornings sells Malvern/.test(revCall.prompt) && /THE CURRENT SCRIPT:\nTitle: /.test(revCall.prompt) && /JORDAN ASKED FOR THIS CHANGE:\nMake the hook about the train\./.test(revCall.prompt));
    const bagR = await bagOf(rev.versionId);
    c.ok("the revision carries briefWriter (revision, the summary, no length pass at 72)", bagR.briefWriter?.revision === true && bagR.briefWriter?.briefId === bA.id && bagR.briefWriter?.lengthFit === null, JSON.stringify(bagR.briefWriter));
    const revRun = await prisma.programAiRun.findFirst({ where: { enrollmentId: M.enrollmentId, promptKey: "script.brief_writer.revise" } });
    c.ok("…its run is the brief writer's revise, key released", !!revRun && revRun.dedupeKey === null);
    await prisma.client.update({ where: { id: M.clientId }, data: { name: "Erica Walker" } });
    writerCalls.length = 0;
    writerQueue = [72];
    await gen.reviseScript(rA.scriptId, "Warmer close.", owner, "REVISION", {});
    c.ok("for Erica Walker herself: Jordan's GPT scripts (her own October videos) are not shown", writerCalls.length === 1 && !/WHAT GOOD LOOKS LIKE/.test(writerCalls[0].prompt) && !writerCalls[0].prompt.includes(JORDAN_GPT_SCRIPTS[1].hook));
    await prisma.client.update({ where: { id: M.clientId }, data: { name: "Marcee Writer TEST" } });

    // ==================================================================
    c.head("7 · counting, and the words");
    c.ok("a skit: speaker names and stage directions are not spoken", bw.briefSpokenWords({ hook: "Bernadette (in the sheep pen): Every morning starts the same.", points: ["Husband (stepping into frame): You think she does this? Bernadette: Fine."], close: "He handles the farm." }, true) === 5 + 5 + 1 + 4, String(bw.briefSpokenWords({ hook: "Bernadette (in the sheep pen): Every morning starts the same.", points: ["Husband (stepping into frame): You think she does this? Bernadette: Fine."], close: "He handles the farm." }, true)));
    c.ok("…a talking-to-camera script counts every word", bw.briefSpokenWords({ hook: "Here's the truth: pricing matters.", points: [], close: "" }, false) === 5);
    c.ok("Jordan's five GPT scripts (the length shown) are 69 to 73 spoken words each", JORDAN_GPT_SCRIPTS.length === 5 && JORDAN_GPT_SCRIPTS.every((g) => { const n = bw.briefSpokenWords(g, false); return n >= 69 && n <= 73; }), JORDAN_GPT_SCRIPTS.map((g) => bw.briefSpokenWords(g, false)).join());
    const { briefWriterSystem } = await import("@/lib/scriptWriter/briefWriterPrompt");
    const rules = briefWriterSystem().slice(briefWriterSystem().indexOf("=== HOW THIS RUNS NOW"));
    c.ok("no em or en dash in the writer's rules or Jordan's examples", !/[—–]/.test(rules) && !/[—–]/.test(JSON.stringify(JORDAN_GPT_SCRIPTS)));
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
