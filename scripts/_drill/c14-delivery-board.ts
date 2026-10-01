// C14: Home and Project Tracker read the same fixture-free delivery board.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5812) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { deliveryBoard } = await import("@/lib/deliveryBoard");
    const now = Date.now();
    const real = await prisma.client.create({ data: { name: "Real Agent" }, select: { id: true } });
    const synthetic = await prisma.client.create({ data: { name: "Avery TEST" }, select: { id: true } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST" }, select: { id: true } });
    const job = async (clientId: string, title: string) => {
      const p = await prisma.project.create({ data: { clientId, title, status: "SHOT", shootDate: new Date(now - 86_400_000), deliveryDue: new Date(now + 86_400_000) }, select: { id: true } });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO" } });
      return p.id;
    };
    const realJob = await job(real.id, "123 TEST Avenue");
    const syntheticJob = await job(synthetic.id, "456 Main Street");
    const protectedJob = await job(protectedReal.id, "789 TEST Road");
    const ids = (b: Awaited<ReturnType<typeof deliveryBoard>>) => [...b.today, ...b.tomorrow, ...b.upcoming, ...b.delivered].map((r) => r.id);
    const normal = await deliveryBoard({ excludeClientIds: [synthetic.id] });
    const normalIds = ids(normal);
    c.ok("normal Home board excludes synthetic job before paging", normalIds.length === 2 && normalIds.includes(realJob) && normalIds.includes(protectedJob) && !normalIds.includes(syntheticJob), normalIds.join(", "));
    const normalRoute = await deliveryBoard({ includeTest: false });
    c.ok("normal Project Tracker resolves the same two jobs", ids(normalRoute).join(",") === normalIds.join(","));
    const all = await deliveryBoard({ includeTest: true });
    c.ok("explicit test view restores synthetic job", ids(all).length === 3 && ids(all).includes(syntheticJob));
    c.ok("provider fence stayed closed", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
