import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyMediaToken, mediaScopeLive, mediaToken } from "@/lib/portalMedia";
import { resolveFinalFile, recordDownload } from "@/lib/postingKit";
import { streamUrlFor } from "@/lib/reviewCuts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// THE DOWNLOAD DOOR for a logical video (spec §8/§10). The page links here
// with a media token minted over the VIDEO id (the same HMAC + scope machinery
// every <video src> uses — src/lib/portalMedia.ts — so no second gate exists);
// this route re-checks that the seat / link / staff login is still live,
// proves the video belongs to that scope's enrollment, resolves WHICH file is
// the final (postingKit.resolveFinalFile) and refuses to serve a cut whose
// bytes no longer match the approval it is served under (409, never a
// different file). Every successful download is recorded as a PortalVisit on
// /portal/download/<videoId> — the client-recorded "Downloaded" fact.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, ctx: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await ctx.params;
  if (!/^[a-z0-9]{10,40}$/i.test(videoId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const m = req.nextUrl.searchParams.get("m");
  const v = verifyMediaToken(videoId, m);
  if (!v.ok || !(await mediaScopeLive(v.scope, v.mintedAt))) return NextResponse.json({ error: "You don't have access to this download." }, { status: 403 });

  const video = await prisma.contentVideo.findUnique({ where: { id: videoId } });
  // A missing row and a foreign row answer the same way.
  let allowed = false;
  let clientUserId: string | null = null;
  let staffUserId: string | null = null;
  let via: "TOKEN" | "LOGIN" | "STAFF" = "TOKEN";
  if (video) {
    if (v.scope.kind === "enrollment") allowed = video.enrollmentId === v.scope.id;
    else if (v.scope.kind === "membership") {
      const seat = await prisma.clientMembership.findUnique({ where: { id: v.scope.id }, select: { enrollmentId: true, clientId: true, clientUserId: true } });
      allowed = !!seat && seat.enrollmentId === video.enrollmentId && seat.clientId === video.clientId;
      clientUserId = seat?.clientUserId ?? null;
      via = "LOGIN";
    } else {
      allowed = true; // OWNER/ADMIN, verified live above — the hub's own authority
      staffUserId = v.scope.id;
      via = "STAFF";
    }
  }
  if (!allowed || !video) return NextResponse.json({ error: "You don't have access to this download." }, { status: 403 });

  const { final, note } = await resolveFinalFile(video);
  if (!final) return NextResponse.json({ error: note ?? "No file yet." }, { status: 404 });
  if (!final.hashOk) return NextResponse.json({ error: note ?? "The file changed since it was approved." }, { status: 409 });

  await recordDownload({ enrollmentId: video.enrollmentId, clientUserId, staffUserId, via }, video.id, final.submissionId);
  const target = final.kind === "cut" && final.submissionId
    ? `${streamUrlFor(final.submissionId)}?m=${encodeURIComponent(mediaToken(final.submissionId, v.scope))}&dl=1`
    : final.url;
  const res = NextResponse.redirect(new URL(target, req.nextUrl.origin), 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
