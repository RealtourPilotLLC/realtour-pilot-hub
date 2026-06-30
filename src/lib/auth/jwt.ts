import { SignJWT, jwtVerify } from "jose";

// Edge-safe session token helpers (no next/headers, no node-only APIs) so this
// module can be imported by both middleware (edge) and server code. The session
// is a stateless JWT in an httpOnly cookie, signed with the existing APP_SECRET.

export const SESSION_COOKIE = "rtp_session";
const DAYS = 7;
export const SESSION_MAX_AGE = DAYS * 24 * 60 * 60;

// In production, REQUIRE a real APP_SECRET — never fall back to a public dev key
// (that would make every session token forgeable). Dev keeps a fallback so local
// runs work without config.
if (process.env.NODE_ENV === "production" && !process.env.APP_SECRET) {
  throw new Error("APP_SECRET must be set in production (session signing key).");
}
const SECRET = new TextEncoder().encode(
  process.env.APP_SECRET || "dev-insecure-secret-change-me",
);

export type SessionPayload = {
  uid: string; // AppUser id of the logged-in person
  email: string;
  role: string; // OWNER | ADMIN | EDITOR | PHOTOGRAPHER
  name?: string;
  permissions?: string | null; // per-page overrides JSON (for edge page-gating)
  actingAs?: string; // AppUser id being previewed (owner read-only "view as")
};

export async function signSession(p: SessionPayload): Promise<string> {
  return new SignJWT({ ...p })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${DAYS}d`)
    .sign(SECRET);
}

export async function verifySession(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (!payload.uid || !payload.email) return null;
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}
