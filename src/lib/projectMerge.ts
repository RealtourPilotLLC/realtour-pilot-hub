import "server-only";

import type { Prisma } from "@prisma/client";

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

/** The marker table, read for real: a failure comes back as a failure. Which
 *  of the two wrappers below a caller wants is the whole question — see the
 *  note on mergeContext. */
async function readMergesOrThrow(): Promise<ProjectMerge[]> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: MERGE_PREFIX } },
    select: { key: true, value: true, updatedAt: true },
  });
  const read = rows.map((r) => ({ key: r.key, merge: parse(r.key, r.value, r.updatedAt) }));
  // A ROW THAT WILL NOT PARSE IS AN UNKNOWN, NOT AN ABSENCE (Sep 20 2026
  // review). Making this function throw on a failed findMany closed one half of
  // the hole and left the other open: a marker whose JSON is damaged, or whose
  // JSON has no intoId, came back null from parse() and was silently dropped —
  // so the answer was "these two jobs were never merged", which is precisely
  // the answer the throw was added to prevent. The reconcile would then go on
  // to retire the moved reel out from under the editor's cut and re-mint it on
  // the job that gave it away. Unknown beats wrong, whichever way the read
  // failed. allMerges (the screens) still swallows it.
  const broken = read.filter((r) => !r.merge).map((r) => r.key);
  if (broken.length > 0) {
    throw new Error(`merge marker will not parse: ${broken.slice(0, 3).join(", ")}${broken.length > 3 ? ` (+${broken.length - 3})` : ""}`);
  }
  return read
    .flatMap((r) => (r.merge ? [r.merge] : []))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Every merge, newest first — including undone ones, which stay as the record.
 *  Every caller of this one is a SCREEN: a page that shows "this job's work is
 *  over there" is better empty than broken, so an unreadable marker table reads
 *  as no merges. Anything that WRITES off the answer must use mergeContext,
 *  which throws instead. */
export async function allMerges(): Promise<ProjectMerge[]> {
  return readMergesOrThrow().catch(() => []);
}

/** The jobs whose work was merged INTO this one, for the survivor's own page. */
export async function mergedInto(projectId: string): Promise<ProjectMerge[]> {
  return (await allMerges()).filter((m) => m.intoId === projectId && !m.undoneAt);
}

/** Both directions of the merge in ONE read of the marker table: the merge this
 *  job's work went away in, and every merge that brought another job's work in.
 *
 *  THE ARYEO RECONCILE NEEDS BOTH HALVES AT ONCE (Sep 20 2026). It reads what a
 *  job owes BY PROJECT while computing what is wanted FROM THE ORDER, and a
 *  merge is precisely the thing that breaks that correspondence: the donor's
 *  rows are somewhere else, and the survivor is holding rows its own order never
 *  sold. Asking for both sides separately would be two round trips per project
 *  per hourly sweep, so it is one read filtered twice.
 *
 *  THIS ONE THROWS, unlike allMerges (Sep 20 2026 review). It shipped reading
 *  through allMerges, which swallows its own findMany failure and returns [] —
 *  so one unreadable AppSetting read during one hourly sweep looked exactly
 *  like "these two jobs were never merged", and the sweep then did the thing
 *  this whole change exists to stop: retired the moved reel out from under the
 *  editor's cut and re-minted it on the job that gave it away. A sweep that
 *  skips a job costs an hour. A sweep that guesses costs an editor's work, and
 *  has to be unpicked by hand. Unknown beats wrong, the same way it does for an
 *  order with no parseable items. */
export async function mergeContext(projectId: string): Promise<{ movedAway: ProjectMerge | null; movedIn: ProjectMerge[] }> {
  const live = (await readMergesOrThrow()).filter((m) => !m.undoneAt);
  return {
    movedAway: live.find((m) => m.fromId === projectId) ?? null,
    movedIn: live.filter((m) => m.intoId === projectId),
  };
}

/** The deliverable ids parked on a job by a merge — rows that belong to ANOTHER
 *  job's order and are none of this order's business. Pure, so the reconcile can
 *  take it off the `movedIn` it already has rather than reading again. */
export function foreignDeliverableIds(movedIn: ProjectMerge[]): Set<string> {
  return new Set(movedIn.flatMap((m) => m.moved.deliverableIds));
}

