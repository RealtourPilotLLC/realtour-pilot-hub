// Read-only C14 inventory: does the normal Home workload have live synthetic
// rows beyond the already scoped exceptions and New clients card?
import { prisma } from "../../src/lib/prisma";
import { isSyntheticClientRow } from "../../src/lib/testClients";

async function main() {
  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const ids = clients.filter(isSyntheticClientRow).map((c) => c.id);
  const [activeProjects, currentTasks, recentProjects, reviewProjects, dueAppointments] = await Promise.all([
    prisma.project.count({ where: { clientId: { in: ids }, status: { notIn: ["DELIVERED", "CANCELLED", "ON_HOLD"] } } }),
    prisma.smartTask.count({ where: { OR: [{ clientId: { in: ids } }, { project: { clientId: { in: ids } } }], status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
    prisma.project.findMany({ where: { clientId: { in: ids }, status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } }, select: { id: true, status: true, title: true }, take: 25 }),
    prisma.project.count({ where: { clientId: { in: ids }, status: "REVIEW" } }),
    prisma.appointment.count({ where: { project: { clientId: { in: ids } }, status: { not: "CANCELED" }, startAt: { gte: new Date(Date.now() - 86_400_000), lte: new Date(Date.now() + 8 * 86_400_000) } } }),
  ]);
  console.log(JSON.stringify({ syntheticClients: ids.length, activeProjects, openTasks: currentTasks, reviewProjects, dueAppointments, productionStageExamples: recentProjects.map((p) => ({ id: p.id, status: p.status, title: p.title })) }, null, 2));
}
main().finally(() => prisma.$disconnect());
