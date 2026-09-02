import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { googleConfigured, googleConsentUrl, GOOGLE_STATE_COOKIE } from "@/lib/integrations/google";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start the MAILBOX consent (Gmail/Drive/Calendar) — NOT the login flow, which
// starts at /api/auth/login. Mirrors the QuickBooks connect route.
//
// Two things must be true before a browser is handed to Google: the caller is a
// signed-in owner/admin, and we planted a one-shot anti-forgery cookie that
// /api/google/callback can match. Until this route existed the "Connect Gmail"
// button pointed straight at Google with no state at all, so the callback had
// nothing to verify and accepted any authorization code from anyone — a
// stranger could attach their own mailbox, and every connected mailbox is
// polled into the company's comms and the AI's memory every 5 minutes.
export async function GET(req: NextRequest) {
  // Same fail-closed signal the server actions use: enforcement is always on in
  // production / on Vercel, so a missing AUTH_ENFORCE can never leave this open.
  if (authEnforced()) {
    const u = await getCurrentUser().catch(() => null);
    if (!u) {
      return NextResponse.redirect(
        new URL(`/login?next=${encodeURIComponent("/api/google/connect")}`, req.url),
      );
    }
    // Owner/admin only, and never while an owner is previewing someone else —
    // "view as" is read-only everywhere, and attaching a mailbox is not a read.
    if (u.impersonating || (u.realRole !== "OWNER" && u.realRole !== "ADMIN")) {
      return NextResponse.redirect(new URL("/connections?gmail=denied", req.url));
    }
  }
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/connections?gmail=config", req.url));
  }

  // The consent, the callback and the state cookie all have to sit on the ONE
  // host the browser is already on (the cookie is host-only), so the redirect
  // URI follows this request's origin — exactly what the login flow does.
  const state = randomUUID();
  const res = NextResponse.redirect(googleConsentUrl(state, req.nextUrl.origin));
  res.cookies.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // 30 minutes, not 10. The cookie's whole job is to prove this round trip is
    // ours; it stays one-shot (the callback clears it on every outcome), so a
    // longer window costs nothing but a wider replay gap on an already-cleared
    // value. 10 minutes was too tight for the real task: Google's consent screen
    // asks which account, and choosing between info@, hello@ and a personal
    // login — possibly signing in first — routinely takes longer than that. An
    // expiry lands the owner back on /connections as ?gmail=state, which reads
    // like the button did nothing.
    maxAge: 1800,
  });
  return res;
}
