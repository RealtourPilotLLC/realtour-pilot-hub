// ---------------------------------------------------------------------------
// Oct 20 2026 — Erica Walker's content pillars and video topics. Jordan: "Fix
// Erica Walker's video topics in her content program ... We can update her
// content pillars in her content strategy to these pillars", with five
// pillars and 22 topics of his own.
//
// Her bank had four pillars whose stock was 40 ideas still waiting on review
// (none visible to her), so her portal showed little more than the old
// imported list under "More ideas". This script:
//
//   1 · backs up her pillars, strategy versions, topics, suggestions and
//       selections (on top of the full content-program backup run first);
//   2 · renames her four pillars to Jordan's names (same ids, the old names
//       stay as aliases, so every topic and script keeps its pillar):
//         New Construction & Builder Collaboration → Builder Partnerships
//         Seller Strategy & Move-Up Planning      → Move-Up Buyers and Sellers
//         Personal Brand & Client Experience      → Personal Brand and Client Stories
//         Chester County Lifestyle & Local Connection → Local Lifestyle
//   3 · writes the strategy's Content Pillars section with the five pillars
//       (a new version, the rest of the document unchanged), approves it as
//       Jordan (which creates the new Custom-Home Buyers pillar) and puts it
//       in her portal (an update goes in quietly: no email);
//   4 · gives each pillar its purpose, focus areas and Jordan's order;
//   5 · adds Jordan's 22 topics under their pillars (approved, in his order,
//       so the two he marked RECOMMENDED lead their pillars), moves the two
//       custom-home ideas from her strategy call to Custom-Home Buyers, and
//       retires the 40 ideas written for the old pillars (SUPERSEDED);
//   6 · with --refresh, tops every pillar up from the new strategy (one model
//       call; the ideas are accepted automatically, so each pillar lands at
//       10 to 15).
//   7 · with --tidy: that refill reworded 16 of the topics on file ("More
//       Space, or Space That Actually Works Better?" beside Jordan's "More
//       Space, or Space That Works Better?"); they are archived (archived
//       ideas never come back) and each pillar left under 10 gets a targeted
//       refill, through the generator's new reworded-duplicate check.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct20/erica-pillars-topics.ts            # dry run
//   ... --apply      (steps 1-5)
//   ... --refresh    (step 6, after --apply)
//   ... --tidy       (step 7, after --refresh)
// ---------------------------------------------------------------------------
import fs from "node:fs";

const ENROLLMENT = "cmt7h6b0300059kcj990r34x7";
const STRATEGY_V1 = "cmuvdoebi00049kl81tl11rdi";
const JORDAN = "info@realtourpilot.com";
const BACKUP = "/Users/jordanspackman/RTP-backups/erica-pillars-topics-2026-10-20.json";

const RENAMES: { id: string; from: string; to: string }[] = [
  { id: "cmux2w99e0000p706eu8dxfjy", from: "New Construction & Builder Collaboration", to: "Builder Partnerships" },
  { id: "cmux2w9a40002p706spekjsik", from: "Seller Strategy & Move-Up Planning", to: "Move-Up Buyers and Sellers" },
  { id: "cmux2w9ar0004p706hw9hoo3v", from: "Personal Brand & Client Experience", to: "Personal Brand and Client Stories" },
  { id: "cmux2w9b80006p706ddnxnh5m", from: "Chester County Lifestyle & Local Connection", to: "Local Lifestyle" },
];

