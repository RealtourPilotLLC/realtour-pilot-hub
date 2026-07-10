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
  premium: boolean;
  round: number;
  status: string;
  submittedByName: string | null;
  note: string | null;
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
  dueAt: string | null;
  assignedKey: string | null;
};

export type QueueFollowUp = {
  projectId: string;
  street: string;
  lane: "EDIT" | "PHOTOGRAPHER" | "EDITOR";
  open: number;
  awaitingReReview: number; // FIXED, waiting on the owner to approve
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
  const [subs, qcTasks, noteRollup] = await Promise.all([
    prisma.reviewSubmission.findMany({
      where: {
        OR: [
          { status: { in: ["PENDING", "CHANGES_REQUESTED"] } },
          { status: "APPROVED", decidedAt: { gte: since } },
        ],
      },
      orderBy: { createdAt: "desc" },
      include: {
        project: {
          select: {
            id: true,
            title: true,
            client: { select: { name: true, socialClient: true } },
            deliverables: { select: { type: true, label: true } },
          },
        },
      },
    }),
    prisma.smartTask.findMany({
      where: { taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }],
      select: {
        id: true,
        projectId: true,
        dueAt: true,
        assignedKey: true,
        propertyAddress: true,
        project: { select: { title: true, client: { select: { name: true } } } },
      },
    }),
    prisma.mediaNote.groupBy({
      by: ["projectId", "lane", "status"],
      where: { parentId: null, status: { in: ["OPEN", "FIXED"] } },
      _count: true,
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
    premium: videoTier(s.project?.deliverables ?? []) === "premium",
    round: s.round,
    status: s.status,
    submittedByName: s.submittedByName,
    note: s.note,
    hasAsset: !!s.assetUrl,
    createdAt: s.createdAt.toISOString(),
    decidedAt: s.decidedAt ? s.decidedAt.toISOString() : null,
    openEditorNotes: editorOpenByProject.get(s.projectId) ?? 0,
  });

  // Only the LATEST round per project belongs in the queue lists — older rounds
  // are history and live in the workspace timeline instead.
  const latestByProject = new Map<string, (typeof subs)[number]>();
  for (const s of subs) {
    const cur = latestByProject.get(s.projectId);
    if (!cur || s.round > cur.round) latestByProject.set(s.projectId, s);
  }
  const latest = [...latestByProject.values()];

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
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      assignedKey: t.assignedKey,
    })),
    followUps: [...followMap.values()].sort((a, b) => b.open - a.open),
  };
}

// --------------------------- Cut workspace ---------------------------------

export type CutSubmission = {
  id: string;
  round: number;
  status: string;
  assetUrl: string | null;
  fileName: string | null;
  note: string | null;
  submittedByKey: string | null;
  submittedByName: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
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
  replies: { id: string; body: string; authorName: string | null; createdAt: string }[];
};

export type CutWorkspace = {
  projectId: string;
  street: string;
  title: string;
  status: string;
  clientName: string;
  premium: boolean;
  frameioViewUrl: string | null;
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
    replies: n.replies.map((r) => ({
      id: r.id,
      body: r.body,
      authorName: r.authorName,
      createdAt: r.createdAt.toISOString(),
    })),
  }));
}

export async function getCutWorkspace(projectId: string): Promise<CutWorkspace | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      status: true,
      frameioViewUrl: true,
      editorBrief: true,
      reelHook: true,
      reelScript: true,
      reelSong: true,
      client: { select: { name: true, socialClient: true } },
      deliverables: { select: { type: true, label: true } },
      reviewSubmissions: { orderBy: { round: "desc" } },
    },
  });
  if (!project) return null;

  const submissions: CutSubmission[] = project.reviewSubmissions.map((s) => ({
    id: s.id,
    round: s.round,
    status: s.status,
    assetUrl: s.assetUrl,
    fileName: s.fileName,
    note: s.note,
    submittedByKey: s.submittedByKey,
    submittedByName: s.submittedByName,
    createdAt: s.createdAt.toISOString(),
    decidedAt: s.decidedAt ? s.decidedAt.toISOString() : null,
    decidedBy: s.decidedBy,
  }));
  const active = submissions[0] ?? null;

  // Notes for the active cut. Cuts with no minted link store notes under the
  // synthetic cut:<submissionId> asset key so feedback still threads correctly.
  const activeAssetKey = active ? (active.assetUrl ?? `cut:${active.id}`) : null;
  const noteRows = activeAssetKey
    ? await prisma.mediaNote.findMany({
        where: { projectId, parentId: null, assetUrl: activeAssetKey },
        orderBy: { createdAt: "asc" },
        include: { replies: { orderBy: { createdAt: "asc" } } },
      })
    : [];

  return {
    projectId: project.id,
    street: streetOf(project.title),
    title: project.title,
    status: project.status,
    clientName: project.client?.name ?? "",
    premium: videoTier(project.deliverables) === "premium",
    frameioViewUrl: project.frameioViewUrl,
    editorBrief: project.editorBrief,
    reelHook: project.reelHook,
    reelScript: project.reelScript,
    reelSong: project.reelSong,
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
      replies: n.replies.map((r) => ({
        id: r.id,
        body: r.body,
        authorName: r.authorName,
        createdAt: r.createdAt.toISOString(),
      })),
    })),
  };
}
