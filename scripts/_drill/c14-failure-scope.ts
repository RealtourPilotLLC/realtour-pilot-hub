// C14: the normal roster hides synthetic failures, including global cut
// transcripts with no clientId; Monitoring retains the complete audit trail.
// All fixtures live in disposable loopback PGlite under _drill-preload.cjs.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5807) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { failedAutomations, failedAutomationIndex } = await import("@/lib/programMonitoring");
    const real = await prisma.client.create({ data: { name: "Real Agent" }, select: { id: true } });
    const synthetic = await prisma.client.create({ data: { name: "Avery TEST" }, select: { id: true } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST" }, select: { id: true } });
    const syntheticEnrollment = await prisma.contentEnrollment.create({ data: { clientId: synthetic.id, package: "Starter", videosPerMonth: 1, sessionsPerMonth: 1, sessionHours: 2 }, select: { id: true } });
    const failedRun = async (clientId: string | null, enrollmentId: string | null) => prisma.programAiRun.create({
      data: { kind: "script_draft", promptKey: "drill", status: "FAILED", clientId, enrollmentId, error: "isolated failure" }, select: { id: true },
    });
    const realRun = await failedRun(real.id, null);
    const syntheticRun = await failedRun(null, syntheticEnrollment.id);
    const protectedRun = await failedRun(protectedReal.id, null);
    const failedCut = async (clientId: string, legacyWithoutProject = false) => {
      const project = await prisma.project.create({ data: { clientId, title: "Drill", status: "REVIEW" }, select: { id: true } });
      const submission = await prisma.reviewSubmission.create({ data: { projectId: project.id }, select: { id: true } });
      return prisma.contentCutTranscript.create({ data: { projectId: legacyWithoutProject ? null : project.id, submissionId: submission.id, status: "FAILED", lastError: "isolated failure" }, select: { id: true } });
    };
    const syntheticCut = await failedCut(synthetic.id, true);
    const realCut = await failedCut(real.id);
    const all = await failedAutomations({ sinceDays: 30 });
    c.ok("Monitoring retains synthetic and real failure evidence", [realRun.id, syntheticRun.id, protectedRun.id, syntheticCut.id, realCut.id].every((id) => all.some((f) => f.ref === id)), `${all.length} failures`);
    const normal = await failedAutomationIndex({ includeTest: false });
    const visible = [...normal.global, ...[...normal.byEnrollment.values()].flat()].map((f) => f.ref);
    c.ok("normal failure index excludes both synthetic enrollment and global cut", visible.length === 3 && [realRun.id, protectedRun.id, realCut.id].every((id) => visible.includes(id)) && !visible.includes(syntheticRun.id) && !visible.includes(syntheticCut.id), visible.join(", "));
    const { programOverview } = await import("@/lib/programOverview");
    const emptyRoster = await programOverview({ includeTest: false });
    c.ok("normal roster with only a synthetic enrollment still shows real global failures", emptyRoster.rows.length === 0 && emptyRoster.globalFailures.length === 3 && !emptyRoster.globalFailures.some((f) => f.ref === syntheticCut.id));
    const testView = await failedAutomationIndex({ includeTest: true });
    const allRefs = [...testView.global, ...[...testView.byEnrollment.values()].flat()].map((f) => f.ref);
    c.ok("explicit test view includes every failure", allRefs.length === 5 && [syntheticRun.id, syntheticCut.id].every((id) => allRefs.includes(id)));
    c.ok("no provider request escaped the isolated fixture", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
