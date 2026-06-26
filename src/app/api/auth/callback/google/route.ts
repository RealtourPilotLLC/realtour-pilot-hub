import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { exchangeLoginCode } from "@/lib/auth/google";
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLEAR = { path: "/", maxAge: 0 };

// Google login callback. Verifies CSRF state, exchanges the code for the verified
// email, and only signs the user in if they exist in the AppUser allowlist (or are
// accepting a matching invite). Random Google accounts are denied.
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get("rtp_oauth_state")?.value;
  const nextRaw = req.cookies.get("rtp_oauth_next")?.value || "/";
  const invite = req.cookies.get("rtp_oauth_invite")?.value || "";

  const fail = (reason: string) => {
    const r = NextResponse.redirect(new URL(`/login?error=${reason}`, req.url));
    r.cookies.set("rtp_oauth_state", "", CLEAR);
    r.cookies.set("rtp_oauth_next", "", CLEAR);
    r.cookies.set("rtp_oauth_invite", "", CLEAR);
    return r;
  };

  if (!code || !state || !cookieState || state !== cookieState) return fail("state");

  const info = await exchangeLoginCode(code);
  if (!info) return fail("google");

  let user = await prisma.appUser.findUnique({ where: { email: info.email } });
  // Invite acceptance: the link carried a token; activate only if the email matches.
  if (!user && invite) {
    const invited = await prisma.appUser.findUnique({ where: { inviteToken: invite } });
    if (invited && invited.email.toLowerCase() === info.email) user = invited;
  }
  if (!user || user.status === "DISABLED") return fail("denied");

  user = await prisma.appUser.update({
    where: { id: user.id },
    data: { status: "ACTIVE", lastLoginAt: new Date(), name: user.name ?? info.name ?? null, inviteToken: null },
  });

  const token = await signSession({ uid: user.id, email: user.email, role: user.role, name: user.name ?? undefined });
  const dest = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/";
  const r = NextResponse.redirect(new URL(dest, req.url));
  r.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  r.cookies.set("rtp_oauth_state", "", CLEAR);
  r.cookies.set("rtp_oauth_next", "", CLEAR);
  r.cookies.set("rtp_oauth_invite", "", CLEAR);
  return r;
}
