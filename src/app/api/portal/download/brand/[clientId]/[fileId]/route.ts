import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyMediaToken, mediaScopeLive } from "@/lib/portalMedia";
import { portalBrandFileFor } from "@/lib/brandProfile";
import { dropboxTemporaryLink } from "@/lib/integrations/dropbox";
import { relayFile } from "@/lib/fileRelay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// READ ONE BRAND FILE FROM THE PORTAL (Oct 20 2026, audit E3). Clients never
// get a Dropbox link, so the Brand Profile's logo, headshot, fonts and the
// files already in their brand folder open through here. Admitted: a portal
// visit with a media token minted over THIS file (portalMedia, the same HMAC +
// live-scope check every portal video and brief file uses) whose scope is
// THIS client (the share link, a seat on it, or staff through the owner
// iframe). The file must be one of the client's own filed assets, or one
// listed in their brand folder; anything else answers 404. The bytes come
// through the hub, so the Dropbox address never reaches the browser; only
// pictures and PDFs are shown in the tab, and sandboxed.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]{10,40}$/i;
const deny = (status: number, msg: string) => NextResponse.json({ error: msg }, { status, headers: { "Cache-Control": "private, no-store" } });

const INLINE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" };

export async function GET(req: NextRequest, ctx: { params: Promise<{ clientId: string; fileId: string }> }) {
  const { clientId, fileId } = await ctx.params;
  if (!ID_RE.test(clientId) || !ID_RE.test(fileId)) return deny(404, "Not found");
  const v = verifyMediaToken(fileId, req.nextUrl.searchParams.get("m"));
  if (!v.ok || !(await mediaScopeLive(v.scope, v.mintedAt))) return deny(403, "This link has expired. Refresh the page and tap the file again.");

  let allowed = false;
  if (v.scope.kind === "enrollment") {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: v.scope.id }, select: { clientId: true } });
    allowed = e?.clientId === clientId;
  } else if (v.scope.kind === "membership") {
    const seat = await prisma.clientMembership.findUnique({ where: { id: v.scope.id }, select: { clientId: true, revokedAt: true } });
    allowed = !!seat && !seat.revokedAt && seat.clientId === clientId;
  } else allowed = true; // OWNER/ADMIN through the owner iframe, verified live above
  if (!allowed) return deny(403, "You don't have access to this file.");

  const file = await portalBrandFileFor(clientId, fileId, { folder: req.nextUrl.searchParams.get("src") === "folder" });
  if (!file) return deny(404, "That file isn't on your profile any more.");
  const link = await dropboxTemporaryLink(file.path).catch(() => null);
  if (!link) return deny(404, "That file isn't available right now. Try again in a minute.");

  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const inlineType = INLINE[ext] ?? null;
  const res = await relayFile(req, link, null, file.name.replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "brand-file", !inlineType);
  if (!res.ok) return deny(res.status === 404 ? 404 : 502, "That file couldn't be opened right now. Try again in a minute.");
  // Our word on the type, never the store's; anything that is not a picture
  // or a PDF downloads. A PDF is drawn by the browser's own viewer (which a
  // sandbox CSP breaks); everything else is sandboxed.
  res.headers.set("Content-Type", inlineType ?? "application/octet-stream");
  if (ext !== "pdf") res.headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  return res;
}
