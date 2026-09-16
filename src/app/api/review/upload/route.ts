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
// This route CANNOT pin that on its own. In @vercel/blob 2.8.0 `access` is a
// CLIENT option (`ClientCommonCreateBlobOptions.access`, dist/client.d.ts),
// sent by the browser as the `x-vercel-blob-access` header on its own PUT; the
// `blob.generate-client-token` event we receive carries only
// `{ pathname, clientPayload, multipart }`, and the signed client token's
// option set (`BlobClientTokenConstraintOptions`) has no `access` key — nor
// does `issueSignedToken`'s (`IssueSignedTokenOptions`), so the presigned
// flow is no better. Returning `access: "private"` from onBeforeGenerateToken
// was tried: it does compile (the option is undeclared, not refused), but
// handleUpload only blind-spreads unknown keys into the signed token payload,
// the browser still sends `x-vercel-blob-access: public` on its own PUT, and
// whether the control plane reads or rejects the extra key can only be
// learned by performing a real upload — which, if it rejects, breaks every
// editor's cut upload in production. It is deliberately NOT shipped on a
// guess. The browser decides, so CutUploader has to be the one to say
// "private" — see the handover note filed with this ticket.
//
// What IS in this route's hands, and is done below:
//   · the cut's bytes no longer leave through a store URL at all — the stream
//     route proxies them behind its own gate, so PLAYBACK no longer hands a
//     browser the object's address — and since Sep 16 no other surface does
//     either: CutSubmission carries `hasHubCopy` (a boolean) where it used to
//     carry blobUrl, so the URL is no longer in any page's HTML;
//   · cacheControlMaxAge drops from the store default of 30 DAYS to the SDK
//     minimum of 1 minute, so when the objects are re-homed to a private
//     store the CDN stops answering for the old URL within a minute instead
//     of a month.
// Neither is a fix. Nor would a longer random path segment be: an unguessable
// URL is still a bearer token that never expires, is copied into Slack
// messages and referrer headers, and cannot be revoked. The fix is a private
// store.
const CACHE_MAX_AGE_SECONDS = 60; // the SDK floor; anything lower is refused

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request: req,
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
        const { finalizeCutUpload } = await import("@/lib/reviewCuts");
        await finalizeCutUpload(tokenPayload, { url: blob.url, pathname: blob.pathname });
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Upload refused" }, { status: 400 });
  }
}
