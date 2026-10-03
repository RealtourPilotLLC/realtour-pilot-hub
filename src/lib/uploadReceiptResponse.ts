/** A committed receipt can be recognised as soon as response headers arrive.
 * The body remains available for older clients and detailed refusal messages. */
export function uploadReceiptHeaders(submissionId: string, fingerprint: string, sent = false) {
  return {
    "Cache-Control": "private, no-store",
    "X-RTP-Upload-Receipt": encodeURIComponent(JSON.stringify({ submissionId, fingerprint, sent })),
  };
}

export function confirmedUploadResponse(response: Response, submissionId: string, fingerprint: string) {
  if (!response.ok || response.redirected) return null;
  try {
    const value = JSON.parse(decodeURIComponent(response.headers.get("X-RTP-Upload-Receipt") ?? ""));
    return value.submissionId === submissionId && value.fingerprint === fingerprint && typeof value.sent === "boolean"
      ? { ok: true, sent: value.sent, message: "Uploaded version recorded." } : null;
  } catch { return null; }
}