/** Add a row that was created AFTER the merge, on the job that now carries the
 *  work, to the marker — so the undo still knows it belongs to the donor.
 *
 *  Sep 20 2026: the marker was written once and never touched again, which made
 *  the undo exact for the rows that moved and blind to everything the merge
 *  caused afterwards. An Aryeo line added to the donor's order in the meantime
 *  mints its row on the SURVIVOR now (see reconcileDeliverablesToOrder), and a
 *  row the undo cannot see is a row that never goes home.
 *
 *  IT TAKES ITS DATABASE HANDLE, AND IT LOCKS (Sep 20 review). It shipped as a
 *  best-effort read-modify-write that ran AFTER the row had already been
 *  created on the other job, swallowing both halves. A single lost append did
 *  not just cost the undo: the next sweep could not see the row either, minted
 *  a second one, and the survivor's own sweep then stamped the stray "no longer
 *  on Aryeo order #<the other job's order>" — the exact note this fix exists to
 *  prevent, once an hour, for ever. The realistic trigger was never a dead
 *  database, it was the :00 cron and an Aryeo order.updated webhook reconciling
 *  the same order at the same moment. So the caller runs it inside the same
 *  transaction as the create (they land or fail together), and the marker row
 *  is locked for the read-modify-write so a concurrent append cannot be
 *  overwritten. It returns whether the append is safely in. */
export async function recordMergedRow(
  db: Prisma.TransactionClient,
  fromId: string,
  kind: keyof MergedRows,
  id: string,
): Promise<boolean> {
  const key = mergeKey(fromId);
  // SELECT … FOR UPDATE, not findUnique: two sweeps minting two types for one
  // merged-away order would otherwise both read the same "before" and the
  // second would write the first one's row back out of the marker.
  const locked = await db.$queryRaw<{ value: string; updatedAt: Date }[]>`
    SELECT "value", "updatedAt" FROM "AppSetting" WHERE "key" = ${key} FOR UPDATE
  `;
  const row = locked[0];
  if (!row) return false;
  const m = parse(key, row.value, row.updatedAt);
  if (!m || m.undoneAt) return false;
  if (m.moved[kind].includes(id)) return true;
  await db.appSetting.update({
    where: { key },
    data: { value: serializeMerge({ ...m, moved: { ...m.moved, [kind]: [...m.moved[kind], id] } }) },
  });
  return true;
}

/** How many rows a merge would move, without moving them — what the dialog
 *  shows before anybody presses anything. */
export async function previewMerge(fromId: string): Promise<MergedRows & { videos: number }> {
  // A CHILD FOLLOWS ITS PARENT, AND ONLY ITS PARENT (Sep 20 2026 review).
  //
  // This read shipped filtering the DELIVERABLES to what is still owed while
  // taking EVERY cut, per-video row and brief on the job by projectId — so a row
  // the donor's order dropped back in August stayed behind (correctly) while the
  // editor's cut against it, and its slot, walked off to the survivor. Retiring
  // a deliverable never touches its cuts, so that shape is ordinary, and the
  // result is the exact thing mergeProjectWork's own transaction comment says
  // the single transaction exists to prevent: a version pointing at a video that
  // lives on another job, which no screen in this codebase is built to render.
  // Proved end to end Sep 20 (journey 2.3): {cuts:1, outputs:1} across the
  // boundary for as long as the merge stood.
  //
  // So each set is now taken off the set above it. The one deliberate exception
  // is a cut with NO deliverable at all — the legacy folder-discovered rounds —
  // which has no parent to stay with and follows the job.
  const [deliverables, tasks] = await Promise.all([
    prisma.deliverable.findMany({ where: { projectId: fromId, removedFromOrderAt: null }, select: { id: true, type: true } }),
    prisma.smartTask.findMany({
      where: { projectId: fromId, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    }),
  ]);
  const ids = deliverables.map((d) => d.id);
  const [subs, outputs] = await Promise.all([
    prisma.reviewSubmission.findMany({
      where: { projectId: fromId, OR: [{ deliverableId: null }, { deliverableId: { in: ids } }] },
      select: { id: true },
    }),
    prisma.deliverableOutput.findMany({ where: { projectId: fromId, deliverableId: { in: ids } }, select: { id: true } }),
  ]);
  const submissionIds = subs.map((s) => s.id);
  const outputIds = outputs.map((o) => o.id);
  const [briefs, topaz] = await Promise.all([
    // A job-level ask (outputId null) is about the job, so it goes with the
    // work; an ask about one video goes only if that video is going.
    prisma.revisionBrief.findMany({
      where: { projectId: fromId, OR: [{ outputId: null }, { outputId: { in: outputIds } }] },
      select: { id: true },
    }),
    // One render per cut, so a render follows its cut — a render whose cut is
    // staying behind would otherwise land on a job holding none of its work.
    prisma.topazJob.findMany({ where: { projectId: fromId, submissionId: { in: submissionIds } }, select: { id: true } }),
  ]);
  return {
    deliverableIds: ids,
    outputIds,
    submissionIds,
    taskIds: tasks.map((t) => t.id),
    briefIds: briefs.map((b) => b.id),
    topazIds: topaz.map((t) => t.id),
    videos: deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL").length,
  };
}
