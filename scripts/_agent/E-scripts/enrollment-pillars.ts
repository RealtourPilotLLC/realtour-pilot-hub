// READ-ONLY. For every enrollment that has live scripts: does it have any
// pillars at all? That decides whether an unmapped label is a MISALIGNED script
// or a client whose strategy never produced pillars.
import { prisma } from "../../../src/lib/prisma";

async function main() {
  const scripts = await prisma.contentScript.findMany({ where: { historical: false }, select: { id: true, enrollmentId: true, currentVersionId: true } });
  const ids = [...new Set(scripts.map((s) => s.enrollmentId))];
  const pillars = await prisma.contentPillar.groupBy({ by: ["enrollmentId"], _count: true });
  const svs = await prisma.contentStrategyVersion.findMany({ where: { enrollmentId: { in: ids } }, select: { enrollmentId: true, versionNo: true, status: true } });
  const enrollments = await prisma.contentEnrollment.findMany({ where: { id: { in: ids } }, select: { id: true, clientId: true } });
  const clients = await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } });
  for (const id of ids) {
    const n = pillars.find((p) => p.enrollmentId === id)?._count ?? 0;
    const strat = svs.filter((s) => s.enrollmentId === id).map((s) => `v${s.versionNo}/${s.status}`).join(",") || "none";
    const e = enrollments.find((x) => x.id === id);
    const name = clients.find((c) => c.id === e?.clientId)?.name ?? "?";
    console.log(`${id}  liveScripts=${scripts.filter((s) => s.enrollmentId === id).length}  pillars=${n}  strategy=${strat}  ${name}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
