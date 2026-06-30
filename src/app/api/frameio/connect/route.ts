import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { frameioAuthorizeUrl, frameioConfigured } from "@/lib/integrations/frameio";
import { getCurrentUser } from "@/lib/auth/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner kicks off the Frame.io (Adobe IMS) OAuth consent. Sets a short-lived
// signed-state cookie (CSRF), then redirects to Adobe.
export async function GET(req: NextRequest) {
  if (process.env.AUTH_ENFORCE === "true") {
    const u = await getCurrentUser();
    if (!u || u.realRole !== "OWNER") return NextResponse.redirect(new URL("/", req.url));
  }
  if (!frameioConfigured()) return NextResponse.redirect(new URL("/connections?frameio=config", req.url));

  const state = randomUUID();
  const res = NextResponse.redirect(frameioAuthorizeUrl(state));
  res.cookies.set("rtp_fio_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
