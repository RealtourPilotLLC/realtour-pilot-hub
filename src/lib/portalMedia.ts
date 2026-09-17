import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import type { PortalViewer } from "@/lib/portal";

// ---------------------------------------------------------------------------
// MEDIA TOKENS — how a portal <video> proves it may play ONE cut.
//
// Until Sep 16 the portal page appended `?t=<enrollment token>` to every cut
// URL, so the client's master key sat in every <video src>, every referrer
// the player sent, and any HAR file a support thread ever asked for. A media
// token is bound to a single submission and dies in six hours: leaking one
// leaks one video for an afternoon, never the portal.
//
// Shape: `<iat>.<exp>.<scope>.<sig>` where sig = HMAC-SHA256(APP_SECRET,
// "sub:<id>:<scope>:<iat>:<exp>") in base64url. The SCOPE names who it was
// minted for — the share link (e<enrollmentId>), a signed-in person's seat
// (m<membershipId>) or a staff member (s<appUserId>) — so the stream route
// can ask "is that still live?" on every request: a revoked seat, a revoked
// program, an expired or ROTATED link (iat before portalTokenIssuedAt) stops
// playing on the next Range request, not six hours later (review, Sep 17).
// The signature needs no lookup; the liveness check is one small read. The
// page mints one per cut it renders, and only for cuts the resolver already
// proved the viewer may see, which is why the token can stand alone.
// ---------------------------------------------------------------------------

const SECRET = process.env.APP_SECRET || "dev-insecure-secret-change-me";
if (process.env.NODE_ENV === "production" && !process.env.APP_SECRET) {
  throw new Error("APP_SECRET must be set in production (media token signing key).");
}

export const MEDIA_TOKEN_TTL_MS = 6 * 3600_000;

export type MediaScope =
  | { kind: "enrollment"; id: string } // the share link (TOKEN actor)
  | { kind: "membership"; id: string } // a signed-in person's seat (CLIENT actor)
  | { kind: "staff"; id: string }; // OWNER/ADMIN through the owner iframe (STAFF actor)

const KIND_CODE: Record<MediaScope["kind"], string> = { enrollment: "e", membership: "m", staff: "s" };
const CODE_KIND: Record<string, MediaScope["kind"] | undefined> = { e: "enrollment", m: "membership", s: "staff" };
const ID_RE = /^[a-z0-9]{10,40}$/i;

/** The scope a viewer's cuts are minted under — one call per render. */
export function mediaScopeOf(viewer: PortalViewer): MediaScope {
  const a = viewer.actor;
  if (a.kind === "CLIENT") return { kind: "membership", id: a.membershipId };
  if (a.kind === "STAFF") return { kind: "staff", id: a.staffUserId };
  return { kind: "enrollment", id: viewer.enrollment.id };
}

const encodeScope = (s: MediaScope) => `${KIND_CODE[s.kind]}${s.id}`;

const sign = (submissionId: string, scope: string, iat: number, exp: number) =>
  createHmac("sha256", SECRET).update(`sub:${submissionId}:${scope}:${iat}:${exp}`).digest("base64url");

export function mediaToken(submissionId: string, scope: MediaScope, ttlMs: number = MEDIA_TOKEN_TTL_MS, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const exp = Math.floor((now + ttlMs) / 1000);
  const s = encodeScope(scope);
  return `${iat}.${exp}.${s}.${sign(submissionId, s, iat, exp)}`;
}

export type MediaTokenCheck = { ok: true; scope: MediaScope; mintedAt: Date } | { ok: false };

/** Signature + expiry only (pure). ok only for a token minted for THIS
 *  submission that has not expired; the caller then asks mediaScopeLive. */
export function verifyMediaToken(submissionId: string, token: string | null | undefined, now: number = Date.now()): MediaTokenCheck {
  if (!token || !ID_RE.test(submissionId)) return { ok: false };
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false };
  const [iatRaw, expRaw, scopeRaw, sigRaw] = parts;
  if (!/^\d{1,12}$/.test(iatRaw) || !/^\d{1,12}$/.test(expRaw)) return { ok: false };
  const iat = Number(iatRaw);
  const exp = Number(expRaw);
  if (exp * 1000 < now || iat > exp) return { ok: false };
  const kind = CODE_KIND[scopeRaw.charAt(0)];
  const id = scopeRaw.slice(1);
  if (!kind || !ID_RE.test(id)) return { ok: false };
  const given = Buffer.from(sigRaw);
  const expected = Buffer.from(sign(submissionId, scopeRaw, iat, exp));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  return { ok: true, scope: { kind, id }, mintedAt: new Date(iat * 1000) };
}

/**
 * Is the seat / link / staff login this token was minted for STILL allowed
 * in? Mirrors the resolver's own rules for that path — re-read on every
 * stream request so revocation is immediate. Paused/ended programs stay
 * playable (released content is theirs); revoked, expired and rotated do not.
 */
export async function mediaScopeLive(scope: MediaScope, mintedAt: Date, now: number = Date.now()): Promise<boolean> {
  if (scope.kind === "enrollment") {
    const e = await prisma.contentEnrollment.findUnique({
      where: { id: scope.id },
      select: { portalToken: true, portalTokenIssuedAt: true, portalTokenExpiresAt: true, accessRevokedAt: true },
    });
    if (!e || !e.portalToken || e.accessRevokedAt) return false;
    if (e.portalTokenExpiresAt && e.portalTokenExpiresAt.getTime() <= now) return false;
    // Rotated since this page was rendered: the old link is dead, so are its
    // videos. (issuePortalLink on the content side does not stamp issuedAt
    // yet — a handover to W1-C — so a rotation from there survives until
    // expiry; the card's Rotate stamps it and is immediate.)
    if (e.portalTokenIssuedAt && e.portalTokenIssuedAt.getTime() > mintedAt.getTime() + 1000) return false;
    return true;
  }
  if (scope.kind === "membership") {
    const m = await prisma.clientMembership.findUnique({ where: { id: scope.id }, select: { revokedAt: true, enrollmentId: true, clientId: true, clientUserId: true } });
    if (!m || m.revokedAt) return false;
    const [e, u] = await Promise.all([
      prisma.contentEnrollment.findUnique({ where: { id: m.enrollmentId }, select: { clientId: true, accessRevokedAt: true } }),
      prisma.clientUser.findUnique({ where: { id: m.clientUserId }, select: { status: true } }),
    ]);
    return !!e && !e.accessRevokedAt && e.clientId === m.clientId && !!u && u.status !== "DISABLED";
  }
  const u = await prisma.appUser.findUnique({ where: { id: scope.id }, select: { status: true, role: true } });
  return !!u && u.status === "ACTIVE" && (u.role === "OWNER" || u.role === "ADMIN");
}

/** The submission id inside a hub cut URL (`/api/review/cut/<id>/stream`), or null. */
export function cutIdFromUrl(url: string | null | undefined): string | null {
  const m = /^\/api\/review\/cut\/([a-z0-9]{10,40})\/stream(?:\?|$)/i.exec(url ?? "");
  return m ? m[1] : null;
}

/** Rewrite a hub cut URL to carry a fresh media token for this viewer's
 *  scope; any other URL (an Aryeo CDN link) passes through untouched. Never
 *  appends the portal token. */
export function withMediaToken(url: string | null, scope: MediaScope): string | null {
  const id = cutIdFromUrl(url);
  if (!id || !url) return url;
  return `${url.split("?")[0]}?m=${encodeURIComponent(mediaToken(id, scope))}`;
}
