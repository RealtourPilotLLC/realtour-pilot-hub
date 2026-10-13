import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canViewProject } from "@/lib/auth/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Open the raw footage" (and the other job-folder buttons): resolve the
// folder that is REALLY there at the moment of the click, then go to it
// (Jordan, Oct 13 2026 — a renamed "…_02-RAW-Video" left the button pointing
// at a folder that didn't exist, or at an empty one made beside it).
const KEYS = new Set(["listing", "rawPhotos", "rawVideo", "backupPhotos", "finalPhotos", "finalVideo"]);

export async function GET(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  const key = req.nextUrl.searchParams.get("folder") ?? "rawVideo";
  if (!/^[a-z0-9]{10,40}$/i.test(projectId) || !KEYS.has(key)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  if (!(await canViewProject(projectId))) return NextResponse.json({ error: "not allowed" }, { status: 403 });
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } } } });
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { liveSubfolderPath, dropboxWebUrl } = await import("@/lib/dropboxFolders");
  const path = await liveSubfolderPath(p as never, key as never).catch(async () => (await import("@/lib/dropboxFolders")).actualFolderPaths(p as never)[key as "rawVideo"]);
  return NextResponse.redirect(dropboxWebUrl(path), { status: 302, headers: { "cache-control": "private, no-store" } });
}
