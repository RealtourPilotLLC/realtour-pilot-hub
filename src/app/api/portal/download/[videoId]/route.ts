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
// proves the video belongs to that scope's enrollment, and asks the release
// rule (cutEntitlement, through postingKit.resolveFinalFile) whether the client
// may have the file at all. Every successful hand-over is recorded as a
// PortalVisit on /portal/download/<videoId> — the client-recorded "Download
// started" fact; a refusal records nothing.
//
// CP-12 (Sep 24 2026): that row used to be read as "Downloaded", but it is
// written BEFORE the redirect — it proves the door opened, not that a single
// byte arrived. It is now "started", and the page records completion itself
// (postingKit.recordDownloadCompleted) when it has read the whole file. A
// STAFF-scope hit is still recorded, attributed to the staff member, and is
// no longer counted as the client's own download. The page fetches this door
// with fetch() for a hub-held cut (the 302 below is same-origin, so the bytes
// and their Content-Length come through for a progress bar) and navigates to
// it for everything else.
//
// CP-01 (Sep 24 2026): until today the only file checks were "is there one"
// and "does the hash match the approval, IF the served cut is the approved
// one" — so an internally approved cut the client had never decided on
// downloaded here, and so did a replacement round. Refusals now say which:
//   403  the client has not approved this version, or asked for changes to it
//   409  the bytes changed since they approved (never a different file)
//   404  there is no file to give (yet, or it is being re-issued)
// The STAFF scope gets the same answer: this door shows the client's truth.
// Staff keep the Review Room and the Ready-to-send card for the raw file.
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

  const { final, note, entitlement: e } = await resolveFinalFile(video);
  if (!final) {
    const status = e.blockedBy === "AWAITING_DECISION" || e.blockedBy === "CHANGES_REQUESTED" ? 403 : e.blockedBy === "HASH_DRIFT" ? 409 : 404;
    return NextResponse.json({ error: note ?? "No file yet." }, { status });
  }

  await recordDownload({ enrollmentId: video.enrollmentId, clientUserId, staffUserId, via }, video.id, final.submissionId);
  const target = final.kind === "cut" && final.submissionId
    ? `${streamUrlFor(final.submissionId)}?m=${encodeURIComponent(mediaToken(final.submissionId, v.scope))}&dl=1`
    : final.url;
  const res = NextResponse.redirect(new URL(target, req.nextUrl.origin), 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
