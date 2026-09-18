import "server-only";
import { prisma } from "@/lib/prisma";
import { buildEditorQueue } from "@/lib/editorQueue";
import type { QueueRow } from "@/components/editing/SimpleQueue";

// ---------------------------------------------------------------------------
// THE EDITING ROOM, AS THE PERSON WHO SHOT THE JOB SEES IT (Jordan, Sep 18:
// "They should also see the editing room and be able to make changes to their
// notes or instructions, but not full control like I do or Kyle does").
//
// WHAT "NOT FULL CONTROL" WAS DECIDED TO MEAN, surface by surface:
//   · they see only jobs they SHOT — the same ownership test the shoot guard,
//     the Review Room page and the bell all use;
//   · every column is READ-ONLY. No status pill (the ladder is the office's
//     and the editor's), no editor reassign, no override dialog, no priority,
//     no delivery-date edit;
//   · the ONE writable thing is the brief THEY wrote at upload. That is the
//     whole reason Jordan asked for this: the editor has a question about the
//     shoot and the only person who can answer it is the one who was there;
//   · no money. A row here is an address, a client name, a status word, a due
//     date and a video count — the type below has nowhere to put a price.
//
// The status ladder is reused from buildEditorQueue() rather than re-derived,
// so a photographer and Kyle looking at the same job read the same word. Two
// copies of that ladder is exactly how the Sep 2 readiness audit found rows
// saying "Ready for review" for video that was still being cut.
// ---------------------------------------------------------------------------

export type PhotographerJob = {
  id: string;
  street: string;
  client: string;
  clientAvatarUrl: string | null;
  status: string;
  /** Slack-ladder rail this row sits on, so the page can group without
   *  re-deriving anything: open work, an upcoming shoot, or finished. */
  rail: "open" | "upcoming" | "done";
  dueISO: string | null;
  late: boolean;
  shootISO: string | null;
  videos: number;
  typeDetail: string;
  editor: string | null;
  openRevisions: number;
  /** Cuts from this job sitting in the Review Room right now — the row links
   *  straight into the Room when there are any, because that is where their
   *  voice on the video is (askCutChange), not here. */
  cutsInReview: number;
  /** Project.editorBrief — "anything else for the editor", theirs to fix. */
  shootBrief: string | null;
  /** Project.videoInstructions — the flow + vision they wrote on the upload
   *  page. Video jobs only; the upload portal requires it there. */
  videoInstructions: string | null;
};

/** Every job on the editing board that this photographer shot, with the two
 *  fields they may edit joined on. Empty for a photographer with no rows. */
export async function photographerEditingBoard(memberId: string): Promise<PhotographerJob[]> {
  const { notDone, upcoming, done } = await buildEditorQueue();
  const rails: { rail: PhotographerJob["rail"]; rows: QueueRow[] }[] = [
    { rail: "open", rows: notDone },
    { rail: "upcoming", rows: upcoming },
    { rail: "done", rows: done },
  ];
  const allIds = rails.flatMap((r) => r.rows.map((x) => x.id));
  if (allIds.length === 0) return [];

  // WHICH OF THESE ARE THEIRS — asked of the board's own ids, not of all 1,583
  // projects. Same predicate as photographerOwnsShoot (the column, else an
  // appointment assigned to them), so a job they can open in the Review Room
  // is a job they can find here, and a job they cannot is absent from both.
  const [mine, briefs, cutRows] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: allIds }, OR: [{ photographerId: memberId }, { appointments: { some: { assignedToId: memberId } } }] },
      select: { id: true },
    }),
    prisma.project.findMany({
      where: { id: { in: allIds } },
      select: { id: true, editorBrief: true, videoInstructions: true },
    }),
    prisma.reviewSubmission.groupBy({
      by: ["projectId"],
      where: { projectId: { in: allIds }, status: "PENDING" },
      _count: { _all: true },
    }),
  ]);
  const mineSet = new Set(mine.map((p) => p.id));
  const briefById = new Map(briefs.map((b) => [b.id, b] as const));
  const inReviewById = new Map(cutRows.map((c) => [c.projectId, c._count._all] as const));

  const out: PhotographerJob[] = [];
  for (const { rail, rows } of rails) {
    for (const r of rows) {
      if (!mineSet.has(r.id)) continue;
      const b = briefById.get(r.id);
      out.push({
        id: r.id,
        street: r.street,
        client: r.client,
        clientAvatarUrl: r.clientAvatarUrl,
        status: r.status,
        rail,
        dueISO: r.dueISO,
        late: r.late,
        shootISO: r.shootISO,
        videos: r.videos,
        typeDetail: r.typeDetail,
        editor: r.editor,
        openRevisions: r.openRevisions,
        cutsInReview: inReviewById.get(r.id) ?? 0,
        shootBrief: b?.editorBrief ?? null,
        videoInstructions: b?.videoInstructions ?? null,
      });
    }
  }
  return out;
}
