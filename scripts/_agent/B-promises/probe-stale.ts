// READ-ONLY. How many pins belong to a visit that has since moved — a frozen
// deadline that now falls before its own shoot. turnaround.livePromise refuses
// those; this counts them and shows the worst.
import { PrismaClient } from "@prisma/client";
import { etDateTime } from "../../../src/lib/datetime";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.project.findMany({
    where: { promisedDueAt: { not: null }, shootDate: { not: null } },
    select: { title: true, status: true, shootDate: true, promisedDueAt: true, deliveredAt: true },
  });
  const stale = rows.filter((p) => p.promisedDueAt! <= p.shootDate!);
  const staleLive = stale.filter((p) => !p.deliveredAt);
  console.log(`pinned rows with a shoot date: ${rows.length}`);
  console.log(`  pins that precede their own shoot: ${stale.length} (${staleLive.length} not yet delivered)`);
  for (const p of stale.slice(0, 8)) {
    console.log(`   ${p.title.slice(0, 40).padEnd(42)} ${p.status.padEnd(9)} shoot ${etDateTime(p.shootDate!)} · pin ${etDateTime(p.promisedDueAt!)}`);
  }
  await prisma.$disconnect();
}
main();
