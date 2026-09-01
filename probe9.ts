import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main(){
  const runs = await prisma.cronRun.findMany({ where:{ job:"sync" }, orderBy:{startedAt:"desc"}, take:12 });
  for (const r of runs) console.log(JSON.stringify(r).slice(0,1500), "\n");
}
main().finally(()=>prisma.$disconnect());
