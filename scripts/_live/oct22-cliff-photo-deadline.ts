// Oct 22 2026: 615 Cliff Ln's photo job carried the order's delivery date
// (Oct 27, dated by the Social Influencer reel). Jordan: "they are due today".
// The photos turnaround (20 h) from the Oct 21 4:15 PM ET visit: Oct 22 12:15
// PM ET. One row, compare-and-set. Dry run unless --apply.
export {};
const JOB = "cmvik1csg000tjt07jbfs79zs";
const WAS = "2026-10-27T21:00:00.000Z";
const DUE = new Date("2026-10-22T16:15:00.000Z");
async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../src/lib/prisma");
  const j = await prisma.photoJob.findUnique({ where: { id: JOB }, select: { stage: true, slaDueAt: true } });
  console.log("before:", j);
  if (!j || j.slaDueAt?.toISOString() !== WAS) { console.log("not the expected deadline; nothing written"); return prisma.$disconnect(); }
  if (!apply) { console.log("dry run: would set", DUE.toISOString()); return prisma.$disconnect(); }
  const r = await prisma.photoJob.updateMany({ where: { id: JOB, slaDueAt: new Date(WAS) }, data: { slaDueAt: DUE } });
  if (r.count === 1) {
    const { logJobEvent } = await import("../../src/lib/photoDelivery/jobState");
    await logJobEvent(JOB, "Jordan (by Claude)", "photo deadline set to Thu, Oct 22, 12:15 PM ET: the photos turnaround from the Oct 21 visit (was Oct 27, the order's reel date)");
  }
  console.log("after:", await prisma.photoJob.findUnique({ where: { id: JOB }, select: { slaDueAt: true } }));
  await prisma.$disconnect();
}
main();
