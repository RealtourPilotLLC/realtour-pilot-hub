// C14: a TEST word in a real job title (or a protected real client's name)
// cannot hide delivery reconciliation. Only a synthetic client row is skipped.
// Run under _drill-preload.cjs; all records live in disposable loopback PGlite.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5806) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { reconcileDeliveries } = await import("@/lib/deliveryExceptions");
    const real = await prisma.client.create({ data: { name: "Real Agent" }, select: { id: true } });
    const synthetic = await prisma.client.create({ data: { name: "Avery TEST" }, select: { id: true } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST" }, select: { id: true } });
    const flagged = async (clientId: string, title: string) => prisma.project.create({
      data: { clientId, title, status: "DELIVERED", deliveryExceptionAt: new Date(), deliveryExceptionNote: "Check the delivery" },
      select: { id: true },
    });
    const realJob = await flagged(real.id, "123 TEST Avenue");
    const testJob = await flagged(synthetic.id, "456 Main Street");
    const protectedJob = await flagged(protectedReal.id, "789 TEST Street");
    const normal = await reconcileDeliveries({ write: false });
    c.ok("normal pass skips only the synthetic client's job", normal.scanned === 3 && normal.candidates === 2 && normal.skippedTest === 1 && normal.classifications.some((r) => r.projectId === realJob.id) && normal.classifications.some((r) => r.projectId === protectedJob.id) && !normal.classifications.some((r) => r.projectId === testJob.id), `${normal.scanned} scanned, ${normal.candidates} candidates, ${normal.skippedTest} skipped`);
    const shown = await reconcileDeliveries({ write: false, includeTest: true });
    c.ok("explicit test pass exposes the synthetic exception", shown.candidates === 3 && shown.skippedTest === 0 && shown.classifications.some((r) => r.projectId === testJob.id));
    c.ok("no provider request escaped the isolated fixture", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
