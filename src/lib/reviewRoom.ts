import "server-only";
import { prisma } from "@/lib/prisma";
import { videoTier } from "@/lib/projectStatus";

// ---------------------------------------------------------------------------
// Read layer for the STANDALONE Review Room (/review) — the owner's quality
// desk now that he's out of the field. Two surfaces:
//   · getReviewQueue()      — the cross-project queue page: cuts awaiting a
//     verdict, changes-requested cuts waiting on the editor, photo sets in QC,
//     and open feedback follow-through by lane.
//   · getCutWorkspace(id)   — one project's cut-review workspace: every
//     submission round, the timestamped notes on the active cut, and the
//     context needed to judge it (brief, recipe, client).
// Mutations live in src/app/review/actions.ts. Per-asset pin review of PHOTOS
// stays where it was — the project gallery (ListingMedia) — and the queue
// links straight into it.
// ---------------------------------------------------------------------------

const streetOf = (title?: string | null) => (title || "Project").split(",")[0].trim() || "Project";

export type QueueSubmission = {
  id: string;
  projectId: string;
  street: string;
  clientName: string;
  clientAvatarUrl: string | null; // the agent's Aryeo headshot, when they have one
  premium: boolean;
  round: number;
  status: string;
  submittedByName: string | null;
  note: string | null;
  fileName: string | null; // labels the row when a project has several cuts in flight
  hasAsset: boolean;
  createdAt: string;
  decidedAt: string | null;
  openEditorNotes: number;
};

export type QueuePhotoQc = {
  taskId: string;
  projectId: string | null;
  street: string;
  clientName: string;
  clientAvatarUrl: string | null;
  dueAt: string | null;
  assignedKey: string | null;
};

export type QueueFollowUp = {
  projectId: string;
  street: string;
  lane: "EDIT" | "PHOTOGRAPHER" | "EDITOR";
  open: number;
  awaitingReReview: number; // FIXED, waiting on the owner to approve
  awaitingReply: number; // threads where a CREATIVE spoke last — the owner owes an answer
};

export type ReviewQueue = {
  pending: QueueSubmission[];
  waitingOnEditor: QueueSubmission[];
  recentlyApproved: QueueSubmission[];
  photoQc: QueuePhotoQc[];
  followUps: QueueFollowUp[];
};

