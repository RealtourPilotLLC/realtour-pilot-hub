import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { MESSAGE_FILE_MAX_BYTES, MESSAGE_FILE_TYPES, messageFilePrefix, parseConversationKey } from "@/lib/messageFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// TOKEN EXCHANGE FOR A FILE ON A TEAM MESSAGE (Oct 28 2026). The browser sends
// the bytes straight to the PRIVATE store (lib/messageAttachments); nothing
// large passes through a server function. This route only hands out a
// short-lived token for ONE path, after checking:
//   · a signed-in team login, not a "view as" preview;
//   · that they can read the conversation the file is for (the team channel:
//     anyone on the team; a job thread: its own gate);
//   · that the path is under that conversation's and that login's own folder
//     (team-files/<conversation>/<login>/…);
// and the store itself enforces the type list and the 50 MB cap. Without a
// private store token nothing is signed: a file never lands in a public store.
// The send action asks the store again what actually landed before a message
// may carry it.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody;
  try {
    const { messageFileToken, NO_FILE_STORE } = await import("@/lib/messageAttachments");
    const token = messageFileToken();
    if (!token) throw new Error(NO_FILE_STORE);
    const result = await handleUpload({
      body,
      request: req,
      token,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const { getCurrentUser } = await import("@/lib/auth/user");
        const { authEnforced } = await import("@/lib/auth/guards");
        const me = await getCurrentUser().catch(() => null);
        if (!me && authEnforced()) throw new Error("Sign in to send files.");
        if (me?.impersonating) throw new Error("You're previewing another user. Exit the preview to send files.");
        let key = "";
        try { key = (JSON.parse(clientPayload ?? "{}") as { conversation?: string }).conversation ?? ""; } catch { /* no payload */ }
        const conv = parseConversationKey(key);
        if (!conv) throw new Error("That conversation doesn't exist.");
        const { canReadConversation } = await import("@/lib/hubLinkAccess");
        if (!(await canReadConversation(me, conv))) throw new Error("You can only send files in conversations you are in.");
        const userId = me?.id ?? "dev";
        if (!pathname.startsWith(messageFilePrefix(conv, userId)) || pathname.includes("..")) throw new Error("That file path doesn't belong to you.");
        return {
          allowedContentTypes: [...MESSAGE_FILE_TYPES],
          maximumSizeInBytes: MESSAGE_FILE_MAX_BYTES,
          addRandomSuffix: true,
          cacheControlMaxAge: 60,
          validUntil: Date.now() + 3600_000,
        };
      },
      // No completion callback: the send action reads the store itself.
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Upload refused" }, { status: 400 });
  }
}
