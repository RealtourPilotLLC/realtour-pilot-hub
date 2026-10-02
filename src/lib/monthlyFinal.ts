import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { actualFolderPaths } from "@/lib/dropboxFolders";
import { videoCutKey } from "@/lib/contentVideos";
import { clientCutFiles } from "@/lib/cutEntitlement";
import { PROGRAM_ROLLOUT_SETTING_KEY, parseProgramRollout, rolloutDecision } from "@/lib/programRolloutCore";
import { digest, proveOriginalBackup, readDropboxFile } from "@/lib/finalDropbox";

type Db = Pick<Prisma.TransactionClient, "contentMonth" | "contentEnrollment" | "clientMembership" | "clientUser" | "client" | "appSetting">;
export type MonthlyAccess = { ok: boolean; enrollmentId: string | null; clientId: string | null; stamp: string; message: string };

/** Same eligibility as a normal owner login, fenced to THIS month's enrollment.
 * A disabled person or an owner seat on another program cannot settle delivery. */
export async function monthlyOwnerAccess(monthIds: string[], db: Db = prisma): Promise<Map<string, MonthlyAccess>> {
  const out = new Map<string, MonthlyAccess>();
  if (!monthIds.length) return out;
  const months = await db.contentMonth.findMany({ where: { id: { in: monthIds } }, select: { id: true, enrollmentId: true, clientId: true } });
  const enrollments = await db.contentEnrollment.findMany({ where: { id: { in: months.map((m) => m.enrollmentId) } }, select: { id: true, clientId: true, status: true, accessRevokedAt: true } });
  const seats = await db.clientMembership.findMany({ where: { enrollmentId: { in: enrollments.map((e) => e.id) }, role: "OWNER", revokedAt: null }, orderBy: { id: "asc" }, select: { id: true, enrollmentId: true, clientId: true, clientUserId: true } });
  const users = await db.clientUser.findMany({ where: { id: { in: seats.map((s) => s.clientUserId) }, status: { not: "DISABLED" } }, select: { id: true, status: true } });
  const clients = await db.client.findMany({ where: { id: { in: months.map((m) => m.clientId) } }, select: { id: true, name: true } });
  const setting = await db.appSetting.findUnique({ where: { key: PROGRAM_ROLLOUT_SETTING_KEY }, select: { value: true } });
  const { rollout } = parseProgramRollout(setting?.value ?? null);
  for (const m of months) {
    const e = enrollments.find((e) => e.id === m.enrollmentId);
    const client = clients.find((c) => c.id === m.clientId);
    const owners = seats.filter((s) => s.enrollmentId === m.enrollmentId && s.clientId === m.clientId && users.some((u) => u.id === s.clientUserId));
    const ok = !!e && e.clientId === m.clientId && e.status === "ACTIVE" && !e.accessRevokedAt && !!client && owners.length > 0
      && rolloutDecision({ rollout, client, op: "portal_sign_in", now: new Date() }).ok;
    out.set(m.id, { ok, enrollmentId: m.enrollmentId, clientId: m.clientId,
      stamp: digest([m, e, owners, users.filter((u) => owners.some((s) => s.clientUserId === u.id)), setting?.value ?? null, ok]),
      message: ok ? "An eligible owner can sign in to this exact program." : "Confirm an eligible owner seat and rollout access for this exact program before recording portal delivery." });
  }
  return out;
}

export async function loadMonthlyCut(id: string, db: Prisma.TransactionClient = prisma) {
  return db.reviewSubmission.findUnique({ where: { id }, include: { topazJob: true, project: { include: { client: { select: { id: true, name: true } } } } } });
}
export type MonthlyCut = NonNullable<Awaited<ReturnType<typeof loadMonthlyCut>>>;
export const monthlyCutStamp = (s: MonthlyCut) => digest([s.id, s.projectId, s.status, s.round, s.deliverableId, s.slot, s.fileName, s.assetPath, s.finalPath, s.blobUrl, s.blobPathname, s.sizeBytes, s.contentHash, s.sourceRev, s.decidedAt, s.portalPublicationRequiredAt, s.project.contentMonthId, s.project.clientId, s.project.status, s.project.dropboxFolder, s.topazJob ? { id: s.topazJob.id, state: s.topazJob.state, finalPath: s.topazJob.finalPath, savedAt: s.topazJob.savedAt, outputCheck: s.topazJob.outputCheck } : null]);

/** Keep access writers ordered with the final check/claim. Serializable reads
 * alone do not require a revocation writer to wait until the stamp commits. */
