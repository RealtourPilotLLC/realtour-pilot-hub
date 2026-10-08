// Oct 8 2026 (Jordan: "Yes" — John Collins' Sep 24 shoot at 80 W Lancaster Ave
// was his August content; approve his September catch-up into October).
// 1) same writes as content/actions.moveSessionToMonth (project + its library rows → August)
// 2) monthCatchUp.applyCatchUp(October, September). No client messages.
import { prisma } from "../../../src/lib/prisma";
const PROJECT = "cmu5lk5ah00mgl10478okkk3f", ENR = "cmt7h6axu00029kcjstmqbv0a";
const AUG = "cmt7h6bci000c9kcj9zyy1bo1", SEP = "cmti54uoz0052ic04q3wz5qzr", OCT = "cmup0bq5000qkjg04vm4tgnrp";
const BY = "Jordan Spackman";
(async () => {
  const p = await prisma.project.findUnique({ where: { id: PROJECT }, select: { title: true, clientId: true, contentMonthId: true, shootDate: true } });
  console.log("project", p);
  const aug = await prisma.contentMonth.findUnique({ where: { id: AUG }, select: { enrollmentId: true, monthKey: true } });
  if (!p || !aug || aug.enrollmentId !== ENR || aug.monthKey !== "2026-08") throw new Error("unexpected rows");
  if (p.contentMonthId === SEP) {
    await prisma.$transaction(async (tx) => {
      const ch = await tx.project.updateMany({ where: { id: PROJECT, contentMonthId: SEP }, data: { contentMonthId: AUG } });
      if (ch.count !== 1) throw new Error("month link changed");
      await tx.portalVideo.updateMany({ where: { projectId: PROJECT }, data: { monthId: AUG } });
      await tx.activity.create({ data: { projectId: PROJECT, type: "SYSTEM", body: "Claude (for Jordan) moved this session from 2026-09 to 2026-08 content month. Reason: Jordan, Oct 8 2026 — the Sep 24 shoot was John's August content." } });
    });
    console.log("moved to August");
  } else console.log("not on September — left as is:", p.contentMonthId);
  const cv = await prisma.contentVideo.findMany({ where: { projectId: PROJECT }, select: { id: true, monthKey: true, status: true } });
  console.log("content videos on the job", cv);
  const { applyCatchUp } = await import("../../../src/lib/monthCatchUp");
  const r = await applyCatchUp(OCT, SEP, BY);
  console.log("catch-up:", r.message);
  for (const id of [AUG, SEP, OCT]) console.log(id, await prisma.contentMonth.findUnique({ where: { id }, select: { monthKey: true, status: true, videosOwed: true, strategyCallStatus: true, planningMode: true, preparationStatus: true } }));
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
