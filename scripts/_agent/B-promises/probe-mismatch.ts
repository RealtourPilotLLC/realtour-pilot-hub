// READ-ONLY. Why does the reconstructed old promise disagree with the stored
// deliveryDue on some rows? Groups the gap so a systematic error in the
// reconstruction (which would make the pinned TIER LABELS wrong across the
// board) can be told from ordinary history (re-shoots, office overrides,
// multi-leg video anchors).
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.project.findMany({
    where: { promisedDueAt: { not: null } },
    select: {
      id: true, title: true, shootDate: true, deliveryDue: true, dueOverrideAt: true,
      appointments: { select: { startAt: true, status: true } },
      deliverables: { select: { type: true, label: true } },
    },
  });
  const hours = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 3_600_000;
  const buckets = new Map<string, number>();
  let multiLeg = 0;
  let overridden = 0;
  let noShoot = 0;
  for (const p of rows) {
    if (!p.deliveryDue) continue;
    if (!p.shootDate) { noShoot++; continue; }
    const legs = p.appointments.filter((a) => a.startAt);
    if (legs.length > 1) multiLeg++;
    if (p.dueOverrideAt) overridden++;
    const h = Math.round(hours(p.deliveryDue, p.shootDate));
    const key = h <= 24 ? "<=24h" : h <= 48 ? "48h" : h <= 72 ? "72h" : h <= 96 ? "96h" : h <= 24 * 10 ? "3-10d" : "10d+";
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  console.log(`pinned rows ${rows.length}; multi-leg ${multiLeg}; office override set ${overridden}; no shoot date ${noShoot}`);
  console.log("stored due measured from shootDate:", [...buckets.entries()].map(([k, n]) => `${k}=${n}`).join(" "));
  await prisma.$disconnect();
}
main();
