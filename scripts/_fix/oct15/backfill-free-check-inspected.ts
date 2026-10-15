// ---------------------------------------------------------------------------
// LIVE (Oct 15 2026): before 9d13daa the free check did not write
// inspectedHash, so on every gallery it checked, the delivery checklist says
// "N photos not inspected" and any later gallery change re-checks every
// photo (re-raising issues already decided). This records what the job's last
// finished free check really looked at: a photo in that run's done/kept set,
// with no version made after the run started (a fix after it, checked by the
// fix runner, counts: the fix runner checks its own result). Open jobs only.
// Dry run unless --apply.
// ---------------------------------------------------------------------------
export {};
import { prisma } from "@/lib/prisma";
async function main() {
  const jobs = await prisma.photoJob.findMany({ where: { stage: { in: ["QC_REVIEW", "READY", "FIXING", "ON_HOLD", "DELIVERING"] } }, select: { id: true, stage: true, projectId: true } });
  let stamped = 0;
  for (const j of jobs) {
    const run = await prisma.photoQcRun.findFirst({ where: { jobId: j.id, trigger: "AUTOHDR_CHECK", status: "DONE" }, orderBy: { startedAt: "desc" }, select: { id: true, startedAt: true, checksJson: true } });
    if (!run) continue;
    let p: { done?: Record<string, number>; kept?: string[] } = {};
    try { p = JSON.parse(run.checksJson ?? "{}"); } catch { continue; }
    const looked = new Set([...Object.keys(p.done ?? {}), ...(p.kept ?? [])]);
    const photos = await prisma.photoAsset.findMany({ where: { jobId: j.id, status: "ACTIVE" }, select: { id: true, contentHash: true, inspectedHash: true, versions: { where: { createdAt: { gt: run.startedAt } }, select: { source: true, label: true } } } });
    const todo = photos.filter((ph) => ph.contentHash && ph.inspectedHash !== ph.contentHash && looked.has(ph.id) && ph.versions.every((v) => v.source === "FIX"));
    const missed = photos.filter((ph) => ph.inspectedHash !== ph.contentHash && !todo.includes(ph)).length;
    if (!todo.length && !missed) continue;
    const proj = await prisma.project.findUnique({ where: { id: j.projectId }, select: { title: true } });
    console.log(`${j.stage.padEnd(10)} ${proj?.title?.slice(0, 40)}: stamp ${todo.length}, left for a re-check ${missed} (versions after the run: ${[...new Set(photos.flatMap((ph) => ph.versions.map((v) => `${v.source}/${v.label}`)))].join(", ") || "none"})`);
    if (process.argv.includes("--apply")) for (const ph of todo) await prisma.photoAsset.update({ where: { id: ph.id }, data: { inspectedHash: ph.contentHash } });
    stamped += todo.length;
  }
  console.log(`${process.argv.includes("--apply") ? "stamped" : "would stamp"} ${stamped}`);
}
main().then(() => process.exit(0)).catch((e) => { console.log("ERR", e.message); process.exit(1); });
