// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: A CLIENT'S PILLARS ARE EXACTLY THE CONFIRMED ONES (Oct 23 2026).
//
// Jordan: "I'm not sure why we have Pillar labels to map. We should just
// stick to their confirmed pillars that are in their content strategy, unless
// we discuss adding a new one on a strategy call or I add a new one in the
// hub."
//
//   1. The rule (contentPolicy/pillarMatch): name, alias, spelling ("Pillar 3:",
//      "&"/"and"), the first matching part, else the closest pillar when it is
//      close, clear of the next, shares a telling word and is not the other
//      side of the deal; else nothing.
//   2. Approving a strategy version still creates its pillars; "Add pillar"
//      still works. They are the confirmed pillars.
//   3. Generation picks only from the confirmed pillars: the schema's enum is
//      exactly their names, a stray "Pillar 2: X" lands on X, an unknown or
//      retired pillar's ideas are dropped, and no pillar is created.
//   4. Imports never create a pillar: a topic bank document's unknown heading
//      leaves its topics with no pillar (an id smuggled into the preview is
//      ignored), a script's unknown Category leaves it with none, a strategy
//      document's pillars wait for approval.
//   5. Call topics, the portal and the call-analysis schema stay inside the
//      confirmed pillars.
//   6. The Strategy tab has no "Pillar labels to map" section; the import
//      panel asks nothing about labels; the mapping actions are gone.
//   7. The Oct 23 repair rule (unlinkedPillarLabels + linkPillarLabel, what
//      scripts/_live/oct23-pillar-labels-auto-map.ts runs): links old labels
//      by the rule with history, leaves the far / dismissed / dimension ones,
//      files a script without touching its words or updatedAt, refuses a
//      retired or foreign pillar, and creates no pillar.
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness; the model is stubbed
// at aiJsonWithUsage; every outbound call is fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 7241);
const REPO = path.resolve(__dirname, "..", "..");
const STAFF_EMAIL = "dev@local";

installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown };
navigation.useRouter = () => ({ refresh() {} });

// ---- the model boundary ----
type BankGroup = { pillarName: string; topics: { title: string; description: string; audienceNeed: string; businessGoal: string; intendedMessage: string; sourceRef: null }[] };
const bankCalls: { system: string; prompt: string; schema: Record<string, unknown> }[] = [];
let bankGroups: string[] = [];
let unexpected = 0;
const VOCAB = ["harbor", "quartz", "mitten", "lantern", "falcon", "velvet", "cobalt", "pepper", "tundra", "orchid", "basalt", "wicker", "saddle", "jigsaw", "nectar", "pylon", "gravel", "umbra", "kettle", "zephyr", "meadow", "rocket", "sphinx", "bonsai", "dynamo", "iguana", "lychee", "mosaic", "nimbus", "oyster", "plinth", "quiver", "raptor", "sorbet", "tulip", "vortex", "walrus", "yonder", "zircon", "anchor", "bugle", "cactus", "dahlia", "ember", "fjord", "gazebo", "hazel", "ivory", "jasper", "kiosk"];
function distinctTitle(key: string): string {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const pick = (n: number) => VOCAB[(h >>> (n * 7)) % VOCAB.length];
  const w = [pick(0), pick(1), pick(2)];
  return `${w[0][0].toUpperCase()}${w[0].slice(1)} ${w[1]} ${w[2]} ${key}`;
}
/** The ideas the stub writes under a group, by group label (their titles carry the label's slug, so a dropped group's ideas are findable). */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
interceptModule(
  (r) => r === "@/lib/integrations/ai" || /[\\/]integrations[\\/]ai(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string; schema: Record<string, unknown> }) => {
        const usage = { inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };
        if (/Video Topic Bank/.test(opts.system)) {
          bankCalls.push({ system: opts.system, prompt: opts.prompt, schema: opts.schema });
          const pillars: BankGroup[] = bankGroups.map((label) => ({
            pillarName: label,
            topics: Array.from({ length: 10 }, (_, i) => ({ title: distinctTitle(`${slug(label)}-${i}`), description: `A video about idea ${i} for ${label}.`, audienceNeed: "Sellers deciding when to list", businessGoal: "Trust", intendedMessage: "Plan before you list", sourceRef: null })),
          }));
          return { result: { complete: true, pillars, gaps: [] }, usage, model: "drill-stub" };
        }
        unexpected++;
        throw new Error(`unexpected model call in this drill: ${opts.system.slice(0, 80)}`);
      };
    },
  }),
);

