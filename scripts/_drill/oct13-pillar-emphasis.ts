// ---------------------------------------------------------------------------
// DRILL: pillar emphasis, Lead · Normal · Light (Oct 13 2026).
//
// Jordan: "Buyer Education & Transaction Guidance topics are being recommended
// for Arielle Roemer. Her content strategy should be less buyer heavy and more
// seller heavy and personal branding heavy." Every pillar got the same number
// of bank topics and the same ranking weight; ContentPillar.emphasis now sets
// both, per pillar.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct13-pillar-emphasis.ts
//
// The OLD ranking is loaded for real from BASE (the commit this change starts
// from) so its behaviour is asserted first, beside the new one.
//
//   1. The pure rules: every pillar gets n (Oct 20 2026: "10-15 video topics
//      per content pillar"; LIGHT was max(2, round(n/3)) from Oct 13).
//   2. The validator holds every pillar, LIGHT included, to n.
//   3. The ranking: a LIGHT pillar's topic used to tie a NORMAL one (no goal
//      link) or beat it (under-represented in filming); now it ranks below.
//   4. The staff action: refuses a bad value and another client's pillar;
//      sets LEAD / LIGHT on Arielle-shaped pillars.
//   5. The bank run: the prompt asks every pillar for n and names the LEAD and
//      LIGHT pillars; a LIGHT pillar keeps its full n; the weekly refill
//      target is n for every pillar.
//   6. The recommendation run: no LIGHT topic is recommended, a LEAD one is
//      ranked first.
//   7. The client's topic bank: LEAD first, LIGHT last (the staff bank keeps
//      the strategy's order).
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
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6977);
const REPO = path.resolve(__dirname, "../..");
const BASE = "ec45a02"; // the commit this change starts from

installNextStubs();
const fence = fenceFetch();

// The staff action runs on the sessionless dev path ("dev@local"); the drill
// makes that address the strategy owner so assertDutyOwner passes on its own rules.
const STAFF_EMAIL = "dev@local";

const BUYER = "Buyer Education & Transaction Guidance";
const SELLER = "Seller Strategy";
const BRAND = "Personal Branding";

// ---- the model boundary: 10 topics for every pillar the context names ----
let aiCalls = 0;
const prompts: { system: string; prompt: string }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        aiCalls++;
        prompts.push({ system: opts.system, prompt: opts.prompt });
        const usage = { inputTokens: 900, outputTokens: 300 };
        if (/Video Topic Bank/.test(opts.system)) {
          const pillars = [...new Set([...opts.prompt.matchAll(/Pillar \d+: ([^\n]+)/g)].map((m) => m[1].trim()))];
          // Deliberately a FULL pillar's worth everywhere: the LIGHT cap must hold on our side.
          const out = pillars.map((p) => ({
            pillarName: p,
            topics: Array.from({ length: 10 }, (_, i) => `${p} idea ${i + 1}`).map((title) => ({ title, description: `About ${title}.`, audienceNeed: "Sellers deciding when to list", businessGoal: "Build trust with sellers", intendedMessage: "Plan before you list", sourceRef: null })),
          }));
          return { result: { complete: true, pillars: out, gaps: [] }, usage, model: "drill-stub" };
        }
        throw new Error(`unexpected model call: ${opts.system.slice(0, 80)}`);
      };
    },
  }),
);

