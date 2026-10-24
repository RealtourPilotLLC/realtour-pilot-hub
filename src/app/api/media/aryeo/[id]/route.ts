import { NextRequest, NextResponse } from "next/server";
import { mediaRouteAccess } from "@/lib/mediaAccess";
import { indexedVideoFile } from "@/lib/mediaLibrary";
import { fileStem } from "@/lib/mediaLibraryCore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// AN INDEXED ARYEO VIDEO, PLAYED OR DOWNLOADED (Oct 24 2026, /media). The
// library's tiles for older videos (lib/listingMediaIndex) carry only this
// address; the press is answered here, for the owner, the office and the
// creative manager only (lib/mediaAccess, re-read on every press, exactly as
// the hub's own file route /api/media/video/<cut>).
//
//   Watch     302 to the video's file on Aryeo's own host, the address the
//             listing read stored (videos.aryeo.com: unsigned, it does not
//             expire). The bytes never pass through the hub.
//   ?dl=1     302 to the staff download proxy (/api/media/download), which
//             re-checks the person and the host and saves it with a name.
//
// A video no longer on its listing (removedAt), on a job that is no longer
// delivered, or whose stored address is not one of Aryeo's media hosts is a
// 404 in words. Nothing here writes, and nothing here calls Aryeo's API.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]{10,40}$/i;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const access = await mediaRouteAccess();
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const found = await indexedVideoFile(id);
  if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });

  const wantsFile = req.nextUrl.searchParams.get("dl") === "1";
  const target = wantsFile
    ? new URL(`/api/media/download?url=${encodeURIComponent(found.url)}&name=${encodeURIComponent(`${fileStem(found.title, "video")}.${found.ext}`)}`, req.nextUrl.origin)
    : new URL(found.url);
  const res = NextResponse.redirect(target, 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
