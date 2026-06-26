import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/jwt";

// Optimistic login gate. Unauthenticated requests to app pages are redirected to
// /login. Authorization (which role can see which page) is enforced server-side in
// the pages/DAL, not here. PUBLIC paths below must never be gated — they include
// the auth + OAuth callbacks, inbound webhooks, cron jobs, and the client-facing
// feedback form.
const PUBLIC_PREFIXES = ["/login", "/invite", "/api/auth", "/api/google", "/api/webhooks", "/api/cron"];

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

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("next", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals + static asset files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|json)$).*)"],
};
