import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyMediaToken, mediaScopeLive } from "@/lib/portalMedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// EVERY SCRIPT ON THE CLIENT'S BULK PLAN (or, with ?month=, one program
// month's approved scripts) AS ONE PDF (Oct 19 2026, Rick
// Schultz). The plan page carries this link with the portal's own media token
// minted over the ENROLLMENT id for the viewer's scope (PortalPage); this door
// re-checks that the scope is still live and is this enrollment's, then prints
// the words released to the client (scriptPdfLinks.bulkScriptsForPdf).
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, ctx: { params: Promise<{ enrollmentId: string }> }) {
  const { enrollmentId } = await ctx.params;
  const deny = (msg: string, status = 403) => NextResponse.json({ error: msg }, { status });
  if (!/^[a-z0-9]{10,40}$/i.test(enrollmentId)) return deny("Not found", 404);
  const v = verifyMediaToken(enrollmentId, req.nextUrl.searchParams.get("m"));
  if (!v.ok || !(await mediaScopeLive(v.scope, v.mintedAt))) return deny("This link has expired. Go back to your page and press Download again.");
  if (v.scope.kind === "enrollment" && v.scope.id !== enrollmentId) return deny("Those scripts aren't on your page.");
  if (v.scope.kind === "membership") {
    const seat = await prisma.clientMembership.findUnique({ where: { id: v.scope.id }, select: { enrollmentId: true } });
    if (!seat || seat.enrollmentId !== enrollmentId) return deny("Those scripts aren't on your page.");
  }
  // Oct 20 2026: ?month=YYYY-MM is one program month's scripts, once every
  // one of them is approved (scriptPdfLinks.monthScriptsForPdf); no month is
  // the bulk plan, as before.
  const monthKey = req.nextUrl.searchParams.get("month");
  const { bulkScriptsForPdf, monthScriptsForPdf } = await import("@/lib/scriptPdfLinks");
  let data: Awaited<ReturnType<typeof bulkScriptsForPdf>>;
  if (monthKey) {
    const m = await monthScriptsForPdf(enrollmentId, monthKey);
    if ("refused" in m) return deny(m.refused);
    data = m;
  } else {
    data = await bulkScriptsForPdf(enrollmentId);
    if (!data) return deny("There is no script plan on this page.", 404);
  }
  const { buildScriptsPdf } = await import("@/lib/scriptPdf");
  const bytes = await buildScriptsPdf({ heading: data.heading, subheading: data.subheading, scripts: data.scripts });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${data.fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
