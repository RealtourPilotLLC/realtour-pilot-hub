// Oct 13 2026 (Jordan): "why Buyer Education & Transaction Guidance topics are
// being recommended for Arielle Roemer. Her content strategy should be less
// buyer heavy and more seller heavy and personal branding heavy."
//
// Why: her strategy has four pillars and the topic bank gave EVERY pillar the
// same 10 topics, so a quarter of what she picks from was buyer education; the
// ranking only nudged the seller pillar from a sentence in the pillars intro.
// Pillar emphasis (ec0958e) fixes it in code; this sets hers:
//   Seller Strategy & Listing Positioning ......... Lead
//   Personal Brand, Team & Trust Builders ......... Lead
//   Main Line & Philadelphia Local Authority ...... Normal
//   Buyer Education & Transaction Guidance ........ Light (a bank of 3)
// and trims the buyer topics already in her bank to the 3 that serve sellers
// most (archived, not deleted: reintroduceTopic brings any back), then re-ranks
// October's recommendations. Nothing is sent to Arielle.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct13/arielle-pillar-emphasis.ts [--apply]
import { prisma } from "@/lib/prisma";

const ENROLLMENT = "cmt7msany000c9kg1ospdeoza";
const OCT = "cmup0bq4600qgjg04fi7j19t5";
const BY = "info@realtourpilot.com";
const SETTING: Record<string, "LEAD" | "NORMAL" | "LIGHT"> = {
  "Seller Strategy & Listing Positioning": "LEAD",
  "Personal Brand, Team & Trust Builders": "LEAD",
  "Main Line & Philadelphia Local Authority": "NORMAL",
  "Buyer Education & Transaction Guidance": "LIGHT",
};
const KEEP = [
  "What Sellers Who Are Also Buying Need to Know First",
  "How to Buy a Home While You Are Still in a Lease",
  "The 30 Days After Your Offer Is Accepted: What Is Actually Happening",
];

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLY" : "DRY RUN");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: ENROLLMENT }, select: { clientId: true } });
  const c = e ? await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }) : null;
  if (c?.name !== "Arielle Roemer") throw new Error("Not Arielle Roemer's program — stopping.");
  const { setPillarEmphasis } = await import("@/lib/contentPillars");
  const { archiveTopic, startTopicRefresh } = await import("@/lib/contentTopics");
  const pillars = await prisma.contentPillar.findMany({ where: { enrollmentId: ENROLLMENT, status: "ACTIVE" }, select: { id: true, name: true, emphasis: true } });
  for (const p of pillars) {
    const want = SETTING[p.name];
    if (!want) throw new Error(`Unexpected pillar "${p.name}".`);
    console.log(`pillar ${p.name}: ${p.emphasis} → ${want}`);
    if (apply) await setPillarEmphasis(ENROLLMENT, p.id, want);
  }
  const buyer = pillars.find((p) => p.name === "Buyer Education & Transaction Guidance")!;
  // Only bank topics nobody has chosen: never one on a month, scripted or filmed.
  const topics = await prisma.contentTopic.findMany({ where: { enrollmentId: ENROLLMENT, pillarId: buyer.id, status: { notIn: ["REJECTED", "ARCHIVED"] } }, select: { id: true, title: true, status: true, monthId: true } });
  const chosen = new Set((await prisma.contentTopicSelection.findMany({ where: { topicId: { in: topics.map((t) => t.id) }, status: { not: "REMOVED" } }, select: { topicId: true } })).map((x) => x.topicId));
  const scripted = new Set((await prisma.contentScript.findMany({ where: { topicId: { in: topics.map((t) => t.id) } }, select: { topicId: true } })).map((x) => x.topicId));
  for (const t of topics) {
    const keep = KEEP.includes(t.title) || chosen.has(t.id) || scripted.has(t.id) || t.status !== "SAVED" || !!t.monthId;
    console.log(`${keep ? "keep   " : "archive"} ${t.status} · ${t.title}`);
    if (apply && !keep) await archiveTopic(t.id, BY, "Oct 13 2026: buyer education is a light pillar for Arielle (Jordan: less buyer heavy, more seller and personal branding)");
  }
  if (!apply) return;
  const r = await startTopicRefresh({ enrollmentId: ENROLLMENT, kind: "RECOMMENDATION", monthId: OCT, requestedBy: BY });
  console.log("October re-ranked:", JSON.stringify(r).slice(0, 200));
  const latest = await prisma.contentTopicRefreshRun.findFirst({ where: { monthId: OCT, kind: "RECOMMENDATION", status: "SUCCEEDED" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  const sugg = latest ? await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: latest.id }, orderBy: [{ kind: "desc" }, { rank: "asc" }], select: { kind: true, rank: true, title: true, pillarId: true } }) : [];
  for (const s of sugg) console.log(`   ${s.kind} #${s.rank} · ${pillars.find((p) => p.id === s.pillarId)?.name} · ${s.title}`);
}

main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
