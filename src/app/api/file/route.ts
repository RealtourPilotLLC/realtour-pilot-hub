import { NextRequest } from "next/server";
import path from "path";
import { promises as fs } from "fs";
import { STORAGE_ROOT } from "@/lib/storage";

// Serves a file from the storage root for download/inline view.
// Guards against path traversal — the resolved path must stay inside STORAGE_ROOT.
export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("path");
  if (!rel) return new Response("Missing path", { status: 400 });

  const abs = path.resolve(STORAGE_ROOT, rel);
  if (abs !== STORAGE_ROOT && !abs.startsWith(STORAGE_ROOT + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const data = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const type =
      ext === ".pdf"
        ? "application/pdf"
        : ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : "application/octet-stream";
    const disposition = req.nextUrl.searchParams.get("download")
      ? `attachment; filename="${path.basename(abs)}"`
      : "inline";
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": type, "Content-Disposition": disposition },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
