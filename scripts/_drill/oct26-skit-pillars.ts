// ---------------------------------------------------------------------------
// DRILL: SKIT CONCEPTS IN EVERY PILLAR, AND THE CALLS IN THE BANK (Oct 26 2026).
//
// Jordan: "anyone that does skits, needs skit concepts as video topics ...
// They should be able to switch back and forth between direct to camera and
// skits for each pillar" and "the skits and topics need to be built around
// them and their content strategy and strategy calls that we have had."
//
//   1  the rules: per-pillar format targets (main at the policy count, the
//      other at 5), the switch's options, counts, the notes tidy and cap.
//   2  bankStock per pillar AND format on Mix and Skits accounts (pending
//      ideas by the format their run recorded); a Direct account unchanged.
//   3  the sweep queues one refill per pillar and format below target, with
//      the format on the run; nothing stacks (an active run covers, a whole
//      bank covers all, a legacy skit-only run covers skits); the weekly
//      cooldown is per pillar and format; pending ideas count as stock; no
//      account-wide skit refresh any more.
//   4  a one-format refill: the prompt asks for that format only in that
//      pillar, a couple more than it keeps; the other format is dropped; on a
//      Skits account the talking-to-camera idea is STAMPED DIRECT when
//      accepted; a whole Skits bank asks for both formats; "regenerate" keeps
//      the idea's format; a run queued before today (skitsOnly) still runs.
//   5  the call notes: completed strategy and discovery calls only, newest
//      first, at most 4, the notes part only (never the transcript), each
//      capped at 1,200 words, a call with no notes skipped, the note taker's
//      furniture and action items gone, another client's name scrubbed and
//      Jordan Spackman's lines kept; the block and its rules in the prompt.
//   6  the bank topics an account wrote before it went to Skits.
//   7  the live one-off's shape (dry run unless --apply; never run here).
//
// ISOLATION: PGlite via the shared harness; the model is a stub; no message leaves.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { isJudgeCall, passingJudge, isIdentityCall, plainIdentity } from "./_judge";

const PORT = Number(process.env.DRILL_PORT ?? 6983);
const REPO = path.resolve(__dirname, "../..");
const STAFF_EMAIL = "jordan@skit-pillars.test";
installNextStubs();
const fence = fenceFetch(async () => null);
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: () => {} }));

// ---- the model boundary ----------------------------------------------------
// Every idea gets a title of three words no other title uses, so the
// near-duplicate checks never drop one by accident.
const WORDS = ("lantern orchard granite pelican harbor velvet compass meadow saffron quarry ember juniper falcon marble thistle cobalt willow canyon riddle tundra "
  + "beacon parsnip glacier mosaic walrus pepper anchor bramble cinder dahlia ermine fjord gazebo hazel igloo jasmine kettle lagoon mango nectar "
  + "oyster paddle quiver raven sorrel tulip umber vortex wicker yarrow zephyr almond bison cactus dune emerald ferret gondola hickory iris jackal "
  + "kayak locust magnet nutmeg osprey pumice quince rocket sequoia trowel urchin violet wombat yucca zinnia acorn badger cello domino eagle fennel "
  + "goblet heron indigo jigsaw koala lilac mortar nickel otter pistol quartz rhubarb spruce tango uplift vista waffle yodel zucchini apricot bobcat "
  + "cricket diesel elbow fiddle gravel hornet ingot jockey kiwi ledger mitten noodle orbit pickle quokka ribbon salmon toffee ukulele vinyl walnut").split(" ");
let wordAt = 0;
const freshTitle = () => { const w = () => { const x = WORDS[wordAt++ % WORDS.length]; return x[0].toUpperCase() + x.slice(1); }; return `${w()} ${w()} ${w()}`; };
type Idea = { title: string; description: string; audienceNeed: string; businessGoal: string; intendedMessage: string; sourceRef: null; format?: string };
const idea = (format: "SKIT" | "DIRECT" | null): Idea => ({ title: freshTitle(), description: format === "SKIT" ? "She plays the seller and the agent; the point lands on pricing." : "Plain advice to camera.", audienceNeed: "Sellers", businessGoal: "Trust", intendedMessage: "Plan first", sourceRef: null, ...(format ? { format } : {}) });
const bankCalls: { system: string; prompt: string; schema: unknown; maxTokens: number | null }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage" && k !== "aiStructuredWithUsage") return t[k];
      return async (opts: { system: string; prompt: string; schema?: unknown; maxTokens?: number }) => {
        if (isJudgeCall(opts.system)) return passingJudge();
        if (isIdentityCall(opts.system)) return plainIdentity();
        const usage = { inputTokens: 500, outputTokens: 200 };
        if (/Video Topic Bank/.test(opts.system)) {
          bankCalls.push({ system: opts.system, prompt: opts.prompt, schema: opts.schema, maxTokens: opts.maxTokens ?? null });
          const pillars = [...new Set([...opts.prompt.matchAll(/Pillar \d+: ([^\n]+)/g)].map((m) => m[1].trim()))];
          // One format only: what was asked, plus one idea in the other format (it must be dropped).
          const only = /exactly (\d+) (skit concepts?|talking-to-camera topics?) in total/.exec(opts.system);
          const out = only
            ? pillars.map((p) => { const f = only[2].startsWith("skit") ? "SKIT" as const : "DIRECT" as const; return { pillarName: p, topics: [...Array.from({ length: Number(only[1]) }, () => idea(f)), idea(f === "SKIT" ? "DIRECT" : "SKIT")] }; })
            // A whole bank: two of each format a pillar, and one idea that says no format.
            : pillars.map((p) => ({ pillarName: p, topics: [idea("SKIT"), idea("SKIT"), idea("DIRECT"), idea("DIRECT"), idea(null)] }));
          return { result: { complete: true, pillars: out, gaps: [] }, usage, model: "drill-stub" };
        }
        throw new Error(`unexpected model call in the skit pillars drill: ${opts.system.slice(0, 80)}`);
      };
    },
  }),
);

