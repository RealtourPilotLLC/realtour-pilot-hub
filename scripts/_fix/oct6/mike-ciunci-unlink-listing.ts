// Oct 12 2026 (Jordan): "Mike Ciunci has not booked his shoot yet. It was
// mis-scheduled. It should be updated since the appointment changed from video
// starter to a listing shoot instead." 141 E Marshall St (Oct 12, now a Premium
// Social Media Reel listing job) is unlinked from his October content month, so
// October reads "book your filming" again. The auto-attach only links monthly-
// plan products, so it won't re-link. No client messages; nothing in Aryeo.
import { prisma } from "../../../src/lib/prisma";
const PROJECT = "cmuzmmqre011ul504lfsfwjau", OCT = "cmup0bq3y00qfjg047fqwv7oy";
(async () => {
  const cv = await prisma.contentVideo.findMany({ where: { projectId: PROJECT }, select: { id: true, status: true, monthKey: true } });
  console.log("content videos on the job:", JSON.stringify(cv));
  await prisma.$transaction(async (tx) => {
    const ch = await tx.project.updateMany({ where: { id: PROJECT, contentMonthId: OCT }, data: { contentMonthId: null } });
    if (ch.count !== 1) throw new Error("link changed");
    await tx.portalVideo.updateMany({ where: { projectId: PROJECT }, data: { monthId: null } });
    await tx.activity.create({ data: { projectId: PROJECT, type: "SYSTEM", body: "Claude (for Jordan) unlinked this job from Mike Ciunci's 2026-10 content month. Reason: Jordan, Oct 12 2026 — the appointment changed from Video Starter to a listing shoot; his October content session is not booked yet." } });
  });
  const { recalcProgramMonth } = await import("../../../src/lib/programMonths");
  await recalcProgramMonth(OCT);
  console.log(await prisma.contentMonth.findUnique({ where: { id: OCT }, select: { monthKey: true, preparationStatus: true, status: true } }), "linked jobs:", await prisma.project.count({ where: { contentMonthId: OCT } }));
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
