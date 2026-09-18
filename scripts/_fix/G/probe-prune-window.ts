// READ-ONLY measurement for MINOR 3 (Sep 17). vercel.json runs
// /api/cron/daily-reconcile at `40 8 * * *`, whose first step is
// pruneReviewUploads. Its release() clears blobUrl/blobPathname BEFORE it calls
// del(blobUrl) — and del() deletes from whatever store BLOB_READ_WRITE_TOKEN
// names, not from the store the URL names. So any row it touches during a
// window in which the token has been swapped to a NEW store loses its only
// pointer to bytes that still sit in the OLD one.
//
// This counts, against production, the rows that window would eat. It COUNTS
// ONLY — it never writes and never calls del(). The three WHERE clauses mirror
// pruneReviewUploads (src/lib/reviewCuts.ts:935) as it stands today.
import { prisma } from "../../../src/lib/prisma";
import { WITHDRAWN, NOT_A_CUT } from "../../../src/lib/reviewCuts";
import { reviewRoomRules } from "../../../src/lib/settings";

async function main() {
  const keepDays = (await reviewRoomRules()).keepUploadsDays;
  const cutoff = new Date(Date.now() - keepDays * 24 * 3600_000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
  console.log(`keepUploadsDays = ${keepDays} (Settings → Review Room; clamped 1..365 in settings.ts, so it cannot be set to "never")`);

  const notAwaitingTopaz = {
    OR: [
      { topazJob: { is: null } },
      { topazJob: { state: { notIn: ["queued", "estimated", "uploading", "processing", "saving"] } } },
    ],
  };

  const step1 = await prisma.reviewSubmission.count({
    where: { blobUrl: { not: null }, completedAt: { lt: cutoff }, finalPath: { not: null }, ...notAwaitingTopaz },
  });
  const step2 = await prisma.reviewSubmission.count({
    where: { blobUrl: { not: null }, status: "UPLOAD_FAILED", updatedAt: { lt: weekAgo } },
  });
  const olderCandidates = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null }, deliverableId: { not: null }, status: { in: ["PENDING", "SUPERSEDED", "CHANGES_REQUESTED", WITHDRAWN] }, updatedAt: { lt: weekAgo } },
    select: { id: true, projectId: true, deliverableId: true, slot: true, round: true, status: true },
  });
  let step3 = 0;
  for (const r of olderCandidates) {
    const newer = await prisma.reviewSubmission.count({
      where: {
        projectId: r.projectId, deliverableId: r.deliverableId, slot: r.slot, id: { not: r.id },
        round: r.status === WITHDRAWN ? { gte: r.round } : { gt: r.round },
        status: { notIn: [...NOT_A_CUT] },
      },
    });
    if (newer > 0) step3++;
  }

  const total = await prisma.reviewSubmission.count({ where: { blobUrl: { not: null } } });
  console.log(`rows carrying a blobUrl today                     : ${total}`);
  console.log(`  step 1 approved + copied, past retention        : ${step1}`);
  console.log(`  step 2 UPLOAD_FAILED, bytes landed, >7d         : ${step2}   <-- keepUploadsDays does NOT gate this`);
  console.log(`  step 3 superseded/withdrawn round, >7d          : ${step3}   <-- nor this`);
  console.log(`  rows the next 08:40 pass would release          : ${step1 + step2 + step3} (up to 50 per step)`);
  // Zero today is not "never" — say WHEN. The soonest date any row currently
  // holding bytes can enter each step, so the handover can state how wide the
  // safe window actually is rather than calling the risk theoretical.
  const holders = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null } },
    select: { id: true, status: true, completedAt: true, finalPath: true, updatedAt: true, deliverableId: true },
  });
  const day = 24 * 3600_000;
  const soonest: Array<{ step: string; at: Date }> = [];
  for (const h of holders) {
    if (h.completedAt && h.finalPath) soonest.push({ step: "1 approved+copied", at: new Date(h.completedAt.getTime() + keepDays * day) });
    if (h.status === "UPLOAD_FAILED") soonest.push({ step: "2 upload failed", at: new Date(h.updatedAt.getTime() + 7 * day) });
    if (h.deliverableId && ["PENDING", "SUPERSEDED", "CHANGES_REQUESTED", WITHDRAWN].includes(h.status)) {
      soonest.push({ step: "3 superseded (once a newer round exists)", at: new Date(h.updatedAt.getTime() + 7 * day) });
    }
  }
  soonest.sort((a, b) => a.at.getTime() - b.at.getTime());
  console.log("\nsoonest a row now holding bytes can become eligible:");
  for (const s of soonest.slice(0, 5)) console.log(`  ${s.at.toISOString().slice(0, 10)}  step ${s.step}`);
  console.log("  (and any cut uploaded and superseded from today is eligible 7 days later)");

  console.log("\nA row released while the token names a different store keeps nothing:");
  console.log("blobUrl and blobPathname are set to null first, and del() then deletes from the");
  console.log("TOKEN's store, so the bytes in the old store are orphaned and unreachable.");
  await prisma.$disconnect();
}
main();
