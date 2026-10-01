// C14: recent TEST arrivals must not consume the normal Home card's row cap.
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5809) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { newClientsForDashboard } = await import("@/lib/newClients");
    const now = Date.now();
    for (let i = 0; i < 8; i++) await prisma.client.create({ data: { name: `Fixture ${i} TEST`, firstSeenAt: new Date(now - i * 60_000), firstSeenVia: "aryeo-webhook" } });
    const real = await prisma.client.create({ data: { name: "Real Arrival", firstSeenAt: new Date(now - 10 * 60_000), firstSeenVia: "aryeo-webhook" }, select: { id: true } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Renamed TEST", firstSeenAt: new Date(now - 11 * 60_000), firstSeenVia: "aryeo-webhook" }, select: { id: true } });
    const normal = await newClientsForDashboard({ limit: 2, includeTest: false });
    c.ok("normal card fills from real arrivals after synthetic rows", normal.length === 2 && normal[0].id === real.id && normal[1].id === protectedReal.id, normal.map((x) => x.name).join(", "));
    const all = await newClientsForDashboard({ limit: 2, includeTest: true });
    c.ok("explicit full reader retains the fixture arrivals", all.length === 2 && all.every((x) => x.name.includes("TEST")) && all.every((x) => x.id !== protectedReal.id));
    c.ok("provider fence stayed closed", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
