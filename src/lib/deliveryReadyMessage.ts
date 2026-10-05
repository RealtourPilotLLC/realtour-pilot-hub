import { createHash } from "node:crypto";
import type { ReadyVideo } from "@/lib/readyToSend";

/** Pure message plan; readiness and exact-version eligibility come from readyToSend. */
export function deliveryReadyMessage(video: ReadyVideo, base: string) {
  const aryeo = video.deliveryDestination === "aryeo-listing";
  const uploaded = aryeo && !!video.uploaded;
  const stage = uploaded ? "send" : aryeo ? "upload" : "portal";
  const fingerprint = createHash("sha256").update(JSON.stringify([
    video.submissionId, video.uploadFingerprint, video.destinationFingerprint,
    video.file.source, video.file.fileName, stage,
  ])).digest("hex").slice(0, 32);
  const title = `${uploaded ? "Uploaded — send now" : aryeo ? "Ready — upload now" : "Ready for portal delivery"} · ${video.street}`;
  const steps = uploaded
    ? "This video is uploaded but not sent. Send the listing in Aryeo now, then confirm Mark as sent in the Hub. The delivery webhook can also confirm sending."
    : aryeo
      ? "Upload this video to Aryeo now. Confirm Mark as Uploaded in the Hub, send the listing in Aryeo, then confirm Mark as sent in the Hub. The delivery webhook can also confirm sending."
      : "This approved video is ready for the portal delivery checks. Complete the final check and confirm delivery in the Hub as soon as possible. Keep the approved destination and client access gates in place.";
  return {
    dedupeKey: `delivery-ready-${fingerprint}`,
    title,
    body: steps,
    href: "/#video-review",
    slackDm: [title, `${video.clientName} · ${video.cutLabel} · version ${video.round}`,
      steps, `Open delivery queue: ${base}/#video-review`,
      !uploaded ? `Download: ${base}${video.file.downloadHref}` : null,
      aryeo && video.aryeoUrl ? `Aryeo listing: ${video.aryeoUrl}` : null,
    ].filter(Boolean).join("\n"),
  };
}