const PILLARS: { name: string; purpose: string; focusAreas: string }[] = [
  {
    name: "Builder Partnerships",
    purpose: "Give smaller and custom-home builders a clear reason to involve Erica early, by showing the buyer insight and market research she brings before a home is designed, priced or listed.",
    focusAreas: "Positioning a spec home for its intended buyer; how location, layout and selections work together; what Erica brings to a builder meeting before there is a house to sell; recurring buyer requests builders should hear; matching the product to the lot and the market; base pricing and included features; marketing new construction; and builder case studies that clearly show Erica's role.",
  },
  {
    name: "Custom-Home Buyers",
    purpose: "Help buyers considering a custom home make better decisions, one choice at a time, with Erica's eleven years of new-construction experience beside them.",
    focusAreas: "Walking finished homes to test decisions before they are final; how the lot shapes the house (placement, slope, light and outdoor use); deciding how involved to be in a custom build; following one real decision from the first question to its resolution; floor-plan and lifestyle fit; selections and customization; and working with the architect and builder.",
  },
  {
    name: "Move-Up Buyers and Sellers",
    purpose: "Attract homeowners who have outgrown their current home by showing how the sale of one home and the purchase of the next are planned together.",
    focusAreas: "Mapping the sale and the next purchase together; deciding what the next home actually needs to solve; walking the house before renovating to sell; strategic improvements before listing; pricing against current competition; evaluating offers beyond the highest price; reading a home the way an appraiser does; staging, presentation and premium marketing; and negotiating with perspective.",
  },
  {
    name: "Personal Brand and Client Stories",
    purpose: "Build familiarity and trust through real stories that show what it feels like to work with Erica and the judgment she brings to important moments.",
    focusAreas: "Lessons from eleven years in new construction; client stories about major life transitions; candid conversations about what clients do not like; decisions changed before they became problems; advice clients did not expect; her path from appraising to new-construction sales; communication throughout a transaction; and relationships beyond closing.",
  },
  {
    name: "Local Lifestyle",
    purpose: "Strengthen local recognition by connecting Erica's own routines and roots in Downingtown and Phoenixville to the everyday experience of living there.",
    focusAreas: "Her actual Downingtown routine; Phoenixville through the eyes of someone who grew up there; walks, trails and outdoor routines; local businesses she keeps recommending; area tours built around a buyer's lifestyle priorities; and purposeful community visits. Feature locations because Erica has a real connection or useful perspective to share.",
  },
];

const PREAMBLE = "Every video should build Trust through honesty and care, provide Value through a useful takeaway, establish Credibility through experience and clear reasoning, and create Entertainment through curiosity, storytelling, visual interest, or natural personality.";

const SECTION_TEXT = [PREAMBLE, ...PILLARS.map((p, i) => `Pillar ${i + 1}: ${p.name}\nPurpose: ${p.purpose}\nFocus Areas: ${p.focusAreas}`)].join("\n");

// Jordan's 22, in his order (the two he marked RECOMMENDED lead their pillars).
const TOPICS: { pillar: string; title: string; concept: string }[] = [
  { pillar: "Builder Partnerships", title: "A Beautiful Spec Home Still Needs a Clear Buyer", concept: "Explore how location, layout, selections, and positioning work together to attract the intended buyer." },
  { pillar: "Builder Partnerships", title: "What I Bring to a Builder Meeting Before There’s a House to Sell", concept: "Show the research, questions, and market insight that contribute to early planning." },
  { pillar: "Builder Partnerships", title: "Buyers Keep Asking Me This. Builders Should Hear It.", concept: "Share one recurring buyer request from current experience and explain its relevance to future builds." },
  { pillar: "Custom-Home Buyers", title: "Why We Walk Another Home Before Finalizing Yours", concept: "Use the ceiling-height example to show how experiencing a space helps buyers make decisions." },
  { pillar: "Custom-Home Buyers", title: "The Lot Changes the House", concept: "Show how placement, slope, light, and outdoor use influence the design." },
  { pillar: "Custom-Home Buyers", title: "Custom Building: How Much Do You Want to Decide?", concept: "Help viewers consider whether the level of involvement and decision-making fits them." },
  { pillar: "Custom-Home Buyers", title: "One Decision From a Real Custom-Home Project", concept: "Follow one specific choice from the initial question to its resolution, with permission." },
  { pillar: "Move-Up Buyers and Sellers", title: "We Want to Move, but Where Would We Go?", concept: "Explain how to start mapping the sale of a current home and the purchase of the next one together." },
  { pillar: "Move-Up Buyers and Sellers", title: "More Space, or Space That Works Better?", concept: "Help homeowners identify what their next home actually needs to solve." },
  { pillar: "Move-Up Buyers and Sellers", title: "Before You Renovate to Sell, Let’s Walk the House", concept: "Revisit the strategic-improvements topic through a practical walkthrough of what deserves attention." },
  { pillar: "Move-Up Buyers and Sellers", title: "The Highest Offer Isn’t the Whole Decision", concept: "Use the real cash-versus-financed offer story to explain how to evaluate the full terms." },
  { pillar: "Move-Up Buyers and Sellers", title: "What My Appraising Background Makes Me Notice", concept: "Walk through a specific example of evaluating a home beyond its cosmetic appeal." },
  { pillar: "Personal Brand and Client Stories", title: "What Eleven Years in New Construction Taught Me", concept: "Focus on one lesson that still shapes the way you work, rather than a résumé recap." },
  { pillar: "Personal Brand and Client Stories", title: "When a Move Is About More Than the House", concept: "Tell a fresh client story that shows empathy during a major life transition." },
  { pillar: "Personal Brand and Client Stories", title: "Why I Ask Clients to Tell Me What They Don’t Like", concept: "Show how candid conversations help guide a more productive home search." },
  { pillar: "Personal Brand and Client Stories", title: "A Decision We Changed Before It Became a Problem", concept: "Share a specific example of foresight, collaboration, and problem-solving." },
  { pillar: "Local Lifestyle", title: "My Actual Downingtown Routine", concept: "Visit a few places you genuinely use and explain why they matter to you." },
  { pillar: "Local Lifestyle", title: "Phoenixville Through the Eyes of Someone Who Grew Up Here", concept: "Connect personal memories with present-day observations about the community." },
  { pillar: "Local Lifestyle", title: "The Walk I Take When I Need to Reset", concept: "Use a familiar route, your dog if appropriate, and a relaxed personal perspective." },
  { pillar: "Local Lifestyle", title: "The Local Business I Keep Recommending", concept: "Highlight an authentic relationship or memorable customer experience." },
  { pillar: "Local Lifestyle", title: "What I’d Show You Beyond the House", concept: "Build a small area tour around a buyer’s stated lifestyle priorities." },
];

