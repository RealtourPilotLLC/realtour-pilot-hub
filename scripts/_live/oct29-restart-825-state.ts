// ---------------------------------------------------------------------------
// 825 State St, Lancaster: Kyle approved the delivery at 1:04 PM; the photos
// went on the Aryeo listing; the Deliver step stopped at 1:23 PM on one
// dropped connection ("fetch failed"), before 63e8949d made that wait and
// carry on. Jordan, Oct 29 2026: "Yes, restart 825 State St's delivery."
// Starts the same Approve and deliver Kyle pressed (approveJob, deliver),
// nothing else: the photos already on the listing are not sent again, and the
// production cron (every 5 minutes) checks the listing, delivers it in Aryeo
// and confirms it. Dry run by default (read-only connection, proven); --apply
// starts it. Refuses if the job or its run moved on since the dry run.
//
//   set -a && source .env && set +a && npx tsx --require \
//     ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct29-restart-825-state.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const JOB = "cmvshfvc6003nkx087rnzc9oj";

(async () => {
  const prisma = await db();
  const job = await prisma.photoJob.findUniqueOrThrow({ where: { id: JOB } });
  const project = await prisma.project.findUniqueOrThrow({ where: { id: job.projectId }, select: { title: true, aryeoListingId: true } });
  const row = await prisma.appSetting.findUnique({ where: { key: `photo_aryeo_push:${JOB}` } });
  const run = row ? (JSON.parse(row.value) as { state: string; note: string | null; deliveredAt: string | null }) : null;
  const { listingGallery } = await import("../../src/lib/photoDelivery/jobs");
  const listing = project.aryeoListingId ? await listingGallery(project.aryeoListingId) : null;
  console.log(`${project.title}: job ${job.stage}; run ${run?.state} (${run?.note ?? "-"}); Aryeo listing ${listing?.deliveryStatus ?? "unread"}, ${listing?.entries.length ?? "?"} photos`);
  if (job.stage !== "DELIVERING" || run?.state !== "FAILED" || run.deliveredAt) {
    console.log("Not the stopped delivery any more (someone moved it on): nothing to do.");
    await prisma.$disconnect();
    return;
  }
  if (String(listing?.deliveryStatus ?? "").toUpperCase() === "DELIVERED") console.log("Aryeo already reads it as delivered: the restart confirms it without pressing Deliver again.");
  if (!APPLY) { console.log("dry run: not restarted."); await prisma.$disconnect(); return; }
  const { approveJob } = await import("../../src/lib/photoDelivery/aryeoPush");
  const r = await approveJob(JOB, "claude: for Jordan", { deliver: true });
  console.log(JSON.stringify(r));
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
