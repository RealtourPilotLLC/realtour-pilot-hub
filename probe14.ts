import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main(){
  const now=new Date();
  const ps = await prisma.project.findMany({
    where:{ status:{in:["SHOT","EDITING","REVIEW","REVISION"]} },
    select:{id:true,title:true,status:true,shootDate:true,statusEvidence:true,deliveryDue:true,videosFilmed:true,packageName:true,
      editor:{select:{name:true}},
      deliverables:{select:{type:true,label:true,status:true,notCompletedReason:true}},
      smartTasks:{where:{status:{notIn:["COMPLETED","CANCELLED"]}},select:{taskType:true,title:true,assignedKey:true,dueAt:true,priority:true}} },
    orderBy:{shootDate:"asc"} });
  for (const p of ps){
    console.log(`\n### ${p.status} ${p.shootDate?.toISOString().slice(0,10)} ${p.title.slice(0,44)} ed=${p.editor?.name??"NONE"} due=${p.deliveryDue?.toISOString().slice(0,16)??"-"} videosFilmed=${p.videosFilmed??"-"}`);
    console.log(`   deliverables: ${p.deliverables.map(d=>`${d.type}[${d.label}]:${d.status}${d.notCompletedReason?" NOTDONE:"+d.notCompletedReason:""}`).join(" | ")}`);
    console.log(`   evidence: ${(p.statusEvidence??"").slice(0,400)}`);
    console.log(`   tasks: ${p.smartTasks.map(t=>`${t.taskType}(${t.assignedKey??"-"},due=${t.dueAt?.toISOString().slice(0,16)??"-"})`).join(" | ")||"NONE"}`);
  }
}
main().finally(()=>prisma.$disconnect());
