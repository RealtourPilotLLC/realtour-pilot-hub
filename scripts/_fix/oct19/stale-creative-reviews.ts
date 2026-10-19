// ---------------------------------------------------------------------------
// LIVE (Oct 19 2026): close three creative reviews the brief sweep opened on
// finished or test work (audit). 671 Northbrook Rd x2: both revision cards
// were already COMPLETED (14:39) when the sweep read the briefs at 15:37.
// TEST Cara: a test client. The review is marked RESOLVED / NOT_NEEDED on the
// brief and its task CANCELLED with the reason. Deliberately NOT through
// creativeReview.resolveCreativeReview: that ingests the brief's items as new
// revision issues, which would put open items on finished work.
//   DRY RUN (default) · --apply
// ---------------------------------------------------------------------------
export {};
const APPLY = process.argv.includes("--apply");
const BRIEFS: [string, string][] = [
  ["cmv8hqrh70009l8064wcgmb7c", "The revision card was already completed when this was read (671 Northbrook Rd)."],
  ["cmv6zt79b000clg06w5bbvu0t", "The revision card was already completed when this was read (671 Northbrook Rd)."],
  ["cmu5mv869000d9k12um97eg2x", "Test client (TEST Cara)."],
];
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const now = new Date();
  for (const [id, why] of BRIEFS) {
    const b = await prisma.revisionBrief.findUnique({ where: { id }, select: { itemsJson: true, projectId: true } });
    if (!b) { console.log(id, "missing"); continue; }
    const doc = JSON.parse(b.itemsJson ?? "{}");
    const cr = doc.creativeReview;
    if (!cr || cr.state !== "OPEN") { console.log(id, "not open:", cr?.state); continue; }
    console.log(`${APPLY ? "CLOSE" : "would close"} ${id} (task ${cr.taskId}) · ${why}`);
    if (!APPLY) continue;
    const note = `Closed by Claude for Jordan (Oct 19 audit): ${why}`;
    await prisma.revisionBrief.update({ where: { id }, data: { itemsJson: JSON.stringify({ ...doc, creativeReview: { ...cr, state: "RESOLVED", resolvedAt: now.toISOString(), resolvedBy: "Claude (Oct 19 audit)", mode: "NOT_NEEDED", note, heldItemIds: [] } }) } });
    if (cr.taskId) {
      const t = await prisma.smartTask.findUnique({ where: { id: cr.taskId }, select: { status: true, summary: true } });
      if (t && t.status !== "COMPLETED" && t.status !== "CANCELLED") {
        await prisma.smartTask.update({ where: { id: cr.taskId }, data: { status: "CANCELLED", summary: `${note}\n${t.summary ?? ""}`.slice(0, 500) } });
      }
    }
    await prisma.activity.create({ data: { projectId: b.projectId, type: "SYSTEM", body: `Creative review closed: ${why}`.slice(0, 500) } }).catch(() => {});
  }
  if (!APPLY) console.log("DRY RUN: nothing written. Re-run with --apply.");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
