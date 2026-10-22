// ---------------------------------------------------------------------------
// DRILL: talking-to-camera videos and skits, per video (Oct 22 2026).
//
// Jordan: "I want to add the ability to do direct to camera videos and
// skits." Bernadette Rabel's Oct 21 strategy call: her account was set to
// Direct-to-camera, but they agreed on a MIX (2 skits a month, the rest
// talking to camera), with her husband acting in the skits.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct22-skits-direct.ts
//
//   1. The pure rules: account style (Direct, Skits, Mix), video format
//      (Skit, Talking to camera), defaults, the routing rule, the Mix count.
//   2. The setting: Mix with its target, ledgered; refusals; back to Direct.
//   3. A topic's own format overrides the account default, both ways; the
//      one control on its card; other keys in the topic's JSON kept.
//   4. Routing: a SKIT topic on a DIRECT account gets the skit prompt; a
//      DIRECT topic on a SKITS account gets the direct one; a SKIT topic with
//      the new writer ON still takes the skit path (no writer step runs).
//      Both draft paths ask the same routing function.
//   5. Revisions follow the topic's format; the judge follows the version's.
//   6. The cast rule: alone by default; a confirmed cast member allowed, with
//      few, short lines; nobody else; privacy and fair housing kept.
//   7. Mix target counting: "1 of 2 skits picked", never a block.
//   8. The topic bank: a Mix refresh asks for skit concepts beside direct
//      topics, each marked, and an accepted skit idea stays a skit; the
//      Skits section and the labels, office and portal.
//   9. Unformatted topics and older versions read exactly as before.
//  10. Nothing approved or shared changes when a format is switched.
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness. Production is never
// opened; every outbound call is fenced and counted; the model is stubbed at
// aiJsonWithUsage (no Anthropic call is made).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";
import { isJudgeCall, passingJudge, isIdentityCall, plainIdentity } from "./_judge";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6791);
const REPO = path.resolve(__dirname, "../..");
const STAFF_EMAIL = "dev@local"; // the sessionless dev path the staff actions run on

installNextStubs();
const fence = fenceFetch();

const SKIT = {
  hook: "[Dana sits alone at a folding table with a microphone.]\n[On-screen text: POSTGAME PRESS CONFERENCE]\nREPORTER (off camera): Your buyers just got their keys. How do you feel?\nDANA: Tired. Proud. Mostly tired.",
  rehook: "REPORTER (off camera): That inspection report was long. Worried?\nDANA: Long reports scare people. They shouldn't.",
  build: "[Slow push in.]\nDANA: You don't fight every play. Ask about the big ones: roof, foundation, systems.",
  payoff: "REPORTER (off camera): Advice for buyers?\nDANA: Read the report for safety and big costs. That's where the deal is won.",
  close: "DANA: Call me before your inspection, not after.\n[Dana closes her eyes at the mic.]\nDANA (eyes closed): Mostly tired.",
};
const DIRECT = {
  hook: "The first weekend decides your price, and most sellers miss it.",
  points: ["Buyers read every week on the market as a signal.", "A stale listing invites the low offers you were hoping to avoid.", "Price it right on day one and the buyers compete for you."],
  close: "Planning to sell this spring? Call me before you pick a price.",
};

const BUYER = "Buyer Education";
const SELLER = "Seller Strategy";
const BRAND = "Personal Branding";

// ---- the model boundary ----------------------------------------------------
let scriptCalls = 0;
const prompts: { system: string; prompt: string; schema: unknown }[] = [];
const judgePrompts: string[] = [];
const bankPrompts: { system: string; schema: unknown }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string; schema?: unknown }) => {
        if (isJudgeCall(opts.system)) { judgePrompts.push(opts.system); return passingJudge(); }
        if (isIdentityCall(opts.system)) return plainIdentity();
        const usage = { inputTokens: 700, outputTokens: 250 };
        if (/Video Topic Bank/.test(opts.system)) {
          bankPrompts.push({ system: opts.system, schema: opts.schema });
          const mix = /VIDEO STYLE: MIX/.test(opts.system);
          const pillars = [...new Set([...opts.prompt.matchAll(/Pillar \d+: ([^\n]+)/g)].map((m) => m[1].trim()))];
          const words = ["harbor", "maple", "lantern", "orchard", "granite", "meadow", "copper", "willow", "summit", "prairie"];
          const out = pillars.map((p, pi) => ({
            pillarName: p,
            topics: words.map((w, i) => ({
              title: `${p.split(" ")[0]} ${w} plan ${pi * 10 + i}`, description: `A concrete video about ${w}.`, audienceNeed: "Sellers deciding when to list", businessGoal: "Build trust with sellers", intendedMessage: "Plan before you list", sourceRef: null,
              ...(mix ? { format: i < 3 ? "SKIT" : "DIRECT" } : {}),
            })),
          }));
          return { result: { complete: true, pillars: out, gaps: [] }, usage, model: "drill-stub" };
        }
        if (!/personal-branding video script/.test(opts.system)) throw new Error(`unexpected model call: ${opts.system.slice(0, 80)}`);
        scriptCalls++;
        prompts.push({ system: opts.system, prompt: opts.prompt, schema: opts.schema });
        const base = { category: BRAND, captionCta: null, filmingNotes: null, contentPillarCheck: { Trust: "t", Value: "v", Credibility: "c", Entertainment: "e" }, sourceExcerpts: [], gaps: [] };
        if (/VIDEO STYLE: SKITS/.test(opts.system)) {
          return { result: { ...base, title: "The Postgame Closing Interview", hook: SKIT.hook, points: [{ role: "re-hook", text: SKIT.rehook }, { role: "build-up", text: SKIT.build }, { role: "payoff", text: SKIT.payoff }], close: SKIT.close }, usage, model: "drill-stub" };
        }
        return { result: { ...base, title: "Pricing for the first weekend", hook: DIRECT.hook, points: [{ role: "re-hook", text: DIRECT.points[0] }, { role: "build-up", text: DIRECT.points[1] }, { role: "payoff", text: DIRECT.points[2] }], close: DIRECT.close }, usage, model: "drill-stub" };
      };
    },
  }),
);

