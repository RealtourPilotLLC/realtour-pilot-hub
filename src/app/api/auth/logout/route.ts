import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function signOut(req: NextRequest) {
  const r = NextResponse.redirect(new URL("/login", req.url));
  r.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return r;
}

// POST is the real sign-out (from the sidebar form). GET is allowed too so a
// /api/auth/logout link works, but the UI uses POST.
export async function POST(req: NextRequest) { return signOut(req); }
export async function GET(req: NextRequest) { return signOut(req); }
