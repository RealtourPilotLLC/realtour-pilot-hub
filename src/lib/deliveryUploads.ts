import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentApproved, loadCut, sourceFingerprint } from "@/lib/finalRendition";
import { readDropboxFile } from "@/lib/finalDropbox";
import { boundedWait } from "@/lib/boundedWait";

/** Append-only upload receipts use the existing indexed audit ledger. No schema
 * migration, historical check backfill or download inference is required. */
export type UploadReceipt = {
  id: string; submissionId: string; projectId: string; listingId: string;
  round: number; deliverableId: string | null; slot: number | null;
  sourceFingerprint: string; source: unknown; actorId: string | null;
  actor: string; uploadedAt: string;
  finalContentHash?: string | null;
};
type Db = Prisma.TransactionClient;

export async function uploadsFor(ids: string[], db: Db = prisma): Promise<Map<string, UploadReceipt>> {
  const result = new Map<string, UploadReceipt>();
  if (!ids.length) return result;
  const rows = await db.auditLog.findMany({ where: { target: { in: ids }, action: { in: ["video_uploaded", "video_upload_corrected"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  for (const row of rows) {
    // Malformed evidence is a failed read, never permission to send a file.
    const data = JSON.parse(row.detail) as UploadReceipt & { receiptId?: string };
    if (row.action === "video_upload_corrected") {
      if (result.get(row.target)?.id === data.receiptId) result.delete(row.target);
    } else if (data.submissionId === row.target && data.id === row.id && data.sourceFingerprint && data.listingId && Number.isFinite(Date.parse(data.uploadedAt))) {
      result.set(row.target, data);
    } else throw new Error("Upload evidence could not be read. Reconcile this exact version.");
  }
  return result;
}

export async function recordUploaded(id: string, actor: { id: string | null; name: string }, expectedFingerprint: string): Promise<{ ok: boolean; message: string }> {
  // Optional provider evidence is read outside locks. Failure cannot prevent a
  // staff acknowledgement; it only limits automatic provider settlement.
  const before = await loadCut(id);
  const finalFile = before?.topazJob?.state === "done" && before.topazJob.finalPath
    ? await boundedWait(readDropboxFile(before.topazJob.finalPath), 2_000).catch(() => null) : null;
  return prisma.$transaction(async (tx) => {
    const initial = await loadCut(id, tx);
    if (!initial) return { ok: false, message: "That video no longer exists." };
    // Serialize replacements, double presses and destination changes with the
    // same project/submission locks used by the delivery writers.
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${initial.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${initial.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${initial.projectId} ORDER BY id FOR UPDATE`;
    const cut = await loadCut(id, tx);
    if (!cut || cut.project.contentMonthId || !cut.project.aryeoListingId || !(await currentApproved(cut, tx))) return { ok: false, message: "Reload: this is no longer a current approved listing video with a destination." };
    if (cut.sentToClientAt) return { ok: false, message: "Delivery is already recorded. Its history cannot be backdated as an upload." };
    const fingerprint = sourceFingerprint(cut);
    if (!fingerprint) return { ok: false, message: "The final file is not ready to upload." };
    if (fingerprint !== expectedFingerprint) return { ok: false, message: "The finished file or destination changed. Reload and upload the current version before acknowledging it." };
    const previous = (await uploadsFor([id], tx)).get(id);
    if (previous?.sourceFingerprint === fingerprint && previous.listingId === cut.project.aryeoListingId) return { ok: true, message: `Already recorded as uploaded by ${previous.actor}.` };
    const receipt: UploadReceipt = { id: `video-upload:${crypto.randomUUID()}`, submissionId: id, projectId: cut.projectId,
      listingId: cut.project.aryeoListingId, round: cut.round, deliverableId: cut.deliverableId, slot: cut.slot,
      sourceFingerprint: fingerprint, source: { assetPath: cut.assetPath, finalPath: cut.finalPath, blobUrl: cut.blobUrl, contentHash: cut.contentHash, sourceRev: cut.sourceRev, topaz: cut.topazJob },
      finalContentHash: cut.topazJob?.state === "done" ? (before && sourceFingerprint(before) === fingerprint ? finalFile?.hash ?? null : null) : cut.contentHash,
      actorId: actor.id, actor: actor.name.slice(0, 120), uploadedAt: new Date().toISOString() };
    await tx.auditLog.create({ data: { id: receipt.id, target: id, actor: receipt.actor, action: "video_uploaded", detail: JSON.stringify(receipt) } });
    return { ok: true, message: "Uploaded version recorded. Delivery remains outstanding; no provider action or client message was sent." };
  }, { isolationLevel: "Serializable" });
}

/** Counts, duration and a reused provider ID cannot identify replacement bytes.
 * The existing matcher proposes a media ID; this guard only subtracts matches.
 * Missing trustworthy event/file evidence remains an office fallback. */
export async function providerUploadMatches(id: string, mediaId: string, listing: { id?: string; videos?: unknown[] } | null, occurredAt: Date | null) {
  if (!occurredAt || occurredAt.getTime() > Date.now() || !(await uploadedForDelivery(id)).ok) return false;
  const receipt = (await uploadsFor([id])).get(id);
  if (!receipt?.finalContentHash || listing?.id !== receipt.listingId || occurredAt.getTime() < Date.parse(receipt.uploadedAt)) return false;
  const row = listing?.videos?.find((value) => value && typeof value === "object" && (value as { id?: string }).id === mediaId) as Record<string, unknown> | undefined;
  if (!row) return false;
  const hash = row.source_content_hash ?? row.content_hash;
  return typeof hash === "string" && hash === receipt.finalContentHash;
}

/** Exact byte evidence can support an in-place provider replacement whose ID
 * predates this rendition. Ambiguous identical files across outputs stay held. */
export async function extendExactUploadMatches(proven: Map<string, string>, candidates: { key: string; submissionId: string; contested?: boolean }[], listing: { id?: string; videos?: unknown[] } | null, occurredAt: Date | null) {
  const mediaIds = (listing?.videos ?? []).flatMap((value) => value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? [(value as { id: string }).id] : []);
  const matches = new Map<string, string[]>();
  for (const candidate of candidates.filter((candidate) => !candidate.contested)) {
    for (const mediaId of mediaIds) if (await providerUploadMatches(candidate.submissionId, mediaId, listing, occurredAt)) matches.set(candidate.key, [...(matches.get(candidate.key) ?? []), mediaId]);
  }
  for (const [key, ids] of matches) {
    if (ids.length !== 1 || [...matches.values()].filter((values) => values.includes(ids[0])).length !== 1 || [...proven].some(([other, mediaId]) => other !== key && mediaId === ids[0])) continue;
    proven.set(key, ids[0]);
  }
}

export async function recordedListingDeliveryAt(listingId: string | null): Promise<Date | null> {
  if (!listingId) return null;
  const rows = await prisma.auditLog.findMany({ where: { target: listingId, action: "aryeo_listing_delivery_event" }, orderBy: { createdAt: "desc" }, take: 100 });
  const dates = rows.map((row) => { const data = JSON.parse(row.detail) as { listingId?: string; occurredAt?: string }; return data.listingId === listingId && data.occurredAt ? new Date(data.occurredAt) : null; }).filter((date): date is Date => !!date && Number.isFinite(date.getTime()));
  return dates.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}

/** Staff fallback checks local exact-version evidence, not provider availability.
 * Already sent versions remain repairable after a later replacement. */
export async function uploadedForDelivery(id: string, db: Db = prisma): Promise<{ ok: boolean; message: string }> {
  const cut = await loadCut(id, db);
  if (!cut) return { ok: false, message: "That video no longer exists." };
  if (cut.sentToClientAt) return { ok: true, message: "Existing delivery can be reconciled." };
  if (cut.project.contentMonthId || !(await currentApproved(cut, db))) return { ok: false, message: "This is no longer a current approved listing video." };
  const receipt = (await uploadsFor([id], db)).get(id);
  if (!receipt || receipt.listingId !== cut.project.aryeoListingId || receipt.sourceFingerprint !== sourceFingerprint(cut)) return { ok: false, message: "Mark this exact finished version as uploaded to its Aryeo listing first." };
  return { ok: true, message: "Exact upload recorded." };
}

export async function claimListingDelivery(id: string, by: string | null, expectedFingerprint?: string) {
  return prisma.$transaction(async (tx) => {
    const cut = await loadCut(id, tx);
    if (!cut) return { ok: false as const, message: "That video no longer exists." };
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${cut.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${cut.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${cut.projectId} ORDER BY id FOR UPDATE`;
    const current = await loadCut(id, tx);
    if (!current?.sentToClientAt && expectedFingerprint && sourceFingerprint(current!) !== expectedFingerprint) return { ok: false as const, message: "The finished file changed. Reload and confirm delivery of the current uploaded version." };
    const ready = await uploadedForDelivery(id, tx);
    if (!ready.ok) return { ok: false as const, message: ready.message };
    const stamp = await tx.reviewSubmission.updateMany({ where: { id, sentToClientAt: null, status: "APPROVED" }, data: { sentToClientAt: new Date(), sentToClientBy: by } });
    return { ok: true as const, count: stamp.count };
  }, { isolationLevel: "Serializable" });
}

export async function correctUpload(id: string, receiptId: string, reason: string, actor: { id: string | null; name: string }) {
  if (!reason.trim()) return { ok: false, message: "Say why the upload record needs correction." };
  return prisma.$transaction(async (tx) => {
    const cut = await loadCut(id, tx);
    if (!cut) return { ok: false, message: "That video no longer exists." };
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${cut.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${cut.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${cut.projectId} ORDER BY id FOR UPDATE`;
    const current = await loadCut(id, tx);
    if (current?.sentToClientAt) return { ok: false, message: "Delivery is already recorded. Reconcile that delivery separately before correcting upload state." };
    const receipt = (await uploadsFor([id], tx)).get(id);
    if (!receipt) return { ok: true, message: "This upload record was already corrected." };
    if (receipt.id !== receiptId) return { ok: false, message: "A newer upload record exists. Reload before correcting it." };
    await tx.auditLog.create({ data: { actor: actor.name.slice(0, 120), action: "video_upload_corrected", target: id,
      detail: JSON.stringify({ receiptId, reason: reason.trim().slice(0, 1000), actorId: actor.id }) } });
    return { ok: true, message: "Upload status corrected. Its original history remains; this did not remove or undeliver anything in Aryeo." };
  }, { isolationLevel: "Serializable" });
}

/** Reverses only this exact local claim. The immutable audit keeps original
 * attribution and notice context; no provider delivery is undone. */
export async function correctSent(id: string, expectedSentAt: string, reason: string, actor: { id: string | null; name: string }) {
  if (!reason.trim()) return { ok: false, message: "Say why this delivery status needs correction." };
  return prisma.$transaction(async (tx) => {
    const initial = await loadCut(id, tx);
    if (!initial || initial.project.contentMonthId) return { ok: false, message: "Only a listing delivery can be corrected here." };
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${initial.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${initial.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${initial.projectId} ORDER BY id FOR UPDATE`;
    const cut = await loadCut(id, tx);
    if (!cut?.sentToClientAt) return { ok: true, message: "This delivery status is already corrected." };
    if (cut.sentToClientAt.toISOString() !== expectedSentAt || !(await currentApproved(cut, tx))) return { ok: false, message: "The delivery or current version changed. Reload before correcting it." };
    const receipt = (await uploadsFor([id], tx)).get(id);
    await tx.auditLog.create({ data: { target: id, actor: actor.name.slice(0, 120), action: "video_delivery_corrected", detail: JSON.stringify({ actorId: actor.id, reason: reason.trim().slice(0, 1000), originalSentAt: cut.sentToClientAt.toISOString(), originalSentBy: cut.sentToClientBy, sourceFingerprint: sourceFingerprint(cut), listingId: cut.project.aryeoListingId, round: cut.round }) } });
    if (receipt) await tx.auditLog.create({ data: { target: id, actor: actor.name.slice(0, 120), action: "video_upload_corrected", detail: JSON.stringify({ receiptId: receipt.id, reason: "Delivery correction: " + reason.trim().slice(0, 1000), actorId: actor.id }) } });
    await tx.reviewSubmission.update({ where: { id }, data: { sentToClientAt: null, sentToClientBy: null } });
    await tx.deliverableOutput.updateMany({ where: { projectId: cut.projectId, sentSubmissionId: id }, data: { sentSubmissionId: null, deliveredAt: null, deliveredBy: null, deliveredVia: null, evidenceSource: null, evidenceSucceededAt: null } });
    if (cut.topazJob) {
      const job = await tx.topazJob.findUnique({ where: { id: cut.topazJob.id }, select: { deliveredAt: true, taskId: true } });
      if (job?.deliveredAt?.getTime() === cut.sentToClientAt.getTime()) {
        await tx.topazJob.update({ where: { id: cut.topazJob.id }, data: { deliveredAt: null, deliveredBy: null } });
        if (job.taskId) await tx.smartTask.updateMany({ where: { id: job.taskId, status: "COMPLETED", completedAt: job.deliveredAt }, data: { status: "OPEN", completedAt: null } });
      }
    }
    return { ok: true, message: "Hub delivery status corrected; original attribution and communication history are retained. Aryeo was not changed. Confirm the current upload before recording delivery again." };
  }, { isolationLevel: "Serializable" });
}
