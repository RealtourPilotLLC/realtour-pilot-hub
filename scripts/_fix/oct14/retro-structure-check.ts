// ---------------------------------------------------------------------------
// LIVE: re-check this week's automatic removals outside the house (cars,
// trash cans, anything on the lot) for a changed house (Oct 14 2026 huddle,
// finding 2: a car removal gave one of Nehemiah's houses steps it does not
// have). Uses only AutoHDR's FREE describe:
//   1. the version BEFORE the fix is described (the house as it was, and
//      whether the removed thing hid part of it);
//   2. the house's features (steps, stoops, porches, railings, doors, garage
//      doors) are counted on the version before and the version after with
//      the same question; a difference is counted again on both, and only a
//      confirmed one is a changed house.
// Nothing is reverted (most of these are delivered): with --apply, a photo
// whose house changed gets a CRITICAL "AI fix changed the house" finding, so
// Kyle sees it and can Restore the version before the fix in one click.
//
//   npx tsx scripts/_fix/oct14/retro-structure-check.ts            (report only)
//   npx tsx scripts/_fix/oct14/retro-structure-check.ts --apply    (flag them)
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";

const APPLY = process.argv.includes("--apply");

async function main() {
  const { touchesStructure, structureCheck } = await import("@/lib/photoDelivery/fixPolicy");
  const { checkFix, damageFinding } = await import("@/lib/photoDelivery/fixRunner");
  const { logJobEvent } = await import("@/lib/photoDelivery/jobState");
  const since = new Date(Date.now() - 7 * 86_400_000);
  const ops = await prisma.photoFixOperation.findMany({
    where: { status: { in: ["VERIFIED", "SUCCEEDED"] }, transformName: { in: ["reedit", "autofill", "autoremove"] }, finishedAt: { gte: since }, inputVersionUuid: { not: null }, outputVersionUuid: { not: null } },
    orderBy: { finishedAt: "asc" },
  });
  console.log(`${ops.length} finished fixes in the last 7 days`);
  let looked = 0, changed = 0, flagged = 0;
  for (const op of ops) {
    const ids = JSON.parse(op.findingIdsJson) as string[];
    const findings = await prisma.photoQcFinding.findMany({ where: { id: { in: ids } }, select: { ruleId: true, qcRunId: true } });
    if (!touchesStructure(findings.map((f) => f.ruleId))) continue;
    const photo = await prisma.photoAsset.findUnique({ where: { id: op.photoId }, select: { id: true, name: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, contentHash: true, autohdrVersionUuid: true } });
    const job = await prisma.photoJob.findUnique({ where: { id: op.jobId }, select: { stage: true, autohdrPhotoshootId: true, projectId: true } });
    if (!photo?.autohdrImageUuid || !job) continue;
    const shootId = photo.sourceKind === "AUTOHDR" && photo.sourceRef?.includes("/") ? Number(photo.sourceRef.split("/")[0]) : job.autohdrPhotoshootId;
    if (!shootId) continue;
    const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true } });
    looked++;
    const look = await structureCheck(shootId, photo.autohdrImageUuid, op.inputVersionUuid, op.prompt ?? "").catch((e) => {
      console.log(`  ${photo.name}: AutoHDR would not describe the version before (${(e as Error).message.slice(0, 80)})`);
      return null;
    });
    if (!look) continue;
    const check = await checkFix({ shootId, imageUuid: photo.autohdrImageUuid, output: op.outputVersionUuid!, prompt: op.prompt ?? "", house: look.house, before: { version: op.inputVersionUuid!, counts: null } });
    const line = `${(project?.title ?? "?").split(",")[0]} · ${photo.name} · ${job.stage} · before: "${look.house.slice(0, 90)}"${look.covers ? ` · HID: ${look.covered}` : ""} · after: ${check.verdict}${check.note ? ` (${check.note})` : ""}`;
    console.log(line);
    if (!check.houseChanged) continue;
    changed++;
    if (!APPLY) continue;
    const open = await prisma.photoQcFinding.count({ where: { photoId: photo.id, ruleId: "FIX_DAMAGE_AI_EDIT", status: "OPEN" } });
    if (open) continue;
    const stillThatVersion = photo.autohdrVersionUuid === op.outputVersionUuid;
    await prisma.photoQcFinding.create({
      data: damageFinding(op, findings[0].qcRunId, photo.id, photo.contentHash, `Checked again on Oct 14 (huddle): the AI fix ${check.note || "changed the house"}. ${stillThatVersion ? "That fixed version is still the current one." : "A different version is current now; compare them."} Open the photo, compare the Versions and Restore the one before the fix${job.stage === "DELIVERED" ? ", then replace it on the Aryeo listing" : ""}.`),
    });
    await logJobEvent(op.jobId, "huddle re-check", `the car or bin removal on ${photo.name} ${check.note || "changed the house"}: flagged for a person (nothing reverted)`, { operationId: op.id });
    flagged++;
  }
  console.log(`\nlooked at ${looked} removals outside; ${changed} changed the house; ${APPLY ? `${flagged} flagged` : "report only (run with --apply to flag them)"}`);
}

main().finally(() => prisma.$disconnect());
