// READ ONLY. How risky is pinning a promise at the FIRST pass that can compute
// one? The danger is an order that grows afterwards: a photo-only job pinned at
// shoot+20h that later gains a premium reel would cap the reel at the photo
// date. Measure how often a project's owed rows arrive after the project does.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.project.findMany({
    where: { createdAt: { gte: new Date("2026-01-01") } },
    select: { id: true, title: true, createdAt: true, shootDate: true, deliverables: { select: { createdAt: true, type: true } } },
  });
  const HOUR = 3_600_000;
  let grewLater = 0;
  let grewAfterShoot = 0;
  const samples: string[] = [];
  for (const p of rows) {
    if (p.deliverables.length === 0) continue;
    const latest = p.deliverables.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    const gapH = (latest.createdAt.getTime() - p.createdAt.getTime()) / HOUR;
    if (gapH > 1) {
      grewLater++;
      if (p.shootDate && latest.createdAt > p.shootDate) grewAfterShoot++;
      if (samples.length < 10) samples.push(`   ${p.title.slice(0, 38).padEnd(40)} +${gapH.toFixed(1)}h  last row ${latest.type}`);
    }
  }
  console.log(`projects created in 2026: ${rows.length}`);
  console.log(`  gained an owed row MORE THAN AN HOUR after the project row: ${grewLater}`);
  console.log(`  ...and after the shoot had already happened             : ${grewAfterShoot}`);
  console.log(samples.join("\n"));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
