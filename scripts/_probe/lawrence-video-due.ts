// Read-only: why is 859 N Lawrence's listing video "late"?
import { deliveryBoard } from "@/lib/deliveryBoard";
import { prisma } from "@/lib/prisma";
(async () => {
  const pid = "cmv7g70jf0005jp0630bolmjp";
  const pr = await prisma.project.findUnique({ where: { id: pid }, select: { promisedDueAt: true, deliveryDue: true, shootDate: true, orderedAt: true, packageName: true } });
  console.log("project", JSON.stringify(pr));
  const b = await deliveryBoard();
  const all = JSON.stringify(b);
  const jobs = (Object.values(b) as unknown[]).flatMap((v) => (Array.isArray(v) ? v : [])) as Array<Record<string, unknown>>;
  const j = jobs.find((x) => x.projectId === pid || x.id === pid);
  console.log(j ? JSON.stringify(j, (k, v) => (k === "notes" ? undefined : v)).slice(0, 2500) : `not found in lanes; mentions: ${all.includes(pid)}`);
  await prisma.$disconnect();
})();
