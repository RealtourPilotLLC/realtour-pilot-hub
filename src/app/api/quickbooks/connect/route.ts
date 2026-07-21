import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { quickbooksAuthorizeUrl, quickbooksConfigured } from "@/lib/integrations/quickbooks";
import { getCurrentUser } from "@/lib/auth/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner kicks off the Intuit OAuth consent. Sets a short-lived state cookie
// (CSRF), then redirects to Intuit. Jordan authenticates on Intuit's own screen;
// we never see his QuickBooks password.
export async function GET(req: NextRequest) {
  if (process.env.AUTH_ENFORCE === "true") {
    const u = await getCurrentUser();
    if (!u || u.realRole !== "OWNER") return NextResponse.redirect(new URL("/", req.url));
  }
  if (!quickbooksConfigured()) {
    return NextResponse.redirect(new URL("/connections?quickbooks=config", req.url));
  }

  const state = randomUUID();
  const res = NextResponse.redirect(quickbooksAuthorizeUrl(state));
  res.cookies.set("rtp_qbo_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
