// Oct 6 2026 (Jordan): "erica had a july content session at 302 Rita — it had
// one video for Spilo Play." Same writes as content/actions.attachUnlinkedSessionToMonth.
import { prisma } from "../../../src/lib/prisma";
const PROJECT = "cmr0ps1ur0001ju04yxias8kx", MONTH = "cmt7mvva000159kg1xpzjuovd";
(async () => {
  const [month, project] = await Promise.all([
    prisma.contentMonth.findUnique({ where: { id: MONTH }, select: { id: true, clientId: true, enrollmentId: true, monthKey: true } }),
    prisma.project.findUnique({ where: { id: PROJECT }, select: { clientId: true, contentMonthId: true, status: true } }),
  ]);
  if (!month || !project || project.clientId !== month.clientId) throw new Error("client mismatch");
  if (project.contentMonthId) { console.log("already linked", project.contentMonthId); }
  else {
    const c1 = await prisma.portalVideo.count({ where: { projectId: PROJECT, monthId: { not: null, notIn: [MONTH] } } });
    const c2 = await prisma.contentVideo.count({ where: { projectId: PROJECT, monthId: { not: null, notIn: [MONTH] } } });
    if (c1 || c2) throw new Error("conflicting video records");
    await prisma.$transaction(async (tx) => {
      const ch = await tx.project.updateMany({ where: { id: PROJECT, clientId: month.clientId, contentMonthId: null }, data: { contentMonthId: MONTH } });
      if (ch.count !== 1) throw new Error("link changed");
      await tx.activity.create({ data: { projectId: PROJECT, type: "SYSTEM", body: "Claude (for Jordan) linked this job to 2026-07 content month. Reason: Jordan, Oct 6 2026 — Erica's July content session; one video (Spilo Play)." } });
    });
    console.log("linked");
  }
  const { syncEnrollmentVideos } = await import("../../../src/lib/contentVideos");
  console.log("sync", await syncEnrollmentVideos({ id: month.enrollmentId, clientId: month.clientId }));
  console.log(await prisma.contentVideo.findMany({ where: { projectId: PROJECT }, select: { id: true, title: true, status: true, kind: true, monthKey: true, deliveredAt: true, releasedToClientAt: true } }));
  console.log(await prisma.portalVideo.findMany({ where: { projectId: PROJECT }, select: { id: true, title: true, monthId: true } as any }));
  await prisma.$disconnect();
})().catch(e => { console.error("ERR", e?.message); process.exit(1); });
