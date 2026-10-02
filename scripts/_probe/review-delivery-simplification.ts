/** Read-only bounded rollout proposal. No providers, repairs or notifications.
 * Explicit old-schema selects keep this usable before the additive rollout. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "../../src/lib/prisma";
import { monthlyOwnerAccess } from "../../src/lib/monthlyFinal";
async function main() {
  const rows = await prisma.reviewSubmission.findMany({ where: { status: "APPROVED", project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } }, OR: [{ sentToClientAt: null }, { decidedAt: { gte: new Date(Date.now() - 90 * 86400000) } }] }, take: 300, orderBy: { decidedAt: "desc" }, select: { id: true, projectId: true, deliverableId: true, slot: true, round: true, decidedAt: true, clientReleasedAt: true, sentToClientAt: true, videoId: true, topazJob: { select: { state: true, finalPath: true, savedAt: true, deliveredAt: true } }, project: { select: { contentMonthId: true, aryeoListingId: true, clientId: true } } } });
  const ids = rows.map((row) => row.id);
  const [sources, videos, windows, markers, uploads, access, columns, migrationTable] = await Promise.all([
    prisma.contentVideoSource.findMany({ where: { kind: "REVIEW_CUT", ref: { in: ids } }, select: { ref: true, videoId: true } }),
    prisma.contentVideo.findMany({ where: { id: { in: rows.flatMap((row) => row.videoId ? [row.videoId] : []) } }, select: { id: true, enrollmentId: true, clientId: true, projectId: true, status: true } }),
    prisma.contentReviewWindow.findMany({ where: { submissionId: { in: ids } }, select: { submissionId: true, state: true, openedAt: true, deadlineAt: true } }),
    prisma.auditLog.findMany({ where: { target: { in: ids }, action: "monthly_portal_handoff" }, select: { target: true, id: true } }),
    prisma.auditLog.findMany({ where: { target: { in: ids }, action: { in: ["video_uploaded", "aryeo_listing_delivery_event"] } }, select: { target: true, action: true } }),
    monthlyOwnerAccess([...new Set(rows.flatMap((row) => row.project.contentMonthId ? [row.project.contentMonthId] : []))]),
    prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ReviewSubmission' AND column_name = 'portalPublicationRequiredAt'`,
    prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`,
  ]);
  const current = rows.filter((row) => !rows.some((other) => other.projectId === row.projectId && other.deliverableId === row.deliverableId && other.slot === row.slot && other.round > row.round));
  const groups: Record<string, unknown[]> = { libraryLinkedManualWorkCandidates: [], aryeoBookkeepingRepairCandidates: [], stillNeedUploadOrDelivery: [], portalExceptions: [], ambiguousHumanReview: [], portalWindowRepairProposal: [] };
  for (const row of current) {
    const base = { submissionId: row.id, projectId: row.projectId, round: row.round };
    if (row.project.contentMonthId) {
      const source = sources.find((source) => source.ref === row.id && source.videoId === row.videoId);
      const video = videos.find((video) => video.id === source?.videoId && video.clientId === row.project.clientId && video.projectId === row.projectId && video.status !== "ARCHIVED");
      const owner = access.get(row.project.contentMonthId);
      const linked = !!video && owner?.ok && owner.enrollmentId === video.enrollmentId;
      if (linked && row.clientReleasedAt && !row.sentToClientAt) groups.libraryLinkedManualWorkCandidates.push({ ...base, releasedAt: row.clientReleasedAt, next: "Verify exact final backup and entitlement before proposing a publication marker; preserve existing review allowance and sends." });
      else if (!row.sentToClientAt) groups.portalExceptions.push({ ...base, libraryLinked: !!linked, ownerAccess: !!owner?.ok, renderState: row.topazJob?.state ?? "missing", next: "Confirm source, backup and access; no live repair authorized." });
      const window = windows.find((window) => window.submissionId === row.id);
      if (markers.some((marker) => marker.target === row.id) && (!window || window.state === "SENT_OUTSIDE_PORTAL")) groups.portalWindowRepairProposal.push({ ...base, window: window ?? null, next: "Inspect recorded client decisions and original publication time; propose only this window's correction. Never shorten an allowance, auto-approve, replay notices or reopen all reviews." });
    } else if (row.sentToClientAt && row.topazJob && !row.topazJob.deliveredAt) groups.aryeoBookkeepingRepairCandidates.push({ ...base, next: "Reconcile existing send bookkeeping with its original attribution; do not infer new provider proof." });
    else if (!row.sentToClientAt) (row.project.aryeoListingId ? groups.stillNeedUploadOrDelivery : groups.ambiguousHumanReview).push({ ...base, hasUploadLedger: uploads.some((receipt) => receipt.target === row.id && receipt.action === "video_uploaded"), next: "Human confirmation of exact version, upload and destination; no inference from download, listing status or counts." });
  }
  const report = { generatedAt: new Date().toISOString(), scope: "At most 300 active approved cuts: unsent or approved in last 90 days. Candidate classification only; no provider playback/backup proof, no changes. Newer nonapproved revisions require individual confirmation before any repair.", inspected: rows.length, capped: rows.length === 300, schema: { publicationColumnPresent: columns.length > 0, migrationLedgerPresent: migrationTable[0]?.present ?? false, backupCoverage: "Not verified for a new production schema change. Additive SQL is prepared only; take and verify the required backup before applying." }, groups };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-delivery-proposal-")); fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "proposal.private.json"); fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ inspected: report.inspected, capped: report.capped, schema: report.schema, groups: Object.fromEntries(Object.entries(groups).map(([name, records]) => [name, records.length])), privateReport: file }));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Read-only proposal failed"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
