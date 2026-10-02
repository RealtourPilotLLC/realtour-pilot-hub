export async function recordUploadRequest(submissionId: string, fingerprint: string): Promise<{ ok: boolean; message: string; unconfirmed?: boolean }> {
  const response = await fetch("/api/ops/video-upload", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ submissionId, fingerprint }), signal: AbortSignal.timeout(15_000),
  });
  return response.json();
}