export async function getReviewQueue(): Promise<ReviewQueue> {
  const since = new Date(Date.now() - 14 * 24 * 3600_000);
  const [subs, qcTasks, noteRollup, threadReplies] = await Promise.all([
    prisma.reviewSubmission.findMany({
      where: {
        OR: [
          { status: { in: ["PENDING", "CHANGES_REQUESTED"] } },
          { status: "APPROVED", decidedAt: { gte: since } },
        ],
        // A cancelled or on-hold job's cuts are not the owner's work list (audit).
        project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } },
      },
      orderBy: { createdAt: "desc" },
      include: {
        project: {
          select: {
            id: true,
            title: true,
            status: true,
            // avatarUrl: Jordan (Sep 2) — "if the agent has a profile photo in
            // Aryeo that should be shown … in other places the clients are
            // mentioned." The queue rows are one of those places.
            client: { select: { name: true, socialClient: true, avatarUrl: true } },
            deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
          },
        },
      },
    }),
    prisma.smartTask.findMany({
      where: {
        taskType: "media_qa",
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        OR: [{ projectId: null }, { project: { status: { notIn: ["CANCELLED", "ON_HOLD"] } } }],
      },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }],
      select: {
        id: true,
        projectId: true,
        dueAt: true,
        assignedKey: true,
        propertyAddress: true,
        project: { select: { title: true, client: { select: { name: true, avatarUrl: true } } } },
      },
    }),
    prisma.mediaNote.groupBy({
      by: ["projectId", "lane", "status"],
      // Editor-authored notes are context for the reviewer, not owed fixes —
      // they must not inflate "open notes" badges or the follow-up tallies.
      where: { parentId: null, status: { in: ["OPEN", "FIXED"] }, NOT: { authorKey: { startsWith: "editor:" } } },
      _count: true,
    }),
    // Thread replies on still-live roots — a creative's "which bathroom do you
    // mean?" otherwise rots invisibly once the owner stops opening the thread.
    // Bounded: replies only exist under review notes (a handful of rows).
    prisma.mediaNote.findMany({
      where: { parentId: { not: null }, parent: { status: { not: "RESOLVED" } } },
      select: {
        parentId: true,
        authorKey: true,
        createdAt: true,
        parent: { select: { projectId: true, lane: true } },
      },
    }),
  ]);

  // Open editor-note counts per project (badges the pending rows so the owner
  // sees at a glance whether he already started marking a cut up).
  const editorOpenByProject = new Map<string, number>();
  for (const r of noteRollup) {
    if (r.lane === "EDITOR" && r.status === "OPEN") {
      editorOpenByProject.set(r.projectId, (editorOpenByProject.get(r.projectId) ?? 0) + r._count);
    }
  }

  const toView = (s: (typeof subs)[number]): QueueSubmission => ({
    id: s.id,
    projectId: s.projectId,
    street: streetOf(s.project?.title),
    clientName: s.project?.client?.name ?? "",
    clientAvatarUrl: s.project?.client?.avatarUrl ?? null,
    premium: videoTier(s.project?.deliverables ?? []) === "premium",
    round: s.round,
    status: s.status,
    submittedByName: s.submittedByName,
    note: s.note,
    fileName: s.fileName,
    hasAsset: !!s.assetUrl,
    createdAt: s.createdAt.toISOString(),
    decidedAt: s.decidedAt ? s.decidedAt.toISOString() : null,
    openEditorNotes: editorOpenByProject.get(s.projectId) ?? 0,
  });

  // Only the LATEST round per CUT belongs in the queue lists — older rounds
  // are history and live in the workspace timeline instead. A cut = one file
  // (assetPath): monthly packages send several videos one by one, and EACH
  // pending video gets its own row so it can be reviewed individually.
  const latestByCut = new Map<string, (typeof subs)[number]>();
  for (const s of subs) {
    const key = `${s.projectId}:${s.deliverableId ? `${s.deliverableId}:${s.slot}` : (s.assetPath ?? s.id)}`;
    const cur = latestByCut.get(key);
    if (!cur || s.round > cur.round) latestByCut.set(key, s);
  }
  // A DELIVERED job's still-PENDING cut is not the owner's work list — the
  // client already has it (131 Woodcutter sat in the queue for days after
  // delivery). Approved rows stay in recentlyApproved.
  const latest = [...latestByCut.values()].filter((s) => !(s.status === "PENDING" && s.project?.status === "DELIVERED"));

  // Unanswered creative replies: per thread, whoever spoke LAST holds the
  // floor — if that's not the owner, the owner owes an answer. Only live
  // (non-RESOLVED) roots count; a root's status lives in [OPEN, FIXED] then,
  // so every counted thread already has a follow-up row to hang the chip on.
  const lastReplyByRoot = new Map<string, (typeof threadReplies)[number]>();
  for (const r of threadReplies) {
    if (!r.parentId) continue;
    const cur = lastReplyByRoot.get(r.parentId);
    if (!cur || r.createdAt > cur.createdAt) lastReplyByRoot.set(r.parentId, r);
  }
  const awaitingReplyByKey = new Map<string, number>(); // "<projectId>:<lane>" → count
  for (const r of lastReplyByRoot.values()) {
    if (!r.parent || r.authorKey === "owner") continue;
    const lane = (["EDIT", "PHOTOGRAPHER", "EDITOR"].includes(r.parent.lane) ? r.parent.lane : "EDIT") as QueueFollowUp["lane"];
    const key = `${r.parent.projectId}:${lane}`;
    awaitingReplyByKey.set(key, (awaitingReplyByKey.get(key) ?? 0) + 1);
  }

  // Feedback follow-through: projects with review notes still open (someone owes
  // a fix) or FIXED (the owner owes a re-review). Rollup by project+lane.
  const followMap = new Map<string, QueueFollowUp>();
  const projectIds = [...new Set(noteRollup.map((r) => r.projectId))];
  const titles = projectIds.length
    ? await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, title: true } })
    : [];
  const titleOf = new Map(titles.map((t) => [t.id, t.title]));
  for (const r of noteRollup) {
    const lane = (["EDIT", "PHOTOGRAPHER", "EDITOR"].includes(r.lane) ? r.lane : "EDIT") as QueueFollowUp["lane"];
    const key = `${r.projectId}:${lane}`;
    const cur = followMap.get(key) ?? {
      projectId: r.projectId,
      street: streetOf(titleOf.get(r.projectId)),
      lane,
      open: 0,
      awaitingReReview: 0,
      awaitingReply: awaitingReplyByKey.get(key) ?? 0,
    };
    if (r.status === "OPEN") cur.open += r._count;
    else cur.awaitingReReview += r._count;
    followMap.set(key, cur);
  }

  return {
    pending: latest.filter((s) => s.status === "PENDING").map(toView),
    waitingOnEditor: latest.filter((s) => s.status === "CHANGES_REQUESTED").map(toView),
    recentlyApproved: latest.filter((s) => s.status === "APPROVED").map(toView),
    photoQc: qcTasks.map((t) => ({
      taskId: t.id,
      projectId: t.projectId,
      street: streetOf(t.project?.title ?? t.propertyAddress),
      clientName: t.project?.client?.name ?? "",
      clientAvatarUrl: t.project?.client?.avatarUrl ?? null,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      assignedKey: t.assignedKey,
    })),
    followUps: [...followMap.values()].sort((a, b) => b.open - a.open),
  };
}

