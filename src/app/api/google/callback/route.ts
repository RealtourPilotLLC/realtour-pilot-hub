import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleCode, addGmailAccount } from "@/lib/integrations/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Google redirects here after the user authorizes Gmail access.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const base = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;

  if (error || !code) {
    return NextResponse.redirect(`${base}/connections?gmail=error`);
  }
  try {
    const { refreshToken } = await exchangeGoogleCode(code);
    await addGmailAccount(refreshToken);
    return NextResponse.redirect(`${base}/connections?gmail=connected`);
  } catch {
    return NextResponse.redirect(`${base}/connections?gmail=error`);
  }
}
