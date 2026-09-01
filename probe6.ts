import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
function etYearMonth(date: Date){const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"numeric"}).formatToParts(date);
 return {year:Number(parts.find(x=>x.type==="year")!.value), monthIdx:Number(parts.find(x=>x.type==="month")!.value)-1};}
function conv(p:{title:string;addressLine:string|null;shootDate:Date|null;createdAt:Date;client:{name:string}}){
 const d=p.shootDate??p.createdAt;const {year,monthIdx}=etYearMonth(d);const month=MONTHS[monthIdx];const q=`Q${Math.floor(monthIdx/3)+1}`;
 const street=(p.addressLine||p.title.split(",")[0]||"Listing").trim();return `/AutoHDR/${year}/${q}/${month}/${street} (${p.client.name})`;}
async function main(){
  const ps = await prisma.project.findMany({
    where:{ dropboxFolder:{not:null} },
    select:{id:true,title:true,addressLine:true,shootDate:true,createdAt:true,status:true,dropboxFolder:true,client:{select:{name:true}}},
    orderBy:{shootDate:"desc"} });
  console.log("projects with a stored dropboxFolder:", ps.length);
  const bad = ps.filter(p=>p.dropboxFolder !== conv(p));
  console.log("STORED != CONVENTION:", bad.length);
  for (const p of bad.slice(0,40)) {
    console.log(`\n  ${p.status} ${p.shootDate?.toISOString().slice(0,10)} ${p.title.slice(0,44)}`);
    console.log(`    stored : ${p.dropboxFolder}`);
    console.log(`    conv   : ${conv(p)}`);
  }
  // collisions: two projects computing the same convention path
  const byPath = new Map<string,string[]>();
  const all = await prisma.project.findMany({ where:{ status:{notIn:["CANCELLED"]} }, select:{id:true,title:true,addressLine:true,shootDate:true,createdAt:true,client:{select:{name:true}},status:true} });
  for (const p of all){ const c=conv(p); byPath.set(c,[...(byPath.get(c)??[]),`${p.status} ${p.shootDate?.toISOString().slice(0,10)} ${p.title.slice(0,40)}`]); }
  console.log("\n=== CONVENTION-PATH COLLISIONS (two live jobs → one folder)");
  for (const [k,v] of byPath) if (v.length>1) console.log(`${k}\n   ${v.join("\n   ")}`);
}
main().finally(()=>prisma.$disconnect());
