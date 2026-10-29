import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { contentDisposition } from "@/lib/contentDisposition";
import { opensInline, parseConversationKey } from "@/lib/messageFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// A FILE ON A TEAM MESSAGE, TO THE PEOPLE IN THAT CONVERSATION ONLY (Oct 28
// 2026). The one door to the bytes: the store is private and its addresses
// never reach a page. Asked of the viewer as they are (a "view as" preview
// reads as the person previewed): the team channel opens to anyone on the
// team; a job thread's files open to whoever may read that thread
// (lib/hubLinkAccess canReadConversation, the thread's own gate). Photos and
// PDFs open in the tab; everything else downloads under its own name (any
// name, an em dash included: lib/contentDisposition). ?download=1 downloads a
// photo too. nosniff, and no SVG or HTML is ever accepted (lib/messageFiles),
// so nothing served here can run script on the hub's address.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { authEnforced } = await import("@/lib/auth/guards");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) return NextResponse.json({ error: "Sign in to open this file." }, { status: 401 });
  const row = await prisma.messageAttachment
    .findUnique({ where: { id }, select: { pathname: true, name: true, contentType: true, size: true, conversation: true } })
    .catch(() => null);
  if (!row) return NextResponse.json({ error: "That file isn't here any more." }, { status: 404 });
  const conv = parseConversationKey(row.conversation);
  const { canReadConversation } = await import("@/lib/hubLinkAccess");
  if (!conv || !(await canReadConversation(me, conv))) {
    return NextResponse.json({ error: "Only the people in this conversation can open its files." }, { status: 403 });
  }
  const { messageFileStore } = await import("@/lib/messageAttachments");
  const store = messageFileStore();
  if (!store) return NextResponse.json({ error: "The private file store isn't connected on this server." }, { status: 503 });
  const got = await store.read(row.pathname);
  if (!got) return NextResponse.json({ error: "That file isn't in the store any more." }, { status: 404 });
  const download = req.nextUrl.searchParams.get("download") === "1" || !opensInline(row.contentType);
  const headers = new Headers({
    "Content-Type": row.contentType || "application/octet-stream",
    "Content-Disposition": contentDisposition(download ? "attachment" : "inline", row.name, "file"),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const size = got.size ?? row.size;
  if (size) headers.set("Content-Length", String(size));
  return new Response(got.stream as unknown as BodyInit, { status: 200, headers });
}
