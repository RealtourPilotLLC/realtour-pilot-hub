import "server-only";
import { NextResponse, type NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// STREAM AN UPSTREAM FILE BACK THROUGH A HUB ROUTE: Range and If-Range passed
// up, a faithful 206 passed down, the name and disposition ours. Shared by the
// review-cut stream route (the hub's own store and a client's 1080p render)
// and the portal's download door (a video delivered through an Aryeo listing,
// Oct 19 2026: Aryeo serves those `inline`, and a browser ignores the
// `download` attribute on another site's link, so Rick's Download button just
// played the video).
// ---------------------------------------------------------------------------

const PASS_THROUGH = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

export async function relayFile(req: NextRequest, url: string, authorization: string | null, fileName: string | null, asAttachment: boolean): Promise<Response> {
  const range = req.headers.get("range");
  const headers: Record<string, string> = {};
  if (range) headers.Range = range;
  const ifRange = req.headers.get("if-range");
  if (ifRange) headers["If-Range"] = ifRange;
  if (authorization) headers.authorization = authorization;

  let upstream: Response;
  try {
    // cache: "no-store" — a 368 MB video must never enter Next's fetch cache.
    upstream = await fetch(url, { headers, cache: "no-store", redirect: "follow" });
  } catch {
    return NextResponse.json({ error: "That cut couldn't be fetched right now — try again" }, { status: 502 });
  }
  if (upstream.status === 404) return NextResponse.json({ error: "That cut's file is no longer in the store" }, { status: 404 });
  if (!upstream.ok && upstream.status !== 206) {
    return NextResponse.json({ error: "That cut couldn't be fetched right now — try again" }, { status: 502 });
  }
  const out = new Headers();
  // fetch() hands us a DECOMPRESSED body when upstream compressed it, while
  // upstream's content-length still describes the compressed bytes — copying
  // it verbatim would advertise the wrong length and the client would truncate
  // the file at that count. Latent today (the store serves video/quicktime
  // uncompressed) and it would bite the day a non-video cut or a different
  // store appears: drop the length and let the response be chunked (review,
  // Sep 16).
  const decompressed = !!upstream.headers.get("content-encoding");
  for (const h of PASS_THROUGH) {
    if (decompressed && h === "content-length") continue;
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("Cache-Control", "private, no-store");
  // The content type on this response is whatever the store said, and the
  // filename below is whatever the editor called the export — neither is the
  // hub's word. nosniff keeps a browser from deciding for itself that a cut is
  // something it should execute rather than play.
  out.set("X-Content-Type-Options", "nosniff");
  // Inline so it plays in the tab; the name is the editor's file name, which
  // is already the one the review surfaces show.
  const safe = (fileName ?? "cut").replace(/["\\\r\n]/g, "");
  out.set("Content-Disposition", `${asAttachment ? "attachment" : "inline"}; filename="${safe}"`);
  if (!out.has("accept-ranges")) out.set("Accept-Ranges", "bytes");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
