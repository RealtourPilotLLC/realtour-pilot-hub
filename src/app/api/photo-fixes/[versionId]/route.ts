import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { contentDisposition } from "@/lib/contentDisposition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// A FIXED PHOTO, FOR KYLE TO PUT ON THE ARYEO LISTING (Oct 14 2026). The fix
// runner stores each AutoHDR result in the PRIVATE Blob store (unreleased
// client photos never go in the public one); this staff-only route streams it
// as a download, named after the photo it replaces so Aryeo's gallery keeps
// its order. OWNER/ADMIN only, the same people who approve fixes.
// ---------------------------------------------------------------------------
export async function GET(_req: NextRequest, ctx: { params: Promise<{ versionId: string }> }) {
  try {
    await requireRole(["OWNER", "ADMIN"]);
  } catch {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const { versionId } = await ctx.params;
  const v = await prisma.photoVersion.findUnique({ where: { id: versionId }, select: { source: true, derivJson: true, photo: { select: { name: true } } } });
  // Oct 21 2026: a photo straightened or cropped in the hub (photoEdit.ts) downloads the same way.
  if (!v || (v.source !== "FIX" && v.source !== "HUB_EDIT")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let pathname: string | null = null;
  try {
    pathname = v.derivJson ? ((JSON.parse(v.derivJson) as { file?: { pathname?: string } }).file?.pathname ?? null) : null;
  } catch {
    pathname = null;
  }
  if (!pathname) return NextResponse.json({ error: "This fix was not stored in the hub. Download it from AutoHDR (kept 7 days)." }, { status: 404 });
  const token = (process.env.PHOTO_QC_BLOB_TOKEN || process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN || "").trim();
  if (!token) return NextResponse.json({ error: "Private storage is not configured." }, { status: 500 });
  const { get } = await import("@vercel/blob");
  const got = await get(pathname, { access: "private", token }).catch(() => null);
  if (!got || !got.stream) return NextResponse.json({ error: "The stored file could not be read." }, { status: 404 });
  const name = (v.photo.name || "photo.jpg").replace(/\.[a-z0-9]+$/i, "") + ".jpg";
  return new NextResponse(got.stream as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": contentDisposition("attachment", name, "photo.jpg"),
      "Cache-Control": "private, no-store",
    },
  });
}
