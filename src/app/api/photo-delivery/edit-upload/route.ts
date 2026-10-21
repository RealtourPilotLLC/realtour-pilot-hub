import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// TOKEN EXCHANGE FOR A STRAIGHTENED PHOTO (Oct 21 2026, photoEdit.ts).
//
// The editor renders the photo at full size in the browser and sends the JPEG
// straight to the hub's PRIVATE store (unreleased client photos never go in
// the public one, blob.ts): nothing large passes through a function. This
// route only hands out a short-lived token for ONE path,
// photo-edits/<jobId>/<photoId>/…jpg, after checking who is asking (owner or
// Kyle, never a "view as" preview) and that the photo is on that job. The
// upload changes nothing by itself: the save (saveHubEdit) reads the file
// back by that path, checks it and only then makes it the photo's version.
// ---------------------------------------------------------------------------

const MAX_BYTES = 60 * 1024 * 1024;
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
    if (!token) throw new Error("The hub's private photo storage is not set up, so an edited photo can't be kept.");
    const result = await handleUpload({
      body,
      request: req,
      // The PRIVATE store's token; without it handleUpload would sign for the public store.
      token,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        await requireAdmin();
        let jobId = "", photoId = "";
        try {
          ({ jobId = "", photoId = "" } = JSON.parse(clientPayload ?? "{}") as { jobId?: string; photoId?: string });
        } catch {
          /* no payload */
        }
        if (!ID.test(jobId) || !ID.test(photoId)) throw new Error("Open the photo from its job first.");
        const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { jobId: true, status: true } });
        if (!photo || photo.jobId !== jobId || photo.status === "GONE") throw new Error("That photo is not on this job.");
        const { editUploadPrefix } = await import("@/lib/photoDelivery/photoEdit");
        if (!pathname.startsWith(editUploadPrefix(jobId, photoId)) || pathname.includes("..") || !/\.jpe?g$/i.test(pathname)) throw new Error("That path doesn't belong to this photo.");
        return {
          allowedContentTypes: ["image/jpeg"],
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          cacheControlMaxAge: 60,
          validUntil: Date.now() + 15 * 60_000,
          tokenPayload: JSON.stringify({ jobId, photoId }),
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
