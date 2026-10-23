// ---------------------------------------------------------------------------
// DRILL: the monthly personal-brand scripting engine, Oct 14 2026.
//
// A creative audit of the monthly scripting engine (not listing reels) found
// a self-contradicting prompt, schema budgets that disagreed with the prose,
// re-hooks that recycle the hook, revisions that dropped the client's written
// answers, voice references limited to imports, formulaic topic titles, and
// skits with no fiction rule. Jordan then asked for it to be hands off: "I
// want AI to fix something if it didn't pass judgement."
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct14-creative-engine.ts
//
//    1. the house brief: no "3 to 4", no PILLAR RULE, no pasted GPT text, no
//       listing-only doctrine; the angle, the audience psychology and the
//       section rules are in; no dash used as punctuation in any of it.
//    2. the schema: the angle first and required; budgets agree (16/26/16).
//    3. the checks: 110 ceiling, long hook, re-hook repeats the hook, stock
//       phrases, a skit's real-client claim; the ceiling holds auto-share back.
//    4. topic bank: originality rule, per-pillar counts intact, formulaic
//       titles dropped after generation and logged.
//    5. creative identity: one stubbed call, stored auto-approved (no review
//       step), other override keys kept, full_skits held back on a Direct
//       account, rendered into script / bank prompts, re-derived for a new
//       strategy version by the cron sweep.
//    6. voice references: approved and MANUAL scripts before imports.
//    7. the automatic judge: fails once then passes after an auto-fix;
//       a judge failure still leaves the draft ("not checked"); two rounds at
//       most, the better attempt kept and flagged first in review.
//    8. revisions: a written-answers script is revised FROM the answers; locked
//       sections are byte-identical.
//    9. the call's quotable lines (verbatim only) and the month's priorities
//       reach the script prompt.
//   10. skits: the fiction rule and comedy safeguards; Direct gets none.
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness. Production is never
// opened; every outbound call is fenced and counted; the model is stubbed at
// aiJsonWithUsage.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6993);
const REPO = path.resolve(__dirname, "../..");
const STAFF_EMAIL = "dev@local";

installNextStubs();
const fence = fenceFetch();

const SELLER = "Seller Strategy";
const BUYER = "Buyer Education";
const BRAND = "Personal Brand";

const ANGLE = { viewer: "A move-up seller in Bucks County", belief: "Pricing high leaves room to negotiate", stake: "Weeks on the market and a lower final price", angle: "The first weekend sets the price", clientTake: "Dana watches the first Saturday's showings and adjusts before Monday", payoff: "Price for the first weekend, not the first month" };
const DRAFT = {
  hook: "Most sellers price for the month. Buyers decide in the first weekend.",
  points: ["And a home that sits two weeks starts collecting low offers.", "Dana watches the first Saturday showings, then adjusts before Monday.", "Price for that first weekend, and the buyers compete instead of you."],
  close: "Plan the first weekend, not the first month.",
};
const REVISED = {
  hook: "CHANGED: buyers judge your price before they ever see the kitchen.",
  points: ["CHANGED: two quiet weeks and the low offers start arriving.", "A sharper build up line from the answers.", "A sharper payoff that answers the hook."],
  close: "CHANGED close line that should never survive a lock.",
};
const QUOTE = "the first Saturday tells you everything about your price";
const TRANSCRIPT = `Jordan: What do you want sellers to hear this month?\nDana: Honestly, ${QUOTE}. If nobody books a showing that weekend, the price is wrong.\nJordan: Great, let's film that.`;

// ---- the model boundary ----------------------------------------------------
type JudgeMode = "pass" | "fail" | "fail3" | "throw";
const judgeQueue: JudgeMode[] = [];
const calls: { kind: string; system: string; prompt: string; schema: unknown }[] = [];
const IDENTITY = {
  humorStyle: "playful", comedyComfort: "full_skits", onCameraEnergy: "quick and upbeat", toneWords: ["direct", "warm", "dry", "local"],
  boundaries: [{ text: "Never joke about a client's money trouble", basis: "stated", source: "Core Values" }],
  interests: [{ text: "Coaching youth soccer on Saturdays", basis: "stated", source: "fact" }],
  formatsLiked: [], formatsAvoided: [{ text: "Dancing trends", basis: "inferred", source: "Brand Voice" }], filmingConstraints: [],
};
const usage = { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string; schema: unknown }) => {
        const s = opts.system;
        const kind = /You are the quality judge/.test(s) ? "judge" : /creative identity for ONE real estate agent/.test(s) ? "identity" : /processing a call transcript/.test(s) ? "analysis" : /Video Topic Bank/.test(s) ? "bank" : /writing ONE personal-branding video script/.test(s) ? (/REVIEWER'S INSTRUCTION/.test(opts.prompt) ? "revise" : "script") : "other";
        calls.push({ kind, system: s, prompt: opts.prompt, schema: opts.schema });
        if (kind === "judge") {
          const mode = judgeQueue.shift() ?? "pass";
          if (mode === "throw") throw new Error("judge model unavailable (drill)");
          const keys = ["hook", "rehook", "buildup", "payoff", "close", "voice", "truth", "skit"];
          const failing = mode === "fail" ? ["rehook"] : mode === "fail3" ? ["rehook", "payoff", "voice"] : [];
          return { result: { criteria: keys.map((key) => ({ key, pass: !failing.includes(key), note: failing.includes(key) ? `JUDGE NOTE ${key}: the ${key} does not work yet` : "ok" })), fixInstruction: failing.length ? "Make the re-hook add a consequence the hook did not say." : null }, usage, model: "drill-stub" };
        }
        if (kind === "identity") return { result: IDENTITY, usage, model: "drill-stub" };
        if (kind === "analysis") {
          return { result: {
            callKind: "planning", plannedMonthKey: (/sometime in (\d{4}-\d{2})/.exec(opts.prompt)?.[1]) ?? null,
            selectedTopics: [{ title: "The first Saturday sets your price", concept: "Why the first weekend decides a listing's price", pillar: SELLER, excerpts: [{ speaker: "client", speakerName: "Dana", text: `Honestly, ${QUOTE}.` }], quotableLines: [QUOTE, "A line the client never said about anything at all."] }],
            discussedTopics: [], rejectedIdeas: [], facts: [], strategyProposals: [], priorities: ["Lead with spring seller advice"], todos: [],
          }, usage, model: "drill-stub" };
        }
        if (kind === "bank") {
          const topics = (prefix: string, extra: string[] = []) => [...extra, ...Array.from({ length: 10 - extra.length }, (_, i) => `${prefix} idea number ${i + 1} from the call`)].map((title) => ({ title, description: "One concrete sentence.", audienceNeed: "n", businessGoal: "g", intendedMessage: "m", sourceRef: null }));
          return { result: { complete: true, gaps: [], pillars: [
            { pillarName: SELLER, topics: topics("Seller", ["What Sellers Actually Pay at Closing", "The Doylestown Street Nobody Talks About"]) },
            { pillarName: BUYER, topics: topics("Buyer", ["Why Inspections Matter More Than Price"]) },
            { pillarName: BRAND, topics: topics("Brand", ["What I Do When an Offer Falls Through"]) },
          ] }, usage, model: "drill-stub" };
        }
        if (kind === "script" || kind === "revise") {
          const src = kind === "revise" ? REVISED : DRAFT;
          return { result: {
            angle: ANGLE, title: kind === "revise" ? "Revised draft" : ((/TOPIC:\s*(.+)/.exec(opts.prompt)?.[1] ?? "Drafted topic").trim().slice(0, 90)), category: SELLER,
            hook: src.hook, points: [{ role: "re-hook", text: src.points[0] }, { role: "build-up", text: src.points[1] }, { role: "payoff", text: src.points[2] }], close: src.close,
            captionCta: "DM me PRICE for a pricing plan.", filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [],
          }, usage, model: "drill-stub" };
        }
        throw new Error(`unexpected model call: ${s.slice(0, 80)}`);
      };
    },
  }),
);

