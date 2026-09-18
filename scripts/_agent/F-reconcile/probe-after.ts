// READ-ONLY. What the three flagged jobs look like now, and what the radar row
// would say. The updatedAt values are the point: if the write had gone through
// Prisma they would all read "now".
import { prisma } from "@/lib/prisma";
import { deliveryExceptionFlags } from "@/lib/deliveryExceptions";

async function main() {
  const rows = await prisma.project.findMany({
    where: { deliveryExceptionAt: { not: null } },
    select: {
      id: true, title: true, status: true, deliveredAt: true, updatedAt: true, statusCheckedAt: true,
      deliveryExceptionAt: true, deliveryExceptionNote: true,
    },
    orderBy: { deliveryExceptionAt: "desc" },
  });
  console.log(`flagged: ${rows.length}   ·  now: ${new Date().toISOString()}\n`);
  for (const r of rows) {
    console.log(`${r.title.split(",")[0]}`);
    console.log(`   status=${r.status}  deliveredAt=${r.deliveredAt?.toISOString() ?? "none"}`);
    console.log(`   updatedAt=${r.updatedAt.toISOString()}   <- untouched by the flag`);
    console.log(`   statusCheckedAt=${r.statusCheckedAt?.toISOString() ?? "none"}`);
    console.log(`   exceptionAt=${r.deliveryExceptionAt?.toISOString()}`);
    console.log(`   note: ${r.deliveryExceptionNote}\n`);
  }
  console.log("THE RADAR ROWS (getProactiveFlags shape):");
  for (const f of await deliveryExceptionFlags()) {
    console.log(`   [${f.severity}] ${f.kind}  ${f.title}`);
    console.log(`      ${f.detail}`);
    console.log(`      -> ${f.href}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
