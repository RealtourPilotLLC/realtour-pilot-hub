// ---------------------------------------------------------------------------
// LIVE (Oct 14 2026, huddle finding 2): three delivered photos where the car
// removal invented steps, confirmed by eye on the version before and after
// (324 Spring Garden DSC07200 and DSC07205, 326 Spring Garden DSC07245). Each
// gets a CRITICAL "AI fix changed the house" finding on its job, with the
// way back: Restore the version before the fix, then replace it on the Aryeo
// listing. Nothing is reverted here (they are delivered). Idempotent.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";

const CASES: { name: string; street: string; what: string }[] = [
  { name: "DSC07200.jpg", street: "324 Spring Garden", what: "added a concrete step at 324's front door where the car stood" },
  { name: "DSC07205.jpg", street: "324 Spring Garden", what: "added steps at 324's door and a stoop at the house to the left where the cars stood" },
  { name: "DSC07245.jpg", street: "326 Spring Garden", what: "added front steps to the house on the right where the car stood" },
];

async function main() {
  const { damageFinding } = await import("@/lib/photoDelivery/fixRunner");
  const { logJobEvent } = await import("@/lib/photoDelivery/jobState");
  for (const c of CASES) {
    const projects = await prisma.project.findMany({ where: { title: { startsWith: c.street } }, select: { id: true } });
    const photo = await prisma.photoAsset.findFirst({ where: { name: c.name, job: { projectId: { in: projects.map((p) => p.id) } } }, select: { id: true, jobId: true, contentHash: true } });
    if (!photo) { console.log(c.name, "not found"); continue; }
    if (await prisma.photoQcFinding.count({ where: { photoId: photo.id, ruleId: "FIX_DAMAGE_AI_EDIT" } })) { console.log(c.name, "already flagged"); continue; }
    const op = await prisma.photoFixOperation.findFirst({ where: { photoId: photo.id, outputVersionUuid: { not: null } }, orderBy: { finishedAt: "desc" }, select: { findingIdsJson: true } });
    const runId = (await prisma.photoQcFinding.findFirst({ where: { id: { in: JSON.parse(op?.findingIdsJson ?? "[]") as string[] } }, select: { qcRunId: true } }))?.qcRunId
      ?? (await prisma.photoJob.findUnique({ where: { id: photo.jobId }, select: { lastQcRunId: true } }))?.lastQcRunId;
    if (!runId) { console.log(c.name, "no QC run to attach to"); continue; }
    await prisma.photoQcFinding.create({ data: damageFinding({ jobId: photo.jobId }, runId, photo.id, photo.contentHash, `Checked Oct 14 (huddle), by eye on the versions before and after: the AI car removal ${c.what}. Open the photo, compare the Versions and Restore the one before the fix (the car comes back), then replace it on the Aryeo listing.`) });
    await logJobEvent(photo.jobId, "huddle re-check", `the car removal on ${c.name} ${c.what}: flagged for a person (nothing reverted; it is delivered)`);
    console.log(c.name, "flagged");
  }
}
main().finally(() => prisma.$disconnect());
