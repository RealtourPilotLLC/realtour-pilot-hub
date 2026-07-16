"use server";

import { prisma } from "@/lib/prisma";
import { requireShootAccess } from "@/lib/auth/guards";
import { projectFolderPaths } from "@/lib/dropboxFolders";

// ---------------------------------------------------------------------------
// Cull-BEFORE-upload (Jordan, Jul 2026): the photographer picks their card's
// JPGs in the portal, groups collapse into bracket sets, they drop the junk,
// and ONLY the keepers upload — straight from their browser to Dropbox via
// temporary upload links (the hub's token never reaches the client, and the
// bytes never touch our server, so it's as fast as their connection allows).
// ---------------------------------------------------------------------------

const MAX_FILES_PER_BATCH = 400;
const LINK_CHUNK = 25; // Dropbox RPC friendliness

// Only what a filename is allowed to look like once it hits the shared folder.
function safeName(name: string): string | null {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  if (!base || base.startsWith(".")) return null;
  if (!/\.(jpe?g)$/i.test(base)) return null; // photo culling is JPG-only (crews shoot 5-bracket JPGs)
  return base.replace(/[^\w.\- ()]/g, "_").slice(0, 120);
}

export async function createUploadLinks(
  projectId: string,
  fileNames: string[],
): Promise<{ ok: boolean; message?: string; links?: { name: string; url: string }[] }> {
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!Array.isArray(fileNames) || fileNames.length === 0) return { ok: false, message: "No files to upload." };
  if (fileNames.length > MAX_FILES_PER_BATCH) {
    return { ok: false, message: `That's ${fileNames.length} files — upload in batches of ${MAX_FILES_PER_BATCH} or fewer.` };
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, client: { select: { name: true } } },
  });
  if (!project) return { ok: false, message: "Project not found." };
  const rawPhotos = projectFolderPaths(project).rawPhotos;

  const { dbx, dropboxAccessToken, dropboxCreateFolder } = await import("@/lib/integrations/dropbox");
  let token: string;
  try {
    token = await dropboxAccessToken();
  } catch {
    return { ok: false, message: "Dropbox isn't connected — upload via the Dropbox app instead." };
  }
  await dropboxCreateFolder(rawPhotos).catch(() => {}); // exists already on most jobs

  const links: { name: string; url: string }[] = [];
  const cleaned = fileNames.map((n) => ({ original: n, safe: safeName(n) }));
  const bad = cleaned.filter((c) => !c.safe);
  if (bad.length > 0) return { ok: false, message: `Only JPGs can be culled here (${bad[0].original} isn't one).` };

  for (let i = 0; i < cleaned.length; i += LINK_CHUNK) {
    const chunk = cleaned.slice(i, i + LINK_CHUNK);
    const results = await Promise.all(
      chunk.map(async (c) => {
        const r = await dbx<{ link: string }>(
          "files/get_temporary_upload_link",
          { commit_info: { path: `${rawPhotos}/${c.safe}`, mode: "add", autorename: true, mute: true } },
          token,
        );
        return { name: c.original, url: r.link };
      }),
    ).catch(() => null);
    if (!results) return { ok: false, message: "Dropbox refused the upload links — try again in a minute." };
    links.push(...results);
  }
  return { ok: true, links };
}

// After the browser finishes: record what the cull actually did (the receipts
// Jordan's culling KPIs feed on) and nudge the folder-driven status engine.
export async function finalizeCullUpload(
  projectId: string,
  stats: { keptSets: number; totalSets: number; uploadedFiles: number; droppedFiles: number; failedFiles: number },
): Promise<{ ok: boolean; message?: string }> {
  try {
    await requireShootAccess(projectId);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const s = {
    keptSets: Math.max(0, Math.floor(stats.keptSets)),
    totalSets: Math.max(0, Math.floor(stats.totalSets)),
    uploadedFiles: Math.max(0, Math.floor(stats.uploadedFiles)),
    droppedFiles: Math.max(0, Math.floor(stats.droppedFiles)),
    failedFiles: Math.max(0, Math.floor(stats.failedFiles)),
  };
  await prisma.activity
    .create({
      data: {
        projectId,
        type: "SYSTEM",
        body: `Culled on upload: kept ${s.keptSets} of ${s.totalSets} sets — ${s.uploadedFiles} JPGs uploaded, ${s.droppedFiles} culled before upload${s.failedFiles ? `, ${s.failedFiles} FAILED (photographer should retry)` : ""}.`,
      },
    })
    .catch(() => {});
  // The folder-count status sync (hourly + on project view) sees the files and
  // flips the photo deliverables — no manual tick needed.
  const { revalidatePath } = await import("next/cache");
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
