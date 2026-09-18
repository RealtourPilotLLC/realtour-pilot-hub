// READ-ONLY. Confirms the proof harness wrote nothing: no caption draft was
// stamped STALE ("cut changed") and no row was touched after the run started.
import { prisma } from "../../../src/lib/prisma";
async function main() {
  const drafts = await prisma.contentCaptionDraft.findMany({ select: { id: true, status: true, staleReason: true, updatedAt: true } });
  console.log(`ContentCaptionDraft rows: ${drafts.length}`);
  console.log(`  STALE: ${drafts.filter((d) => d.status === "STALE").length}; staleReason "cut changed": ${drafts.filter((d) => d.staleReason === "cut changed").length}`);
  const newest = drafts.map((d) => d.updatedAt.toISOString()).sort().slice(-1)[0];
  console.log(`  newest updatedAt: ${newest} (now ${new Date().toISOString()})`);
}
main().then(() => prisma.$disconnect());
