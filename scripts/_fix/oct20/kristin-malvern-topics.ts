// ---------------------------------------------------------------------------
// Oct 20 2026 — Kristin Ciarmella's Malvern pillar. Two topic refills today
// filed their 20 ideas under her RETIRED duplicate pillar "Malvern and Media
// Lifestyle and Local Connection (duplicate, merged)" (it kept the real
// pillar's name as an alias and sorted first; contentPillars.resolvePillarByLabel
// now prefers the pillar in use). Her bank showed 0 Malvern topics.
//
//   · the 20 topics and their 20 accepted ideas move to the active pillar;
//   · the second refill ran without seeing the first one's ideas under her
//     pillar and repeated five of them in new words; those five are archived
//     (archived ideas never come back), which leaves the pillar at 15;
//   · a backup of every row touched is written first.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct20/kristin-malvern-topics.ts           # dry run
//   ... --apply
// ---------------------------------------------------------------------------
import fs from "node:fs";

const RETIRED = "cmv72nk0r000bl906nh40n7xy";
const ACTIVE = "cmv5hsh9g0004ju06fhirjo9x";
const ENROLLMENT = "cmt7n3fy1006x9kg1wl2rz5z9";
const BY = "info@realtourpilot.com";
const BACKUP = "/Users/jordanspackman/RTP-backups/kristin-malvern-topics-2026-10-20.json";
const REPEATS: Record<string, string> = {
  "Growing Up in Media Gave Me a Strange Advantage in Real Estate": "Growing Up in Media: What I Didn't Appreciate Until I Moved Away",
  "The Farmers Market Test I Give Every Client Moving to Chester County": "The Malvern Farmers Market: What to Know Before You Go",
  "The Thing About Malvern That No One Puts in a Listing Description": "Media, Pennsylvania: The Part Nobody Mentions in the Listing Description",
  "What I Notice About a Neighborhood's Architecture That Most People Walk Right Past": "Why Chester County Architecture Stops Me Every Time",
  "What I Tell People Who Think the Suburbs Are All the Same": "Delaware County to Chester County: What Changes and What Doesn't",
};

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../../src/lib/prisma");
  const [retired, active] = await Promise.all([
    prisma.contentPillar.findUnique({ where: { id: RETIRED }, select: { enrollmentId: true, status: true, mergedIntoId: true, name: true } }),
    prisma.contentPillar.findUnique({ where: { id: ACTIVE }, select: { enrollmentId: true, status: true, name: true } }),
  ]);
  if (retired?.enrollmentId !== ENROLLMENT || retired.status !== "RETIRED" || retired.mergedIntoId !== ACTIVE || active?.enrollmentId !== ENROLLMENT || active.status !== "ACTIVE") throw new Error("The pillars are not as expected; stopping.");
  const topics = await prisma.contentTopic.findMany({ where: { pillarId: RETIRED } });
  const suggestions = await prisma.contentTopicSuggestion.findMany({ where: { pillarId: RETIRED } });
  const selected = await prisma.contentTopicSelection.count({ where: { topicId: { in: topics.map((t) => t.id) }, status: { not: "REMOVED" } } });
  console.log(`under the retired pillar: ${topics.length} topics, ${suggestions.length} ideas, ${selected} chosen for a month`);
  for (const [repeat, first] of Object.entries(REPEATS)) if (!topics.some((t) => t.title === repeat) || !topics.some((t) => t.title === first)) throw new Error(`Not found: "${repeat}" / "${first}"`);
  const archive = topics.filter((t) => REPEATS[t.title]);
  const keep = topics.filter((t) => !REPEATS[t.title]);
  console.log("move:", keep.map((t) => t.title).join(" | "));
  console.log("archive:", archive.map((t) => `${t.title}  (repeats "${REPEATS[t.title]}")`).join(" | "));
  if (!apply) { console.log("\nDRY RUN."); await prisma.$disconnect(); return; }

  fs.writeFileSync(BACKUP, JSON.stringify({ at: new Date().toISOString(), topics, suggestions }, null, 1));
  console.log("backup:", BACKUP);
  await prisma.contentTopic.updateMany({ where: { id: { in: topics.map((t) => t.id) } }, data: { pillarId: ACTIVE } });
  await prisma.contentTopicSuggestion.updateMany({ where: { id: { in: suggestions.map((s) => s.id) } }, data: { pillarId: ACTIVE } });
  const { archiveTopic, bankStock } = await import("../../../src/lib/contentTopics");
  for (const t of archive) await archiveTopic(t.id, BY, `Repeats "${REPEATS[t.title]}" from the same day's refill (Oct 20 2026)`);
  console.log(`moved ${topics.length}, archived ${archive.length}`);
  for (const p of await bankStock(ENROLLMENT)) console.log(`  ${p.pillarName}: ${p.usable} usable, ${p.pending} pending`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
