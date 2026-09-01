import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/jwt";
import { canAccess, homeFor, PAGES, type PageKey } from "@/lib/auth/access";

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
// /api/health = read-only integration diagnostics (no secrets in responses).
// /api/activity = the usage beacon: it self-authenticates (204 on no session),
// and gating it here would 307 stale-cookie beacons into pointless /login
// renders on every navigation.
// /learn/<token> = public training-lesson share (unguessable token is the gate;
// the page shows video + summary only, never the verbatim transcript).
// /privacy + /terms are the public legal pages OAuth providers (Intuit, Google,
// Adobe) require in order to issue production credentials, and reviewers must be
// able to open them without signing in.
// NOTE: /api/quickbooks is deliberately NOT public. The Intuit consent + callback
// both run in the owner's own browser, so the session cookie carries them through
// the gate exactly like Frame.io. Opening the prefix would bypass middleware auth
// on /connect, whose own guard only fires when AUTH_ENFORCE is explicitly "true".
// /portal/<token> = the client-facing content page (unguessable token is the gate).
// /api/portal = the client portal's upload endpoint — token-authenticated
// inside the route itself, exactly like the /portal pages it serves.
const PUBLIC_PREFIXES = ["/login", "/invite", "/learn", "/portal", "/api/portal/upload", "/api/review/cut", "/api/review/upload", "/privacy", "/terms", "/api/auth", "/api/google", "/api/webhooks", "/api/cron", "/api/health", "/api/activity"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  // Public client feedback form is /feedback/<projectId>; the bare /feedback board
  // (no segment) stays gated.
  if (/^\/feedback\/[^/]+$/.test(pathname)) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  // Gate is OFF only in local dev (no AUTH_ENFORCE, not production, not Vercel).
  // In production / on Vercel the gate is ALWAYS on regardless of AUTH_ENFORCE —
  // losing the env var must fail CLOSED, never silently open every page against
  // the shared prod database (audit crack #26).
  const enforced =
    process.env.AUTH_ENFORCE === "true" ||
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.VERCEL);
  if (!enforced) return NextResponse.next();

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
    // (Next 16 proxy), so on this rare DENY path re-read the live row and
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