export async function lockMonthlyFinalAccess(tx: Prisma.TransactionClient, monthId: string) {
  await tx.$queryRaw`SELECT id FROM "ContentMonth" WHERE id = ${monthId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "ContentEnrollment" WHERE id IN (SELECT "enrollmentId" FROM "ContentMonth" WHERE id = ${monthId}) ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "ClientMembership" WHERE "enrollmentId" IN (SELECT "enrollmentId" FROM "ContentMonth" WHERE id = ${monthId}) ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "ClientUser" WHERE id IN (SELECT "clientUserId" FROM "ClientMembership" WHERE "enrollmentId" IN (SELECT "enrollmentId" FROM "ContentMonth" WHERE id = ${monthId})) ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id IN (SELECT "clientId" FROM "ContentMonth" WHERE id = ${monthId}) ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT key FROM "AppSetting" WHERE key = ${PROGRAM_ROLLOUT_SETTING_KEY} FOR SHARE`;
}

export async function currentMonthlyCut(s: MonthlyCut, db: Prisma.TransactionClient = prisma): Promise<boolean> {
  if (!s.project.contentMonthId || s.status !== "APPROVED" || ["CANCELLED", "ON_HOLD"].includes(s.project.status)) return false;
  const rounds = await db.reviewSubmission.findMany({ where: { projectId: s.projectId, withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } }, orderBy: [{ round: "desc" }, { createdAt: "desc" }] });
  if (rounds.find((r) => videoCutKey(r) === videoCutKey(s))?.id !== s.id) return false;
  if (!s.deliverableId) return true;
  const output = await db.deliverableOutput.findFirst({ where: { projectId: s.projectId, deliverableId: s.deliverableId, slot: s.slot, waivedAt: null, removedFromOrderAt: null } });
  return !!output && (!output.currentSubmissionId || output.currentSubmissionId === s.id) && (!output.approvedSubmissionId || output.approvedSubmissionId === s.id);
}

export type MonthlyFinalSnapshot = { ok: true; cut: MonthlyCut; fingerprint: string; mediaId: string; previewUrl: string; fileName: string; file: { kind: "original" } | { kind: "processed"; path: string }; backup: NonNullable<Awaited<ReturnType<typeof readDropboxFile>>>; access: MonthlyAccess } | { ok: false; message: string };

/** Read-only provider proof. Metadata/content/source changes invalidate a pass.
 * The Review Room's original is intentionally not repointed to this final file. */
export async function monthlyFinalSnapshot(id: string): Promise<MonthlyFinalSnapshot> {
  const cut = await loadMonthlyCut(id);
  if (!cut || !(await currentMonthlyCut(cut))) return { ok: false, message: "That monthly approved version is no longer current." };
  if (cut.portalPublicationRequiredAt && !(cut.topazJob?.state === "done" && cut.topazJob.finalPath && cut.topazJob.savedAt && ["verified", "resolved-processed"].includes(cut.topazJob.outputCheck ?? ""))) return { ok: false, message: "The verified 1080p file is not ready. Retry finishing or resolve its hold before portal publication." };
  const files = await clientCutFiles([id]); // A read failure throws, never falls back to the original.
  const file = files.get(id) ?? { kind: "original" as const };
  if (file.kind === "finishing") return { ok: false, message: "The client file is still being finished or held for review." };
  const path = file.kind === "processed" ? file.path : cut.finalPath ?? (!cut.blobUrl ? cut.assetPath : null);
  const folder = `${actualFolderPaths(cut.project).finalVideo}/`;
  if (!path || path.slice(0, path.lastIndexOf("/") + 1).toLowerCase() !== folder.toLowerCase()) return { ok: false, message: "The exact client file needs a verified backup in this job’s final Dropbox folder." };
  const backup = file.kind === "processed" ? await readDropboxFile(path) : await proveOriginalBackup(cut, path);
  if (!backup) return { ok: false, message: "Dropbox could not confirm the exact final bytes. A saved path or timestamp alone cannot certify the backup." };
  // The canonical stream prefers assetPath after hub retention. Legacy imports
  // can keep a different original there; checking a backup must not certify an
  // overwritten client source merely because finalPath still holds good bytes.
  let canonicalSource = backup;
  if (file.kind === "original" && !cut.blobUrl && cut.assetPath && cut.assetPath.toLowerCase() !== path.toLowerCase()) {
    const source = await readDropboxFile(cut.assetPath);
    if (!source || source.hash !== backup.hash || source.size !== backup.size) return { ok: false, message: "The client’s original file and its final Dropbox backup do not match. Reconcile these exact files before recording delivery." };
    canonicalSource = source;
  }
  const access = (await monthlyOwnerAccess([cut.project.contentMonthId!])).get(cut.project.contentMonthId!);
  if (!access?.ok || access.clientId !== cut.project.clientId) return { ok: false, message: access?.message ?? "Client access could not be confirmed." };
  const fresh = await loadMonthlyCut(id);
  if (!fresh || monthlyCutStamp(fresh) !== monthlyCutStamp(cut) || !(await currentMonthlyCut(fresh))) return { ok: false, message: "The approved version or final file changed during the read. Check the current version again." };
  const mediaId = digest([file.kind, backup.id, backup.rev, backup.hash, backup.size, digest(backup.path)]);
  const fingerprint = digest([monthlyCutStamp(cut), mediaId, access.stamp, canonicalSource]);
  return { ok: true, cut, fingerprint, mediaId, previewUrl: `/api/review/cut/${id}/final?f=${fingerprint}`, fileName: file.kind === "processed" ? file.fileName : cut.fileName ?? path.split("/").pop()!, file: file.kind === "processed" ? { kind: "processed", path: file.path } : { kind: "original" }, backup, access };
}

