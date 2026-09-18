// READ-ONLY. Is the Greycliffe "cannot find the video" loop still open, and do
// any of the other candidates carry an unanswered delivery complaint?
import { prisma } from "@/lib/prisma";

async function main() {
  const p = await prisma.project.findFirst({ where: { title: { contains: "626 Greycliffe" } }, select: { id: true, title: true } });
  if (p) {
    const tasks = await prisma.smartTask.findMany({
      where: { projectId: p.id },
      select: { id: true, taskType: true, title: true, status: true, createdAt: true, completedAt: true, dueAt: true, assignedKey: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    console.log(`\n══ ${p.title} — ${tasks.length} tasks`);
    for (const t of tasks) {
      console.log(`   ${t.status.padEnd(11)} ${String(t.taskType).padEnd(20)} ${t.completedAt ? `closed ${t.completedAt.toISOString().slice(0, 10)}` : "OPEN      "} ${t.title.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  // Every open task on any of the 16, by kind — so the exception note can name
  // a loop that already exists instead of inventing a second one.
  const titles = ["296 Sugar Maple", "45 Heron Hill", "316 W Market", "143 Penns Manor", "330 N Charlotte", "1741 Hilltop", "3408 Oak Hill", "626 Greycliffe", "1125 N Broom", "2310 Ellsworth", "1845 Serene", "893 S Matlack", "2009 Garrison", "208 N Adams", "5642 Limeport", "2051 Old Sumneytown"];
  console.log("\nOPEN TASKS ON THE 16:");
  for (const t of titles) {
    const proj = await prisma.project.findFirst({ where: { title: { contains: t } }, select: { id: true, title: true } });
    if (!proj) continue;
    const open = await prisma.smartTask.findMany({
      where: { projectId: proj.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { taskType: true, title: true, status: true, createdAt: true },
    });
    if (open.length) console.log(`   ${proj.title.slice(0, 34).padEnd(34)} ${open.map((o) => `${o.taskType}:${o.title.replace(/\s+/g, " ").slice(0, 46)}`).join(" | ")}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
