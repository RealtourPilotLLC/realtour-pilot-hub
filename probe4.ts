import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const now = new Date();
  console.log("=== STATUS COUNTS");
  const g = await prisma.project.groupBy({ by:["status"], _count:true });
  console.log(g.map(x=>`${x.status}=${x._count}`).join("  "));

  console.log("\n=== PAST-DATED but still SCHEDULED/BOOKED (shot but never moved) — last 120d");
  const stuck = await prisma.project.findMany({
    where: { status: { in:["SCHEDULED","BOOKED"] }, shootDate: { lt: now, gte: new Date(Date.now()-120*86400000) } },
    select: { id:true, title:true, status:true, shootDate:true, uploadedAt:true, debriefSubmittedAt:true, dropboxFolder:true,
      photographer:{select:{name:true}}, deliverables:{select:{type:true,status:true}} },
    orderBy:{shootDate:"desc"} });
  for (const p of stuck) console.log(`${p.shootDate?.toISOString().slice(0,16)} ${p.status.padEnd(9)} ${p.title.slice(0,40).padEnd(40)} ph=${p.photographer?.name??"NONE"} uploaded=${!!p.uploadedAt} debrief=${!!p.debriefSubmittedAt} dbx=${p.dropboxFolder?"y":"NULL"}`);

  console.log("\n=== BOOKED with no shootDate (never scheduled) — ordered in last 120d");
  const noDate = await prisma.project.findMany({
    where: { status:{in:["BOOKED"]}, shootDate: null, orderedAt: { gte: new Date(Date.now()-120*86400000) } },
    select: { id:true, title:true, orderedAt:true, appointments:{select:{status:true,startAt:true}}, client:{select:{name:true}} },
    orderBy:{orderedAt:"desc"} });
  for (const p of noDate) console.log(`ordered ${p.orderedAt?.toISOString().slice(0,10)} ${p.title.slice(0,42).padEnd(42)} ${p.client.name} appts=${p.appointments.map(a=>a.status+":"+(a.startAt?.toISOString().slice(0,10)??"null")).join(",")||"NONE"}`);

  console.log("\n=== SHOT / EDITING / REVIEW / REVISION detail");
  const active = await prisma.project.findMany({
    where: { status:{in:["SHOT","EDITING","REVIEW","REVISION"]} },
    select: { id:true, title:true, status:true, shootDate:true, uploadedAt:true, debriefSubmittedAt:true, editorId:true,
      editor:{select:{name:true}}, photographer:{select:{name:true}}, statusEvidence:true, statusCheckedAt:true,
      deliverables:{select:{type:true,status:true}} },
    orderBy:{shootDate:"asc"} });
  for (const p of active) {
    const ageD = p.shootDate ? Math.round((now.getTime()-p.shootDate.getTime())/86400000) : null;
    console.log(`${(p.shootDate?.toISOString().slice(0,10))??"no-date"} +${ageD}d ${p.status.padEnd(9)} ${p.title.slice(0,36).padEnd(36)} ed=${(p.editor?.name??"NONE").padEnd(10)} up=${p.uploadedAt?"y":"n"} db=${p.debriefSubmittedAt?"y":"n"} chk=${p.statusCheckedAt?.toISOString().slice(0,10)??"never"} dl=${p.deliverables.map(d=>d.type+":"+d.status).join(",")}`);
  }
}
main().finally(()=>prisma.$disconnect());
