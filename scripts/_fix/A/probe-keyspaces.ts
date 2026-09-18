// READ-ONLY. Ground the four WF-02/WF-03 findings against production rows.
import { prisma } from "@/lib/prisma";
import { cutSlots, slotKeyOf, cutKeyOf } from "@/lib/reviewCuts";

async function main() {
  // ---- SERIOUS 1: rounds with no deliverableId, and the jobs they sit on ----
  const keyless = await prisma.reviewSubmission.findMany({
    where: { deliverableId: null },
    select: {
      id: true, projectId: true, kind: true, slot: true, status: true, assetPath: true, outputId: true, createdAt: true,
      project: { select: { title: true, revisionRequestedAt: true, deliveredAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(`ReviewSubmission rows with NO deliverableId: ${keyless.length} (of ${await prisma.reviewSubmission.count()})`);
  const byProject = new Map<string, typeof keyless>();
  for (const r of keyless) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
  console.log(`  spread across ${byProject.size} projects\n`);
  for (const [pid, rows] of byProject) {
    const slots = await cutSlots(pid).catch(() => []);
    const owed = slots.map((s) => slotKeyOf(s.deliverableId, s.slot));
    const title = rows[0].project?.title ?? pid;
    console.log(`  ${title}`);
    console.log(`    owes ${owed.length} slot(s): ${owed.join(", ") || "(none)"}`);
    console.log(`    revisionRequestedAt=${rows[0].project?.revisionRequestedAt?.toISOString() ?? "-"} deliveredAt=${rows[0].project?.deliveredAt?.toISOString() ?? "-"}`);
    for (const r of rows) {
      console.log(`    round ${r.status.padEnd(18)} cutKeyOf="${cutKeyOf(r)}"  outputId=${r.outputId ?? "-"}  intersects owed? ${owed.includes(cutKeyOf(r))}`);
    }
    console.log("");
  }

  // ---- MINOR 4: briefs, their taskId, and the lane the task belongs to ----
  const briefs = await prisma.revisionBrief.findMany({
    select: { id: true, projectId: true, taskId: true, createdAt: true, itemsJson: true, outputId: true },
    orderBy: { createdAt: "desc" },
  });
  const withItems = briefs.filter((b) => {
    try { return ((JSON.parse(b.itemsJson ?? "{}") as { items?: unknown[] }).items ?? []).length > 0; } catch { return false; }
  });
  console.log(`RevisionBrief rows: ${briefs.length}; with >=1 analysed item: ${withItems.length}`);
  console.log(`  taskId set: ${briefs.filter((b) => b.taskId).length}; taskId NULL: ${briefs.filter((b) => !b.taskId).length}`);
  console.log(`  (of the itemised ones) taskId set: ${withItems.filter((b) => b.taskId).length}; NULL: ${withItems.filter((b) => !b.taskId).length}`);

  // projects carrying more than one brief
  const perProject = new Map<string, typeof briefs>();
  for (const b of briefs) perProject.set(b.projectId, [...(perProject.get(b.projectId) ?? []), b]);
  let collisions = 0;
  for (const [pid, bs] of perProject) {
    if (bs.length < 2) continue;
    const p = await prisma.project.findUnique({ where: { id: pid }, select: { title: true, revisionRequestedAt: true } });
    console.log(`  ${bs.length} briefs on ${p?.title} (revisionRequestedAt=${p?.revisionRequestedAt?.toISOString() ?? "-"})`);
    for (const b of bs) console.log(`      ${b.createdAt.toISOString()} taskId=${b.taskId ?? "NULL"}`);
    collisions++;
  }
  console.log(`  projects with >1 brief: ${collisions}`);

  // ---- SERIOUS 2: waived deliverables vs their outputs ----
  const waived = await prisma.deliverable.findMany({ where: { waivedAt: { not: null } }, select: { id: true, type: true, projectId: true } });
  const wOut = await prisma.deliverableOutput.count({ where: { waivedAt: { not: null } } });
  console.log(`\nDeliverable rows waived now: ${waived.length}; DeliverableOutput rows stamped waivedAt: ${wOut}`);
  const orphanWaivedOutputs = await prisma.deliverableOutput.findMany({
    where: { waivedAt: { not: null }, deliverable: { waivedAt: null } },
    select: { id: true, deliverableId: true, slot: true, projectId: true },
  });
  console.log(`  outputs stamped waived whose Deliverable is NOT waived (the un-waive leak): ${orphanWaivedOutputs.length}`);
  for (const o of orphanWaivedOutputs) console.log(`    ${o.projectId} ${o.deliverableId}:${o.slot}`);

  // ---- MINOR 3: stamps pointing at rows that no longer exist ----
  const outs = await prisma.deliverableOutput.findMany({
    select: {
      id: true, projectId: true, deliverableId: true, slot: true, currentSubmissionId: true,
      approvedSubmissionId: true, sentSubmissionId: true, approvedAt: true, deliveredAt: true, reviewReadyAt: true,
    },
  });
  const ids = new Set((await prisma.reviewSubmission.findMany({ select: { id: true } })).map((r) => r.id));
  let dangling = 0;
  for (const o of outs) {
    const cols = [
      ["currentSubmissionId", o.currentSubmissionId],
      ["approvedSubmissionId", o.approvedSubmissionId],
      ["sentSubmissionId", o.sentSubmissionId],
    ] as const;
    for (const [col, v] of cols) {
      if (v && !ids.has(v)) { console.log(`  DANGLING ${col}=${v} on output ${o.deliverableId}:${o.slot} (${o.projectId})`); dangling++; }
    }
  }
  console.log(`DeliverableOutput rows: ${outs.length}; dangling submission pointers: ${dangling}`);
  console.log(`  outputs with approvedAt but no approvedSubmissionId: ${outs.filter((o) => o.approvedAt && !o.approvedSubmissionId).length}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
