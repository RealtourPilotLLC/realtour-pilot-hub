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