// ------------------- The photographer's Review Room ------------------------
//
// Jordan, Sep 18: "I want to be able to share the review room with the
// photographer who shot the video … they should be notified just like I am,
// with access to the review room."
//
// It is deliberately NOT getReviewQueue() with a filter bolted on. That queue
// is the office's desk — every client's cut, Kyle's photo-QC cards, the
// feedback-follow-through rollup, the recurring-miss scoreboards — and the
// point of this one is the opposite: the handful of cuts that came out of THIS
// person's shoots. Reusing the office's row type would also carry
// `openEditorNotes`, a count of the office's private notes on the cut, onto a
// creative's screen for no purpose (and the Sep 17 audit is about precisely
// that class of leak). So: a narrower row, built from a narrower query.
//
// The scope test is shoot OWNERSHIP, the same predicate photographerOwnsShoot
// enforces on the workspace page and requireShootAccess enforces on every
// write — one definition of "their job", three surfaces.
export type PhotographerCut = {
  id: string;
  projectId: string;
  street: string;
  clientName: string;
  clientAvatarUrl: string | null;
  round: number;
  status: string;
  fileName: string | null;
  hasAsset: boolean;
  createdAt: string;
  decidedAt: string | null;
  /** Capture notes on this cut addressed to THEM, still open — the thing they
   *  actually owe an answer on. */
  myOpenNotes: number;
  /** Change requests they asked for on this cut, still open (askCutChange). */
  myOpenAsks: number;
};

export type PhotographerReviewQueue = {
  inReview: PhotographerCut[];
  inRevisions: PhotographerCut[];
  decided: PhotographerCut[];
};

