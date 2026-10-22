import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// DOWNLOAD A PHOTO AT FULL SIZE (Oct 22 2026, hubFiles.ts downloadPhoto).
//
//   GET /api/photo-delivery/download/<photoId>?which=current    what gets delivered
//   GET /api/photo-delivery/download/<photoId>?which=original   the photo's own file, before the hub's edits
//
// Jordan: "we should be able to download photos". The owner, Kyle and the
// creative manager's view-only desk (Download is the one file control it
// has; a "view as" preview may download too, nothing is written). The bytes
// come THROUGH here (no store, Dropbox, Aryeo or AutoHDR link reaches the
// browser), as an attachment, never kept by a shared cache. NEVER A PAID
// DOWNLOAD: only what the hub already has; an AutoHDR photo the hub never
// bought is refused before AutoHDR is asked anything.
// ---------------------------------------------------------------------------

const ID = /^[A-Za-z0-9_-]{6,64}$/;

async function mayViewDesk(): Promise<boolean> {
  const { authEnforced } = await import("@/lib/auth/guards");
  if (!authEnforced()) return true;
  const { getCurrentUser } = await import("@/lib/auth/user");
  const u = await getCurrentUser().catch(() => null);
  if (!u) return false;
  if (u.realRole !== "CREATIVE_MANAGER") return true;
  const { canAccess } = await import("@/lib/auth/access");
  return canAccess({ role: u.realRole, permissions: u.permissions }, "photos");
}

const text = (message: string, status: number) => new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

export async function GET(req: NextRequest, ctx: { params: Promise<{ photoId: string }> }) {
  const { photoId } = await ctx.params;
  if (!ID.test(photoId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await requireRole(["OWNER", "ADMIN", "CREATIVE_MANAGER"], { allowImpersonation: true });
    if (!(await mayViewDesk())) throw new Error("no photo desk");
  } catch {
    return text("Staff access required.", 403);
  }
  const which = req.nextUrl.searchParams.get("which") === "original" ? "original" : "current";
  try {
    const { downloadPhoto } = await import("@/lib/photoDelivery/hubFiles");
    const r = await downloadPhoto(photoId, which);
    if (!r.ok) return text(r.message, r.status);
    const ascii = r.fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
    let at = 0;
    const bytes = r.bytes;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= bytes.length) return c.close();
        const end = Math.min(bytes.length, at + 1024 * 1024);
        c.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset + at, end - at));
        at = end;
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": r.contentType,
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    console.warn("photo-delivery download failed", photoId, (e as Error).message.slice(0, 160));
    return text("This photo can't be downloaded right now. Try again.", 503);
  }
}
