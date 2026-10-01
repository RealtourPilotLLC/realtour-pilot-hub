import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { lockAdvisory } from "@/lib/dbLocks";
import { staffReceiptIntake, type StaffReceiptIntake } from "@/lib/revisionBrief";
import { STORAGE_PREFIX, projectIdFromStoragePath } from "@/lib/storage";
import { DropboxError, dropboxDownload, dropboxUpload } from "@/lib/integrations/dropbox";

const hash = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Persist the exact attachment identity before making any provider call. */
export async function staffAttachmentManifest(projectId: string, requestKey: string, file: File | null): Promise<StaffReceiptIntake["attachment"]> {
  if (!file?.size) return null;
  const sha256 = hash(new Uint8Array(await file.arrayBuffer()));
  return { originalName: file.name, mimeType: file.type || "application/octet-stream", size: file.size, sha256, storedPath: `${STORAGE_PREFIX}/projects/${projectId}/uploads/staff-${requestKey}-${sha256}.attachment`, state: "PENDING" };
}

/** A provider outcome is not a database transaction. Claim one upload, then
 * confirm bytes at its exact path. A crash/timeout is recovered by reading
 * that path, never by uploading a different file or making another copy. */
export async function finishStaffAttachment(briefId: string, file: File | null): Promise<void> {
  const bytes = file?.size ? new Uint8Array(await file.arrayBuffer()) : null;
  const incomingHash = bytes ? hash(bytes) : null;
  const work = await prisma.$transaction(async (tx) => {
    await lockAdvisory(tx, `staff-intake:${briefId}`);
    const row = await tx.revisionBrief.findUnique({ where: { id: briefId } });
    const intake = row ? staffReceiptIntake(row.itemsJson) : null;
    if (!row || row.source !== "review_room_staff" || !intake) throw new Error("The saved attachment receipt is incomplete. Ask Kyle to check it.");
    const attachment = intake.attachment;
    if (!attachment || attachment.state === "CONFIRMED") return null;
    if (projectIdFromStoragePath(attachment.storedPath) !== row.projectId) throw new Error("The saved attachment path does not belong to this job. Ask Kyle to check it.");
    const upload = attachment.state === "PENDING";
    if (upload) {
      if (!file || !bytes || incomingHash !== attachment.sha256 || bytes.length !== attachment.size || file.name !== attachment.originalName || (file.type || "application/octet-stream") !== attachment.mimeType) throw new Error(`The client's words are saved. Select the original attachment “${attachment.originalName}” to finish this request; edited form content will not replace it.`);
      attachment.state = "UPLOADING";
      const parsed = JSON.parse(row.itemsJson!); parsed.staffReceipt.intake = intake;
      await tx.revisionBrief.update({ where: { id: briefId }, data: { itemsJson: JSON.stringify(parsed) } });
    }
    return { projectId: row.projectId, submissionId: row.submissionId, attachment, upload };
  });
  if (!work) return;

  if (work.upload) {
    try {
      await dropboxUpload(work.attachment.storedPath, bytes!, { autorename: false });
    } catch {
      // A timeout can follow a successful write. The read below decides what
      // actually exists; it never treats a transport error as proof of absence.
    }
  }
  const probe = async (): Promise<"confirmed" | "missing" | "mismatch" | "unknown"> => {
    try {
      const saved = await dropboxDownload(work.attachment.storedPath);
      return saved.length === work.attachment.size && hash(saved) === work.attachment.sha256 ? "confirmed" : "mismatch";
    } catch (e) {
      return e instanceof DropboxError && e.status === 409 && /path\/not_found/i.test(e.message) ? "missing" : "unknown";
    }
  };
  let outcome = await probe();
  if (!work.upload && outcome === "missing") {
    const a = work.attachment;
    if (!file || !bytes || incomingHash !== a.sha256 || bytes.length !== a.size || file.name !== a.originalName || (file.type || "application/octet-stream") !== a.mimeType) throw new Error(`The original upload is absent. Select the same attachment “${a.originalName}” to retry; the saved request and file identity will be preserved.`);
    // A late first write can race this retry: add + no autorename refuses the
    // collision, then readback confirms the same bytes. Neither call overwrites
    // another file or makes a second destination.
    try { await dropboxUpload(a.storedPath, bytes, { autorename: false }); } catch { /* readback resolves the outcome */ }
    outcome = await probe();
  }
  let confirmed = outcome === "confirmed";
  await prisma.$transaction(async (tx) => {
    await lockAdvisory(tx, `staff-intake:${briefId}`);
    const row = await tx.revisionBrief.findUnique({ where: { id: briefId } });
    const intake = row ? staffReceiptIntake(row.itemsJson) : null;
    if (!row || !intake?.attachment) throw new Error("The saved attachment receipt was not found.");
    if (intake.attachment.state === "CONFIRMED") { confirmed = true; return; }
    const parsed = JSON.parse(row.itemsJson!);
    if (confirmed) {
      const cut = row.submissionId ? await tx.reviewSubmission.findFirst({ where: { id: row.submissionId, projectId: row.projectId }, select: { deliverableId: true } }) : null;
      if (!cut?.deliverableId) throw new Error("The saved attachment's video no longer belongs to this job. Ask Kyle to check the receipt.");
      const a = intake.attachment;
      await tx.uploadedFile.create({ data: { projectId: row.projectId, deliverableId: cut.deliverableId, originalName: a.originalName, storedPath: a.storedPath, size: a.size, mimeType: a.mimeType } });
      parsed.references = [...(parsed.references ?? []), { what: a.originalName, where: `/api/file?path=${encodeURIComponent(a.storedPath)}` }];
      a.state = "CONFIRMED";
    } else intake.attachment.state = "UNKNOWN";
    parsed.staffReceipt.intake = intake;
    await tx.revisionBrief.update({ where: { id: briefId }, data: { itemsJson: JSON.stringify(parsed) } });
  });
  if (!confirmed) throw new Error("The client's words and attachment identity are saved, but the original upload is not confirmed. Retry to check that same upload, or ask Kyle to inspect it. No replacement file or duplicate upload has been created.");
}
