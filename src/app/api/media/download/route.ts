import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforcedNow } from "@/lib/auth/enforced";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Only proxy assets from Aryeo's own media hosts — prevents this route from
// becoming an open proxy / SSRF vector.
//
// Oct 20 2026 (audit G14): redirects are now followed BY HAND and every hop is
// re-checked against this list. The old fetch followed redirects on its own,
// so an allowed host that answered 302 to anywhere took the proxy with it.
// cloudfront.net and digitaloceanspaces.com are shared hosts used by many
// companies; narrowing them to Aryeo's own buckets needs the real bucket names
// from live media rows, so that is left as an open item rather than guessed.
const ALLOWED_HOST_SUFFIXES = [
  "aryeo.com",
  "digitaloceanspaces.com",
  "mux.com",
  "cloudfront.net",
];
// A redirect may also land on S3 (the photo-QC fetcher allows the same, see
// lib/photoDelivery/qc/source.ts), but a first request may not start there.
const REDIRECT_ONLY_SUFFIXES = ["amazonaws.com"];
const MAX_HOPS = 3;

function hostAllowed(u: URL, list: string[]): boolean {
  const host = u.hostname.toLowerCase();
  return list.some((s) => host === s || host.endsWith(`.${s}`));
}

/** https, an allowed host, no credentials, the standard port. */
function safeTarget(u: URL, isRedirect = false): boolean {
  const list = isRedirect ? [...ALLOWED_HOST_SUFFIXES, ...REDIRECT_ONLY_SUFFIXES] : ALLOWED_HOST_SUFFIXES;
  return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && hostAllowed(u, list);
}

// Streams a remote Aryeo asset back to the browser with Content-Disposition:
// attachment, so a download is forced even though the asset is cross-origin.
export async function GET(req: NextRequest) {
  // Staff only, re-read from the database (an active AppUser), not just a
  // cookie the auth proxy let through (audit G14).
  if (authEnforcedNow()) {
    const me = await getCurrentUser().catch(() => null);
    if (!me) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  }

  const url = req.nextUrl.searchParams.get("url");
  const name = req.nextUrl.searchParams.get("name") || "download";
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: "Bad url" }, { status: 400 });
  }
  if (!safeTarget(target)) {
    return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
  }

  let upstream: Response | null = null;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetch(target.toString(), { cache: "no-store", redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      let next: URL;
      try {
        if (!loc) throw new Error("no location");
        next = new URL(loc, target);
      } catch {
        return NextResponse.json({ error: "Bad redirect" }, { status: 502 });
      }
      if (!safeTarget(next, true)) return NextResponse.json({ error: "Redirect host not allowed" }, { status: 403 });
      target = next;
      continue;
    }
    upstream = res;
    break;
  }
  if (!upstream) return NextResponse.json({ error: "Too many redirects" }, { status: 502 });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `Upstream ${upstream.status}` }, { status: 502 });
  }

  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "download";
  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  headers.set("Content-Disposition", `attachment; filename="${safeName}"`);
  headers.set("Cache-Control", "private, max-age=0, no-store");

  return new NextResponse(upstream.body, { status: 200, headers });
}
