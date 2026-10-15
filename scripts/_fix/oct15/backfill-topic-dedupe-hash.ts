// ---------------------------------------------------------------------------
// LIVE (Oct 15 2026): 954 of 1,282 topics predate ContentTopic.dedupeHash, so
// createTopic could not see that a call's "What Sellers Need to Know — This Is
// Not the 2022 Market" was the chosen "…Know: This Is Not the 2022 Market"
// (Marcee McMullen) and made a twin. This fills in the missing match key from
// each title (topicDedupeHash, the same one every new topic gets). Titles are
// not touched. Dry run unless --apply.
// ---------------------------------------------------------------------------
export {};
import { prisma } from "@/lib/prisma";
async function main() {
  const { topicDedupeHash } = await import("@/lib/contentTopics");
  const rows = await prisma.contentTopic.findMany({ where: { dedupeHash: null }, select: { id: true, title: true } });
  console.log(`${rows.length} topics without a match key`);
  if (!process.argv.includes("--apply")) return;
  let n = 0;
  for (const r of rows) {
    await prisma.contentTopic.update({ where: { id: r.id }, data: { dedupeHash: topicDedupeHash(r.title) } });
    n++;
  }
  console.log(`filled ${n}; left without one: ${await prisma.contentTopic.count({ where: { dedupeHash: null } })}`);
}
main().then(() => process.exit(0)).catch((e) => { console.log("ERR", e.message); process.exit(1); });
