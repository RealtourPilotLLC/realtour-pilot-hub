// ---------------------------------------------------------------------------
// DRILL: video style per account, Direct-to-camera · Skits (Oct 13 2026).
//
// Jordan: "Some clients, like Janice Pigga, Joe Sutow, and Mike Flatley,
// prefer more creative, skit-style videos ... It should still follow the same
// scripting framework, but the scripts should be written differently ... the
// personal branding topics should be a bit funnier ... Direct-to-camera or
// Skits." And: "I don't want the scripts to always include other characters
// ... it creates complications with the production logistics."
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct13-video-style.ts
//
// Oct 14 2026: the script and bank prompts changed for EVERY account (the clean
// house brief, oct14-creative-engine.ts), so sections 2 and 3 now assert that a
// DIRECT account gets no skit content (and keeps its per-pillar counts) rather
// than the BASE prompt byte for byte; the validator comparison still holds.
//
// The OLD prompts.ts and scriptFormat.ts are loaded for real from BASE (the
// commit this change starts from), so "a DIRECT account reads as before" is
// asserted byte for byte, not described.
//
//   1. The setting: missing = DIRECT; the setter round-trips, is ledgered with
//      who changed it, keeps the other keys in the overrides bag; the staff
//      action refuses anything but DIRECT / SKITS.
//   2. The script prompt: a SKITS account's carries the skit block (the same
//      framework labels, the client-alone rule, the made-up house example);
//      a DIRECT account's is the OLD prompt exactly.
//   3. The topic bank prompt: SKITS asks for skit concepts filmable alone;
//      every account gets the personal brand humour rule; pillar emphasis
//      still shapes the count either way.
//   4. Validation: a skit with speaker lines and brackets passes, its word
//      count is the dialogue only, a greeting behind a speaker label is still
//      caught; a direct script validates exactly as the OLD validator did.
//   5. End to end (model stubbed): a SKITS draft is stored as a skit (lines
//      kept, speakers kept, dialogue-only count); a DIRECT draft as before;
//      "Revise" keeps a skit a skit, even an uploaded skit on a DIRECT
//      account; a hand edit of a drafted skit reads back as a skit.
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness. Production is never
// opened; every outbound call is fenced and counted; the model is stubbed at
// aiJsonWithUsage.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";
import { isJudgeCall, passingJudge } from "./_judge";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6985);
const REPO = path.resolve(__dirname, "../..");
const BASE = "c4d1bb1"; // the commit this change starts from
const STAFF_EMAIL = "dev@local"; // the sessionless dev path the staff action runs on

installNextStubs();
const fence = fenceFetch();

// ---- the stubbed skit: dialogue, [directions], an unbracketed SFX cue ------
const SKIT = {
  hook: "[Dana sits alone at a folding table with a microphone.]\n[On-screen text: POSTGAME PRESS CONFERENCE]\nREPORTER (off camera): Your buyers just got their keys. How do you feel?\nDANA: Tired. Proud. Mostly tired.",
  rehook: "REPORTER (off camera): That inspection report was long. Worried?\nDANA: Long reports scare people. They shouldn't.",
  build: "[Slow push in. Dana taps the table like a coach.]\nDANA: You don't fight every play. Ask about the big ones: roof, foundation, systems.\nSFX: a crowd cheering, much too loud",
  payoff: "REPORTER (off camera): Advice for buyers?\nDANA: Read the report for safety and big costs. [Beat.] That's where the deal is won.",
  close: "DANA: Call me before your inspection, not after.\n[Dana closes her eyes at the mic.]\nDANA (eyes closed): Mostly tired.",
};
/** What is SAID, written out by hand: the words the cap counts. */
const SKIT_DIALOGUE = [
  "Your buyers just got their keys. How do you feel?", "Tired. Proud. Mostly tired.",
  "That inspection report was long. Worried?", "Long reports scare people. They shouldn't.",
  "You don't fight every play. Ask about the big ones: roof, foundation, systems.",
  "Advice for buyers?", "Read the report for safety and big costs. That's where the deal is won.",
  "Call me before your inspection, not after.", "Mostly tired.",
];
const DIRECT = {
  hook: "The first weekend decides your price, and most sellers miss it.",
  points: ["Buyers read every week on the market as a signal.", "A stale listing invites the low offers you were hoping to avoid.", "Price it right on day one and the buyers compete for you."],
  close: "Planning to sell this spring? Call me before you pick a price.",
};

