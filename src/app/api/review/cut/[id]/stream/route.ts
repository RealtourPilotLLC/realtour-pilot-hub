import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LINK_TTL_MS = 3.5 * 3600_000; // Dropbox temporary links live 4h
const linkCache = new Map<string, { link: string; at: number }>();

// The stable playback URL stored on every ReviewSubmission (assetUrl). It never
// serves bytes itself: it checks who is asking, mints a fresh 4-hour Dropbox
// temporary link for the cut's file, and 302s the browser there — the player
// then does its own Range requests straight against Dropbox (verified 206).
//
// Why a redirect and not a stored link: the Dropbox app has no sharing scope
// (public links can't be minted — and shouldn't be for unreleased client
// videos), temporary links expire, and MediaNotes key on the submission's
// assetUrl string, so that string has to stay constant while the real URL
// changes per request.
//
// Who may play: any signed-in hub user (owner/admin review, editors on /edit,
// Kyle on QC), or the client portal via `?t=<portal token>` — gated the same
// way the portal gates everything: the enrollment owning the submission's
// project, and only cuts that were shown to the client.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const token = req.nextUrl.searchParams.get("t");
  let allowed = false;
  if (token) {
    const { portalEnrollment, submissionForEnrollment } = await import("@/lib/portal");
    const enrollment = await portalEnrollment(token);
    allowed = !!enrollment && !!(await submissionForEnrollment(enrollment.id, id));
  } else {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { authEnforced } = await import("@/lib/auth/guards");
    const me = await getCurrentUser().catch(() => null);
    allowed = !!me || !authEnforced(); // local dev without a session, same as every guard
  }
  if (!allowed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sub = await prisma.reviewSubmission.findUnique({ where: { id }, select: { assetPath: true, blobUrl: true } });
  // Uploaded through the hub → served from the hub's own store (inline,
  // Range-capable, plays in every browser). Dropbox temporary links are the
  // legacy fallback and do NOT play in Chrome (served as an attachment) —
  // they're still fine as a download.
  if (sub?.blobUrl) {
    const res = NextResponse.redirect(sub.blobUrl, 302);
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  }
  if (!sub?.assetPath) return NextResponse.json({ error: "No file is attached to this cut" }, { status: 404 });

  try {
    // Browsers issue every Range/seek request against the ORIGINAL src, i.e.
    // this route — scrubbing a 2 GB cut could mint dozens of links a minute
    // through the same Dropbox ceiling the status sweep uses. Cache the
    // minted link per submission for most of its 4-hour life (in memory,
    // never in the DB).
    const cached = linkCache.get(id);
    let link = cached && Date.now() - cached.at < LINK_TTL_MS ? cached.link : null;
    if (!link) {
      const { dbx } = await import("@/lib/integrations/dropbox");
      const r = await dbx<{ link?: string }>("files/get_temporary_link", { path: sub.assetPath });
      if (!r.link) throw new Error("Dropbox returned no link");
      link = r.link;
      linkCache.set(id, { link, at: Date.now() });
    }
    const res = NextResponse.redirect(link, 302);
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    // A moved/renamed file is a 404 to the player, not a server fault.
    const status = /not_found|path_lookup/i.test(msg) ? 404 : 502;
    return NextResponse.json({ error: status === 404 ? "That file is no longer in the Final folder" : "Dropbox couldn't serve this file right now — try again" }, { status });
  }
}
