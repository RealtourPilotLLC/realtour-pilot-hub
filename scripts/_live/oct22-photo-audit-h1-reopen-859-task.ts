// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, photo audit H1). 859 N Lawrence St (Joseph Sutow).
//
// The video side closed the photo revision's to-do: resolveRevision (comms.ts)
// completed every `revision` task on the project when Jordan moved the job to
// Completed after the video v2 was approved (5:36:10 PM ET). The photo lane's
// task "Add outdoor staging to pic 38: furniture, fire pit, plants" (its key is
// the photo lane's, 451402fe…) was completed with it, though the photo job is
// still in Revision and Joe's photo 11 / photo 38 requests are still open. The
// code no longer does that (the photo lane closes only from the photo job);
// this puts that one task back: OPEN, completedAt cleared, a timeline line.
// Nothing else changes, nothing is sent.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-photo-audit-h1-reopen-859-task.ts
// Write it:
//   … scripts/_live/oct22-photo-audit-h1-reopen-859-task.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  // A dry run cannot write, whatever the code below does.
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

const TASK_ID = "cmvk18rmw0009l4088m0akdmx";

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { photoRevisionTaskKey } = await import("@/lib/photoDelivery/clientAsked");
  console.log(APPLY ? "APPLYING" : "DRY RUN (read-only connection)");
  const t = await prisma.smartTask.findUnique({ where: { id: TASK_ID }, select: { id: true, title: true, status: true, completedAt: true, dedupeKey: true, projectId: true, assignedKey: true } });
  if (!t?.projectId) throw new Error("the 859 photo revision task is not there");
  const job = await prisma.photoJob.findUnique({ where: { projectId: t.projectId }, select: { id: true, stage: true } });
  const asks = await prisma.clientAsk.findMany({ where: { projectId: t.projectId, state: "OPEN", medium: "photo" }, select: { id: true, summary: true } });
  console.log(`task ${t.id} "${t.title}": ${t.status}, completed ${t.completedAt?.toISOString() ?? "-"}, assigned ${t.assignedKey}`);
  console.log(`  key ${t.dedupeKey} = the photo lane's (${photoRevisionTaskKey(t.projectId)}): ${t.dedupeKey === photoRevisionTaskKey(t.projectId)}`);
  console.log(`  photo job ${job?.id}: ${job?.stage}; open photo requests: ${asks.length}`);
  for (const a of asks) console.log(`    · ${a.id}: ${a.summary}`);
  if (t.status !== "COMPLETED") {
    console.log("\nNothing to do: the task is not completed.");
    return prisma.$disconnect();
  }
  if (job?.stage !== "REVISION_REQUESTED") console.log(`\nNOTE: the photo job is ${job?.stage}, not in Revision; reopening anyway only if --apply (the photo work is still owed while the requests are open: ${asks.length}).`);
  console.log(`\nWould set task ${t.id} OPEN (completedAt cleared) and add a timeline line.`);
  if (!APPLY) return prisma.$disconnect();
  const r = await prisma.smartTask.updateMany({ where: { id: t.id, status: "COMPLETED" }, data: { status: "OPEN", completedAt: null } });
  await prisma.activity.create({ data: { projectId: t.projectId, type: "SYSTEM", body: "Photo revision to-do reopened (photo audit, Oct 22): the video's approval closed it by mistake; the photo requests for pic 11 and pic 38 are still open." } });
  console.log(`reopened: ${r.count}`);
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
