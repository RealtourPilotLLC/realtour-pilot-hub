import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
function normProductGuess(s:string){return s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
async function main() {
  const prods = await prisma.product.findMany({ select:{title:true, mediaTypes:true, videoTier:true, serviceKind:true, addonTypes:true, videoQuantity:true, active:true } });
  console.log("=== PRODUCTS:", prods.length, " mapped:", prods.filter(p=>p.mediaTypes).length, " UNMAPPED:", prods.filter(p=>!p.mediaTypes).length);
  console.log("\n-- UNMAPPED products (no mediaTypes → parser fallback):");
  for (const p of prods.filter(p=>!p.mediaTypes)) console.log(`   active=${p.active} ${p.title}`);

  // Which order-item titles used in the last 180 days have NO product mapping?
  const since = new Date(Date.now()-180*86400000);
  const items = await prisma.orderItem.findMany({
    where: { project: { orderedAt: { gte: since } } },
    select: { title:true, isCanceled:true, project:{select:{id:true,title:true,orderedAt:true}} } });
  const mapped = new Set(prods.filter(p=>p.mediaTypes).map(p=>normProductGuess(p.title)));
  const known = new Set(prods.map(p=>normProductGuess(p.title)));
  const counts = new Map<string, number>();
  for (const it of items) { if (it.isCanceled) continue; counts.set(it.title, (counts.get(it.title)??0)+1); }
  console.log("\n=== ORDER-ITEM TITLES last 180d (count) — [MAPPED]/[no product row]/[product but UNMAPPED]");
  for (const [t,c] of [...counts.entries()].sort((a,b)=>b[1]-a[1])) {
    const n = normProductGuess(t);
    const tag = mapped.has(n) ? "MAPPED " : known.has(n) ? "PRODUCT-UNMAPPED" : "NO-PRODUCT-ROW";
    console.log(`${String(c).padStart(4)}  [${tag}] ${t}`);
  }
}
main().finally(()=>prisma.$disconnect());
