// Oct 6 2026 (Jordan): the 302 Rita Ct July session's one video (Spilo Play) is
// a July PROGRAM video. Staff identity correction, audited via ContentVideoCorrection.
import { prisma } from "../../../src/lib/prisma";
(async () => {
  const { correctVideoIdentity } = await import("../../../src/lib/contentVideos");
  const r = await correctVideoIdentity("cmt7h6b0300059kcj990r34x7", "cmux33ljp00129kxp3vvqq7gt",
    { kind: "PROGRAM", title: "Spilo Play Promo", confirmMonth: true }, "info@realtourpilot.com",
    "Jordan, Oct 6 2026: Erica's July content session at 302 Rita had one video, for Spilo Play.");
  console.log(r);
  console.log(await prisma.contentVideo.findUnique({ where: { id: "cmux33ljp00129kxp3vvqq7gt" }, select: { title: true, kind: true, countsTowardAllowance: true, monthKey: true, identityConfirmedAt: true, status: true } }));
  await prisma.$disconnect();
})().catch(e => { console.error("ERR", e?.message); process.exit(1); });
