import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentApproved, loadCut, sourceFingerprint } from "@/lib/finalRendition";
import { usesAryeoDelivery } from "@/lib/videoDeliveryDestination";

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
  // Recording what staff uploaded is entirely local. Provider reads must never
  // delay this save; an authenticated subsequent delivery event settles it.
  return prisma.$transaction(async (tx) => {
    const initial = await loadCut(id, tx);
    if (!initial) return { ok: false, message: "That video no longer exists." };
    // Serialize replacements, double presses and destination changes with the
    // same project/submission locks used by the delivery writers.
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${initial.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${initial.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${initial.projectId} ORDER BY id FOR UPDATE`;
    const cut = await loadCut(id, tx);
    if (!cut || !(await usesAryeoDelivery(cut, tx)) || !cut.project.aryeoListingId || !(await currentApproved(cut, tx))) return { ok: false, message: "Reload: this is no longer a current approved Aryeo video with a destination." };
    if (cut.sentToClientAt) return { ok: false, message: "Delivery is already recorded. Its history cannot be backdated as an upload." };
    const fingerprint = sourceFingerprint(cut);
    if (!fingerprint) return { ok: false, message: "The final file is not ready to upload." };
    if (fingerprint !== expectedFingerprint) return { ok: false, message: "The finished file or destination changed. Reload and upload the current version before acknowledging it." };
    const previous = (await uploadsFor([id], tx)).get(id);
    if (previous?.sourceFingerprint === fingerprint && previous.listingId === cut.project.aryeoListingId) return { ok: true, message: `Already recorded as uploaded by ${previous.actor}.` };
    const receipt: UploadReceipt = { id: `video-upload:${crypto.randomUUID()}`, submissionId: id, projectId: cut.projectId,
      listingId: cut.project.aryeoListingId, round: cut.round, deliverableId: cut.deliverableId, slot: cut.slot,
      sourceFingerprint: fingerprint, source: { assetPath: cut.assetPath, finalPath: cut.finalPath, blobUrl: cut.blobUrl, contentHash: cut.contentHash, sourceRev: cut.sourceRev, topaz: cut.topazJob },
      finalContentHash: cut.topazJob?.state === "done" ? null : cut.contentHash,
      actorId: actor.id, actor: actor.name.slice(0, 120), uploadedAt: new Date().toISOString() };
    await tx.auditLog.create({ data: { id: receipt.id, target: id, actor: receipt.actor, action: "video_uploaded", detail: JSON.stringify(receipt) } });
    return { ok: true, message: "Uploaded version recorded. Delivery remains outstanding; no provider action or client message was sent." };
  }, { isolationLevel: "Serializable" });
}


/** Read-only recovery of a lost acknowledgement response. Never consult providers
 * or write another receipt; the exact current source and destination must match. */
export async function uploadReceiptStatus(id: string, expectedFingerprint: string) {
  return prisma.$transaction(async (tx) => {
    const cut = await loadCut(id, tx);
    const missing = { ok: true, recorded: false, message: "No matching current upload receipt was found." };
    if (!cut || !(await usesAryeoDelivery(cut, tx)) || !cut.project.aryeoListingId || !(await currentApproved(cut, tx)) || sourceFingerprint(cut) !== expectedFingerprint) return missing;
    const receipt = (await uploadsFor([id], tx)).get(id);
    if (!receipt || receipt.sourceFingerprint !== expectedFingerprint || receipt.listingId !== cut.project.aryeoListingId) return missing;
    return { ok: true, recorded: true, sent: !!cut.sentToClientAt, message: `Upload confirmed from the saved receipt by ${receipt.actor}.` };
  }, { isolationLevel: "RepeatableRead" });
}

/** Exact bytes: Kyle's receipt for this version, a delivery occurrence after it,
 * and the provider row carrying the same content hash. Counts, duration and a
 * reused provider ID cannot identify replacement bytes on their own. */
async function exactUploadMatches(id: string, mediaId: string, listing: ListingProof, occurredAt: Date | null) {
  if (!occurredAt || occurredAt.getTime() > Date.now() || !(await uploadedForDelivery(id)).ok) return false;
  const receipt = (await uploadsFor([id])).get(id);
  if (!receipt?.finalContentHash || listing?.id !== receipt.listingId || occurredAt.getTime() < Date.parse(receipt.uploadedAt)) return false;
  const row = listing?.videos?.find((value) => value && typeof value === "object" && (value as { id?: string }).id === mediaId) as Record<string, unknown> | undefined;
  if (!row) return false;
  const hash = row.source_content_hash ?? row.content_hash;
  return typeof hash === "string" && hash === receipt.finalContentHash;
}

/** The existing matcher (aryeoDelivery) proposes one media ID for one version;
 * this guard only ever subtracts. A proposal stands when EITHER Kyle's exact
 * upload receipt carries the provider's own bytes, OR — with no receipt at all —
 * Aryeo itself confirmed the delivery (Oct 5 2026, Jordan: that proof IS
 * delivery, Kyle should not have to press anything): an authenticated read of
 * the listing says DELIVERED, and a signed delivery event or an accepted
 * delivery text happened after that video was on the listing. */
export async function providerUploadMatches(id: string, mediaId: string, listing: ListingProof, occurredAt: Date | null) {
  if (await exactUploadMatches(id, mediaId, listing, occurredAt)) return true;
  return (await aryeoConfirmedDelivery(id, { listing, mediaId, occurredAt })).ok;
}

/** Exact byte evidence can support an in-place provider replacement whose ID
 * predates this rendition. Ambiguous identical files across outputs stay held.
 * Bytes only: a delivery occurrence never lets an older media ID stand in. */
export async function extendExactUploadMatches(proven: Map<string, string>, candidates: { key: string; submissionId: string; contested?: boolean }[], listing: ListingProof, occurredAt: Date | null) {
  const mediaIds = (listing?.videos ?? []).flatMap((value) => value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? [(value as { id: string }).id] : []);
  const matches = new Map<string, string[]>();
  for (const candidate of candidates.filter((candidate) => !candidate.contested)) {
    for (const mediaId of mediaIds) if (await exactUploadMatches(candidate.submissionId, mediaId, listing, occurredAt)) matches.set(candidate.key, [...(matches.get(candidate.key) ?? []), mediaId]);
  }
  for (const [key, ids] of matches) {
    if (ids.length !== 1 || [...matches.values()].filter((values) => values.includes(ids[0])).length !== 1 || [...proven].some(([other, mediaId]) => other !== key && mediaId === ids[0])) continue;
    proven.set(key, ids[0]);
  }
}

type ListingProof = { id?: string; delivery_status?: string | null; videos?: unknown[] } | null;
export type DeliveryOccurrence = { at: Date; source: "aryeo-event" | "delivery-text"; ref: string };

/** Five minutes of clock skew between Aryeo/OpenPhone and us, never more. */
const SKEW_MS = 5 * 60_000;

/**
 * THE TWO DELIVERY OCCURRENCES THE HUB CAN VERIFY, newest first:
 *   · a LISTING_DELIVERED webhook that carried Aryeo's signature, stored
 *     before any cooldown (aryeoDelivery.handleAryeoActivity), dated by Aryeo;
 *   · the hub's own delivery text for a job on this listing that the provider
 *     ACCEPTED (OutboxMessage state "accepted"), dated by that acceptance.
 * Unsigned posts and texts in any other state are not occurrences. Reads only.
 */
export async function deliveryOccurrences(listingId: string | null, db: Db = prisma): Promise<DeliveryOccurrence[]> {
  if (!listingId) return [];
  const now = Date.now() + SKEW_MS;
  const events = await db.auditLog.findMany({ where: { target: listingId, action: "aryeo_listing_delivery_event" }, orderBy: { createdAt: "desc" }, take: 100 });
  const projects = await db.project.findMany({ where: { aryeoListingId: listingId }, select: { id: true } });
  const out: DeliveryOccurrence[] = [];
  for (const row of events) {
    const data = JSON.parse(row.detail) as { listingId?: string; occurredAt?: string };
    const at = data.listingId === listingId && data.occurredAt ? new Date(data.occurredAt) : null;
    if (at && Number.isFinite(at.getTime()) && at.getTime() <= now) out.push({ at, source: "aryeo-event", ref: row.id });
  }
  if (projects.length) {
    const { deliveryKey } = await import("@/lib/outbox");
    const texts = await db.outboxMessage.findMany({
      where: { dedupeKey: { in: projects.map((p) => deliveryKey(p.id)) }, state: "accepted", acceptedAt: { not: null } },
      select: { id: true, acceptedAt: true }, orderBy: { acceptedAt: "desc" }, take: 20,
    });
    for (const t of texts) if (t.acceptedAt && t.acceptedAt.getTime() <= now) out.push({ at: t.acceptedAt, source: "delivery-text", ref: t.id });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** The newest verified delivery occurrence for a listing (see deliveryOccurrences). */
export async function recordedListingDeliveryAt(listingId: string | null): Promise<Date | null> {
  return (await deliveryOccurrences(listingId))[0]?.at ?? null;
}

/** When this exact version's file existed: the filed 1080p file, else the approval. */
async function versionReadyAt(id: string, db: Db = prisma): Promise<Date | null> {
  const row = await db.reviewSubmission.findUnique({ where: { id }, select: { decidedAt: true, completedAt: true, createdAt: true, topazJob: { select: { state: true, savedAt: true, finalPath: true } } } });
  if (!row) return null;
  const j = row.topazJob;
  if (j && j.state === "done") return j.savedAt ?? null;
  return row.decidedAt ?? row.completedAt ?? row.createdAt;
}

/**
 * ARYEO CONFIRMED THIS VERSION'S DELIVERY — with no upload receipt needed.
 *
 * True only when ALL of this holds for the current approved Aryeo version:
 *   · its job is linked to the listing the proof is about;
 *   · when a listing read is supplied, Aryeo's own read says DELIVERED (a field
 *     only Aryeo can set) and, when a media ID is supplied, that video is on it;
 *   · a signed delivery event or an accepted delivery text happened at or after
 *     the moment this version's file existed — and, with a media ID, at or after
 *     that video went up — so the delivery cannot predate the file.
 * It never writes and never fabricates an upload receipt: a row it settles is
 * recorded as Aryeo's confirmation, never as Kyle's upload. The matcher in
 * aryeoDelivery decides WHICH video is this version; this decides only that a
 * verified delivery covered it.
 */
export async function aryeoConfirmedDelivery(id: string, opts: { listing?: ListingProof; mediaId?: string | null; occurredAt?: Date | null } = {}, db: Db = prisma): Promise<{ ok: boolean; occurrence?: DeliveryOccurrence; message: string }> {
  const no = (message: string) => ({ ok: false, message });
  const cut = await loadCut(id, db);
  if (!cut) return no("That video no longer exists.");
  const listingId = cut.project.aryeoListingId;
  if (!listingId) return no("This job has no linked Aryeo listing.");
  if (!(await usesAryeoDelivery(cut, db)) || !(await currentApproved(cut, db))) return no("This is no longer a current approved Aryeo video.");
  const listing = opts.listing;
  if (listing !== undefined) {
    if (!listing || (listing.id && listing.id !== listingId)) return no("Aryeo's listing is not this job's listing.");
    if (String(listing.delivery_status ?? "").toUpperCase() !== "DELIVERED") return no("Aryeo does not show this listing as delivered.");
    if (opts.mediaId && !listing.videos?.some((v) => v && typeof v === "object" && (v as { id?: unknown }).id === opts.mediaId)) return no("That video is not on Aryeo's listing.");
  }
  const readyAt = await versionReadyAt(id, db);
  if (!readyAt) return no("This version's final file is not filed yet.");
  const { aryeoIdTime } = await import("@/lib/readyToSend");
  const mediaAt = opts.mediaId ? aryeoIdTime(opts.mediaId) : null;
  // A person who corrected this video's "sent" said the proof on record was
  // wrong: only a delivery AFTER that correction may close it again, or the
  // next hourly check would quietly undo their correction.
  const corrected = await db.auditLog.findFirst({ where: { target: id, action: "video_delivery_corrected" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const floor = Math.max(readyAt.getTime(), mediaAt?.getTime() ?? 0, corrected?.createdAt.getTime() ?? 0);
  const occurrences = await deliveryOccurrences(listingId, db);
  if (opts.occurredAt && Number.isFinite(opts.occurredAt.getTime()) && opts.occurredAt.getTime() <= Date.now() + SKEW_MS) occurrences.unshift({ at: opts.occurredAt, source: "aryeo-event", ref: "live-signed-event" });
  const occurrence = occurrences.find((o) => o.at.getTime() >= floor);
  return occurrence ? { ok: true, occurrence, message: "Aryeo confirmed the delivery." } : no("No signed Aryeo delivery or accepted delivery text since this version was ready.");
}

/** Staff fallback checks local exact-version evidence, not provider availability.
 * Already sent versions remain repairable after a later replacement. */
export async function uploadedForDelivery(id: string, db: Db = prisma): Promise<{ ok: boolean; message: string }> {
  const cut = await loadCut(id, db);
  if (!cut) return { ok: false, message: "That video no longer exists." };
  if (cut.sentToClientAt) return { ok: true, message: "Existing delivery can be reconciled." };
  if (!(await usesAryeoDelivery(cut, db)) || !(await currentApproved(cut, db))) return { ok: false, message: "This is no longer a current approved Aryeo video." };
  const receipt = (await uploadsFor([id], db)).get(id);
  if (!receipt || receipt.listingId !== cut.project.aryeoListingId || receipt.sourceFingerprint !== sourceFingerprint(cut)) return { ok: false, message: "Mark this exact finished version as uploaded to its Aryeo listing first." };
  return { ok: true, message: "Exact upload recorded." };
}

/** `providerConfirmed`: the Aryeo proof pass is settling this version on its
 * own evidence. The flag is never trusted alone — with no upload receipt the
 * claim re-checks, inside its own locks, that a signed delivery event or an
 * accepted delivery text covers this exact version (aryeoConfirmedDelivery).
 * A person's press passes nothing and still needs Kyle's upload receipt. */
export async function claimListingDelivery(id: string, by: string | null, expectedFingerprint?: string, opts: { providerConfirmed?: boolean } = {}) {
  return prisma.$transaction(async (tx) => {
    const cut = await loadCut(id, tx);
    if (!cut) return { ok: false as const, message: "That video no longer exists." };
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${cut.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${cut.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${cut.projectId} ORDER BY id FOR UPDATE`;
    const current = await loadCut(id, tx);
    if (!current?.sentToClientAt && expectedFingerprint && sourceFingerprint(current!) !== expectedFingerprint) return { ok: false as const, message: "The finished file changed. Reload and confirm delivery of the current uploaded version." };
    const ready = await uploadedForDelivery(id, tx);
    if (!ready.ok && !(opts.providerConfirmed && (await aryeoConfirmedDelivery(id, {}, tx)).ok)) return { ok: false as const, message: ready.message };
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

/**
 * UNDO A "MARK AS UPLOADED" PRESSED BY MISTAKE (Oct 5 2026). Owner/admin only
 * (the action checks), and only on the same Eastern day it was pressed — past
 * that the receipt is history a person may have acted on, and it takes Correct
 * upload status with a reason. The original receipt stays in the ledger; an
 * appended correction row retires it (uploadsFor), so the video goes back to
 * "Ready for upload". Nothing in Aryeo is touched and nothing is sent.
 */
export async function undoUpload(id: string, expectedFingerprint: string, actor: { id: string | null; name: string }, now: Date = new Date()) {
  const { etDayKey } = await import("@/lib/datetime");
  return prisma.$transaction(async (tx) => {
    const cut = await loadCut(id, tx);
    if (!cut) return { ok: false, message: "That video no longer exists." };
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${cut.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${cut.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${cut.projectId} ORDER BY id FOR UPDATE`;
    const current = await loadCut(id, tx);
    if (current?.sentToClientAt) return { ok: false, message: "This video is already recorded as sent, so its upload can't be undone here." };
    const receipt = (await uploadsFor([id], tx)).get(id);
    if (!receipt) return { ok: true, already: true, message: "Already undone — it's back in Ready for upload." };
    if (receipt.sourceFingerprint !== expectedFingerprint) return { ok: false, message: "This video's file changed since it was marked uploaded. Reload before undoing." };
    if (etDayKey(new Date(receipt.uploadedAt)) !== etDayKey(now)) return { ok: false, message: "Undo only works on the day it was marked uploaded (ET). Ask Jordan to correct an older upload record." };
    await tx.auditLog.create({ data: { actor: actor.name.slice(0, 120), action: "video_upload_corrected", target: id,
      detail: JSON.stringify({ receiptId: receipt.id, reason: "Undone: marked uploaded by mistake", undo: true, actorId: actor.id, originalActor: receipt.actor, originalUploadedAt: receipt.uploadedAt }) } });
    return { ok: true, message: "Upload undone — it's back in Ready for upload. Nothing in Aryeo changed." };
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
