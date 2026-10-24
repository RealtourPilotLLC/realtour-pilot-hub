import { NextResponse } from "next/server";
import { isPublicRoute } from "@/lib/publicRoutes";
import type { NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/jwt";
import { canAccess, homeFor, PAGES, type PageKey } from "@/lib/auth/access";
import { authEnforcedNow } from "@/lib/auth/enforced";
import { CLIENT_COOKIE } from "@/lib/auth/clientSession";
import { isClientSessionVisit, keepClientSignedIn } from "@/lib/auth/clientSessionRefresh";

// THE AUTH PROXY (Next 16's name for what used to be src/middleware.ts).
// Oct 20 2026 (audit G4/H22): Next 16 deprecates the `middleware` file and
// builds it for the EDGE runtime, where Prisma cannot run, so the live-row
// re-check on the deny path below always threw and fell back to the stale
// login claim (a fresh page grant kept bouncing its holder for up to 7 days).
// `proxy` always runs on Node (it cannot be configured otherwise; see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md),
// which is what that re-check needs. Matcher, config and the public list are
// unchanged by the rename.

// Which page-key (if any) a path belongs to — for role/permission gating. Only
// top-level nav pages are gated; contextual detail routes (/projects/[id], etc.)
// are allowed to any signed-in user.
function pathKey(pathname: string): PageKey | null {
  if (pathname === "/") return "dashboard";
  // Shoot DETAIL screens are contextual field surfaces every signed-in role
  // may open from a link (Schedule rows, Today's-shoots strip) — only the
  // bare /shoot list is the photographer nav page (review finding: dropping
  // "shoot" from ADMIN broke every /shoot/<id> link Kyle taps).
  if (pathname.startsWith("/shoot/")) return null;
  // The listing pages are the media library's (Oct 23 2026): one key, /media.
  if (pathname === "/listings" || pathname.startsWith("/listings/")) return "media";
  for (const p of PAGES) {
    if (p.href !== "/" && (pathname === p.href || pathname.startsWith(p.href + "/"))) return p.key;
  }
  return null;
}

// Optimistic login gate. Unauthenticated requests to app pages are redirected to
// /login. Authorization (which role can see which page) is enforced server-side in
// the pages/DAL, not here. PUBLIC paths below must never be gated — they include
// the auth + OAuth callbacks, inbound webhooks, cron jobs, and the client-facing
// feedback form.
// /api/activity = the usage beacon: it self-authenticates (204 on no session),
// and gating it here would 307 stale-cookie beacons into pointless /login
// renders on every navigation.
// /learn/<token> = public training-lesson share (unguessable token is the gate;
// the page shows video + summary only, never the verbatim transcript).
// /privacy + /terms are the public legal pages OAuth providers (Intuit, Google)
// require in order to issue production credentials, and reviewers must be able
// to open them without signing in.
// NOTE: /api/quickbooks is deliberately NOT public. The Intuit consent + callback
// both run in the owner's own browser, so the session cookie carries them through
// the gate. Opening the prefix would bypass the proxy's auth on /connect and
// /callback (both also check for the owner themselves since Oct 20 2026).
// /portal/<token> = the client-facing content page (unguessable token is the gate).
// /api/portal = the client portal's upload endpoint — token-authenticated
// inside the route itself, exactly like the /portal pages it serves.
// The list itself lives in src/lib/publicRoutes.ts — this proxy and the app
// shell must never disagree about it (see that file).

const isPublic = isPublicRoute;

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Oct 22 2026: a client's portal visit slides their year-long session on
  // (lib/auth/clientSessionRefresh: only for a person still allowed in, at
  // most once an hour per device). Every other public request is untouched.
  if (isClientSessionVisit(req.method, pathname, req.cookies.has(CLIENT_COOKIE))) {
    const res = NextResponse.next();
    await keepClientSignedIn(req, res);
    return res;
  }
  if (isPublic(pathname)) return NextResponse.next();

  // Gate is OFF only in local dev (no AUTH_ENFORCE, not production, not Vercel).
  // In production / on Vercel the gate is ALWAYS on regardless of AUTH_ENFORCE —
  // losing the env var must fail CLOSED, never silently open every page against
  // the shared prod database (audit crack #26). Same rule as every server
  // action guard (lib/auth/enforced), so the two can never drift.
  if (!authEnforcedNow()) return NextResponse.next();

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  // Signed in: enforce role/permission page access (honours per-user overrides via
  // the permissions claim). Owner sees everything; others are bounced home from a
  // page they can't open.
  const key = pathKey(pathname);
  let viewer = { role: session.role, permissions: session.permissions };
  if (key && !canAccess(viewer, key)) {
    // The permissions CLAIM was minted at login and goes stale the moment the
    // owner grants a page — James's fresh `mypay` grant kept bouncing him to
    // /tasks until re-login (Aug 25). This file runs on the Node runtime
    // (Next 16 proxy, see the note at the top), so on this rare DENY path re-read the live row and
    // re-evaluate; allowed requests never touch the DB. A DB hiccup falls
    // back to the claim — fail toward the stricter answer, never open.
    try {
      const { prisma } = await import("@/lib/prisma");
      const u = await prisma.appUser.findUnique({
        where: { id: session.uid },
        select: { role: true, permissions: true, status: true },
      });
      if (u && u.status === "ACTIVE") viewer = { role: u.role, permissions: u.permissions };
    } catch { /* keep the claim */ }
  }
  if (key && !canAccess(viewer, key)) {
    const home = homeFor(viewer.role);
    const homeKey = pathKey(home);
    // Bounce home — but ONLY if they can actually open it. The old code assumed
    // "homeFor never points at a page the role can't open", which is false the
    // moment a per-user override revokes it: an EDITOR whose `editing` override
    // was set to false got /editing -> denied -> home is /editing -> same path ->
    // the old fallback punted to /shoot -> editors can't open /shoot either ->
    // back to /editing. ERR_TOO_MANY_REDIRECTS, and the account is unusable.
    // (Hit live while onboarding an editor whose three default pages had all been
    // revoked.) /shoot was a bad fallback for exactly the same reason it looped:
    // most roles can't open it.
    if (homeKey && canAccess(viewer, homeKey) && home !== pathname) {
      return NextResponse.redirect(new URL(home, req.url));
    }
    // Their own home is closed to them. Find any page they CAN open rather than
    // ping-ponging between two closed doors.
    const fallback = PAGES.find((p) => p.href !== pathname && canAccess(viewer, p.key));
    if (fallback) return NextResponse.redirect(new URL(fallback.href, req.url));
    // Nothing at all is open: send them to /login with a reason instead of a
    // redirect loop. /login is public, so this always terminates.
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("error", "noaccess");
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals + static asset files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|json)$).*)"],
};
