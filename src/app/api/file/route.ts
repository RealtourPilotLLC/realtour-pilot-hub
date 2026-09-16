import { NextRequest } from "next/server";
import path from "path";
import { prisma } from "@/lib/prisma";
import { readFile, withinStorage, projectIdFromStoragePath } from "@/lib/storage";
import { canViewProject } from "@/lib/auth/guards";
import { DropboxError } from "@/lib/integrations/dropbox";

export const runtime = "nodejs";

// Serves a stored file from the company Dropbox for download/inline view.
//
// TWO guards, and the second one is new (RTP-01, Sep 16). The prefix check
// below stops this endpoint reaching the rest of the team's Dropbox, but on
// its own it answered "is this path ours?", never "is this file YOURS?" — so
// any signed-in hub user could ask for any other job's uploaded file and the
// request went through to storage. The path is now resolved to the job it
// belongs to (its UploadedFile row, else the `projects/<id>` convention
// storage.ts writes under) and the viewer must be on that job: owner/admin,
// the editor who holds it, or the photographer who shot it.
//
// An in-prefix path that resolves to NO job is a 403, not a pass-through: a
// path we can't attribute is a path nobody can be shown to own.
export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("path");
  if (!rel) return new Response("Missing path", { status: 400 });
  if (!withinStorage(rel)) return new Response("Forbidden", { status: 403 });

  const row = await prisma.uploadedFile
    .findFirst({ where: { storedPath: rel }, select: { projectId: true } })
    .catch(() => null);
  const projectId = row?.projectId ?? projectIdFromStoragePath(rel);
  if (!projectId) return new Response("Forbidden", { status: 403 });
  // A path shaped like ours naming a job that does not exist resolves to
  // nothing, so it is refused here rather than handed to Dropbox — otherwise
  // owner/admin (who pass any project check) would still walk the prefix.
  if (!row) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }).catch(() => null);
    if (!p) return new Response("Forbidden", { status: 403 });
  }
  if (!(await canViewProject(projectId))) return new Response("Forbidden", { status: 403 });

  try {
    const data = await readFile(rel);
    const ext = path.extname(rel).toLowerCase();
    const type =
      ext === ".pdf"
        ? "application/pdf"
        : ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : "application/octet-stream";
    const disposition = req.nextUrl.searchParams.get("download")
      ? `attachment; filename="${path.basename(rel)}"`
      : "inline";
    return new Response(new Uint8Array(data), {
      // Client work, served to one admitted viewer — never to a shared cache.
      headers: { "Content-Type": type, "Content-Disposition": disposition, "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    // Dropbox not connected → 503; anything else (missing file, etc.) → 404.
    const status = e instanceof DropboxError && e.status === 401 ? 503 : 404;
    return new Response(status === 503 ? "Storage unavailable" : "Not found", { status });
  }
}
