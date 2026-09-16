import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A Dropbox-held cut still leaves through a 302 and returns in milliseconds,
// but a hub-uploaded one now streams its BYTES through this function (up to
// the 8 GB the upload route funds; the largest cut live today is 368 MB), and
// a player buffering ahead holds the response open for as long as it is
// filling. Without this the platform default ceiling cuts a long pull
// mid-stream — the player recovers by re-issuing the Range, so it reads as a
// stall rather than a failure, which is exactly the kind of fault nobody
// reports. 300s, the same ceiling /api/media/download proxies under (review,
// Sep 16).
export const maxDuration = 300;

const LINK_TTL_MS = 3.5 * 3600_000; // Dropbox temporary links live 4h
const linkCache = new Map<string, { link: string; at: number }>();

// The stable playback URL stored on every ReviewSubmission (assetUrl). It never
// serves bytes itself for a Dropbox-held cut: it checks who is asking, mints a
// fresh 4-hour Dropbox temporary link for the cut's file, and 302s the browser
// there — the player then does its own Range requests straight against Dropbox
// (verified 206). A cut uploaded through the hub is PROXIED instead; see below.
//
// Why a redirect and not a stored link: the Dropbox app has no sharing scope
// (public links can't be minted — and shouldn't be for unreleased client
// videos), temporary links expire, and MediaNotes key on the submission's
// assetUrl string, so that string has to stay constant while the real URL
// changes per request.
//
// WHO MAY PLAY (RTP-01, Sep 16). Until today the answer was "anyone with a hub
// session", which let the editor on one job stream another client's unreleased
// cut by id — 24 cuts across 13 jobs with differing editors. It is now the
// job's own people: owner/admin, the editor who holds the job, the
// photographer who shot it (canViewProject in auth/guards — the same
// resolution the task and shoot guards use), or the client portal via
// `?t=<portal token>`, gated exactly as before: the enrollment owning the
// submission's project, and only cuts that were shown to the client.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The row first — every branch below needs its project, and the portal
  // branch already resolved the submission anyway.
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id },
    select: { projectId: true, assetPath: true, blobUrl: true, fileName: true },
  });

  const token = req.nextUrl.searchParams.get("t");
  let allowed = false;
  if (token) {
    const { portalEnrollment, submissionForEnrollment } = await import("@/lib/portal");
    const enrollment = await portalEnrollment(token);
    allowed = !!enrollment && !!(await submissionForEnrollment(enrollment.id, id));
  } else if (sub) {
    const { canViewProject } = await import("@/lib/auth/guards");
    allowed = await canViewProject(sub.projectId); // no-op in local dev, same as every guard
  }
  // A missing row and a forbidden row answer the SAME way to a signed-in
  // stranger — "no" must not double as "that id exists".
  if (!allowed) return NextResponse.json({ error: "You don't have access to this cut." }, { status: 403 });
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Uploaded through the hub → served BY THIS ROUTE from the hub's own store.
  // It used to 302 the browser at the blob URL, and those objects are public
  // (see the note in /api/review/upload): the moment that URL left the gate it
  // was a permanent, credential-free link to an unreleased client video — a
  // 368 MB one in the audit's reproduction. The bytes now come back through
  // here, so the gate above is the only way THROUGH THIS ROUTE, and playback
  // never puts the object's address in a <video src>, an <a href> or the
  // referrer of anything the player loads. Range is proxied straight through
  // (and 206 returned verbatim) so scrubbing a 2 GB cut still works exactly
  // as it did.
  //
  // WHAT REMAINS (Sep 16). The client payload no longer carries the URL —
  // CutSubmission passes `hasHubCopy`, a boolean — so this route is now the
  // only door the hub opens. The objects themselves, however, are still in a
  // PUBLIC store, so every URL ever emitted (the 11 files live today) stays
  // reachable by anyone who kept one. That cannot be fixed in code: the SDK
  // refuses a private upload to a public store ("Cannot use private access on
  // a public store"), so the store has to be REPLACED by one created with
  // private access and the existing objects moved across. Jordan's call; until
  // then, treat any cut URL that has already left the building as still live.
  if (sub.blobUrl) return proxyBlob(req, sub.blobUrl, sub.fileName);

  if (!sub.assetPath) return NextResponse.json({ error: "No file is attached to this cut" }, { status: 404 });

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

// Headers a player actually needs, copied from upstream verbatim so a 206 is a
// faithful 206. Everything else (the store's own public cache-control, its
// CORS allow-origin) is dropped: this response is private to the person the
// gate just admitted.
const PASS_THROUGH = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

async function proxyBlob(req: NextRequest, blobUrl: string, fileName: string | null): Promise<Response> {
  const range = req.headers.get("range");
  const headers: Record<string, string> = {};
  if (range) headers.Range = range;
  const ifRange = req.headers.get("if-range");
  if (ifRange) headers["If-Range"] = ifRange;
  // A private blob needs the store's read token; a public one ignores it. The
  // host says which — the SDK builds `<store>.<access>.blob.vercel-storage.com`
  // — so this keeps working unchanged the day the store goes private.
  let host = "";
  try { host = new URL(blobUrl).host; } catch { return NextResponse.json({ error: "That cut's file link is unreadable" }, { status: 502 }); }
  if (!host.endsWith(".blob.vercel-storage.com")) return NextResponse.json({ error: "That cut's file link is unreadable" }, { status: 502 });
  const rw = process.env.BLOB_READ_WRITE_TOKEN;
  if (host.includes(".private.") && rw) headers.authorization = `Bearer ${rw}`;

  let upstream: Response;
  try {
    // cache: "no-store" — a 368 MB video must never enter Next's fetch cache.
    upstream = await fetch(blobUrl, { headers, cache: "no-store", redirect: "follow" });
  } catch {
    return NextResponse.json({ error: "That cut couldn't be fetched right now — try again" }, { status: 502 });
  }
  if (upstream.status === 404) return NextResponse.json({ error: "That cut's file is no longer in the store" }, { status: 404 });
  if (!upstream.ok && upstream.status !== 206) {
    return NextResponse.json({ error: "That cut couldn't be fetched right now — try again" }, { status: 502 });
  }
  const out = new Headers();
  // fetch() hands us a DECOMPRESSED body when upstream compressed it, while
  // upstream's content-length still describes the compressed bytes — copying
  // it verbatim would advertise the wrong length and the client would truncate
  // the file at that count. Latent today (the store serves video/quicktime
  // uncompressed) and it would bite the day a non-video cut or a different
  // store appears: drop the length and let the response be chunked (review,
  // Sep 16).
  const decompressed = !!upstream.headers.get("content-encoding");
  for (const h of PASS_THROUGH) {
    if (decompressed && h === "content-length") continue;
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("Cache-Control", "private, no-store");
  // Inline so it plays in the tab; the name is the editor's file name, which
  // is already the one the review surfaces show.
  const safe = (fileName ?? "cut").replace(/["\\\r\n]/g, "");
  out.set("Content-Disposition", `inline; filename="${safe}"`);
  if (!out.has("accept-ranges")) out.set("Accept-Ranges", "bytes");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
