import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRole } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// WHAT THE STRAIGHTEN EDITOR WORKS ON (Oct 21 2026, photoEdit.ts).
//
//   GET /api/photo-delivery/edit-source/<photoId>?size=preview   2048 px, for the sliders
//   GET /api/photo-delivery/edit-source/<photoId>?size=full      the full-size file, for Save
//
// Always the photo's OWN file (the listing image, the Dropbox file or
// AutoHDR's current version), never an earlier hub edit: every save is
// rendered from it with the settings on the sliders, so an edit is never
// re-edited and the quality never drops. Owner and Kyle only (a "view as"
// preview may look); the bytes come through here, never a store or AutoHDR
// link, and nothing is cached by a shared cache.
// ---------------------------------------------------------------------------

const ID = /^[A-Za-z0-9_-]{6,64}$/;
const SHOWS = new Set(["jpeg", "png", "webp"]);

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close();
      const end = Math.min(bytes.length, at + 1024 * 1024);
      c.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset + at, end - at));
      at = end;
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ photoId: string }> }) {
  const { photoId } = await ctx.params;
  const size = req.nextUrl.searchParams.get("size") === "full" ? "full" : "preview";
  if (!ID.test(photoId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await requireRole(["OWNER", "ADMIN"], { allowImpersonation: true });
  } catch {
    return NextResponse.json({ error: "Office access required." }, { status: 403 });
  }
  const photo = await prisma.photoAsset.findUnique({
    where: { id: photoId },
    select: {
      id: true, jobId: true, name: true, status: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true, contentHash: true, autohdrImageUuid: true,
      autohdrVersionUuid: true, width: true, height: true, inspectedHash: true, classifiedHash: true, derivJson: true, derivHash: true,
    },
  });
  if (!photo) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const [{ editBaseBytes, editBaseOf }, D] = await Promise.all([import("@/lib/photoDelivery/photoEdit"), import("@/lib/photoDelivery/qc/derivatives")]);
    const base = await editBaseOf(photo);
    // Oct 22 2026: an uploaded replacement is what the editor works on (photoEdit.ts editBaseOf fromHash).
    const key = D.derivKey(photo.id, `editbase:${base.fromHash ?? base.sourceHash ?? "none"}`, size);
    const cached = size === "preview" ? D.derivCache.get(key) : undefined;
    if (cached) return new Response(new Uint8Array(cached), { status: 200, headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=600", "x-content-type-options": "nosniff" } });
    const bytes = await editBaseBytes(photo);
    const meta = await D.readMeta(bytes);
    if (size === "preview") {
      const r = await D.renderFromSource(bytes, meta, "qc2048");
      D.derivCache.set(key, r.data);
      return new Response(new Uint8Array(r.data), { status: 200, headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=600", "x-content-type-options": "nosniff" } });
    }
    // A file a browser can't draw (TIFF, HEIC) goes over as a top-quality JPEG of the same size.
    let out = bytes;
    let type = `image/${meta.format === "jpeg" ? "jpeg" : meta.format}`;
    if (!SHOWS.has(meta.format ?? "")) {
      const sharp = (await import("sharp")).default;
      out = await sharp(bytes, { failOn: "none" }).rotate().toColourspace("srgb").jpeg({ quality: 97, chromaSubsampling: "4:4:4" }).toBuffer();
      type = "image/jpeg";
    }
    return new Response(streamOf(out), { status: 200, headers: { "content-type": type, "content-length": String(out.length), "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-photo-width": String(meta.width), "x-photo-height": String(meta.height) } });
  } catch (e) {
    const reason = (e as { publicReason?: string }).publicReason ?? "the photo could not be read just now";
    return NextResponse.json({ error: `This photo can't be opened for editing: ${reason}.` }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
