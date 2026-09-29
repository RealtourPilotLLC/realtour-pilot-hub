import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// TAKE A JOB OFF THE EDITING ROOM, AND BE ABLE TO PUT IT BACK.
//
// Jordan, Sep 18 2026: "I'd like a way to delete the jobs from the editing
// room, with a way to bring them back if needed. I don't want it to delete
// anything other than the editing task. I don't want it to affect anything else
// in our system. Maybe keep it stored for 7 days after being deleted with the
// ability to bring it back."
//
// NOTHING IS DELETED, AND THE WORD IS DELIBERATE. "Removed" is a marker in
// AppSetting — the same shape queueWaiting.ts uses for a hold, and for the same
// reason: a set of project ids one query consults, touching no column any other
// engine reads. The project keeps its status, its deliverables, its cuts, its
// verdicts, its delivery stamps, its Aryeo order and its client. Take the
// marker away and the row is back exactly as it was.
//
// THE ONE THING IT DOES TOUCH is the edit_video task, because that is what
// Jordan asked it to touch and because a job off the board with a live task on
// it is the worst of both — invisible to the person who would work it and still
// counted by everything that counts open work. The task is CANCELLED, never
// deleted, and its state is written into the marker first so a restore can put
// it back byte for byte: the status it held, who it was assigned to, and
// whether that assignment was a human's (`assignedManually`, the invariant
// every engine in this codebase respects).
//
// SEVEN DAYS is the RESTORE window, not the hide duration. The row goes the
// moment it is removed and stays gone; what expires is the ability to undo it
// from the screen. The marker itself is kept for ever — who removed what, when
// and why is a record, and this codebase retires rather than deletes.
// ---------------------------------------------------------------------------

export const QUEUE_REMOVED_PREFIX = "editing-removed:";
export const queueRemovedKey = (projectId: string) => `${QUEUE_REMOVED_PREFIX}${projectId}`;

/** How long a removal can be undone from the Editing Room. */
export const RESTORE_WINDOW_DAYS = 7;
const DAY = 86_400_000;

/** What the edit task looked like at the moment of removal, so a restore is a
 *  restore and not a guess. Null when the job had no edit task at all. */
export type RemovedTask = {
  status: string;
  assignedKey: string | null;
  assignedManually: boolean;
} | null;

export type QueueRemoval = {
  projectId: string;
  by: string | null;
  at: Date;
  note: string | null;
  task: RemovedTask;
  /** Set once somebody brought it back — the marker stays as the record. */
  restoredAt: Date | null;
  restoredBy: string | null;
  /** How it came back when it was NOT the restore button (Sep 28 review fix):
   *  "added to the Editing Room again", "a client asked for changes to the
   *  video"… Null for the restore itself and for every older marker. */
  restoredHow?: string | null;
};

function parse(key: string, value: string, fallbackAt: Date): QueueRemoval | null {
  const projectId = key.slice(QUEUE_REMOVED_PREFIX.length);
  if (!projectId) return null;
  const base: QueueRemoval = { projectId, by: null, at: fallbackAt, note: null, task: null, restoredAt: null, restoredBy: null };
  try {
    const v = JSON.parse(value) as Partial<{
      by: string | null; at: string; note: string | null; task: RemovedTask;
      restoredAt: string | null; restoredBy: string | null; restoredHow: string | null;
    }>;
    const at = v.at ? new Date(v.at) : null;
    const restoredAt = v.restoredAt ? new Date(v.restoredAt) : null;
    return {
      ...base,
      by: v.by ?? null,
      at: at && Number.isFinite(at.getTime()) ? at : fallbackAt,
      note: v.note ?? null,
      task: v.task ?? null,
      restoredAt: restoredAt && Number.isFinite(restoredAt.getTime()) ? restoredAt : null,
      restoredBy: v.restoredBy ?? null,
      restoredHow: v.restoredHow ?? null,
    };
  } catch {
    // An unreadable value still means REMOVED — the marker's existence is the
    // fact, and its contents are only how well we can undo it.
    return base;
  }
}

export function serialize(r: Omit<QueueRemoval, "projectId">): string {
  return JSON.stringify({
    by: r.by,
    at: r.at.toISOString(),
    note: r.note,
    task: r.task,
    ...(r.restoredAt ? { restoredAt: r.restoredAt.toISOString(), restoredBy: r.restoredBy, ...(r.restoredHow ? { restoredHow: r.restoredHow } : {}) } : {}),
  });
}

export function restorable(r: QueueRemoval, now = new Date()): boolean {
  return !r.restoredAt && now.getTime() - r.at.getTime() <= RESTORE_WINDOW_DAYS * DAY;
}

