import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { blobFetchDecision as decideBlobFetch } from "@/lib/reviewCuts";

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
// resolution the task and shoot guards use), or the client portal, three ways
// (identity layer, Sep 16 evening):
//   ?m=<media token>  what the portal page now puts in every <video src>: an
//                     HMAC bound to THIS submission id, six hours, minted only
//                     for cuts the resolver already proved the viewer may see
//                     (src/lib/portalMedia.ts). Leaking one leaks one video.
//   rtp_client cookie a signed-in person — their live seats are re-read and
//                     the cut must belong to one of those enrollments AND
//                     that enrollment's client (submissionForEnrollment).
//   ?t=<portal token> the pre-Sep-16 form. TRANSITION ONLY: no page emits it
//                     any more, but a client with a stale tab still may. Each
//                     use is logged so the day it goes quiet is visible, then
//                     this branch is deleted (Stage D of the plan).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // The row first — every branch below needs its project, and the portal
  // branch already resolved the submission anyway.
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id },
    select: { projectId: true, assetPath: true, finalPath: true, blobUrl: true, fileName: true },
  });

  const media = req.nextUrl.searchParams.get("m");
  const token = req.nextUrl.searchParams.get("t");
  let allowed = false;
  if (media) {
    const { verifyMediaToken, mediaScopeLive } = await import("@/lib/portalMedia");
    // Three proofs, not two. The signature proves the portal page minted this
    // for THIS cut; the scope check proves the seat / link / staff login it was
    // minted for is still allowed in — so a revoked seat or a rotated link
    // stops on the next Range request, not when the token expires; and the
    // OWNERSHIP check proves the cut belongs to that scope's own enrollment.
    // Without the third, a token minted over one client's cut passed the gate
    // on another client's cut, which is exactly the check the sibling download
    // route already makes (review, Sep 17).
    const v = verifyMediaToken(id, media);
    if (v.ok && (await mediaScopeLive(v.scope, v.mintedAt))) {
      if (v.scope.kind === "staff") {
        allowed = true; // OWNER/ADMIN, verified live — the hub's own authority
      } else {
        const { submissionForEnrollment } = await import("@/lib/portal");
        const pair =
          v.scope.kind === "enrollment"
            ? await prisma.contentEnrollment.findUnique({ where: { id: v.scope.id }, select: { id: true, clientId: true } })
            : await prisma.clientMembership
                .findUnique({ where: { id: v.scope.id }, select: { enrollmentId: true, clientId: true } })
                .then((seat) => (seat ? { id: seat.enrollmentId, clientId: seat.clientId } : null));
        allowed = !!pair && !!(await submissionForEnrollment(pair, id));
      }
    }
  } else if (token) {
    console.info(`[portal] legacy ?t= media access on cut ${id} (transition path)`);
    const { resolvePortalViewer, submissionForEnrollment } = await import("@/lib/portal");
    const r = await resolvePortalViewer({ token, cookies: req.cookies });
    // Released content stays playable for a paused/ended client (READ_ONLY);
    // a revoked or expired link plays nothing.
    allowed = r.ok && r.viewer.access !== "NONE" && !!(await submissionForEnrollment(r.viewer.enrollment, id));
  } else {
    if (req.cookies.get("rtp_client")?.value) {
      const { currentClientUser, liveMemberships, submissionForEnrollment } = await import("@/lib/portal");
      const person = await currentClientUser(req.cookies);
      if (person) {
        // liveMemberships already drops a seat whose clientId disagrees with
        // its enrollment's, so the pair passed here is the enrollment's own.
        for (const seat of await liveMemberships(person.id)) {
          if (await submissionForEnrollment({ id: seat.enrollmentId, clientId: seat.clientId }, id)) { allowed = true; break; }
        }
      }
    }
    // The hub's own guard reads rtp_session, which a client never holds — so
    // falling through here cannot open a cut for a client, but it does keep
    // the Review Room playing for a staff member who also signed into a TEST
    // client's portal in the same browser.
    if (!allowed && sub) {
      const { canViewProject } = await import("@/lib/auth/guards");
      allowed = await canViewProject(sub.projectId); // no-op in local dev, same as every guard
    }
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
  // docs/REVIEW-CUT-STORE-HANDOVER.md is the order that replacement has to go
  // in and the list of what else breaks; no private read has ever executed.
  // `dl=1` (the portal's download door, /api/portal/download) asks for an
  // attachment so the browser saves the file instead of playing it.
  if (sub.blobUrl) return proxyBlob(req, sub.blobUrl, sub.fileName, req.nextUrl.searchParams.get("dl") === "1");

  // assetPath is where the editor's file lives; finalPath is the copy the
  // approval filed (and, after a 1080p pass, the superseded original). Pruning
  // an upload deliberately leaves rows holding ONLY the filed copy — those used
  // to 404 here while every surface still offered a play/download button for
  // them. The filed copy is the same cut's bytes, so serve it.
  const path = sub.assetPath ?? sub.finalPath;
  if (!path) return NextResponse.json({ error: "No file is attached to this cut" }, { status: 404 });

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
      const r = await dbx<{ link?: string }>("files/get_temporary_link", { path });
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

// WHO MAY FETCH THE OBJECT, and with what, now lives in src/lib/reviewCuts.ts
// (Sep 18). It moved because the workers that also need it — the Topaz upload,
// the header probes, the retention prune, the approval's Dropbox copy — have no
// business importing an app route to get at it, and a second copy of this
// decision is exactly how six paths ended up handing out a bare public URL.
// Re-exported here because that is the path it shipped at and the probe that
// proves it (scripts/_fix/G/probe-guard.ts) imports it from this file.
export { blobFetchDecision } from "@/lib/reviewCuts";
export type { BlobFetchDecision } from "@/lib/reviewCuts";

async function proxyBlob(req: NextRequest, blobUrl: string, fileName: string | null, asAttachment = false): Promise<Response> {
  const range = req.headers.get("range");
  const headers: Record<string, string> = {};
  if (range) headers.Range = range;
  const ifRange = req.headers.get("if-range");
  if (ifRange) headers["If-Range"] = ifRange;
  // No token argument: the decision reads every store token this deployment
  // holds (blobStoreTokens), which during the store cutover is two — so a cut
  // still living in the old store and one already in the new one both play.
  const decision = decideBlobFetch(blobUrl);
  if (!decision.ok) {
    if (decision.reason === "unreadable") return NextResponse.json({ error: "That cut's file link is unreadable" }, { status: 502 });
    // A generic answer to the viewer; the detail belongs in the log, where it
    // names the half-finished configuration rather than the video.
    console.error("[review] private cut object on a store this deployment holds no token for:", decision.host);
    return NextResponse.json({ error: "That cut couldn't be fetched right now — try again" }, { status: 502 });
  }
  if (decision.authorization) headers.authorization = decision.authorization;

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
  // The content type on this response is whatever the store said, and the
  // filename below is whatever the editor called the export — neither is the
  // hub's word. nosniff keeps a browser from deciding for itself that a cut is
  // something it should execute rather than play.
  out.set("X-Content-Type-Options", "nosniff");
  // Inline so it plays in the tab; the name is the editor's file name, which
  // is already the one the review surfaces show.
  const safe = (fileName ?? "cut").replace(/["\\\r\n]/g, "");
  out.set("Content-Disposition", `${asAttachment ? "attachment" : "inline"}; filename="${safe}"`);
  if (!out.has("accept-ranges")) out.set("Accept-Ranges", "bytes");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
