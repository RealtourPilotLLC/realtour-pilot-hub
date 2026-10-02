import type { SentResult } from "@/lib/readyToSend";
export async function recordDeliveryRequest(submissionId: string, notice?: string, fingerprint?: string): Promise<SentResult> {
  const response = await fetch("/api/ops/video-sent", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ submissionId, notice, fingerprint }), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (result.unconfirmed) throw new Error("Unconfirmed delivery record");
  return result;
}
