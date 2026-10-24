/**
 * The ONE list of routes a person can open without a session.
 *
 * Two places must agree about this, and when they drifted apart the whole staff
 * sidebar — Finance, People, Connections, Ask the Hub — rendered on real
 * clients' portal pages (Sep 2 2026 audit):
 *   · src/proxy.ts   decides whether to demand a session (Next 16's renamed middleware)
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
  // The client's ONLY download door. It authenticates itself by scoped media
  // token (src/app/api/portal/download/[videoId]/route.ts) exactly like the cut
  // stream below; left off this list the auth gate sent every real client's
  // "Download" button to the STAFF sign-in page (review blocker, Sep 17).
  "/api/portal/download",
  // The month's creative brief (Oct 8 2026): upload and read. Both doors
  // authenticate themselves — a scoped portal token or the hub session —
  // exactly like the download door above (src/app/api/portal/brief).
  "/api/portal/brief",
  // Scripts as a PDF (Oct 14 2026): the agent's approved script (scoped media
  // token) and a shoot's scripts (the hub session, or the signed link texted
  // to the agent). Each door authenticates itself (src/app/api/portal/scripts).
  "/api/portal/scripts",
  // A video's Instagram covers (Oct 24 2026): the Posting Kit's pictures and
  // their download. Authenticates itself with the same scoped media token over
  // the video as the download door (src/app/api/portal/cover/[videoId]).
  "/api/portal/cover",
  "/api/review/cut",
  "/api/review/upload",
  "/api/auth",
  "/api/google",
  "/api/webhooks",
  "/api/cron",
  // "/api/health" was listed here with no route behind it (removed Oct 20 2026,
  // audit H25): any route later added at that path would have been public by
  // accident. Add a real health route here deliberately if one is ever built.
  "/api/activity",
  // The browser error beacon (Oct 6 2026): portal visitors have no session and
  // their errors are the ones that matter most. Same-origin, size-capped and
  // rate-limited inside the route; stores no client data.
  "/api/errors",
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
