import { boundedWait } from "@/lib/boundedWait";
import { confirmedUploadResponse } from "@/lib/uploadReceiptResponse";

export type UploadRecordResult = { ok: boolean; message: string; unconfirmed?: boolean; sent?: boolean };

// AbortSignal.timeout is unavailable in some browsers. Own the timer so those
// browsers submit the request too, and include body parsing in the same bound.
async function requestReceipt(url: string, init: RequestInit, submissionId: string, fingerprint: string, timeout: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let stage = "request", status: number | undefined;
  try {
    return await boundedWait((async () => {
      const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { Accept: "application/json", ...init.headers } });
      stage = "response"; status = response.status;
      if (response.redirected) throw new Error("Upload response redirected");
      const receipt = confirmedUploadResponse(response, submissionId, fingerprint);
      if (receipt) return { ...receipt, recorded: true };
      stage = "body";
      return response.json();
    })(), timeout);
  } catch (error) {
    console.warn("video_upload_response_unconfirmed", { method: init.method ?? "GET", stage, status,
      reason: error instanceof Error ? error.name : "unknown" });
    throw error;
  } finally { clearTimeout(timer); }
}

/** A lost POST response does not mean the write failed. Recover by reading the
 * exact receipt; never replay a mutation automatically or infer from downloads. */
async function savedReceipt(submissionId: string, fingerprint: string): Promise<UploadRecordResult | null> {
  try {
    const query = new URLSearchParams({ submissionId, fingerprint });
    const result = await requestReceipt(`/api/ops/video-upload?${query}`, {}, submissionId, fingerprint, 5_000);
    return result?.ok === true && result.recorded === true && typeof result.message === "string"
      ? { ok: true, message: result.message, sent: result.sent === true } : null;
  } catch { return null; }
}

export async function recordUploadRequest(submissionId: string, fingerprint: string, recoverExisting = false): Promise<UploadRecordResult> {
  if (recoverExisting) {
    const receipt = await savedReceipt(submissionId, fingerprint);
    if (receipt) return receipt;
  }
  try {
    const result = await requestReceipt("/api/ops/video-upload", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submissionId, fingerprint }),
    }, submissionId, fingerprint, 8_000);
    if (!result || typeof result.ok !== "boolean" || typeof result.message !== "string" || result.unconfirmed) throw new Error("Unconfirmed upload response");
    return result;
  } catch {
    const receipt = await savedReceipt(submissionId, fingerprint);
    if (receipt) return receipt;
    return { ok: false, unconfirmed: true, message: "Could not confirm the upload record." };
  }
}
