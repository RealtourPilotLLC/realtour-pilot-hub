import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// TOKEN EXCHANGE FOR KYLE'S OWN PHOTO FILES (Oct 22 2026, hubFiles.ts).
//
// Jordan: "we should be able to download photos, and then replace them with
// an upload, or add photos to the gallery manually." Modeled on the
// Straighten editor's edit-upload route: the browser sends the file straight
// to the hub's PRIVATE store (unreleased client photos never go in the public
// one, blob.ts), and this route only hands out a short-lived token for ONE
// path, after checking who is asking (owner or Kyle, never a "view as"
// preview) and what it is for:
//   photo-uploads/<jobId>/<photoId>/…   a replacement for that photo
//   photo-uploads/<jobId>/new/…         a photo to add to that job's gallery
// JPEG, PNG, HEIC or TIFF, at most 120 MB. The upload changes nothing by
// itself: the save (replaceWithUpload, addPhotosByHand) reads the file back
// by that path, checks and converts it, and only then makes it a version.
// ---------------------------------------------------------------------------

const ID = /^[A-Za-z0-9_-]{6,64}$/;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  try {
    const { privateBlobToken } = await import("@/lib/photoDelivery/blob");
    const token = privateBlobToken();
    if (!token) throw new Error("The hub's private photo storage is not set up, so a photo can't be uploaded.");
    const result = await handleUpload({
      body,
      request: req,
      // The PRIVATE store's token; without it handleUpload would sign for the public store.
      token,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        await requireAdmin();
        let jobId = "", target = "";
        try {
          ({ jobId = "", target = "" } = JSON.parse(clientPayload ?? "{}") as { jobId?: string; target?: string });
        } catch {
          /* no payload */
        }
        if (!ID.test(jobId) || !(target === "new" || ID.test(target))) throw new Error("Open the job first.");
        const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true } });
        if (!job) throw new Error("That job does not exist.");
        if (target !== "new") {
          const photo = await prisma.photoAsset.findUnique({ where: { id: target }, select: { jobId: true, status: true } });
          if (!photo || photo.jobId !== jobId || photo.status === "GONE") throw new Error("That photo is not on this job.");
        }
        const { uploadPathPrefix, UPLOAD_EXT, UPLOAD_TYPES, MAX_UPLOAD_BYTES } = await import("@/lib/photoDelivery/hubFiles");
        if (!pathname.startsWith(uploadPathPrefix(jobId, target)) || pathname.includes("..") || !UPLOAD_EXT.test(pathname)) throw new Error("That path doesn't belong to this job.");
        return {
          allowedContentTypes: [...UPLOAD_TYPES],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          cacheControlMaxAge: 60,
          validUntil: Date.now() + 15 * 60_000,
          tokenPayload: JSON.stringify({ jobId, target }),
        };
      },
      // The save records it (and checks it); nothing to do when the store calls back.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Upload refused" }, { status: 400 });
  }
}
