import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { monthlyFinalSnapshot } from "@/lib/monthlyFinal";
import { blobFetchDecision } from "@/lib/reviewCuts";
import { dbx } from "@/lib/integrations/dropbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Office-only spot check of canonical client bytes. No download/notice/decision
 * stamp, and no change to the Review Room's original playback route. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try { await requireAdmin(); } catch { return NextResponse.json({ error: "Office access required." }, { status: 403 }); }
  const me = await getCurrentUser();
  if (!me || me.impersonating) return NextResponse.json({ error: "Leave preview mode before checking the final file." }, { status: 403 });
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const s = await monthlyFinalSnapshot(id);
    if (!s.ok) return NextResponse.json({ error: s.message }, { status: 409 });
    if (req.nextUrl.searchParams.get("f") !== s.fingerprint) return NextResponse.json({ error: "The final file or access changed. Reopen the current final check." }, { status: 409 });
    let url: string;
    const headers = new Headers();
    const range = req.headers.get("range");
    if (range) headers.set("range", range);
    if (s.file.kind === "original" && s.cut.blobUrl) {
      const decision = blobFetchDecision(s.cut.blobUrl);
      if (!decision.ok) return NextResponse.json({ error: "The final source is unavailable." }, { status: 503 });
      url = s.cut.blobUrl;
      if (decision.authorization) headers.set("Authorization", decision.authorization);
    } else {
      const link = await dbx<{ link?: string; metadata?: { id?: string; rev?: string; content_hash?: string; size?: number; path_display?: string; path_lower?: string } }>("files/get_temporary_link", { path: s.file.kind === "processed" ? s.file.path : s.backup.path });
      if (!link.link) return NextResponse.json({ error: "The final file could not be opened." }, { status: 503 });
      // The path may have been replaced since the snapshot's metadata read.
      // Dropbox's link response must describe those same verified bytes.
      const metadata = link.metadata;
      const path = metadata?.path_display ?? metadata?.path_lower;
      if (!metadata || metadata.id !== s.backup.id || metadata.rev !== s.backup.rev
        || metadata.content_hash !== s.backup.hash || metadata.size !== s.backup.size
        || !path || path.toLowerCase() !== s.backup.path.toLowerCase()) {
        return NextResponse.json({ error: "The final file changed while it was opened. Reopen the current final check." }, { status: 409 });
      }
      url = link.link;
    }
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(300_000) });
    if (![200, 206].includes(response.status) || !response.body) return NextResponse.json({ error: "The final file could not be played." }, { status: 503 });
    const outgoing = new Headers({ "Cache-Control": "private, no-store", "Content-Type": response.headers.get("content-type") ?? "video/mp4", "X-Content-Type-Options": "nosniff" });
    for (const key of ["content-length", "content-range", "accept-ranges"]) { const value = response.headers.get(key); if (value) outgoing.set(key, value); }
    return new NextResponse(response.body, { status: response.status, headers: outgoing });
  } catch { return NextResponse.json({ error: "The final file and access could not be verified. Try the read again before recording a check." }, { status: 503 }); }
}
