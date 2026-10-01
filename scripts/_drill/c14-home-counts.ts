// C14: Home's normal exception rows and totals must exclude synthetic clients
// before each source read/cap. Disposable loopback PGlite and provider fence.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5808) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
    const now = new Date("2026-09-30T20:00:00.000Z");
    const old = new Date("2026-09-24T20:00:00.000Z");
    const real = await prisma.client.create({ data: { name: "Real Agent" }, select: { id: true } });
    const synthetic = await prisma.client.create({ data: { name: "Avery TEST" }, select: { id: true } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST" }, select: { id: true } });
    const job = async (clientId: string, title: string) => {
      const p = await prisma.project.create({ data: { clientId, title, status: "SHOT", deliveryDue: old }, select: { id: true } });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO" } });
      await prisma.smartTask.create({ data: { clientId, projectId: p.id, title: `Chase ${title}`, taskType: "client_reply", followUpAt: old } });
      return p.id;
    };
    const realJob = await job(real.id, "123 TEST Avenue");
    const syntheticJob = await job(synthetic.id, "456 Main Street");
    const protectedJob = await job(protectedReal.id, "789 TEST Road");
    for (let i = 0; i < 5; i++) await prisma.smartTask.create({ data: { clientId: synthetic.id, title: `Synthetic chase ${i}`, taskType: "client_reply", followUpAt: old } });
    const enrollment = async (clientId: string) => prisma.contentEnrollment.create({ data: { clientId, package: "Starter", videosPerMonth: 1, sessionsPerMonth: 1, sessionHours: 2, librarySyncFailedAt: old }, select: { id: true } });
    const realEnrollment = await enrollment(real.id);
    const syntheticEnrollment = await enrollment(synthetic.id);
    const protectedEnrollment = await enrollment(protectedReal.id);
    for (const projectId of [realJob, syntheticJob, protectedJob]) {
      await prisma.photoEditBatch.create({ data: { projectId, vendorKey: "autohdr", state: "MISSING", attempt: 1 } });
    }
    const normal = await opsExceptionsBoard({ now, includeTest: false });
    c.ok("normal unassigned total excludes synthetic while keeping protected real", normal.totals.unassigned.all === 2 && normal.rows.filter((r) => r.kind === "unassigned").length === 2, JSON.stringify(normal.totals.unassigned));
    c.ok("normal follow-up total and page exclude synthetic before cap", normal.totals["overdue-followup"].all === 2 && normal.rows.filter((r) => r.kind === "overdue-followup").length === 2, JSON.stringify(normal.totals["overdue-followup"]));
    c.ok("normal library failure total excludes synthetic", normal.totals["library-missing"].all === 2 && normal.rows.some((r) => r.id === `library:${realEnrollment.id}`) && normal.rows.some((r) => r.id === `library:${protectedEnrollment.id}`) && !normal.rows.some((r) => r.id === `library:${syntheticEnrollment.id}`));
    c.ok("normal AutoHDR total excludes synthetic", normal.totals["photo-batch"].all === 2, JSON.stringify(normal.totals["photo-batch"]));
    c.ok("real job title containing TEST stays visible", normal.rows.some((r) => r.kind === "unassigned" && r.href === `/edit/${realJob}`));
    c.ok("synthetic job has no Home exception row", !normal.rows.some((r) => r.href === `/edit/${syntheticJob}` || r.href === `/projects/${syntheticJob}`));
    const all = await opsExceptionsBoard({ now, includeTest: true });
    c.ok("explicit full view retains synthetic rows and totals", all.totals.unassigned.all === 3 && all.totals["overdue-followup"].all === 8 && all.totals["library-missing"].all === 3 && all.totals["photo-batch"].all === 3, JSON.stringify({ unassigned: all.totals.unassigned, followup: all.totals["overdue-followup"], library: all.totals["library-missing"], photo: all.totals["photo-batch"] }));
    c.ok("provider fence stayed closed", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
