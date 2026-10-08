import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyMediaToken, mediaScopeLive } from "@/lib/portalMedia";
import { briefFileFor, hubUserMayReadBrief, readBriefBytes } from "@/lib/monthBrief";
import { briefInline, briefMimeFor } from "@/lib/monthBriefCore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// READ ONE FILE OF A MONTH'S CREATIVE BRIEF (Oct 8 2026). Admitted:
//   · a portal visit with a scoped media token minted over THIS file
//     (`?m=`, portalMedia — the same HMAC + live-scope check every portal
//     video uses) whose scope is THIS month's enrollment (a share link, a
//     seat on it, or staff through the owner iframe);
//   · a signed-in hub user: owner/admin, or the photographer / editor on one
//     of THIS month's jobs (monthBrief.hubUserMayReadBrief).
// Anyone else — and a file that is not this month's — gets the same 404/403.
// Bytes are streamed from the private Dropbox prefix, never cached, never
// sniffed, and sandboxed so a document cannot run anything on our origin.
// ---------------------------------------------------------------------------

const deny = (status: number, msg: string) => NextResponse.json({ error: msg }, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET(req: NextRequest, ctx: { params: Promise<{ monthId: string; fileId: string }> }) {
  const { monthId, fileId } = await ctx.params;
  const hit = await briefFileFor(monthId, fileId);
  if (!hit) return deny(404, "Not found");
  const { month, file } = hit;

  const m = req.nextUrl.searchParams.get("m");
  let allowed = false;
  if (m) {
    const v = verifyMediaToken(fileId, m);
    if (v.ok && (await mediaScopeLive(v.scope, v.mintedAt))) {
      if (v.scope.kind === "enrollment") allowed = v.scope.id === month.enrollmentId;
      else if (v.scope.kind === "membership") {
        const seat = await prisma.clientMembership.findUnique({ where: { id: v.scope.id }, select: { enrollmentId: true, revokedAt: true } });
        allowed = !!seat && !seat.revokedAt && seat.enrollmentId === month.enrollmentId;
      } else allowed = true; // OWNER/ADMIN through the owner iframe, verified live above
    }
  } else {
    allowed = await hubUserMayReadBrief(month.id);
  }
  if (!allowed) return deny(403, "You don't have access to this file.");

  const bytes = await readBriefBytes(month, file);
  if (!bytes) return deny(404, "That file isn't available right now.");
  const safeName = file.name.replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "brief";
  const download = req.nextUrl.searchParams.get("download") === "1" || !briefInline(file.name);
  const headers: Record<string, string> = {
    "Content-Type": briefMimeFor(file.name),
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  // A PDF is drawn by the browser's own viewer (which a sandbox CSP breaks);
  // everything else shown inline is a picture.
  if (!/\.pdf$/i.test(file.name)) headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
  return new Response(new Uint8Array(bytes), { headers });
}
