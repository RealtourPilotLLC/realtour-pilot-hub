import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { loginAuthorizeUrl, loginConfigured } from "@/lib/auth/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Kick off Google login. Sets a short-lived signed-state cookie (CSRF) plus the
// post-login destination + any invite token, then redirects to Google.
export async function GET(req: NextRequest) {
  if (!loginConfigured()) return NextResponse.redirect(new URL("/login?error=config", req.url));

  const nextParam = req.nextUrl.searchParams.get("next") || "/";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";
  const invite = req.nextUrl.searchParams.get("invite") || "";
  const state = randomUUID();

  const res = NextResponse.redirect(loginAuthorizeUrl(state));
  const opts = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: 600 };
  res.cookies.set("rtp_oauth_state", state, opts);
  res.cookies.set("rtp_oauth_next", next, opts);
  if (invite) res.cookies.set("rtp_oauth_invite", invite, opts);
  return res;
}
