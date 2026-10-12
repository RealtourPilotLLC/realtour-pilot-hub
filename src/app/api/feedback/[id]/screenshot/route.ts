import { prisma } from "@/lib/prisma";
import { authEnforced } from "@/lib/auth/guards";
import { parseScreenshotDataUrl } from "@/lib/feedbackScreenshot";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// A FEEDBACK SCREENSHOT, AS AN IMAGE (Oct 12 2026).
//
// The board stored each screenshot as a data: URL and linked the thumbnail
// straight to it. Browsers refuse to open a data: URL in a new tab ("Not
// allowed to navigate top frame to data URL"), so clicking Kyle's screenshots
// did nothing — and every screenshot rode inside the page payload too. The
// board now points at this route instead: same people who can open the board
// (the "feedback" page permission), bytes only, never cached by anyone else.
// ---------------------------------------------------------------------------
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return new Response("Not found", { status: 404 });
  if (authEnforced()) {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { canAccess } = await import("@/lib/auth/access");
    const me = await getCurrentUser().catch(() => null);
    if (!me) return new Response("Sign in to see this screenshot.", { status: 401 });
    if (!canAccess(me, "feedback")) return new Response("Forbidden", { status: 403 });
  }
  const row = await prisma.platformFeedback.findUnique({ where: { id }, select: { screenshot: true } }).catch(() => null);
  const image = parseScreenshotDataUrl(row?.screenshot ?? null);
  if (!image) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.type,
      "Content-Disposition": `inline; filename="feedback-${id}.${image.type === "image/png" ? "png" : "jpg"}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
