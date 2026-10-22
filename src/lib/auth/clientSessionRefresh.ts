import { CLIENT_COOKIE, CLIENT_SESSION_MAX_AGE, clientCookieOptions, clientSessionDue, readClientSession, signClientSession } from "@/lib/auth/clientSession";

// ---------------------------------------------------------------------------
// THE SLIDING RE-ISSUE of a client's portal session (Oct 22 2026). The proxy
// calls keepClientSignedIn on a GET under /portal that carries the client
// cookie; once the cookie is an hour old it is signed again for another full
// year and set on the response, with the same httpOnly / secure / sameSite /
// path attributes the sign-in route uses (clientCookieOptions).
//
// It re-issues ONLY for a person the portal would still let in: the ClientUser
// exists and is not DISABLED, and they hold at least one live seat
// (portal.liveMemberships: seat not revoked, program access not revoked, the
// seat's client agrees with the program's, and the client is in the rollout).
// Otherwise nothing is set and the old cookie runs out on its own; the
// resolver refuses it on every request meanwhile, so staff revoking access
// still cuts it at once. The DB is read at most once an hour per device.
// ---------------------------------------------------------------------------

/** A fresh session token for this cookie's person, or null (not due, not
 *  valid, or no longer allowed in). */
export async function refreshedClientSession(token: string | undefined | null, now: Date = new Date()): Promise<string | null> {
  const s = await readClientSession(token);
  if (!s || !clientSessionDue(s.issuedAt, now)) return null;
  const { prisma } = await import("@/lib/prisma");
  const person = await prisma.clientUser.findUnique({ where: { id: s.cu }, select: { id: true, email: true, status: true } });
  if (!person || person.status === "DISABLED") return null;
  const { liveMemberships } = await import("@/lib/portal");
  if ((await liveMemberships(person.id)).length === 0) return null;
  return signClientSession({ cu: person.id, email: person.email }, now);
}

/** Should this request be considered for a re-issue? A page or data GET under
 *  /portal that carries the client cookie. The one-time sign-in route sets its
 *  own cookie and is left alone. */
export function isClientSessionVisit(method: string, pathname: string, hasCookie: boolean): boolean {
  return hasCookie && method === "GET" && (pathname === "/portal" || pathname.startsWith("/portal/")) && !pathname.startsWith("/portal/auth/");
}

type CookieReader = { cookies: { get(name: string): { value: string } | undefined } };
type CookieWriter = { cookies: { set(name: string, value: string, opts: ReturnType<typeof clientCookieOptions>): unknown } };

/** Re-issue onto `res` when due. Never throws: a failed check only means no
 *  re-issue this time, and the request carries on exactly as before. */
export async function keepClientSignedIn(req: CookieReader & { method: string; nextUrl: { pathname: string } }, res: CookieWriter, now: Date = new Date()): Promise<boolean> {
  const value = req.cookies.get(CLIENT_COOKIE)?.value;
  if (!isClientSessionVisit(req.method, req.nextUrl.pathname, !!value)) return false;
  try {
    const fresh = await refreshedClientSession(value, now);
    if (!fresh) return false;
    res.cookies.set(CLIENT_COOKIE, fresh, clientCookieOptions(CLIENT_SESSION_MAX_AGE));
    return true;
  } catch (e) {
    console.warn(`[portal] client session re-issue skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
