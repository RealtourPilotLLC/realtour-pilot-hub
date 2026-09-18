import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// MERGING TWO JOBS — the WORK moves, the ORDERS stay.
//
// Jordan, Sep 18 2026: "I should be able to merge projects together", scoped to
// the second-shoot case — "second order's deliverables join the first job. One
// Editing Room row, one delivery, two order lines" — with money explicitly
// untouched: "nothing moves, keep both".
//
// WHY THIS DOES NOT FUSE THE TWO ROWS, which is what "merge" usually means.
// Three reasons, and the first is decisive:
//
//   1. `prisma.project.create` exists in exactly ONE place in this codebase —
//      the Aryeo order import — and it is keyed on `aryeoOrderId`. Every
//      duplicate pair in the database carries an order id on BOTH sides (9 of
//      9, measured Sep 18). Delete or repurpose the loser and the next sync
//      recreates it, and the merge silently undoes itself.
//   2. The loser is a REAL ORDER that was really billed. Hiding it would make
//      a paid job vanish from the client's history, and marking it CANCELLED
//      would book real revenue as cancelled. Jordan's own answer was "two order
//      lines" — both orders stand.
//   3. Money must not move, and on this database money is attached to the
//      PROJECT: payroll reads Project.payableInvoice per appointment. Moving an
//      appointment or an invoice would change what somebody is paid for a day
//      they already worked.
//
// So the two jobs stay, and the WORK consolidates: what is owed, the cuts made
// against it, the cards carrying it and the client's asks about it all move to
// the survivor. The other job keeps its order, its invoice, its appointment,
// its shoot and its history — and says, on its own page, where its work went.
//
// It falls off the Editing Room by itself once its video deliverables leave
// (buildEditorQueue filters on `hasVideo`), which is "one Editing Room row"
// without a single exclusion rule to forget somewhere.
//
// REVERSIBLE, like everything else here. The marker records every row that
// moved, by id, so unmerging puts each one back where it came from rather than
// guessing.
// ---------------------------------------------------------------------------

export const MERGE_PREFIX = "project-merge:";
export const mergeKey = (fromId: string) => `${MERGE_PREFIX}${fromId}`;

/** Exactly what moved, so the reverse is a reverse and not an approximation. */
export type MergedRows = {
  deliverableIds: string[];
  outputIds: string[];
  submissionIds: string[];
  taskIds: string[];
  briefIds: string[];
  topazIds: string[];
};

export type ProjectMerge = {
  /** the job whose work moved away */
  fromId: string;
  /** the job that now carries it */
  intoId: string;
  at: Date;
  by: string | null;
  note: string | null;
  moved: MergedRows;
  undoneAt: Date | null;
  undoneBy: string | null;
};

const EMPTY: MergedRows = { deliverableIds: [], outputIds: [], submissionIds: [], taskIds: [], briefIds: [], topazIds: [] };

export function serializeMerge(m: Omit<ProjectMerge, "fromId">): string {
  return JSON.stringify({
    intoId: m.intoId,
    at: m.at.toISOString(),
    by: m.by,
    note: m.note,
    moved: m.moved,
    ...(m.undoneAt ? { undoneAt: m.undoneAt.toISOString(), undoneBy: m.undoneBy } : {}),
  });
}

function parse(key: string, value: string, fallbackAt: Date): ProjectMerge | null {
  const fromId = key.slice(MERGE_PREFIX.length);
  if (!fromId) return null;
  try {
    const v = JSON.parse(value) as Partial<{
      intoId: string; at: string; by: string | null; note: string | null;
      moved: Partial<MergedRows>; undoneAt: string | null; undoneBy: string | null;
    }>;
    if (!v.intoId) return null;
    const at = v.at ? new Date(v.at) : null;
    const undone = v.undoneAt ? new Date(v.undoneAt) : null;
    return {
      fromId,
      intoId: v.intoId,
      at: at && Number.isFinite(at.getTime()) ? at : fallbackAt,
      by: v.by ?? null,
      note: v.note ?? null,
      moved: { ...EMPTY, ...(v.moved ?? {}) },
      undoneAt: undone && Number.isFinite(undone.getTime()) ? undone : null,
      undoneBy: v.undoneBy ?? null,
    };
  } catch {
    return null;
  }
}

/** The merge this job's work went away in, if any is still standing. */
export async function mergeFrom(projectId: string): Promise<ProjectMerge | null> {
  const row = await prisma.appSetting
    .findUnique({ where: { key: mergeKey(projectId) }, select: { key: true, value: true, updatedAt: true } })
    .catch(() => null);
  const m = row ? parse(row.key, row.value, row.updatedAt) : null;
  return m && !m.undoneAt ? m : null;
}

/** Every merge, newest first — including undone ones, which stay as the record. */
export async function allMerges(): Promise<ProjectMerge[]> {
  const rows = await prisma.appSetting
    .findMany({ where: { key: { startsWith: MERGE_PREFIX } }, select: { key: true, value: true, updatedAt: true } })
    .catch(() => []);
  return rows
    .map((r) => parse(r.key, r.value, r.updatedAt))
    .filter((m): m is ProjectMerge => !!m)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** The jobs whose work was merged INTO this one, for the survivor's own page. */
export async function mergedInto(projectId: string): Promise<ProjectMerge[]> {
  return (await allMerges()).filter((m) => m.intoId === projectId && !m.undoneAt);
}

/** How many rows a merge would move, without moving them — what the dialog
 *  shows before anybody presses anything. */
export async function previewMerge(fromId: string): Promise<MergedRows & { videos: number }> {
  const [deliverables, subs, tasks] = await Promise.all([
    prisma.deliverable.findMany({ where: { projectId: fromId, removedFromOrderAt: null }, select: { id: true, type: true } }),
    prisma.reviewSubmission.findMany({ where: { projectId: fromId }, select: { id: true } }),
    prisma.smartTask.findMany({
      where: { projectId: fromId, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    }),
  ]);
  const ids = deliverables.map((d) => d.id);
  const [outputs, briefs, topaz] = await Promise.all([
    prisma.deliverableOutput.findMany({ where: { projectId: fromId }, select: { id: true } }),
    prisma.revisionBrief.findMany({ where: { projectId: fromId }, select: { id: true } }),
    prisma.topazJob.findMany({ where: { projectId: fromId }, select: { id: true } }),
  ]);
  void ids;
  return {
    deliverableIds: deliverables.map((d) => d.id),
    outputIds: outputs.map((o) => o.id),
    submissionIds: subs.map((s) => s.id),
    taskIds: tasks.map((t) => t.id),
    briefIds: briefs.map((b) => b.id),
    topazIds: topaz.map((t) => t.id),
    videos: deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").length,
  };
}
