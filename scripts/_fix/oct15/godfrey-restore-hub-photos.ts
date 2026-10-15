// ---------------------------------------------------------------------------
// LIVE (Oct 15 2026): 1934 W Godfrey Ave (Stephen Kennedy). The old Aryeo push
// added the 36 photos twice ("(2)" copies, removed by
// remove-duplicate-listing-photos.ts). Before that, at 03:38 UTC the sync read
// the 72-photo listing, matched nothing (adoptListing needs the listing to be
// the 06-Ready files exactly), made 72 plain ARYEO rows and set the job's own
// 36 AutoHDR photos aside as GONE (room labels, the 3 fixes, versions, hero).
// This puts the job back: the 72 rows made then go (only if nothing points at
// them), the 36 come back ACTIVE, and the next sync carries them over to the
// now-clean listing in place. Dry run unless --apply.
// ---------------------------------------------------------------------------
export {};
import { prisma } from "@/lib/prisma";
const JOB = "cmv8bx47n001tl506yyo3imf5";
const SINCE = new Date("2026-10-15T03:38:00Z");
async function main() {
  const aryeo = await prisma.photoAsset.findMany({ where: { jobId: JOB, sourceKind: "ARYEO" }, select: { id: true, name: true, createdAt: true, status: true } });
  const hub = await prisma.photoAsset.findMany({ where: { jobId: JOB, sourceKind: "AUTOHDR" }, select: { id: true, name: true, status: true, roomType: true } });
  const ids = aryeo.map((a) => a.id);
  const [findings, ops, versions] = await Promise.all([
    prisma.photoQcFinding.count({ where: { photoId: { in: ids } } }),
    prisma.photoFixOperation.count({ where: { photoId: { in: ids } } }),
    prisma.photoVersion.count({ where: { photoId: { in: ids } } }),
  ]);
  const job = await prisma.photoJob.findUniqueOrThrow({ where: { id: JOB }, select: { stage: true, heroPhotoId: true, orderJson: true } });
  const heroIsHub = hub.some((h) => h.id === job.heroPhotoId);
  const order = job.orderJson ? (JSON.parse(job.orderJson) as string[]) : [];
  console.log(`ARYEO rows ${aryeo.length} (all made since 03:38: ${aryeo.every((a) => a.createdAt >= SINCE)}), pointing at them: findings ${findings}, fix ops ${ops}, versions ${versions}`);
  console.log(`AutoHDR rows ${hub.length}: ${JSON.stringify(Object.fromEntries(["ACTIVE", "GONE", "EXCLUDED"].map((s) => [s, hub.filter((h) => h.status === s).length])))}, labelled ${hub.filter((h) => h.roomType).length}; hero is a hub photo: ${heroIsHub}; saved order of hub photos: ${order.filter((o) => hub.some((h) => h.id === o)).length}/${order.length}; stage ${job.stage}`);
  if (aryeo.length !== 72 || !aryeo.every((a) => a.createdAt >= SINCE) || findings || ops || hub.length !== 36 || hub.some((h) => h.status === "ACTIVE")) throw new Error("not the state this repair expects: stopping without changes");
  if (!process.argv.includes("--apply")) return;
  await prisma.$transaction([
    prisma.photoVersion.deleteMany({ where: { photoId: { in: ids } } }),
    prisma.photoAsset.deleteMany({ where: { id: { in: ids } } }),
    prisma.photoAsset.updateMany({ where: { jobId: JOB, sourceKind: "AUTOHDR", status: "GONE" }, data: { status: "ACTIVE" } }),
    // The next sync reads the listing again (and carries the 36 over in place).
    prisma.photoJob.update({ where: { id: JOB }, data: { finalsFingerprint: null, finalsCount: 36, nextCheckAt: new Date() } }),
    prisma.photoJobEvent.create({ data: { jobId: JOB, actor: "Claude", action: "repaired: the listing had every photo twice (the old Aryeo push); the 36 copies were removed in Aryeo and the job's own 36 photos (labels, fixes, versions) are back" } }),
  ]);
  const { syncJobFinals } = await import("@/lib/photoDelivery/jobs");
  const r = await syncJobFinals(JOB);
  const after = await prisma.photoAsset.groupBy({ by: ["status", "sourceKind"], where: { jobId: JOB }, _count: true });
  console.log("sync:", JSON.stringify(r), "rows:", JSON.stringify(after));
}
main().then(() => process.exit(0)).catch((e) => { console.log("ERR", e.message); process.exit(1); });
