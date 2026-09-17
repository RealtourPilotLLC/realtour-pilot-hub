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
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const r = await consumeLoginToken(token);
  const to = (path: string) => NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
  if (!r.ok) return to(`/portal/login?reason=${r.reason}`);
  const res = to("/portal/me");
  res.cookies.set(CLIENT_COOKIE, await signClientSession({ cu: r.clientUserId, email: r.email }), clientCookieOptions(CLIENT_SESSION_MAX_AGE));
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