/** The OLD topicBank.ts, byte for byte from BASE, its imports aimed at this tree. */
function writeBaseTopicBank(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oct13-emphasis-base-"));
  const src = execFileSync("git", ["show", `${BASE}:src/lib/contentPolicy/topicBank.ts`], { cwd: REPO, encoding: "utf8" });
  const file = path.join(dir, "topicBank.base.ts");
  fs.writeFileSync(file, src.replace(/(["'])\.\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src/lib/contentPolicy", p)}${q}`));
  return { dir, file };
}

async function strategyText(name: string): Promise<string> {
  const { renderStrategy } = await import("@/lib/contentPolicy");
  const doc = {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice, local depth.", brandMessage: "Plan the sale before the sign goes up.", shortBrandStatement: null, brandVoice: "Plain, direct, warm.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Bucks County", pricePositioning: null, primaryClientTypes: "Move-up sellers and first-time buyers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers", "Show local market expertise"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Trust, Value, Credibility and Entertainment guide every pillar."], pillars: [
      { number: 1, name: BUYER, heading: `Pillar 1: ${BUYER}`, purpose: "Walk buyers through the process.", focusAreas: "offers, inspections, closing", contentApproach: null, otherFields: [] },
      { number: 2, name: SELLER, heading: `Pillar 2: ${SELLER}`, purpose: "Show sellers how a sale is planned.", focusAreas: "pricing, prep, timing", contentApproach: null, otherFields: [] },
      { number: 3, name: BRAND, heading: `Pillar 3: ${BRAND}`, purpose: "Let people know the agent.", focusAreas: "story, team, community", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PRICE for a pricing plan."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["Grow the seller side this year."] }, otherSections: [],
  };
  return renderStrategy(doc as unknown as Parameters<typeof renderStrategy>[0]);
}

async function main() {
  const { server, stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const policy = await import("@/lib/contentPolicy");
  const ct = await import("@/lib/contentTopics");
  const { createStrategyVersion, structuredFromText, approveStrategyVersion } = await import("@/lib/contentStrategy");
  const { portalTopics } = await import("@/lib/portal");
  const { etMonthKey, setOwnerOverride } = await import("@/lib/contentProgram");
  const contentActions = await import("@/app/content/actions");
  const base = writeBaseTopicBank();
  const old = (await import(base.file)) as { rankRecommendations: typeof policy.rankRecommendations };

  try {
    // ======================================================================
    c.head("1 · the pure rules");
    c.ok("LIGHT at 10 per pillar → 10 (Oct 20 2026)", policy.topicsForEmphasis(10, "LIGHT") === 10);
    c.ok("LIGHT at 15 per pillar → 15", policy.topicsForEmphasis(15, "LIGHT") === 15);
    c.ok("LEAD and NORMAL keep the full count", policy.topicsForEmphasis(10, "LEAD") === 10 && policy.topicsForEmphasis(10, "NORMAL") === 10);
    c.ok("an unknown stored value reads as NORMAL", policy.asPillarEmphasis("loud") === "NORMAL" && policy.asPillarEmphasis(null) === "NORMAL" && policy.asPillarEmphasis(" light ") === "LIGHT");
    c.ok("weights LEAD 1.5 · NORMAL 1 · LIGHT 0.5", policy.PILLAR_EMPHASIS_WEIGHT.LEAD === 1.5 && policy.PILLAR_EMPHASIS_WEIGHT.NORMAL === 1 && policy.PILLAR_EMPHASIS_WEIGHT.LIGHT === 0.5);
    c.ok("a name lookup ignores case and punctuation", policy.emphasisOfPillar({ [BUYER]: "LIGHT" }, "buyer education and transaction guidance") === "NORMAL" && policy.emphasisOfPillar({ [BUYER]: "LIGHT" }, "BUYER EDUCATION & TRANSACTION GUIDANCE") === "LIGHT");
    const ordered = policy.orderByPillarEmphasis([{ n: "a", e: "LIGHT" }, { n: "b", e: "NORMAL" }, { n: "none", e: null }, { n: "c", e: "LEAD" }, { n: "d", e: "NORMAL" }], (r) => r.e, (r) => r.n !== "none");
    c.ok("ordering: LEAD, NORMAL (stable), LIGHT, then no pillar", ordered.map((r) => r.n).join(",") === "c,b,d,a,none", ordered.map((r) => r.n).join(","));

    // ======================================================================
    c.head("2 · the validator holds every pillar to the same count");
    const bankOf = (counts: Record<string, number>): import("@/lib/contentPolicy").TopicBank => ({
      clientId: null, clientName: "Arielle TEST", intro: [], strategyVersion: null, stamp: null,
      pillars: Object.entries(counts).map(([name, n]) => ({ pillarId: null, name, purpose: null, topics: Array.from({ length: n }, (_, i) => policy.makeTopic({ title: `${name.split(" ")[0]} distinct ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"][i]} subject ${i * 7}`, pillarName: name, description: "A concrete video." })) })),
    });
    const emph = { [BUYER]: "LIGHT", [SELLER]: "LEAD" };
    const v1 = policy.validateTopicBank(bankOf({ [BUYER]: 3, [SELLER]: 10, [BRAND]: 10 }), { topicsPerPillar: 10, mode: "generated", pillarEmphasis: emph });
    c.ok("3 / 10 / 10 with Buyer LIGHT is held to 10 for Buyer too", v1.findings.some((f) => f.code === "pillar.count" && f.message.includes(BUYER) && f.message.includes("exactly 10")), JSON.stringify(v1.findings.map((f) => f.message)).slice(0, 300));
    c.ok("…and reports 10 expected for every pillar", v1.counts.map((x) => x.expected).join("/") === "10/10/10", JSON.stringify(v1.counts));
    const v2 = policy.validateTopicBank(bankOf({ [BUYER]: 10, [SELLER]: 10, [BRAND]: 10 }), { topicsPerPillar: 10, mode: "generated", pillarEmphasis: emph });
    c.ok("a full 10 under the LIGHT pillar passes the count rule", !v2.findings.some((f) => f.code === "pillar.count"), JSON.stringify(v2.findings.map((f) => f.message)).slice(0, 300));
    const v3 = policy.validateTopicBank(bankOf({ [BUYER]: 3, [SELLER]: 10, [BRAND]: 10 }), { topicsPerPillar: 10, mode: "generated" });
    c.ok("with no emphasis every pillar is still held to 10 (unchanged)", v3.findings.some((f) => f.code === "pillar.count" && f.message.includes(BUYER) && f.message.includes("exactly 10")));

    // ======================================================================
    c.head("3 · the ranking: a weight below 1 really demotes");
    const t = (title: string, pillarName: string) => ({ ...policy.makeTopic({ title, pillarName, description: "A video." }), id: title });
    const rankIn = {
      bank: [t("First home inspection walkthrough", BUYER), t("Pricing your home in week one", SELLER)],
      goals: [], filmingHistory: null, priorScripts: [], capacity: 2, pillarEmphasis: { [BUYER]: 0.5 },
    };
    const oldTie = old.rankRecommendations(rankIn);
    const newTie = policy.rankRecommendations(rankIn);
    const scoreOf = (r: ReturnType<typeof policy.rankRecommendations>, p: string) => r.recommended.find((x) => x.pillar === p)?.score;
    c.ok("OLD: no goal link → the LIGHT topic scored level with the normal one", scoreOf(oldTie, BUYER) === scoreOf(oldTie, SELLER), `${scoreOf(oldTie, BUYER)} vs ${scoreOf(oldTie, SELLER)}`);
    c.ok("NEW: the LIGHT topic scores half and ranks second", (scoreOf(newTie, BUYER) ?? 9) < (scoreOf(newTie, SELLER) ?? 0) && newTie.recommended[0].pillar === SELLER, `${scoreOf(newTie, BUYER)} vs ${scoreOf(newTie, SELLER)}`);
    const filmed = [1, 2, 3].map((i) => ({ topicId: null, title: `Seller market update number ${i} for spring`, pillarName: SELLER, filmedAt: "2026-09-01", verified: true as const }));
    const histIn = { ...rankIn, filmingHistory: filmed, capacity: 1 };
    const oldHist = old.rankRecommendations(histIn);
    const newHist = policy.rankRecommendations(histIn);
    c.ok("OLD: with seller videos filmed, the LIGHT buyer topic was recommended FIRST (under-represented bonus)", oldHist.recommended[0]?.pillar === BUYER, oldHist.recommended[0]?.pillar);
    c.ok("NEW: the seller topic is recommended; the light pillar earns no under-representation bonus", newHist.recommended[0]?.pillar === SELLER && !newHist.alternatives.concat(newHist.recommended).some((r) => r.pillar === BUYER && r.reasons.some((x) => /under-represented/.test(x))), newHist.recommended[0]?.pillar);
    const leadIn = { ...rankIn, pillarEmphasis: { [SELLER]: 1.5 } };
    const lead = policy.rankRecommendations(leadIn);
    c.ok("a LEAD weight still ranks up (×1.5 over the whole score)", lead.recommended[0].pillar === SELLER && scoreOf(lead, SELLER) === 1.5 && scoreOf(lead, BUYER) === 1, `${scoreOf(lead, SELLER)} / ${scoreOf(lead, BUYER)}`);

    // ======================================================================
    c.head("4 · the staff action on Arielle-shaped pillars");
    const A = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Emphasis Drill TEST", package: "Accelerator", monthKey: etMonthKey(new Date()) });
    const text = await strategyText("Emphasis Drill TEST");
    const { stored } = structuredFromText(text);
    const sv = await createStrategyVersion({ enrollmentId: A.enrollmentId, stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof createStrategyVersion>[0]);
    const owner = await prisma.appUser.create({ data: { email: STAFF_EMAIL, name: "Jordan Drill", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
    await setOwnerOverride("ENROLLMENT", A.enrollmentId, "STRATEGY", owner.id, "drill");
    const r0 = await approveStrategyVersion(sv.versionId, STAFF_EMAIL);
    const pillars = await prisma.contentPillar.findMany({ where: { enrollmentId: A.enrollmentId }, orderBy: { sortOrder: "asc" } });
    c.ok("three pillars, Buyer first in the strategy's order", r0.pillarsCreated === 3 && pillars[0]?.name === BUYER, pillars.map((p) => p.name).join(" | "));
    c.ok("every pillar starts NORMAL", pillars.every((p) => p.emphasis === "NORMAL"));
    const pBuyer = pillars.find((p) => p.name === BUYER)!;
    const pSeller = pillars.find((p) => p.name === SELLER)!;
    const bad = await contentActions.setPillarEmphasisAction(A.enrollmentId, pBuyer.id, "LOUD");
    c.ok("a value other than Lead / Normal / Light is refused", !bad.ok, bad.message);
    const B = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Other Client TEST", package: "Starter", monthKey: etMonthKey(new Date()) });
    const otherPillar = await prisma.contentPillar.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, name: "Someone else's pillar" } });
    const cross = await contentActions.setPillarEmphasisAction(A.enrollmentId, otherPillar.id, "LIGHT");
    c.ok("another client's pillar is refused and untouched", !cross.ok && (await prisma.contentPillar.findUnique({ where: { id: otherPillar.id } }))?.emphasis === "NORMAL", cross.message);
    const light = await contentActions.setPillarEmphasisAction(A.enrollmentId, pBuyer.id, "LIGHT");
    const leadR = await contentActions.setPillarEmphasisAction(A.enrollmentId, pSeller.id, "LEAD");
    c.ok("Buyer set LIGHT, Seller set LEAD", light.ok && leadR.ok, `${light.message} / ${leadR.message}`);
    c.ok("…stored on the rows", (await prisma.contentPillar.findUnique({ where: { id: pBuyer.id } }))?.emphasis === "LIGHT" && (await prisma.contentPillar.findUnique({ where: { id: pSeller.id } }))?.emphasis === "LEAD");
    c.ok("the confirmation has no em dash", !/[—–]/.test(light.message + leadR.message));
    const same = await contentActions.setPillarEmphasisAction(A.enrollmentId, pBuyer.id, "light");
    c.ok("setting the same value again changes nothing", same.ok && /already light/.test(same.message), same.message);

    // ======================================================================
    c.head("5 · the bank run: the full count for every pillar, emphasis named");
    await prisma.programAutomation.upsert({ where: { key: "ai_runs" }, create: { key: "ai_runs", enabled: true, enabledBy: "drill", enabledAt: new Date() }, update: { enabled: true } });
    const run5 = await ct.startTopicRefresh({ enrollmentId: A.enrollmentId, kind: "BANK", requestedBy: STAFF_EMAIL });
    const row5 = await prisma.contentTopicRefreshRun.findUnique({ where: { id: run5.runId } });
    c.ok("the bank run SUCCEEDED with one model call", row5?.status === "SUCCEEDED" && aiCalls === 1, `${row5?.status} ${row5?.lastError ?? row5?.changeSummary ?? ""}`);
    const sys = prompts[0]?.system ?? "";
    c.ok("the prompt asks every pillar for 10, the LIGHT one too", /exactly 10 topics under EACH of the client's 3 pillars/.test(sys) && sys.includes("= 30 topics"), (/COUNT:[^\n]+/.exec(sys)?.[0] ?? "").slice(0, 300));
    c.ok("…names the LEAD pillar as the main focus", new RegExp(`LEAD pillars \\(the client's main focus[^)]*\\): ${SELLER}\\.`).test(sys), /EMPHASIS:[^\n]+/.exec(sys)?.[0]);
    c.ok("…and the LIGHT pillar as supporting, with its full count", new RegExp(`LIGHT pillars \\(supporting; they still get their full count[^)]*\\): ${BUYER.replace(/[&]/g, "\\&")}\\.`).test(sys), /EMPHASIS:[^\n]+/.exec(sys)?.[0]);
    c.ok("the prompt has no em dash in the new lines", !/[—–]/.test((/COUNT:[^\n]+/.exec(sys)?.[0] ?? "") + (/EMPHASIS:[^\n]+/.exec(sys)?.[0] ?? "")));
    const sugg = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: A.enrollmentId, disposition: "PENDING" } });
    const per = (id: string) => sugg.filter((s) => s.pillarId === id).length;
    c.ok("the model sent 10 for Buyer; all 10 were kept", per(pBuyer.id) === 10 && per(pSeller.id) === 10 && sugg.length === 30, `${per(pBuyer.id)} / ${per(pSeller.id)} / ${sugg.length}`);
    const plainPrompt = policy.buildTopicBankPrompt((await (await import("@/lib/contentGeneration")).buildClientContext(A.enrollmentId)).ctx);
    c.ok("with no emphasis map the prompt reads as before (10 under EACH, no EMPHASIS line)", /exactly 10 topics under EACH of the client's 3 pillars/.test(plainPrompt.system) && !/EMPHASIS:/.test(plainPrompt.system));
    for (const s of sugg) await ct.acceptSuggestion(s.id, STAFF_EMAIL);
    const stock = await ct.bankStock(A.enrollmentId);
    const st = (id: string) => stock.find((p) => p.pillarId === id);
    c.ok("refill target: 10 for Buyer (light) and Seller alike", st(pBuyer.id)?.target === 10 && st(pSeller.id)?.target === 10, JSON.stringify(stock.map((p) => [p.pillarName, p.usable, p.target, p.need])));
    c.ok("…every pillar at target, nothing needed", stock.every((p) => p.need === 0));

    // ======================================================================
    c.head("6 · the recommendation run");
    const rec = await ct.startTopicRefresh({ enrollmentId: A.enrollmentId, kind: "RECOMMENDATION", requestedBy: STAFF_EMAIL, monthId: A.monthId });
    const recRun = await prisma.contentTopicRefreshRun.findUnique({ where: { id: rec.runId } });
    const recs = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: rec.runId }, orderBy: { rank: "asc" } });
    const recommended = recs.filter((r) => r.kind === "RECOMMENDED");
    c.ok("the run recommended something", recRun?.status === "SUCCEEDED" && recommended.length > 0, `${recRun?.status} ${recRun?.changeSummary ?? ""}`);
    c.ok("no LIGHT (buyer) topic is recommended", !recommended.some((r) => r.pillarId === pBuyer.id), recommended.map((r) => r.title).join(" | "));
    c.ok("rank 1 is the LEAD (seller) pillar", recommended[0]?.pillarId === pSeller.id, recommended[0]?.title);
    c.ok("no model call for the ranking", aiCalls === 1);

    // ======================================================================
    c.head("7 · the client's topic bank: LEAD first, LIGHT last");
    const staffOrder = (await ct.topicBankByPillar(A.enrollmentId)).groups.map((g) => g.pillarName);
    c.ok("the staff bank keeps the strategy's order (Buyer first)", staffOrder[0] === BUYER, staffOrder.join(" | "));
    const page = await portalTopics({ id: A.enrollmentId, clientId: A.clientId });
    const order = page.groups.map((g) => g.pillarName);
    c.ok("the portal shows Seller, Personal Branding, Buyer", order.join(" | ") === [SELLER, BRAND, BUYER].join(" | "), order.join(" | "));
    c.ok("…with all 30 accepted topics", page.total === 30, `${page.total}`);
    await contentActions.setPillarEmphasisAction(A.enrollmentId, pBuyer.id, "NORMAL");
    await contentActions.setPillarEmphasisAction(A.enrollmentId, pSeller.id, "NORMAL");
    const back = (await portalTopics({ id: A.enrollmentId, clientId: A.clientId })).groups.map((g) => g.pillarName);
    c.ok("all NORMAL again → the strategy's order again", back[0] === BUYER, back.join(" | "));

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