// ---- the model boundary ----------------------------------------------------
let aiCalls = 0;
const prompts: { system: string; prompt: string }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        if (isJudgeCall(opts.system)) return passingJudge(); // Oct 14 2026: the automatic judge passes; not counted here
        aiCalls++;
        prompts.push({ system: opts.system, prompt: opts.prompt });
        const usage = { inputTokens: 700, outputTokens: 250 };
        if (!/personal-branding video script/.test(opts.system)) throw new Error(`unexpected model call: ${opts.system.slice(0, 80)}`);
        const base = { category: "Personal Brand", captionCta: null, filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [] };
        if (/VIDEO STYLE: SKITS/.test(opts.system)) {
          return { result: { ...base, title: "The Postgame Closing Interview", hook: SKIT.hook, points: [{ role: "re-hook", text: SKIT.rehook }, { role: "build-up", text: SKIT.build }, { role: "payoff", text: SKIT.payoff }], close: SKIT.close }, usage, model: "drill-stub" };
        }
        return { result: { ...base, title: "Pricing for the first weekend", hook: DIRECT.hook, points: [{ role: "re-hook", text: DIRECT.points[0] }, { role: "build-up", text: DIRECT.points[1] }, { role: "payoff", text: DIRECT.points[2] }], close: DIRECT.close }, usage, model: "drill-stub" };
      };
    },
  }),
);

/** OLD contentPolicy files from BASE, byte for byte, their sibling imports aimed at this tree. */
function writeBaseCopies(): { dir: string; prompts: string; scriptFormat: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oct13-video-style-base-"));
  const point = (src: string) => src.replace(/(["'])\.\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src/lib/contentPolicy", p)}${q}`);
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:src/lib/contentPolicy/${f}`], { cwd: REPO, encoding: "utf8" });
  const out = { dir, prompts: path.join(dir, "prompts.base.ts"), scriptFormat: path.join(dir, "scriptFormat.base.ts") };
  fs.writeFileSync(out.prompts, point(show("prompts.ts")));
  fs.writeFileSync(out.scriptFormat, point(show("scriptFormat.ts")));
  return out;
}

