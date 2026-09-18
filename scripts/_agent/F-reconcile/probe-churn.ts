// READ-ONLY. Who else is writing to Project right now? A Next dev server has
// been up against this same production database since 19:26, so "updatedAt
// moved during my run" needs a second look before it is blamed on my run.
import { prisma } from "@/lib/prisma";

async function main() {
  const now = Date.now();
  for (const mins of [1, 5, 15, 60]) {
    const since = new Date(now - mins * 60_000);
    const n = await prisma.project.count({ where: { updatedAt: { gte: since } } });
    console.log(`projects with updatedAt in the last ${String(mins).padStart(2)} min: ${n}`);
  }
  const recent = await prisma.project.findMany({
    where: { updatedAt: { gte: new Date(now - 5 * 60_000) } },
    select: { id: true, title: true, status: true, updatedAt: true, statusCheckedAt: true, deliveryExceptionAt: true },
    orderBy: { updatedAt: "desc" },
    take: 25,
  });
  console.log(`\nthe last ${recent.length} rows to move (mine are the ones with an exception stamp):`);
  for (const r of recent) {
    console.log(`   ${r.updatedAt.toISOString()}  ${r.status.padEnd(10)} ${r.title.split(",")[0].slice(0, 34).padEnd(34)} exception=${r.deliveryExceptionAt ? r.deliveryExceptionAt.toISOString() : "-"}`);
  }
  console.log("\nthe three flagged rows, read again:");
  const flagged = await prisma.project.findMany({
    where: { deliveryExceptionAt: { not: null } },
    select: { title: true, updatedAt: true, deliveryExceptionAt: true },
    orderBy: { deliveryExceptionAt: "asc" },
  });
  for (const f of flagged) {
    const gapMs = f.deliveryExceptionAt!.getTime() - f.updatedAt.getTime();
    console.log(`   ${f.title.split(",")[0].padEnd(24)} updatedAt=${f.updatedAt.toISOString()}  exceptionAt=${f.deliveryExceptionAt!.toISOString()}  exception is ${(gapMs / 1000).toFixed(1)}s LATER`);
  }
  console.log("\n  A Prisma update would have set updatedAt to the moment of the write, so all three would read");
  console.log("  the same second as exceptionAt. They do not, and they do not even agree with each other.");
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