/** Every removal ever recorded, newest first. One query. */
export async function allRemovals(): Promise<QueueRemoval[]> {
  const rows = await prisma.appSetting
    .findMany({ where: { key: { startsWith: QUEUE_REMOVED_PREFIX } }, select: { key: true, value: true, updatedAt: true } })
    .catch(() => []);
  return rows
    .map((r) => parse(r.key, r.value, r.updatedAt))
    .filter((r): r is QueueRemoval => !!r)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** The ids the Editing Room must not show. Restored removals are not in it. */
export async function removedProjectIds(): Promise<Set<string>> {
  return new Set((await allRemovals()).filter((r) => !r.restoredAt).map((r) => r.projectId));
}

/** One removal, or null. `db` (Sep 28 2026, R01): startEditing reads the
 *  marker inside its switch transaction, after the job's row is locked — a
 *  job taken off the Editing Room can't be started until it is brought back.
 *  Inside a transaction a failed read is NOT swallowed into "not removed": on
 *  Postgres that transaction is already aborted, and the Start fails safe. */
export async function removalFor(projectId: string, db?: Prisma.TransactionClient): Promise<QueueRemoval | null> {
  const read = (db ?? prisma).appSetting.findUnique({ where: { key: queueRemovedKey(projectId) }, select: { key: true, value: true, updatedAt: true } });
  const row = db ? await read : await read.catch(() => null);
  return row ? parse(row.key, row.value, row.updatedAt) : null;
}

/** Off the Editing Room right now: removed, and not brought back. The one
 *  definition the Start rule and the queue share (removedProjectIds). */
export function isRemoved(r: QueueRemoval | null | undefined): boolean {
  return !!r && !r.restoredAt;
}

// ---------------------------------------------------------------------------
// A REMOVAL ENDS WHEN VIDEO WORK COMES BACK BY ANOTHER DOOR (review fix, Sep
// 28 2026).
//
// R01 made "taken off the Editing Room" refuse a Start until the job came
// back (editorWork.startBlock), and the only thing that ever set restoredAt
// was the restore button — which refuses after 7 days and tells the office to
// "Add it to the queue again". That re-add never touched the marker. The
// review walked it: remove, wait 8 days, re-add for Kim — the card OPEN and
// hers, the marker still live, her Start refused "bring it back before
// starting it", the office's Start refused the same way, a second restore
// refused again. No way out. And inside the 7 days, following those words
// after re-adding for John, the restore put the card back to Kim from the
// record — undoing the office's own re-add.
//
// So every door that puts video work back on a removed job ends the removal,
// here, in one place: the queue's re-add (both rails), a client's video
// revision, a cut sent back for another round, the override moving a
// delivered job back to work. The marker is KEPT (the record, as the restore
// keeps it) with restoredAt stamped and restoredHow naming the door, so the
// queue shows the job again and the Start rule stops refusing it — one fact,
// read the same way by both (isRemoved). Written under the job's Project row
// lock, the same order removeFromEditorQueue writes it in, so a remove and a
// re-add never interleave.
// ---------------------------------------------------------------------------

/** Inside a transaction that already holds the job's Project row. True when a
 *  live removal was ended. */
export async function endRemovalTx(
  tx: Prisma.TransactionClient,
  projectId: string,
  opts: { by: string | null; how: string },
): Promise<boolean> {
  const r = await removalFor(projectId, tx);
  if (!r || !isRemoved(r)) return false;
  const at = new Date();
  await tx.appSetting.update({
    where: { key: queueRemovedKey(projectId) },
    data: { value: serialize({ by: r.by, at: r.at, note: r.note, task: r.task, restoredAt: at, restoredBy: opts.by, restoredHow: opts.how }) },
  });
  await tx.activity.create({
    data: {
      projectId,
      type: "SYSTEM",
      body: `Back on the Editing Room — ${opts.how}${opts.by ? ` (${opts.by})` : ""}. It had been taken off${r.by ? ` by ${r.by}` : ""}.`.slice(0, 500),
    },
  });
  return true;
}

/** The same, on its own: a cheap read first (almost no job was ever removed),
 *  then the job's row lock and the write. Never throws — every caller's own
 *  write has already landed and must not be undone by this; a failure is
 *  logged, and the office can still restore or re-add. */
export async function endRemoval(projectId: string, opts: { by: string | null; how: string }): Promise<boolean> {
  try {
    if (!isRemoved(await removalFor(projectId))) return false;
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR NO KEY UPDATE`;
      return endRemovalTx(tx, projectId, opts);
    });
  } catch (e) {
    console.error("[queueRemoved] could not end the removal", projectId, e);
    return false;
  }
}
