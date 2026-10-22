export {};
// LIVE ONE-OFF (Oct 22 2026). Jordan: 859 N Lawrence St's approved revision
// "should have" gone through Topaz: "It was a revision." Its round 1 went
// through the pass and to Joe; the revision was skipped as already 1080p. The
// hub's own Try again (topazJobs.retryTopazJob) sends an already-finished skip
// through the pass (resolution force-pass); the Topaz cron does the rest with
// every price and spend guard. Dry run by default; --apply queues it.
async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const sub = await prisma.reviewSubmission.findFirst({ where: { projectId: "cmv7g70jf0005jp0630bolmjp", fileName: { startsWith: "Revised_859" }, status: "APPROVED" }, select: { id: true, fileName: true, sentToClientAt: true, topazJob: { select: { id: true, state: true, resolution: true, skipReason: true } } } });
  console.log(JSON.stringify(sub));
  if (!sub?.topazJob) throw new Error("no Topaz job for the revision");
  if (sub.sentToClientAt) console.log("NOTE: already sent to the client");
  if (!process.argv.includes("--apply")) { console.log("dry run (add --apply)"); process.exit(0); }
  const { retryTopazJob } = await import("../../src/lib/topazJobs");
  console.log(JSON.stringify(await retryTopazJob(sub.topazJob.id)));
  console.log(JSON.stringify(await prisma.topazJob.findUnique({ where: { id: sub.topazJob.id }, select: { state: true, resolution: true } })));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
