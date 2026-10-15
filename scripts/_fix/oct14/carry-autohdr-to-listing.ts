// ---------------------------------------------------------------------------
// LIVE (Oct 14 2026, huddle): jobs whose 06-Ready-for-Aryeo files reached the
// Aryeo listing BEFORE the sync learned to carry each AutoHDR photo over in
// place. Their AutoHDR rows went GONE and new Aryeo rows took over, so the
// versions, the findings (an AI fix that changed the house among them) and the
// AutoHDR link (Restore) were stranded on rows nobody can open. This moves
// them onto the Aryeo copy, matched by the name the Ready run gave each photo
// ("01-Front-Exterior.jpg"). Dry run unless --apply. Idempotent.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";

const APPLY = process.argv.includes("--apply");

async function main() {
  const { readyNamesFor } = await import("@/lib/photoDelivery/handoff");
  const { logJobEvent } = await import("@/lib/photoDelivery/jobState");
  const jobs = await prisma.photoJob.findMany({ where: { photos: { some: { sourceKind: "AUTOHDR", status: "GONE" } } }, select: { id: true, heroPhotoId: true, orderJson: true, projectId: true } });
  for (const job of jobs) {
    const names = await readyNamesFor(job.id);
    if (!names.size) continue;
    const aryeo = await prisma.photoAsset.findMany({ where: { jobId: job.id, sourceKind: "ARYEO", status: "ACTIVE" }, select: { id: true, name: true, autohdrImageUuid: true } });
    const pairs: { from: string; to: string; name: string }[] = [];
    for (const a of aryeo) {
      const from = names.get(a.name.toLowerCase());
      if (!from || a.autohdrImageUuid) continue;
      const src = await prisma.photoAsset.findUnique({ where: { id: from }, select: { id: true, status: true, sourceKind: true } });
      if (src?.status === "GONE" && src.sourceKind === "AUTOHDR") pairs.push({ from, to: a.id, name: a.name });
    }
    const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true } });
    console.log(`${(project?.title ?? job.id).split(",")[0]}: ${pairs.length} of ${aryeo.length} listing photos matched to their AutoHDR photo`);
    if (!APPLY || !pairs.length) continue;
    for (const p of pairs) {
      const src = await prisma.photoAsset.findUniqueOrThrow({ where: { id: p.from }, select: { autohdrImageUuid: true, autohdrVersionUuid: true, roomType: true, sequenceGroup: true, description: true, featuresJson: true } });
      await prisma.$transaction([
        prisma.photoVersion.updateMany({ where: { photoId: p.from }, data: { photoId: p.to } }),
        prisma.photoQcFinding.updateMany({ where: { photoId: p.from }, data: { photoId: p.to } }),
        prisma.photoFixOperation.updateMany({ where: { photoId: p.from }, data: { photoId: p.to } }),
        prisma.photoAsset.update({ where: { id: p.from }, data: { autohdrImageUuid: null } }),
        prisma.photoAsset.update({ where: { id: p.to }, data: { autohdrImageUuid: src.autohdrImageUuid, autohdrVersionUuid: src.autohdrVersionUuid } }),
      ]);
    }
    const remap = new Map(pairs.map((p) => [p.from, p.to]));
    let order: string[] | null = null;
    try { order = job.orderJson ? (JSON.parse(job.orderJson) as string[]) : null; } catch { order = null; }
    await prisma.photoJob.update({ where: { id: job.id }, data: { ...(job.heroPhotoId && remap.has(job.heroPhotoId) ? { heroPhotoId: remap.get(job.heroPhotoId)! } : {}), ...(order ? { orderJson: JSON.stringify(order.map((id) => remap.get(id) ?? id)) } : {}) } });
    await logJobEvent(job.id, "huddle repair", `${pairs.length} listing photos reunited with their AutoHDR photo (versions, findings and Restore)`);
    console.log("  moved");
  }
}
main().finally(() => prisma.$disconnect());
