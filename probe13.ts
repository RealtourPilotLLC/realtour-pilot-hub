import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
function parseAccessBrief(raw: string | null) {
  if (!raw?.trim()) return { name:null,email:null,phone:null,notes:null };
  const text = raw.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
  const grab=(re:RegExp)=>text.match(re)?.[1]?.trim()||null;
  const name=grab(/Name:\s*(.*?)(?=\s*(?:Email:|Phone:|Notes:|Order Items|$))/i);
  const email=grab(/Email:\s*(\S+@\S+)/i);
  const phone=grab(/Phone:\s*([()\d\s+.-]{7,20})/i);
  let notes=grab(/Notes:\s*(.*?)(?=\s*Order Items|$)/i);
  if (notes && /^n\/?a$/i.test(notes)) notes=null;
  const firstLabel=text.search(/(?:Customer|Contact|Name|Email|Phone|Notes|Order Items):/i);
  const leftover=firstLabel>0?text.slice(0,firstLabel).trim():"";
  if (leftover && !/^(?:Customer|Contact|Name|Email|Phone|Notes|Order(?: Items)?)(?: (?:Name|Info))?\s*:?$/i.test(leftover)) notes=notes?`${leftover} — ${notes}`:leftover;
  if (!name&&!email&&!phone&&!notes) notes=text.slice(0,300);
  return {name,email,phone,notes:notes?notes.slice(0,300):null};
}
async function main(){
  const ps = await prisma.project.findMany({
    where:{ shootDate:{gte:new Date(Date.now()-2*86400000), lt:new Date(Date.now()+10*86400000)}, status:{notIn:["CANCELLED","ON_HOLD"]} },
    select:{title:true,shootDate:true,appointments:{select:{description:true}}}, orderBy:{shootDate:"asc"} });
  for (const p of ps){
    const raw = p.appointments.map(a=>a.description?.trim()).find(Boolean) ?? null;
    const a = parseAccessBrief(raw);
    console.log(`\n### ${p.shootDate?.toISOString().slice(0,16)} ${p.title.slice(0,40)}`);
    console.log(`   name=${a.name} phone=${a.phone}`);
    console.log(`   NOTES: ${a.notes ?? "(none)"}`);
    console.log(`   RAWTAIL: ${(raw??"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").slice(0,600)}`);
  }
}
main().finally(()=>prisma.$disconnect());
