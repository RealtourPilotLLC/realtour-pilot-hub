import { NextRequest } from "next/server";
import path from "path";
import { readFile, withinStorage } from "@/lib/storage";
import { DropboxError } from "@/lib/integrations/dropbox";

export const runtime = "nodejs";

// Serves a stored file from the company Dropbox for download/inline view.
// HARD GUARD: the path must live inside our app-owned storage prefix, so this
// endpoint can never be used to pull arbitrary files from the rest of the team's
// Dropbox. (This route is also behind the login gate.)
export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("path");
  if (!rel) return new Response("Missing path", { status: 400 });
  if (!withinStorage(rel)) return new Response("Forbidden", { status: 403 });

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
      headers: { "Content-Type": type, "Content-Disposition": disposition },
    });
  } catch (e) {
    // Dropbox not connected → 503; anything else (missing file, etc.) → 404.
    const status = e instanceof DropboxError && e.status === 401 ? 503 : 404;
    return new Response(status === 503 ? "Storage unavailable" : "Not found", { status });
  }
}
