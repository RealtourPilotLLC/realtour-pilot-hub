// ---------------------------------------------------------------------------
// SHARE A VIDEO FROM /media (Jordan, Oct 27 2026 Loom: "I would like share
// buttons, so like a button to be able to share. Share the video, so like a
// link to share"). Pure, so the page, the tile and the drill read one rule.
//
// THE ONLY LINK IS THE CLIENT'S PORTAL. A share link opens the video in the
// client's own Content Program portal (the Content Library, that one video),
// the same address the client's review emails carry (PORTAL_LANDING.video):
//   · the enrollment's portal link when it is live (not revoked, not expired):
//     /portal/<token>?tab=library&v=<video>, opens with no sign-in;
//   · else, when the client has a portal login: /portal/me?e=<enrollment>&
//     tab=library&v=<video>, which opens only for their own sign-in.
// Nothing else is ever a share link: never Dropbox (house rule: clients never
// get Dropbox links), never Aryeo's file, a Blob address or a hub stream route.
// A video with no portal home (a listing video, a program video not tied to
// its client's program) gets no Share button. The last check below refuses
// anything that is not one of the two portal shapes on the hub's own origin.
// ---------------------------------------------------------------------------

const ID = /^[a-z0-9]{10,40}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,}$/;

export type ShareFacts = {
  /** The logical program video (ContentVideo id) the tile shows; null on a listing video. */
  contentVideoId: string | null;
  /** That video's own program and client (ContentVideo). */
  video: { enrollmentId: string; clientId: string } | null;
  /** The program the video belongs to. */
  enrollment: { id: string; clientId: string; portalToken: string | null; portalTokenExpiresAt: Date | null; accessRevokedAt: Date | null } | null;
  /** At least one live (not revoked) portal login on that program. */
  hasSeat: boolean;
};

/** Only the portal's own addresses on the hub's origin, landing on one video. */
export function isClientSafeShareLink(url: string, base: string): boolean {
  let u: URL, b: URL;
  try {
    u = new URL(url);
    b = new URL(base);
  } catch {
    return false;
  }
  if (u.origin !== b.origin || u.username || u.password || u.hash) return false;
  if (/dropbox|blob\.vercel|aryeo|mux\.com|\/api\//i.test(url)) return false;
  const tokenPage = /^\/portal\/[A-Za-z0-9_-]{20,}$/.test(u.pathname) && u.pathname !== "/portal/login";
  const signedIn = u.pathname === "/portal/me";
  if (!tokenPage && !signedIn) return false;
  const q = u.search;
  return signedIn ? /^\?e=[a-z0-9]{10,40}&tab=library&v=[a-z0-9]{10,40}$/.test(q) : /^\?tab=library&v=[a-z0-9]{10,40}$/.test(q);
}

/** The link the Share button copies, or null (no Share button). */
export function videoShareLink(base: string, f: ShareFacts, now: Date = new Date()): string | null {
  const id = f.contentVideoId;
  const e = f.enrollment;
  if (!id || !ID.test(id) || !f.video || !e || !ID.test(e.id)) return null;
  // The video must be this client's, in this program (the portal checks the same: videoForEnrollment).
  if (f.video.enrollmentId !== e.id || f.video.clientId !== e.clientId) return null;
  if (e.accessRevokedAt) return null;
  const root = base.replace(/\/+$/, "");
  const tokenLive = !!e.portalToken && TOKEN.test(e.portalToken) && (!e.portalTokenExpiresAt || e.portalTokenExpiresAt.getTime() > now.getTime());
  const url = tokenLive
    ? `${root}/portal/${e.portalToken}?tab=library&v=${id}`
    : f.hasSeat
      ? `${root}/portal/me?e=${e.id}&tab=library&v=${id}`
      : null;
  return url && isClientSafeShareLink(url, root) ? url : null;
}
