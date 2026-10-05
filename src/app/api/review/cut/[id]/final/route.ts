import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { monthlyFinalSnapshot } from "@/lib/monthlyFinal";
import { currentApproved, loadCut, sourceFingerprint } from "@/lib/finalRendition";
import { readDropboxFile } from "@/lib/finalDropbox";
import { blobFetchDecision } from "@/lib/reviewCuts";
import { dbx } from "@/lib/integrations/dropbox";
import { usesAryeoDelivery } from "@/lib/videoDeliveryDestination";

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
    const cut = await loadCut(id);
    if (!cut) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Listing previews use exactly the same source order as Download, without
    // recording a download or substituting the creative-review original.
    const listing = async () => {
      const fingerprint = sourceFingerprint(cut);
      if (!fingerprint || !(await currentApproved(cut))) return { ok: false as const, message: "This is no longer the current approved finished file." };
      const path = cut.topazJob?.state === "done" && cut.topazJob.finalPath && cut.topazJob.savedAt ? cut.topazJob.finalPath : cut.assetPath ?? cut.finalPath;
      const processed = Boolean(cut.topazJob?.state === "done" && cut.topazJob.finalPath && cut.topazJob.savedAt);
      const backup = path && (processed || !cut.blobUrl) ? await readDropboxFile(path) : null;
      if (!(cut.blobUrl && !processed) && !backup) return { ok: false as const, message: "The finished file could not be read." };
      return { ok: true as const, fingerprint, cut, file: processed ? { kind: "processed" as const, path: path! } : { kind: "original" as const }, backup };
    };
    const s = await usesAryeoDelivery(cut) ? await listing() : await monthlyFinalSnapshot(id);
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
      if (!s.backup) return NextResponse.json({ error: "The final source is unavailable." }, { status: 503 });
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
      // The native delivery player fetches directly from Dropbox after this
      // exact-file/access check. Seeking no longer repeats the database + two
      // Dropbox reads through a serverless proxy for each byte range. A normal
      // final-check request keeps the existing protected proxy response.
      if (req.nextUrl.searchParams.get("play") === "1") {
        return new NextResponse(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
      }
    }
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(300_000) });
    if (![200, 206].includes(response.status) || !response.body) return NextResponse.json({ error: "The final file could not be played." }, { status: 503 });
    const outgoing = new Headers({ "Cache-Control": "private, no-store", "Content-Type": response.headers.get("content-type") ?? "video/mp4", "X-Content-Type-Options": "nosniff" });
    for (const key of ["content-length", "content-range", "accept-ranges"]) { const value = response.headers.get(key); if (value) outgoing.set(key, value); }
    return new NextResponse(response.body, { status: response.status, headers: outgoing });
  } catch { return NextResponse.json({ error: "The final file and access could not be verified. Try the read again before recording a check." }, { status: 503 }); }
}
