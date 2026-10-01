// C14: normal Home operating-day counts and capped rows omit synthetic clients.
// All fixture writes stay in disposable PGlite; provider traffic is fenced.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5810) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { buildOpsDay } = await import("@/lib/opsDay");
    const real = await prisma.client.create({ data: { name: "Real Agent" }, select: { id: true } });
    const synthetic = await prisma.client.create({ data: { name: "Avery TEST" }, select: { id: true } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST" }, select: { id: true } });
    const job = async (clientId: string, title: string) => {
      const p = await prisma.project.create({ data: { clientId, title, status: "REVIEW" }, select: { id: true } });
      await prisma.smartTask.create({ data: { clientId, projectId: p.id, title: `Reply on ${title}`, taskType: "client_reply" } });
      await prisma.reviewSubmission.create({ data: { projectId: p.id, status: "PENDING" } });
      return p.id;
    };
    const realJob = await job(real.id, "123 TEST Avenue");
    const syntheticJob = await job(synthetic.id, "456 Main Street");
    const protectedJob = await job(protectedReal.id, "789 TEST Road");
    const revision = async (clientId: string, title: string) => {
      const p = await prisma.project.create({ data: { clientId, title, status: "REVISION" }, select: { id: true } });
      await prisma.smartTask.create({ data: { clientId, projectId: p.id, title: `Revise ${title}`, taskType: "revision" } });
      return p.id;
    };
    const realRevision = await revision(real.id, "221 Real Lane");
    const syntheticRevision = await revision(synthetic.id, "222 Fixture Lane");
    const normal = await buildOpsDay({ includeTest: false });
    c.ok("normal Review count and rows retain only real client identities", normal.pipeline.review === 2 && normal.pipeline.rows.length === 3 && normal.pipeline.rows.some((r) => r.projectId === realJob) && normal.pipeline.rows.some((r) => r.projectId === protectedJob) && !normal.pipeline.rows.some((r) => r.projectId === syntheticJob), `${normal.pipeline.review} count / ${normal.pipeline.rows.length} rows`);
    c.ok("normal loop badge and list omit synthetic client task", normal.openLoopsTally.total === 2 && normal.openLoops.length === 2 && !normal.openLoops.some((r) => r.projectId === syntheticJob), `${normal.openLoopsTally.total} loops`);
    c.ok("normal revision count and row exclude synthetic job", normal.pipeline.revision === 1 && normal.pipeline.rows.some((r) => r.projectId === realRevision) && !normal.pipeline.rows.some((r) => r.projectId === syntheticRevision), `${normal.pipeline.revision} revisions`);
    c.ok("normal video review excludes the fixture cut", normal.videoReview.waiting.length === 2 && !normal.videoReview.waiting.some((r) => r.projectId === syntheticJob), `${normal.videoReview.waiting.length} pending cuts`);
    const { revisionsBoard } = await import("@/lib/commsBoard");
    const revisionList = await revisionsBoard(new Date(), { excludeClientIds: [synthetic.id] });
    c.ok("the Tasks revision reader resolves the same normal count", revisionList.reduce((n, group) => n + group.jobs.length, 0) === normal.pipeline.revision);
    const all = await buildOpsDay({ includeTest: true });
    c.ok("full reader retains the synthetic workload", all.pipeline.review === 3 && all.pipeline.revision === 2 && all.pipeline.rows.length === 5 && all.openLoopsTally.total === 3 && all.openLoops.some((r) => r.projectId === syntheticJob) && all.videoReview.waiting.length === 3);
    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
