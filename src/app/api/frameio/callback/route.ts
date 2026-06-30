import { NextRequest, NextResponse } from "next/server";
import { exchangeFrameioCode } from "@/lib/integrations/frameio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Adobe IMS redirects back here with ?code. Verify the CSRF state, exchange the
// code for the refresh token (stored encrypted), then return to /connections.
export async function GET(req: NextRequest) {
  const back = (status: string) => {
    const res = NextResponse.redirect(new URL(`/connections?frameio=${status}`, req.url));
    res.cookies.delete("rtp_fio_state");
    return res;
  };

  if (req.nextUrl.searchParams.get("error")) return back("error");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("rtp_fio_state")?.value;
  if (!code || !state || !cookieState || state !== cookieState) return back("state");

  const r = await exchangeFrameioCode(code);
  return back(r.ok ? "connected" : "error");
}
