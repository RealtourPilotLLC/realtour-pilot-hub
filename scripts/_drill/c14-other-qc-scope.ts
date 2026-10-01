// C14: Home badges and their Other / Review Room destinations share scope.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { isSyntheticClientRow, NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5815) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { boardWhere, photoQcWhere } = await import("@/lib/taskBoard");
    const { getReviewQueue } = await import("@/lib/reviewRoom");
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST" } });
    const realJob = await prisma.project.create({ data: { clientId: real.id, title: "123 TEST Avenue", status: "EDITING" } });
    const fixtureJob = await prisma.project.create({ data: { clientId: fixture.id, title: "456 Main Street", status: "EDITING" } });
    const protectedJob = await prisma.project.create({ data: { clientId: protectedReal.id, title: "789 TEST Road", status: "EDITING" } });
    const oldJob = await prisma.project.create({ data: { clientId: real.id, title: "Old delivered project", status: "DELIVERED", deliveredAt: new Date("2020-01-01") } });
    const scope = { excludeClientIds: (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((row) => row.id) };
    const task = (title: string, data: { projectId?: string; clientId?: string; assignedKey?: string; taskType?: string; status?: string } = {}) => prisma.smartTask.create({ data: { title, taskType: "todo", ...data } });
    const realTask = await task("Real address", { projectId: realJob.id, clientId: real.id });
    const protectedTask = await task("Protected identity", { projectId: protectedJob.id, clientId: protectedReal.id });
    const fixtureTask = await task("Fixture task", { projectId: fixtureJob.id, clientId: fixture.id });
    const projectOnlyFixture = await task("Fixture project link only", { projectId: fixtureJob.id });
    const clientOnlyFixture = await task("Fixture client link only", { clientId: fixture.id });
    const orphan = await task("Unlinked manual work");
    const olderAsk = await task("Old job still owes a reply", { projectId: oldJob.id, taskType: "lead" });
    const olderTodo = await task("Old finished task", { projectId: oldJob.id });
    const unassignedEdit = await task("Edit awaiting assignment", { projectId: realJob.id, taskType: "edit_video" });
    const kimsEdit = await task("Kim's edit", { projectId: realJob.id, taskType: "edit_video", assignedKey: "kim" });
    const otherEdit = await task("Another editor's edit", { projectId: realJob.id, taskType: "edit_video", assignedKey: "remar" });
    await task("Already completed", { projectId: realJob.id, status: "COMPLETED" });
    const normal = await prisma.smartTask.findMany({ where: boardWhere(null, scope), select: { id: true } });
    const normalIds = new Set(normal.map((row) => row.id));
    c.ok("Other keeps real TEST addresses, protected identity and orphan work", [realTask, protectedTask, orphan].every((row) => normalIds.has(row.id)));
    c.ok("Other hides fixtures through either durable task link", [fixtureTask, projectOnlyFixture, clientOnlyFixture].every((row) => !normalIds.has(row.id)));
    c.ok("Other preserves live work, old message and unassigned edit rules", normalIds.has(olderAsk.id) && !normalIds.has(olderTodo.id) && normalIds.has(unassignedEdit.id) && !normalIds.has(kimsEdit.id));
    c.ok("Home Other badge predicate equals the full normal tab row set", normal.length === 5 && await prisma.smartTask.count({ where: boardWhere(null, scope) }) === normal.length);
    const full = await prisma.smartTask.findMany({ where: boardWhere(null), select: { id: true } });
    c.ok("explicit full Other view retains all fixture work", [fixtureTask, projectOnlyFixture, clientOnlyFixture].every((row) => full.some((shown) => shown.id === row.id)));
    const editor = await prisma.smartTask.findMany({ where: boardWhere("kim"), select: { id: true } });
    c.ok("editor assignment remains closed to other people's work", editor.length === 1 && editor[0].id === kimsEdit.id && !editor.some((row) => row.id === otherEdit.id));

    const realQc = await task("Real media check", { projectId: realJob.id, clientId: real.id, taskType: "media_qa" });
    const protectedQc = await task("Protected media check", { projectId: protectedJob.id, taskType: "media_qa" });
    const fixtureQc = await task("Fixture media check", { projectId: fixtureJob.id, taskType: "media_qa" });
    const fixtureOrphanQc = await task("Fixture orphan media check", { clientId: fixture.id, taskType: "media_qa" });
    const orphanQc = await task("Unlinked media check", { taskType: "media_qa" });
    const holdJob = await prisma.project.create({ data: { clientId: real.id, title: "Paused real job", status: "ON_HOLD" } });
    const holdQc = await task("Paused media check", { projectId: holdJob.id, taskType: "media_qa" });
    const normalQc = await prisma.smartTask.findMany({ where: photoQcWhere(scope), select: { id: true } });
    const review = await getReviewQueue({ includeTest: false });
    const qcIds = new Set(normalQc.map((row) => row.id));
    c.ok("Home media-check badge and Review Room show identical real rows", normalQc.length === 3 && review.photoQc.length === 3 && review.photoQc.every((row) => qcIds.has(row.taskId)) && [realQc, protectedQc, orphanQc].every((row) => qcIds.has(row.id)));
    c.ok("QC excludes linked fixtures and preserves the on-hold rule", [fixtureQc, fixtureOrphanQc, holdQc].every((row) => !qcIds.has(row.id)));
    const reviewAll = await getReviewQueue({ includeTest: true });
    c.ok("Review Room full view and unscoped badge retain fixtures", reviewAll.photoQc.length === 5 && await prisma.smartTask.count({ where: photoQcWhere() }) === 5);
    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
