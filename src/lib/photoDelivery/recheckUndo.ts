import "server-only";

import { prisma } from "@/lib/prisma";
import { etDateTime } from "@/lib/datetime";
import { logJobEvent } from "./jobState";
import { FREE_RECHECK_ACTION, FREE_RECHECK_UNDONE, labelRoom, readProgress } from "./autohdrCheck";

// ---------------------------------------------------------------------------
// UNDO "CHECK AGAIN" (Oct 27 2026).
//
// Jordan, on 913 Lakeview: "Check again. Oh. Wish I could undo that. So that
// would be nice to be able to undo." Check again marks the free-checked photos
// not inspected (the checklist then reads "3 photos not inspected") and the
// next pass checks them again. Undo, for a day after the press and while no
// one has decided anything from the new check:
//   · the request is marked undone (a check not run yet never runs);
//   · photos unchanged since are inspected again at their version;
//   · a check that ran since is set aside (its run says "Undone by <name>",
//     its findings superseded), and the earlier check's findings, rooms and
//     verdict are back;
//   · the home's prep and the job's verdict are read again from the earlier
//     check (prep.refreshPrepMode, fixPolicy.refreshVerdict).
// Nothing is sent and nothing is charged.
// ---------------------------------------------------------------------------

/** How long after the press Undo is offered. */
export const RECHECK_UNDO_HOURS = 24;

export type RecheckUndo = { at: string; by: string; ran: boolean; words: string };

type Request = { id: string; at: Date; actor: string; cleared: { id: string; hash: string | null }[] };

async function lastRequest(jobId: string, now: Date): Promise<Request | null> {
  const e = await prisma.photoJobEvent.findFirst({
    where: { jobId, action: { in: [FREE_RECHECK_ACTION, FREE_RECHECK_UNDONE] }, at: { gte: new Date(now.getTime() - RECHECK_UNDO_HOURS * 3_600_000) } },
    orderBy: { at: "desc" },
    select: { id: true, at: true, actor: true, action: true, dataJson: true },
  });
  if (!e || e.action !== FREE_RECHECK_ACTION) return null;
  let cleared: Request["cleared"] = [];
  try {
    const d = JSON.parse(e.dataJson ?? "{}") as { cleared?: unknown };
    if (Array.isArray(d.cleared)) cleared = d.cleared.filter((x): x is { id: string; hash: string | null } => !!x && typeof (x as { id?: unknown }).id === "string");
  } catch { /* an older request: nothing to put back but the run */ }
  return { id: e.id, at: e.at, actor: e.actor, cleared };
}

const DECIDED = ["IGNORED", "FALSE_POSITIVE", "OVERRIDDEN", "SENT_TO_EDITOR", "RESHOOT_REQUESTED", "APPROVED_FIX", "FIXING", "FIXED"];
const hubCall = (by: string | null) => !by || /^(hub\b|hub:|auto-|free second look|fix-runner|system|autohdr-check|geometry)/i.test(by);

/** What Undo would do, or null when there is nothing to undo (the job page's button). */
export async function recheckUndoOf(jobId: string, now: Date = new Date()): Promise<RecheckUndo | null> {
  const req = await lastRequest(jobId, now);
  if (!req) return null;
  const earlier = await prisma.photoQcRun.count({ where: { jobId, trigger: "AUTOHDR_CHECK", status: "DONE", startedAt: { lt: req.at } } });
  if (!earlier) return null;
  const ran = (await prisma.photoQcRun.count({ where: { jobId, trigger: "AUTOHDR_CHECK", startedAt: { gt: req.at } } })) > 0;
  return { at: req.at.toISOString(), by: req.actor, ran, words: `${req.actor} pressed Check again ${etDateTime(req.at)}.` };
}

