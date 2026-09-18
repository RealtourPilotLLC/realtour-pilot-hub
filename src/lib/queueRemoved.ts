import "server-only";

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
};

function parse(key: string, value: string, fallbackAt: Date): QueueRemoval | null {
  const projectId = key.slice(QUEUE_REMOVED_PREFIX.length);
  if (!projectId) return null;
  const base: QueueRemoval = { projectId, by: null, at: fallbackAt, note: null, task: null, restoredAt: null, restoredBy: null };
  try {
    const v = JSON.parse(value) as Partial<{
      by: string | null; at: string; note: string | null; task: RemovedTask;
      restoredAt: string | null; restoredBy: string | null;
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
    ...(r.restoredAt ? { restoredAt: r.restoredAt.toISOString(), restoredBy: r.restoredBy } : {}),
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

/** One removal, or null. */
export async function removalFor(projectId: string): Promise<QueueRemoval | null> {
  const row = await prisma.appSetting
    .findUnique({ where: { key: queueRemovedKey(projectId) }, select: { key: true, value: true, updatedAt: true } })
    .catch(() => null);
  return row ? parse(row.key, row.value, row.updatedAt) : null;
}
