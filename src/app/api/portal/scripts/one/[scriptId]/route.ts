import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyMediaToken, mediaScopeLive } from "@/lib/portalMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// ONE APPROVED SCRIPT AS A PDF, from the agent's portal (Oct 14 2026).
// The page asks a server action for this link (portalScriptPdfLink), which
// mints the portal's own media token over the SCRIPT id for the viewer's
// scope; this door re-checks that scope is still live, that the script is on
// that scope's program, and that the agent approved the version on their page.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, ctx: { params: Promise<{ scriptId: string }> }) {
  const { scriptId } = await ctx.params;
  const deny = (msg: string, status = 403) => NextResponse.json({ error: msg }, { status });
  if (!/^[a-z0-9]{10,40}$/i.test(scriptId)) return deny("Not found", 404);
  const v = verifyMediaToken(scriptId, req.nextUrl.searchParams.get("m"));
  if (!v.ok || !(await mediaScopeLive(v.scope, v.mintedAt))) return deny("This link has expired. Go back to your page and press Download again.");
  const script = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { enrollmentId: true, clientId: true } });
  if (!script) return deny("That script isn't on your page.");
  if (v.scope.kind === "enrollment" && v.scope.id !== script.enrollmentId) return deny("That script isn't on your page.");
  if (v.scope.kind === "membership") {
    const seat = await prisma.clientMembership.findUnique({ where: { id: v.scope.id }, select: { enrollmentId: true, clientId: true } });
    if (!seat || seat.enrollmentId !== script.enrollmentId || seat.clientId !== script.clientId) return deny("That script isn't on your page.");
  }
  const { approvedScriptForPdf } = await import("@/lib/scriptPdfLinks");
  const r = await approvedScriptForPdf(script.enrollmentId, scriptId);
  if ("refused" in r) return deny(r.refused);
  const client = await prisma.client.findUnique({ where: { id: script.clientId }, select: { name: true } });
  const { buildScriptsPdf } = await import("@/lib/scriptPdf");
  const bytes = await buildScriptsPdf({ heading: r.script.title, subheading: client?.name ? `${client.name} · You can edit the wording on your page any time before we film.` : null, scripts: [r.script] });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${r.fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
