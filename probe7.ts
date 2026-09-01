import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main(){
  const ps = await prisma.project.findMany({
    where:{ OR:[{title:{contains:"Scotch Way"}},{title:{contains:"Koser"}},{title:{contains:"Graystone"}},{title:{contains:"Shelly Dr"}}] },
    select:{id:true,title:true,status:true,shootDate:true,orderedAt:true,createdAt:true,updatedAt:true,uploadedAt:true,debriefSubmittedAt:true,
      dropboxFolder:true, photographerId:true, photographer:{select:{name:true}}, client:{select:{name:true}}, aryeoOrderId:true, deliveredAt:true,
      deliverables:{select:{type:true,status:true,label:true}},
      appointments:{select:{aryeoId:true,startAt:true,status:true,postponedAt:true,previousStartAt:true,assignedToId:true,updatedAt:true}},
      activities:{orderBy:{createdAt:"desc"},take:8,select:{type:true,body:true,createdAt:true}},
      smartTasks:{where:{status:{notIn:["COMPLETED","CANCELLED"]}},select:{taskType:true,title:true,dueAt:true,status:true}} }});
  for (const p of ps){
    console.log(`\n======== ${p.title} [${p.status}] id=${p.id}`);
    console.log(` client=${p.client.name} photog=${p.photographer?.name??"NONE"} order=${p.aryeoOrderId}`);
    console.log(` orderedAt=${p.orderedAt?.toISOString()} shootDate=${p.shootDate?.toISOString()??"NULL"} uploadedAt=${p.uploadedAt?.toISOString()??"-"} delivered=${p.deliveredAt?.toISOString()??"-"} updated=${p.updatedAt.toISOString()}`);
    console.log(` dropboxFolder=${p.dropboxFolder}`);
    console.log(` deliverables=${p.deliverables.map(d=>`${d.type}:${d.status}`).join(",")}`);
    console.log(` appts:`); for(const a of p.appointments) console.log(`   ${a.aryeoId} start=${a.startAt?.toISOString()??"NULL"} status=${a.status} postponed=${a.postponedAt?.toISOString()??"-"} prevStart=${a.previousStartAt?.toISOString()??"-"} upd=${a.updatedAt.toISOString()}`);
    console.log(` openTasks: ${p.smartTasks.map(t=>t.taskType).join(",")||"none"}`);
    console.log(` recent activity:`); for(const a of p.activities) console.log(`   ${a.createdAt.toISOString().slice(0,16)} [${a.type}] ${a.body.slice(0,150)}`);
  }
}
main().finally(()=>prisma.$disconnect());
