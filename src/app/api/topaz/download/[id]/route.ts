import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One-click download of a finished 1080p file, for the card Kyle works from.
//
// Why a route and not a link in the text: the Dropbox app has NO sharing scope
// (see lib/clientAssets — public links can't be minted, and shouldn't be for a
// client's unreleased video), so the only address a file has is a
// `get_temporary_link` that dies after four hours. A link pasted into a
// SmartTask would therefore be dead by the time Kyle opened the card in the
// morning. This URL is stable and mints a FRESH link on every press, so it
// works on day one and day thirty, and the credential never sits in a stored
// row. Same shape as /api/review/cut/[id]/stream, which solved this for
// playback (Sep 16).
//
// Jordan, Sep 16: "Zillow Showcase listings dont work with linked videos, they
// have to be uploaded." That is why this exists at all — the file has to reach
// Kyle's machine so he can upload the bytes to Aryeo by hand. There is no
// Aryeo endpoint that would let us skip this step; see ARYEO_MANUAL_NOTE.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The office only: this hands out a client's finished video. Kyle is ADMIN.
  try {
    await requireRole(["OWNER", "ADMIN"]);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const job = await prisma.topazJob.findUnique({
    where: { id },
    select: { finalPath: true, savedAt: true, state: true },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!job.finalPath || !job.savedAt) {
    // Not an error — the render simply hasn't landed yet. Say which, in words
    // the person reading them can act on.
    return NextResponse.json(
      { error: "That 1080p file isn't in Dropbox yet. The card will say when it lands." },
      { status: 409 },
    );
  }

  try {
    const { dbx } = await import("@/lib/integrations/dropbox");
    const r = await dbx<{ link?: string }>("files/get_temporary_link", { path: job.finalPath });
    if (!r.link) throw new Error("Dropbox returned no link");
    const res = NextResponse.redirect(r.link, 302);
    // Minted per press and good for four hours — never cache it anywhere.
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    const gone = /not_found|path_lookup/i.test(msg);
    return NextResponse.json(
      {
        error: gone
          ? "That file is no longer in the Final Video folder — it may have been moved or renamed in Dropbox."
          : "Dropbox couldn't hand the file over just now. Try again in a moment.",
      },
      { status: gone ? 404 : 502 },
    );
  }
}