const SELLER = "Seller Strategy";
const BRAND = "Personal Branding";
function strategyDoc(name: string) {
  return {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice.", brandMessage: "Plan before you list.", shortBrandStatement: null, brandVoice: "Plain, warm.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Lehigh Valley", pricePositioning: null, primaryClientTypes: "Move-up sellers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Trust, Value, Credibility and Entertainment guide every pillar."], pillars: [
      { number: 1, name: SELLER, heading: `Pillar 1: ${SELLER}`, purpose: "Show how a sale is planned.", focusAreas: "pricing, prep", contentApproach: null, otherFields: [] },
      { number: 2, name: BRAND, heading: `Pillar 2: ${BRAND}`, purpose: "Let people know the agent.", focusAreas: "story, family", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PLAN."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["More personal branding."] }, otherSections: [],
  };
}

/** A Gemini "Notes by Gemini" export: the notes part above "📖 Transcript", then the transcript. */
function geminiExport(marker: string, extra: string[] = []): string {
  return [
    `Strategy call ${marker}`,
    "Invited Mix Pillars TEST mix@pillars.test Jordan Spackman info@realtourpilot.com",
    "Attachments Strategy call",
    "Meeting records Transcript",
    "",
    "📝 Full notes",
    "Summary",
    `${marker}: she wants more personal brand videos about her life in Easton and her family.`,
    "",
    "Details",
    `Skit idea ${marker}: her husband does voice impressions and is happy to appear in skits.`,
    `Jordan Spackman suggested a courtroom skit about pricing ${marker}.`,
    `She is helping Harold Pemberton with a listing in Bethlehem ${marker}.`,
    `Her favourite story ${marker}: the buyer who brought a parrot to every showing.`,
    ...extra,
    "",
    "Suggested next steps",
    `* [Jordan Spackman] Send Portal Link ${marker}: Jordan will send the portal link today.`,
    "",
    "You should review Gemini's notes to make sure they're accurate.",
    "Please rate these notes",
    "",
    "📖 Transcript",
    "",
    `Mix Pillars TEST: TRANSCRIPT-ONLY-LINE ${marker} that must never reach a prompt.`,
  ].join("\n");
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-skit-pillars-oct26", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const noDash = (s: string) => !/[‒-―]/.test(s);
  const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
  const ct = await import("@/lib/contentTopics");
  const gen = await import("@/lib/contentGeneration");
  const vf = await import("@/lib/contentPolicy/videoFormat");
  const policy = await import("@/lib/contentPolicy/prompts");
  const notesLib = await import("@/lib/contentPolicy/callNotes");
  const passages = await import("@/lib/scriptWriter/passages");
  const { setVideoStyle } = await import("@/lib/programStyle");
  const { createStrategyVersion, structuredFromText, approveStrategyVersion } = await import("@/lib/contentStrategy");
  const { setOwnerOverride } = await import("@/lib/contentProgram");
  const { renderStrategy } = await import("@/lib/contentPolicy");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const owner = await prisma.appUser.create({ data: { email: STAFF_EMAIL, name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
    for (const key of ["ai_runs", "topic_refresh"]) await prisma.programAutomation.upsert({ where: { key }, create: { key, enabled: true, enabledBy: "drill", enabledAt: new Date() }, update: { enabled: true } });

    // =======================================================================
    c.head("1 · the rules");
    // =======================================================================
    c.ok("the other format is 5 a pillar", vf.OTHER_FORMAT_PER_PILLAR === 5);
    const tMix = vf.pillarFormatTargets("MIX", 12), tSkits = vf.pillarFormatTargets("SKITS", 12);
    c.ok("Mix: talking to camera is the main format at the policy count, skits at 5", JSON.stringify(tMix) === JSON.stringify([{ format: "DIRECT", main: true, target: 12 }, { format: "SKIT", main: false, target: 5 }]), JSON.stringify(tMix));
    c.ok("Skits: skits are the main format at the policy count, talking to camera at 5", JSON.stringify(tSkits) === JSON.stringify([{ format: "SKIT", main: true, target: 12 }, { format: "DIRECT", main: false, target: 5 }]), JSON.stringify(tSkits));
    c.ok("Direct: one format, no targets per format", vf.pillarFormatTargets("DIRECT", 12) === null && vf.mainFormatFor("DIRECT") === "DIRECT");
    c.ok("the switch reads 'Talking to camera | Skits', in that order", vf.FORMAT_SWITCH_OPTIONS.map((o) => o.label).join(" | ") === "Talking to camera | Skits");
    c.ok("formatCounts counts each format", JSON.stringify(vf.formatCounts(["SKIT", "DIRECT", "SKIT"] as const, (f) => f)) === JSON.stringify({ DIRECT: 1, SKIT: 2 }));
    const sample = geminiExport("ZULU");
    const notes = passages.transcriptNotes(sample);
    c.ok("transcriptNotes: the part above '📖 Transcript', never the transcript", !!notes && /ZULU: she wants/.test(notes) && !/TRANSCRIPT-ONLY-LINE/.test(notes));
    c.ok("…and nothing for an export with no notes part", passages.transcriptNotes("📖 Transcript\n\nA: hello there") === null && passages.transcriptNotes("A: no heading at all") === null);
    const tidy = notesLib.tidyCallNotes(notes ?? "");
    c.ok("tidy: the header with email addresses, the separators, the rating lines and the action items go", !/@/.test(tidy) && !/Please rate|You should review|Full notes|Attachments|Send Portal Link/.test(tidy) && /parrot/.test(tidy) && /Jordan Spackman suggested a courtroom skit/.test(tidy), tidy);
    const long = Array.from({ length: 300 }, (_, i) => `Line ${i} has exactly seven words here.`).join("\n");
    const capped = notesLib.capWords(long, 1200);
    c.ok("cap: at most 1,200 words, whole lines kept, the crossing line cut with ' ...'", notesLib.wordCount(capped) <= 1201 && notesLib.wordCount(capped) >= 1190 && / \.\.\.$/.test(capped), String(notesLib.wordCount(capped)));
    c.ok("a run's scope reads its pillar and format; a pre-Oct 26 skit-only run reads as skits across the bank", JSON.stringify(ct.refreshScopeOf('{"pillarId":"p1","format":"DIRECT","keep":3}')) === JSON.stringify({ pillarId: "p1", format: "DIRECT", keep: 3, skitsOnly: false }) && ct.refreshScopeOf('{"skitsOnly":true,"keep":2}').format === "SKIT" && ct.refreshScopeOf("not json").format === null);
    c.ok("the call rules: what the client said, no agency business, no live deal or listing for sale or confidence, never their clients' names", /what the client said/.test(policy.STRATEGY_CALLS_RULE) && /our agency's own business/.test(policy.STRATEGY_CALLS_RULE) && /live or pending deal/.test(policy.STRATEGY_CALLS_RULE) && /still for sale/.test(policy.STRATEGY_CALLS_RULE) && /in confidence/.test(policy.STRATEGY_CALLS_RULE) && /Never name the client's own clients/.test(policy.STRATEGY_CALLS_RULE) && noDash(policy.STRATEGY_CALLS_RULE));
    c.ok("the skit rules: the confirmed cast or the client alone, filmable in a normal session, each lands its pillar's real point", /can be filmed by the client alone/.test(policy.SKIT_CONCEPT_RULES) && /Never a stranger, an actor or an invented character/.test(policy.SKIT_CONCEPT_RULES) && /normal content session/.test(policy.SKIT_CONCEPT_RULES) && /pillar/.test(policy.SKIT_CONCEPT_RULES) && noDash(policy.SKIT_CONCEPT_RULES));

    // =======================================================================
    c.head("setup · a Mix, a Skits and a Direct account, each with two pillars");
    // =======================================================================
    const approve = async (f: { enrollmentId: string }, name: string) => {
      const text = renderStrategy(strategyDoc(name) as unknown as Parameters<typeof renderStrategy>[0]);
      const sv = await createStrategyVersion({ enrollmentId: f.enrollmentId, stored: structuredFromText(text).stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof createStrategyVersion>[0]);
      await setOwnerOverride("ENROLLMENT", f.enrollmentId, "STRATEGY", owner.id, "drill");
      await approveStrategyVersion(sv.versionId, STAFF_EMAIL);
      await prisma.contentTopicRefreshRun.updateMany({ where: { enrollmentId: f.enrollmentId, status: "QUEUED" }, data: { status: "CANCELLED", dedupeKey: null } });
      const pillars = await prisma.contentPillar.findMany({ where: { enrollmentId: f.enrollmentId }, select: { id: true, name: true } });
      return { seller: pillars.find((p) => p.name === SELLER)!.id, brand: pillars.find((p) => p.name === BRAND)!.id };
    };
    const M = await buildContentMonth(db, { name: "Mix Pillars TEST", package: "Accelerator", project: false });
    const S = await buildContentMonth(db, { name: "Skit Pillars TEST", package: "Accelerator", project: false });
    const D = await buildContentMonth(db, { name: "Direct Pillars TEST", package: "Accelerator", project: false });
    const mP = await approve(M, "Mix Pillars TEST");
    const sP = await approve(S, "Skit Pillars TEST");
    const dP = await approve(D, "Direct Pillars TEST");
    await setVideoStyle(M.enrollmentId, "MIX", STAFF_EMAIL, { skitsPerMonth: 2 });
    const topic = (f: { enrollmentId: string; clientId: string }, pillarId: string, title: string, format: "SKIT" | "DIRECT" | null, over: Record<string, unknown> = {}) =>
      prisma.contentTopic.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, pillarId, title, concept: `${title}, the concept.`, status: "SAVED", approvalState: "APPROVED", source: "staff", ...(format ? { scoresJson: JSON.stringify({ videoFormat: format }) } : {}), ...over } });
    // The Skits account: three topics from before it went to Skits (one bank topic, one with a script, one picked), then the switch, then a skit concept and a stamped talking-to-camera topic.
    const preBank = await topic(S, sP.seller, "Before the switch kitchen", null);
    const preScripted = await topic(S, sP.seller, "Before the switch porch", null);
    await prisma.contentScript.create({ data: { enrollmentId: S.enrollmentId, clientId: S.clientId, topicId: preScripted.id, title: preScripted.title, body: "A talking-to-camera script." } });
    const prePicked = await topic(S, sP.brand, "Before the switch garden", null, { status: "SELECTED" });
    await sleep(40);
    await setVideoStyle(S.enrollmentId, "SKITS", STAFF_EMAIL);
    await sleep(40);
    await topic(S, sP.seller, "After the switch courtroom", null);
    await topic(S, sP.seller, "Stamped to camera attic", "DIRECT");
    // The Mix account: Seller holds 3 + 1 unmarked talking-to-camera topics and 2 skits (and a declined skit, not stock).
    for (const t of ["Mix direct basement", "Mix direct driveway", "Mix direct chimney"]) await topic(M, mP.seller, t, "DIRECT");
    await topic(M, mP.seller, "Mix unmarked hallway", null);
    await topic(M, mP.seller, "Mix skit closet", "SKIT");
    await topic(M, mP.seller, "Mix skit pantry", "SKIT");
    await topic(M, mP.seller, "Mix skit declined", "SKIT", { clientDeclinedAt: new Date() });
    // Every account has had its bank run since approval (so the sweep refills rather than starts a bank): one SUCCEEDED whole-bank run each,
    // and on the Mix account it carries two pending ideas in Seller, one recorded as a skit and one with no format recorded.
    const doneRun = async (f: { enrollmentId: string; clientId: string }, inputs: Record<string, unknown> = {}) => prisma.contentTopicRefreshRun.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, kind: "REFRESH", status: "SUCCEEDED", requestedBy: "drill", inputsJson: JSON.stringify(inputs), finishedAt: new Date() } });
    const pend = async (f: { enrollmentId: string; clientId: string }, runId: string, pillarId: string, title: string) => prisma.contentTopicSuggestion.create({ data: { refreshRunId: runId, enrollmentId: f.enrollmentId, clientId: f.clientId, pillarId, kind: "BANK", title, dedupeHash: ct.topicDedupeHash(title) } });
    const mRun = await doneRun(M, { formats: { [ct.topicDedupeHash("Pending skit wardrobe")]: "SKIT" } });
    await pend(M, mRun.id, mP.seller, "Pending skit wardrobe");
    await pend(M, mRun.id, mP.seller, "Pending unrecorded staircase");
    await doneRun(S);
    await doneRun(D);

    // =======================================================================
    c.head("2 · stock per pillar and format");
    // =======================================================================
    const stockM = await ct.bankStock(M.enrollmentId);
    const T = stockM[0]?.target ?? 0;
    const mSeller = stockM.find((p) => p.pillarId === mP.seller)!;
    const mBrand = stockM.find((p) => p.pillarId === mP.brand)!;
    const fmt = (p: typeof mSeller, f: "SKIT" | "DIRECT") => p.formats?.find((x) => x.format === f);
    c.ok("Mix: talking to camera first and main (the unmarked topic counts there), at the policy count", T >= 10 && mSeller.formats?.[0].format === "DIRECT" && mSeller.formats[0].main && fmt(mSeller, "DIRECT")?.usable === 4 && fmt(mSeller, "DIRECT")?.target === T, JSON.stringify(mSeller));
    c.ok("…an idea with no recorded format waits as the main format; the recorded skit as a skit", fmt(mSeller, "DIRECT")?.pending === 1 && fmt(mSeller, "SKIT")?.pending === 1 && fmt(mSeller, "DIRECT")?.need === T - 5);
    c.ok("…skits at 5: 2 usable (the declined one is not stock) + 1 pending, needs 2", fmt(mSeller, "SKIT")?.usable === 2 && fmt(mSeller, "SKIT")?.target === 5 && fmt(mSeller, "SKIT")?.need === 2);
    c.ok("…the top-level numbers are the main format's", mSeller.usable === 4 && mSeller.pending === 1 && mSeller.need === T - 5 && mBrand.need === T);
    const stockS = await ct.bankStock(S.enrollmentId);
    const sSeller = stockS.find((p) => p.pillarId === sP.seller)!;
    c.ok("Skits: skits are main, unmarked topics count as skits until marked", sSeller.formats?.[0].format === "SKIT" && fmt(sSeller, "SKIT")?.usable === 3 && fmt(sSeller, "DIRECT")?.usable === 1 && fmt(sSeller, "DIRECT")?.need === 4, JSON.stringify(sSeller.formats));
    const stockD = await ct.bankStock(D.enrollmentId);
    c.ok("Direct: no formats, the pillar's count as before", stockD.every((p) => p.formats === null && p.target === T && p.need === T), JSON.stringify(stockD));

    // =======================================================================
    c.head("3 · the sweep refills per pillar and format, never stacking");
    // =======================================================================
    const queuedOf = async (enrollmentId: string) => (await prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId, status: "QUEUED" }, orderBy: { createdAt: "asc" } })).map((r) => ({ id: r.id, ...ct.refreshScopeOf(r.inputsJson), skitsOnlyRaw: /skitsOnly/.test(r.inputsJson ?? "") }));
    const sw1 = await ct.sweepTopicBanks({ max: 0 });
    const qM = await queuedOf(M.enrollmentId);
    const want = (q: typeof qM, pillarId: string, format: string | null, keep: number) => q.some((r) => r.pillarId === pillarId && r.format === format && r.keep === keep);
    c.ok("Mix: four refills, one per pillar and format, each keeping its shortfall", qM.length === 4 && want(qM, mP.seller, "DIRECT", T - 5) && want(qM, mP.seller, "SKIT", 2) && want(qM, mP.brand, "DIRECT", T) && want(qM, mP.brand, "SKIT", 5), JSON.stringify(qM));
    c.ok("…and no account-wide skit-only refresh any more", !qM.some((r) => r.skitsOnlyRaw || (!r.pillarId && r.format)));
    const qS = await queuedOf(S.enrollmentId);
    c.ok("Skits: skit concepts at the policy count, talking to camera at 5", qS.length === 4 && want(qS, sP.seller, "SKIT", T - 3) && want(qS, sP.seller, "DIRECT", 4) && want(qS, sP.brand, "SKIT", T) && want(qS, sP.brand, "DIRECT", 5), JSON.stringify(qS));
    const qD = await queuedOf(D.enrollmentId);
    c.ok("Direct: one refill a pillar with no format, as before", qD.length === 2 && want(qD, dP.seller, null, T) && want(qD, dP.brand, null, T), JSON.stringify(qD));
    c.ok("the sweep counted them", "refills" in sw1 && sw1.refills === 10, JSON.stringify(sw1));
    const sw2 = await ct.sweepTopicBanks({ max: 0 });
    c.ok("a second sweep while they wait queues nothing", "refills" in sw2 && sw2.refills === 0 && (await queuedOf(M.enrollmentId)).length === 4, JSON.stringify(sw2));
    // Finished runs start the weekly cooldown, per pillar AND format.
    await prisma.contentTopicRefreshRun.updateMany({ where: { status: "QUEUED" }, data: { status: "SUCCEEDED", dedupeKey: null, finishedAt: new Date() } });
    const sw3 = await ct.sweepTopicBanks({ max: 0 });
    c.ok("refilled this week: nothing queued", "refills" in sw3 && sw3.refills === 0, JSON.stringify(sw3));
    // Eight days later for the Mix account's SKIT refills only: those two come back, the DIRECT ones stay cooled.
    const mRuns = await prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId: M.enrollmentId, status: "SUCCEEDED" } });
    for (const r of mRuns) if (ct.refreshScopeOf(r.inputsJson).format === "SKIT") await prisma.contentTopicRefreshRun.update({ where: { id: r.id }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    // …and five skit ideas now wait for review in Branding: pending ideas are stock, so Branding's skits need nothing.
    const brandRun = await doneRun(M, { formats: Object.fromEntries(["Branding skit one", "Branding skit two", "Branding skit three", "Branding skit four", "Branding skit five"].map((t) => [ct.topicDedupeHash(t), "SKIT"])) });
    for (const t of ["Branding skit one", "Branding skit two", "Branding skit three", "Branding skit four", "Branding skit five"]) await pend(M, brandRun.id, mP.brand, t);
    await ct.sweepTopicBanks({ max: 0 });
    const qM2 = await queuedOf(M.enrollmentId);
    c.ok("the cooldown is per pillar and format; pending ideas stop new spend", qM2.length === 1 && qM2[0].pillarId === mP.seller && qM2[0].format === "SKIT", JSON.stringify(qM2));
    await prisma.contentTopicRefreshRun.updateMany({ where: { enrollmentId: M.enrollmentId, status: "QUEUED" }, data: { status: "CANCELLED", dedupeKey: null } });
    // Coverage on the Skits account (cooldown waived to see it).
    const legacy = await ct.queueTopicRefresh({ enrollmentId: S.enrollmentId, kind: "REFRESH", requestedBy: "drill", skitsOnly: true, keep: 2, reason: "legacy" });
    const planLegacy = await ct.planPillarRefills(S.enrollmentId, { ignoreCooldown: true });
    c.ok("a queued skit-only run from before today covers every pillar's skits, not their talking to camera", planLegacy.plans.filter((p) => p.format === "SKIT").every((p) => /queued or running/.test(p.skip ?? "")) && planLegacy.plans.filter((p) => p.format === "DIRECT").every((p) => !p.skip), JSON.stringify(planLegacy));
    await prisma.contentTopicRefreshRun.update({ where: { id: legacy.runId }, data: { status: "CANCELLED", dedupeKey: null } });
    const whole = await ct.queueTopicRefresh({ enrollmentId: S.enrollmentId, kind: "REFRESH", requestedBy: "drill", reason: "whole bank" });
    const planWhole = await ct.planPillarRefills(S.enrollmentId, { ignoreCooldown: true });
    c.ok("a queued whole-bank run covers every pillar and format", planWhole.wholeBankActive && planWhole.plans.length === 0);
    await prisma.contentTopicRefreshRun.update({ where: { id: whole.runId }, data: { status: "CANCELLED", dedupeKey: null } });
    c.ok("a whole-bank click never claims a queued one-format refill", /!opts\.format && !opts\.skitsOnly/.test(read("src/lib/contentTopics.ts")));

    // =======================================================================
    c.head("4 · one-format refills, stamping, a whole Skits bank, regenerate, a legacy run");
    // =======================================================================
    bankCalls.length = 0;
    const r1 = await ct.startTopicRefresh({ enrollmentId: S.enrollmentId, kind: "REFRESH", requestedBy: STAFF_EMAIL, pillarId: sP.seller, keep: 2, format: "DIRECT" });
    const run1 = await prisma.contentTopicRefreshRun.findUniqueOrThrow({ where: { id: r1.runId } });
    const call1 = bankCalls[0];
    c.ok("the refill asked for talking to camera only, two more than it keeps, all in Seller Strategy", run1.status === "SUCCEEDED" && !!call1 && /TALKING TO CAMERA ONLY/.test(call1.system) && /exactly 4 talking-to-camera topics in total/.test(call1.system) && !/Pillar \d+: Personal Branding/.test(call1.prompt) && /Pillar \d+: Seller Strategy/.test(call1.prompt), `${run1.status} ${run1.lastError ?? run1.changeSummary}`);
    c.ok("…with the format in the schema and the run's inputs", /"enum":\["DIRECT","SKIT"\]/.test(JSON.stringify(call1?.schema)) && ct.refreshScopeOf(run1.inputsJson).format === "DIRECT" && ct.refreshScopeOf(run1.inputsJson).pillarId === sP.seller);
    const s1 = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: r1.runId } });
    const f1 = await ct.suggestionFormats(s1);
    c.ok("two kept, both talking to camera (the skit the model added was dropped)", s1.length === 2 && s1.every((x) => f1.get(x.id) === "DIRECT"), `${s1.length} ${JSON.stringify([...f1.values()])} ${run1.changeSummary}`);
    const acc1 = await ct.acceptSuggestion(s1[0].id, STAFF_EMAIL);
    const t1 = await prisma.contentTopic.findUniqueOrThrow({ where: { id: acc1.topicId } });
    c.ok("accepted on a Skits account, it is STAMPED Talking to camera (unmarked it would read as a skit)", vf.topicFormatOf(t1.scoresJson) === "DIRECT" && vf.resolvedTopicFormat(vf.topicFormatOf(t1.scoresJson), "SKITS") === "DIRECT");
    bankCalls.length = 0;
    const r2 = await ct.startTopicRefresh({ enrollmentId: S.enrollmentId, kind: "REFRESH", requestedBy: STAFF_EMAIL });
    const run2 = await prisma.contentTopicRefreshRun.findUniqueOrThrow({ where: { id: r2.runId } });
    const call2 = bankCalls[0];
    c.ok("a whole Skits bank asks for both formats in every pillar, with room to write them", !!call2 && /COUNT: every pillar holds BOTH formats: exactly \d+ skit concepts \(format "SKIT"\) and exactly 5 talking-to-camera topics \(format "DIRECT"\) under EACH/.test(call2.system) && call2.system.includes(policy.SKIT_TOPIC_RULE) && call2.maxTokens === 24_000, `${call2?.maxTokens} ${(/^COUNT:.*$/m.exec(call2?.system ?? "") ?? [""])[0].slice(0, 200)}`);
    const s2 = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: r2.runId } });
    const f2 = await ct.suggestionFormats(s2);
    c.ok("every idea has a format: the unmarked ones as skits, the talking-to-camera ones as DIRECT", s2.length === 10 && s2.every((x) => !!f2.get(x.id)) && s2.filter((x) => f2.get(x.id) === "DIRECT").length === 4 && s2.filter((x) => f2.get(x.id) === "SKIT").length === 6, `${run2.status} ${s2.length} ${JSON.stringify([...f2.values()])}`);
    const direct2 = s2.find((x) => f2.get(x.id) === "DIRECT")!;
    c.ok("…and a talking-to-camera idea from it is stamped DIRECT when accepted", vf.topicFormatOf((await prisma.contentTopic.findUniqueOrThrow({ where: { id: (await ct.acceptSuggestion(direct2.id, STAFF_EMAIL)).topicId } })).scoresJson) === "DIRECT");
    const skit2 = s2.find((x) => f2.get(x.id) === "SKIT" && x.pillarId === sP.brand)!;
    bankCalls.length = 0;
    const r3 = await ct.regenerateSuggestion(skit2.id, STAFF_EMAIL);
    const run3 = await prisma.contentTopicRefreshRun.findUniqueOrThrow({ where: { id: r3.runId } });
    const s3 = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: r3.runId } });
    const f3 = await ct.suggestionFormats(s3);
    c.ok("regenerating a skit idea asks for one skit concept in its pillar and keeps one skit", ct.refreshScopeOf(run3.inputsJson).format === "SKIT" && ct.refreshScopeOf(run3.inputsJson).pillarId === sP.brand && /SKITS ONLY/.test(bankCalls[0]?.system ?? "") && s3.length === 1 && f3.get(s3[0].id) === "SKIT", `${run3.status} ${s3.length} ${run3.changeSummary}`);
    // A run queued before today (skitsOnly, no format) still runs as it did.
    bankCalls.length = 0;
    const old = await ct.queueTopicRefresh({ enrollmentId: M.enrollmentId, kind: "REFRESH", requestedBy: "cron", skitsOnly: true, keep: 2, reason: "queued before Oct 26" });
    await ct.drainTopicRefreshQueue({ max: 1, budgetMs: 60_000 });
    const oldRun = await prisma.contentTopicRefreshRun.findUniqueOrThrow({ where: { id: old.runId } });
    const sOld = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: old.runId } });
    const fOld = await ct.suggestionFormats(sOld);
    c.ok("a skit-only run queued before today still runs: skits only, across the bank, two kept", oldRun.status === "SUCCEEDED" && /SKITS ONLY/.test(bankCalls[0]?.system ?? "") && /exactly 2 skit concepts in total/.test(bankCalls[0]?.system ?? "") && sOld.length === 2 && sOld.every((x) => fOld.get(x.id) === "SKIT"), `${oldRun.status} ${sOld.length} ${oldRun.changeSummary ?? oldRun.lastError}`);

    // =======================================================================
    c.head("5 · the strategy calls in the bank prompt");
    // =======================================================================
    // Another client (not a test name, so it is scrubbed) with an enrollment.
    const other = await prisma.client.create({ data: { name: "Harold Pemberton", socialClient: true } });
    await prisma.contentEnrollment.create({ data: { clientId: other.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2, startedAt: new Date("2026-08-01T04:00:00Z") } as never });
    let hashN = 0;
    const call = async (marker: string, callType: string, status: string, startISO: string, text: string | null) => {
      const rec = await prisma.programCallRecord.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, callType, status, scheduledStart: new Date(startISO) } as never });
      if (text) await prisma.programTranscriptSource.create({ data: { callRecordId: rec.id, provider: "paste", text, contentHash: `drill-${marker}-${hashN++}`, matchState: "CONFIRMED" } as never });
      return rec;
    };
    const bulky = Array.from({ length: 250 }, (_, i) => `Bravo detail ${i}: one more idea about the listing photos.`);
    await call("ALPHA", "MONTHLY_STRATEGY", "COMPLETED", "2026-10-20T15:00:00Z", geminiExport("ALPHA"));
    await call("NONOTES", "MONTHLY_STRATEGY", "COMPLETED", "2026-10-10T15:00:00Z", "📖 Transcript\n\nMix Pillars TEST: NONOTES only a transcript here.");
    await call("BRAVO", "BRAND_DISCOVERY", "COMPLETED", "2026-09-25T15:00:00Z", geminiExport("BRAVO", bulky));
    await call("CHARLIE", "MONTHLY_STRATEGY", "COMPLETED", "2026-09-10T15:00:00Z", geminiExport("CHARLIE"));
    await call("DELTA", "MONTHLY_STRATEGY", "COMPLETED", "2026-08-20T15:00:00Z", geminiExport("DELTA"));
    await call("ECHO", "MONTHLY_STRATEGY", "COMPLETED", "2026-08-01T15:00:00Z", geminiExport("ECHO"));
    await call("FOXTROT", "UNRELATED", "COMPLETED", "2026-10-22T15:00:00Z", geminiExport("FOXTROT"));
    await call("GOLF", "MONTHLY_STRATEGY", "SCHEDULED", "2026-10-21T15:00:00Z", geminiExport("GOLF"));
    const cn = await gen.strategyCallNotesFor(M.enrollmentId, M.clientId);
    const markers = cn.calls.map((x) => (/(ALPHA|BRAVO|CHARLIE|DELTA|ECHO)/.exec(x.notes) ?? [""])[0]);
    c.ok("completed strategy and discovery calls only, newest first, at most 4, the call with no notes skipped", markers.join(",") === "ALPHA,BRAVO,CHARLIE,DELTA" && cn.calls[1].kind === "discovery" && cn.calls[0].kind === "strategy" && cn.calls[0].dateISO === "2026-10-20", JSON.stringify(cn.calls.map((x) => [x.dateISO, x.kind])));
    const allNotes = cn.calls.map((x) => x.notes).join("\n");
    c.ok("the notes part only: no transcript line, no email, no rating line, no action item", !/TRANSCRIPT-ONLY-LINE|NONOTES|FOXTROT|GOLF|ECHO/.test(allNotes) && !/@|Please rate|Send Portal Link/.test(allNotes));
    c.ok("another client's name is scrubbed; Jordan Spackman's lines stay", !/Harold Pemberton/.test(allNotes) && /Jordan Spackman suggested a courtroom skit about pricing ALPHA/.test(allNotes) && cn.stripped >= 4, String(cn.stripped));
    c.ok("each call capped at 1,200 words", cn.calls.every((x) => notesLib.wordCount(x.notes) <= 1201) && notesLib.wordCount(cn.calls[1].notes) > 1100 && / \.\.\.$/.test(cn.calls[1].notes), String(notesLib.wordCount(cn.calls[1].notes)));
    bankCalls.length = 0;
    const rM = await ct.startTopicRefresh({ enrollmentId: M.enrollmentId, kind: "REFRESH", requestedBy: STAFF_EMAIL, pillarId: mP.brand, keep: 2, format: "SKIT" });
    const runM = await prisma.contentTopicRefreshRun.findUniqueOrThrow({ where: { id: rM.runId } });
    const callM = bankCalls[0];
    c.ok("the bank prompt carries the call block, newest first, and the rules in the system prompt", runM.status === "SUCCEEDED" && !!callM && /STRATEGY CALL NOTES/.test(callM.prompt) && callM.prompt.indexOf("Strategy call, Oct 20, 2026") < callM.prompt.indexOf("Brand discovery call, Sep 25, 2026") && callM.prompt.indexOf("Brand discovery call, Sep 25, 2026") > 0 && callM.system.includes(policy.STRATEGY_CALLS_RULE), `${runM.status} ${runM.lastError ?? ""}`);
    c.ok("…and no other client's name, no transcript line", !/Harold Pemberton|TRANSCRIPT-ONLY-LINE/.test(callM?.prompt ?? "") && !/Harold Pemberton/.test(callM?.system ?? ""));
    const aiRun = runM.aiRunId ? await prisma.programAiRun.findUnique({ where: { id: runM.aiRunId } }) : null;
    const refs = JSON.parse((aiRun as { inputRefsJson?: string | null } | null)?.inputRefsJson ?? "{}") as { strategyCallIds?: string[] };
    c.ok("…the run records which calls it read", Array.isArray(refs.strategyCallIds) && refs.strategyCallIds.length === 4, JSON.stringify(refs).slice(0, 200));
    c.ok("a skit-only refill on a Mix account asks for skits in that pillar, with the cast rules", /SKITS ONLY/.test(callM?.system ?? "") && /Pillar \d+: Personal Branding/.test(callM?.prompt ?? "") && callM!.system.includes(policy.SKIT_CONCEPT_RULES));
    bankCalls.length = 0;
    await ct.startTopicRefresh({ enrollmentId: D.enrollmentId, kind: "REFRESH", requestedBy: STAFF_EMAIL, pillarId: dP.seller, keep: 1 });
    c.ok("a client with no calls: no block and no call rules", !!bankCalls[0] && !/STRATEGY CALL NOTES/.test(bankCalls[0].prompt) && !bankCalls[0].system.includes(policy.STRATEGY_CALLS_RULE) && !/VIDEO STYLE: (SKITS|MIX)/.test(bankCalls[0].system));
    c.ok("the call block is empty with no notes", policy.strategyCallsBlock([]) === "" && policy.strategyCallsBlock(null) === "");

    // =======================================================================
    c.head("6 · bank topics written before an account went to Skits");
    // =======================================================================
    const pre = await ct.preSkitsBankTopics(S.enrollmentId);
    c.ok("the unmarked bank topic from before the switch, not the scripted one, the picked one or anything after", !!pre.since && pre.topics.map((t) => t.id).join() === preBank.id, JSON.stringify(pre));
    c.ok("…none on a Mix or Direct account", (await ct.preSkitsBankTopics(M.enrollmentId)).topics.length === 0 && (await ct.preSkitsBankTopics(D.enrollmentId)).topics.length === 0);
    const before = (await ct.bankStock(S.enrollmentId)).find((p) => p.pillarId === sP.seller)!;
    await ct.setTopicFormat(preBank.id, "DIRECT", { kind: "STAFF" });
    const after = (await ct.bankStock(S.enrollmentId)).find((p) => p.pillarId === sP.seller)!;
    c.ok("marked Talking to camera, it moves from skit stock to talking-to-camera stock", fmt(after, "SKIT")!.usable === fmt(before, "SKIT")!.usable - 1 && fmt(after, "DIRECT")!.usable === fmt(before, "DIRECT")!.usable + 1 && (await ct.preSkitsBankTopics(S.enrollmentId)).topics.length === 0);
    c.ok("…the picked and scripted topics were left as they were", vf.topicFormatOf((await prisma.contentTopic.findUniqueOrThrow({ where: { id: prePicked.id } })).scoresJson) === null && vf.topicFormatOf((await prisma.contentTopic.findUniqueOrThrow({ where: { id: preScripted.id } })).scoresJson) === null);

    // =======================================================================
    c.head("7 · the live one-off (never run by the drill)");
    // =======================================================================
    const live = read("scripts/_live/oct26-skit-banks.ts");
    c.ok("dry run unless --apply, behind the read-only guard", /import \{ APPLY, db \} from "\.\/_oct22-guard"/.test(live) && /if \(!APPLY\) continue;/.test(live) && /if \(APPLY\) \{/.test(live));
    c.ok("the four clients by name", ["Bernadette Rabel", "Janice Pigga", "Joseph Sutow", "Mike Flatley"].every((n) => live.includes(`"${n}"`)));
    c.ok("it queues per pillar and format with its own requester, the cooldown waived, and marks only with --apply", /queuePillarRefills\(e\.id, \{ requestedBy: BY, ignoreCooldown: true \}\)/.test(live) && /const BY = "staff:oct26-skit-banks"/.test(live) && /if \(APPLY\) \{\s*for \(const t of pre\.topics\) \{ const r = await ct\.setTopicFormat\(t\.id, "DIRECT"/.test(live));
    c.ok("the client copy added today carries no em or en dash", noDash(read("src/components/content/FormatSwitch.tsx").replace(/\/\/.*$/gm, "")) && noDash((read("src/components/portal/TopicBank.tsx").match(/No \{FORMAT_PLURAL\[onFormat\]\} in this pillar yet\./) ?? ["x"])[0]) && noDash(vf.FORMAT_PLURAL.SKIT + vf.FORMAT_PLURAL.DIRECT));

    c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    await new Promise((r) => setTimeout(r, 1500));
    await prisma.$disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
