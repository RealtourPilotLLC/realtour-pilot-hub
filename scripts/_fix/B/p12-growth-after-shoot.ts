// READ ONLY. If the pin waits until the shoot has happened, how often does the
// order still grow afterwards? The 2026-06-23 backfill created rows for 1,356
// projects at once (p11), so it is excluded — it is a migration, not an order.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const BACKFILL_DAY = "2026-06-23";

async function main() {
  const rows = await prisma.project.findMany({
    where: { createdAt: { gte: new Date("2026-01-01") }, shootDate: { not: null } },
    select: { id: true, title: true, createdAt: true, shootDate: true, deliverables: { select: { createdAt: true, type: true } } },
  });
  let afterShoot = 0;
  let afterProject = 0;
  const samples: string[] = [];
  for (const p of rows) {
    const real = p.deliverables.filter((d) => d.createdAt.toISOString().slice(0, 10) !== BACKFILL_DAY);
    if (real.length === 0) continue;
    const latest = real.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    if (latest.createdAt.getTime() - p.createdAt.getTime() > 3_600_000) afterProject++;
    if (latest.createdAt > p.shootDate!) {
      afterShoot++;
      if (samples.length < 10) {
        samples.push(`   ${p.title.slice(0, 36).padEnd(38)} shoot ${p.shootDate!.toISOString().slice(0, 16)} last row ${latest.createdAt.toISOString().slice(0, 16)} ${latest.type}`);
      }
    }
  }
  console.log(`projects with a shoot date (backfill rows excluded): ${rows.length}`);
  console.log(`  order grew more than an hour after the PROJECT row : ${afterProject}`);
  console.log(`  order grew after the SHOOT had happened            : ${afterShoot}`);
  console.log(samples.join("\n"));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
