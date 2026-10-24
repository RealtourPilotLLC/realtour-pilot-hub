import { NextRequest, NextResponse } from "next/server";
import { mediaRouteAccess } from "@/lib/mediaAccess";
import { mediaFileForCut } from "@/lib/mediaLibrary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A hub-stored original streams its bytes through here (Range passed up, a
// 206 passed down); the same ceiling the review stream route plays under.
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// THE MEDIA LIBRARY'S FILE DOOR (Oct 23 2026, /media and /listings). One
// finished video, played (no query) or downloaded (?dl=1), for the owner, the
// office and the creative manager only (lib/mediaAccess, re-read from the
// database on every press; a "view as" preview gets exactly what the
// previewed login would, and those three roles only).
//
// Only a video IN the library: an approved cut that went to the client or to
// their portal (mediaLibraryCore cutDone). Its file is the finished one
// (finishedFileOf): the checked Topaz file, else the editor's export.
// A Dropbox file leaves through a temporary link minted HERE, on this press,
// never cached and never written into a page. A file in the hub's store is
// relayed (it needs the store's credential).
//
// WHAT THIS NEVER DOES. It writes nothing. The Ready to send card's
// "downloaded by" stamp belongs to /api/topaz/download and the review stream
// route, which ARE the hand-off; taking a copy of an old video from the
// library is not, so it must never mark one.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]{10,40}$/i;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const access = await mediaRouteAccess();
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const found = await mediaFileForCut(id);
  if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
  const { file } = found;
  const wantsFile = req.nextUrl.searchParams.get("dl") === "1";

  if (file.kind === "blob") {
    const { blobFetchDecision } = await import("@/lib/reviewCuts");
    const decision = blobFetchDecision(file.url);
    if (!decision.ok) return NextResponse.json({ error: "That video couldn't be fetched right now. Try again." }, { status: 502 });
    const { relayFile } = await import("@/lib/fileRelay");
    return relayFile(req, file.url, decision.authorization ?? null, file.fileName, wantsFile);
  }

  try {
    const { dbx } = await import("@/lib/integrations/dropbox");
    const r = await dbx<{ link?: string }>("files/get_temporary_link", { path: file.path });
    if (!r.link) throw new Error("Dropbox returned no link");
    const res = NextResponse.redirect(r.link, 302);
    // Minted for this press and good for four hours: never cached anywhere.
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    const gone = /not_found|path_lookup/i.test(msg);
    return NextResponse.json(
      { error: gone ? "That file is no longer where the hub filed it in Dropbox. It may have been moved or renamed." : "Dropbox couldn't hand the file over just now. Try again in a moment." },
      { status: gone ? 404 : 502 },
    );
  }
}
