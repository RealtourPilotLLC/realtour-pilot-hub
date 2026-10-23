import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// HAVE THE RAWS ARRIVED? (Oct 23 2026, Jordan and Kyle's huddle, item 12:
// today's jobs read "Editing" while the photos were not uploaded yet.)
//
// A photo job is opened at EDITING from the shoot on, so its stage alone can't
// say whether the raws are in. They are in once an upload went on to AutoHDR:
// an intake batch past WAITING (sent, landing, processing, done, linked to a
// shoot made by hand, or failed after sending), or the job is linked to an
// AutoHDR shoot, or edited photos were read. Files still arriving (a WAITING
// batch, settling before it is sent) are not in yet. Before that every screen
// says "Waiting for upload" (holding.WAITING_FOR_UPLOAD): the Photo Delivery
// board and the job page, the Shoots board, Kyle's desk and the photos-late
// alert. One read here for all of them.
// ---------------------------------------------------------------------------

/** Of these projects, the ones with an upload that went on to AutoHDR. null: the read failed (then nothing is called "waiting"). */
export async function rawsSentFor(projectIds: string[]): Promise<Set<string> | null> {
  const ids = [...new Set(projectIds)].filter(Boolean);
  if (!ids.length) return new Set();
  return prisma.photoIntakeBatch
    .groupBy({ by: ["projectId"], where: { projectId: { in: ids }, state: { not: "WAITING" } }, _count: { _all: true } })
    .then((rows) => new Set(rows.map((r) => r.projectId)))
    .catch(() => null);
}

/** The projects (of these jobs in Editing with no photos read and no AutoHDR shoot linked) still waiting for their upload. Empty when the read failed. */
export async function waitingForUploadOf(jobs: { projectId: string; stage: string; finalsCount: number | null; autohdrPhotoshootId?: number | null }[]): Promise<Set<string>> {
  const candidates = jobs.filter((j) => j.stage === "EDITING" && !j.finalsCount && !j.autohdrPhotoshootId).map((j) => j.projectId);
  if (!candidates.length) return new Set();
  const sent = await rawsSentFor(candidates);
  return sent ? new Set(candidates.filter((id) => !sent.has(id))) : new Set();
}
