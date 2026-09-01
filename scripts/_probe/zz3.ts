import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
(async () => {
  for (const street of ["632 Greenridge", "38 E Gay", "1033 Preserve"]) {
    const p = await prisma.project.findFirst({
      where: { OR: [{ addressLine: { contains: street } }, { title: { contains: street } }] },
      include: { deliverables: true, editor: true, client: true },
    });
    if (!p) { console.log(street, "NOT FOUND"); continue; }
    console.log("=== " + (p.addressLine || p.title) + " id=" + p.id);
    console.log(" status=", p.status, "editorManual=", (p as any).editorManual, "editor=", p.editor?.name, "shoot=", p.shootDate?.toISOString().slice(0,10), "due=", p.deliveryDue?.toISOString().slice(0,10), "delivered=", p.deliveredAt?.toISOString().slice(0,10) ?? "-", "created=", p.createdAt.toISOString().slice(0,10), "updated=", p.updatedAt.toISOString().slice(0,16));
    console.log(" videosFilmed=", (p as any).videosFilmed, "package=", p.packageName);
    console.log(" deliverables:", p.deliverables.map((d) => d.type + "/" + (d.label ?? "") + "x" + (d.quantity ?? 1)).join(" | "));
    console.log(" evidence:", (p.statusEvidence ?? "").slice(0, 400));
    const tasks = await prisma.smartTask.findMany({ where: { projectId: p.id }, select: { taskType: true, status: true, assignedKey: true, title: true, createdAt: true }, orderBy: { createdAt: "asc" } });
    console.log(" tasks:");
    for (const t of tasks) console.log("   ", t.taskType.padEnd(22), String(t.status).padEnd(10), "key=" + String(t.assignedKey).padEnd(8), t.createdAt.toISOString().slice(0,10), "|", t.title.slice(0, 60));
    const subs = await prisma.reviewSubmission.findMany({ where: { projectId: p.id }, select: { round: true, status: true, submittedByKey: true, fileName: true, createdAt: true } });
    console.log(" submissions:", subs.map((s) => "r" + s.round + "/" + s.status + "/" + s.submittedByKey + "/" + s.fileName + "/" + s.createdAt.toISOString().slice(0,10)).join(" ; ") || "none");
    const acts = await prisma.activity.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "desc" }, take: 8, select: { type: true, body: true, createdAt: true } });
    console.log(" recent activity:");
    for (const a of acts) console.log("   ", a.createdAt.toISOString().slice(0,16), a.type, "|", (a.body ?? "").slice(0, 90));
  }
  await prisma.$disconnect();
})();