/** Undo the last "Check again" (see above). Never throws. */
export async function undoFreeRecheck(jobId: string, by: string, now: Date = new Date()): Promise<{ ok: boolean; message: string }> {
  try {
    const who = by.trim().slice(0, 120) || "staff";
    const req = await lastRequest(jobId, now);
    if (!req) return { ok: false, message: "There is no Check again to undo (it was undone already, or it was more than a day ago)." };
    const prev = await prisma.photoQcRun.findFirst({ where: { jobId, trigger: "AUTOHDR_CHECK", status: "DONE", startedAt: { lt: req.at } }, orderBy: { startedAt: "desc" }, select: { id: true, verdict: true, checksJson: true } });
    if (!prev) return { ok: false, message: "There is no earlier check to go back to." };
    const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { leaseOwner: true, leaseUntil: true } });
    if (job?.leaseOwner === "autohdr-check" && job.leaseUntil && job.leaseUntil > now) return { ok: false, message: "The photo check is looking at the photos right now. Try again in a minute." };
    const newer = await prisma.photoQcRun.findMany({ where: { jobId, trigger: "AUTOHDR_CHECK", startedAt: { gt: req.at } }, select: { id: true } });
    const newerIds = newer.map((r) => r.id);
    if (newerIds.length) {
      const decided = await prisma.photoQcFinding.findMany({ where: { qcRunId: { in: newerIds }, status: { in: DECIDED } }, select: { decidedBy: true } });
      if (decided.some((d) => !hubCall(d.decidedBy))) return { ok: false, message: "Someone already decided an issue the new check found, so it stays. Decide the rest on the Issues tab." };
    }
    // The photos the request marked not inspected, unchanged since: inspected again at that version.
    const photos = req.cleared.length ? await prisma.photoAsset.findMany({ where: { id: { in: req.cleared.map((c) => c.id) }, jobId }, select: { id: true, contentHash: true } }) : [];
    const back = photos.filter((p) => { const c = req.cleared.find((x) => x.id === p.id); return !!c?.hash && c.hash === p.contentHash; });
    await prisma.$transaction([
      prisma.photoQcFinding.updateMany({ where: { qcRunId: { in: newerIds }, status: { notIn: ["SUPERSEDED"] } }, data: { status: "SUPERSEDED", statusReason: `check undone by ${who}` } }),
      ...newerIds.map((runId) => prisma.photoQcFinding.updateMany({ where: { jobId, status: "SUPERSEDED", statusReason: `re-checked in run ${runId}` }, data: { status: "OPEN", statusReason: null } })),
      prisma.photoQcRun.updateMany({ where: { id: { in: newerIds } }, data: { status: "FAILED", error: `Undone by ${who}: the earlier check stands.`, finishedAt: now } }),
      ...back.map((p) => prisma.photoAsset.updateMany({ where: { id: p.id, contentHash: p.contentHash }, data: { inspectedHash: p.contentHash } })),
      prisma.photoJob.update({ where: { id: jobId }, data: { lastQcRunId: prev.id, ...(prev.verdict ? { qcVerdict: prev.verdict } : {}) } }),
    ]);
    await logJobEvent(jobId, who, FREE_RECHECK_UNDONE, { request: req.id, runs: newerIds, inspectedAgain: back.length });
    if (newerIds.length) {
      // The earlier check's rooms, light and view on its photos (the new one may have relabeled them).
      const p = readProgress(prev.checksJson);
      for (const [photoId, room] of Object.entries(p.rooms)) await labelRoom(photoId, room, p.light?.[photoId], p.features?.[photoId], p.view?.[photoId]).catch(() => {});
      await (await import("./prep")).refreshPrepMode(jobId).catch(() => null);
    }
    await (await import("./fixPolicy")).refreshVerdict(jobId, who).catch(() => {});
    return { ok: true, message: newerIds.length ? "Undone. The earlier check's results are back." : "Undone. The check will not run again." };
  } catch (e) {
    console.error("[photo-delivery] undoing Check again failed", jobId, e);
    return { ok: false, message: "Undo did not go through. Reload the page and try again." };
  }
}
