import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main(){
  const runs = await prisma.cronRun.findMany({ orderBy:{startedAt:"desc"}, take:14 });
  for (const r of runs){
    console.log(`\n${r.startedAt.toISOString()} job=${r.job} ok=${(r as any).ok ?? (r as any).status} ms=${(r as any).durationMs ?? "-"}`);
    const raw = (r as any).resultJson ?? (r as any).result ?? (r as any).summary;
    if (raw) { try { const j=JSON.parse(raw as string); for (const [k,v] of Object.entries(j)) console.log(`   ${k}: ${JSON.stringify(v).slice(0,220)}`);} catch { console.log("   ", String(raw).slice(0,400)); } }
  }
}
main().finally(()=>prisma.$disconnect());
