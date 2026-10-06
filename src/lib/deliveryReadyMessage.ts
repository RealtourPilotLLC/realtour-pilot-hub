import { createHash } from "node:crypto";
import type { ReadyVideo } from "@/lib/readyToSend";

/**
 * A recorded 1080p reason, minus the sentences that only hold for a listing job
 * ("the editor's own upload is the one to deliver"). A portal video has no such
 * fallback — its portal only takes the checked 1080p file — so printing that
 * beside it is the contradiction Kyle read (Oct 5 2026). Only whole sentences
 * are removed; the explanation of the fault is quoted as written.
 */
export function portalReason(reason: string): string {
  const parts = reason.match(/[^.!?]+[.!?]*/g)?.map((p) => p.trim()).filter(Boolean) ?? [reason];
  const kept = parts.filter((p) => !/(is the one to deliver|was delivered as normal|is the deliverable|is the file to send)/i.test(p));
  return (kept.length ? kept : parts).join(" ");
}

/** Pure message plan; readiness and exact-version eligibility come from readyToSend. */
export function deliveryReadyMessage(video: ReadyVideo, base: string) {
  const aryeo = video.deliveryDestination === "aryeo-listing";
  const uploaded = aryeo && !!video.uploaded;
  // No linked listing: the upload can't be recorded, so the one next step is
  // linking it (Oct 5 2026) — never "upload now" toward a refusal.
  const unlinked = aryeo && !uploaded && !!video.listingMissing;
  const step = !aryeo ? video.portalStep ?? null : null;
  // A portal video's stage is its next step, so a new step is a new message
  // (a fixed 1080p file, then "send the Dropbox link") and a repeat is not.
  const stage = uploaded ? "send" : unlinked ? "link-listing" : aryeo ? "upload" : `portal:${step?.action ?? "none"}`;
  const fingerprint = createHash("sha256").update(JSON.stringify([
    video.submissionId, video.uploadFingerprint, video.destinationFingerprint,
    video.file.source, video.file.fileName, stage,
  ])).digest("hex").slice(0, 32);
  const portalTitle = !step ? "Ready for portal delivery"
    : step.action === "send-outside-portal" ? "Send the Final Dropbox link"
      : step.action === "run-1080p" || step.action === "retry-1080p" ? "1080p file needed"
        : step.action === "retry-publication" ? "Portal publication"
          : "Needs a new upload";
  const title = `${uploaded ? "Uploaded — send now" : unlinked ? "Link the Aryeo listing" : aryeo ? "Ready — upload now" : portalTitle} · ${video.street}`;
  // Every portal sentence says what is true and what to press. Nothing here
  // promises a check, a notice or a release the hub does not do.
  const portalSteps = !step
    ? "This approved video goes to the client's portal. Open the delivery queue to see its next step."
    : step.action === "send-outside-portal"
      ? `${step.says} Share the file from Dropbox (Share → Copy link) and send that link.`
      : step.action === "run-1080p"
        ? `${step.says} Press Run 1080p on the delivery queue.`
        : step.action === "retry-1080p"
          ? `${step.says} Press Retry 1080p on the delivery queue.`
          : step.action === "retry-publication"
            ? `${step.says} Press Retry publication on the delivery queue if it hasn't reached the portal.`
            : step.says;
  // Aryeo's own confirmed delivery closes the row by itself (Oct 5 2026); the
  // two buttons are for when Kyle does it by hand.
  const steps = uploaded
    ? "This video is uploaded but not sent. Send the listing in Aryeo now, then confirm Mark as sent in the Hub. When Aryeo confirms the delivery, the Hub closes it by itself."
    : unlinked
      ? "This job has no Aryeo listing linked, so the upload can't be recorded yet. Open the job and press Refresh from Aryeo to link it, then upload this video."
      : aryeo
        ? "Upload this video to Aryeo now. Confirm Mark as Uploaded in the Hub, send the listing in Aryeo, then confirm Mark as sent in the Hub. When Aryeo confirms the delivery, the Hub closes it by itself."
        : portalSteps;
  // A blocked portal video has no file to hand over yet: no Download line.
  const download = !uploaded && !step?.blocked;
  return {
    dedupeKey: `delivery-ready-${fingerprint}`,
    title,
    body: steps,
    href: unlinked ? `/projects/${video.projectId}` : "/#video-review",
    slackDm: [title, `${video.clientName} · ${video.cutLabel} · version ${video.round}`,
      steps, unlinked ? `Open the job: ${base}/projects/${video.projectId}` : `Open delivery queue: ${base}/#video-review`,
      download ? `Download: ${base}${video.file.downloadHref}` : null,
      aryeo && video.aryeoUrl ? `Aryeo listing: ${video.aryeoUrl}` : null,
      step?.action === "send-outside-portal" && video.file.dropboxUrl ? `Final Dropbox file: ${video.file.dropboxUrl}` : null,
    ].filter(Boolean).join("\n"),
  };
}
