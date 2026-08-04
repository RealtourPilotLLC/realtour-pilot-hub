import "server-only";

import crypto from "crypto";

// AES-256-GCM encryption for secrets at rest. The master key comes from the
// APP_SECRET env var; in production set a strong random 32+ char value (e.g. on
// Vercel). For local dev we fall back to a stable dev key so the app runs, with
// a console warning. Encrypted blobs are stored as: ivHex:tagHex:cipherHex.

const DEV_FALLBACK = "rtp-dev-only-secret-change-me-please-32xx";

function masterKey(): Buffer {
  const secret = process.env.APP_SECRET || DEV_FALLBACK;
  // Require a real key on ANY deployed environment (Vercel sets VERCEL), not only
  // NODE_ENV=production — otherwise a preview/staging deploy would silently
  // encrypt real integration tokens with the committed dev fallback key.
  if (!process.env.APP_SECRET && (process.env.NODE_ENV === "production" || process.env.VERCEL)) {
    throw new Error("APP_SECRET must be set on any deployed environment to encrypt secrets.");
  }
  // Derive a 32-byte key from whatever length secret is provided.
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(blob: string): string {
  const [ivHex, tagHex, dataHex] = blob.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed secret blob");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

// Mask a secret for display, e.g. "sk_live_…3a9f".
export function maskSecret(plain: string): string {
  if (plain.length <= 8) return "••••";
  return `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}
