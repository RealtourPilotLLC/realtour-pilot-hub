// READ ONLY. Is "the order grew later" real growth, or a backfill that created
// deliverable rows for hundreds of projects at once? Cluster the late rows by
// the day they were created.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.project.findMany({
    where: { createdAt: { gte: new Date("2026-01-01") } },
    select: { id: true, title: true, createdAt: true, shootDate: true, deliverables: { select: { createdAt: true, type: true } } },
  });
  const byDay = new Map<string, number>();
  const lateTypeByDay = new Map<string, Set<string>>();
  for (const p of rows) {
    if (p.deliverables.length === 0) continue;
    const latest = p.deliverables.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    if (latest.createdAt.getTime() - p.createdAt.getTime() <= 3_600_000) continue;
    const key = latest.createdAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
    if (!lateTypeByDay.has(key)) lateTypeByDay.set(key, new Set());
    lateTypeByDay.get(key)!.add(latest.type);
  }
  console.log("the DAY the last owed row landed, for projects whose rows arrived late:");
  for (const [k, n] of [...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`   ${k}  ${String(n).padStart(4)} project(s)   types: ${[...lateTypeByDay.get(k)!].join(",")}`);
  }
  const total = [...byDay.values()].reduce((a, b) => a + b, 0);
  const top3 = [...byDay.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  console.log(`\n${total} late-row projects; the three biggest days account for ${top3} (${Math.round((top3 / total) * 100)}%)`);

  // Same question for jobs booked in the last 30 days only — the shape the pin
  // writer will actually meet from here on.
  const recent = rows.filter((p) => p.createdAt >= new Date(Date.now() - 30 * 86_400_000));
  let grew = 0;
  for (const p of recent) {
    if (p.deliverables.length === 0) continue;
    const latest = p.deliverables.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    if (latest.createdAt.getTime() - p.createdAt.getTime() > 3_600_000) {
      grew++;
      console.log(`   recent: ${p.title.slice(0, 38).padEnd(40)} project ${p.createdAt.toISOString().slice(0, 16)} last row ${latest.createdAt.toISOString().slice(0, 16)} ${latest.type}`);
    }
  }
  console.log(`projects booked in the last 30 days: ${recent.length}; whose owed rows arrived late: ${grew}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
