export type CutUploadFinishResult = { ok: boolean; message: string; held?: boolean };

/** Bytes already landed. A transport failure cannot authorize abandonment:
 * the callback or the action may have committed before its response was lost. */
export async function cutUploadFinishReceipt(action: () => Promise<CutUploadFinishResult>, timeoutMs = 20_000): Promise<CutUploadFinishResult> {
  const unknown = { ok: false, held: true, message: "Your file uploaded, but the review confirmation didn't arrive. Refresh this page to check the recorded version before uploading again. Your file and message have been kept." };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action).catch(() => unknown),
      new Promise<CutUploadFinishResult>(resolve => { timer = setTimeout(() => resolve(unknown), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
