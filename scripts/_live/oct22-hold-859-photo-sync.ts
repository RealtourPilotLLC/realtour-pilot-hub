export {};
// LIVE ONE-OFF (Oct 22 2026, 6:55 PM ET). The photo audit found the 6-hour
// listing sync moves a REVISION_REQUESTED job to Delivered whenever Aryeo says
// "delivered" (jobs.ts ~834) and then auto-closes the client's photo asks.
// 859 N Lawrence St (Joe: restage pic 11, stage pic 38) is due at 8:03 PM ET.
// Until the fix deploys, its next check moves to Fri Oct 23, 4:00 PM ET.
// Nothing else on the job changes. Dry run by default; --apply writes.
async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const id = "cmvgypc0p002cl708t8lgzjd3";
  const j = await prisma.photoJob.findUniqueOrThrow({ where: { id }, select: { stage: true, nextCheckAt: true } });
  console.log(JSON.stringify(j));
  if (j.stage !== "REVISION_REQUESTED") { console.log("not in revision: nothing to do"); process.exit(0); }
  if (!process.argv.includes("--apply")) { console.log("dry run (add --apply)"); process.exit(0); }
  await prisma.photoJob.update({ where: { id }, data: { nextCheckAt: new Date("2026-10-23T20:00:00Z") } });
  console.log(JSON.stringify(await prisma.photoJob.findUnique({ where: { id }, select: { stage: true, nextCheckAt: true } })));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