/** A two-pillar strategy in the house template, rendered by the policy's renderer. */
async function strategyText(name: string, pillars: { name: string; purpose: string; focusAreas: string }[]): Promise<string> {
  const { renderStrategy } = await import("@/lib/contentPolicy");
  const doc = {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice, local depth.", brandMessage: "Plan the sale before the sign goes up.", shortBrandStatement: null, brandVoice: "Plain, direct, warm.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Bucks County", pricePositioning: null, primaryClientTypes: "Move-up sellers and first-time buyers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers", "Show local market expertise"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Lead with pricing and timing."], pillars: pillars.map((p, i) => ({ number: i + 1, name: p.name, heading: `Pillar ${i + 1}: ${p.name}`, purpose: p.purpose, focusAreas: p.focusAreas, contentApproach: null, otherFields: [] })) },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PRICE for a pricing plan."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["Lead with pricing and timing this quarter."] }, otherSections: [],
  };
  return renderStrategy(doc as unknown as Parameters<typeof renderStrategy>[0]);
}

async function main(): Promise<void> {
  const drill = await bootDrillDb({ port: PORT });
  const fence = fenceFetch();
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const pm = await import("@/lib/contentPolicy");
    const cp = await import("@/lib/contentPillars");
    const ct = await import("@/lib/contentTopics");
    const { createStrategyVersion, structuredFromText, approveStrategyVersion } = await import("@/lib/contentStrategy");
    const { previewImport, applyImport } = await import("@/lib/contentImport");
    const { createScriptVersion } = await import("@/lib/contentScripts");
    const contentActions = await import("@/app/content/actions");
    const portalActions = await import("@/app/portal/actions");
    const gen = await import("@/lib/contentGeneration");

    // ======================================================================
    c.head("1 · the rule");
    const P = [{ id: "s", name: "Seller Strategy & Listing Positioning" }, { id: "b", name: "Buyer Education & Protection", aliases: ["Buyer Basics"] }, { id: "l", name: "Lehigh Valley Lifestyle & Local Authority" }];
    const m = (label: string) => pm.matchPillarLabel(label, P);
    c.ok("its name → name", m("seller strategy & listing positioning")?.how === "name");
    c.ok("an alias → alias", m("Buyer Basics")?.pillarId === "b" && m("Buyer Basics")?.how === "alias");
    c.ok("'Pillar 2: Buyer Education and Protection' → spelling", m("Pillar 2: Buyer Education and Protection")?.pillarId === "b" && m("Pillar 2: Buyer Education and Protection")?.how === "spelling");
    c.ok("'Crypto / Buyer Basics' → the part that matches", m("Crypto / Buyer Basics")?.pillarId === "b" && m("Crypto / Buyer Basics")?.how === "part");
    c.ok("'Seller Strategy' → the closest", m("Seller Strategy")?.pillarId === "s" && m("Seller Strategy")?.how === "closest", JSON.stringify(m("Seller Strategy")));
    c.ok("'Local Authority' → the closest", m("Local Authority")?.pillarId === "l");
    c.ok("'Seller Education' is never the buyer pillar (the other side of the deal)", m("Seller Education")?.pillarId !== "b", JSON.stringify(m("Seller Education")));
    c.ok("'Education / Both' shares only a general word → nothing", m("Education / Both") === null);
    c.ok("'Trust / Value' is a quality dimension → nothing", m("Trust / Value") === null && pm.isQualityDimensionLabel("Trust / Value"));
    c.ok("'Crypto Tips' → nothing", m("Crypto Tips") === null);
    c.ok("no confirmed pillars → nothing", pm.matchPillarLabel("Seller Strategy", []) === null);
    const tie = pm.closestPillar("Market Homes", [{ id: "x", name: "Market Insights" }, { id: "y", name: "Market Reports" }]);
    c.ok("two pillars equally close → ambiguous, nothing", tie.match === null && /ambiguous|too far|telling/.test(tie.reason), tie.reason);

    // ======================================================================
    c.head("2 · approving a strategy creates its pillars; Add pillar still works");
    const owner = await prisma.appUser.create({ data: { email: STAFF_EMAIL, name: "Jordan Drill", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
    void owner;
    const A = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Confirmed Pillars TEST", package: "Accelerator", project: false });
    const text = await strategyText("Confirmed Pillars TEST", [
      { name: "Market Authority", purpose: "Show command of the local market.", focusAreas: "pricing, timing, days on market" },
      { name: "Seller Education", purpose: "Teach sellers what to do before listing.", focusAreas: "prep, repairs, inspections" },
    ]);
    const { stored } = structuredFromText(text);
    const sv = await createStrategyVersion({ enrollmentId: A.enrollmentId, stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof createStrategyVersion>[0]);
    c.ok("a draft version makes no pillar", (await prisma.contentPillar.count({ where: { enrollmentId: A.enrollmentId } })) === 0);
    const approved = await approveStrategyVersion(sv.versionId, STAFF_EMAIL);
    const afterApprove = await prisma.contentPillar.findMany({ where: { enrollmentId: A.enrollmentId }, select: { id: true, name: true, strategyVersionId: true } });
    c.ok("approving it creates its two pillars, tied to the version", approved.pillarsCreated === 2 && afterApprove.length === 2 && afterApprove.every((p) => p.strategyVersionId === sv.versionId), JSON.stringify(afterApprove.map((p) => p.name)));
    const MA = afterApprove.find((p) => p.name === "Market Authority")!.id;
    const SE = afterApprove.find((p) => p.name === "Seller Education")!.id;
    const add = await contentActions.addPillar(A.enrollmentId, "Local Life", "Show the town.", "places, events");
    const LL = (await prisma.contentPillar.findFirst({ where: { enrollmentId: A.enrollmentId, name: "Local Life" }, select: { id: true } }))?.id ?? "";
    c.ok("\"Add pillar\" adds one", add.ok && !!LL, add.message);
    const again = await contentActions.addPillar(A.enrollmentId, "Pillar 3: Local Life", "", "");
    c.ok("…and adding the same name again (numbered) makes no second one", again.ok && (await prisma.contentPillar.count({ where: { enrollmentId: A.enrollmentId } })) === 3);
    // A retired pillar: confirmed once, not any more.
    const MM = await cp.createPillar({ enrollmentId: A.enrollmentId, clientId: A.clientId, name: "Mortgage Myths", createdBy: "drill" });
    await cp.retirePillar(MM);
    const pillarCount = async () => prisma.contentPillar.count();
    const baseline = await pillarCount();
    const pillarNames = async () => (await prisma.contentPillar.findMany({ where: { enrollmentId: A.enrollmentId }, select: { name: true } })).map((p) => p.name).sort();

    // ======================================================================
    c.head("3 · generation picks only from the confirmed pillars");
    bankGroups = ["Market Authority", "Pillar 2: Seller Education", "Local Life", "Crypto Tips", "Mortgage Myths"];
    const run = await ct.startTopicRefresh({ enrollmentId: A.enrollmentId, kind: "BANK", requestedBy: STAFF_EMAIL });
    const row = await prisma.contentTopicRefreshRun.findUnique({ where: { id: run.runId } });
    c.ok("one bank call, run SUCCEEDED", bankCalls.length === 1 && row?.status === "SUCCEEDED", `${bankCalls.length} ${row?.status} ${row?.lastError ?? ""}`);
    const call = bankCalls[0];
    const enumOf = (schema: Record<string, unknown>) => (((((schema?.properties as Record<string, Record<string, unknown>>)?.pillars?.items as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>>)?.pillarName?.enum) as string[] | undefined) ?? [];
    c.ok("the schema holds pillarName to EXACTLY the confirmed names (an enum)", JSON.stringify([...enumOf(call?.schema ?? {})].sort()) === JSON.stringify(["Local Life", "Market Authority", "Seller Education"]), JSON.stringify(enumOf(call?.schema ?? {})));
    c.ok("the prompt lists them (the hub-added one too) and says never another", /PILLARS: the client's confirmed pillars are exactly these: .*"Local Life"/.test(call?.system ?? "") && /never a new pillar/.test(call?.system ?? ""));
    c.ok("the retired pillar is not offered", !/Mortgage Myths/.test(`${call?.system}\n${call?.prompt}`) && !enumOf(call?.schema ?? {}).includes("Mortgage Myths"));
    const sugg = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: run.runId }, select: { title: true, pillarId: true } });
    const confirmed = new Set([MA, SE, LL]);
    c.ok("every stored idea is under a confirmed pillar", sugg.length > 0 && sugg.every((s) => s.pillarId && confirmed.has(s.pillarId)), `${sugg.length}`);
    c.ok("'Pillar 2: Seller Education' landed on Seller Education", sugg.filter((s) => s.title.includes("pillar-2-seller-education")).every((s) => s.pillarId === SE) && sugg.some((s) => s.pillarId === SE));
    c.ok("the hub-added pillar got its ideas", sugg.some((s) => s.pillarId === LL));
    c.ok("no idea from 'Crypto Tips' or the retired pillar was stored", !sugg.some((s) => /crypto-tips|mortgage-myths/.test(s.title)) && (await prisma.contentTopic.count({ where: { title: { contains: "crypto-tips" } } })) === 0);
    const mc = JSON.parse(row?.missingContextJson ?? "{}") as { droppedPillars?: string[] };
    c.ok("the run records what it dropped and why", (mc.droppedPillars ?? []).some((d) => /Crypto Tips/.test(d)) && (mc.droppedPillars ?? []).some((d) => /Mortgage Myths/.test(d)) && /outside the confirmed pillars dropped/.test(row?.changeSummary ?? ""), `${JSON.stringify(mc)} | ${row?.changeSummary}`);
    c.ok("no pillar was created", (await pillarCount()) === baseline, JSON.stringify(await pillarNames()));
    // Every group unknown: nothing stored, still no pillar.
    bankGroups = ["Crypto Tips", "Luxury Yachts"];
    const run2 = await ct.startTopicRefresh({ enrollmentId: A.enrollmentId, kind: "REFRESH", requestedBy: STAFF_EMAIL });
    const row2 = await prisma.contentTopicRefreshRun.findUnique({ where: { id: run2.runId } });
    c.ok("a bank of only unknown pillars stores nothing (NEEDS_INPUT) and makes no pillar", row2?.status === "NEEDS_INPUT" && (await prisma.contentTopicSuggestion.count({ where: { refreshRunId: run2.runId } })) === 0 && (await pillarCount()) === baseline, `${row2?.status}`);

    // ======================================================================
    c.head("4 · imports never create a pillar");
    const doc = [
      "## Pillar 2: Seller Education", "1. **Staging the front porch first**", "Why curb appeal sets the price.", "",
      "## Market Authority Tips", "1. **Reading days on market**", "What the number tells a buyer.", "",
      "## Crypto Tips", "1. **Paying for a house in bitcoin**", "Should you?", "",
    ].join("\n");
    const pv = await previewImport({ kind: "TOPICS", enrollmentId: A.enrollmentId, fileName: "topics-2026-09.md", text: doc });
    const item = (title: string) => pv.items.find((i) => i.title === title)!;
    c.ok("the preview carries no mapping list", !("unmappedPillarLabels" in pv));
    c.ok("'Pillar 2: Seller Education' → Seller Education", item("Staging the front porch first")?.pillarId === SE, JSON.stringify(item("Staging the front porch first")));
    c.ok("'Market Authority Tips' → Market Authority (closest), with the reason", item("Reading days on market")?.pillarId === MA && /closest/.test(item("Reading days on market")?.pillarWhy ?? ""), item("Reading days on market")?.pillarWhy ?? "");
    c.ok("'Crypto Tips' → no pillar, said so", item("Paying for a house in bitcoin")?.pillarId === null && /no confirmed pillar is close/.test(item("Paying for a house in bitcoin")?.pillarWhy ?? ""));
    // An id smuggled into the preview (it round-trips through the browser) is not trusted.
    const tampered = { ...pv, items: pv.items.map((i) => (i.title === "Paying for a house in bitcoin" ? { ...i, pillarId: LL } : i)) };
    const ap = await applyImport(tampered, { monthKey: null, modes: {} }, STAFF_EMAIL);
    const imported = await prisma.contentTopic.findMany({ where: { enrollmentId: A.enrollmentId, source: "import" }, select: { title: true, pillarId: true, pillar: true } });
    const it = (title: string) => imported.find((t) => t.title === title);
    c.ok("applied: three topics", ap.created === 3 && imported.length === 3, JSON.stringify(ap));
    c.ok("…the known labels on their pillars", it("Staging the front porch first")?.pillarId === SE && it("Reading days on market")?.pillarId === MA);
    c.ok("…the unknown one with no pillar (its label kept as text), the smuggled id ignored", it("Paying for a house in bitcoin")?.pillarId === null && it("Paying for a house in bitcoin")?.pillar === "Crypto Tips");
    c.ok("…and no pillar was created", (await pillarCount()) === baseline);
    // A script import whose Category names no confirmed pillar.
    const parts = (cat: string) => ({ title: `Imported ${cat}`, categoryLabel: cat, hook: "The first weekend decides it.", points: [{ role: "re-hook" as const, text: "Buyers read days on market." }, { role: "build-up" as const, text: "Stale listings invite low offers." }, { role: "payoff" as const, text: "Price it right on day one." }], close: "Plan before the photos." });
    const s1 = await createScriptVersion({ enrollmentId: A.enrollmentId, parts: parts("Pillar 1: Market Authority"), source: "IMPORT", createdBy: STAFF_EMAIL, historical: true, sourceFile: "scripts.pdf" });
    const s2 = await createScriptVersion({ enrollmentId: A.enrollmentId, parts: parts("Crypto Tips"), source: "IMPORT", createdBy: STAFF_EMAIL, historical: true, sourceFile: "scripts.pdf" });
    const v1 = await prisma.contentScriptVersion.findUnique({ where: { id: s1.versionId }, select: { pillarId: true } });
    const v2 = await prisma.contentScriptVersion.findUnique({ where: { id: s2.versionId }, select: { pillarId: true, categoryLabel: true } });
    c.ok("an imported script's 'Pillar 1: Market Authority' → Market Authority", v1?.pillarId === MA);
    c.ok("an imported script's unknown Category keeps no pillar, words kept", v2?.pillarId === null && v2?.categoryLabel === "Crypto Tips" && (await pillarCount()) === baseline);
    // A strategy document's pillars wait for approval.
    const sText = await strategyText("Confirmed Pillars TEST", [{ name: "Luxury Condos", purpose: "High-end condos.", focusAreas: "amenities" }, { name: "Market Authority", purpose: "Market.", focusAreas: "pricing" }]);
    const spv = await previewImport({ kind: "STRATEGY", enrollmentId: A.enrollmentId, fileName: "strategy-v3.md", text: sText });
    c.ok("a strategy document's preview says its pillars come with approval", spv.notes.some((n) => /become the client's pillars when this version is approved/.test(n)), spv.notes.join(" | "));
    await applyImport(spv, { monthKey: null, modes: {} }, STAFF_EMAIL);
    c.ok("…applying it makes a version, not a pillar", (await pillarCount()) === baseline && !(await prisma.contentPillar.findFirst({ where: { name: "Luxury Condos" } })));

    // ======================================================================
    c.head("5 · call topics, the portal and the call analysis stay inside the confirmed pillars");
    const STAFF = { kind: "STAFF" as const, staffUserId: STAFF_EMAIL };
    const t1 = await ct.createTopic({ enrollmentId: A.enrollmentId, title: "Call topic about pricing week one", pillarLabel: "Pillar 1: Market Authority", source: "strategy_call", actor: STAFF });
    const t2 = await ct.createTopic({ enrollmentId: A.enrollmentId, title: "Call topic about yachts", pillarLabel: "Luxury Yachts", source: "strategy_call", actor: STAFF });
    const t3 = await ct.createTopic({ enrollmentId: A.enrollmentId, title: "Call topic about myths", pillarLabel: "Mortgage Myths", source: "strategy_call", actor: STAFF });
    const pid = async (id: string) => (await prisma.contentTopic.findUnique({ where: { id }, select: { pillarId: true } }))?.pillarId ?? null;
    c.ok("a call topic's 'Pillar 1: Market Authority' → Market Authority", (await pid(t1.id)) === MA);
    c.ok("a call topic's unknown pillar → none", (await pid(t2.id)) === null);
    c.ok("a call topic naming the RETIRED pillar → none (new topics link to current pillars only)", (await pid(t3.id)) === null);
    const sch = gen.analysisSchemaFor(["Market Authority", "Seller Education", "Local Life"]) as unknown as { properties: Record<string, { items: { properties: { pillar: { enum?: unknown[] } } } }> };
    c.ok("the call analysis schema holds a topic's pillar to the confirmed names or null", JSON.stringify(sch.properties.discussedTopics.items.properties.pillar.enum) === JSON.stringify(["Market Authority", "Seller Education", "Local Life", null]) && JSON.stringify(sch.properties.selectedTopics.items.properties.pillar.enum) === JSON.stringify(["Market Authority", "Seller Education", "Local Life", null]));
    c.ok("…and with no pillars yet it is free text, as before", !("enum" in ((gen.analysisSchemaFor([]) as unknown as typeof sch).properties.discussedTopics.items.properties.pillar)));
    const okIdea = await portalActions.portalSuggestTopic({ token: A.portalToken }, { title: "Client idea on pricing", pillarId: MA });
    const retiredIdea = await portalActions.portalSuggestTopic({ token: A.portalToken }, { title: "Client idea on myths", pillarId: MM });
    c.ok("a client's idea under a current pillar keeps it", okIdea.ok && !!okIdea.id && (await pid(okIdea.id)) === MA, okIdea.message);
    c.ok("a client's idea naming a retired pillar gets none", retiredIdea.ok && !!retiredIdea.id && (await pid(retiredIdea.id)) === null, retiredIdea.message);
    c.ok("still no pillar created", (await pillarCount()) === baseline);

    // ======================================================================
    c.head("6 · no mapping section, no mapping question, no mapping actions");
    const { loadStrategyTab } = await import("@/app/content/[id]/programData");
    const { StrategyPanel } = await import("@/components/content/StrategyPanel");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
    const ser = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
    const tab = await loadStrategyTab(A.enrollmentId, null);
    const html = plain(renderToStaticMarkup(createElement(StrategyPanel, ser({ enrollmentId: A.enrollmentId, versions: tab.versions, proposals: tab.proposals, pillars: tab.pillars, owners: tab.owners, staff: tab.staff, isOwner: true, month: null, discovery: tab.discovery, queueActive: tab.queueActive }))));
    c.ok("the Strategy tab loader carries no mapping list", !("mapping" in tab));
    c.ok("the Strategy tab shows the confirmed pillars (the hub-added one too)", /Content pillars/.test(html) && /Market Authority/.test(html) && /Local Life/.test(html));
    c.ok("…and no \"Pillar labels to map\" section, nothing to confirm or dismiss", !/Pillar labels to map/i.test(html) && !/Not a pillar/.test(html) && !/choose a pillar/i.test(html) && !/labels on old topics/i.test(html));
    c.ok("the mapping actions are gone", !("confirmPillarMappingAction" in contentActions) && !("dismissPillarLabelAction" in contentActions));
    const importPanel = fs.readFileSync(path.join(REPO, "src/components/content/ImportPanel.tsx"), "utf8");
    c.ok("the import panel asks nothing about labels", !/map them now/i.test(importPanel) && !/unmappedPillarLabels/.test(importPanel) && !/pillarMap/.test(importPanel));
    const panel = fs.readFileSync(path.join(REPO, "src/components/content/StrategyPanel.tsx"), "utf8");
    c.ok("the Strategy panel has no mapping component left", !/MappingItem|MappingRowUi|Pillar labels to map/.test(panel.replace(/^\/\/.*$/gm, "")));
    // Who may create a pillar: only the strategy approval and "Add pillar".
    const callers: string[] = [];
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(e.name) && !f.endsWith("contentPillars.ts")) { const s = fs.readFileSync(f, "utf8"); if (/\bcreatePillar\(|contentPillar\.create\(/.test(s)) callers.push(path.relative(REPO, f)); } } };
    walk(path.join(REPO, "src"));
    c.ok("createPillar is called only by the strategy approval and the Add pillar action", JSON.stringify(callers.sort()) === JSON.stringify(["src/app/content/actions.ts", "src/lib/contentStrategy.ts"]), JSON.stringify(callers));
    const actionsSrc = fs.readFileSync(path.join(REPO, "src/app/content/actions.ts"), "utf8");
    c.ok("…in actions.ts, from addPillar only", (actionsSrc.match(/\bcreatePillar\(/g) ?? []).length === 1 && /export async function addPillar[\s\S]{0,600}createPillar\(/.test(actionsSrc));

    // ======================================================================
    c.head("7 · the Oct 23 repair rule");
    const topic = (title: string, label: string) => prisma.contentTopic.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, title, pillar: label }, select: { id: true } });
    const old1 = await topic("Old numbered one", "Pillar 1: Market Authority");
    const old2 = await topic("Old numbered two", "Pillar 1: Market Authority");
    const old3 = await topic("Old two-part one", "Seller Education / Buyer Education");
    const old4 = await topic("Old lifestyle one", "Local Lifestyle");
    const old5 = await topic("Old buyer one", "Buyer Education");
    const old6 = await topic("Old dimension one", "Trust / Value");
    const old7 = await topic("Old dismissed one", "Seller Strategy Stuff");
    await prisma.appSetting.create({ data: { key: `pillar-dismissed-${A.enrollmentId}`, value: JSON.stringify(["Seller Strategy Stuff"]) } });
    // An old script filed before the pillar existed: its current version says "Pillar 1: Market Authority" and nothing is linked.
    const s3 = await createScriptVersion({ enrollmentId: A.enrollmentId, parts: { ...parts("Crypto Tips"), title: "Old script about pricing" }, source: "IMPORT", createdBy: STAFF_EMAIL, historical: true, sourceFile: "old.pdf" });
    await prisma.contentScriptVersion.update({ where: { id: s3.versionId }, data: { categoryLabel: "Pillar 1: Market Authority", pillarId: null } });
    await prisma.contentScript.update({ where: { id: s3.scriptId }, data: { pillarId: null, updatedAt: new Date("2026-01-02T03:04:05Z") } });
    const verBefore = await prisma.contentScriptVersion.findUnique({ where: { id: s3.versionId } });

    const rows = await cp.unlinkedPillarLabels(A.enrollmentId);
    const r = (label: string) => rows.find((x) => x.label === label);
    c.ok("it lists what the old section listed, plus the unlinked script", !!r("Pillar 1: Market Authority") && r("Pillar 1: Market Authority")!.topicCount === 2 && r("Pillar 1: Market Authority")!.scriptCount === 1, JSON.stringify(rows.map((x) => [x.label, x.topicCount, x.scriptCount])));
    c.ok("'Pillar 1: Market Authority' → Market Authority (spelling)", r("Pillar 1: Market Authority")?.match?.pillarId === MA && r("Pillar 1: Market Authority")?.match?.how === "spelling");
    c.ok("'Seller Education / Buyer Education' → Seller Education (part)", r("Seller Education / Buyer Education")?.match?.pillarId === SE && r("Seller Education / Buyer Education")?.match?.how === "part");
    c.ok("'Local Lifestyle' → Local Life (closest)", r("Local Lifestyle")?.match?.pillarId === LL && r("Local Lifestyle")?.match?.how === "closest", JSON.stringify(r("Local Lifestyle")));
    c.ok("'Buyer Education' → none (never the seller pillar)", r("Buyer Education")?.match === null, JSON.stringify(r("Buyer Education")));
    c.ok("'Trust / Value' → none, a quality dimension", r("Trust / Value")?.match === null && /quality dimension/.test(r("Trust / Value")?.reason ?? ""));
    c.ok("'Crypto Tips' (the earlier import) → none, too far", r("Crypto Tips")?.match === null && !!r("Crypto Tips")?.reason);
    c.ok("the label Jordan dismissed is marked dismissed", r("Seller Strategy Stuff")?.dismissed === true);
    // What the repair does with them, through the app's own function.
    const BY = "pillar label auto-map (drill)";
    for (const x of rows) if (x.match && !x.dismissed) await cp.linkPillarLabel(A.enrollmentId, x.label, x.match.pillarId, BY, { why: `${x.match.how}: ${x.match.why}`, actorKind: "SYSTEM" });
    c.ok("the matched topics are linked", (await pid(old1.id)) === MA && (await pid(old2.id)) === MA && (await pid(old3.id)) === SE && (await pid(old4.id)) === LL);
    c.ok("the far, dimension and dismissed ones keep no pillar", (await pid(old5.id)) === null && (await pid(old6.id)) === null && (await pid(old7.id)) === null && (await pid(t2.id)) === null);
    const ev = await prisma.contentTopicEvent.findFirst({ where: { topicId: old4.id, kind: "RECONCILED" } });
    c.ok("each link is on the topic's history, with why", ev?.actorKind === "SYSTEM" && /linked to the confirmed pillar “Local Life”/.test(ev?.note ?? "") && /closest/.test(ev?.note ?? ""), ev?.note ?? "none");
    const scr = await prisma.contentScript.findUnique({ where: { id: s3.scriptId }, select: { pillarId: true, updatedAt: true } });
    const verAfter = await prisma.contentScriptVersion.findUnique({ where: { id: s3.versionId } });
    c.ok("the old script is filed under Market Authority, its updatedAt kept", scr?.pillarId === MA && scr?.updatedAt.toISOString() === "2026-01-02T03:04:05.000Z", `${scr?.pillarId} ${scr?.updatedAt.toISOString()}`);
    c.ok("…its version (words, label, link) untouched", JSON.stringify(verAfter) === JSON.stringify(verBefore));
    c.ok("…with an audit-log row", !!(await prisma.auditLog.findFirst({ where: { action: "script_pillar_linked", target: s3.scriptId } })));
    c.ok("a matched label is not made an alias: the pillars' names stay their own", !(await prisma.contentPillarAlias.findFirst({ where: { name: { in: ["Local Lifestyle", "Seller Education / Buyer Education", "Pillar 1: Market Authority"] } } })));
    let refusedRetired = false, refusedForeign = false;
    try { await cp.linkPillarLabel(A.enrollmentId, "Buyer Education", MM, BY); } catch { refusedRetired = true; }
    const B = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Other Client TEST", package: "Starter", project: false });
    const foreign = await cp.createPillar({ enrollmentId: B.enrollmentId, clientId: B.clientId, name: "Buyer Education", createdBy: "drill" });
    try { await cp.linkPillarLabel(A.enrollmentId, "Buyer Education", foreign, BY); } catch { refusedForeign = true; }
    c.ok("a retired pillar and another client's pillar are refused", refusedRetired && refusedForeign && (await pid(old5.id)) === null);
    const rest = await cp.unlinkedPillarLabels(A.enrollmentId);
    c.ok("a second pass finds only what was left", rest.every((x) => !x.match || x.dismissed) && rest.some((x) => x.label === "Buyer Education"), JSON.stringify(rest.map((x) => [x.label, x.match?.pillarName ?? null, x.match?.how ?? null, x.dismissed])));
    c.ok("no pillar was created by any of it (one for the other client, made here on purpose)", (await pillarCount()) === baseline + 1);
    const live = fs.readFileSync(path.join(REPO, "scripts/_live/oct23-pillar-labels-auto-map.ts"), "utf8").replace(/^\/\/.*$/gm, "");
    c.ok("the live repair calls the same two functions and never creates a pillar", /unlinkedPillarLabels/.test(live) && /linkPillarLabel/.test(live) && !/createPillar|contentPillar\.create|syncPillarsFromVersion/.test(live) && /default_transaction_read_only/.test(live));

    c.ok("no unexpected model call; nothing left the machine", unexpected === 0 && fence.blocked.length === 0, `${unexpected} ${JSON.stringify(fence.blocked).slice(0, 200)}`);
    c.summary();
  } finally {
    quiet.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();
