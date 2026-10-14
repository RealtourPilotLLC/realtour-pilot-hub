// Oct 14 2026 (Jordan): "Bernadette's and Joe's strategies were already sent to
// them. Everyone on the platform already has a strategy; they don't need to be
// notified about that." Releases each active client's APPROVED-but-unreleased
// strategy to the portal with releaseStrategyVersion (no STRATEGY_READY notice
// is created; releaseStrategyToPortal would queue one).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct14/release-without-notice.ts [--apply]
import { prisma } from "@/lib/prisma";
async function main() {
  const apply = process.argv.includes("--apply");
  const { releaseStrategyVersion } = await import("@/lib/contentStrategy");
  const es = await prisma.contentEnrollment.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] } }, select: { id: true, clientId: true } });
  for (const e of es) {
    const c = await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } });
    if (/TEST/.test(c?.name ?? "")) continue;
    const v = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: e.id, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true, releasedAt: true } });
    if (!v || v.releasedAt) continue;
    console.log(`${c?.name}: v${v.versionNo} approved, not released → release (no email)`);
    if (apply) { await releaseStrategyVersion(v.id, "info@realtourpilot.com"); console.log("   released"); }
  }
  const pending = await prisma.programReminder.count({ where: { action: "STRATEGY_READY", state: { in: ["PENDING", "QUEUED", "SCHEDULED"] } } }).catch(() => -1);
  console.log("pending STRATEGY_READY notices:", pending);
}
main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
