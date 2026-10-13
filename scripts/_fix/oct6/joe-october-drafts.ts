// Oct 13 2026 (Jordan): "I uploaded scripts for Joseph Sutow and added them to
// October but there are scripts in the review queue that I can't clear." The
// four drafts the hub wrote for October on Oct 12 step aside for his upload,
// exactly as a new upload now does (scriptUpload.stepAsideForUpload): out of
// the review queue, their topics off October (his upload's topics stay), all
// recorded on that upload so Undo would restore them. Nothing reaches Joe.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct6/joe-october-drafts.ts [--apply]
import { prisma } from "@/lib/prisma";

async function main() {
  const apply = process.argv.includes("--apply");
  const c = await prisma.client.findFirst({ where: { name: "Joseph Sutow" }, select: { id: true } });
  const e = await prisma.contentEnrollment.findFirst({ where: { clientId: c!.id, status: "ACTIVE" }, select: { id: true } });
  const m = await prisma.contentMonth.findUniqueOrThrow({ where: { enrollmentId_monthKey: { enrollmentId: e!.id, monthKey: "2026-10" } }, select: { id: true } });
  const batches = await prisma.contentImportBatch.findMany({ where: { enrollmentId: e!.id, mode: "APPLIED", kind: "MONTH_SCRIPTS" }, orderBy: { createdAt: "desc" }, select: { id: true, previewJson: true, createdAt: true } });
  const batch = batches.find((b) => (JSON.parse(b.previewJson ?? "{}") as { monthId?: string }).monthId === m.id);
  if (!batch) throw new Error("No applied October upload for Joe.");
  const drafts = await prisma.contentScript.findMany({ where: { monthId: m.id, source: "ai", status: { in: ["DRAFT", "INTERNAL_REVIEW"] }, approvedVersionId: null, sharedVersionId: null }, select: { title: true } });
  console.log(`Upload ${batch.id} (${batch.createdAt.toISOString().slice(0, 16)}); hub drafts in review: ${drafts.map((d) => d.title).join(" | ")}`);
  if (!apply) { console.log("DRY RUN"); return; }
  const me = await prisma.appUser.findFirst({ where: { email: "info@realtourpilot.com" }, select: { id: true, name: true } });
  const { stepAsideForUpload } = await import("@/lib/scriptUpload");
  const r = await stepAsideForUpload(batch.id, { email: "info@realtourpilot.com", appUserId: me?.id ?? null, name: me?.name ?? "Jordan" });
  const { recalcProgramMonth } = await import("@/lib/programMonths");
  await recalcProgramMonth(m.id);
  const after = await prisma.contentMonth.findUnique({ where: { id: m.id }, select: { preparationStatus: true } });
  const live = await prisma.contentTopicSelection.count({ where: { monthId: m.id, status: { in: ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"] } } });
  const scripts = await prisma.contentScript.findMany({ where: { monthId: m.id }, select: { title: true, source: true, status: true } });
  console.log(`removed ${r.removed}; October now: ${live} topics, ${scripts.length} scripts (${scripts.map((s) => `${s.source}/${s.status}`).join(", ")}), ${after?.preparationStatus}`);
}
main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
