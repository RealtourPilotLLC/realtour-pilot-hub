import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyMediaToken, mediaScopeLive } from "@/lib/portalMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// A VIDEO'S INSTAGRAM COVER, FOR THE CLIENT (Oct 24 2026; lib/videoAnalysis).
// The Posting Kit shows the three covers and offers the chosen one beside the
// video download. Same gate as the download door (/api/portal/download): a
// media token minted over THIS video for the viewer's scope, re-checked live
// (a revoked seat or rotated link stops here), the video proven to belong to
// that scope's program, and the release rule asked whether the client may
// have the file at all: a cover is offered only with the file it is a frame
// of. The image comes out of the hub's own store through this route; a client
// is never handed a Dropbox or blob link. ?n=0..2 picks one; ?dl=1 saves it.
// Writes nothing.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await ctx.params;
  if (!/^[a-z0-9]{10,40}$/i.test(videoId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const v = verifyMediaToken(videoId, req.nextUrl.searchParams.get("m"));
  const refuse = () => NextResponse.json({ error: "You don't have access to this cover." }, { status: 403 });
  if (!v.ok || !(await mediaScopeLive(v.scope, v.mintedAt))) return refuse();

  const video = await prisma.contentVideo.findUnique({ where: { id: videoId } });
  let allowed = false;
  if (video) {
    if (v.scope.kind === "enrollment") allowed = video.enrollmentId === v.scope.id;
    else if (v.scope.kind === "membership") {
      const seat = await prisma.clientMembership.findUnique({ where: { id: v.scope.id }, select: { enrollmentId: true, clientId: true } });
      allowed = !!seat && seat.enrollmentId === video.enrollmentId && seat.clientId === video.clientId;
    } else {
      allowed = true; // OWNER/ADMIN through the owner iframe, verified live above
    }
  }
  if (!allowed || !video) return refuse();

  const { resolveFinalFile } = await import("@/lib/postingKit");
  const { final } = await resolveFinalFile(video);
  if (!final || final.kind !== "cut" || !final.submissionId) return NextResponse.json({ error: "The cover opens with the download." }, { status: 404 });

  const nRaw = req.nextUrl.searchParams.get("n");
  const n = nRaw != null && /^[0-5]$/.test(nRaw) ? Number(nRaw) : null;
  const { coverBytes } = await import("@/lib/videoAnalysis");
  const found = await coverBytes(final.submissionId, n).catch(() => null);
  if (!found) return NextResponse.json({ error: "No cover for this video yet." }, { status: 404 });

  const headers: Record<string, string> = { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300", "Content-Length": String(found.bytes.length) };
  if (req.nextUrl.searchParams.get("dl") === "1") {
    const stem = (video.title ?? "video").replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
    headers["Content-Disposition"] = `attachment; filename="${stem} cover.jpg"`;
  }
  return new NextResponse(new Uint8Array(found.bytes), { status: 200, headers });
}
