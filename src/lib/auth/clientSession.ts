import { SignJWT, jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// THE CLIENT'S SESSION — a second cookie, deliberately not the staff one.
//
// A signed-in portal client is a ClientUser, never an AppUser: middleware,
// requireRole, canAccess and PAGES never learn that clients exist, and a
// client cookie can never open a hub page because nothing in the hub reads
// it. Mirror of src/lib/auth/jwt.ts (same signing key, same edge-safe shape)
// with its own name, its own claims and a longer life — an agent opens their
// portal a few times a month, and a 7-day cookie would mean a sign-in email
// on most visits.
//
// The JWT is stateless. Revocation is therefore NOT here: the portal resolver
// re-reads ClientMembership on every request, so a revoked seat stops working
// on the next request even though this cookie still verifies.
//
// STAY SIGNED IN (Oct 22 2026, Jordan: "Clients need an easy way to access the
// portal without having to log in every time"). The session is a ROLLING year
// on the device: the proxy re-issues the cookie on a visit once it is an hour
// old (lib/auth/clientSessionRefresh), so a client who opens the portal at
// least once a year never signs in again. The re-issue happens only for a
// person who is still ACTIVE with a live seat; it never widens anything, and
// the resolver's per-request checks (revoked seat, revoked program access, a
// DISABLED person) still refuse on the very next request, cookie or not.
// ---------------------------------------------------------------------------

export const CLIENT_COOKIE = "rtp_client";
const DAYS = 365;
export const CLIENT_SESSION_MAX_AGE = DAYS * 24 * 60 * 60;
/** A cookie older than this is re-issued on the next portal visit (sliding expiry). */
export const CLIENT_SESSION_REFRESH_AFTER_MS = 60 * 60_000;

if (process.env.NODE_ENV === "production" && !process.env.APP_SECRET) {
  throw new Error("APP_SECRET must be set in production (client session signing key).");
}
const SECRET = new TextEncoder().encode(process.env.APP_SECRET || "dev-insecure-secret-change-me");

export type ClientSessionPayload = {
  cu: string; // ClientUser id
  email: string;
};

export async function signClientSession(p: ClientSessionPayload, now: Date = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ cu: p.cu, email: p.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(iat)
    .setExpirationTime(iat + CLIENT_SESSION_MAX_AGE)
    .sign(SECRET);
}

/** The session plus when it was issued (for the sliding re-issue). Same
 *  checks as verifyClientSession. */
export async function readClientSession(token: string | undefined | null): Promise<(ClientSessionPayload & { issuedAt: Date | null }) | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (typeof payload.cu !== "string" || typeof payload.email !== "string") return null;
    return { cu: payload.cu, email: payload.email, issuedAt: typeof payload.iat === "number" ? new Date(payload.iat * 1000) : null };
  } catch {
    return null;
  }
}

/** Due for a re-issue: issued more than CLIENT_SESSION_REFRESH_AFTER_MS ago (or with no issue time). */
export function clientSessionDue(issuedAt: Date | null, now: Date = new Date()): boolean {
  return !issuedAt || now.getTime() - issuedAt.getTime() >= CLIENT_SESSION_REFRESH_AFTER_MS;
}

export async function verifyClientSession(token: string | undefined | null): Promise<ClientSessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (typeof payload.cu !== "string" || typeof payload.email !== "string") return null;
    // A staff session token presented on this cookie carries `uid`, not `cu`,
    // so the check above already rejects it — the two cookies cannot be
    // swapped even though they share a key.
    return { cu: payload.cu, email: payload.email };
  } catch {
    return null;
  }
}

/** Cookie attributes, shared by the auth route (set) and sign-out (clear). */
export const clientCookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  // Site-wide, not "/portal": the cut stream (/api/review/cut/…) and the
  // brand-kit upload (/api/portal/upload) authenticate a signed-in client by
  // this cookie, and a path-scoped cookie would never reach them.
  path: "/",
  maxAge,
});
