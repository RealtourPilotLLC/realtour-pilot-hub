import "server-only";

import { prisma } from "@/lib/prisma";
import { actualFolderPaths } from "@/lib/dropboxFolders";
import { shootPendingFor } from "@/lib/projectStatus";
import { dropboxListFolder, DropboxError } from "@/lib/integrations/dropbox";

// ---------------------------------------------------------------------------
// Per-job raw-photo counting for AutoHDR cost (owner formula, 2026-07-22):
//   • photos are shot as 5-bracket JPG sets → merged to ONE finished photo
//   • drone shots are SINGLE JPGs (filenames DJI_*)
//   • finished = (rawCount − droneCount) / 5 + droneCount
//   • photo-editing cost = finished × $0.50
// Counts come from the project's Dropbox 01-RAW-Photos folder and are persisted
// on Project so the Jobs tab never has to hit Dropbox at render time.
// ---------------------------------------------------------------------------

const IMG_RE = /\.(jpe?g|png|dng|arw|raw|heic|tiff?)$/i;
const DRONE_RE = /^dji|dji[_-]|drone|mavic|air ?2|^m3[_-]/i;

export function finishedPhotos(raw: number, drone: number): number {
  const bracketed = Math.max(0, raw - drone);
  return Math.round(bracketed / 5) + drone;
}

/** Count one project's raw folder and persist the result. Returns null when
 *  Dropbox couldn't be read (auth/rate-limit) — never stores a bad zero — and
 *  null, untouched, for a shoot that hasn't happened yet. */
export async function countProjectPhotos(projectId: string): Promise<{ raw: number; drone: number } | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true,
      client: { select: { name: true } },
      appointments: { select: { status: true, startAt: true } },
    },
  });
  if (!p || !p.client) return null;
  // A shoot that hasn't happened has no raws of its own — whatever sits under
  // its name is another job's. The Sep 9 1946 Rowan St re-shoot was billed the
  // Sep 3 job's 84 raws (AutoHDR cost double-counted, Harrison's culling KPI
  // scored against them) two days before the appointment (Sep 8 2026 audit).
  if (shootPendingFor(p)) return null;
  // The job's OWN folder (a re-shoot's dated name, a rescheduled shoot's real
  // month) — the convention path is where the count went wrong.
  const paths = actualFolderPaths({ ...p, client: p.client });
  try {
    // Recursive: same counter semantics as the portal + status engine, so the
    // billed count can't disagree with the over-budget chip (review).
    const entries = await dropboxListFolder(paths.rawPhotos, { recursive: true });
    const imgs = entries.filter((e) => e.tag === "file" && IMG_RE.test(e.name));
    const drone = imgs.filter((e) => DRONE_RE.test(e.name)).length;
    await prisma.project.update({
      where: { id: p.id },
      data: { rawPhotoCount: imgs.length, dronePhotoCount: drone, photoCountedAt: new Date() },
    });
    return { raw: imgs.length, drone };
  } catch (e) {
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) {
      // Folder genuinely doesn't exist → trustworthy zero.
      await prisma.project.update({ where: { id: p.id }, data: { rawPhotoCount: 0, dronePhotoCount: 0, photoCountedAt: new Date() } });
      return { raw: 0, drone: 0 };
    }
    return null; // auth/rate-limit/network — leave existing counts untouched
  }
}

/** Sweep recent shoots: count anything never counted, and re-count fresh jobs
 *  (files keep landing for a few days after the shoot). Bounded for cron. */
export async function sweepPhotoCounts(opts: { days?: number; max?: number } = {}): Promise<{ counted: number; skipped: number; failed: number }> {
  const days = opts.days ?? 21;
  const max = opts.max ?? 120;
  const since = new Date(Date.now() - days * 864e5);
  const recount = new Date(Date.now() - 10 * 864e5); // re-count jobs shot in the last 10 days
  const projects = await prisma.project.findMany({
    where: {
      // Shoots that have HAPPENED. The old open-ended `gte: since` swept every
      // upcoming shoot too, which is how a job two days out got a count (Sep 8 2026).
      shootDate: { gte: since, lte: new Date() },
      OR: [{ photoCountedAt: null }, { shootDate: { gte: recount } }],
    },
    orderBy: { shootDate: "desc" },
    take: max,
    select: { id: true },
  });
  let counted = 0, failed = 0;
  for (const p of projects) {
    const r = await countProjectPhotos(p.id);
    if (r) counted++; else failed++;
  }
  return { counted, skipped: 0, failed };
}
