import type { ReadyVideo } from "@/lib/readyToSend";

export type UploadedTarget = { submissionId: string; fingerprint: string };
export type GroupDeliveryResult = { ok: boolean; message: string; completed: UploadedTarget[]; unconfirmed?: boolean };

export function projectDeliveryHeaders(projectId: string, attemptId: string) {
  return { "Cache-Control": "private, no-store", "X-RTP-Project-Delivery": encodeURIComponent(JSON.stringify({ projectId, attemptId })) };
}

export function confirmedProjectDeliveryResponse(response: Response, projectId: string, cuts: UploadedTarget[], attemptId: string): GroupDeliveryResult | null {
  if (!response.ok || response.redirected) return null;
  try {
    const receipt = JSON.parse(decodeURIComponent(response.headers.get("X-RTP-Project-Delivery") ?? ""));
    return receipt.projectId === projectId && receipt.attemptId === attemptId
      ? { ok: true, completed: cuts, message: "Uploaded videos marked sent." } : null;
  } catch { return null; }
}

/** Group presentation only. Membership still carries each exact uploaded file. */
export function uploadedDeliveryGroups(rows: ReadyVideo[]) {
  const groups = new Map<string, ReadyVideo[]>();
  for (const row of rows) groups.set(row.projectId, [...(groups.get(row.projectId) ?? []), row]);
  return [...groups].map(([projectId, videos]) => {
    const labels = [...new Set(videos.map((v) => v.cutLabel.replace(/\s*[—·]\s*Video\s+\d+\s+of\s+\d+.*$/i, "").replace(/\s+Reel$/i, "").trim()))];
    return { projectId, videos, title: `${videos[0].street} · ${labels.join(" / ") || "Videos"} - Not Sent`,
      targets: videos.flatMap((v) => v.uploadFingerprint ? [{ submissionId: v.submissionId, fingerprint: v.uploadFingerprint }] : []),
      overdue: videos.some((v) => v.overdue), watchHref: videos[0].reviewHref, aryeoUrl: videos[0].aryeoUrl };
  });
}

export function isUploadedTarget(value: unknown): value is UploadedTarget {
  if (!value || typeof value !== "object") return false;
  const v = value as UploadedTarget;
  return typeof v.submissionId === "string" && v.submissionId.length > 0 && v.submissionId.length <= 200
    && typeof v.fingerprint === "string" && v.fingerprint.length > 0 && v.fingerprint.length <= 5000;
}
