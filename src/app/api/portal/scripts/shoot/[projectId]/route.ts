import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// A SHOOT'S SCRIPTS AS A PDF (Oct 14 2026). Two ways in:
//   · the photographer (or the office) signed in, from the shoot screen
//     (?script=<id> prints one);
//   · the link texted to the agent, ?k=<signature over this shoot>, which
//     needs no sign-in and lives 30 days. Refused once the agent's program
//     access is revoked.
// Always the CURRENT words: an edit made after the text shows in the PDF.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  const deny = (msg: string, status = 403) => NextResponse.json({ error: msg }, { status });
  if (!/^[a-z0-9]{10,40}$/i.test(projectId)) return deny("Not found", 404);
  const key = req.nextUrl.searchParams.get("k");
  const one = req.nextUrl.searchParams.get("script");
  const { verifyShootScriptsKey, shootScriptsForPdf } = await import("@/lib/scriptPdfLinks");
  let viaLink = false;
  if (key) {
    if (!verifyShootScriptsKey(projectId, key)) return deny("This link has expired. Ask us and we'll send a fresh one.");
    viaLink = true;
  } else {
    // Reading, not changing: a preview ("view as") may print too.
    const u = await getCurrentUser();
    if (!u && authEnforced()) return deny("Please sign in.", 401);
    // The creative manager prints any shoot's scripts, like the office (Oct 21 2026).
    if (u && u.realRole !== "OWNER" && u.realRole !== "ADMIN" && u.realRole !== "CREATIVE_MANAGER") {
      const { photographerMemberId, photographerOwnsShoot } = await import("@/lib/shoot");
      const mid = u.realRole === "PHOTOGRAPHER" ? await photographerMemberId(u) : null;
      if (!mid || !(await photographerOwnsShoot(projectId, mid))) return deny("You don't have access to that shoot.");
    }
  }
  const data = await shootScriptsForPdf(projectId, { scriptId: !viaLink && one && /^[a-z0-9]{10,40}$/i.test(one) ? one : null });
  if (!data) return deny("No scripts for this shoot.", 404);
  if (viaLink && data.enrollmentId) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: data.enrollmentId }, select: { accessRevokedAt: true } });
    if (!e || e.accessRevokedAt) return deny("This link is no longer active.");
  }
  const { buildScriptsPdf } = await import("@/lib/scriptPdf");
  const bytes = await buildScriptsPdf({ heading: data.heading, subheading: data.subheading, scripts: data.scripts });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      // The texted link opens in the phone's PDF viewer; the screen's button downloads.
      "Content-Disposition": `${viaLink ? "inline" : "attachment"}; filename="${data.fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
