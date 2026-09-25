import { NextRequest, NextResponse } from "next/server";
import { consumeLoginToken } from "@/lib/portalAccess";
import { signClientSession, CLIENT_COOKIE, clientCookieOptions, CLIENT_SESSION_MAX_AGE } from "@/lib/auth/clientSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The one-time sign-in link lands here. Consume it (single use, 15 minutes —
// the conditional update in consumeLoginToken is the lock), set the client
// cookie, stamp acceptedAt on the person's pending seats, and land them on
// /portal/me. Anything else — used, expired, unknown — goes to the sign-in
// page with one neutral reason, never a 404 and never a hint about why. A
// person whose every seat was revoked after the email went out is NOT signed
// in (no cookie): they land on the sign-in page with the "no access" note
// instead of a cookie that no page can honour.
//
// CP-08 (Sep 24 2026): a follow-up link can say WHERE to land — the questions
// still open on one topic — as `?next=`. That is an open-redirect surface, so
// it is honoured only when it is EXACTLY a portal interview address (no host,
// no scheme, no `//`, no path traversal, nothing appended); anything else is
// ignored and the person lands on /portal/me as before.
const SAFE_NEXT = /^\/portal\/me\?tab=topics&iv=[a-z0-9]{10,40}$/;

// Not exported: a route file may export only its handlers and route config.
function safePortalNext(next: string | null | undefined): string {
  return typeof next === "string" && SAFE_NEXT.test(next) ? next : "/portal/me";
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const r = await consumeLoginToken(token);
  const to = (path: string) => NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
  if (!r.ok) return to(`/portal/login?reason=${r.reason}`);
  const res = to(safePortalNext(req.nextUrl.searchParams.get("next")));
  res.cookies.set(CLIENT_COOKIE, await signClientSession({ cu: r.clientUserId, email: r.email }), clientCookieOptions(CLIENT_SESSION_MAX_AGE));
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
