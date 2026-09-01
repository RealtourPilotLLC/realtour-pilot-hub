import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const upcoming = await prisma.project.findMany({
    where: { shootDate: { gte: new Date(Date.now() - 3*86400000), lt: new Date(Date.now() + 14*86400000) }, status: { notIn: ["CANCELLED","ON_HOLD"] } },
    select: { id:true, title:true, status:true, shootDate:true, dropboxFolder:true, lat:true, lng:true, packageName:true,
      photographer:{select:{name:true}}, client:{select:{name:true}},
      appointments:{select:{description:true,status:true,startAt:true}},
      deliverables:{select:{type:true,label:true}},
      orderItems:{select:{title:true,quantity:true,isCanceled:true}} },
    orderBy:{shootDate:"asc"} });
  for (const p of upcoming) {
    const brief = p.appointments.map(a=>a.description?.trim()).find(Boolean);
    console.log(`\n--- ${p.shootDate?.toISOString().slice(0,16)} ${p.title.slice(0,40)} [${p.status}] ph=${p.photographer?.name??"NONE"}`);
    console.log(`    dropboxFolder=${p.dropboxFolder ?? "NULL"}  latlng=${p.lat},${p.lng}  pkg=${p.packageName ?? "-"}`);
    console.log(`    appts=${p.appointments.length} briefLen=${brief?brief.length:0}  brief="${(brief??"").replace(/\s+/g," ").slice(0,120)}"`);
    console.log(`    deliverables=${p.deliverables.map(d=>d.type+(d.label?`(${d.label})`:"")).join(" | ")}`);
    console.log(`    orderItems=${p.orderItems.map(i=>`${i.title}${i.isCanceled?"[CANCELED]":""}x${i.quantity}`).join(" | ")}`);
  }
}
main().finally(()=>prisma.$disconnect());
