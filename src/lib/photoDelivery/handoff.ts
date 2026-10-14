import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { actualFolderPaths } from "@/lib/dropboxFolders";
import { dbx, dropboxCreateFolder, dropboxDelete, dropboxListFolder } from "@/lib/integrations/dropbox";
import { deliveryOrderFor } from "./delivery";
import { logJobEvent } from "./jobState";
import { photoDeliverySettings } from "./settings";

// ---------------------------------------------------------------------------
// READY FOR ARYEO: THE FINISHED PHOTOS, NUMBERED, IN ONE FOLDER (Oct 14 2026).
//
// Jordan: "when the photos are done going through QC and fixes, and then the
// final QC, that they're able to be downloaded and there's a button to open
// the listing on Aryeo so Kyle can just download them, click the Aryeo button,
// upload them to Aryeo and send them."
//
// A full-size gallery (~250 MB) is too big to stream out of a hub function, so
// Dropbox fetches the files itself (files/save_url, the same call the Review
// Room uses): every photo in the delivery order, its CURRENT version (the AI
// fixes included), named "01-Front-Exterior.jpg", "02-Living.jpg", … into the
// job's 06-Ready-for-Aryeo folder. The deliver panel's first step opens that
// folder (Dropbox's own Download button gives one zip); the second opens the
// listing in Aryeo. Internal only: Dropbox links never go to clients.
//
// When: the hub's own AutoHDR shoots, once nothing is still being fixed and the
// checks are done (QC_REVIEW or READY). Again whenever the set changes (a fix,
// a photo left out, a new order): a fingerprint of names + versions decides.
// ---------------------------------------------------------------------------

export const READY_FOLDER = "06-Ready-for-Aryeo";

type Photo = { id: string; sourceKind: string; sourceUrl: string | null; sourceRef: string | null; dropboxPath: string | null; contentHash: string | null; autohdrVersionUuid: string | null };

async function urlFor(p: Photo): Promise<string | null> {
  if (p.sourceKind === "AUTOHDR") {
    const { freshAutohdrUrl } = await import("./display");
    return freshAutohdrUrl(p).catch(() => null); // free: the photo was downloaded once already
  }
  if (p.sourceKind === "ARYEO") return p.sourceUrl;
  return null;
}

export async function readyFolderFor(jobId: string): Promise<string | null> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  if (!job) return null;
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } } } });
  if (!project?.client) return null;
  return `${actualFolderPaths({ ...project, client: project.client }).listing}/${READY_FOLDER}`;
}

/** Stage the finished photos for the Aryeo upload. `force` restages even when nothing changed. */
export async function stageForAryeo(jobId: string, opts: { force?: boolean; by?: string } = {}): Promise<{ ok: boolean; message: string; staged: number; folder: string | null }> {
  const folder = await readyFolderFor(jobId);
  if (!folder) return { ok: false, message: "This job has no Dropbox folder.", staged: 0, folder: null };
  const order = await deliveryOrderFor(jobId);
  if (!order.length) return { ok: false, message: "No photos in the delivery yet.", staged: 0, folder };
  const photos = new Map((await prisma.photoAsset.findMany({ where: { id: { in: order.map((o) => o.photoId) } }, select: { id: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true, contentHash: true, autohdrVersionUuid: true } })).map((p) => [p.id, p]));
  const fingerprint = createHash("sha256").update(order.map((o) => `${o.deliveryName}:${photos.get(o.photoId)?.autohdrVersionUuid ?? photos.get(o.photoId)?.contentHash ?? ""}`).join("\n")).digest("hex").slice(0, 24);
  if (!opts.force) {
    const last = await prisma.photoJobEvent.findFirst({ where: { jobId, actor: "ready-for-aryeo" }, orderBy: { at: "desc" }, select: { dataJson: true } });
    if (last?.dataJson?.includes(fingerprint)) return { ok: true, message: "Already up to date.", staged: 0, folder };
  }
  // A clean folder: last time's names may not match this order.
  await dropboxDelete(folder).catch(() => {});
  await dropboxCreateFolder(folder).catch(() => {});
  let staged = 0;
  const missing: string[] = [];
  for (const o of order) {
    const p = photos.get(o.photoId);
    if (!p) continue;
    const path = `${folder}/${o.deliveryName}`;
    try {
      if (p.sourceKind === "DROPBOX" && p.dropboxPath) {
        await dbx("files/copy_v2", { from_path: p.dropboxPath, to_path: path, autorename: false });
      } else {
        const url = await urlFor(p);
        if (!url) { missing.push(o.name); continue; }
        await dbx("files/save_url", { path, url });
      }
      staged++;
    } catch (e) {
      missing.push(o.name);
      console.warn("ready-for-aryeo: one photo failed", jobId, o.name, (e as Error).message.slice(0, 160));
    }
  }
  await prisma.photoJob.update({ where: { id: jobId }, data: { deliveryPath: folder, deliveryStagedAt: new Date() } });
  await logJobEvent(jobId, "ready-for-aryeo", `${staged} photo${staged === 1 ? "" : "s"} put in ${READY_FOLDER}, numbered in delivery order${missing.length ? ` (${missing.length} could not be copied: ${missing.slice(0, 5).join(", ")})` : ""}${opts.by ? ` (asked by ${opts.by})` : ""}`, { fingerprint, staged, missing });
  return { ok: staged > 0, message: missing.length ? `${staged} photos are being copied; ${missing.length} could not be (${missing.slice(0, 3).join(", ")}).` : `${staged} photos are being copied into ${READY_FOLDER}, numbered in order. Dropbox finishes in a minute or two.`, staged, folder };
}

