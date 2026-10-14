import "server-only";

import { prisma } from "@/lib/prisma";
import { autohdr, autohdrConfigured, type AutohdrPhotoshoot } from "@/lib/integrations/autohdr";
import { logJobEvent } from "./jobState";

// ---------------------------------------------------------------------------
// FIND THE JOB'S AUTOHDR SHOOT (docs/photo-delivery/01 §5.1.6, read-only).
//
// The hub never creates an AutoHDR shoot for photos that are already edited
// (that would charge twice). Fixes run on the shoot that AutoHDR already made
// for the job, so the hub has to FIND it: listPhotoshoots returns every shoot
// of the last 7 days (AutoHDR keeps nothing older), without a source field.
// A shoot is this job's when its `address` names the job's street (the
// watcher names a shoot after the job folder, "<Street> (<Client>)"; other
// routes name it after the address), it was created after the shoot date,
// and it is the only such shoot. Then each hub photo is matched to an
// AutoHDR photo:
//   · by name (a Dropbox final keeps AutoHDR's filename), else
//   · by position, only when the counts agree exactly (Aryeo's imported
//     files are "<Street> (N of M).jpg", in AutoHDR's gallery order).
// Anything ambiguous is left unlinked and the Fix Cart says so: a fix sent to
// the wrong photo would spend a credit for nothing.
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const STREET_WORDS: Record<string, string> = { street: "st", avenue: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct", boulevard: "blvd", place: "pl", circle: "cir", terrace: "ter", highway: "hwy", parkway: "pkwy" };
const streetKey = (s: string) =>
  norm(s)
    .split(" ")
    .map((w) => STREET_WORDS[w] ?? w)
    .join(" ");

export function shootMatchesStreet(shootAddress: string | null | undefined, street: string): boolean {
  if (!shootAddress || !street) return false;
  const a = streetKey(shootAddress);
  const b = streetKey(street);
  if (!b || b.length < 4) return false;
  return a.startsWith(b) || a.includes(` ${b}`) || a === b;
}

const N_OF_M = /\((\d+) of (\d+)\)\.[a-z0-9]+$/i;

/** Link one job to its AutoHDR shoot and photos. Free (reads only). */
export async function linkAutohdrShoot(jobId: string, opts: { shoots?: AutohdrPhotoshoot[] } = {}): Promise<{ linked: boolean; photos: number; note: string }> {
  if (!(await autohdrConfigured())) return { linked: false, photos: 0, note: "AutoHDR API not connected" };
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true, autohdrPhotoshootId: true } });
  if (!job) return { linked: false, photos: 0, note: "job not found" };
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true, addressLine: true, shootDate: true } });
  const street = project?.addressLine || project?.title.split(",")[0] || "";
  let shootId = job.autohdrPhotoshootId;
  if (!shootId) {
    const shoots = opts.shoots ?? (await autohdr.listPhotoshoots());
    const after = project?.shootDate ? project.shootDate.getTime() - 12 * 3_600_000 : 0;
    const candidates = shoots.filter((s) => shootMatchesStreet(s.address, street) && (!s.created_at || Date.parse(s.created_at) >= after));
    if (candidates.length !== 1) {
      return { linked: false, photos: 0, note: candidates.length ? `${candidates.length} AutoHDR shoots match "${street}", none chosen` : `no AutoHDR shoot in the last 7 days matches "${street}"` };
    }
    const s = candidates[0];
    shootId = s.photoshoot_id;
    await prisma.photoJob.update({
      where: { id: jobId },
      data: { autohdrPhotoshootId: s.photoshoot_id, autohdrShootName: s.address ?? null, autohdrLinkedAt: new Date(), autohdrCreatedAt: s.created_at ? new Date(s.created_at) : null },
    });
    await logJobEvent(jobId, "autohdr-link", `linked to AutoHDR shoot ${s.photoshoot_id} ("${s.address ?? ""}")`);
  }
  const remote = await autohdr.listPhotos(shootId);
  const photos = await prisma.photoAsset.findMany({ where: { jobId, status: { in: ["ACTIVE", "EXCLUDED"] } }, orderBy: { sequence: "asc" }, select: { id: true, name: true, sourceKind: true } });
  const byName = new Map(remote.filter((r) => r.name).map((r) => [norm(r.name!), r]));
  let linked = 0;
  for (const p of photos) {
    let hit = byName.get(norm(p.name));
    if (!hit) {
      const m = N_OF_M.exec(p.name);
      if (m && Number(m[2]) === remote.length) hit = remote[Number(m[1]) - 1];
    }
    if (!hit) continue;
    await prisma.photoAsset.update({ where: { id: p.id }, data: { autohdrImageUuid: hit.image_uuid, autohdrVersionUuid: hit.image_version_uuid } });
    linked++;
  }
  await logJobEvent(jobId, "autohdr-link", `${linked} of ${photos.length} photos matched to AutoHDR (${remote.length} in the shoot)`);
  return { linked: true, photos: linked, note: `${linked}/${photos.length} photos matched` };
}

/** Link the open jobs that still lack a shoot (one listPhotoshoots call per pass). */
export async function linkOpenJobs(max = 6): Promise<{ tried: number; linked: number }> {
  if (!(await autohdrConfigured())) return { tried: 0, linked: 0 };
  const jobs = await prisma.photoJob.findMany({
    where: { autohdrPhotoshootId: null, stage: { in: ["EDITED", "QC_RUNNING", "QC_REVIEW", "READY", "ON_HOLD"] }, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    select: { id: true },
    take: max,
  });
  if (!jobs.length) return { tried: 0, linked: 0 };
  const shoots = await autohdr.listPhotoshoots();
  let linked = 0;
  for (const j of jobs) {
    const r = await linkAutohdrShoot(j.id, { shoots }).catch(() => ({ linked: false }));
    if (r.linked) linked++;
  }
  return { tried: jobs.length, linked };
}
