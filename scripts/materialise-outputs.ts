/**
 * MATERIALISE ONE ROW PER OWED VIDEO (audit WF-02, COMPLETION-CONTRACT §9
 * Phase 1).
 *
 *   npx tsx --env-file=.env scripts/materialise-outputs.ts --dry
 *   npx tsx --env-file=.env scripts/materialise-outputs.ts
 *
 * WHAT IT WRITES, AND NOTHING ELSE:
 *   · DeliverableOutput rows — a table that is empty everywhere, so every row
 *     it creates is new information and none of it overwrites anything;
 *   · ReviewSubmission.outputId — a column that is null on every row, set only
 *     where (deliverableId, slot) identifies the cut exactly. The 14 rounds
 *     that carry no deliverable (the folder-discovered era, identified by a
 *     Dropbox path) are LEFT NULL and counted. A path is mutable: guessing
 *     would attach a client's approval to the wrong video.
 *   · the derived review/delivery stamps on those same new rows
 *     (deliverableOutputs.refreshOutputsForProject).
 *
 * It sends nothing, texts nobody, touches no Dropbox file and no Aryeo record.
 * It is idempotent: a second run creates 0 rows. Cancelled jobs are skipped —
 * nothing is owed on a job that was called off.
 */
import { prisma } from "@/lib/prisma";
import { ensureOutputsForProject, refreshOutputsForProject } from "@/lib/deliverableOutputs";

async function main() {
  const dry = process.argv.includes("--dry");
  const started = Date.now();
  const all = await prisma.project.findMany({
    where: { status: { notIn: ["CANCELLED"] } },
    select: { id: true, title: true },
    orderBy: { createdAt: "asc" },
  });
  // Only the jobs that could owe a video, and a job that already has rows (so a
  // re-run still retires a slot that has since left the order). Two thirds of
  // the database sells no video, and asking each of those over the wire cost
  // more than the whole rest of the pass.
  const withVideo = new Set(
    (
      await prisma.deliverable.findMany({
        where: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null },
        select: { projectId: true },
        distinct: ["projectId"],
      })
    ).map((d) => d.projectId),
  );
  for (const o of await prisma.deliverableOutput.findMany({ select: { projectId: true }, distinct: ["projectId"] })) withVideo.add(o.projectId);
  const projects = all.filter((p) => withVideo.has(p.id));
  console.log(
    `${all.length} non-cancelled jobs, ${projects.length} of them own a video (or already have rows)` +
      `${dry ? " — DRY RUN, nothing will be written" : ""}`,
  );

  let touchedJobs = 0, created = 0, retired = 0, unretired = 0, waived = 0, linked = 0, stamped = 0, failed = 0;
  for (const p of projects) {
    try {
      if (dry) {
        const { planOutputsForProject } = await import("@/lib/deliverableOutputs");
        const plan = await planOutputsForProject(p.id);
        if (plan.slots.length + plan.waived.length === 0) continue;
        touchedJobs++;
        created += plan.slots.length + plan.waived.length;
        continue;
      }
      const r = await ensureOutputsForProject(p.id);
      if (r.slotKeys.length === 0 && r.created === 0 && r.retired === 0) continue;
      touchedJobs++;
      created += r.created;
      retired += r.retired;
      unretired += r.unretired;
      waived += r.waived;
      linked += r.linkedRounds;
      stamped += await refreshOutputsForProject(p.id);
      if (r.created > 0) console.log(`  ${p.title ?? p.id}: ${r.created} video row${r.created === 1 ? "" : "s"}`);
    } catch (e) {
      failed++;
      console.error(`  FAILED ${p.title ?? p.id}: ${(e as Error).message}`);
    }
  }

  const rounds = await prisma.reviewSubmission.count();
  const unlinked = await prisma.reviewSubmission.count({ where: { deliverableId: null } });
  const linkedTotal = await prisma.reviewSubmission.count({ where: { outputId: { not: null } } });
  console.log(
    `\njobs with owed video: ${touchedJobs}\n` +
      `rows created: ${created}${dry ? " (would be)" : ""}\n` +
      `rows retired: ${retired} · un-retired: ${unretired} · waived: ${waived}\n` +
      `review rounds linked this run: ${linked} · linked in total: ${linkedTotal} of ${rounds}\n` +
      `rounds left unlinked on purpose (no deliverable — folder-discovered): ${unlinked}\n` +
      `outputs carrying a derived stamp: ${stamped}\n` +
      `failures: ${failed}\n` +
      `DeliverableOutput rows now: ${await prisma.deliverableOutput.count()}\n` +
      `took ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