/** How the folder is doing, for the deliver panel (one Dropbox list call). */
export async function readyFolderState(jobId: string, expected: number): Promise<{ folder: string; files: number; ready: boolean; stagedAt: string | null } | null> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { deliveryPath: true, deliveryStagedAt: true } });
  if (!job?.deliveryPath || !job.deliveryPath.endsWith(READY_FOLDER)) return null;
  const files = await dropboxListFolder(job.deliveryPath).then((es) => es.filter((e) => e.tag === "file").length).catch(() => 0);
  return { folder: job.deliveryPath, files, ready: expected > 0 && files >= expected, stagedAt: job.deliveryStagedAt?.toISOString() ?? null };
}

/** Cron: stage hub shoots that are done with QC and fixes (and restage after a change). */
export async function stageReadyJobs(opts: { max?: number } = {}): Promise<{ staged: string[]; skipped?: string }> {
  const settings = await photoDeliverySettings();
  if (!settings.enabled || !settings.showAutohdrPhotos) return { staged: [], skipped: "showing AutoHDR photos is switched off" };
  const jobs = await prisma.photoJob.findMany({
    where: { stage: { in: ["QC_REVIEW", "READY"] }, photos: { some: { status: "ACTIVE", sourceKind: "AUTOHDR" } }, stageChangedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    select: { id: true },
    take: 10,
  });
  const staged: string[] = [];
  for (const j of jobs) {
    if (staged.length >= (opts.max ?? 2)) break;
    // Done = nothing queued or running, the second look finished, and the photos downloaded.
    const busy = await prisma.photoFixOperation.count({ where: { jobId: j.id, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
    const looking = await prisma.photoQcFinding.count({ where: { jobId: j.id, status: "OPEN", source: "AHDR", arbitration: "NOT_REQUIRED" } });
    const notShown = await prisma.photoAsset.count({ where: { jobId: j.id, status: "ACTIVE", sourceKind: "AUTOHDR", sourceUrl: null } });
    const planned = settings.autoFix ? await prisma.photoJobEvent.count({ where: { jobId: j.id, actor: "auto-fix" } }) : 1;
    if (busy || looking || !planned || notShown > 0 && !(await anyDownloaded(j.id))) continue;
    const r = await stageForAryeo(j.id).catch((e) => ({ ok: false, message: (e as Error).message, staged: 0, folder: null }));
    if (r.staged) staged.push(j.id);
  }
  return { staged };
}

async function anyDownloaded(jobId: string): Promise<boolean> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  const b = job ? await prisma.photoIntakeBatch.findFirst({ where: { projectId: job.projectId, state: "DONE" }, select: { photosJson: true } }) : null;
  return !!b?.photosJson?.includes('"downloaded":true');
}
