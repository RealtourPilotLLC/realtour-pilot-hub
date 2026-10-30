import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// A TEAMMATE'S PROFILE PHOTO (Oct 30 2026). Signed-in hub users only: these
// are the team's own faces, never a client page's. A request carrying the
// photo's stamp (?v=, lib/teamPhoto) is cached for good, because a new photo
// gets a new stamp; without one the browser rechecks within a minute.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { authEnforced } = await import("@/lib/auth/guards");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) return NextResponse.json({ error: "Sign in to see this." }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[a-z0-9_-]{8,64}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const photo = await prisma.teamPhoto.findUnique({ where: { teamMemberId: id }, select: { bytes: true, contentType: true } });
  if (!photo) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const stamped = req.nextUrl.searchParams.has("v");
  return new NextResponse(Buffer.from(photo.bytes), {
    headers: {
      "Content-Type": photo.contentType || "image/jpeg",
      "Cache-Control": stamped ? "private, max-age=31536000, immutable" : "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
