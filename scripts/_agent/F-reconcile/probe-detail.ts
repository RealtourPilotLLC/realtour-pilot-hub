// READ-ONLY probe. The three jobs that decide the exception list, in full:
// product identity, activity history (who wrote DELIVERED), and the Dropbox
// numbers. Writes nothing.
import { prisma } from "@/lib/prisma";

const NEEDLES = ["45 Heron Hill", "893 S Matlack", "5642 Limeport", "626 Greycliffe", "296 Sugar Maple", "1125 N Broom"];

async function main() {
  for (const needle of NEEDLES) {
    const p = await prisma.project.findFirst({
      where: { title: { contains: needle } },
      select: {
        id: true, title: true, status: true, deliveredAt: true, deliveredBy: true, deliveredVia: true,
        aryeoListingId: true, aryeoOrderId: true, createdAt: true, shootDate: true,
        deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, productTitle: true, videoStyle: true, quantity: true, status: true } },
        activities: { orderBy: { createdAt: "desc" }, take: 6, select: { type: true, body: true, createdAt: true, authorId: true } },
      },
    });
    if (!p) { console.log(`\n${needle}: NOT FOUND`); continue; }
    console.log(`\n══ ${p.title}  [${p.status}]  listing=${p.aryeoListingId ?? "none"}`);
    console.log(`   deliveredAt=${p.deliveredAt?.toISOString().slice(0, 16) ?? "none"} by=${p.deliveredBy ?? "-"} via=${p.deliveredVia ?? "-"}  shoot=${p.shootDate?.toISOString().slice(0, 10) ?? "-"}`);
    for (const d of p.deliverables) {
      console.log(`   ordered  ${d.type.padEnd(16)} q=${d.quantity ?? 1} ${d.status.padEnd(9)} product="${(d.productTitle ?? d.label ?? "").slice(0, 52)}" style=${d.videoStyle ?? "-"}`);
    }
    for (const a of p.activities) {
      console.log(`   ${a.createdAt.toISOString().slice(0, 16)} ${a.type.padEnd(16)} author=${a.authorId ?? "SYSTEM"} ${a.body.replace(/\s+/g, " ").slice(0, 110)}`);
    }
  }

  // How many DELIVERED stamps carry an actor at all?
  const total = await prisma.project.count({ where: { deliveredAt: { not: null } } });
  const withBy = await prisma.project.count({ where: { deliveredAt: { not: null }, deliveredBy: { not: null } } });
  const withVia = await prisma.project.count({ where: { deliveredAt: { not: null }, deliveredVia: { not: null } } });
  console.log(`\ndeliveredAt stamps: ${total}   with deliveredBy: ${withBy}   with deliveredVia: ${withVia}`);
  console.log(`existing deliveryExceptionAt rows: ${await prisma.project.count({ where: { deliveryExceptionAt: { not: null } } })}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
