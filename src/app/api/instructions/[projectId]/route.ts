import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canViewProject } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The photographer's instructions file, from the job's Dropbox folder (Oct 22
// 2026, lib/dropboxInstructions). Same door as the editor brief: whoever may
// open the job (canViewProject), plus the job's second shooter (the upload
// page's own rule). Open = a 4-hour Dropbox temporary link to the file, never
// a share link; ?as=text = its text for the brief (txt, md, docx, pdf).
export async function GET(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  if (!/^[a-z0-9]{10,40}$/i.test(projectId)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  if (!(await mayOpen(projectId))) return NextResponse.json({ error: "not allowed" }, { status: 403 });
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { instructionsDropboxPath: true, instructionsDropboxName: true } });
  if (!p?.instructionsDropboxPath) return NextResponse.json({ error: "no instructions file on this job" }, { status: 404 });
  const name = p.instructionsDropboxName ?? p.instructionsDropboxPath.split("/").pop() ?? "instructions";
  const headers = { "cache-control": "private, no-store" };
  try {
    if (req.nextUrl.searchParams.get("as") === "text") {
      const { instructionText } = await import("@/lib/dropboxInstructions");
      const text = await instructionText(p.instructionsDropboxPath, name);
      return NextResponse.json({ name, text }, { headers });
    }
    const { dropboxTemporaryLink } = await import("@/lib/integrations/dropbox");
    return NextResponse.redirect(await dropboxTemporaryLink(p.instructionsDropboxPath), { status: 302, headers });
  } catch (e) {
    return NextResponse.json({ error: `Couldn't open "${name}" in Dropbox (${(e as Error).message.slice(0, 120)}). It may have been moved or renamed.` }, { status: 502, headers });
  }
}

async function mayOpen(projectId: string): Promise<boolean> {
  const u = await getCurrentUser().catch(() => null);
  if (await canViewProject(projectId, u)) return true;
  if (u?.role !== "PHOTOGRAPHER") return false;
  const { photographerMemberId, photographerMayUpload } = await import("@/lib/shoot");
  const mid = await photographerMemberId(u);
  return !!mid && (await photographerMayUpload(projectId, mid));
}