const BRAND = "Personal Brand";
const SELLER = "Seller Strategy";
const BUYER = "Buyer Education";
function strategyDoc(name: string) {
  return {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice.", brandMessage: "Plan before you list.", shortBrandStatement: null, brandVoice: "Plain, warm, a little dry.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Bucks County", pricePositioning: null, primaryClientTypes: "Move-up sellers", longTermPositioningGoal: null, otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: [], pillars: [
      { number: 1, name: SELLER, heading: `Pillar 1: ${SELLER}`, purpose: "Show how a sale is planned.", focusAreas: "pricing, prep", contentApproach: null, otherFields: [] },
      { number: 2, name: BUYER, heading: `Pillar 2: ${BUYER}`, purpose: "Walk buyers through it.", focusAreas: "offers, inspections", contentApproach: null, otherFields: [] },
      { number: 3, name: BRAND, heading: `Pillar 3: ${BRAND}`, purpose: "Let people know the agent.", focusAreas: "story, family, community", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PLAN."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: [] }, otherSections: [],
  };
}

async function main() {
  const { server, stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const policy = await import("@/lib/contentPolicy");
  const style = await import("@/lib/programStyle");
  const gen = await import("@/lib/contentGeneration");
  const scripts = await import("@/lib/contentScripts");
  const { setProgramStyleAction } = await import("@/app/content/[id]/workspaceActions");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const base = writeBaseCopies();
  const oldPrompts = (await import(base.prompts)) as typeof import("@/lib/contentPolicy/prompts");
  const oldFormat = (await import(base.scriptFormat)) as typeof import("@/lib/contentPolicy/scriptFormat");
  const noDash = (s: string) => !/[‒-―]/.test(s);

  try {
    await prisma.appUser.create({ data: { email: STAFF_EMAIL, name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
    const MONTH = etMonthKey(new Date());

    // ======================================================================
    c.head("1 · the setting: default DIRECT, the setter round-trips");
    c.ok("a missing or unknown value reads as DIRECT", policy.videoStyleFromOverrides(null) === "DIRECT" && policy.videoStyleFromOverrides("{}") === "DIRECT" && policy.videoStyleFromOverrides('{"videoStyle":"loud"}') === "DIRECT" && policy.videoStyleFromOverrides("not json") === "DIRECT");
    c.ok("…and SKITS reads as SKITS (any case)", policy.videoStyleFromOverrides('{"videoStyle":"SKITS"}') === "SKITS" && policy.asVideoStyle(" skits ") === "SKITS");
    c.ok("staff labels: Direct-to-camera · Skits", policy.VIDEO_STYLE_LABEL.DIRECT === "Direct-to-camera" && policy.VIDEO_STYLE_LABEL.SKITS === "Skits");
    const S = await buildContentMonth(db, { name: "Skit Drill TEST", package: "Accelerator", monthKey: MONTH, topics: [{ title: "Read the inspection report like a pro", selection: "SELECTED" }, { title: "A second skit topic", selection: "SELECTED" }] });
    const D = await buildContentMonth(db, { name: "Direct Drill TEST", package: "Accelerator", monthKey: MONTH, topics: [{ title: "Pricing for the first weekend", selection: "SELECTED" }, { title: "An uploaded skit's topic", selection: "SELECTED" }] });
    c.ok("a new enrollment is DIRECT", (await style.videoStyleOf(S.enrollmentId)) === "DIRECT" && (await style.videoStyleOf(D.enrollmentId)) === "DIRECT");
    // Another key already in the bag must survive both directions.
    await prisma.contentEnrollment.update({ where: { id: S.enrollmentId }, data: { overridesJson: JSON.stringify({ preparationWindowHours: 48 }) } });
    const r1 = await style.setVideoStyle(S.enrollmentId, "SKITS", "jordan@drill.invalid");
    const bag1 = JSON.parse((await prisma.contentEnrollment.findUnique({ where: { id: S.enrollmentId } }))!.overridesJson ?? "{}");
    c.ok("set SKITS: changed, stored as overridesJson.videoStyle", r1.changed && bag1.videoStyle === "SKITS", JSON.stringify(bag1));
    c.ok("…the other override key kept", bag1.preparationWindowHours === 48);
    c.ok("…videoStyleOf reads SKITS", (await style.videoStyleOf(S.enrollmentId)) === "SKITS");
    const ledger = await prisma.programEnrollmentChange.findMany({ where: { enrollmentId: S.enrollmentId, field: "overrides" } });
    c.ok("…ledgered once, with who changed it, from DIRECT to SKITS", ledger.length === 1 && ledger[0].changedBy === "jordan@drill.invalid" && JSON.parse(ledger[0].fromValue ?? "{}").videoStyle === "DIRECT" && JSON.parse(ledger[0].toValue ?? "{}").videoStyle === "SKITS" && !!ledger[0].appliedAt, JSON.stringify(ledger.map((l) => [l.fromValue, l.toValue, l.changedBy])));
    const r2 = await style.setVideoStyle(S.enrollmentId, "SKITS", "jordan@drill.invalid");
    c.ok("setting SKITS again changes nothing and writes no ledger row", !r2.changed && (await prisma.programEnrollmentChange.count({ where: { enrollmentId: S.enrollmentId, field: "overrides" } })) === 1);
    const r3 = await style.setVideoStyle(S.enrollmentId, "DIRECT", "kyle@drill.invalid");
    const bag3 = JSON.parse((await prisma.contentEnrollment.findUnique({ where: { id: S.enrollmentId } }))!.overridesJson ?? "{}");
    c.ok("set DIRECT: the key is removed (the default), the other key kept", r3.changed && !("videoStyle" in bag3) && bag3.preparationWindowHours === 48, JSON.stringify(bag3));
    const bad = await setProgramStyleAction(S.enrollmentId, { videoStyle: "VLOG" });
    c.ok("the staff action refuses a value other than DIRECT / SKITS", !bad.ok && /Direct-to-camera or Skits/.test(bad.message), bad.message);
    const viaAction = await setProgramStyleAction(S.enrollmentId, { videoStyle: "SKITS" });
    c.ok("the staff action sets Skits and says so", viaAction.ok && /Video style: Skits/.test(viaAction.message) && (await style.videoStyleOf(S.enrollmentId)) === "SKITS", viaAction.message);
    c.ok("…recording the staff member", (await prisma.programEnrollmentChange.findFirst({ where: { enrollmentId: S.enrollmentId, field: "overrides" }, orderBy: { createdAt: "desc" } }))?.changedBy === STAFF_EMAIL);
    const card = fs.readFileSync(path.join(REPO, "src/components/content/ProgramStyleCard.tsx"), "utf8");
    c.ok("Settings › Program style shows a two-option control: Direct-to-camera · Skits", /label: "Direct-to-camera"/.test(card) && /label: "Skits"/.test(card) && /videoStyle: v/.test(card));

    // ======================================================================
    c.head("2 · the script prompt: SKITS carries the skit block, DIRECT is the old prompt");
    const builtS = await gen.buildClientContext(S.enrollmentId, { monthId: S.monthId });
    const builtD = await gen.buildClientContext(D.enrollmentId, { monthId: D.monthId });
    c.ok("the context carries the account's style", builtS.ctx.videoStyle === "SKITS" && builtD.ctx.videoStyle === "DIRECT");
    const topicFor = (ctx: typeof builtS.ctx, title: string) => ({ ...policy.makeTopic({ title, pillarName: BRAND, description: "What to read first in an inspection report.", clientId: ctx.clientId }), id: "t1" });
    const skitPrompt = policy.buildScriptPrompt(builtS.ctx, { path: "transcript", topic: topicFor(builtS.ctx, "Read the inspection report like a pro"), excerpts: [], selectedOnCall: true });
    const directPrompt = policy.buildScriptPrompt(builtD.ctx, { path: "transcript", topic: topicFor(builtD.ctx, "Read the inspection report like a pro"), excerpts: [], selectedOnCall: true });
    c.ok("SKITS: the skit block is in the system prompt", skitPrompt.system.includes(policy.SKIT_SCRIPT_BLOCK));
    c.ok("…it keeps the same framework labels in order", /HOOK, Talking Point 1: Re-hook, Talking Point 2: Build up, Talking Point 3: Payoff, Close \/ Call to action/.test(skitPrompt.system));
    // Oct 22 2026: "THE CLIENT IS ALONE ON CAMERA" became the cast rule (alone by default; one
    // confirmed cast member at most, nobody else). oct22-skits-direct.ts proves the rest of it.
    c.ok("…it states the client-alone rule (the cast rule since Oct 22)", /By default the client is alone on camera/.test(skitPrompt.system) && /Nobody else is written in: never a stranger, an actor/.test(skitPrompt.system) && /at most one of them in a skit/.test(skitPrompt.system) && /Off-camera voices are always fine\./.test(skitPrompt.system));
    c.ok("…speaker labels, bracketed directions, on-screen text, callback, deadpan button", ["speaker label in capitals", "square brackets", "[On-screen text:", "callback", "deadpan final button"].every((s) => skitPrompt.system.includes(s)));
    c.ok("…the value lands inside the joke, never instead of it", /delivered inside the joke, never instead of it/.test(skitPrompt.system));
    c.ok("…the same word cap, dialogue only", /spoken dialogue of the whole script stays within the same cap as every script \(about 70 to 110 words\)/.test(skitPrompt.system) && /PART BUDGETS \(spoken dialogue words; speaker labels and bracketed lines are not counted\)/.test(skitPrompt.system));
    c.ok("…no dashes, no durations, nothing confidential, only facts we have", /no em dash or en dash anywhere, no durations or timings written into the script, nothing confidential, only facts we have/.test(skitPrompt.system));
    c.ok("…the house example is a SOLO press conference with off-camera questions", policy.SKIT_HOUSE_EXAMPLE.includes("REPORTER (off camera):") && /alone at a folding table/.test(policy.SKIT_HOUSE_EXAMPLE) && new Set(policy.skitSpeakerLabels([policy.SKIT_HOUSE_EXAMPLE]).map((l) => l.replace(/\s*\(.*\)$/, ""))).size === 2);
    c.ok("…no real client in it (client-scoped prompts)", !/joe|sutow|janice|pigga|flatley|robber/i.test(policy.SKIT_SCRIPT_BLOCK));
    const exampleSaid = policy.SKIT_HOUSE_EXAMPLE.split("\n").map((l) => /^[A-Z][A-Z ]*(?:\([^)]*\))?:\s+(.*)$/.exec(l)?.[1] ?? "").join(" ");
    const exampleWords = policy.countSpokenWords(exampleSaid);
    c.ok("…its own dialogue respects the house cap", exampleWords >= 50 && exampleWords <= 110, `${exampleWords} words`);
    c.ok("the skit block and the topic rules carry no em or en dash", noDash(policy.SKIT_SCRIPT_BLOCK) && noDash(policy.SKIT_TOPIC_RULE) && noDash(policy.PERSONAL_BRAND_HUMOUR_RULE));
    c.ok("SKITS: the output schema describes a scene", /speaker-labelled dialogue/.test(JSON.stringify(skitPrompt.outputSchema)) && (skitPrompt.outputSchema.required as string[]).join() === (policy.SCRIPT_OUTPUT_SCHEMA.required as string[]).join());
    c.ok("DIRECT: no skit block", !/VIDEO STYLE: SKITS/.test(directPrompt.system) && directPrompt.outputSchema === policy.SCRIPT_OUTPUT_SCHEMA);
    // Oct 14 2026: the script prompt itself changed for every account (oct14-creative-engine.ts), so DIRECT is no
    // longer the BASE prompt byte for byte; what must hold is that a DIRECT account gets no skit content at all.
    const skitWords = /VIDEO STYLE: SKITS|ACTED SCENE|THE CLIENT IS ALONE ON CAMERA|skit/i;
    c.ok("DIRECT: no skit content anywhere in the system or user prompt", !skitWords.test(directPrompt.system) && !skitWords.test(directPrompt.user), (directPrompt.system.match(skitWords) ?? directPrompt.user.match(skitWords) ?? [""])[0]);
    c.ok("DIRECT and SKITS share the house brief, the angle and the audience psychology", [policy.HOUSE_SCRIPTING_RULES, policy.ANGLE_BLOCK, policy.AUDIENCE_PSYCHOLOGY_BLOCK].every((b) => directPrompt.system.includes(b) && skitPrompt.system.includes(b)));

    // ======================================================================
    c.head("3 · the topic bank prompt");
    const withStrategy = (ctx: typeof builtS.ctx) => ({ ...ctx, strategy: { version: "v1", document: strategyDoc(ctx.clientName) as unknown as import("@/lib/contentPolicy").StrategyDocument } });
    const bankS = policy.buildTopicBankPrompt(withStrategy(builtS.ctx));
    const bankD = policy.buildTopicBankPrompt(withStrategy(builtD.ctx));
    c.ok("SKITS: the skit topic rule is in the prompt", bankS.system.includes(policy.SKIT_TOPIC_RULE));
    c.ok("…the title is the premise, the description the real takeaway", /The title is the premise/.test(bankS.system) && /naming the real takeaway/.test(bankS.system) && /Shark Tank Listing Pitch/.test(bankS.system));
    c.ok("…every concept can be filmed by the client alone", /can be filmed by the client alone/.test(bankS.system) && /Never a stranger, an actor or an invented character/.test(bankS.system));
    c.ok("DIRECT: no skit topic rule", !/VIDEO STYLE: SKITS/.test(bankD.system));
    c.ok("the personal brand humour rule is in BOTH", bankS.system.includes(policy.PERSONAL_BRAND_HUMOUR_RULE) && bankD.system.includes(policy.PERSONAL_BRAND_HUMOUR_RULE));
    c.ok("…personality and self-aware humour over earnest résumé statements", /self-aware humour and relatable moments/.test(policy.PERSONAL_BRAND_HUMOUR_RULE) && /earnest résumé statements/.test(policy.PERSONAL_BRAND_HUMOUR_RULE));
    // Oct 14 2026: the bank prompt gained the originality rule for every account; a DIRECT bank still carries no skit rule.
    c.ok("DIRECT: the bank prompt carries the humour and originality rules and no skit rule", bankD.system.includes(policy.PERSONAL_BRAND_HUMOUR_RULE) && bankD.system.includes(policy.TOPIC_ORIGINALITY_RULE) && !bankD.system.includes(policy.SKIT_TOPIC_RULE) && !/VIDEO STYLE: SKITS/.test(bankD.system));
    const emph = { [BUYER]: "LIGHT", [SELLER]: "LEAD" };
    const bankSE = policy.buildTopicBankPrompt(withStrategy(builtS.ctx), { pillarEmphasis: emph });
    // Oct 20 2026: every pillar, LIGHT included, gets the full count; emphasis is still named.
    // Oct 26 2026: a Skits account's pillars hold both formats: the policy count of skit concepts plus 5 talking-to-camera topics.
    c.ok("pillar emphasis still shapes a SKITS bank: 10 skit concepts + 5 to camera per pillar, LEAD and LIGHT named", /exactly 10 skit concepts \(format "SKIT"\) and exactly 5 talking-to-camera topics \(format "DIRECT"\) under EACH/.test(bankSE.system) && /LEAD pillars[^\n]*Seller Strategy/.test(bankSE.system) && /LIGHT pillars[^\n]*Buyer Education/.test(bankSE.system) && bankSE.system.includes(policy.SKIT_TOPIC_RULE));
    const oldBankDE = oldPrompts.buildTopicBankPrompt(withStrategy(builtD.ctx), { pillarEmphasis: emph });
    const countLine = (sys: string) => (/^COUNT:.*$/m.exec(sys) ?? [""])[0] + (/^EMPHASIS:.*$/m.exec(sys) ?? [""])[0];
    const bankDE = policy.buildTopicBankPrompt(withStrategy(builtD.ctx), { pillarEmphasis: emph });
    // Oct 26 2026: the DIRECT count line is unchanged; the SKITS one adds the second format, the emphasis line is shared.
    const emphLine = (sys: string) => (/^EMPHASIS:.*$/m.exec(sys) ?? [""])[0];
    c.ok("…and a DIRECT bank with emphasis keeps its count line, with the same emphasis line as a SKITS one", /^COUNT: exactly 10 topics under EACH/m.test(bankDE.system) && emphLine(bankDE.system) === emphLine(bankSE.system) && countLine(bankDE.system).length > 20 && !bankDE.system.includes(policy.SKIT_TOPIC_RULE), `${countLine(oldBankDE.system).length}`);

    // ======================================================================
    c.head("4 · validation: a skit passes, dialogue only is counted; direct unchanged");
    const skitJson = { title: "The Postgame Closing Interview", category: BRAND, hook: SKIT.hook, points: [{ role: "re-hook", text: SKIT.rehook }, { role: "build-up", text: SKIT.build }, { role: "payoff", text: SKIT.payoff }], close: SKIT.close, gaps: [] };
    const skitScript = policy.scriptFromGeneratorOutput(skitJson, null, null, { skit: true });
    const skitV = policy.validateNewScript(skitScript);
    const dialogueWords = policy.countSpokenWords(SKIT_DIALOGUE.join(" "));
    const allWords = policy.countSpokenWords([SKIT.hook, SKIT.rehook, SKIT.build, SKIT.payoff, SKIT.close].join("\n"));
    c.ok("the speakers are read: DANA, REPORTER (off camera), DANA (eyes closed); SFX is not a speaker", skitScript.internal.speakerLabels.join(" | ") === "REPORTER (off camera) | DANA | DANA (eyes closed)", skitScript.internal.speakerLabels.join(" | "));
    c.ok("a skit with speaker lines and brackets passes validation (no blocking finding)", skitV.ok, JSON.stringify(skitV.findings.filter((f) => f.severity === "block").map((f) => f.code)));
    c.ok(`its word count is the dialogue only (${dialogueWords}, not ${allWords})`, skitV.estimate.words === dialogueWords && allWords > dialogueWords, `${skitV.estimate.words}`);
    c.ok("…under the house cap (110 spoken words)", dialogueWords <= 110, `${dialogueWords}`);
    c.ok("…no timing warning", !skitV.findings.some((f) => f.code === "timing.out-of-range"));
    const unlabelled = policy.scriptFromGeneratorOutput(skitJson, null, null);
    c.ok("the same text without the skit flag carries no speaker labels (DIRECT never gets them)", unlabelled.internal.speakerLabels.length === 0);
    const greeting = policy.validateNewScript(policy.scriptFromGeneratorOutput({ ...skitJson, hook: "[Dana at the mic.]\nDANA: Hey guys, welcome back to the channel." }, null, null, { skit: true }));
    c.ok("a greeting behind a speaker label is still caught", !greeting.ok && greeting.findings.some((f) => f.code === "hook.banned-opener"), JSON.stringify(greeting.findings.map((f) => f.code)));
    const onScreen = policy.scriptFromGeneratorOutput({ ...skitJson, hook: "On-screen text: HE PICKED A REALTOR\nDANA: Tired. Proud. Mostly tired." }, null, null, { skit: true });
    c.ok("an unbracketed 'On-screen text:' line is not spoken", policy.estimateSpokenSeconds(onScreen).breakdown.hook === 4 && policy.isUnspokenCueLine("On-screen time card: THREE DAYS LATER"), `${policy.estimateSpokenSeconds(onScreen).breakdown.hook}`);
    const directJson = { title: "Pricing for the first weekend", category: BRAND, hook: DIRECT.hook, points: DIRECT.points.map((text, i) => ({ role: ["re-hook", "build-up", "payoff"][i], text })), close: DIRECT.close, gaps: [] };
    const newD = policy.validateNewScript(policy.scriptFromGeneratorOutput(directJson, null, null));
    const oldD = oldFormat.validateNewScript(oldFormat.scriptFromGeneratorOutput(directJson as Parameters<typeof oldFormat.scriptFromGeneratorOutput>[0], null, null));
    // Oct 23 2026: the pillar findings' wording changed on purpose (no "map it on import": a label is matched to a
    // confirmed pillar or none, contentPolicy/pillarMatch); their codes, severities and paths are compared, the rest whole.
    const same = (a: { code: string; message: string }[], b: { code: string; message: string }[]) => JSON.stringify(a.map((f) => (f.code.startsWith("pillar.") ? { ...f, message: "" } : f))) === JSON.stringify(b.map((f) => (f.code.startsWith("pillar.") ? { ...f, message: "" } : f)));
    c.ok("a direct script still validates as before (same findings, same estimate)", newD.ok && same(newD.findings, oldD.findings) && JSON.stringify(newD.estimate) === JSON.stringify(oldD.estimate), `${newD.estimate.words} vs ${oldD.estimate.words}`);
    const longDirect = { ...directJson, hook: "Hey guys, the first weekend decides your price." };
    const nl = policy.validateNewScript(policy.scriptFromGeneratorOutput(longDirect, null, null));
    const ol = oldFormat.validateNewScript(oldFormat.scriptFromGeneratorOutput(longDirect as Parameters<typeof oldFormat.scriptFromGeneratorOutput>[0], null, null));
    c.ok("…and a direct greeting is blocked exactly as before", !nl.ok && same(nl.findings, ol.findings));

    // ======================================================================
    c.head("5 · end to end: drafts, revisions, hand edits");
    prompts.length = 0;
    const sDraft = await gen.generateScriptForTopic({ topicId: S.topicIds[0], monthId: S.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const sv = await prisma.contentScriptVersion.findUnique({ where: { id: sDraft.versionId } });
    c.ok("SKITS: the draft prompt carried the skit block", prompts.length === 1 && prompts[0].system.includes(policy.SKIT_SCRIPT_BLOCK));
    const sRun = await prisma.programAiRun.findFirst({ where: { kind: "script_draft", enrollmentId: S.enrollmentId }, orderBy: { createdAt: "desc" } });
    c.ok("…its run is stamped with the skit prompt (script.v5-angle+skits)", sRun?.promptVersion === "script.v5-angle+skits", sRun?.promptVersion ?? "no run");
    c.ok("…the version passes the format check", sDraft.ok, JSON.stringify(JSON.parse(sv?.validationJson ?? "{}").findings?.filter((f: { severity: string }) => f.severity === "block")));
    c.ok("…stored as a skit: speakers kept", JSON.parse(sv?.speakerLabelsJson ?? "[]").join(" | ") === "REPORTER (off camera) | DANA | DANA (eyes closed)", sv?.speakerLabelsJson ?? "none");
    c.ok("…every line kept, one per line", sv?.hook === SKIT.hook && sv?.close === SKIT.close && JSON.parse(sv?.pointsJson ?? "[]")[1]?.text === SKIT.build);
    c.ok(`…spoken word count = dialogue only (${dialogueWords})`, sv?.spokenWordCount === dialogueWords, `${sv?.spokenWordCount}`);
    c.ok("…the body renders the scene in the house labels", /HOOK\n\[Dana sits alone/.test(sv?.body ?? "") && /Talking Point 2: Build up\n\[Slow push in/.test(sv?.body ?? "") && /Close \/ Call to action\nDANA: Call me/.test(sv?.body ?? ""), (sv?.body ?? "").slice(0, 200));
    const edited = await scripts.editScriptFromBody(sDraft.scriptId, (sv?.body ?? "").replace("Advice for buyers?", "Any advice for buyers?"), "kyle@drill.invalid");
    const ev = await prisma.contentScriptVersion.findUnique({ where: { id: edited.versionId } });
    c.ok("a hand edit of the drafted skit reads back as a skit (speakers, lines)", !!ev?.speakerLabelsJson && /Any advice for buyers\?/.test(ev?.pointsJson ?? "") && (ev?.hook ?? "").split("\n").length === 4, `${ev?.speakerLabelsJson} / ${ev?.hook}`);

    const dDraft = await gen.generateScriptForTopic({ topicId: D.topicIds[0], monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const dv = await prisma.contentScriptVersion.findUnique({ where: { id: dDraft.versionId } });
    c.ok("DIRECT: no skit block in the prompt", !/VIDEO STYLE: SKITS/.test(prompts[prompts.length - 1].system));
    c.ok("…the version as before: no speakers, the spoken words of every part", dDraft.ok && !dv?.speakerLabelsJson && dv?.hook === DIRECT.hook && dv?.spokenWordCount === policy.countSpokenWords([DIRECT.hook, ...DIRECT.points, DIRECT.close].join(" ")), `${dv?.spokenWordCount}`);

    prompts.length = 0;
    const rv = await gen.reviseScript(sDraft.scriptId, "Make the close land harder.", STAFF_EMAIL);
    const rvv = await prisma.contentScriptVersion.findUnique({ where: { id: rv.versionId } });
    c.ok("Revise on a SKITS account: the skit block rides along", prompts.length === 1 && prompts[0].system.includes(policy.SKIT_SCRIPT_BLOCK));
    c.ok("…and the new version is still a skit", !!rvv?.speakerLabelsJson && rvv?.spokenWordCount === dialogueWords, `${rvv?.speakerLabelsJson} ${rvv?.spokenWordCount}`);

    // An uploaded skit (speaker labels on the version) on a DIRECT account.
    const up = await scripts.createScriptVersion({
      enrollmentId: D.enrollmentId, monthId: D.monthId, topicId: D.topicIds[1], source: "MANUAL", createdBy: "kyle@drill.invalid", status: "INTERNAL_REVIEW",
      parts: { title: "Uploaded skit", categoryLabel: BRAND, hook: SKIT.hook, points: [{ role: "re-hook", text: SKIT.rehook }, { role: "build-up", text: SKIT.build }, { role: "payoff", text: SKIT.payoff }], close: SKIT.close, speakerLabels: ["REPORTER (off camera)", "DANA", "DANA (eyes closed)"] },
    });
    prompts.length = 0;
    const urv = await gen.reviseScript(up.scriptId, "Tighten the build up.", STAFF_EMAIL);
    const urvv = await prisma.contentScriptVersion.findUnique({ where: { id: urv.versionId } });
    c.ok("Revise an uploaded skit on a DIRECT account: written as a skit", prompts.length === 1 && prompts[0].system.includes(policy.SKIT_SCRIPT_BLOCK) && !!urvv?.speakerLabelsJson);
    c.ok("…the account itself stays DIRECT", (await style.videoStyleOf(D.enrollmentId)) === "DIRECT");
    prompts.length = 0;
    await gen.reviseScript(dDraft.scriptId, "Shorter hook.", STAFF_EMAIL);
    c.ok("Revise a direct script on a DIRECT account: no skit block", prompts.length === 1 && !/VIDEO STYLE: SKITS/.test(prompts[0].system));
    c.ok("model calls: 2 drafts + 3 revisions", aiCalls === 5, `${aiCalls}`);

    // ======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
  } finally {
    try { fs.rmSync(base.dir, { recursive: true, force: true }); } catch { /* a leftover temp dir is harmless */ }
    quiet.restore();
    c.summary();
    void server;
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
