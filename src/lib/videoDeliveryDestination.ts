import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentApproved, loadCut, sourceFingerprint } from "@/lib/finalRendition";
import { videoStyleFor } from "@/lib/videoStyles";
import { createHash } from "node:crypto";

type Cut = NonNullable<Awaited<ReturnType<typeof loadCut>>>;
type Db = Prisma.TransactionClient;
export type VideoDeliveryDestination = "client-portal" | "aryeo-listing";
/** A routing choice binds the video version and listing, while the separate
 * upload receipt binds the final bytes. Finishing must not reset a choice. */
export const destinationFingerprint = (cut: Cut) => createHash("sha256").update(JSON.stringify([cut.id, cut.projectId, cut.round, cut.deliverableId, cut.slot, cut.project.aryeoListingId])).digest("hex");
const receiptId = (cut: Cut) => `video-destination:${cut.id}:${destinationFingerprint(cut)}`;

export function canChooseAryeo(cut: Cut): boolean {
  return !!cut.project.contentMonthId && cut.kind === "video"
    && videoStyleFor(cut.deliverable ?? {}, { monthly: true }).key === "personal_branding";
}

/** The existing indexed audit ledger stores the staff choice for this exact
 * video version/listing. A replacement version or changed listing cannot inherit it. */
export async function usesAryeoDelivery(cut: Cut, db: Db = prisma): Promise<boolean> {
  if (!cut.project.contentMonthId) return true;
  // Once sent, repairs must keep the recorded channel even if a path/listing
  // subsequently changes. Only choices made before that delivery count.
  if (cut.sentToClientAt) {
    const receipt = await db.auditLog.findFirst({ where: { action: "video_delivery_destination", target: cut.id, createdAt: { lte: cut.sentToClientAt } }, orderBy: { createdAt: "desc" } });
    if (!receipt) return false;
    const data = JSON.parse(receipt.detail);
    return data.submissionId === cut.id && data.destination === "aryeo-listing" && !!data.destinationFingerprint && !!data.listingId;
  }
  if (!canChooseAryeo(cut) || !cut.project.aryeoListingId) return false;
  const receipt = await db.auditLog.findUnique({ where: { id: receiptId(cut) } });
  if (!receipt) return false;
  const data = JSON.parse(receipt.detail);
  return receipt.action === "video_delivery_destination" && receipt.target === cut.id
    && data.destination === "aryeo-listing" && data.submissionId === cut.id
    && data.destinationFingerprint === destinationFingerprint(cut) && data.listingId === cut.project.aryeoListingId;
}

export async function chooseAryeoDelivery(id: string, fingerprint: string, actor: { id: string; name: string }) {
  return prisma.$transaction(async (tx) => {
    const initial = await loadCut(id, tx);
    if (!initial) return { ok: false, message: "That video no longer exists." };
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${initial.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${initial.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${initial.projectId} ORDER BY id FOR UPDATE`;
    const cut = await loadCut(id, tx);
    if (!cut || !canChooseAryeo(cut) || !(await currentApproved(cut, tx))) return { ok: false, message: "Choose the current approved branding video before changing its destination." };
    if (!cut.project.aryeoListingId) return { ok: false, message: "Link an Aryeo listing to this project first, then choose Upload to Aryeo instead." };
    if (!fingerprint || destinationFingerprint(cut) !== fingerprint) return { ok: false, message: "The video version or listing changed. Reload before choosing its destination." };
    if (await usesAryeoDelivery(cut, tx)) return { ok: true, fingerprint, message: "Aryeo destination already saved for this version." };
    if (cut.sentToClientAt) return { ok: false, message: "This version already has a delivery record. Its destination history is preserved." };
    await tx.auditLog.create({ data: { id: receiptId(cut), actor: actor.name.slice(0, 120), action: "video_delivery_destination", target: id,
      detail: JSON.stringify({ submissionId: id, destinationFingerprint: fingerprint, sourceFingerprint: sourceFingerprint(cut), listingId: cut.project.aryeoListingId,
        destination: "aryeo-listing", actorId: actor.id, chosenAt: new Date().toISOString() }) } });
    await tx.activity.create({ data: { projectId: cut.projectId, type: "SYSTEM", body: `Branding video v${cut.round}: ${actor.name} chose Aryeo instead of portal delivery. The final Dropbox backup is retained. No upload or client message was sent.`.slice(0, 500) } });
    return { ok: true, fingerprint, message: "Aryeo selected. Upload this finished version there, then mark it uploaded." };
  }, { isolationLevel: "Serializable" });
}
