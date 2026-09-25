import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Token exchange for the editor portal's cut uploads. The browser sends the
// bytes straight to the hub's store (multipart, resumable parts) — nothing
// large ever passes through a serverless function. This route only (1) hands
// out a short-lived, path-scoped upload token after checking who is asking
// and that the row they're filling is theirs, and (2) receives Vercel's
// upload-completed callback (signed by the store; the client also finalizes
// itself, so a missed callback costs nothing).
const MAX_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB — 4K vertical exports run 1–3 GB

// THE BLOB ACCESS PROBLEM (RTP-01, Sep 16). The cuts this route funds land in
// the store with `access: "public"`, which means the object's own URL is a
// permanent, credential-free link to an unreleased client video: the audit
// pulled a 368 MB .mov straight off `…public.blob.vercel-storage.com` with no
// session at all, `cache-control: public, max-age=2592000`.
//
// This route CANNOT pin that on its own, and the installed SDK was read line
// by line on Sep 17 to be sure of it rather than to assume it. In
// @vercel/blob 2.8.0 `access` is a CLIENT option
// (`ClientCommonCreateBlobOptions.access`, dist/client.d.ts:17), turned into
// the `x-vercel-blob-access` header on the browser's own PUT by
// `createPutHeaders` (`putOptionHeaderMap.access`, dist/chunk-YYMLUMXS.js) —
// and, tellingly, it is the ONE header that function writes unconditionally,
// before it consults the allowed-options list at all. The
// `blob.generate-client-token` event we receive carries only
// `{ pathname, clientPayload, multipart }`, and `onBeforeGenerateToken` is
// typed to return exactly
// `Pick<GenerateClientTokenOptions,'allowedContentTypes'|'maximumSizeInBytes'
// |'validUntil'|'addRandomSuffix'|'allowOverwrite'|'cacheControlMaxAge'
// |'ifMatch'>` (dist/client.d.ts:341) — no `access` key. Nor has
// `issueSignedToken` one (`IssueSignedTokenOptions`), so the presigned flow is
// no better. Returning `access: "private"` from onBeforeGenerateToken was
// tried: it does compile (the option is undeclared, not refused), but
// handleUpload only blind-spreads unknown keys into the signed token payload,
// the browser still sends `x-vercel-blob-access: public` on its own PUT, and
// whether the control plane reads or rejects the extra key can only be
// learned by performing a real upload — which, if it rejects, breaks every
// editor's cut upload in production. It is deliberately NOT shipped on a
// guess. The browser decides, so CutUploader is where the word lives, and it
// reads NEXT_PUBLIC_REVIEW_CUT_ACCESS so flipping it is a Vercel setting and
// a redeploy rather than an edit — docs/REVIEW-CUT-STORE-HANDOVER.md has the
// order the halves have to happen in.
//
// THE SIX PLACES THAT USED TO BREAK ARE FIXED (Sep 18). §4 of that handover
// listed six paths outside the Review Room that handed this URL to somebody
// else's servers — the finalize's own hostname check, Instagram's container
// fetch, the approval's Dropbox copy, Topaz and the header probes, and both
// delete guards. They now go through one place, src/lib/reviewCuts.ts (THE CUT
// STORE): our own fetches carry the store's token, an outside fetcher gets a
// short-lived presigned GET scoped to one object, and every hostname test asks
// the TOKEN which store we own instead of matching `.public.`. None of it has
// ever run against a private store, because none exists.
//
// What is left is genuinely Jordan's: create the store. The deployment can
// hold BOTH tokens while the objects move (BLOB_READ_WRITE_TOKEN +
// BLOB_READ_WRITE_TOKEN_LEGACY), which is what closes the window the old order
// left open — the 08:40 prune cleared a row's pointer and then aimed del() at
// whatever store the token named (§4). The prune now refuses to clear a
// pointer it cannot aim a delete with, so that window is shut in code and not
// in a runbook step somebody has to remember.
//
// What IS in this route's hands, and is done below:
//   · the cut's bytes no longer leave through a store URL at all — the stream
//     route proxies them behind its own gate, so PLAYBACK no longer hands a
//     browser the object's address — and since Sep 16 no other surface does
//     either: CutSubmission carries `hasHubCopy` (a boolean) where it used to
//     carry blobUrl, so the URL is no longer in any page's HTML;
//   · cacheControlMaxAge drops from the store default of 30 DAYS to the
//     documented platform minimum of 1 minute, so when the objects are
//     re-homed to a private store the CDN stops answering for the old URL
//     within a minute instead of a month. The store survey on Sep 17 proves
//     it took: of the 14 objects, the 4 uploaded since this line shipped
//     answer `cache-control: public, max-age=60` and the 10 older ones still
//     answer `max-age=2592000`.
// Neither is a fix. Nor is the random path segment the token asks for — the
// survey confirmed all 14 objects really are suffixed, so nobody is guessing
// URLs, but an unguessable URL is still a bearer token that never expires, is
// copied into Slack messages and referrer headers, and cannot be revoked. The
// fix is a private store, and that is an account action.
const CACHE_MAX_AGE_SECONDS = 60; // the documented floor; the SDK sends whatever it is given

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody;
  try {
    const { cutUploadToken } = await import("@/lib/reviewCuts");
    const result = await handleUpload({
      body,
      request: req,
      // The private store's token once it is connected (reviewCuts,
      // cutUploadToken); without this handleUpload signs with
      // BLOB_READ_WRITE_TOKEN — the public store — whatever the browser asks.
      token: cutUploadToken(),
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const { getCurrentUser } = await import("@/lib/auth/user");
        const { authEnforced } = await import("@/lib/auth/guards");
        const me = await getCurrentUser().catch(() => null);
        const devOpen = !me && !authEnforced(); // local dev without a session acts as the owner
        if (!devOpen && (!me || me.impersonating || !["OWNER", "ADMIN", "EDITOR"].includes(me.role))) {
          throw new Error("Sign in as the editor, an admin or the owner to upload a cut.");
        }
        let submissionId = "";
        try { submissionId = (JSON.parse(clientPayload ?? "{}") as { submissionId?: string }).submissionId ?? ""; } catch { /* no payload */ }
        const sub = submissionId
          ? await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { id: true, projectId: true, status: true, submittedByKey: true } })
          : null;
        if (!sub || sub.status !== "UPLOADING") throw new Error("Start the upload from the editor portal first.");
        // An editor may only fund the row THEY reserved (the reservation is
        // where assignment is checked); owner/admin may fund any.
        if (me && me.role === "EDITOR") {
          const { slugForName } = await import("@/lib/assignees");
          const myKey = me.editorKey ?? (me.name ? slugForName(me.name) : null);
          if (!myKey || sub.submittedByKey !== myKey) throw new Error("That upload was started by someone else.");
        }
        if (!pathname.startsWith(`review-cuts/${sub.projectId}/${sub.id}/`)) throw new Error("That path doesn't belong to this cut.");
        return {
          allowedContentTypes: ["video/mp4", "video/quicktime", "video/x-m4v", "video/webm", "video/x-matroska", "application/octet-stream"],
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
          tokenPayload: sub.id,
          // The default token lives 1 hour and every multipart part reuses it —
          // a 6 GB export over a slow link takes longer than that (review).
          validUntil: Date.now() + 12 * 3600_000,
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        if (!tokenPayload) return;
        // The browser chose `access` (see the note above), so this callback is
        // the only moment the hub ever learns where the bytes ACTUALLY landed.
        // Once the store is replaced, a cut that still lands in a public store
        // is the exact half-flipped state the replacement can leave behind —
        // an editor on a cached bundle, a preview deployment built before the
        // variable was set — and it is otherwise invisible: the row records a
        // URL, the Review Room plays it, nothing looks wrong. It is logged and
        // NOT refused: refusing here would strand a finished export the editor
        // has already spent an hour uploading, which is a worse trade than one
        // more object to re-home.
        const { ownCutObject, finalizeCutUpload, cutStoreAccess } = await import("@/lib/reviewCuts");
        const landed = ownCutObject(blob.url);
        if (cutStoreAccess() === "private" && landed.ok && landed.access === "public") {
          console.error("[review] cut landed in a PUBLIC store while the hub is configured private:", blob.pathname);
        }
        // …and the same sentence for the other half-flipped state: bytes in a
        // store no token of ours owns. Logged, never refused, for the same
        // reason — an editor's finished export is not thrown away over a
        // configuration mistake — but it is the state that makes a cut
        // unplayable and unprunable, so it must not be silent.
        if (!landed.ok) {
          console.error("[review] cut landed in a store this deployment has no token for:", landed.reason, blob.pathname);
        }
        await finalizeCutUpload(tokenPayload, { url: blob.url, pathname: blob.pathname });
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Upload refused" }, { status: 400 });
  }
}
