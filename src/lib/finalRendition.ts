import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getListingMedia, type MediaVideo } from "@/lib/integrations/aryeo";
import { aryeoIdTime } from "@/lib/readyToSend";

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
  actor: { id: string | null; name: string };
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
  await prisma.finalRenditionCheck.create({ data: {
    submissionId: cut.id, projectId: cut.projectId, destination: "aryeo-listing",
    destinationMediaId: input.mediaId, destinationUrl: url, sourceFingerprint: fingerprint,
    checksJson: JSON.stringify({ checks: FINAL_CHECK_KEYS, providerTitle: video.title, providerDuration: video.duration }),
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    checkedBy: input.actor.name.slice(0, 120), checkedByUserId: input.actor.id,
  } });
  await prisma.activity.create({ data: { projectId: cut.projectId, type: "SYSTEM",
    body: `Final Aryeo video checked by ${input.actor.name}: cut v${cut.round}, provider video ${input.mediaId}. Playback, audio, frames, title, identity and access were attested. This is a staff check, not automated proof of a full watch.`.slice(0, 500) } });
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
