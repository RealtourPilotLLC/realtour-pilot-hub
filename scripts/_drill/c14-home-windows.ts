// C14: source queries for Home fires and week strip exclude synthetic clients.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5811) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { getStuckJobs, getShootWindow } = await import("@/lib/queries");
    const now = Date.now();
    const real = await prisma.client.create({ data: { name: "Real Agent" }, select: { id: true } });
    const synthetic = await prisma.client.create({ data: { name: "Avery TEST" }, select: { id: true } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST" }, select: { id: true } });
    const make = async (clientId: string, title: string, n: number) => {
      const p = await prisma.project.create({ data: { clientId, title, status: "SHOT", shootDate: new Date(now - 4 * 86_400_000), deliveryDue: new Date(now - 2 * 86_400_000) }, select: { id: true } });
      const future = await prisma.project.create({ data: { clientId, title: `${title} future`, status: "SCHEDULED" }, select: { id: true } });
      await prisma.appointment.create({ data: { aryeoId: `isolated-${n}`, projectId: future.id, startAt: new Date(now + 2 * 86_400_000), status: "SCHEDULED" } });
      return { stuck: p.id, future: future.id };
    };
    const realJobs = await make(real.id, "123 TEST Avenue", 1);
    const syntheticJobs = await make(synthetic.id, "456 Main Street", 2);
    const protectedJobs = await make(protectedReal.id, "789 TEST Road", 3);
    const normalStuck = await getStuckJobs({ excludeClientIds: [synthetic.id] });
    c.ok("normal fires keep real and protected clients, not synthetic", normalStuck.length === 2 && normalStuck.some((j) => j.id === realJobs.stuck) && normalStuck.some((j) => j.id === protectedJobs.stuck) && !normalStuck.some((j) => j.id === syntheticJobs.stuck), normalStuck.map((j) => j.title).join(", "));
    const allStuck = await getStuckJobs();
    c.ok("full fire reader retains the fixture", allStuck.length === 3 && allStuck.some((j) => j.id === syntheticJobs.stuck));
    const normalWeek = await getShootWindow({ excludeClientIds: [synthetic.id] });
    c.ok("normal week strip omits synthetic appointment at source", normalWeek.week.length === 2 && normalWeek.week.some((a) => a.id === realJobs.future) && normalWeek.week.some((a) => a.id === protectedJobs.future) && !normalWeek.week.some((a) => a.id === syntheticJobs.future), `${normalWeek.week.length} upcoming`);
    const allWeek = await getShootWindow();
    c.ok("full week reader retains the fixture", allWeek.week.length === 3 && allWeek.week.some((a) => a.id === syntheticJobs.future));
    c.ok("provider fence stayed closed", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
