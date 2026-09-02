/**
 * The ONE list of routes a person can open without a session.
 *
 * Two places must agree about this, and when they drifted apart the whole staff
 * sidebar — Finance, People, Connections, Ask the Hub — rendered on real
 * clients' portal pages (Sep 2 2026 audit):
 *   · src/middleware.ts   decides whether to demand a session
 *   · src/components/Shell.tsx  decides whether to draw the app chrome
 * A route registered in one and forgotten in the other is either a locked-out
 * client or a leaked hub, so both now import from here. Add a public route in
 * exactly one place: this file.
 */
export const PUBLIC_PREFIXES = [
  "/login",
  "/invite", // token-link account setup, opened before a session exists
  "/learn", // public training-lesson share link
  "/portal", // THE CLIENT HUB — a client's only view of us
  "/privacy",
  "/terms", // public legal pages OAuth reviewers open signed out
  "/api/portal/upload",
  "/api/review/cut",
  "/api/review/upload",
  "/api/auth",
  "/api/google",
  "/api/webhooks",
  "/api/cron",
  "/api/health",
  "/api/activity",
] as const;

/** The client-facing feedback form is /feedback/<projectId> — ONE segment. The
 *  bare /feedback board is the internal request board and stays gated. */
export const isPublicFeedbackForm = (pathname: string) => /^\/feedback\/[^/]+$/.test(pathname);

/** Segment-boundary match, so /portal and /portal/<token> are public but a
 *  future /portals page would not be. */
export function isPublicRoute(pathname: string): boolean {
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  return isPublicFeedbackForm(pathname);
}
