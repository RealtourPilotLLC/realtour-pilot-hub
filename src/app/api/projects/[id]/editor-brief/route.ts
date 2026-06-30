import { NextRequest } from "next/server";
import { getProject } from "@/lib/queries";
import { buildEditorBriefPdf } from "@/lib/editor-pdf";
import { requireShootAccess } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The editor brief is rebuilt from the project on demand — no stored file. That
// keeps it working on Vercel's ephemeral filesystem, always reflects the latest
// project data, and means a photographer's field submit can't fail on a storage
// hiccup. Access: owner/admin, or the photographer assigned to this shoot.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireShootAccess(id);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  const project = await getProject(id);
  if (!project) return new Response("Not found", { status: 404 });

  const bytes = await buildEditorBriefPdf(project);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="editor-brief-${id}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
