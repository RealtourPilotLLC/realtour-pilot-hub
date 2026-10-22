// Read-only: every product title ordered since Jul 1 and the turnaround tier it gets.
import { prisma } from "@/lib/prisma";
import * as t from "@/lib/turnaround";
(async () => {
  const rows = await prisma.orderItem.groupBy({ by: ["title"], where: { project: { orderedAt: { gte: new Date("2026-07-01") } } }, _count: true }).catch(async (e) => { console.log(String(e).slice(0, 300)); return []; });
  const fn = (t as Record<string, unknown>).tierForTitle ?? (t as Record<string, unknown>).tierFor ?? (t as Record<string, unknown>).classifyTier;
  console.log("tier fn:", Object.keys(t).filter((k) => /tier/i.test(k)).join(", "));
  for (const r of rows.sort((a, b) => b._count - a._count)) console.log(r._count, "|", r.title, "|", typeof fn === "function" ? JSON.stringify((fn as (x: string) => unknown)(r.title as string)) : "");
  await prisma.$disconnect();
})();