export async function getPhotographerReviewQueue(memberId: string): Promise<PhotographerReviewQueue> {
  const since = new Date(Date.now() - 14 * 24 * 3600_000);
  const subs = await prisma.reviewSubmission.findMany({
    where: {
      OR: [
        { status: { in: ["PENDING", "CHANGES_REQUESTED"] } },
        { status: { in: ["APPROVED", "CHANGES_REQUESTED"] }, decidedAt: { gte: since } },
      ],
      project: {
        status: { notIn: ["CANCELLED", "ON_HOLD"] },
        OR: [{ photographerId: memberId }, { appointments: { some: { assignedToId: memberId } } }],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      project: {
        select: { id: true, title: true, status: true, client: { select: { name: true, avatarUrl: true } } },
      },
    },
  });

  // Latest round per cut, exactly as the office's queue collapses them: an
  // older round is history and lives in the workspace timeline.
  const latestByCut = new Map<string, (typeof subs)[number]>();
  for (const s of subs) {
    const key = `${s.projectId}:${s.deliverableId ? `${s.deliverableId}:${s.slot}` : (s.assetPath ?? s.id)}`;
    const cur = latestByCut.get(key);
    if (!cur || s.round > cur.round) latestByCut.set(key, s);
  }
  const latest = [...latestByCut.values()].filter((s) => s.status !== "WITHDRAWN");

  // Their open rows on those cuts, tallied by the asset key a note threads
  // under (the same key addCutNote writes: the minted link, else cut:<id>).
  // Both lanes in one read — capture notes addressed to them, and the change
  // requests they wrote, which are EDITOR-lane rows carrying their id.
  const projectIds = [...new Set(latest.map((s) => s.projectId))];
  const openNotes = projectIds.length
    ? await prisma.mediaNote.findMany({
        where: { projectId: { in: projectIds }, parentId: null, status: "OPEN", photographerId: memberId },
        select: { assetUrl: true, lane: true },
      })
    : [];
  const notesByAsset = new Map<string, { notes: number; asks: number }>();
  for (const n of openNotes) {
    const cur = notesByAsset.get(n.assetUrl) ?? { notes: 0, asks: 0 };
    if (n.lane === "EDITOR") cur.asks += 1;
    else cur.notes += 1;
    notesByAsset.set(n.assetUrl, cur);
  }

  const toView = (s: (typeof subs)[number]): PhotographerCut => {
    const tally = notesByAsset.get(s.assetUrl ?? `cut:${s.id}`) ?? { notes: 0, asks: 0 };
    return {
      id: s.id,
      projectId: s.projectId,
      street: streetOf(s.project?.title),
      clientName: s.project?.client?.name ?? "",
      clientAvatarUrl: s.project?.client?.avatarUrl ?? null,
      round: s.round,
      status: s.status,
      fileName: s.fileName,
      hasAsset: !!s.assetUrl,
      createdAt: s.createdAt.toISOString(),
      decidedAt: s.decidedAt ? s.decidedAt.toISOString() : null,
      myOpenNotes: tally.notes,
      myOpenAsks: tally.asks,
    };
  };

  return {
    inReview: latest.filter((s) => s.status === "PENDING").map(toView),
    inRevisions: latest.filter((s) => s.status === "CHANGES_REQUESTED").map(toView),
    decided: latest.filter((s) => s.status === "APPROVED").map(toView),
  };
}

// --------------------------- Cut workspace ---------------------------------

export type CutSubmission = {
  id: string;
  round: number;
  status: string;
  assetUrl: string | null;
  assetPath: string | null; // groups rounds of the SAME video (multi-cut jobs)
  fileName: string | null;
  note: string | null;
  submittedByKey: string | null;
  submittedByName: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  // internal-upload flow (Sep 1 2026)
  deliverableId: string | null;
  slot: number;
  source: string;
  // Whether the cut has a copy in the hub's own store, i.e. whether it streams
  // from us rather than from Dropbox. It is deliberately a BOOLEAN and not the
  // blob's URL: this type is serialised into the Review Room's client payload,
  // and the store's URLs are public and permanent, so shipping one would put a
  // credential-free link to an unreleased client video in the page's HTML —
  // defeating the gate on /api/review/cut/<id>/stream, which is the only way
  // a cut is meant to be reached (RTP-01 handover, Sep 16).
  hasHubCopy: boolean;
  completedAt: string | null;
};

export type CutNote = {
  id: string;
  assetUrl: string;
  timeSec: number | null;
  lane: string;
  kind: string;
  body: string;
  status: string;
  authorName: string | null;
  createdAt: string;
  /** An EDITOR-lane note the PHOTOGRAPHER asked for (askCutChange, Sep 18) —
   *  an EDITOR row stamped with a photographerId, a pairing nothing else in
   *  the schema writes. Every surface that shows cut notes needs to say so:
   *  "fix the 0:14 driveway" reads very differently depending on whether the
   *  office decided it or the person who was standing there asked for it. */
  ask: boolean;
  replies: { id: string; body: string; authorName: string | null; createdAt: string }[];
};

export type CutWorkspace = {
  projectId: string;
  street: string;
  title: string;
  status: string;
  clientName: string;
  clientAvatarUrl: string | null; // the agent's Aryeo headshot — the workspace header shows it beside the name
  premium: boolean;
  editorBrief: string | null;
  reelHook: string | null;
  reelScript: string | null;
  reelSong: string | null;
  deliverables: string[];
  submissions: CutSubmission[]; // newest round first
  active: CutSubmission | null; // the round under review
  notes: CutNote[]; // ROOT notes on the ACTIVE cut, oldest first
};

// An editor's slice of the review: EDITOR-lane notes addressed to THEM on this
// project (editorKey scoping — same fail-closed spirit as the photographer's
// getPhotographerFeedback). Owner/admin pass null to see every editor note.
export async function getEditorFeedback(projectId: string, editorKey: string | null): Promise<CutNote[]> {
  const notes = await prisma.mediaNote.findMany({
    where: {
      projectId,
      parentId: null,
      lane: "EDITOR",
      ...(editorKey ? { editorKey } : {}),
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }], // FIXED sorts after OPEN alphabetically — re-sort in UI
    include: { replies: { orderBy: { createdAt: "asc" } } },
  });
  return notes.map((n) => ({
    id: n.id,
    assetUrl: n.assetUrl,
    timeSec: n.timeSec,
    lane: n.lane,
    kind: n.kind,
    body: n.body,
    status: n.status,
    authorName: n.authorName,
    createdAt: n.createdAt.toISOString(),
    ask: n.lane === "EDITOR" && !!n.photographerId,
    replies: n.replies.map((r) => ({
      id: r.id,
      body: r.body,
      authorName: r.authorName,
      createdAt: r.createdAt.toISOString(),
    })),
  }));
}

