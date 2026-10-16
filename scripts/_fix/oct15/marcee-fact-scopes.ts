// LIVE (Oct 15 2026): the call analysis filed six of Marcee's facts as PROJECT
// scope with no project (so they surfaced nowhere) or as October-only when
// they are about the relationship. They become PERMANENT; the renovation
// video note stays October-only. Uses lib/clientFacts.setFactScope.
export {};
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { setFactScope } = await import("@/lib/clientFacts");
  const rows = await prisma.clientFact.findMany({
    where: { clientId: "cmqiksjju007v9k9qtuql2n4e", createdAt: { gte: new Date("2026-10-15T00:00:00Z") }, scope: { not: "PERMANENT" }, NOT: { body: { startsWith: "Renovation-cost video" } } },
    select: { id: true, body: true },
  });
  for (const r of rows) { await setFactScope(r.id, "PERMANENT", {}); console.log("PERMANENT:", r.body.slice(0, 80)); }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
