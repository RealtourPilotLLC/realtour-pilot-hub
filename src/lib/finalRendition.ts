import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getListingMedia, type MediaVideo } from "@/lib/integrations/aryeo";
import { aryeoIdTime } from "@/lib/readyToSend";
import { currentMonthlyCut, loadMonthlyCut, monthlyCutStamp, monthlyFinalSnapshot, monthlyOwnerAccess, lockMonthlyFinalAccess } from "@/lib/monthlyFinal";
import { backupReceiptData, digest } from "@/lib/finalDropbox";

export const FINAL_CHECK_KEYS = ["identity", "playback", "audio", "frames", "title", "access"] as const;
export type FinalCheckKey = (typeof FINAL_CHECK_KEYS)[number];

type Cut = NonNullable<Awaited<ReturnType<typeof loadCut>>>;

async function loadCut(submissionId: string) {
  return prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true, projectId: true, status: true, deliverableId: true, slot: true, round: true,
      assetPath: true, finalPath: true, blobUrl: true, contentHash: true, sourceRev: true,
      sentToClientAt: true, decidedAt: true,
      project: { select: { aryeoListingId: true, status: true, contentMonthId: true } },
      topazJob: { select: { id: true, state: true, finalPath: true, savedAt: true } },
    },
  });
}

/** The identity of the source file Kyle is taking to Aryeo. A render that
 * lands later, or a changed path/hash, invalidates an earlier attestation. */
function sourceFingerprint(cut: Cut): string | null {
  const job = cut.topazJob;
  if (job && !["done", "failed", "cancelled", "skipped"].includes(job.state)) return null;
  const source = job?.finalPath && job.savedAt
    ? ["topaz", job.id, job.finalPath, job.savedAt.toISOString()]
    : cut.blobUrl ? ["hub", cut.blobUrl, cut.contentHash, cut.sourceRev]
    : cut.assetPath ? ["dropbox", cut.assetPath, cut.contentHash, cut.sourceRev]
    : cut.finalPath ? ["final", cut.finalPath, cut.contentHash, cut.sourceRev] : null;
  return source ? createHash("sha256").update(JSON.stringify([cut.id, cut.round, source])).digest("hex") : null;
}

