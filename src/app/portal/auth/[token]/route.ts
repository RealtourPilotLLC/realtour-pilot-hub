import { NextRequest, NextResponse } from "next/server";
import { consumeLoginToken, peekLoginToken } from "@/lib/portalAccess";
import { signClientSession, CLIENT_COOKIE, clientCookieOptions, CLIENT_SESSION_MAX_AGE } from "@/lib/auth/clientSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The one-time sign-in link lands here.
//
// OPENING THE LINK NO LONGER SPENDS IT (Oct 5 2026). The GET used to consume
// the token, and mail scanners, link checkers and iMessage previews fetch every
// link they see — so a client's link was often used up before they tapped it.
// Now the GET only LOOKS (peekLoginToken, no write) and shows one button,
// "Continue to your portal"; the POST from that button is what consumes it
// (single use — the conditional update in consumeLoginToken is the lock), sets
// the client cookie, stamps acceptedAt on the person's pending seats, and lands
// them on /portal/me. Anything else — used, expired, unknown — goes to the
// sign-in page with one neutral reason, never a 404 and never a hint about
// why. A person whose every seat was revoked after the email went out is NOT
// signed in (no cookie): they land on the sign-in page with the "no access"
// note instead of a cookie that no page can honour.
//
// CP-08 (Sep 24 2026): a follow-up link can say WHERE to land — the questions
// still open on one topic — as `?next=`. That is an open-redirect surface, so
// it is honoured only when it is EXACTLY a portal interview address (no host,
// no scheme, no `//`, no path traversal, nothing appended); anything else is
// ignored and the person lands on /portal/me as before. The page carries it to
// the POST as a hidden field, checked again there.
const SAFE_NEXT = /^\/portal\/me\?tab=topics&iv=[a-z0-9]{10,40}$/;

// Not exported: a route file may export only its handlers and route config.
function safePortalNext(next: string | null | undefined): string {
  return typeof next === "string" && SAFE_NEXT.test(next) ? next : "/portal/me";
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function continuePage(action: string, next: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<title>Sign in · RealTour Pilot</title>
<style>
  :root { --bg: #f6f7f9; --card: #ffffff; --text: #111827; --muted: #4b5563; --brand: #ea580c; --brand-fg: #ffffff; --border: #e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0f14; --card: #131a22; --text: #f3f4f6; --muted: #9ca3af; --brand: #f97316; --brand-fg: #111827; --border: #263040; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 28px 24px; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 20px; color: var(--muted); font-size: 15px; }
  button { width: 100%; min-height: 48px; border: 0; border-radius: 12px; background: var(--brand); color: var(--brand-fg); font: inherit; font-weight: 600; cursor: pointer; }
  button:focus-visible { outline: 3px solid var(--text); outline-offset: 3px; }
</style>
</head>
<body>
<main>
  <h1>Your content portal</h1>
  <p>Press the button to sign in. This link works once.</p>
  <form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <button type="submit" autofocus>Continue to your portal</button>
  </form>
</main>
</body>
</html>`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const peek = await peekLoginToken(token);
  if (!peek.ok) {
    const res = NextResponse.redirect(new URL(`/portal/login?reason=${peek.reason}`, req.nextUrl.origin), 303);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
    return res;
  }
  const next = safePortalNext(req.nextUrl.searchParams.get("next"));
  // "same-origin", not "no-referrer", on THIS page only (Oct 5 2026): under
  // no-referrer a browser sends `Origin: null` with the button's POST, so the
  // POST could never show it came from here. same-origin still sends no
  // referrer to any other site (the page loads nothing from one).
  return new NextResponse(continuePage(req.nextUrl.pathname, next), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...PRIVATE_HEADERS, "Referrer-Policy": "same-origin" } });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const to = (path: string) => {
    const res = NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
    return res;
  };
  // Only this site's own page may press the button: a form posted from
  // anywhere else is refused before the link is touched. A browser's POST
  // carries Origin, and Sec-Fetch-Site; the press must PROVE it is ours with
  // one of them — a same-origin Origin, or Sec-Fetch-Site: same-origin. A
  // request with neither (review fix, Oct 5 2026: it used to pass) is refused
  // too, and so is an Origin naming another site whatever else it says.
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let sameOrigin = false;
  if (origin && origin !== "null") {
    try { sameOrigin = !!host && new URL(origin).host === host; } catch { sameOrigin = false; }
    if (!sameOrigin) return to("/portal/login?reason=invalid");
  }
  if (!sameOrigin && req.headers.get("sec-fetch-site") !== "same-origin") return to("/portal/login?reason=invalid");
  let next: string | null = null;
  try {
    const form = await req.formData();
    const v = form.get("next");
    next = typeof v === "string" ? v : null;
  } catch { /* no body: land on /portal/me */ }
  const r = await consumeLoginToken(token);
  if (!r.ok) return to(`/portal/login?reason=${r.reason}`);
  const res = to(safePortalNext(next));
  res.cookies.set(CLIENT_COOKIE, await signClientSession({ cu: r.clientUserId, email: r.email }), clientCookieOptions(CLIENT_SESSION_MAX_AGE));
  return res;
}
