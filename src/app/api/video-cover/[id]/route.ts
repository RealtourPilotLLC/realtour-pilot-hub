import { NextRequest, NextResponse } from "next/server";
import { mediaRouteAccess } from "@/lib/mediaAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// A VERSION'S COVER, FOR STAFF (Oct 24 2026; lib/videoAnalysis). The Media
// library tile and the Ready to send row show it and offer it beside the video
// download. The owner, the office and the creative manager only (the media
// library's own gate, re-read on every request). ?n=0..2 picks one of the
// three (default: the client's pick, else the best); ?dl=1 saves it. The
// image is read from the hub's own store here and never handed out as a link.
// Writes nothing.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]{10,40}$/i;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const access = await mediaRouteAccess();
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const nRaw = req.nextUrl.searchParams.get("n");
  const n = nRaw != null && /^[0-5]$/.test(nRaw) ? Number(nRaw) : null;
  const { coverBytes } = await import("@/lib/videoAnalysis");
  const found = await coverBytes(id, n).catch(() => null);
  if (!found) return NextResponse.json({ error: "No cover for that video yet." }, { status: 404 });
  const headers: Record<string, string> = { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300", "Content-Length": String(found.bytes.length) };
  if (req.nextUrl.searchParams.get("dl") === "1") {
    const { prisma } = await import("@/lib/prisma");
    const cut = await prisma.reviewSubmission.findUnique({ where: { id }, select: { fileName: true, project: { select: { title: true } } } }).catch(() => null);
    const stem = (cut?.fileName ?? cut?.project.title ?? "video").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[^A-Za-z0-9 ._-]+/g, " ").trim().slice(0, 80) || "video";
    headers["Content-Disposition"] = `attachment; filename="${stem} cover ${found.n + 1}.jpg"`;
  }
  return new NextResponse(new Uint8Array(found.bytes), { status: 200, headers });
}