function strategyDoc(name: string) {
  return {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice.", brandMessage: "Plan before you list.", shortBrandStatement: null, brandVoice: "Plain, warm, a little dry.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Bucks County", pricePositioning: null, primaryClientTypes: "Move-up sellers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Trust, Value, Credibility and Entertainment guide every pillar."], pillars: [
      { number: 1, name: BUYER, heading: `Pillar 1: ${BUYER}`, purpose: "Walk buyers through it.", focusAreas: "offers, inspections", contentApproach: null, otherFields: [] },
      { number: 2, name: SELLER, heading: `Pillar 2: ${SELLER}`, purpose: "Show how a sale is planned.", focusAreas: "pricing, prep", contentApproach: null, otherFields: [] },
      { number: 3, name: BRAND, heading: `Pillar 3: ${BRAND}`, purpose: "Let people know the agent.", focusAreas: "story, family, animals", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PLAN."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["More personal branding."] }, otherSections: [],
  };
}

async function strategyText(name: string): Promise<string> {
  const { renderStrategy } = await import("@/lib/contentPolicy");
  return renderStrategy(strategyDoc(name) as unknown as Parameters<typeof renderStrategy>[0]);
}

async function main() {
  const { server, stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const vf = await import("@/lib/contentPolicy/videoFormat");
  const policy = await import("@/lib/contentPolicy");
  const style = await import("@/lib/programStyle");
  const gen = await import("@/lib/contentGeneration");
  const ct = await import("@/lib/contentTopics");
  const actions = await import("@/app/content/actions");
  const { setProgramStyleAction, setSkitCastAction } = await import("@/app/content/[id]/workspaceActions");
  const { etMonthKey, setOwnerOverride } = await import("@/lib/contentProgram");
  const { createStrategyVersion, structuredFromText, approveStrategyVersion } = await import("@/lib/contentStrategy");
  const { portalTopics } = await import("@/lib/portal");
  const noDash = (s: string) => !/[‒-―]/.test(s);
  const skitWords = /VIDEO STYLE: SKITS|ACTED SCENE|SKIT CAST|cast member|skit/i;

  try {
    const owner = await prisma.appUser.create({ data: { email: STAFF_EMAIL, name: "Jordan Drill", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
    const MONTH = etMonthKey(new Date());

    // ======================================================================
    c.head("1 · the pure rules");
    c.ok("account style: a missing or unknown value is DIRECT; SKITS and MIX read in any case", vf.videoStyleFromOverrides(null) === "DIRECT" && vf.videoStyleFromOverrides('{"videoStyle":"vlog"}') === "DIRECT" && vf.videoStyleFromOverrides('{"videoStyle":" mix "}') === "MIX" && vf.videoStyleFromOverrides({ videoStyle: "skits" }) === "SKITS");
    c.ok("prompts.ts still exports the same style reader (old imports keep working)", policy.videoStyleFromOverrides === vf.videoStyleFromOverrides && policy.asVideoStyle === vf.asVideoStyle);
    c.ok("labels: Direct-to-camera · Skits · Mix, and per video: Skit · Talking to camera", vf.VIDEO_STYLE_LABEL.DIRECT === "Direct-to-camera" && vf.VIDEO_STYLE_LABEL.SKITS === "Skits" && vf.VIDEO_STYLE_LABEL.MIX === "Mix" && vf.VIDEO_FORMAT_LABEL.SKIT === "Skit" && vf.VIDEO_FORMAT_LABEL.DIRECT === "Talking to camera");
    c.ok("a video's format: SKIT (or SKITS) and DIRECT, anything else is none", vf.asVideoFormat("skit") === "SKIT" && vf.asVideoFormat("SKITS") === "SKIT" && vf.asVideoFormat("direct") === "DIRECT" && vf.asVideoFormat("vlog") === null && vf.asVideoFormat(null) === null);
    c.ok("defaults: Skits account → Skit; Direct and Mix → Talking to camera", vf.defaultFormatFor("SKITS") === "SKIT" && vf.defaultFormatFor("DIRECT") === "DIRECT" && vf.defaultFormatFor("MIX") === "DIRECT" && vf.defaultFormatFor(null) === "DIRECT");
    c.ok("a topic's own format overrides the account, both ways", vf.resolvedTopicFormat("SKIT", "DIRECT") === "SKIT" && vf.resolvedTopicFormat("DIRECT", "SKITS") === "DIRECT" && vf.resolvedTopicFormat(null, "SKITS") === "SKIT" && vf.resolvedTopicFormat(null, "DIRECT") === "DIRECT");
    c.ok("a write: the topic wins, else the version revised, else the account", vf.formatForWrite({ topicFormat: "DIRECT", baseFormat: "SKIT", style: "SKITS" }) === "DIRECT" && vf.formatForWrite({ topicFormat: null, baseFormat: "SKIT", style: "DIRECT" }) === "SKIT" && vf.formatForWrite({ style: "SKITS" }) === "SKIT");
    c.ok("routing: a skit always takes the skit path, writer on or off", vf.scriptRoute("SKIT", true) === "skit" && vf.scriptRoute("SKIT", false) === "skit");
    c.ok("routing: talking to camera takes the new writer only when it is on", vf.scriptRoute("DIRECT", true) === "writer" && vf.scriptRoute("DIRECT", false) === "direct");
    const vfSrc = fs.readFileSync(path.join(REPO, "src/lib/contentPolicy/videoFormat.ts"), "utf8");
    c.ok("the routing rule says why in one comment (the new writer has no skit brief yet)", /because the new writer has no skit brief yet/.test(vfSrc));
    c.ok("Mix count: 1 of 2 skits picked; 2 of 2 is met; no target, no line", vf.skitTargetFor(["SKIT", "DIRECT", "DIRECT"], 2)?.line === "1 of 2 skits picked" && vf.skitTargetFor(["SKIT", "SKIT"], 2)?.met === true && vf.skitTargetFor(["SKIT"], null) === null && vf.skitTargetFor([], 1)?.line === "0 of 1 skit picked");

    // ======================================================================
    c.head("2 · the setting: Mix with its target");
    const D = await buildContentMonth(db, { name: "Direct Account Drill TEST", package: "Pro", monthKey: MONTH, topics: [
      { title: "My Animals Run the Morning", selection: "SELECTED" }, { title: "Pricing for the first weekend", selection: "SELECTED" }, { title: "An unformatted legacy topic", selection: "SELECTED" }, { title: "A shared script topic", selection: "SELECTED" },
    ] });
    const S = await buildContentMonth(db, { name: "Comedy Account Drill TEST", package: "Accelerator", monthKey: MONTH, topics: [{ title: "Read the inspection report like a pro", selection: "SELECTED" }, { title: "A talking-to-camera topic on a comedy account", selection: "SELECTED" }] });
    const M = await buildContentMonth(db, { name: "Mix Drill TEST", package: "Pro", monthKey: MONTH, topics: [
      { title: "Real Estate Agents Are Scumbags (Sort Of)", selection: "SELECTED" }, { title: "The spring market in plain words", selection: "SELECTED" }, { title: "Three questions before you list", selection: "SELECTED" },
    ] });
    await prisma.contentEnrollment.update({ where: { id: M.enrollmentId }, data: { overridesJson: JSON.stringify({ preparationWindowHours: 48 }) } });
    const badStyle = await setProgramStyleAction(M.enrollmentId, { videoStyle: "VLOG" });
    c.ok("the staff action refuses a style other than the three", !badStyle.ok && /Direct-to-camera or Skits, or a Mix/.test(badStyle.message), badStyle.message);
    const badTarget = await setProgramStyleAction(M.enrollmentId, { videoStyle: "MIX", skitsPerMonth: 0 });
    c.ok("…and a target that is not 1 to 8", !badTarget.ok && /1 to 8/.test(badTarget.message), badTarget.message);
    const mixR = await setProgramStyleAction(M.enrollmentId, { videoStyle: "MIX", skitsPerMonth: 2 });
    const mBag = JSON.parse((await prisma.contentEnrollment.findUnique({ where: { id: M.enrollmentId } }))!.overridesJson ?? "{}");
    c.ok("Mix, 2 a month: stored as videoStyle MIX + skitsPerMonth 2, the other key kept", mixR.ok && mBag.videoStyle === "MIX" && mBag.skitsPerMonth === 2 && mBag.preparationWindowHours === 48, JSON.stringify(mBag));
    c.ok("…the confirmation says it plainly, no em dash", /Video style: Mix, 2 skits a month/.test(mixR.message) && noDash(mixR.message), mixR.message);
    const mLedger = await prisma.programEnrollmentChange.findFirst({ where: { enrollmentId: M.enrollmentId, field: "overrides" }, orderBy: { createdAt: "desc" } });
    c.ok("…ledgered with who and the target", mLedger?.changedBy === STAFF_EMAIL && JSON.parse(mLedger?.toValue ?? "{}").skitsPerMonth === 2 && /Mix \(2 skits a month\)/.test(mLedger?.reason ?? ""), mLedger?.reason ?? "none");
    c.ok("skitsPerMonthFromOverrides reads 2 on Mix, null elsewhere", vf.skitsPerMonthFromOverrides(mBag) === 2 && vf.skitsPerMonthFromOverrides('{"videoStyle":"SKITS","skitsPerMonth":3}') === null);
    const again = await style.setVideoStyle(M.enrollmentId, "MIX", "kyle@drill.invalid");
    c.ok("setting Mix again with no new number keeps 2 and writes nothing", !again.changed && again.skitsPerMonth === 2);
    await style.setVideoStyle(S.enrollmentId, "SKITS", "jordan@drill.invalid");
    c.ok("the Skits account is set (the Oct 13 setting, unchanged)", (await style.videoStyleOf(S.enrollmentId)) === "SKITS");
    const card = fs.readFileSync(path.join(REPO, "src/components/content/ProgramStyleCard.tsx"), "utf8");
    c.ok("Settings > Program style shows three choices and the skits-a-month box", /label: "Direct-to-camera"/.test(card) && /label: "Skits"/.test(card) && /label: "Mix"/.test(card) && /Skits a month/.test(card) && /videoStyle: v/.test(card));

    // ======================================================================
    c.head("3 · a topic's own format, both ways, with one control");
    const [T0, T1, T2, T3] = D.topicIds;
    const [S0, S1] = S.topicIds;
    // T0 carries an imported scores summary, as 190 live topics do: it must survive.
    await prisma.contentTopic.update({ where: { id: T0 }, data: { scoresJson: JSON.stringify({ summary: "Trust: High · Value: High" }) } });
    const badFmt = await actions.setTopicFormatAction(T0, "VLOG");
    c.ok("the card's control refuses anything but Skit or Talking to camera", !badFmt.ok, badFmt.message);
    const toSkit = await actions.setTopicFormatAction(T0, "SKIT");
    const t0 = await prisma.contentTopic.findUnique({ where: { id: T0 } });
    const t0Bag = JSON.parse(t0?.scoresJson ?? "{}");
    c.ok("SKIT on a DIRECT account: stored on the topic, the scores summary kept", toSkit.ok && t0Bag.videoFormat === "SKIT" && t0Bag.summary === "Trust: High · Value: High", t0?.scoresJson ?? "");
    c.ok("…the answer says what happens next, no em dash", /Now: Skit\. Its script will be written this way\./.test(toSkit.message) && noDash(toSkit.message), toSkit.message);
    const ev = await prisma.contentTopicEvent.findFirst({ where: { topicId: T0, kind: "EDITED" }, orderBy: { createdAt: "desc" } });
    c.ok("…on the topic's history with who did it", ev?.staffUserId === STAFF_EMAIL && /Format: Skit/.test(ev?.note ?? ""), ev?.note ?? "none");
    const toDirect = await actions.setTopicFormatAction(S1, "DIRECT");
    c.ok("DIRECT on a SKITS account: stored on the topic", toDirect.ok && vf.topicFormatOf((await prisma.contentTopic.findUnique({ where: { id: S1 } }))?.scoresJson) === "DIRECT");
    const same = await actions.setTopicFormatAction(S1, "DIRECT");
    c.ok("pressing it to the same value again changes nothing", same.ok && /Already set/.test(same.message));
    const bankD = await ct.topicBankByPillar(D.enrollmentId);
    const rowOf = (b: typeof bankD, id: string) => b.groups.flatMap((g) => g.topics).find((t) => t.id === id);
    c.ok("the bank row carries the topic's own format (T0 SKIT, T2 none)", rowOf(bankD, T0)?.videoFormat === "SKIT" && rowOf(bankD, T2)?.videoFormat === null);
    c.ok("withTopicFormat(null) clears it and keeps the other keys", vf.withTopicFormat(t0?.scoresJson, null) === JSON.stringify({ summary: "Trust: High · Value: High" }) && vf.withTopicFormat(JSON.stringify({ videoFormat: "SKIT" }), null) === null);

    // ======================================================================
    c.head("4 · routing: the topic's format decides the writer, both paths");
    const builtD = await gen.buildClientContext(D.enrollmentId, { monthId: D.monthId });
    const builtS = await gen.buildClientContext(S.enrollmentId, { monthId: S.monthId });
    c.ok("the context carries the account style", builtD.ctx.videoStyle === "DIRECT" && builtS.ctx.videoStyle === "SKITS");
    const r = async (topicId: string, enrollmentId: string, ctx: typeof builtD.ctx) => gen.routeScriptDraft({ topicId, enrollmentId, ctx: { ...ctx } });
    c.ok("SKIT topic on a DIRECT account → the skit path", (await r(T0, D.enrollmentId, builtD.ctx)).route === "skit");
    c.ok("DIRECT topic on a SKITS account → the direct prompt", (await r(S1, S.enrollmentId, builtS.ctx)).route === "direct");
    c.ok("an unformatted topic follows the account (DIRECT → direct, SKITS → skit)", (await r(T2, D.enrollmentId, builtD.ctx)).route === "direct" && (await r(S0, S.enrollmentId, builtS.ctx)).route === "skit");
    await prisma.appSetting.create({ data: { key: "script_writer_v2", value: JSON.stringify({ on: true }) } });
    c.ok("new writer ON: a SKIT topic still takes the skit path", (await r(T0, D.enrollmentId, builtD.ctx)).route === "skit");
    c.ok("new writer ON: a DIRECT topic goes to the new writer", (await r(T1, D.enrollmentId, builtD.ctx)).route === "writer" && (await r(S1, S.enrollmentId, builtS.ctx)).route === "writer");
    const genSrc = fs.readFileSync(path.join(REPO, "src/lib/contentGeneration.ts"), "utf8");
    const topicFn = genSrc.slice(genSrc.indexOf("export async function generateScriptForTopic"), genSrc.indexOf("async function generateWithWriter"));
    const ivFn = genSrc.slice(genSrc.indexOf("export async function generateScriptFromInterview"), genSrc.indexOf("/** Talking point index of each lockable point section. */"));
    c.ok("both draft paths ask the one routing function", /routeScriptDraft\(/.test(topicFn) && /routeScriptDraft\(/.test(ivFn) && !/videoStyle !== "SKITS"/.test(topicFn + ivFn));

    prompts.length = 0; judgePrompts.length = 0;
    const blockedBefore = fence.blocked.length;
    const d0 = await gen.generateScriptForTopic({ topicId: T0, monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const v0 = await prisma.contentScriptVersion.findUnique({ where: { id: d0.versionId } });
    c.ok("drafted with the new writer ON: one model call, the skit prompt, no writer step", scriptCalls === 1 && prompts.length === 1 && prompts[0].system.includes(policy.SKIT_SCRIPT_BLOCK) && fence.blocked.length === blockedBefore, `${prompts.length} prompts, ${fence.blocked.length - blockedBefore} blocked`);
    c.ok("…the skit output schema", /speaker-labelled dialogue/.test(JSON.stringify(prompts[0].schema)));
    const run0 = await prisma.programAiRun.findFirst({ where: { kind: "script_draft", enrollmentId: D.enrollmentId }, orderBy: { createdAt: "desc" } });
    c.ok("…its run is the skit prompt (script.v5-angle+skits), no writer runs", run0?.promptVersion === "script.v5-angle+skits" && (await prisma.programAiRun.count({ where: { enrollmentId: D.enrollmentId, kind: { in: ["script_brief", "script_hooks", "script_retrieval"] } } })) === 0, run0?.promptVersion ?? "none");
    c.ok("…stored as a skit: speakers kept, the version says SKIT", !!v0?.speakerLabelsJson && JSON.parse(v0?.validationJson ?? "{}").videoFormat === "SKIT" && vf.versionFormatOf(v0) === "SKIT");
    c.ok("…judged as a skit (the skit criterion and the cast rule)", judgePrompts.some((j) => /- skit: /.test(j) && /cast member the client confirmed/.test(j)));
    await prisma.appSetting.delete({ where: { key: "script_writer_v2" } });

    prompts.length = 0; judgePrompts.length = 0;
    const s1 = await gen.generateScriptForTopic({ topicId: S1, monthId: S.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const sv1 = await prisma.contentScriptVersion.findUnique({ where: { id: s1.versionId } });
    c.ok("DIRECT topic on a SKITS account: the direct prompt, no skit content at all", prompts.length === 1 && !skitWords.test(prompts[0].system) && !skitWords.test(prompts[0].prompt), (prompts[0]?.system.match(skitWords) ?? [""])[0]);
    c.ok("…the plain output schema", prompts[0].schema === policy.SCRIPT_OUTPUT_SCHEMA || JSON.stringify(prompts[0].schema) === JSON.stringify(policy.SCRIPT_OUTPUT_SCHEMA));
    c.ok("…stored as talking to camera: no speakers, the version says DIRECT", !sv1?.speakerLabelsJson && JSON.parse(sv1?.validationJson ?? "{}").videoFormat === "DIRECT" && sv1?.hook === DIRECT.hook);
    c.ok("…judged as talking to camera (no skit criterion)", judgePrompts.length > 0 && judgePrompts.every((j) => !/- skit: /.test(j)));
    const runS1 = await prisma.programAiRun.findFirst({ where: { kind: "script_draft", enrollmentId: S.enrollmentId }, orderBy: { createdAt: "desc" } });
    c.ok("…its run is the plain prompt version", runS1?.promptVersion === "script.v5-angle", runS1?.promptVersion ?? "none");

    // ======================================================================
    c.head("5 · revisions follow the topic; the judge follows the version");
    prompts.length = 0;
    await gen.reviseScript(s1.scriptId, "Shorter hook.", STAFF_EMAIL);
    c.ok("revising the DIRECT topic's script on a SKITS account: still the direct prompt", prompts.length === 1 && !/VIDEO STYLE: SKITS/.test(prompts[0].system));
    const d1 = await gen.generateScriptForTopic({ topicId: T1, monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const switched = await actions.setTopicFormatAction(T1, "SKIT");
    c.ok("switching a topic that has a script: the script stays as written (said so)", switched.ok && /The script on file stays as written/.test(switched.message), switched.message);
    const d1Before = await prisma.contentScriptVersion.count({ where: { scriptId: d1.scriptId } });
    prompts.length = 0;
    const rv1 = await gen.reviseScript(d1.scriptId, "Make it a skit.", STAFF_EMAIL);
    const rv1v = await prisma.contentScriptVersion.findUnique({ where: { id: rv1.versionId } });
    c.ok("…then a revision is written as a skit (the topic's format wins)", prompts.length === 1 && prompts[0].system.includes(policy.SKIT_SCRIPT_BLOCK) && !!rv1v?.speakerLabelsJson && JSON.parse(rv1v?.validationJson ?? "{}").videoFormat === "SKIT");
    c.ok("…as a NEW version; the earlier one is kept", (await prisma.contentScriptVersion.count({ where: { scriptId: d1.scriptId } })) === d1Before + 1);

    // ======================================================================
    c.head("6 · the cast rule");
    const block = policy.SKIT_SCRIPT_BLOCK;
    c.ok("by default the client is alone on camera", /By default the client is alone on camera/.test(block));
    c.ok("a skit may include a cast member the client confirmed, at most one", /A skit may include a cast member the client confirmed: only the people listed under SKIT CAST below/.test(block) && /at most one of them in a skit/.test(block));
    c.ok("…with few, short lines, easy to say and film; the client stays the lead", /few, short lines that are easy to say and easy to film/.test(block) && /The client stays the lead/.test(block));
    c.ok("…and nobody else is written in", /Nobody else is written in: never a stranger, an actor/.test(block) && /Off-camera voices are always fine/.test(block));
    c.ok("the old 'alone' rule is gone", !/THE CLIENT IS ALONE ON CAMERA/.test(block) && !/build every skit for one person/.test(block));
    c.ok("privacy and fair housing are still guarded", /Never reveal anything private about them/.test(block) && /fair housing/.test(block) && /Never make fun of buyers, sellers or anyone in a vulnerable moment/.test(block));
    // The call: her husband is a voice impressionist, and some voices she named would cross the line.
    c.ok("a cast member's impressions: never a real, named person, never a voice that plays on a protected characteristic", /never as an impression of a real, named person, and never a voice or accent that plays on race, ethnicity, religion, disability/.test(block) && /No concept rests on impersonating a real, named person/.test(policy.SKIT_CONCEPT_RULES));
    c.ok("the skit block and the cast block carry no em or en dash", noDash(block) && noDash(policy.skitCastBlock([])) && noDash(policy.SKIT_TOPIC_RULE) && noDash(policy.mixTopicRule(2)));
    c.ok("no cast confirmed: the prompt says the client is alone", /SKIT CAST: nobody confirmed\. The client is alone on camera; off-camera voices only\./.test(policy.skitCastBlock([])) && prompts[0].system.includes(policy.skitCastBlock([])));
    const noRole = await setSkitCastAction(D.enrollmentId, { add: { role: "  ", name: "Mark" } });
    c.ok("adding someone without saying who they are is refused", !noRole.ok, noRole.message);
    const addCast = await setSkitCastAction(D.enrollmentId, { add: { role: "Her husband", name: "Mark", note: "A voice impressionist. Happy to act in her skits." } });
    const cast = vf.skitCastFromOverrides((await prisma.contentEnrollment.findUnique({ where: { id: D.enrollmentId } }))!.overridesJson);
    c.ok("the office adds a confirmed cast member (stored on the client file, ledgered)", addCast.ok && cast.length === 1 && cast[0].role === "Her husband" && cast[0].name === "Mark" && cast[0].addedBy === STAFF_EMAIL && (addCast.cast?.length ?? 0) === 1, JSON.stringify(cast));
    c.ok("…ledgered as a plain line", /Skit cast: added Her husband \(Mark\)\./.test((await prisma.programEnrollmentChange.findFirst({ where: { enrollmentId: D.enrollmentId, field: "overrides" }, orderBy: { createdAt: "desc" } }))?.reason ?? ""));
    prompts.length = 0;
    const tCast = await gen.generateScriptForTopic({ topicId: T0, monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    c.ok("the skit prompt now lists the cast member, one at most, few short lines", prompts.length === 1 && /SKIT CAST \(confirmed by the client; the only people besides the client who may appear on camera, one at most per skit, with few, short lines\):\n- Her husband \(Mark\): A voice impressionist\. Happy to act in her skits\./.test(prompts[0].system), (prompts[0]?.system.match(/SKIT CAST[^\n]*\n[^\n]*/) ?? [""])[0]);
    void tCast;
    prompts.length = 0;
    await gen.generateScriptForTopic({ topicId: T2, monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    c.ok("a talking-to-camera prompt on the same account names no cast and no skit", prompts.length === 1 && !skitWords.test(prompts[0].system) && !/Her husband|Mark/.test(prompts[0].system));
    const rm = await setSkitCastAction(D.enrollmentId, { removeId: cast[0].id });
    c.ok("taking them off works and is said plainly", rm.ok && (rm.cast?.length ?? 1) === 0 && vf.skitCastFromOverrides((await prisma.contentEnrollment.findUnique({ where: { id: D.enrollmentId } }))!.overridesJson).length === 0, rm.message);
    await setSkitCastAction(D.enrollmentId, { add: { role: "Her husband", name: "Mark", note: "A voice impressionist. Happy to act in her skits." } });

    // ======================================================================
    c.head("7 · Mix target counting: shown, never a block");
    const [M0, M1, M2] = M.topicIds;
    await actions.setTopicFormatAction(M0, "SKIT");
    const pt = await portalTopics({ id: M.enrollmentId, clientId: M.clientId });
    const mFormats = pt.groups.flatMap((g) => g.topics).filter((t) => t.selection?.monthId === M.monthId).map((t) => t.format);
    c.ok("the portal knows the style and target (Mix, 2)", pt.videoStyle === "MIX" && pt.skitsPerMonth === 2);
    c.ok("this month: 1 of 2 skits picked", vf.skitTargetFor(mFormats, pt.skitsPerMonth ?? null)?.line === "1 of 2 skits picked", JSON.stringify(mFormats));
    const pFormat = (id: string) => pt.groups.flatMap((g) => g.topics).find((t) => t.id === id)?.format;
    c.ok("each portal topic carries its format (the skit, and two talking to camera)", pFormat(M0) === "SKIT" && pFormat(M1) === "DIRECT" && pFormat(M2) === "DIRECT");
    const extra = await ct.createTopic({ enrollmentId: M.enrollmentId, title: "One more talking-to-camera topic", source: "staff", approvalState: "APPROVED", actor: { kind: "STAFF", staffUserId: STAFF_EMAIL } });
    const sel = await ct.selectTopicForMonth(extra.id, M.monthId, { source: "staff", actor: { kind: "STAFF", staffUserId: STAFF_EMAIL } });
    c.ok("choosing another talking-to-camera topic while the skit target is short is not blocked", !!sel && (await prisma.contentTopicSelection.count({ where: { monthId: M.monthId, topicId: extra.id } })) === 1);
    const tb = fs.readFileSync(path.join(REPO, "src/components/portal/TopicBank.tsx"), "utf8");
    const tp = fs.readFileSync(path.join(REPO, "src/components/content/TopicsPanel.tsx"), "utf8");
    c.ok("the month shows the count beside the plan, office and portal", /skitTargetFor\(/.test(tb) && /skitLine\.line/.test(tb) && /skitTargetFor\(/.test(tp) && /skitCount\.line/.test(tp));

    // ======================================================================
    c.head("8 · the topic bank: Skits section, labels, Mix refresh");
    // The bank prompts, by account.
    const withStrategy = (ctx: typeof builtD.ctx) => ({ ...ctx, strategy: { version: "v1", document: strategyDoc(ctx.clientName) as unknown as import("@/lib/contentPolicy").StrategyDocument } });
    const builtM = await gen.buildClientContext(M.enrollmentId);
    const pD = policy.buildTopicBankPrompt(withStrategy(builtD.ctx));
    const pS = policy.buildTopicBankPrompt(withStrategy(builtS.ctx));
    const pM = policy.buildTopicBankPrompt(withStrategy(builtM.ctx));
    c.ok("DIRECT bank: no skit concepts, the plain schema", !/VIDEO STYLE: (SKITS|MIX)/.test(pD.system) && pD.outputSchema === policy.TOPIC_BANK_OUTPUT_SCHEMA);
    c.ok("SKITS bank: every topic a skit concept (the Oct 13 rule), with the cast block", pS.system.includes(policy.SKIT_TOPIC_RULE) && /SKIT CAST/.test(pS.system));
    c.ok("MIX bank: skit concepts beside direct topics, reusing the skit concept rules", pM.system.includes(policy.mixTopicRule(2)) && pM.system.includes(policy.SKIT_CONCEPT_RULES) && policy.SKIT_TOPIC_RULE.includes(policy.SKIT_CONCEPT_RULES) && /never fewer than 4 across the bank/.test(pM.system));
    const fmtSchema = JSON.stringify(pM.outputSchema);
    c.ok("…every topic in a Mix bank must say its format (DIRECT or SKIT)", /"format":\{"type":"string","enum":\["DIRECT","SKIT"\]/.test(fmtSchema) && /"required":\["title","description","audienceNeed","businessGoal","intendedMessage","sourceRef","format"\]/.test(fmtSchema));
    // A real Mix refresh, end to end.
    const text = await strategyText("Mix Drill TEST");
    const { stored } = structuredFromText(text);
    const svM = await createStrategyVersion({ enrollmentId: M.enrollmentId, stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof createStrategyVersion>[0]);
    await setOwnerOverride("ENROLLMENT", M.enrollmentId, "STRATEGY", owner.id, "drill");
    await approveStrategyVersion(svM.versionId, STAFF_EMAIL);
    await prisma.programAutomation.upsert({ where: { key: "ai_runs" }, create: { key: "ai_runs", enabled: true, enabledBy: "drill", enabledAt: new Date() }, update: { enabled: true } });
    bankPrompts.length = 0;
    const runM = await ct.startTopicRefresh({ enrollmentId: M.enrollmentId, kind: "REFRESH", requestedBy: STAFF_EMAIL });
    const runRow = await prisma.contentTopicRefreshRun.findUnique({ where: { id: runM.runId } });
    c.ok("the Mix refresh SUCCEEDED with the Mix prompt", runRow?.status === "SUCCEEDED" && bankPrompts.length === 1 && /VIDEO STYLE: MIX/.test(bankPrompts[0].system), `${runRow?.status} ${runRow?.lastError ?? runRow?.changeSummary ?? ""}`);
    const sugg = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: runM.runId }, orderBy: { createdAt: "asc" } });
    const sFormats = await ct.suggestionFormats(sugg);
    const skitSugg = sugg.filter((s) => sFormats.get(s.id) === "SKIT");
    const directSugg = sugg.filter((s) => sFormats.get(s.id) === "DIRECT");
    c.ok("every new idea's format is kept on the run (9 skits, 21 talking to camera)", sugg.length === 30 && skitSugg.length === 9 && directSugg.length === 21, `${sugg.length} / ${skitSugg.length} / ${directSugg.length}`);
    const accSkit = await ct.acceptSuggestion(skitSugg[0].id, STAFF_EMAIL);
    const accDirect = await ct.acceptSuggestion(directSugg[0].id, STAFF_EMAIL, { edits: { title: "An edited direct idea title" } });
    c.ok("an accepted skit idea becomes a SKIT topic", vf.topicFormatOf((await prisma.contentTopic.findUnique({ where: { id: accSkit.topicId } }))?.scoresJson) === "SKIT");
    c.ok("an accepted (edited) direct idea becomes a DIRECT topic", vf.topicFormatOf((await prisma.contentTopic.findUnique({ where: { id: accDirect.topicId } }))?.scoresJson) === "DIRECT");
    // Sections.
    const groupsOf = (b: typeof bankD) => b.groups.map((g) => ({ pillarId: g.pillarId, pillarName: g.pillarName, topics: g.topics.map((t) => ({ ...t, format: vf.resolvedTopicFormat(t.videoFormat, "DIRECT") })) }));
    const splitD = vf.splitSkitSection(groupsOf(await ct.topicBankByPillar(D.enrollmentId)), (t) => t.format);
    c.ok("a bank with both formats gets a Skits section holding the skits; pillars keep the rest", splitD.show && splitD.skits.every((t) => t.format === "SKIT") && splitD.skits.length === 2 && splitD.groups.every((g) => g.topics.every((t) => t.format === "DIRECT")), `${splitD.skits.length}`);
    const one = [{ topics: [{ format: "DIRECT" as const }, { format: "DIRECT" as const }] }];
    c.ok("a bank of one format keeps its pillars (no section), unless the account is Mix", !vf.splitSkitSection(one, (t) => t.format).show && vf.splitSkitSection(one, (t) => t.format, { always: true }).show);
    c.ok("office: the Skits section, the label on every card, the one switch", /Skits · \{bank\.skits\.length\}/.test(tp) && /function FormatChip/.test(tp) && /setTopicFormatAction\(t\.id, other\)/.test(tp) && /VIDEO_FORMAT_LABEL\[t\.format\]/.test(tp));
    c.ok("portal: a Skits category first, and the card label where skits are on", /pillarName: "Skits"/.test(tb) && /showFormat && <span/.test(tb) && /VIDEO_FORMAT_LABEL\[t\.format\]/.test(tb));
    const sp = fs.readFileSync(path.join(REPO, "src/components/content/ScriptsPanel.tsx"), "utf8");
    const shoot = fs.readFileSync(path.join(REPO, "src/app/shoot/[id]/page.tsx"), "utf8");
    const edit = fs.readFileSync(path.join(REPO, "src/app/edit/[id]/page.tsx"), "utf8");
    c.ok("the office script view, the shoot screen and the editor brief show the format", /VIDEO_FORMAT_LABEL\[cur\.format\]/.test(sp) && /"Skit" : "Talking to camera"/.test(shoot) && /"Skit" : "Talking to camera"/.test(edit));
    c.ok("no em dash in any new label or hint", noDash((tp.match(/No skit ideas yet[^<]*/) ?? [""])[0]) && noDash((tb.match(/Short acted videos[^"]*/) ?? [""])[0]) && noDash((shoot.match(/A skit: an acted scene[^<]*/) ?? [""])[0]));

    // ======================================================================
    c.head("9 · unformatted topics and older versions read as before");
    c.ok("a topic JSON with no format (or none at all) has no format of its own", vf.topicFormatOf(null) === null && vf.topicFormatOf(JSON.stringify({ summary: "Trust: High" })) === null && vf.topicFormatOf("not json") === null);
    c.ok("…so it follows its account: DIRECT stays talking to camera, SKITS stays a skit", vf.resolvedTopicFormat(vf.topicFormatOf(null), builtD.ctx.videoStyle) === "DIRECT" && vf.resolvedTopicFormat(vf.topicFormatOf(null), builtS.ctx.videoStyle) === "SKIT");
    prompts.length = 0;
    const s0 = await gen.generateScriptForTopic({ topicId: S0, monthId: S.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    c.ok("an unformatted topic on a SKITS account is drafted as a skit, as on Oct 13", prompts.length === 1 && prompts[0].system.includes(policy.SKIT_SCRIPT_BLOCK) && !!(await prisma.contentScriptVersion.findUnique({ where: { id: s0.versionId } }))?.speakerLabelsJson);
    c.ok("an older version with speaker labels reads as a skit; one without reads as talking to camera", vf.versionFormatOf({ validationJson: null, speakerLabelsJson: '["DANA"]' }) === "SKIT" && vf.versionFormatOf({ validationJson: '{"ok":true}', speakerLabelsJson: null }) === null && vf.shownVersionFormat({ validationJson: null, speakerLabelsJson: null }) === "DIRECT");
    const accountsUntouched = await prisma.contentEnrollment.findUnique({ where: { id: D.enrollmentId } });
    c.ok("the DIRECT account's style is still DIRECT after all of this", vf.videoStyleFromOverrides(accountsUntouched?.overridesJson) === "DIRECT");

    // ======================================================================
    c.head("10 · nothing approved or shared changes");
    const d3 = await gen.generateScriptForTopic({ topicId: T3, monthId: D.monthId, requestedBy: STAFF_EMAIL, unattended: false });
    const now = new Date();
    await prisma.contentScriptVersion.update({ where: { id: d3.versionId }, data: { status: "SHARED", approvedBy: STAFF_EMAIL, approvedAt: now, sharedAt: now } });
    await prisma.contentScript.update({ where: { id: d3.scriptId }, data: { approvedVersionId: d3.versionId, sharedVersionId: d3.versionId, approvedAt: now, sharedAt: now, releaseState: "released", status: "CLIENT_VISIBLE" } });
    const beforeScript = await prisma.contentScript.findUnique({ where: { id: d3.scriptId } });
    const beforeVersions = await prisma.contentScriptVersion.findMany({ where: { scriptId: d3.scriptId }, orderBy: { versionNo: "asc" } });
    const callsBefore = scriptCalls;
    const flip = await actions.setTopicFormatAction(T3, "SKIT");
    const afterScript = await prisma.contentScript.findUnique({ where: { id: d3.scriptId } });
    const afterVersions = await prisma.contentScriptVersion.findMany({ where: { scriptId: d3.scriptId }, orderBy: { versionNo: "asc" } });
    c.ok("switching the format of a topic whose script is shared: no new version, no model call", flip.ok && afterVersions.length === beforeVersions.length && scriptCalls === callsBefore);
    c.ok("…the shared version, its words and its status are untouched", afterScript?.sharedVersionId === beforeScript?.sharedVersionId && afterScript?.body === beforeScript?.body && JSON.stringify(afterVersions.map((v) => [v.id, v.status, v.body])) === JSON.stringify(beforeVersions.map((v) => [v.id, v.status, v.body])));
    c.ok("…still reads as talking to camera (it was written that way)", vf.versionFormatOf(afterVersions[afterVersions.length - 1]) === "DIRECT");
    prompts.length = 0;
    const cr = await gen.reviseScript(d3.scriptId, "Say Lehigh Valley instead of the area.", STAFF_EMAIL, "CLIENT_REQUEST");
    const crv = await prisma.contentScriptVersion.findUnique({ where: { id: cr.versionId } });
    c.ok("a change request on that shared script keeps the format the client saw (talking to camera)", prompts.length === 1 && !/VIDEO STYLE: SKITS/.test(prompts[0].system) && !crv?.speakerLabelsJson && JSON.parse(crv?.validationJson ?? "{}").videoFormat === "DIRECT");
    c.ok("…as a new version; the shared one is still the one on the portal", (await prisma.contentScript.findUnique({ where: { id: d3.scriptId } }))?.sharedVersionId === beforeScript?.sharedVersionId && (await prisma.contentScriptVersion.findUnique({ where: { id: d3.versionId } }))?.status === "SHARED");

    // ======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
  } finally {
    quiet.restore();
    c.summary();
    void server;
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
