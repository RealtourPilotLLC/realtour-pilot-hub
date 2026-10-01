/** A receipt identifies one exact request, never an earlier handoff stamp.
 * Only opaque IDs/hashes are kept in the recovery mirror. */
export const UPLOAD_ATTEMPT_ACTION = "upload_attempt";
export const uploadAttemptIdValid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const uploadFingerprintValid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const uploadAttemptRowId = (id: string) => `upload-attempt:${id}`;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key, v]) => v !== undefined && key !== "attemptId" && key !== "payloadFingerprint").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, canonical(v)]));
  return value;
}
export async function uploadAttemptFingerprint(value: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export type UploadAttempt = { attemptId: string; payloadFingerprint: string };
export function parseUploadAttempt(value: string | null): UploadAttempt | null {
  try {
    const candidate = JSON.parse(value ?? "null");
    return candidate && uploadAttemptIdValid(candidate.attemptId) && uploadFingerprintValid(candidate.payloadFingerprint) ? { attemptId: candidate.attemptId, payloadFingerprint: candidate.payloadFingerprint } : null;
  } catch { return null; }
}
export type UploadCommitReceipt = {
  version: 1; phase: "core_saved" | "complete" | "ended";
  payloadFingerprint: string; baseHash: string; scope: "photos" | "video" | "all"; atISO: string;
};
export function parseUploadCommitReceipt(detail: string): UploadCommitReceipt | null {
  try {
    const value = JSON.parse(detail) as UploadCommitReceipt;
    return value.version === 1 && ["core_saved", "complete", "ended"].includes(value.phase) && uploadFingerprintValid(value.payloadFingerprint) && typeof value.baseHash === "string" && ["photos", "video", "all"].includes(value.scope) && Number.isFinite(Date.parse(value.atISO)) ? value : null;
  } catch { return null; }
}
