import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main(){
  const ps = await prisma.project.findMany({ where:{ status:{in:["SHOT","EDITING","REVIEW","REVISION"]} }, select:{title:true,status:true,statusEvidence:true} });
  for (const p of ps) console.log(`\n### ${p.status} ${p.title.slice(0,40)}\n${p.statusEvidence}`);
}
main().finally(()=>prisma.$disconnect());
