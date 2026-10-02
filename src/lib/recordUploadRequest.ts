import { boundedWait } from "@/lib/boundedWait";

export type UploadRecordResult = { ok: boolean; message: string; unconfirmed?: boolean; sent?: boolean };

/** A lost POST response does not mean the write failed. Recover by reading the
 * exact receipt; never replay a mutation automatically or infer from downloads. */
async function savedReceipt(submissionId: string, fingerprint: string): Promise<UploadRecordResult | null> {
  try {
    const query = new URLSearchParams({ submissionId, fingerprint });
    const result = await boundedWait((async () => {
      const response = await fetch(`/api/ops/video-upload?${query}`, {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok || response.redirected) return null;
      return response.json();
    })(), 5_000);
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
    const result = await boundedWait((async () => {
      const response = await fetch("/api/ops/video-upload", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId, fingerprint }), signal: AbortSignal.timeout(8_000),
      });
      if (response.redirected) throw new Error("Upload response redirected");
      return response.json();
    })(), 8_000);
    if (!result || typeof result.ok !== "boolean" || typeof result.message !== "string" || result.unconfirmed) throw new Error("Unconfirmed upload response");
    return result;
  } catch {
    const receipt = await savedReceipt(submissionId, fingerprint);
    if (receipt) return receipt;
    return { ok: false, unconfirmed: true, message: "Could not confirm the upload record." };
  }
}