// The two custom-home ideas from her strategy call (PROPOSED, still Jordan's to approve) belong under Custom-Home Buyers.
const TO_CUSTOM_HOME = ["cmv5esq9n005sl306w3ldq7gi", "cmv5esqh00060l306zed6izre"];

async function main() {
  const apply = process.argv.includes("--apply");
  const refresh = process.argv.includes("--refresh");
  const { prisma } = await import("../../../src/lib/prisma");
  const en = await prisma.contentEnrollment.findUnique({ where: { id: ENROLLMENT }, select: { id: true, clientId: true, status: true } });
  const client = en ? await prisma.client.findUnique({ where: { id: en.clientId }, select: { name: true } }) : null;
  if (!en || client?.name !== "Erica Walker") throw new Error("Not Erica Walker's enrollment.");

  if (process.argv.includes("--tidy")) {
    const REWORDED: string[] = [
      "A Beautiful Spec Home Still Has to Have a Clear Buyer",
      "The Feature Buyers Keep Asking For That Builders Keep Leaving Out",
      "The Lot Tells You What the House Should Be",
      "Your Floor Plan Should Start With Your Day",
      "How Much Do You Actually Want to Decide? Choosing Your Level of Involvement",
      "Why I Take Buyers Through a Finished Home Before They Finalize Theirs",
      "More Space, or Space That Actually Works Better?",
      "Before You Renovate to Sell, Walk the House With Me",
      "How My Appraising Background Changes the Way I Walk a House",
      "The Highest Offer Isn't Always the Decision You Think It Is",
      "The Decision We Changed Before It Became a Problem",
      "Eleven Years and the Thing I'm Still Figuring Out",
      "My Actual Downingtown Routine, Not the Highlight Reel Version",
      "Phoenixville Looks Different When You Grew Up Here",
      "The Local Business I Have Recommended More Than Any Other",
      "What I'd Show a Buyer Before I Showed Them Houses",
      // The same subject as Jordan's own, in new words, from the targeted refills.
      "How Location, Layout, and Selections Work Together on a Spec Home",
      "Most Move-Up Buyers Are Planning Two Moves When They Should Be Planning One",
      "Selling and Buying at the Same Time Is One Decision, Not Two",
      "The Sale and the Purchase Are One Decision, Not Two",
    ];
    const rows = await prisma.contentTopic.findMany({ where: { enrollmentId: ENROLLMENT, source: "ai", sourceRef: { startsWith: "refresh:" }, createdAt: { gte: new Date("2026-10-20T17:00:00Z") }, title: { in: REWORDED } }, select: { id: true, title: true, status: true } });
    const missing = REWORDED.filter((t) => !rows.some((r) => r.title === t));
    if (missing.length) throw new Error(`Not found from today's refills: ${missing.join(" | ")}`);
    const selected = await prisma.contentTopicSelection.count({ where: { topicId: { in: rows.map((r) => r.id) }, status: { not: "REMOVED" } } });
    if (selected) throw new Error("One of them has been chosen for a month since; stopping.");
    const { archiveTopic, startTopicRefresh, bankStock } = await import("../../../src/lib/contentTopics");
    for (const r of rows.filter((x) => x.status !== "ARCHIVED")) await archiveTopic(r.id, JORDAN, "A reworded copy of a topic already in her bank (Oct 20 2026 refill)");
    console.log(`archived ${rows.length} reworded copies (${rows.filter((x) => x.status !== "ARCHIVED").length} just now)`);
    for (const p of await bankStock(ENROLLMENT)) {
      if (p.need <= 0) { console.log(`  ${p.pillarName}: ${p.usable}, no refill needed`); continue; }
      const r = await startTopicRefresh({ enrollmentId: ENROLLMENT, kind: "REFRESH", requestedBy: JORDAN, pillarId: p.pillarId, keep: p.need });
      const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: r.runId }, select: { status: true, changeSummary: true } });
      console.log(`  ${p.pillarName}: ${p.usable} usable, refill of ${p.need} → ${run?.status} · ${run?.changeSummary}`);
    }
    for (const p of await bankStock(ENROLLMENT)) console.log(`  ${p.pillarName}: ${p.usable} usable, ${p.pending} pending`);
    await prisma.$disconnect();
    return;
  }

  if (refresh) {
    const { listPillars } = await import("../../../src/lib/contentPillars");
    const pillars = await listPillars(ENROLLMENT);
    if (pillars.map((p) => p.name).join("|") !== PILLARS.map((p) => p.name).join("|")) throw new Error(`Run --apply first: her pillars are ${pillars.map((p) => p.name).join(" | ")}`);
    const { startTopicRefresh, bankStock } = await import("../../../src/lib/contentTopics");
    const r = await startTopicRefresh({ enrollmentId: ENROLLMENT, kind: "REFRESH", requestedBy: JORDAN });
    const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: r.runId }, select: { status: true, changeSummary: true, lastError: true, generatedCount: true } });
    console.log("refresh:", r.runId, run);
    for (const p of await bankStock(ENROLLMENT)) console.log(`  ${p.pillarName}: ${p.usable} usable, ${p.pending} pending (target ${p.target})`);
    await prisma.$disconnect();
    return;
  }

  const [pillars, v1, pending] = await Promise.all([
    prisma.contentPillar.findMany({ where: { enrollmentId: ENROLLMENT }, select: { id: true, name: true, status: true } }),
    prisma.contentStrategyVersion.findUnique({ where: { id: STRATEGY_V1 }, select: { id: true, status: true, versionNo: true, enrollmentId: true } }),
    prisma.contentTopicSuggestion.count({ where: { enrollmentId: ENROLLMENT, disposition: "PENDING" } }),
  ]);
  const newest = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: ENROLLMENT }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true, status: true } });
  console.log("pillars:", pillars.map((p) => `${p.name} (${p.status})`).join(" | "));
  console.log("strategy:", v1?.versionNo, v1?.status, "newest:", newest?.versionNo, newest?.status, "· pending ideas:", pending);
  for (const r of RENAMES) if (!pillars.some((p) => p.id === r.id && (p.name === r.from || p.name === r.to))) throw new Error(`Pillar ${r.id} is not "${r.from}" any more.`);
  if (!v1 || v1.enrollmentId !== ENROLLMENT || v1.status !== "APPROVED" || newest?.id !== STRATEGY_V1) throw new Error("v1 is no longer the newest approved version; stopping.");

  // The candidate document, parsed exactly as the version will be.
  const { parseStoredSections, refreshedDocument } = await import("../../../src/lib/contentStrategy");
  const base = await prisma.contentStrategyVersion.findUnique({ where: { id: STRATEGY_V1 }, select: { sectionsJson: true } });
  const stored = parseStoredSections(base!.sectionsJson)!;
  const sections = stored.sections.map((s) => (s.id === "content-pillars" ? { ...s, text: SECTION_TEXT } : s));
  const doc = refreshedDocument(stored, sections);
  const parsed = doc?.contentPillars.pillars ?? [];
  console.log("\nthe new section parses to:", parsed.map((p) => `${p.name} [purpose ${p.purpose ? "yes" : "NO"}, focus ${p.focusAreas ? "yes" : "NO"}]`).join(" | "));
  if (parsed.map((p) => p.name).join("|") !== PILLARS.map((p) => p.name).join("|") || parsed.some((p) => !p.purpose || !p.focusAreas)) throw new Error("The new pillar section does not parse into the five pillars; stopping.");
  if (/[—–]/.test(SECTION_TEXT + TOPICS.map((t) => t.title + t.concept).join(" "))) throw new Error("An em or en dash in client copy; stopping.");

  if (!apply) {
    console.log(`\nDRY RUN. Would: back up her rows; rename 4 pillars; write and approve strategy v${(newest?.versionNo ?? 1) + 1} with the five pillars and release it (quietly); add ${TOPICS.length} topics; move ${TO_CUSTOM_HOME.length} call ideas to Custom-Home Buyers; retire ${pending} pending ideas.`);
    console.log("\n" + SECTION_TEXT);
    await prisma.$disconnect();
    return;
  }

  // 1 · backup
  const backup = {
    at: new Date().toISOString(),
    pillars: await prisma.contentPillar.findMany({ where: { enrollmentId: ENROLLMENT } }),
    aliases: await prisma.contentPillarAlias.findMany({ where: { pillarId: { in: pillars.map((p) => p.id) } } }),
    strategy: await prisma.contentStrategy.findMany({ where: { enrollmentId: ENROLLMENT } }),
    versions: await prisma.contentStrategyVersion.findMany({ where: { enrollmentId: ENROLLMENT } }),
    topics: await prisma.contentTopic.findMany({ where: { enrollmentId: ENROLLMENT } }),
    suggestions: await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: ENROLLMENT } }),
    selections: await prisma.contentTopicSelection.findMany({ where: { enrollmentId: ENROLLMENT } }),
  };
  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 1));
  console.log("backup:", BACKUP);

  // 2 · rename (same ids; the old names stay as aliases)
  const { renamePillar, updatePillarFields, listPillars } = await import("../../../src/lib/contentPillars");
  for (const r of RENAMES) await renamePillar(r.id, r.to, JORDAN);
  console.log("renamed 4 pillars");

  // 3 · the strategy: new version, approved as Jordan, in her portal
  const { editStrategyVersionSection, approveStrategyVersion } = await import("../../../src/lib/contentStrategy");
  const v2 = await editStrategyVersionSection(STRATEGY_V1, "content-pillars", SECTION_TEXT, JORDAN);
  await prisma.contentStrategyVersion.update({ where: { id: v2.versionId }, data: { changeSummary: "Content Pillars rewritten to Jordan's five pillars (Oct 20 2026): Builder Partnerships, Custom-Home Buyers, Move-Up Buyers and Sellers, Personal Brand and Client Stories, Local Lifestyle" } });
  const ap = await approveStrategyVersion(v2.versionId, JORDAN);
  console.log(`strategy v${v2.versionNo} approved (${ap.pillarsCreated} pillar created)`);
  const { releaseStrategyToPortal } = await import("../../../src/lib/programOnboarding");
  const rel = await releaseStrategyToPortal(v2.versionId, JORDAN);
  console.log("portal:", rel.message);

  // 4 · each pillar's purpose, focus areas and order
  const now = await listPillars(ENROLLMENT);
  const idOf = new Map(now.map((p) => [p.name, p.id]));
  for (const [i, p] of PILLARS.entries()) {
    const id = idOf.get(p.name);
    if (!id) throw new Error(`No pillar "${p.name}" after the approval.`);
    await updatePillarFields(id, { purpose: p.purpose, focusAreas: p.focusAreas, sortOrder: i });
    await prisma.contentPillar.update({ where: { id }, data: { strategyVersionId: v2.versionId } });
  }
  console.log("pillars now:", (await listPillars(ENROLLMENT)).map((p) => p.name).join(" | "));

  // 5 · Jordan's topics, the two call ideas, the old pending ideas
  const { createTopic } = await import("../../../src/lib/contentTopics");
  let added = 0;
  for (const t of TOPICS) {
    const r = await createTopic({
      enrollmentId: ENROLLMENT, title: t.title, concept: t.concept, pillarId: idOf.get(t.pillar)!, source: "staff", status: "SAVED", approvalState: "APPROVED", approvedBy: JORDAN,
      actor: { kind: "STAFF", staffUserId: JORDAN }, note: "Jordan's topic for Erica's new pillars (Oct 20 2026)",
    });
    if (r.existed) console.log("  already on file:", t.title);
    else added++;
  }
  console.log(`added ${added} topics`);
  const moved = await prisma.contentTopic.updateMany({ where: { id: { in: TO_CUSTOM_HOME }, enrollmentId: ENROLLMENT }, data: { pillarId: idOf.get("Custom-Home Buyers")! } });
  console.log(`moved ${moved.count} call ideas to Custom-Home Buyers`);
  const retired = await prisma.contentTopicSuggestion.updateMany({ where: { enrollmentId: ENROLLMENT, disposition: "PENDING" }, data: { disposition: "SUPERSEDED", dispositionBy: JORDAN, dispositionAt: new Date() } });
  console.log(`retired ${retired.count} pending ideas written for the old pillars`);

  const { bankStock } = await import("../../../src/lib/contentTopics");
  for (const p of await bankStock(ENROLLMENT)) console.log(`  ${p.pillarName}: ${p.usable} usable, ${p.pending} pending (target ${p.target}, needs ${p.need})`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
