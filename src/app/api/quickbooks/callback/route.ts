import { NextRequest, NextResponse } from "next/server";
import { exchangeQuickBooksCode } from "@/lib/integrations/quickbooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Intuit redirects back here with ?code and ?realmId (the company id). Verify
// the CSRF state, exchange the code for a refresh token (stored encrypted),
// then return to /connections.
//
// realmId is required for every later API call and Intuit only ever sends it
// here, so a callback without it is a hard failure rather than a partial connect.
export async function GET(req: NextRequest) {
  const back = (status: string) => {
    const res = NextResponse.redirect(new URL(`/connections?quickbooks=${status}`, req.url));
    res.cookies.delete("rtp_qbo_state");
    return res;
  };

  if (req.nextUrl.searchParams.get("error")) return back("error");

  const code = req.nextUrl.searchParams.get("code");
  const realmId = req.nextUrl.searchParams.get("realmId");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("rtp_qbo_state")?.value;

  if (!code || !state || !cookieState || state !== cookieState) return back("state");
  if (!realmId) return back("realm");

  const r = await exchangeQuickBooksCode(code, realmId);
  return back(r.ok ? "connected" : "error");
}
