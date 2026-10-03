import "server-only";
import { prisma } from "@/lib/prisma";
import { loadCut, sourceFingerprint } from "@/lib/finalRendition";
import { recordedListingDeliveryAt, uploadedForDelivery, uploadsFor } from "@/lib/deliveryUploads";
import { markVideoSent } from "@/lib/readyToSend";
import type { GroupDeliveryResult, UploadedTarget } from "@/lib/uploadedDeliveryGroups";
import { usesAryeoDelivery } from "@/lib/videoDeliveryDestination";

/** Validate the whole visible snapshot before recording any delivery. A stale
 * group cannot silently include new uploads or videos belonging to another job. */
export async function markUploadedGroupSent(projectId: string, targets: UploadedTarget[], by: string): Promise<GroupDeliveryResult> {
  const completed: UploadedTarget[] = [];
  if (!targets.length || targets.length > 100 || new Set(targets.map(v => v.submissionId)).size !== targets.length) {
    return { ok: false, completed, message: "Reload this project's uploaded videos before marking them sent." };
  }
  const refusal = await prisma.$transaction(async (tx) => {
    const receipts = await uploadsFor(targets.map(v => v.submissionId), tx);
    let listingId: string | null = null;
    for (const target of targets) {
      const cut = await loadCut(target.submissionId, tx), receipt = receipts.get(target.submissionId);
      if (!cut || cut.projectId !== projectId || !(await usesAryeoDelivery(cut, tx)) || !cut.project.aryeoListingId
        || (listingId && listingId !== cut.project.aryeoListingId) || !receipt || receipt.sourceFingerprint !== target.fingerprint
        || receipt.listingId !== cut.project.aryeoListingId || (!cut.sentToClientAt && sourceFingerprint(cut) !== target.fingerprint)) {
        return "An uploaded file or destination changed. Reload this project before recording delivery.";
      }
      listingId = cut.project.aryeoListingId;
      const ready = await uploadedForDelivery(cut.id, tx);
      if (!ready.ok) return ready.message;
    }
    return null;
  }, { isolationLevel: "RepeatableRead" });
  if (refusal) return { ok: false, completed, message: refusal };
  for (const target of targets) {
    try {
      const result = await markVideoSent(target.submissionId, by, { expectedFingerprint: target.fingerprint });
      if (!result.ok || result.incomplete?.length) return { ok: false, completed, message: result.message };
      completed.push(target);
    } catch {
      return { ok: false, completed, unconfirmed: true, message: "Some delivery records could not be confirmed. Try Mark as sent again; existing records and attribution will be preserved." };
    }
  }
  return { ok: true, completed, message: "Uploaded videos marked sent." };
}

/** Staff has identified the exact uploaded versions. A recorded authenticated
 * delivery event AFTER that acknowledgement plus an authenticated Aryeo read
 * of DELIVERED settles those versions, without pretending to prove file hashes.
 * Old deliveries, unsigned events and newer replacements cannot close them. */
export async function acknowledgedDeliveryTargets(projectId: string, listing: { id?: string; delivery_status?: string | null } | null) {
  if (!listing?.id || listing.delivery_status?.toUpperCase() !== "DELIVERED") return [];
  const eventAt = await recordedListingDeliveryAt(listing.id);
  if (!eventAt || eventAt.getTime() > Date.now()) return [];
  const rows = await prisma.reviewSubmission.findMany({ where: { projectId, status: "APPROVED", sentToClientAt: null }, select: { id: true } });
  const receipts = await uploadsFor(rows.map(v => v.id));
  const targets: UploadedTarget[] = [];
  for (const row of rows) {
    const receipt = receipts.get(row.id);
    if (!receipt || receipt.listingId !== listing.id || Date.parse(receipt.uploadedAt) > eventAt.getTime()) continue;
    const cut = await loadCut(row.id);
    if (!cut || !(await usesAryeoDelivery(cut)) || cut.project.aryeoListingId !== listing.id || sourceFingerprint(cut) !== receipt.sourceFingerprint
      || !(await uploadedForDelivery(row.id)).ok) continue;
    targets.push({ submissionId: row.id, fingerprint: receipt.sourceFingerprint });
  }
  return targets;
}
