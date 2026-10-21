// Oct 21 2026: 615 Cliff Ln (Alex Ercole Stackhouse) has two appointments on one
// job (Oct 7, Oct 21). Adding the second moved the shoot date into the intake's
// window and the hub sent the Oct 7 raws to AutoHDR again (batch 1, 69 files).
// Stop that batch before it finishes: a finished batch is downloaded for display,
// which charges a credit per photo for photos already paid for. FAILED keeps the
// 69 files claimed, so they are never sent again. Dry run unless --apply.
export {};
const BATCH = "cmvik1ffe003pjt076ygomrup";
const WHY = "Stopped by hand (Oct 21): these 69 raws are from the Oct 7 appointment, already edited and delivered. Sent again by mistake when the Oct 21 appointment was added; not downloaded, so no credits spent.";
async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../src/lib/prisma");
  const b = await prisma.photoIntakeBatch.findUnique({ where: { id: BATCH }, select: { state: true, fileCount: true, photoshootId: true, projectId: true, doneAt: true } });
  console.log("before:", b);
  // Step 2 (also on a re-run): the job's AutoHDR link was pointed at this duplicate shoot when it was
  // sent (it had none before). Fixes and versions read that link, so put it back to none.
  const job2 = await prisma.photoJob.findUnique({ where: { projectId: b?.projectId ?? "" }, select: { id: true, autohdrPhotoshootId: true, autohdrLinkedAt: true } });
  console.log("job link before:", job2);
  if (apply && job2 && b?.photoshootId && job2.autohdrPhotoshootId === b.photoshootId) {
    const u = await prisma.photoJob.updateMany({ where: { id: job2.id, autohdrPhotoshootId: b.photoshootId }, data: { autohdrPhotoshootId: null, autohdrShootName: null, autohdrLinkedAt: null, autohdrCreatedAt: null } });
    console.log("job link cleared:", u.count);
  }
  if (!b || !["PROCESSING", "LANDING", "UNCERTAIN"].includes(b.state)) { console.log("batch not in flight; nothing more to do"); return prisma.$disconnect(); }
  if (!apply) { console.log("dry run: would mark FAILED"); return prisma.$disconnect(); }
  const r = await prisma.photoIntakeBatch.updateMany({ where: { id: BATCH, state: b.state }, data: { state: "FAILED", lastError: WHY, nextCheckAt: null } });
  console.log("updated:", r.count);
  const job = await prisma.photoJob.findUnique({ where: { projectId: b.projectId }, select: { id: true } });
  if (job && r.count === 1) {
    const { logJobEvent } = await import("../../src/lib/photoDelivery/jobState");
    await logJobEvent(job.id, "autohdr-intake", `batch 1 stopped: ${WHY}`, { batchId: BATCH, photoshootId: b.photoshootId });
  }
  console.log("after:", await prisma.photoIntakeBatch.findUnique({ where: { id: BATCH }, select: { state: true, lastError: true } }));
  await prisma.$disconnect();
}
main();
