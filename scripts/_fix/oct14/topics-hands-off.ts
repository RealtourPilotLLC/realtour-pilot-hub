// Oct 14 2026 (Jordan): "I want them to be able to log in and start using it
// right away with no issues ... ready for either scheduling, choosing topics,
// or both." Bernadette Rabel had 0 pickable topics (her approved strategy's
// pillars were never created) and Ashley Brunner's bank had 0 visible topics
// (new ideas waited for staff acceptance). This:
//   1. turns ON topic_auto_accept (new bank ideas go straight into the bank);
//   2. creates Bernadette's pillars from her approved strategy;
//   3. builds Bernadette's and Ashley's topic banks now (one AI run each).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct14/topics-hands-off.ts [--apply]
import { prisma } from "@/lib/prisma";
const BY = "info@realtourpilot.com";
const CLIENTS = [{ name: "Bernadette Rabel", enrollmentId: "cmt7h6b0u00069kcjdq8xi0le" }, { name: "Ashley Brunner", enrollmentId: "cmt7msava000e9kg1zvggxqm9" }];
async function main() {
  const apply = process.argv.includes("--apply");
  const { setAutomation, isAutomationEnabled } = await import("@/lib/programAutomation");
  console.log("topic_auto_accept:", await isAutomationEnabled("topic_auto_accept"), apply ? "→ ON" : "(dry run)");
  if (apply) await setAutomation("topic_auto_accept", true, BY);
  const { syncPillarsFromVersion } = await import("@/lib/contentStrategy");
  const { startTopicRefresh } = await import("@/lib/contentTopics");
  const { portalTopics } = await import("@/lib/portal");
  for (const c of CLIENTS) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: c.enrollmentId }, select: { id: true, clientId: true } });
    const cl = await prisma.client.findUnique({ where: { id: e!.clientId }, select: { name: true } });
    if (cl?.name !== c.name) throw new Error(`${c.name}: wrong program — stopping.`);
    const v = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: c.enrollmentId, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { id: true, versionNo: true } });
    const pillarsBefore = await prisma.contentPillar.count({ where: { enrollmentId: c.enrollmentId, status: "ACTIVE" } });
    console.log(`\n== ${c.name}: strategy v${v?.versionNo}, ${pillarsBefore} pillars`);
    if (!apply) continue;
    if (v) console.log("   pillars created:", await syncPillarsFromVersion(v.id, BY));
    const bank = await prisma.contentTopic.count({ where: { enrollmentId: c.enrollmentId, status: { notIn: ["REJECTED", "ARCHIVED"] } } });
    const r = await startTopicRefresh({ enrollmentId: c.enrollmentId, kind: bank ? "REFRESH" : "BANK", requestedBy: BY });
    console.log("   bank run:", JSON.stringify(r).slice(0, 160));
    const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: (r as { runId: string }).runId }, select: { status: true, changeSummary: true } });
    console.log("   ", run?.status, run?.changeSummary?.slice(0, 200));
    const t = await portalTopics(e!);
    const pickable = t.groups.reduce((n, g) => n + g.topics.filter((x) => !x.declined && x.state === "SUGGESTED").length, 0);
    console.log(`   client now sees ${t.groups.length} pillar groups, ${pickable} topics to pick`);
  }
}
main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
