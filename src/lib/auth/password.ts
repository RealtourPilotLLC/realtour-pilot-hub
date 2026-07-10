import "server-only";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";

// Email+password auth for team members who can't (or don't want to) use Google
// sign-in — e.g. contractors on personal Gmail addresses that a Workspace-
// "Internal" OAuth app rejects. Passwords are NEVER stored in plaintext: we
// keep a scrypt hash with a per-user random salt, stored as "salt:hash" (both
// hex). scrypt is memory-hard and deliberately slow, so each guess is costly.
// No external dependency — Node's crypto is enough and edge-safe concerns
// don't apply (auth runs in the nodejs runtime).

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

// Constant-time verify. Returns false on any malformed stored value rather than
// throwing, so a corrupt row can never crash the login path.
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// A quick sanity gate before hashing — the UI enforces this too, but never
// trust the client. Returns an error string, or null when the password is OK.
export function passwordProblem(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return "That password is too long.";
  return null;
}