async function strategyText(name: string, direction = "Grow the seller side this year."): Promise<string> {
  const { renderStrategy } = await import("@/lib/contentPolicy");
  const doc = {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice, local depth.", brandMessage: "Plan the sale before the sign goes up.", shortBrandStatement: null, brandVoice: "Plain, direct, warm, a little dry.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Bucks County", pricePositioning: null, primaryClientTypes: "Move-up sellers and first-time buyers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Trust, Value, Credibility and Entertainment guide every pillar."], pillars: [
      { number: 1, name: SELLER, heading: `Pillar 1: ${SELLER}`, purpose: "Show sellers how a sale is planned.", focusAreas: "pricing, prep, timing", contentApproach: null, otherFields: [] },
      { number: 2, name: BUYER, heading: `Pillar 2: ${BUYER}`, purpose: "Walk buyers through the process.", focusAreas: "offers, inspections", contentApproach: null, otherFields: [] },
      { number: 3, name: BRAND, heading: `Pillar 3: ${BRAND}`, purpose: "Let people know the agent.", focusAreas: "story, team, community", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PRICE for a pricing plan."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: [direction] }, otherSections: [],
  };
  return renderStrategy(doc as unknown as Parameters<typeof renderStrategy>[0]);
}

const noDash = (s: string) => !/[‒-―]/.test(s);

async function main() {
  const { server, stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const policy = await import("@/lib/contentPolicy");
  const gen = await import("@/lib/contentGeneration");
  const scripts = await import("@/lib/contentScripts");
  const judge = await import("@/lib/scriptJudge");
  const rec = await import("@/lib/scriptJudgeRecord");
  const ident = await import("@/lib/creativeIdentity");
  const ci = await import("@/lib/contentInterview");
  const style = await import("@/lib/programStyle");
  const ct = await import("@/lib/contentTopics");
  const { createStrategyVersion, structuredFromText, approveStrategyVersion } = await import("@/lib/contentStrategy");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const MONTH = etMonthKey(new Date());
  const approveStrategy = async (enrollmentId: string, name: string, direction?: string) => {
    const text = await strategyText(name, direction);
    const { stored } = structuredFromText(text);
    const sv = await createStrategyVersion({ enrollmentId, stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof createStrategyVersion>[0]);
    await approveStrategyVersion(sv.versionId, STAFF_EMAIL);
    return sv.versionId;
  };
  const callsOf = (kind: string) => calls.filter((x) => x.kind === kind);

  try {
    await prisma.appUser.create({ data: { email: STAFF_EMAIL, name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
    await prisma.programAutomation.upsert({ where: { key: "ai_runs" }, create: { key: "ai_runs", enabled: true, enabledBy: "drill", enabledAt: new Date() }, update: { enabled: true } });

    // ======================================================================
    c.head("1 · a clean house brief, the angle first, the psychology, the section rules");
    const D = await buildContentMonth(db, { name: "Engine Direct TEST", package: "Accelerator", monthKey: MONTH, topics: [
      { title: "Pricing for the first weekend", selection: "SELECTED", excerpts: ["Honestly, the first weekend decides the price."] },
      { title: "The inspection report, read calmly", selection: "SELECTED", excerpts: ["Long inspection reports scare people; most items are small."] },
      { title: "A third topic for the max-rounds case", selection: "SELECTED", excerpts: ["Buyers compare every listing on the same street."] },
      { title: "A fourth topic for the keep-the-better case", selection: "SELECTED", excerpts: ["Staging matters less than the first price."] },
    ] });
    const v1Strategy = await approveStrategy(D.enrollmentId, "Engine Direct TEST");
    const builtD = await gen.buildClientContext(D.enrollmentId, { monthId: D.monthId });
    const topicD = { ...policy.makeTopic({ title: "Pricing for the first weekend", pillarName: SELLER, description: "Why the first weekend sets the price.", clientId: builtD.ctx.clientId }), id: D.topicIds[0] };
    const pD = policy.buildScriptPrompt(builtD.ctx, { path: "transcript", topic: topicD, excerpts: [], selectedOnCall: true });
    const sysD = pD.system;
    c.ok("no \"3 to 4\" anywhere in the built script prompt", !/3 to 4/i.test(sysD + pD.user));
    c.ok("no PILLAR RULE, no mandatory Trust and Credibility", !/PILLAR RULE/.test(sysD) && !/must strongly communicate Trust and Credibility/.test(sysD));
    c.ok("no pasted GPT text: no BASE RULES, no SCRIPT FORMAT slots, no topic-extraction duties", !/BASE RULES/.test(sysD) && !/SCRIPT FORMAT/.test(sysD) && !/TOPIC EXTRACTION/.test(sysD) && !/Extract the strongest filmable topics/.test(sysD) && !sysD.includes(policy.SCRIPTING_GPT_INSTRUCTIONS_VERBATIM.slice(0, 80)));
    c.ok("…the constant is kept as a record", policy.SCRIPTING_GPT_INSTRUCTIONS_VERBATIM.startsWith("You are an elite short-form"));
    c.ok("the house scripting rules are in", sysD.includes("=== HOUSE SCRIPTING RULES") && sysD.includes(policy.HOUSE_SCRIPTING_RULES));
    c.ok("…they keep the good parts: strategic, specific, natural on camera, hook standards, no weak intros, the client's voice", ["strategic", "specific to this client", "natural on camera", "HOOK STANDARDS", "No weak intros", "brand voice", "conversational"].every((w) => policy.HOUSE_SCRIPTING_RULES.includes(w)));
    c.ok("…and say it is a personal brand, never listing content", /This is not listing content: never sell a specific property/.test(policy.HOUSE_SCRIPTING_RULES));
    c.ok("no listing-only doctrine in the monthly prompt (stunning, dream home, camera and edit rules)", !/stunning|gorgeous|dream home|Scripting to edit|Agent on camera immediately|WTF/i.test(sysD));
    c.ok("the listing training's shared psychology stays: association, surprise, bold statement, story, why this over that", ["Affluence through association", "Genuine surprise", "Bold statement", "Storytelling", "why someone should choose this over that"].every((w) => sysD.includes(w)));
    c.ok("the angle block, verbatim, before the rules", sysD.includes(policy.ANGLE_BLOCK) && sysD.indexOf(policy.ANGLE_BLOCK) < sysD.indexOf("SECTION RULES:"));
    c.ok("the audience psychology block, with the listing levers translated", sysD.includes(policy.AUDIENCE_PSYCHOLOGY_BLOCK) && ["Expectation vs reality", "The tradeoff", "Identity", "Aspiration or envy", "Present pain", "Trusted advice", "Comparison", "Curiosity", "IDENTIFICATION", "HONEST STAKES", "CREDIBLE SPECIFICITY", "REFRAME AND AGENCY", "never demographics"].every((w) => policy.AUDIENCE_PSYCHOLOGY_BLOCK.includes(w)));
    c.ok("…a re-hook that restates the hook fails; the close is an earned callback", /saying the hook again in other words fails/.test(policy.AUDIENCE_PSYCHOLOGY_BLOCK) && /completes the hook's thought/.test(policy.AUDIENCE_PSYCHOLOGY_BLOCK));
    c.ok("the section rules: hook 6 to 14, re-hook adds something new, payoff answers, close calls back, 110 ceiling", sysD.includes(policy.scriptSectionRules()) && /about 6 to 14 spoken words/.test(sysD) && /must not restate the hook/.test(sysD) && /Never withhold the answer to force a DM/.test(sysD) && /call back to the hook/.test(sysD) && /110 is the ceiling/.test(sysD));
    c.ok("the length rule is today's (30 to 50 seconds, 66 to 110 words), with no new aim", /30 to 50 seconds of natural delivery, about 66 to 110 spoken words/.test(sysD) && !/60 to 90/.test(sysD));
    c.ok("the standing rulings keep LENGTH, TRUTHFULNESS, SPEAKER ATTRIBUTION; the contradicting override is gone", policy.POLICY_OVERRIDES.some((o) => o.startsWith("LENGTH:")) && policy.POLICY_OVERRIDES.some((o) => o.startsWith("TRUTHFULNESS:")) && !policy.POLICY_OVERRIDES.some((o) => /never “3 to 4”|SCRIPT FORMAT above/.test(o)));
    c.ok("the policy version moved (runs are stamped differently)", policy.GENERATION_POLICY_VERSION === "2026-10-14.1");
    const withoutRule = (s: string) => s.split(policy.SCRIPT_PUNCTUATION_RULE).join("");
    c.ok("no em or en dash used as punctuation anywhere in the DIRECT script system prompt", noDash(withoutRule(sysD)), (withoutRule(sysD).match(/.{30}[‒-―].{30}/) ?? [""])[0]);
    c.ok("…nor in the rules text every prompt carries", noDash(withoutRule(policy.policyRulesText())));
    c.ok("…nor in any new block", [policy.HOUSE_SCRIPTING_RULES, policy.ANGLE_BLOCK, policy.AUDIENCE_PSYCHOLOGY_BLOCK, policy.scriptSectionRules(), policy.TOPIC_ORIGINALITY_RULE, policy.SKIT_SCRIPT_BLOCK, policy.CREATIVE_IDENTITY_RULE, ...policy.POLICY_OVERRIDES].every(noDash));
    c.ok("a DIRECT account's prompt carries no skit content", !/VIDEO STYLE: SKITS|ACTED SCENE|THE CLIENT IS ALONE|skit/i.test(sysD + pD.user));
    c.ok("the role line names the monthly content", /personal-branding video script for a Realtour Pilot client's monthly content/.test(sysD));

    // ======================================================================
    c.head("2 · the output schema: the angle first and required; budgets agree");
    const schema = policy.SCRIPT_OUTPUT_SCHEMA as { required: string[]; properties: Record<string, { description?: string; required?: string[]; items?: { properties: { text: { description: string } } } }> };
    c.ok("angle is required and first", schema.required[0] === "angle" && !!schema.properties.angle);
    c.ok("…with all six fields required", JSON.stringify(schema.properties.angle.required) === JSON.stringify(["viewer", "belief", "stake", "angle", "clientTake", "payoff"]));
    const skitCtx = { ...builtD.ctx, videoStyle: "SKITS" as const };
    const pSkit = policy.buildScriptPrompt(skitCtx, { path: "transcript", topic: topicD, excerpts: [], selectedOnCall: true });
    const skitSchema = pSkit.outputSchema as typeof schema;
    c.ok("the skit schema carries the same required angle", skitSchema.required[0] === "angle" && JSON.stringify(skitSchema.properties.angle.required) === JSON.stringify(schema.properties.angle.required));
    const b = policy.SCRIPT_PART_BUDGETS;
    c.ok("budgets 16 / 26 / 16 (sum 110)", b.hookWords === 16 && b.pointWords === 26 && b.closeWords === 16 && b.hookWords + 3 * b.pointWords + b.closeWords === 110);
    c.ok("hook description says 16 at most", (schema.properties.hook.description ?? "").includes(`${b.hookWords} at most`));
    c.ok("each point says 26 spoken words at most", (schema.properties.points.items?.properties.text.description ?? "").includes(`${b.pointWords} spoken words at most`));
    c.ok("close says 16 spoken words at most", (schema.properties.close.description ?? "").includes(`${b.closeWords} spoken words at most`));
    c.ok("no old 12 / 14 / 10 numbers left in the schema", !/\b(12|14|10) spoken words at most/.test(JSON.stringify(policy.SCRIPT_OUTPUT_SCHEMA)) && !/ONE sentence, 12/.test(JSON.stringify(policy.SCRIPT_OUTPUT_SCHEMA)));
    c.ok("the prompt's part budgets say the same numbers", sysD.includes(`hook ≤${b.hookWords}`) && sysD.includes(`each talking point ≤${b.pointWords}`) && sysD.includes(`close ≤${b.closeWords}`));

    // ======================================================================
    c.head("3 · the checks");
    const mk = (j: Partial<typeof DRAFT> & { points?: string[] }, opts: { skit?: boolean } = {}) => {
      const x = { ...DRAFT, ...j };
      return policy.validateNewScript(policy.scriptFromGeneratorOutput({ title: "T", category: SELLER, hook: x.hook, points: x.points.map((text, i) => ({ role: ["re-hook", "build-up", "payoff"][i], text })), close: x.close, gaps: [] }, null, null, opts));
    };
    const codes = (v: ReturnType<typeof mk>) => v.findings.map((f) => f.code);
    const NEW = ["length.over-cap", "hook.long", "rehook.repeats-hook", "style.stock-phrase", "skit.real-client-claim"];
    const clean = mk({});
    c.ok("a clean draft raises none of the new warnings", !codes(clean).some((x) => NEW.includes(x)) && clean.ok, JSON.stringify(codes(clean)));
    const repeat = mk({ hook: "Pricing your home right the first weekend decides everything.", points: ["Pricing your home right decides everything that first weekend.", DRAFT.points[1], DRAFT.points[2]] });
    c.ok("re-hook overlap ≥ 50% → \"re-hook repeats the hook\"", codes(repeat).includes("rehook.repeats-hook") && /re-hook repeats the hook/i.test(repeat.findings.find((f) => f.code === "rehook.repeats-hook")?.message ?? ""));
    const long = mk({ points: DRAFT.points.map((p) => `${p} ${"Every single extra word here keeps going and going and going to push this talking point well past its budget of words".repeat(1)}`) });
    c.ok("over 110 spoken words → length.over-cap (a warning, not a block)", codes(long).includes("length.over-cap") && long.findings.find((f) => f.code === "length.over-cap")?.severity === "warn" && long.estimate.words > 110, `${long.estimate.words} words`);
    const longHook = mk({ hook: "Most sellers in Bucks County price their homes for the whole month when buyers really decide everything in the first weekend." });
    c.ok("a hook over 16 spoken words → hook.long", codes(longHook).includes("hook.long"));
    const stock = mk({ hook: "The pricing mistake nobody talks about costs sellers weeks." });
    c.ok("a stock phrase → style.stock-phrase", codes(stock).includes("style.stock-phrase"));
    c.ok("…\"here's the truth\" and \"let that sink in\" too", codes(mk({ close: "Here's the truth: plan the first weekend." })).includes("style.stock-phrase") && codes(mk({ close: "Let that sink in." })).includes("style.stock-phrase"));
    const skitClaim = { hook: "[Dana at a folding table.]\nREPORTER (off camera): How was the weekend?\nDANA: True story, my client almost priced it wrong.", points: ["REPORTER (off camera): Worried?\nDANA: Not anymore.", "DANA: We watched Saturday's showings.", "DANA: Then we fixed the price."], close: "DANA: Plan the first weekend." };
    c.ok("a skit line claiming a real client event → skit.real-client-claim", codes(mk(skitClaim, { skit: true })).includes("skit.real-client-claim"));
    c.ok("…the same words in a DIRECT script are not judged as a skit", !codes(mk(skitClaim)).includes("skit.real-client-claim"));
    const overVersion = await scripts.createScriptVersion({ enrollmentId: D.enrollmentId, monthId: D.monthId, topicId: null, source: "AI", createdBy: "cron", status: "INTERNAL_REVIEW", parts: { title: "Over the cap", hook: DRAFT.hook, points: DRAFT.points.map((text, i) => ({ role: (["re-hook", "build-up", "payoff"] as const)[i], text })), close: DRAFT.close }, validation: { ok: true, findings: long.findings } });
    const { autoShareEligible } = await import("@/lib/scriptAutoShare");
    const verdict = await autoShareEligible(overVersion.versionId);
    c.ok("over the ceiling holds auto-share back (a person may still approve)", verdict.reasons.includes("over the 110-word ceiling"), verdict.reasons.join(" | "));

    // ======================================================================
    c.head("4 · topic bank: originality, counts intact, formulaic titles dropped");
    c.ok("the shape filter: four banned shapes", [policy.formulaicTitleShape("What Sellers Actually Pay at Closing"), policy.formulaicTitleShape("Why Inspections Matter More Than Price"), policy.formulaicTitleShape("The Doylestown Street Nobody Talks About"), policy.formulaicTitleShape("What I Do When an Offer Falls Through")].every(Boolean));
    c.ok("…and leaves a fresh title alone", !policy.formulaicTitleShape("Three offers by Sunday: the pricing plan") && !policy.formulaicTitleShape("Actually, the roof is fine") && !policy.formulaicTitleShape("What sellers ask on day one"));
    const bankP = policy.buildTopicBankPrompt(builtD.ctx, { pillarEmphasis: { [BUYER]: "LIGHT", [SELLER]: "LEAD" } });
    c.ok("the bank prompt carries the originality rule", bankP.system.includes(policy.TOPIC_ORIGINALITY_RULE) && /angle only this client could take/.test(policy.TOPIC_ORIGINALITY_RULE));
    // Oct 20 2026: every pillar, LIGHT included, gets the full 10.
    c.ok("…and the per-pillar counts and emphasis are intact", /exactly 10 topics under EACH/.test(bankP.system) && /LEAD pillars/.test(bankP.system) && /LIGHT pillars/.test(bankP.system));
    const run4 = await ct.startTopicRefresh({ enrollmentId: D.enrollmentId, kind: "BANK", requestedBy: STAFF_EMAIL });
    const row4 = await prisma.contentTopicRefreshRun.findUnique({ where: { id: run4.runId } });
    const suggs = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: run4.runId }, select: { title: true } });
    c.ok("the bank run succeeded", row4?.status === "SUCCEEDED" && suggs.length > 0, `${row4?.status} ${row4?.changeSummary ?? ""}`);
    c.ok("formulaic titles were dropped, never offered", !suggs.some((s) => policy.formulaicTitleShape(s.title)), suggs.filter((s) => policy.formulaicTitleShape(s.title)).map((s) => s.title).join(" | "));
    c.ok("…and the run says how many", /4 formulaic titles dropped/.test(row4?.changeSummary ?? ""), row4?.changeSummary ?? "");

    // ======================================================================
    c.head("5 · creative identity: one call, stored auto-approved, rendered into prompts");
    await prisma.contentEnrollment.update({ where: { id: D.enrollmentId }, data: { overridesJson: JSON.stringify({ preparationWindowHours: 48 }) } });
    const callsBefore5 = calls.length;
    const d5 = await ident.deriveCreativeIdentity(D.enrollmentId, { requestedBy: STAFF_EMAIL, unattended: false });
    c.ok("one model call, kind creative_identity", calls.length === callsBefore5 + 1 && callsOf("identity").length === 1 && (await prisma.programAiRun.count({ where: { kind: "creative_identity", enrollmentId: D.enrollmentId, status: "SUCCEEDED" } })) === 1);
    const idPrompt = callsOf("identity")[0];
    c.ok("built from the approved strategy: brand voice, message, core values, audience, pillars, direction", ["Brand Voice: Plain, direct, warm", "Brand Message: Plan the sale", "Core Values: Honest advice", "Primary Client Types", `Pillar: ${SELLER}`, "Strategic Direction"].every((w) => idPrompt.prompt.includes(w)) && /DIRECT/.test(idPrompt.prompt));
    c.ok("…never from demographics", /Never infer anything from age, gender/.test(idPrompt.system));
    const bag5 = JSON.parse((await prisma.contentEnrollment.findUnique({ where: { id: D.enrollmentId } }))!.overridesJson ?? "{}");
    const st5 = bag5.creativeIdentity;
    c.ok("stored on overridesJson.creativeIdentity, approved by auto, with the strategy version", d5.ok && st5?.approvedBy === "auto" && !!st5.approvedAt && st5.strategyVersionId === v1Strategy && !!st5.derivedAt);
    c.ok("…no review step: it is approved the moment it is stored", st5?.approvedBy === "auto" && !("reviewState" in (st5 ?? {})) && !("pending" in (st5 ?? {})));
    c.ok("…other override keys kept", bag5.preparationWindowHours === 48);
    c.ok("full_skits is held to light_bits on a Direct account", st5?.comedyComfort === "light_bits" && st5?.humorStyle === "playful");
    c.ok("items keep their basis and source", st5?.boundaries?.[0]?.basis === "stated" && st5?.boundaries?.[0]?.source === "Core Values" && st5?.formatsAvoided?.[0]?.basis === "inferred");
    const built5 = await gen.buildClientContext(D.enrollmentId, { monthId: D.monthId });
    const p5 = policy.buildScriptPrompt(built5.ctx, { path: "transcript", topic: topicD, excerpts: [], selectedOnCall: true });
    c.ok("the script prompt carries the CREATIVE IDENTITY block and its rule", p5.user.includes("CREATIVE IDENTITY") && p5.user.includes(policy.CREATIVE_IDENTITY_RULE) && p5.user.includes("(stated) Never joke about a client's money trouble") && p5.user.includes("(inferred) Dancing trends"));
    c.ok("…the rule: stated are the client's, inferred are suggestions, a boundary wins over a joke", /Stated items are the client's own; inferred items are suggestions, never facts\. Write inside these limits\. A boundary always wins over a joke\./.test(policy.CREATIVE_IDENTITY_RULE));
    c.ok("the topic-bank prompt carries it too", policy.buildTopicBankPrompt(built5.ctx).user.includes("CREATIVE IDENTITY"));
    c.ok("the strategy prompt does not (it is built from the strategy)", !policy.buildStrategyPrompt(built5.ctx).user.includes("CREATIVE IDENTITY"));
    const v2Strategy = await approveStrategy(D.enrollmentId, "Engine Direct TEST", "Grow the seller side and the personal brand this year.");
    c.ok("a new approved strategy version makes the identity stale", v2Strategy !== v1Strategy && (await ident.creativeIdentityStale(D.enrollmentId)));
    const sw = await ident.sweepCreativeIdentities({ max: 3, budgetMs: 60_000, minStartMs: 0 });
    const st5b = policy.creativeIdentityFromOverrides((await prisma.contentEnrollment.findUnique({ where: { id: D.enrollmentId } }))!.overridesJson);
    c.ok("the AI cron's sweep re-derives it from the new version", sw.derived >= 1 && st5b?.strategyVersionId === v2Strategy, JSON.stringify(sw));
    const actionsSrc = fs.readFileSync(path.join(REPO, "src/app/content/actions.ts"), "utf8");
    const approveBody = /export async function approveStrategy\([\s\S]*?\n\}/.exec(actionsSrc)?.[0] ?? "";
    c.ok("the approve action re-derives it after approval (best effort, after the response)", /deriveCreativeIdentity\(/.test(approveBody) && /after\(work\)/.test(approveBody) && approveBody.indexOf("approveStrategyVersion(") < approveBody.indexOf("deriveCreativeIdentity("));
    c.ok("Rebuild is a server action behind requireCreativeLead (owner, office or the creative manager since Oct 21 2026)", /export async function rebuildCreativeIdentityAction[\s\S]{0,120}requireCreativeLead\(\)/.test(actionsSrc));
    const routeSrc = fs.readFileSync(path.join(REPO, "src/app/api/cron/topics/route.ts"), "utf8");
    c.ok("the 15-minute AI cron runs the identity sweep and the script checks", /sweepCreativeIdentities\(/.test(routeSrc) && /sweepScriptChecks\(/.test(routeSrc));
    c.ok("a function runs it for every active enrollment (the live run after deploy)", typeof ident.deriveAllCreativeIdentities === "function");
    const card = fs.readFileSync(path.join(REPO, "src/components/content/CreativeIdentityCard.tsx"), "utf8");
    c.ok("the Strategy tab shows it read-only with Rebuild", /Creative identity/.test(card) && /Rebuild/.test(card) && /rebuildCreativeIdentityAction/.test(card) && /CreativeIdentityCard/.test(fs.readFileSync(path.join(REPO, "src/components/content/StrategyPanel.tsx"), "utf8")));

    // ======================================================================
    c.head("6 · voice references: approved and MANUAL scripts first, then imports");
    const V = await buildContentMonth(db, { name: "Voice Refs TEST", package: "Accelerator", monthKey: MONTH });
    const parts = (title: string) => ({ title, categoryLabel: SELLER, hook: `${title} hook line.`, points: [{ role: "re-hook" as const, text: "A re-hook line." }, { role: "build-up" as const, text: "A build up line." }, { role: "payoff" as const, text: "A payoff line." }], close: "A close line." });
    const approvedV = await scripts.createScriptVersion({ enrollmentId: V.enrollmentId, monthId: V.monthId, source: "AI", createdBy: STAFF_EMAIL, status: "INTERNAL_REVIEW", parts: parts("Approved hub script") });
    await prisma.contentScript.update({ where: { id: approvedV.scriptId }, data: { approvedVersionId: approvedV.versionId, approvedAt: new Date(Date.now() - 60_000) } });
    await scripts.createScriptVersion({ enrollmentId: V.enrollmentId, monthId: V.monthId, source: "MANUAL", createdBy: STAFF_EMAIL, status: "INTERNAL_REVIEW", parts: parts("Uploaded by Jordan") });
    for (const t of ["Import one", "Import two", "Import three"]) await scripts.createScriptVersion({ enrollmentId: V.enrollmentId, monthId: null, source: "IMPORT", createdBy: "import", historical: true, parts: parts(t) });
    const builtV = await gen.buildClientContext(V.enrollmentId);
    const kinds = builtV.inputRefs.voiceKinds as string[];
    c.ok("three references, the approved and the MANUAL one first, though the imports are newer", kinds.length === 3 && [...kinds.slice(0, 2)].sort().join() === "approved,manual" && kinds[2] === "import", JSON.stringify(kinds));
    c.ok("…in the prompt as the client's earlier scripts", (builtV.ctx.priorScripts ?? []).map((s) => s.title).slice(0, 2).sort().join(" | ") === "Approved hub script | Uploaded by Jordan");
    const B5 = await buildContentMonth(db, { name: "No Imports TEST", package: "Starter", monthKey: MONTH });
    const onlyApproved = await scripts.createScriptVersion({ enrollmentId: B5.enrollmentId, monthId: B5.monthId, source: "AI", createdBy: STAFF_EMAIL, status: "INTERNAL_REVIEW", parts: parts("Only approved") });
    await prisma.contentScript.update({ where: { id: onlyApproved.scriptId }, data: { approvedVersionId: onlyApproved.versionId, approvedAt: new Date() } });
    c.ok("a client with no imports now gets a voice reference", ((await gen.buildClientContext(B5.enrollmentId)).ctx.priorScripts ?? []).length === 1);

    // ======================================================================
    c.head("7 · the automatic judge and fix");
    const nCalls = () => ({ script: callsOf("script").length, judge: callsOf("judge").length, revise: callsOf("revise").length });
    // a) fails once, the auto-fix runs, then passes
    judgeQueue.push("fail", "pass");
    const before7 = nCalls();
    const dA = await gen.generateScriptForTopic({ topicId: D.topicIds[0], monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const after7 = nCalls();
    const vsA = await prisma.contentScriptVersion.findMany({ where: { scriptId: dA.scriptId }, orderBy: { versionNo: "asc" } });
    const jA1 = rec.readJudge(vsA[0]?.validationJson), jA2 = rec.readJudge(vsA[1]?.validationJson);
    c.ok("one draft, two judge calls, one automatic revision", after7.script - before7.script === 1 && after7.judge - before7.judge === 2 && after7.revise - before7.revise === 1, JSON.stringify({ before7, after7 }));
    c.ok("v1 kept with the judge's failing note; v2 is the auto-fix", vsA.length === 2 && jA1?.state === "fixing" && jA1.issues.some((i) => /JUDGE NOTE rehook/.test(i)) && jA2?.state === "passed" && jA2.fixRounds === 1, JSON.stringify([jA1?.state, jA2?.state, jA2?.fixRounds]));
    c.ok("the revise prompt carried the judge's notes and the fix", /JUDGE NOTE rehook/.test(callsOf("revise").at(-1)?.prompt ?? "") && /Make the re-hook add a consequence/.test(callsOf("revise").at(-1)?.prompt ?? "") && /never invent a story, number, result or credential/.test(callsOf("revise").at(-1)?.prompt ?? ""));
    c.ok("the auto-fix is the draft's own next version (source AI, same author, current, in review)", vsA[1]?.source === "AI" && vsA[1]?.createdBy === STAFF_EMAIL && vsA[1]?.status === "INTERNAL_REVIEW" && (await prisma.contentScript.findUnique({ where: { id: dA.scriptId } }))?.currentVersionId === vsA[1]?.id);
    c.ok("staff line: \"Auto-fixed 1 time · checked: passed\"", rec.judgeLine(jA2)?.text === "Auto-fixed 1 time · checked: passed", rec.judgeLine(jA2)?.text);
    c.ok("nothing approved or shared by the loop", !(await prisma.contentScript.findUnique({ where: { id: dA.scriptId } }))?.approvedVersionId && vsA.every((v) => v.status === "INTERNAL_REVIEW" && !v.sharedAt));
    c.ok("the angle is stored with the draft (staff only)", rec.readAngle(vsA[0]?.validationJson)?.viewer === ANGLE.viewer && rec.readAngle(vsA[0]?.validationJson)?.angle === ANGLE.angle);
    c.ok("the judge prompt scores the levers and never fails what the sources cannot support", /pulls a real lever/.test(callsOf("judge")[0].system) && /escalates instead of restating/.test(callsOf("judge")[0].system) && /that is a gap, not a failure/.test(callsOf("judge")[0].system));
    c.ok("…a DIRECT script is never scored as a skit", !/^- skit:/m.test(callsOf("judge")[0].system));
    c.ok("the judge is cheap (1200 output tokens) and gated like every run", /maxTokens: 1200/.test(fs.readFileSync(path.join(REPO, "src/lib/scriptJudge.ts"), "utf8")) && (await prisma.programAiRun.count({ where: { kind: "script_judge" } })) >= 2);
    c.ok("judge prompts carry no em or en dash", noDash(callsOf("judge")[0].system));

    // b) the judge itself fails: the draft stands, "not checked"
    judgeQueue.push("throw");
    const dB = await gen.generateScriptForTopic({ topicId: D.topicIds[1], monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const vB = await prisma.contentScriptVersion.findUnique({ where: { id: dB.versionId } });
    c.ok("a failed judge call never blocks a draft: one version, labelled not checked", !!vB && (await prisma.contentScriptVersion.count({ where: { scriptId: dB.scriptId } })) === 1 && rec.readJudge(vB.validationJson)?.state === "not_checked" && /Not checked/.test(rec.judgeLine(rec.readJudge(vB.validationJson))?.text ?? ""));

    // c) still failing: two rounds at most, flagged
    judgeQueue.push("fail", "fail", "fail");
    const b7c = nCalls();
    const dC = await gen.generateScriptForTopic({ topicId: D.topicIds[2], monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const a7c = nCalls();
    const vsC = await prisma.contentScriptVersion.findMany({ where: { scriptId: dC.scriptId }, orderBy: { versionNo: "asc" } });
    // Oct 23 2026 (never a worse version): a round no better than v1 stays in the history; v1 stays current, the rounds counted on it.
    const headC = await prisma.contentScript.findUniqueOrThrow({ where: { id: dC.scriptId } });
    const jC = rec.readJudge(vsC.find((v) => v.id === headC.currentVersionId)?.validationJson);
    c.ok("max 2 rounds: 3 judge calls, 2 revisions, 3 versions", a7c.judge - b7c.judge === 3 && a7c.revise - b7c.revise === 2 && vsC.length === 3, JSON.stringify({ b7c, a7c, versions: vsC.length }));
    c.ok("…the current version is flagged with the remaining issue (v1: the rounds were no better, so they never became current)", headC.currentVersionId === vsC[0].id && jC?.state === "flagged" && jC.fixRounds === 2 && /Still flagged: rehook/.test(rec.judgeLine(jC)?.text ?? "") && vsC.slice(1).every((v) => rec.readJudge(v.validationJson)?.state === "set_aside"), rec.judgeLine(jC)?.text);

    // d) the better attempt is kept
    judgeQueue.push("fail", "fail3", "fail3");
    const dD = await gen.generateScriptForTopic({ topicId: D.topicIds[3], monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const vsD = await prisma.contentScriptVersion.findMany({ where: { scriptId: dD.scriptId }, orderBy: { versionNo: "asc" } });
    const headD = await prisma.contentScript.findUniqueOrThrow({ where: { id: dD.scriptId } });
    const jD = rec.readJudge(vsD.find((v) => v.id === headD.currentVersionId)?.validationJson);
    c.ok("still failing, the EARLIER attempt was better: it stays current, flagged; the worse rounds are in the history, nothing copied", vsD.length === 3 && headD.currentVersionId === vsD[0].id && jD?.state === "flagged" && vsD.slice(1).every((v) => rec.readJudge(v.validationJson)?.state === "set_aside" && rec.readJudge(v.validationJson)?.keptInstead === 1), JSON.stringify({ n: vsD.length, current: vsD.findIndex((v) => v.id === headD.currentVersionId) + 1 }));
    const queueRows = await scripts.scriptsAwaitingReview(D.enrollmentId);
    c.ok("flagged scripts sort first in the review queue", queueRows.length >= 4 && queueRows[0].judgeFlagged && queueRows[1].judgeFlagged && !queueRows.slice(2).some((r) => r.judgeFlagged), JSON.stringify(queueRows.map((r) => r.judgeFlagged)));
    const sweep7 = await judge.sweepScriptChecks({ max: 4, budgetMs: 60_000, minStartMs: 0 });
    c.ok("the cron sweep retries the not-checked draft", sweep7.checked >= 1 && rec.readJudge((await prisma.contentScriptVersion.findUnique({ where: { id: dB.versionId } }))?.validationJson)?.state === "passed", JSON.stringify(sweep7));
    const panel = fs.readFileSync(path.join(REPO, "src/components/content/ScriptsPanel.tsx"), "utf8");
    // Oct 23 2026: the card shows the script, not the machinery. The angle stays for staff, in the closed Writer's notes fold at the bottom; the check line is gone.
    const notesSrc = fs.readFileSync(path.join(REPO, "src/components/content/WriterNotes.tsx"), "utf8");
    c.ok("staff see the writer's angle in the Writer's notes fold (closed, at the bottom), never the check line", !/cur\.check/.test(panel) && /angle=\{cur\.angle/.test(panel) && /ANGLE_LABELS/.test(notesSrc) && /Writer&rsquo;s notes/.test(notesSrc) && /Staff only/.test(panel));
    const portalSrc = ["src/lib/portal.ts", "src/lib/portalHome.ts", "src/lib/portalLibrary.ts"].map((f) => fs.existsSync(path.join(REPO, f)) ? fs.readFileSync(path.join(REPO, f), "utf8") : "").join("\n");
    c.ok("the portal never reads the angle or the judge (validationJson)", !/validationJson|readAngle|readJudge/.test(portalSrc));

    // ======================================================================
    c.head("8 · revisions from the ORIGINAL source; locked sections byte-identical");
    const W = await buildContentMonth(db, { name: "Written Answers TEST", package: "Accelerator", monthKey: MONTH, topics: [{ title: "Pricing for the first weekend", selection: "SELECTED" }] });
    await approveStrategy(W.enrollmentId, "Written Answers TEST");
    const actor = { clientUserId: W.clientUserId };
    const iv = await ci.getOrCreateInterview(W.topicIds[0], W.monthId, actor);
    const CANNED: Record<string, string> = {
      audienceProblem: "Sellers who think the first offer is the floor and wait for a better one that never comes.",
      pointOfView: "The first weekend is the whole negotiation, so price for it and you set the terms.",
      talkingPoints: "First, buyers read days on market as a discount signal. Second, a stale listing invites low offers. Finally, the right price on day one brings competing offers.",
      evidence: "I have seen it every spring in Bucks County.",
      story: "Two houses on the same street, one priced for the weekend and one not.",
      nextAction: "Call me before you book the photographer so we can plan the first weekend.",
    };
    for (let i = 0; i < 20; i++) {
      const s = await ci.interviewState(iv);
      if (s.next.kind === "done") break;
      await ci.answerQuestion(iv, s.nextKey!, { text: CANNED[s.nextKey!] ?? "Buyers compare every listing on the street, so the first price is the one they judge.", kind: "TYPED", actor });
    }
    judgeQueue.push("pass");
    const dW = await gen.generateScriptFromInterview(iv, STAFF_EMAIL);
    const baseW = await prisma.contentScriptVersion.findUnique({ where: { id: dW.versionId } });
    const reviseBefore = callsOf("revise").length;
    const rW = await gen.reviseScript(dW.scriptId, "Make the payoff sharper.", STAFF_EMAIL, "REVISION", { lockSections: ["hook", "rehook", "close"] });
    const revPrompt = callsOf("revise").at(-1)!;
    c.ok("one revision call", callsOf("revise").length === reviseBefore + 1);
    c.ok("the revise prompt carries the client's WRITTEN answers", revPrompt.prompt.includes("CLIENT'S WRITTEN ANSWERS") && revPrompt.prompt.includes(CANNED.pointOfView));
    c.ok("…and not \"SELECTED ON THE CALL: yes\"", !revPrompt.prompt.includes("SELECTED ON THE CALL: yes"));
    c.ok("…it says to change only what was asked, word for word otherwise, and names the locks", /change only what the instruction asks, and keep every other line word for word where possible/.test(revPrompt.prompt) && /KEEP EXACTLY[^\n]*Hook, Re-hook, Close/.test(revPrompt.prompt));
    c.ok("…and it reads the same house brief and creative identity path", revPrompt.system.includes(policy.ANGLE_BLOCK));
    const vW = await prisma.contentScriptVersion.findUnique({ where: { id: rW.versionId } });
    const ptsBase = scripts.pointsFromJson(baseW!.pointsJson), ptsNew = scripts.pointsFromJson(vW!.pointsJson);
    c.ok("locked hook, re-hook and close are byte-identical", vW!.hook === baseW!.hook && ptsNew[0].text === ptsBase[0].text && vW!.close === baseW!.close);
    c.ok("…the unlocked build up and payoff took the revision", ptsNew[1].text === REVISED.points[1] && ptsNew[2].text === REVISED.points[2]);
    c.ok("…regeneratedSections names only what changed", JSON.parse(vW!.regeneratedSections ?? "[]").join() === "points");
    const runW = await prisma.programAiRun.findFirst({ where: { kind: "script_revise", enrollmentId: W.enrollmentId }, orderBy: { createdAt: "desc" } });
    c.ok("the run records the written-answers path and the locks", /"sourcePath":"written-answers"/.test(runW?.inputRefsJson ?? "") && /"lockSections":\["hook","rehook","close"\]/.test(runW?.inputRefsJson ?? ""));
    c.ok("a person's revision is not judged or rewritten by the loop", rec.readJudge(vW!.validationJson) === null && rec.judgeLine(null) === null);
    const nolock = await gen.reviseScript(dW.scriptId, "Tighten it.", STAFF_EMAIL);
    const vN = await prisma.contentScriptVersion.findUnique({ where: { id: nolock.versionId } });
    c.ok("default: nothing locked", vN!.hook === REVISED.hook);
    c.ok("the staff revise UI offers \"Keep exactly\" checkboxes, threaded through the queue", /Keep exactly:/.test(panel) && /type="checkbox"/.test(panel) && /lockSections: asLockSections\(scope\.lockSections\)/.test(fs.readFileSync(path.join(REPO, "src/lib/aiQueue.ts"), "utf8")) && /queueScriptRevisionAction\(scriptId: string, mode: "revise" \| "tighten", instructions = "", lockSections: string\[\] = \[\]\)/.test(actionsSrc));
    const topicRevPrompt = calls.filter((x) => x.kind === "revise" && x.prompt.includes("Pricing for the first weekend") && x.prompt.includes("SELECTED ON THE CALL"))[0];
    c.ok("a call-drafted script still revises from its call excerpts", !!topicRevPrompt && /TOPIC-SPECIFIC EXCERPTS/.test(topicRevPrompt.prompt));

    // ======================================================================
    c.head("8b · (Oct 20 2026, Marcee's Malvern video) one script per video: the written answers never make a second one");
    {
      const M = await buildContentMonth(db, { name: "One Script TEST", package: "Accelerator", monthKey: MONTH, topics: [{ title: "Why this town is underrated", selection: "SELECTED" }] });
      await approveStrategy(M.enrollmentId, "One Script TEST");
      const mActor = { clientUserId: M.clientUserId };
      // The call path drafts the video first (what happened at 2:41:51 PM)…
      judgeQueue.push("pass");
      const fromCall = await gen.generateScriptForTopic({ topicId: M.topicIds[0], monthId: M.monthId, requestedBy: STAFF_EMAIL, unattended: false });
      // …then the client's written answer arrives and the sweep reaches it.
      const mIv = await ci.getOrCreateInterview(M.topicIds[0], M.monthId, mActor);
      for (let i = 0; i < 20; i++) {
        const st = await ci.interviewState(mIv);
        if (st.next.kind === "done") break;
        await ci.answerQuestion(mIv, st.nextKey!, { text: CANNED[st.nextKey!] ?? "The coffee shops and the train station along the main street.", kind: "TYPED", actor: mActor });
      }
      let refused = "";
      try {
        await gen.generateScriptFromInterview(mIv, STAFF_EMAIL, { onlyIfUnscripted: true });
      } catch (e) { refused = (e as Error).name; }
      const count = () => prisma.contentScript.count({ where: { topicId: M.topicIds[0], monthId: M.monthId, historical: false } });
      c.ok("the sweep's written-answer draft stops: the video already has its script (AlreadyDraftedError)", refused === "AlreadyDraftedError" && (await count()) === 1, `${refused || "no error"} · ${await count()} script(s)`);
      judgeQueue.push("pass");
      const asked = await gen.generateScriptFromInterview(mIv, STAFF_EMAIL);
      c.ok("a person's explicit draft from the answers becomes the NEXT VERSION of that script, not a second script", asked.scriptId === fromCall.scriptId && (await count()) === 1, `${asked.scriptId} vs ${fromCall.scriptId} · ${await count()} script(s)`);
    }

    // ======================================================================
    c.head("9 · the call's quotable lines and the month's priorities reach the script");
    const Q = await buildContentMonth(db, { name: "Quotable TEST", package: "Accelerator", monthKey: MONTH });
    await approveStrategy(Q.enrollmentId, "Quotable TEST");
    const an = await gen.analyzeTranscriptText({ enrollmentId: Q.enrollmentId, clientId: Q.clientId, monthId: Q.monthId, monthKey: MONTH, transcript: TRANSCRIPT, callDate: null, videosOwed: 4, requestedBy: STAFF_EMAIL, unattended: false });
    const anSchema = callsOf("analysis").at(-1)?.schema as { properties: { selectedTopics: { items: { properties: Record<string, unknown> } } } } | undefined;
    c.ok("the analysis schema offers quotableLines on a selected topic", !!anSchema?.properties.selectedTopics.items.properties.quotableLines);
    const qTopic = await prisma.contentTopic.findFirst({ where: { enrollmentId: Q.enrollmentId, title: "The first Saturday sets your price" } });
    c.ok("the analysed topic was selected for the month", !!qTopic && an.priorities === 1);
    const lines = await gen.quotableLinesForTopic(qTopic!.id, Q.monthId, Q.clientId);
    c.ok("only the verbatim, client-spoken line was kept", lines.length === 1 && lines[0] === QUOTE, JSON.stringify(lines));
    judgeQueue.push("pass");
    await gen.generateScriptForTopic({ topicId: qTopic!.id, monthId: Q.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const qPrompt = callsOf("script").at(-1)!.prompt;
    c.ok("the script prompt carries CLIENT'S OWN LINES with it", qPrompt.includes("CLIENT'S OWN LINES (use their phrasing where it fits):") && qPrompt.includes(QUOTE) && !qPrompt.includes("never said about anything"));
    c.ok("…and THIS MONTH'S PRIORITIES", qPrompt.includes("THIS MONTH'S PRIORITIES") && qPrompt.includes("Lead with spring seller advice"));

    // ======================================================================
    c.head("10 · skits: the fiction rule, comedy safeguards, no narrator default; Direct gets none");
    const sb = policy.SKIT_SCRIPT_BLOCK;
    c.ok("THIS IS AN ACTED SCENE, never a real client", sb.includes("THIS IS AN ACTED SCENE. Never present it as something that happened to a real client, and never imply a fictional person is a real client."));
    c.ok("never punch down; fair housing; the agent never careless for the laugh", sb.includes("Never make fun of buyers, sellers or anyone in a vulnerable moment (grief, divorce, money trouble, health, estate situations).") && sb.includes("Never touch protected characteristics or anything that conflicts with fair housing.") && sb.includes("the agent can be the straight man, the overprepared one, the self-aware one."));
    c.ok("on-screen text and the client's own voice over a narrator", sb.includes("Prefer on-screen text and the client's own voice over a narrator voiceover.") && !/NARRATOR \(voiceover\)/.test(sb) && !/SAM \(voiceover\)/.test(sb) && !/documentary voiceover/.test(sb));
    c.ok("personality-first allowed; value inside the joke stays the default", /personality-first/.test(sb) && /By default the real estate point still lands/.test(sb));
    const S = await buildContentMonth(db, { name: "Engine Skits TEST", package: "Accelerator", monthKey: MONTH });
    await style.setVideoStyle(S.enrollmentId, "SKITS", STAFF_EMAIL);
    const builtS = await gen.buildClientContext(S.enrollmentId);
    const topicS = { ...policy.makeTopic({ title: "Postgame closing interview", pillarName: BRAND, clientId: builtS.ctx.clientId }), id: "tS" };
    const pS = policy.buildScriptPrompt(builtS.ctx, { path: "transcript", topic: topicS, excerpts: [], selectedOnCall: true });
    c.ok("a SKITS account's prompt carries the skit block and the same psychology", pS.system.includes(sb) && pS.system.includes(policy.AUDIENCE_PSYCHOLOGY_BLOCK));
    c.ok("no dash used as punctuation in the SKITS system prompt", noDash(withoutRule(pS.system)));
    const jS = policy.buildScriptJudgePrompt(builtS.ctx, { path: "transcript", topic: topicS, excerpts: [], selectedOnCall: true }, { body: "x" });
    c.ok("the judge scores a skit as a skit (funny, acted-scene safe, solo)", /^- skit: It is actually funny, safe as an acted scene/m.test(jS.system));
    const q5 = policy.INTERVIEW_QUESTION_PLAN.find((q) => q.id === "story")!;
    c.ok("interview question 5 is neutral about humour", /a contrast, a funny moment, or something we could show/.test(q5.captures) && !/never forced humour/.test(q5.captures) && /a funny moment/.test(q5.template));

    // ======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
    c.ok("no unexpected model call", !calls.some((x) => x.kind === "other"), calls.filter((x) => x.kind === "other").map((x) => x.system.slice(0, 60)).join(" | "));
  } finally {
    quiet.restore();
    c.summary();
    void server;
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
