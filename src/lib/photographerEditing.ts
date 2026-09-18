import "server-only";
import { prisma } from "@/lib/prisma";
import { buildEditorQueue, STATUS_LABEL } from "@/lib/editorQueue";
import { editorMeta } from "@/lib/editors";
import { etAddDays } from "@/lib/datetime";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { effectiveDue, effectiveTypeDetail, effectiveVideosOwed } from "@/lib/editOverrides";
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
//
// …WITH ONE EXCEPTION, MEASURED (review, Sep 18): the DELIVERED rail cannot
// come from the office board. buildEditorQueue's delivered query is
// `take: 60` over EVERY client's jobs — 108 jobs were delivered in the last 60
// days and only 32 of them survive to the board's Done rail — so filtering it
// to one person truncates by whatever share of that window belongs to other
// photographers. Live, today: Harrison shot 12 delivered video jobs inside the
// window and his own board showed 8. He is not missing jobs because of what he
// shot; he is missing them because of how busy everyone else was. So this rail
// is queried FOR HIM, and the ladder is not duplicated to do it: for a
// DELIVERED project every branch of buildEditorQueue's status derivation is
// skipped (`if (!upcoming && p.status !== "DELIVERED")`) and even a pinned
// status reads back Project.status, so the word is the constant below.
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
  /** Who actually HAS it — the editor of record, never the routing rules'
   *  guess. See ROUTING IS NOT AN ASSIGNMENT below. */
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

// ROUTING IS NOT AN ASSIGNMENT (review, Sep 18). A QueueRow's editor name falls
// through to the routing rules when no task and no editor of record says
// otherwise, and `auto` is the row's own marker for exactly that — the office
// table draws it differently for the same reason. This board printed it as
// "with John Mark", which on the live board was 8 of Harrison's 18 rows,
// telling a photographer their job is with an editor nobody has handed it to.
// An honest blank is worth more than a name here: the only thing they do with
// it is decide whom they are answering.
const namedEditor = (r: QueueRow): string | null => (r.auto ? null : r.editor);

const streetOf = (p: { addressLine: string | null; title: string }) =>
  (p.addressLine || p.title.split(",")[0] || "Job").trim();

const VIDEO_TYPES = ["VIDEO", "SOCIAL_REEL"] as const;

/** Their delivered video jobs in the same 60-ET-day window the office board
 *  uses — asked of the database as THEIRS, so nobody else's busy fortnight can
 *  push a job off the end of it. */
async function deliveredRail(memberId: string): Promise<PhotographerJob[]> {
  const rows = await prisma.project.findMany({
    where: {
      status: "DELIVERED",
      deliveredAt: { gte: etAddDays(new Date(), -60) },
      // The same ownership test as everywhere else (photographerOwnsShoot):
      // the column, else an appointment that is still ON — a canceled visit is
      // not a shoot they worked.
      OR: [{ photographerId: memberId }, { appointments: { some: { assignedToId: memberId, status: { not: "CANCELED" } } } }],
      // Video lane only, and only deliverables still owed on the order — the
      // same pair of tests the office board applies (OWED_DELIVERABLE_WHERE
      // then hasVideo), so a photo-only job never appears here.
      deliverables: { some: { ...OWED_DELIVERABLE_WHERE, type: { in: [...VIDEO_TYPES] } } },
    },
    orderBy: { deliveredAt: "desc" },
    // One person's delivered video work inside 60 days. The office's identical
    // cap is what this rail exists to escape; kept at the same number because
    // it is a ceiling on ONE photographer's fortnight, not on the whole shop's.
    take: 60,
    select: {
      id: true, title: true, addressLine: true, shootDate: true, deliveryDue: true,
      dueOverrideAt: true, promisedDueAt: true, videosOwedOverride: true, videosFilmed: true,
      typeDetailOverride: true, editorVendorKey: true, editorBrief: true, videoInstructions: true,
      client: { select: { name: true, avatarUrl: true } },
      editor: { select: { name: true } },
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { type: true, label: true, quantity: true } },
    },
  });

  return rows.map((p) => {
    const videos = p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    return {
      id: p.id,
      street: streetOf(p),
      client: p.client.name,
      clientAvatarUrl: p.client.avatarUrl,
      // DELIVERED is the one rung the office board reads straight off the
      // project: its cut-derived ladder is skipped for these rows outright.
      status: STATUS_LABEL.DELIVERED,
      rail: "done" as const,
      dueISO: effectiveDue(p, p.deliveryDue)?.toISOString() ?? null,
      // `late` is false on every delivered row of the office board too
      // (`!upcoming && p.status !== "DELIVERED" && …`) — the deadline of a job
      // that shipped is history, and printing an Overdue chip on it would
      // brand every one of them.
      late: false,
      shootISO: p.shootDate?.toISOString() ?? null,
      videos: effectiveVideosOwed(p, videos),
      typeDetail: effectiveTypeDetail(p, videos.map((d) => d.label || d.type).join(" · ")),
      // The editor of record, or the outside shop's key when that is all there
      // is. No routing guess — same rule as namedEditor above.
      editor: p.editor?.name ?? (p.editorVendorKey ? editorMeta(p.editorVendorKey)?.name ?? p.editorVendorKey : null),
      // Always 0, and matched to the office board on purpose: it loads open
      // tasks for IN-FLIGHT jobs only, so its delivered rows carry no revision
      // count either. A number here would be one this rail invented alone.
      openRevisions: 0,
      cutsInReview: 0,
      shootBrief: p.editorBrief,
      videoInstructions: p.videoInstructions,
    };
  });
}

/** Every job on the editing board that this photographer shot, with the two
 *  fields they may edit joined on. Empty for a photographer with no rows. */
export async function photographerEditingBoard(memberId: string): Promise<PhotographerJob[]> {
  const [{ notDone, upcoming }, done] = await Promise.all([buildEditorQueue(), deliveredRail(memberId)]);
  const rails: { rail: PhotographerJob["rail"]; rows: QueueRow[] }[] = [
    { rail: "open", rows: notDone },
    { rail: "upcoming", rows: upcoming },
  ];
  const allIds = rails.flatMap((r) => r.rows.map((x) => x.id));

  // WHICH OF THESE ARE THEIRS — asked of the board's own ids, not of all 1,583
  // projects. Same predicate as photographerOwnsShoot (the column, else an
  // appointment that was not canceled), so a job they can open in the Review
  // Room is a job they can find here, and a job they cannot is absent from
  // both.
  const [mine, briefs, cutRows] = await Promise.all([
    prisma.project.findMany({
      where: {
        id: { in: allIds },
        OR: [{ photographerId: memberId }, { appointments: { some: { assignedToId: memberId, status: { not: "CANCELED" } } } }],
      },
      select: { id: true },
    }),
    prisma.project.findMany({
      where: { id: { in: allIds } },
      select: { id: true, editorBrief: true, videoInstructions: true },
    }),
    prisma.reviewSubmission.groupBy({
      by: ["projectId"],
      where: { projectId: { in: [...allIds, ...done.map((d) => d.id)] }, status: "PENDING" },
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
        editor: namedEditor(r),
        openRevisions: r.openRevisions,
        cutsInReview: inReviewById.get(r.id) ?? 0,
        shootBrief: b?.editorBrief ?? null,
        videoInstructions: b?.videoInstructions ?? null,
      });
    }
  }
  // A delivered job with a cut still pending is rare but real (a re-cut handed
  // in after delivery), and the "Watch the cut" link is the one thing on the
  // row that has to be right.
  return [...out, ...done.map((d) => ({ ...d, cutsInReview: inReviewById.get(d.id) ?? 0 }))];
}