/** Provider proof is collected before the transaction; the first delivery
 * claim rechecks canonical version, exact seat/scope and saved check inside it. */
export const monthlyPortalHandoffId = (submissionId: string) => `monthly-portal-handoff:${submissionId}`;

export async function claimMonthlyFinalDelivery(id: string, by: string | null): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  const s = await monthlyFinalSnapshot(id);
  if (!s.ok) return s;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${s.cut.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${s.cut.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${s.cut.projectId} ORDER BY id FOR UPDATE`;
    await lockMonthlyFinalAccess(tx, s.cut.project.contentMonthId!);
    const current = await loadMonthlyCut(id, tx);
    if (current?.sentToClientAt) return { ok: true as const, count: 0 };
    const access = (await monthlyOwnerAccess([s.cut.project.contentMonthId!], tx)).get(s.cut.project.contentMonthId!);
    if (!current || monthlyCutStamp(current) !== monthlyCutStamp(s.cut) || !(await currentMonthlyCut(current, tx)) || !access?.ok || access.stamp !== s.access.stamp) return { ok: false as const, message: "The version or client access changed before delivery was recorded. Check the current final file again." };
    await tx.$queryRaw`SELECT id FROM "ContentVideoSource" WHERE kind = 'REVIEW_CUT' AND ref = ${id} FOR SHARE`;
    const source = await tx.contentVideoSource.findFirst({ where: { kind: "REVIEW_CUT", ref: id }, select: { videoId: true } });
    if (source) await tx.$queryRaw`SELECT id FROM "ContentVideo" WHERE id = ${source.videoId} FOR SHARE`;
    const linked = source ? await tx.contentVideo.findFirst({ where: { id: source.videoId, enrollmentId: s.access.enrollmentId!, clientId: s.access.clientId!, status: { not: "ARCHIVED" }, projectId: current.projectId }, select: { id: true } }) : null;
    if (!linked || current.videoId !== linked.id) return { ok: false as const, message: "This exact version is not linked to the correct client library. Retry library publication." };
    const publishedAt = new Date();
    const changed = await tx.reviewSubmission.updateMany({ where: { id, status: "APPROVED", sentToClientAt: null }, data: { sentToClientAt: publishedAt, sentToClientBy: by, clientReleasedAt: current.clientReleasedAt ?? publishedAt, clientReleasedBy: current.clientReleasedBy ?? "Portal publication" } });
    if (changed.count === 1) {
      await tx.auditLog.create({ data: { id: monthlyPortalHandoffId(id), actor: "system", action: "monthly_portal_handoff", target: id,
        detail: JSON.stringify({ sourceFingerprint: s.fingerprint, destinationMediaId: s.mediaId, publishedAt: publishedAt.toISOString(), libraryVideoId: linked.id }) } });
    }
    return { ok: true as const, count: changed.count };
  }, { isolationLevel: "Serializable" });
}

/** Only new publication-gated approvals. No historical deadline repair or
 * broad backfill is performed by this automatic retry. */
export async function repairMonthlyPublications(max = 100) {
  const cuts = await prisma.reviewSubmission.findMany({ where: { status: "APPROVED", portalPublicationRequiredAt: { not: null }, clientReleasedAt: null, project: { contentMonthId: { not: null }, status: { notIn: ["CANCELLED", "ON_HOLD"] } } }, orderBy: { decidedAt: "asc" }, take: max, select: { id: true } });
  const { publishApprovedCutToLibrary } = await import("@/lib/contentVideos");
  let published = 0;
  const exceptions: { id: string; reason: string }[] = [];
  for (const cut of cuts) {
    const result = await publishApprovedCutToLibrary(cut.id);
    if (result.published) published++; else exceptions.push({ id: cut.id, reason: result.why ?? "Publication unavailable" });
  }
  return { checked: cuts.length, published, exceptions };
}
