import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { quickbooksAuthorizeUrl, quickbooksConfigured } from "@/lib/integrations/quickbooks";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforcedNow } from "@/lib/auth/enforced";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner kicks off the Intuit OAuth consent. Sets a short-lived state cookie
// (CSRF), then redirects to Intuit. Jordan authenticates on Intuit's own screen;
// we never see his QuickBooks password.
//
// OWNER only, checked with the same fail-closed rule as every other guard
// (audit G5, Oct 20 2026). It used to fire only when AUTH_ENFORCE was exactly
// "true", so a lost env var let any signed-in login re-point the hub's
// QuickBooks connection at another company file. Never from a view-as preview.
export async function GET(req: NextRequest) {
  if (authEnforcedNow()) {
    const u = await getCurrentUser().catch(() => null);
    if (!u || u.realRole !== "OWNER" || u.impersonating) return NextResponse.redirect(new URL("/", req.url));
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