// `cutId` opens a SPECIFIC submission (the queue's per-video rows link with
// ?cut=<id>); omitted → the newest pending cut, else the newest round.
/**
 * WHOSE ROOM IS THIS? (audit finding 4, Sep 17.)
 *
 * The office lens is the whole workspace, as it always was. The photographer
 * lens exists because Sep 17 gave a photographer a way into this page — "tag
 * james on the video, he gets a text and a link to see the review room video
 * and comment" — and the page then handed them the OFFICE's workspace: the
 * editor brief, the reel script, and every note lane with raw bodies and
 * replies, including Kyle's instructions to the editor and the client's own
 * words. Shoot ownership is a reason to see the CUT, not a reason to read the
 * office's discussion about it.
 *
 * So the lens is applied HERE, server-side, before anything reaches a client
 * component — the same fail-closed spirit as getEditorFeedback and
 * getPhotographerFeedback, which have always scoped a creative to their own
 * lane. A photographer sees the video, the notes addressed to them, and their
 * own replies. Nothing else on this page was ever theirs.
 */
export type WorkspaceLens = { kind: "office" } | { kind: "photographer"; memberId: string };

export async function getCutWorkspace(projectId: string, cutId?: string | null, lens: WorkspaceLens = { kind: "office" }): Promise<CutWorkspace | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      status: true,
      editorBrief: true,
      reelHook: true,
      reelScript: true,
      reelSong: true,
      client: { select: { name: true, socialClient: true, avatarUrl: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
      // An upload still in flight (or one that died) is not a cut yet.
      reviewSubmissions: { where: { status: { notIn: ["UPLOADING", "UPLOAD_FAILED"] } }, orderBy: { round: "desc" } },
    },
  });
  if (!project) return null;

  const submissions: CutSubmission[] = project.reviewSubmissions.map((s) => ({
    id: s.id,
    round: s.round,
    status: s.status,
    assetUrl: s.assetUrl,
    assetPath: s.assetPath,
    fileName: s.fileName,
    note: s.note,
    submittedByKey: s.submittedByKey,
    submittedByName: s.submittedByName,
    createdAt: s.createdAt.toISOString(),
    decidedAt: s.decidedAt ? s.decidedAt.toISOString() : null,
    decidedBy: s.decidedBy,
    deliverableId: s.deliverableId,
    slot: s.slot,
    source: s.source,
    hasHubCopy: !!s.blobUrl,
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
  }));
  // A WITHDRAWN round is history, not the thing to rule on (Sep 16) — it is
  // still reachable by ?cut=<id> (the Earlier-rounds list links to it) but it
  // never becomes the default cut just because it has the highest round. The
  // choice HAS to be made here rather than in the page: the notes below are
  // read for whichever cut this picks, and a page-level swap left the reviewer
  // looking at one cut under another cut's notes (reviewer, Sep 16).
  const active =
    (cutId ? submissions.find((s) => s.id === cutId) : null) ??
    submissions.find((s) => s.status === "PENDING") ??
    submissions.find((s) => s.status !== "WITHDRAWN") ??
    submissions[0] ??
    null;

  // Notes for the active cut. Cuts with no minted link store notes under the
  // synthetic cut:<submissionId> asset key so feedback still threads correctly.
  const activeAssetKey = active ? (active.assetUrl ?? `cut:${active.id}`) : null;
  // A photographer reads ONE lane, and only the rows scoped to them: the note
  // they were tagged in and their own capture feedback. The EDIT lane (Kyle to
  // the editor) and the EDITOR lane (edit feedback) are not theirs.
  // …plus, since Sep 18, the change requests they wrote THEMSELVES: an
  // EDITOR-lane row carrying their photographerId is askCutChange's marker and
  // nothing else in the schema writes that pairing. Without this they could
  // post an ask and never see it again — a composer that swallows what you
  // type is worse than no composer.
  const laneWhere =
    lens.kind === "photographer"
      ? {
          OR: [
            { lane: "PHOTOGRAPHER" as const, photographerId: lens.memberId },
            { lane: "EDITOR" as const, photographerId: lens.memberId },
          ],
        }
      : {};
  const noteRows = activeAssetKey
    ? await prisma.mediaNote.findMany({
        where: { projectId, parentId: null, assetUrl: activeAssetKey, ...laneWhere },
        orderBy: { createdAt: "asc" },
        include: { replies: { orderBy: { createdAt: "asc" } } },
      })
    : [];
  // The brief and the recipe are the office's working notes on the job. They
  // are withheld rather than blanked at the component, so they never travel.
  const officeOnly = lens.kind === "office";

  return {
    projectId: project.id,
    street: streetOf(project.title),
    title: project.title,
    status: project.status,
    clientName: project.client?.name ?? "",
    clientAvatarUrl: project.client?.avatarUrl ?? null,
    premium: videoTier(project.deliverables) === "premium",
    editorBrief: officeOnly ? project.editorBrief : null,
    reelHook: officeOnly ? project.reelHook : null,
    reelScript: officeOnly ? project.reelScript : null,
    reelSong: officeOnly ? project.reelSong : null,
    deliverables: project.deliverables
      .filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")
      .map((d) => d.label || d.type),
    submissions,
    active,
    notes: noteRows.map((n) => ({
      id: n.id,
      assetUrl: n.assetUrl,
      timeSec: n.timeSec,
      lane: n.lane,
      kind: n.kind,
      body: n.body,
      status: n.status,
      authorName: n.authorName,
      createdAt: n.createdAt.toISOString(),
      ask: n.lane === "EDITOR" && !!n.photographerId,
      replies: n.replies.map((r) => ({
        id: r.id,
        body: r.body,
        authorName: r.authorName,
        createdAt: r.createdAt.toISOString(),
      })),
    })),
  };
}
