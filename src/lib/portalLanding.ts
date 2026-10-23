// ---------------------------------------------------------------------------
// WHERE A PORTAL LINK IN AN EMAIL MAY LAND (Oct 22 2026). One allowlist for
// both ends of a one-tap link: the builder that appends it to an emailed link
// (programReminders.resolvePortalLink: `?next=` on a sign-in link, the query on
// the shared token page) and the sign-in route that honours `?next=` after the
// press (app/portal/auth/[token]). `next` is an open-redirect surface, so only
// these exact shapes pass: no host, no scheme, no `//`, no traversal, nothing
// appended. Anything else lands on the portal's home, as before.
//
//   ?tab=topics&iv=<id>      the open questions on one topic (CP-08, Sep 24)
//   ?tab=library             the content library
//   ?tab=library&st=review   …filtered to the videos waiting on them
//   ?tab=library&v=<id>      one video
//   ?tab=plan                Your Month (call, filming)
//   ?tab=plan&pv=scripts     the scripts to read and approve
//     …#reply-<id>           …scrolled to an office reply under a script
//   ?tab=plan&pv=strategy    the content strategy
//   ?tab=messages            the conversation with the office
//   ?tab=brand               the brand profile / brand kit
// Any of them may lead with `e=<enrollmentId>&` (which program, for a person
// who holds seats on more than one; the resolver checks it is theirs).
// ---------------------------------------------------------------------------

const ID = "[a-z0-9]{10,40}";
const LANDING = new RegExp(`^\\?(?:e=${ID}&)?tab=(?:topics&iv=${ID}|library(?:&st=review|&v=${ID})?|plan(?:&pv=(?:scripts(?:#reply-${ID})?|strategy))?|messages|brand)$`);

/** The query when it is one of the allowed landings, else null. */
export function portalLandingQuery(q: string | null | undefined): string | null {
  return typeof q === "string" && LANDING.test(q) ? q : null;
}

/** A signed-in landing: `/portal/me` plus an allowed query, else `/portal/me`. */
export function portalNextPath(next: string | null | undefined): string {
  if (typeof next !== "string" || !next.startsWith("/portal/me?")) return "/portal/me";
  const q = portalLandingQuery(next.slice("/portal/me".length));
  return q ? `/portal/me${q}` : "/portal/me";
}

/** Where each kind of client email should open the portal. */
export const PORTAL_LANDING = {
  reviewVideos: "?tab=library&st=review",
  video: (videoId: string) => (/^[a-z0-9]{10,40}$/.test(videoId) ? `?tab=library&v=${videoId}` : "?tab=library"),
  yourMonth: "?tab=plan",
  scripts: "?tab=plan&pv=scripts",
  strategy: "?tab=plan&pv=strategy",
  messages: "?tab=messages",
  brand: "?tab=brand",
  /** One topic's open questions (CP-08's shape; Oct 23 2026, a question request). */
  topicQuestions: (interviewId: string, enrollmentId?: string | null) =>
    /^[a-z0-9]{10,40}$/.test(interviewId) ? `?${enrollmentId && /^[a-z0-9]{10,40}$/.test(enrollmentId) ? `e=${enrollmentId}&` : ""}tab=topics&iv=${interviewId}` : "?tab=plan",
  /** An office reply under a script, on the Scripts view, scrolled to it
   *  (the shape programMessages.scriptReplyLink uses). */
  scriptReply: (enrollmentId: string, messageId: string) =>
    /^[a-z0-9]{10,40}$/.test(enrollmentId) && /^[a-z0-9]{10,40}$/.test(messageId) ? `?e=${enrollmentId}&tab=plan&pv=scripts#reply-${messageId}` : "?tab=plan&pv=scripts",
} as const;
