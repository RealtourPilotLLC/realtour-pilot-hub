import { after, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/jwt";
import { CLIENT_BODY_MAX, errorTrackingEnabled, limiter, recordClientReport, type ClientReport } from "@/lib/errorTracker";
import { appBase } from "@/lib/appUrl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// THE BROWSER ERROR BEACON (Oct 6 2026). src/lib/clientErrorReport.ts posts
// here. Public (listed in lib/publicRoutes.ts) because a client on the portal
// has no staff session and their errors matter most — so it trusts nothing:
//   · same-origin only (Origin must be this host; a request with no Origin
//     must say Sec-Fetch-Site: same-origin);
//   · 16 KB body cap, read as text, parsed once;
//   · rate-limited per IP (10/min, 60/h) and per instance (120/min), plus the
//     tracker's own cap on NEW client rows per hour;
//   · only the error's description is read from the body. The signed-in staff
//     member (if any) comes from the session cookie's signature — id and role
//     only; a portal visitor is stored as nobody.
//   · ONLY THE PRODUCTION APP (Oct 9 2026): outside the production deployment
//     (local dev, previews, drills — all of which share the live database)
//     the beacon records nothing, and in production it takes reports only for
//     the app's own origin (appBase()), not another host the deployment
//     happens to answer on.
// Always answers 204 for an accepted or ignored report: the browser has
// nothing to do with the answer.
// ---------------------------------------------------------------------------

const noContent = () => new NextResponse(null, { status: 204 });

function sameOrigin(req: Request): boolean {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return !!host && new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
}

/** The request came to the production app's own host. */
function productionHost(req: Request): boolean {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !!host && host.toLowerCase() === new URL(appBase()).host.toLowerCase();
  } catch {
    return false;
  }
}

function clientKey(req: Request): string {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export async function POST(req: Request) {
  try {
    // Not production: nothing to record into (and nothing to tell the browser).
    if (!errorTrackingEnabled()) return noContent();
    if (!productionHost(req) || !sameOrigin(req)) return new NextResponse(null, { status: 403 });
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > CLIENT_BODY_MAX) return new NextResponse(null, { status: 413 });
    if (!limiter.allow(clientKey(req))) return new NextResponse(null, { status: 429 });
    const text = await req.text();
    if (text.length > CLIENT_BODY_MAX) return new NextResponse(null, { status: 413 });
    let body: ClientReport;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return noContent();
      body = parsed as ClientReport;
    } catch {
      return noContent();
    }
    const s = await verifySession(cookie(req, SESSION_COOKIE)).catch(() => null);
    const user = s ? { id: s.uid, role: s.role } : null;
    const work = recordClientReport(body, user).catch(() => null);
    try {
      after(() => work.then(() => undefined));
    } catch {
      await work; // no request scope (a drill): finish here
    }
  } catch {
    /* never an error about an error */
  }
  return noContent();
}
