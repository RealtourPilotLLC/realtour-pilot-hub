import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Only proxy assets from Aryeo's own media hosts — prevents this route from
// becoming an open proxy / SSRF vector.
const ALLOWED_HOST_SUFFIXES = [
  "aryeo.com",
  "digitaloceanspaces.com",
  "mux.com",
  "cloudfront.net",
];

function hostAllowed(u: URL): boolean {
  return ALLOWED_HOST_SUFFIXES.some(
    (s) => u.hostname === s || u.hostname.endsWith(`.${s}`),
  );
}

// Streams a remote Aryeo asset back to the browser with Content-Disposition:
// attachment, so a download is forced even though the asset is cross-origin.
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  const name = req.nextUrl.searchParams.get("name") || "download";
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: "Bad url" }, { status: 400 });
  }
  if (target.protocol !== "https:" || !hostAllowed(target)) {
    return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
  }

  const upstream = await fetch(target.toString(), { cache: "no-store" });
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
