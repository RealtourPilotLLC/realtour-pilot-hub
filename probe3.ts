import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const st = await prisma.connection.findMany({ select: { provider:true, status:true, lastSyncedAt:true, lastError:true, updatedAt:true } });
  console.log("=== INTEGRATION STATE");
  for (const s of st) console.log(`${s.provider.padEnd(14)} conn=${s.status} lastSync=${s.lastSyncedAt?.toISOString()??"NEVER"} err=${(s.lastError??"").slice(0,120)}`);

  // Appointments not linked to any project
  const apptTotal = await prisma.appointment.count();
  console.log("\nappointments total:", apptTotal);
  const recentAppts = await prisma.appointment.findMany({
    where: { startAt: { gte: new Date(Date.now()-14*86400000) } },
    select: { aryeoId:true, startAt:true, status:true, projectId:true, assignedToId:true,
      project:{select:{id:true,title:true,status:true,shootDate:true,photographerId:true}} },
    orderBy:{startAt:"asc"} });
  console.log("recent/future appts:", recentAppts.length);
  for (const a of recentAppts) {
    const mismatch = a.project && a.startAt && a.project.shootDate && Math.abs(a.project.shootDate.getTime()-a.startAt.getTime())>60000 ? " SHOOTDATE-MISMATCH(proj="+a.project.shootDate.toISOString()+")" : "";
    const noPhotog = a.project && !a.project.photographerId ? " PROJ-NO-PHOTOG" : "";
    const apptNoAssign = !a.assignedToId ? " APPT-NO-ASSIGNEE" : "";
    console.log(`${a.startAt?.toISOString().slice(0,16)} ${String(a.status).padEnd(11)} proj=${a.project?.status??"NONE"} ${(a.project?.title??"?").slice(0,32).padEnd(32)}${mismatch}${noPhotog}${apptNoAssign}`);
  }
}
main().finally(()=>prisma.$disconnect());
