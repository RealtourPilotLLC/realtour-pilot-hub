"use server";

import { prisma } from "@/lib/prisma";
import { requireShootAccess } from "@/lib/auth/guards";
import { actualFolderPaths } from "@/lib/dropboxFolders";

// ---------------------------------------------------------------------------
// Cull-BEFORE-upload (Jordan, Jul 2026): the photographer picks their card's
// JPGs in the portal, groups collapse into bracket sets, they drop the junk,
// and ONLY the keepers upload — straight from their browser to Dropbox via
// temporary upload links (the hub's token never reaches the client, and the
// bytes never touch our server, so it's as fast as their connection allows).
// ---------------------------------------------------------------------------

const MAX_FILES_PER_BATCH = 400;
const LINK_CONCURRENCY = 12; // parallel link mints — gentle on Dropbox burst limits

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    // dropboxFolder: the engine's memory of where THIS job's folder really is.
    // The convention path is shared by a same-street re-shoot (1946 Rowan St,
    // Sep 3 + Sep 9), so the in-page upload would have committed the second
    // shoot's frames into the first job's 01-RAW-Photos (audit, Sep 8).
    select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } } },
  });
  if (!project) return { ok: false, message: "Project not found." };
  const rawPhotos = actualFolderPaths(project).rawPhotos;

  const { dbx, dropboxAccessToken, dropboxCreateFolder, DropboxError } = await import("@/lib/integrations/dropbox");
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

  for (let i = 0; i < cleaned.length; i += LINK_CONCURRENCY) {
    const chunk = cleaned.slice(i, i + LINK_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (c) => {
        // Ride out 429s / 5xx / network blips with backoff — one flaky call out
        // of hundreds used to reject the whole Promise.all and abort the entire
        // upload with a blind "Dropbox refused the upload links".
        for (let attempt = 0; ; attempt++) {
          try {
            const r = await dbx<{ link: string }>(
              "files/get_temporary_upload_link",
              { commit_info: { path: `${rawPhotos}/${c.safe}`, mode: "add", autorename: true, mute: true } },
              token,
            );
            return { ok: true as const, name: c.original, url: r.link };
          } catch (e) {
            const status = e instanceof DropboxError ? e.status : undefined; // undefined = network hiccup
            const retriable = status === undefined || status === 429 || (status ?? 0) >= 500;
            if (retriable && attempt < 3) {
              await sleep(500 * (attempt + 1));
              continue;
            }
            return { ok: false as const, error: e instanceof Error ? e.message : "unknown error" };
          }
        }
      }),
    );
    const bad = results.find((r) => !r.ok);
    if (bad && !bad.ok) {
      return { ok: false, message: `Dropbox said: ${bad.error.slice(0, 120)} — nothing was lost, press Upload again in a minute.` };
    }
    for (const r of results) if (r.ok) links.push({ name: r.name, url: r.url });
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
  // Fire the status sync NOW — this is the upload flow photographers actually
  // use (12 uses/30d, audit), and waiting for the hourly cron meant the
  // field→SHOT→editor-handoff sat idle for up to an hour after every upload.
  // Best-effort + non-blocking: the photographer's confirmation never waits on it.
  import("@/lib/projectStatus")
    .then(({ syncProjectStatuses }) => syncProjectStatuses({ projectId }))
    .catch(() => {});
  const { revalidatePath } = await import("next/cache");
  revalidatePath(`/upload/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
