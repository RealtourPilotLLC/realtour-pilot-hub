import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/jwt";
import { canAccess, homeFor, PAGES, type PageKey } from "@/lib/auth/access";

// Which page-key (if any) a path belongs to — for role/permission gating. Only
// top-level nav pages are gated; contextual detail routes (/projects/[id], etc.)
// are allowed to any signed-in user.
function pathKey(pathname: string): PageKey | null {
  if (pathname === "/") return "dashboard";
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
const PUBLIC_PREFIXES = ["/login", "/invite", "/api/auth", "/api/google", "/api/webhooks", "/api/cron", "/api/health", "/api/activity"];

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
  if (key && !canAccess({ role: session.role, permissions: session.permissions }, key)) {
    const home = homeFor(session.role);
    // Avoid redirecting onto the same path (defensive — homeFor never points at a
    // page the role can't open).
    return NextResponse.redirect(new URL(home === pathname ? "/shoot" : home, req.url));
  }
  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals + static asset files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|json)$).*)"],
};