async function currentApproved(cut: Cut): Promise<boolean> {
  if (cut.status !== "APPROVED" || cut.project.status === "CANCELLED") return false;
  if (cut.deliverableId) {
    const latest = await prisma.reviewSubmission.findFirst({
      where: { projectId: cut.projectId, deliverableId: cut.deliverableId, slot: cut.slot,
        withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
      orderBy: [{ round: "desc" }, { createdAt: "desc" }], select: { id: true },
    });
    const output = await prisma.deliverableOutput.findFirst({
      where: { projectId: cut.projectId, deliverableId: cut.deliverableId, slot: cut.slot, waivedAt: null, removedFromOrderAt: null },
      select: { id: true, currentSubmissionId: true, approvedSubmissionId: true },
    });
    return latest?.id === cut.id && !!output
      && (!output.currentSubmissionId || output.currentSubmissionId === cut.id)
      && (!output.approvedSubmissionId || output.approvedSubmissionId === cut.id);
  }
  // Legacy folder cuts are keyed by file path. Do not pretend two distinct
  // paths on one job are the same video or let an older round certify a newer.
  if (!cut.assetPath) return false;
  const latest = await prisma.reviewSubmission.findFirst({
    where: { projectId: cut.projectId, deliverableId: null, assetPath: cut.assetPath,
      withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
    orderBy: [{ round: "desc" }, { createdAt: "desc" }], select: { id: true },
  });
  return latest?.id === cut.id;
}

function clientFile(v: MediaVideo): string | null {
  const value = v.playback ?? v.download;
  if (!value) return null;
  try { return new URL(value).protocol === "https:" ? value : null; } catch { return null; }
}

function providerFileIsNewEnough(cut: Cut, mediaId: string | null): boolean {
  const created = aryeoIdTime(mediaId);
  const ready = cut.topazJob?.finalPath && cut.topazJob.savedAt ? cut.topazJob.savedAt : cut.decidedAt;
  return !!created && !!ready && created.getTime() >= ready.getTime();
}

export type ListingChoice = { id: string; title: string; url: string; duration: number | null };

export async function listingChoices(submissionId: string): Promise<{ ok: boolean; message: string; choices: ListingChoice[] }> {
  const cut = await loadCut(submissionId);
  if (!cut || !(await currentApproved(cut)) || !sourceFingerprint(cut)) return { ok: false, message: "This is no longer a current approved file ready for delivery.", choices: [] };
  if (cut.project.contentMonthId) return { ok: false, message: "This monthly video uses the client portal; its delivery check is separate.", choices: [] };
  const listingId = cut.project.aryeoListingId;
  if (!listingId) return { ok: false, message: "This job has no Aryeo listing to check.", choices: [] };
  const media = await getListingMedia(listingId);
  if (!media) return { ok: false, message: "Aryeo could not be read. Try again before recording delivery.", choices: [] };
  const choices = media.videos.filter((v) => v.id && clientFile(v) && providerFileIsNewEnough(cut, v.id))
    .map((v) => ({ id: v.id!, title: v.title || "Untitled Aryeo video", url: clientFile(v)!, duration: v.duration }));
  return { ok: true, message: choices.length ? "Choose the video you checked on the client listing." : "No verifiable new video is on this listing yet. Older videos cannot certify this cut.", choices };
}

export async function recordListingCheck(input: {
  submissionId: string; mediaId: string; checks: FinalCheckKey[]; metadata?: { duration?: number; width?: number; height?: number } | null;
  actor: { id: string | null; name: string }; attemptId?: string;
}): Promise<{ ok: boolean; message: string }> {
  const cut = await loadCut(input.submissionId);
  if (!cut || !(await currentApproved(cut))) return { ok: false, message: "That approved version changed. Reload before checking it." };
  if (cut.sentToClientAt) return { ok: false, message: "This cut is already recorded as sent; its verification history cannot be backdated here." };
  if (cut.project.contentMonthId) return { ok: false, message: "Use the portal verification path for a monthly video." };
  const fingerprint = sourceFingerprint(cut);
  if (!fingerprint) return { ok: false, message: "The final file is still being prepared or is unavailable." };
  if (!FINAL_CHECK_KEYS.every((k) => input.checks.includes(k))) return { ok: false, message: "Check the exact video, playback, audio, first and last frames, title, and client access before recording this pass." };
  if (!cut.project.aryeoListingId) return { ok: false, message: "This job has no Aryeo listing." };
  const media = await getListingMedia(cut.project.aryeoListingId);
  if (!media) return { ok: false, message: "Aryeo could not be read. The check was not saved." };
  const video = media.videos.find((v) => v.id === input.mediaId && clientFile(v) && providerFileIsNewEnough(cut, v.id));
  if (!video) return { ok: false, message: "That video is absent, unplayable, or older than the approved file on this listing." };
  const otherCheck = await prisma.finalRenditionCheck.findFirst({ where: { projectId: cut.projectId, destination: "aryeo-listing", destinationMediaId: input.mediaId, submissionId: { not: cut.id } }, select: { submissionId: true } });
  if (otherCheck) return { ok: false, message: "Another cut on this job already claimed this Aryeo video. Reconcile the file identity before marking delivery." };
  const url = clientFile(video)!;
  await prisma.$transaction(async (tx) => {
    await tx.finalRenditionCheck.create({ data: {
      ...(input.attemptId ? { id: `final-check:${input.attemptId}` } : {}),
      submissionId: cut.id, projectId: cut.projectId, destination: "aryeo-listing",
      destinationMediaId: input.mediaId, destinationUrl: url, sourceFingerprint: fingerprint,
      checksJson: JSON.stringify({ checks: FINAL_CHECK_KEYS, providerTitle: video.title, providerDuration: video.duration, attemptFingerprint: finalCheckAttemptFingerprint(input) }),
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      checkedBy: input.actor.name.slice(0, 120), checkedByUserId: input.actor.id,
    } });
    await tx.activity.create({ data: { projectId: cut.projectId, type: "SYSTEM",
      body: `Final Aryeo video checked by ${input.actor.name}: cut v${cut.round}, provider video ${input.mediaId}. Playback, audio, frames, title, identity and access were attested. This is a staff check, not automated proof of a full watch.`.slice(0, 500) } });
  });
  return { ok: true, message: "Final-file check recorded for this exact version and Aryeo video. You can now record delivery once the listing is delivered." };
}

/** Manual delivery only. The automated Aryeo proof pass records its own
 * independent evidence and may truthfully settle a video even without this
 * optional historical human check. */
export async function manualListingCheckReady(submissionId: string): Promise<{ ok: boolean; message: string }> {
  const cut = await loadCut(submissionId);
  if (!cut) return { ok: false, message: "That cut no longer exists." };
  // A repeat press repairs records for a send already stamped; it must still
  // work after a later replacement cut becomes current.
  if (cut.sentToClientAt) return { ok: true, message: "Already recorded as sent." };
  if (!(await currentApproved(cut))) return { ok: false, message: "That approved cut is no longer current." };
  const fingerprint = sourceFingerprint(cut);
  if (!fingerprint) return { ok: false, message: "The final rendition is not ready." };
  const check = await prisma.finalRenditionCheck.findFirst({ where: { submissionId, destination: "aryeo-listing", sourceFingerprint: fingerprint }, orderBy: { checkedAt: "desc" } });
  if (!check) return { ok: false, message: "Check the actual Aryeo video on the listing before marking this cut delivered." };
  if (!cut.project.aryeoListingId) return { ok: false, message: "This job has no Aryeo listing." };
  const media = await getListingMedia(cut.project.aryeoListingId);
  if (!media) return { ok: false, message: "Aryeo could not be rechecked. Delivery was not recorded; try again." };
  const same = media.videos.find((v) => v.id === check.destinationMediaId && clientFile(v) === check.destinationUrl && providerFileIsNewEnough(cut, v.id));
  if (!same) return { ok: false, message: "The Aryeo video changed since the final check. Check the client-visible file again." };
  if (media.deliveryStatus?.toUpperCase() !== "DELIVERED") return { ok: false, message: "Aryeo does not show this listing as delivered yet. Finish delivery there, then record it here." };
  return { ok: true, message: "Final file and delivered listing confirmed." };
}


export type FinalCheckInput = Parameters<typeof recordListingCheck>[0];
export const finalCheckAttemptFingerprint = (input: FinalCheckInput) => digest([input.submissionId, input.mediaId, [...input.checks].sort(), input.metadata ?? null, input.actor.id]);
export const validFinalCheckAttempt = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);

export async function finalChoices(submissionId: string) {
  const cut = await loadCut(submissionId);
  if (!cut?.project.contentMonthId) return listingChoices(submissionId);
  const s = await monthlyFinalSnapshot(submissionId);
  return s.ok ? { ok: true, message: "Play the exact portal file. Its final Dropbox backup and this program’s owner access were read now. These ticks are your staff attestation.", choices: [{ id: s.fingerprint, title: s.fileName, url: s.previewUrl, duration: null }] } : { ok: false, message: s.message, choices: [] };
}

export async function finalCheckReceipt(submissionId: string, attemptId: string, actorId: string | null, attemptFingerprint?: string) {
  if (!validFinalCheckAttempt(attemptId) || !actorId) return { ok: false, message: "That final-check receipt is unavailable." };
  const row = await prisma.finalRenditionCheck.findUnique({ where: { id: `final-check:${attemptId}` } });
  if (!row || row.submissionId !== submissionId || row.checkedByUserId !== actorId) return { ok: false, message: "The earlier check is not confirmed yet. Keep this attempt held; ask office staff to inspect its check history before any new save." };
  if (attemptFingerprint) {
    let value: unknown;
    try { value = JSON.parse(row.checksJson); } catch { return { ok: false, message: "That receipt could not be verified." }; }
    if (!value || typeof value !== "object" || (value as { attemptFingerprint?: unknown }).attemptFingerprint !== attemptFingerprint) return { ok: false, message: "That receipt belongs to a different check." };
  }
  return { ok: true, message: "This exact final-file check was recorded. Its saved evidence will be rechecked before delivery." };
}

export async function recordFinalCheck(input: FinalCheckInput): Promise<{ ok: boolean; message: string }> {
  if (!input.attemptId || !validFinalCheckAttempt(input.attemptId) || !input.actor.id) return { ok: false, message: "Prepare a valid final-check attempt before saving." };
  const previous = await prisma.finalRenditionCheck.findUnique({ where: { id: `final-check:${input.attemptId}` }, select: { id: true } });
  if (previous) return finalCheckReceipt(input.submissionId, input.attemptId, input.actor.id, finalCheckAttemptFingerprint(input));
  const cut = await loadCut(input.submissionId);
  if (!cut?.project.contentMonthId) return recordListingCheck(input);
  if (!FINAL_CHECK_KEYS.every((k) => input.checks.includes(k))) return { ok: false, message: "Check identity, playback, audio, frames, title and access before recording this pass." };
  const s = await monthlyFinalSnapshot(input.submissionId);
  if (!s.ok) return s;
  if (s.cut.sentToClientAt) return { ok: false, message: "This cut is already recorded as delivered. Its check history cannot be backdated here." };
  if (input.mediaId !== s.fingerprint) return { ok: false, message: "The final bytes, version or client access changed since you opened the check. Read and inspect the current file again." };
  // All external reads happen before the transaction. Parent/child locks fence
  // a concurrently entered replacement; serializable reads fence seat/settings drift.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${s.cut.projectId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${s.cut.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE "projectId" = ${s.cut.projectId} ORDER BY id FOR UPDATE`;
    await lockMonthlyFinalAccess(tx, s.cut.project.contentMonthId!);
    const current = await loadMonthlyCut(s.cut.id, tx);
    const access = (await monthlyOwnerAccess([s.cut.project.contentMonthId!], tx)).get(s.cut.project.contentMonthId!);
    if (!current || current.sentToClientAt || monthlyCutStamp(current) !== monthlyCutStamp(s.cut) || !(await currentMonthlyCut(current, tx)) || !access?.ok || access.stamp !== s.access.stamp) return { ok: false, message: "The version or client access changed. Check the current final file again." };
    if (s.file.kind === "original") await tx.auditLog.upsert({ where: { id: backupReceiptData(s.cut, s.backup).id }, create: backupReceiptData(s.cut, s.backup), update: {} });
    await tx.finalRenditionCheck.create({ data: { id: `final-check:${input.attemptId}`, submissionId: s.cut.id, projectId: s.cut.projectId,
      destination: "client-portal", destinationMediaId: s.mediaId, destinationUrl: s.previewUrl, sourceFingerprint: s.fingerprint,
      checksJson: JSON.stringify({ checks: FINAL_CHECK_KEYS, attemptFingerprint: finalCheckAttemptFingerprint(input) }), metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      checkedBy: input.actor.name.slice(0, 120), checkedByUserId: input.actor.id } });
    await tx.activity.create({ data: { projectId: s.cut.projectId, type: "SYSTEM", body: `Final portal video checked by ${input.actor.name}: cut v${s.cut.round}, exact final Dropbox backup and owner access confirmed. Playback, audio, frames, title and identity were attested; this is not an automated full watch or client notification.`.slice(0, 500) } });
    return { ok: true, message: "Exact portal final-file check recorded with final Dropbox backup and owner access. Notification and client approval remain separate." };
  }, { isolationLevel: "Serializable" });
}

/** Existing listing rules remain unchanged; monthly delivery uses portal + final Dropbox. */
export async function manualFinalCheckReady(submissionId: string): Promise<{ ok: boolean; message: string }> {
  const cut = await loadCut(submissionId);
  if (!cut) return { ok: false, message: "That cut no longer exists." };
  if (cut.sentToClientAt) return { ok: true, message: "Already recorded as sent." };
  if (!cut.project.contentMonthId) return manualListingCheckReady(submissionId);
  const s = await monthlyFinalSnapshot(submissionId);
  if (!s.ok) return s;
  const check = await prisma.finalRenditionCheck.findFirst({ where: { submissionId, destination: "client-portal", sourceFingerprint: s.fingerprint, destinationMediaId: s.mediaId }, orderBy: { checkedAt: "desc" } });
  return check ? { ok: true, message: "The exact portal final file, final Dropbox backup and program owner access are confirmed." } : { ok: false, message: "Check the exact portal file and final Dropbox backup before recording monthly delivery." };
}
