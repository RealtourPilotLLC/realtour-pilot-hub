import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleCode, addGmailAccount, GOOGLE_STATE_COOKIE } from "@/lib/integrations/google";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Google redirects here after the MAILBOX consent (Gmail/Drive/Calendar). This
// is not the login callback — that one is /api/auth/callback/google.
//
// Both halves of the check matter, and neither used to exist. The state cookie
// proves this is the round trip WE started from /api/google/connect; the
// session check proves the person finishing it is still a signed-in owner/admin
// (a cookie alone would still let a stale tab, or a link fired at a signed-out
// browser, land a mailbox). Before this, the route connected whatever mailbox
// an authorization code belonged to — and every connected mailbox is polled
// into the company's comms and the AI's memory every 5 minutes.
export async function GET(req: NextRequest) {
  const back = (status: string) => {
    const res = NextResponse.redirect(new URL(`/connections?gmail=${status}`, req.url));
    // One-shot, cleared on every outcome: a leaked ?code can't be replayed
    // against a still-valid state.
    res.cookies.set(GOOGLE_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  };

  if (req.nextUrl.searchParams.get("error")) return back("error");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get(GOOGLE_STATE_COOKIE)?.value;
  if (!code || !state || !cookieState || state !== cookieState) return back("state");

  if (authEnforced()) {
    const u = await getCurrentUser().catch(() => null);
    if (!u || u.impersonating || (u.realRole !== "OWNER" && u.realRole !== "ADMIN")) {
      return back("denied");
    }
  }

  try {
    // Same origin the consent step used, or Google rejects the exchange.
    const { refreshToken } = await exchangeGoogleCode(code, req.nextUrl.origin);
    await addGmailAccount(refreshToken);
    return back("connected");
  } catch (e) {
    // "error" is the one outcome /connections can't explain to the owner —
    // a redirect_uri mismatch, a re-consent that returned no refresh token and
    // a Google outage all land here looking identical. The reason never reaches
    // the browser (it can carry token details), so leave a trail in the server
    // log instead of failing silently in both places.
    console.error("[google] mailbox connect failed:", e);
    return back("error");
  }
}
