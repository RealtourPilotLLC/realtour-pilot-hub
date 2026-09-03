import "server-only";
import { prisma } from "@/lib/prisma";
import { editorRouting } from "@/lib/settings";
import { editorForDeliverable, editorKeyForTeamName, editorMeta } from "@/lib/editors";
import { cutKeyOf } from "@/lib/reviewCuts";
import { videoTier } from "@/lib/projectStatus";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { etAddDays } from "@/lib/datetime";
import type { QueueRow } from "@/components/editing/SimpleQueue";

// The Editor Queue's row builder, extracted from /editing so the message
// center (/editing/messages) can reuse the exact same job set and the same
// resolved-editor ladder for scoping an editor's view. Everything the two
// pages disagree on stays in the pages; this file only answers "what jobs,
// and whose are they?".

// Project status → the Slack ladder's words, verbatim from the Loom.
// APPROVED isn't a Project status: it's the video lane's own answer when every
// cut the job owes has passed review but the job hasn't been delivered yet.
// Such a row must stop saying "Ready for review" — nobody is waiting on a
// human any more, so an editor reading the queue would chase a ghost.
export const STATUS_LABEL: Record<string, string> = {
  // Past-shoot BOOKED/SCHEDULED = shot but raws not in yet → Slack's "Waiting".
  BOOKED: "Waiting",
  SCHEDULED: "Waiting",
  SHOT: "Ready for editing",
  EDITING: "In editing",
  REVIEW: "Ready for review",
  REVISION: "Revisions",
  APPROVED: "Approved",
  DELIVERED: "Completed",
};

export async function buildEditorQueue(): Promise<{ notDone: QueueRow[]; upcoming: QueueRow[]; done: QueueRow[] }> {
  const rules = await editorRouting();
  const now = new Date();
  const deliveredCutoff = etAddDays(now, -60);
  const [inflight, scheduled, deliveredRaw] = await Promise.all([
    prisma.project.findMany({
      // Past-shoot BOOKED/SCHEDULED jobs belong here too (as "Waiting"): the
      // shoot happened but raws haven't landed — they were falling between
      // the Not-Done and Upcoming rails and vanishing entirely (Aug 18 audit:
      // four monthly jobs actively being shot were invisible). 7-day window
      // so ancient stale bookings don't pile up.
      where: {
        OR: [
          { status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } },
          { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { lt: now, gte: etAddDays(now, -7) } },
        ],
        aryeoMissingAt: null,
      },
      orderBy: [{ deliveryDue: { sort: "asc", nulls: "last" } }, { shootDate: { sort: "asc", nulls: "last" } }],
      include: { client: true, editor: true, photographer: true, deliverables: { where: { removedFromOrderAt: null } } },
    }),
    // Upcoming edits — Jordan: "any shoot on the schedule upcoming should be in
    // an upcoming edits tab". Every future-dated booked/scheduled job with a
    // video deliverable, however far out.
    prisma.project.findMany({
      where: { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { gte: now }, aryeoMissingAt: null },
      orderBy: { shootDate: "asc" },
      include: { client: true, editor: true, photographer: true, deliverables: { where: { removedFromOrderAt: null } } },
    }),
    prisma.project.findMany({
      where: { status: "DELIVERED", deliveredAt: { gte: deliveredCutoff } },
      orderBy: { deliveredAt: "desc" },
      take: 60,
      include: { client: true, editor: true, photographer: true, deliverables: { where: { removedFromOrderAt: null } } },
    }),
  ]);

  // The truth about WHO has an in-flight edit is the open task's assignedKey
  // (reassignments land there) — the routing rules only PREDICT for jobs with
  // no task yet. Without this, every row showed the current rule's editor and
  // misattributed Kim's and Luma's in-flight work to John Mark.
  const allIds = [...inflight, ...scheduled, ...deliveredRaw].map((p) => p.id);
  const [openTasks, msgCounts, cutRows] = await Promise.all([
    prisma.smartTask.findMany({
      where: {
        projectId: { in: inflight.map((p) => p.id) },
        taskType: { in: ["edit_video", "revision"] },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      select: { projectId: true, assignedKey: true, taskType: true },
    }),
    // The Slack messages column → the job's own chat. Revisions live THERE now,
    // not in channel dumps.
    prisma.projectMessage.groupBy({ by: ["projectId"], where: { projectId: { in: allIds } }, _count: true }),
    // What the Review Room actually holds for each in-flight job — the signal
    // every other "where is this job's video?" surface reads (Ops Day, the
    // Dashboard, the QC card; see reviewCuts.videoStatesFor). UPLOADING and
    // UPLOAD_FAILED rows are not cuts (bytes still moving, or never arrived);
    // SUPERSEDED ones were replaced by a newer version of the same cut.
    prisma.reviewSubmission.findMany({
      where: {
        projectId: { in: inflight.map((p) => p.id) },
        status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "SUPERSEDED"] },
      },
      orderBy: { round: "asc" },
      select: { id: true, projectId: true, deliverableId: true, slot: true, assetPath: true, round: true, status: true },
    }),
  ]);
  // This queue narrates the VIDEO lane only. A photo-retouch revision (Kyle's)
  // also lives on the project — it must not flip the video row to "Revisions",
  // pad the revision-ask chip, or show Kyle as the editor (Janice's "remove
  // the closets photos" ask did all three before this scoping).
  const VIDEO_LANE = new Set(["kim", "john", "remar", "luma"]);
  const taskEditor = new Map<string, string>();
  for (const t of openTasks) if (t.projectId && t.assignedKey && t.taskType === "edit_video") taskEditor.set(t.projectId, t.assignedKey);
  for (const t of openTasks)
    if (t.projectId && t.assignedKey && t.taskType === "revision" && VIDEO_LANE.has(t.assignedKey) && !taskEditor.has(t.projectId))
      taskEditor.set(t.projectId, t.assignedKey);
  // A NULL-key revision counts as video-lane too: personal-branding routing is
  // manual by design, so its revision task sits unassigned in "Needs assigning"
  // — it's still a video revision and must keep the row on "Revisions".
  const revisionCount = new Map<string, number>();
  for (const t of openTasks)
    if (t.taskType === "revision" && t.projectId && (t.assignedKey == null || VIDEO_LANE.has(t.assignedKey)))
      revisionCount.set(t.projectId, (revisionCount.get(t.projectId) ?? 0) + 1);
  const comments = new Map(msgCounts.map((m) => [m.projectId, m._count]));

  // Per job: how many cuts exist and what each one's LATEST round says. Only
  // the newest round of a cut (deliverable × slot; legacy folder rows by file
  // path — cutKeyOf, the identity every reader uses) speaks for it, or round
  // 1's "changes requested" would outvote the version 2 the editor already
  // sent back. Rows arrive round-ascending, so the last write per key wins.
  type CutTally = { total: number; waiting: number; revising: number; approved: number };
  const latestCut = new Map<string, { projectId: string; round: number; status: string }>();
  for (const s of cutRows) {
    const key = `${s.projectId}|${cutKeyOf(s)}`;
    const cur = latestCut.get(key);
    if (!cur || s.round > cur.round) latestCut.set(key, { projectId: s.projectId, round: s.round, status: s.status });
  }
  const cutTally = new Map<string, CutTally>();
  for (const c of latestCut.values()) {
    const t = cutTally.get(c.projectId) ?? { total: 0, waiting: 0, revising: 0, approved: 0 };
    t.total++;
    if (c.status === "PENDING") t.waiting++;
    else if (c.status === "CHANGES_REQUESTED") t.revising++;
    else if (c.status === "APPROVED") t.approved++;
    cutTally.set(c.projectId, t);
  }

  type P = (typeof inflight)[number];
  const hasVideo = (p: P) => p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const toRow = (p: P, upcoming = false): QueueRow => {
    const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    const monthly = isMonthlyContentJob(p.deliverables);
    const tier: QueueRow["tier"] = monthly ? "branding" : videoTier(p.deliverables) === "premium" ? "premium" : "standard";
    const assigned = taskEditor.get(p.id) ?? null;
    const routeKey = assigned ?? editorKeyForTeamName(p.editor?.name) ?? editorForDeliverable(v?.type, v?.label, monthly, rules);
    const videos = p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    // The BATCH size, not the number of order rows: a monthly plan is ONE
    // deliverable whose quantity is the batch (Starter 2 / Accelerator 4 /
    // Pro 8), so counting rows told the editor "1 video" for a 4-video
    // session (audit HIGH). videosFilmed, when the photographer reported it,
    // is the most truthful number of all. It is also how many cuts have to be
    // approved before the job's video work is finished.
    const videosOwed = p.videosFilmed ?? videos.reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
    const folders = projectFolderPaths(p);
    // Dropbox truth (from the evidence sweep, so it refreshes hourly) — drives
    // the uploaded-or-not dot on the RAW/Final link chips and the REVISION
    // guard below.
    let rawIn = 0;
    let finalIn = 0;
    let dropboxStale = false;
    let videoLive = false;
    try {
      const ev = JSON.parse(p.statusEvidence ?? "{}") as { present?: string[]; dropbox?: { rawVideo?: number; finalVideo?: number; stale?: boolean } | null };
      rawIn = ev.dropbox?.rawVideo ?? 0;
      finalIn = ev.dropbox?.finalVideo ?? 0;
      dropboxStale = !!ev.dropbox?.stale;
      // Already live on Aryeo → a cut exists, whatever the Review Room knows.
      videoLive = (ev.present ?? []).includes("Video");
    } catch { /* unreadable evidence → treat as empty */ }

    // ---- WHERE THE JOB'S VIDEO ACTUALLY IS -------------------------------
    // Project.status is a CLAIM — anyone can type it into the status pill, and
    // the hourly engines move it too. The Review Room is the RECORD of what
    // was really handed in, so the label is derived from the cuts themselves,
    // the same signals Ops Day / the Dashboard / QC read.
    // Why (Sep 2 readiness audit): rows said "Ready for review" for video that
    // was still in editing — 2530 Walnut St and 160 Kennedy Ln had no cut
    // anywhere, one of them wearing an overdue chip. John and Kim start
    // working out of this queue this week; a row that lies about who owes the
    // next move is worse than no row.
    const cut = cutTally.get(p.id);
    // Widened to string on purpose: APPROVED is a video-lane state, not one of
    // Prisma's ProjectStatus values — nothing here is ever written back.
    let effectiveStatus: string = p.status;
    if (!upcoming && p.status !== "DELIVERED") {
      if (cut) {
        // Same precedence as reviewCuts.videoStatesFor: a cut that came back
        // with changes outranks one still waiting — the editor owes the redo
        // before anyone owes a verdict. "Ready for review" therefore means
        // exactly one thing: a cut is uploaded and a human hasn't ruled yet.
        effectiveStatus =
          cut.revising > 0 ? "REVISION"
          : cut.waiting > 0 ? "REVIEW"
          : cut.approved >= Math.max(1, videosOwed) ? "APPROVED"
          // Part of the batch passed, the rest was never handed in — a
          // 4-video month with cut 1 approved is progress, not done.
          : "EDITING";
      } else if (p.status === "REVIEW" || (p.status === "REVISION" && (revisionCount.get(p.id) ?? 0) === 0)) {
        // The Room holds nothing for this job. Most jobs never pass through it
        // (folder discovery is off by default), so a file in the Final folder
        // or a video already live on Aryeo still counts as a cut. Neither one
        // present means nothing was handed in — REVIEW is a lie — and a
        // REVISION with no open VIDEO-lane ask was flipped by a photo ask
        // (Janice's "remove the closets photos" did exactly that). A stale
        // zero (Dropbox couldn't be read this pass) proves nothing, so the row
        // stays where it is rather than guessing.
        effectiveStatus = finalIn > 0 || videoLive ? "REVIEW" : dropboxStale ? p.status : "EDITING";
      }
    }
    return {
      id: p.id,
      street: (p.addressLine || p.title.split(",")[0] || "Job").trim(),
      client: p.client.name,
      // `include: { client: true }` above already carries Client.avatarUrl —
      // the agent's Aryeo headshot, shown beside the name in the queue row
      // (Jordan, Sep 2). A photo is creative-safe; nothing else from the
      // client record joins it.
      clientAvatarUrl: p.client.avatarUrl,
      tier,
      typeDetail: videos.map((d) => d.label || d.type).join(" · "),
      status: upcoming ? "Waiting" : STATUS_LABEL[effectiveStatus] ?? effectiveStatus,
      editor: (assigned ? editorMeta(assigned)?.name ?? assigned : null) ?? p.editor?.name ?? (routeKey ? editorMeta(routeKey)?.name ?? routeKey : null),
      // The key behind the name, for the row's reassign select. Same truth
      // ladder as the display: open task → Project.editor → routing rules.
      editorKey: routeKey,
      auto: !assigned && !p.editor && !!routeKey,
      dueISO: upcoming ? p.shootDate?.toISOString() ?? null : p.deliveryDue?.toISOString() ?? null,
      late: !upcoming && p.status !== "DELIVERED" && !!p.deliveryDue && p.deliveryDue < now,
      priority: p.priority,
      videos: videosOwed,
      hasScript: !!(p.reelScript || p.reelHook),
      comments: comments.get(p.id) ?? 0,
      rawUrl: dropboxWebUrl(folders.rawVideo),
      finalUrl: dropboxWebUrl(folders.finalVideo),
      rawCount: rawIn,
      finalCount: finalIn,
      shootISO: p.shootDate?.toISOString() ?? null,
      photographer: p.photographer?.name ?? null,
      openRevisions: revisionCount.get(p.id) ?? 0,
    };
  };

  return {
    notDone: inflight.filter(hasVideo).map((p) => toRow(p)),
    upcoming: scheduled.filter(hasVideo).map((p) => toRow(p, true)),
    done: deliveredRaw.filter(hasVideo).map((p) => toRow(p)),
  };
}

// ---- Message-center helpers ------------------------------------------------

export type LatestMsg = { body: string; authorName: string; createdAt: Date };

// Newest message per project, one query (distinct keeps the first row per
// projectId in createdAt-desc order).
export async function latestMessagePerProject(projectIds: string[]): Promise<Map<string, LatestMsg>> {
  if (projectIds.length === 0) return new Map();
  const rows = await prisma.projectMessage.findMany({
    where: { projectId: { in: projectIds } },
    orderBy: { createdAt: "desc" },
    distinct: ["projectId"],
    select: { projectId: true, body: true, authorName: true, createdAt: true },
  });
  return new Map(rows.map((r) => [r.projectId, { body: r.body, authorName: r.authorName ?? "Someone", createdAt: r.createdAt }]));
}

// How many of these threads have a message newer than the viewer's read
// watermark — the badge on the queue's Messages button.
export async function unreadThreadCount(userKey: string | null, projectIds: string[]): Promise<number> {
  if (!userKey || projectIds.length === 0) return 0;
  const [latest, reads] = await Promise.all([
    latestMessagePerProject(projectIds),
    prisma.threadRead.findMany({ where: { userKey }, select: { projectId: true, seenAt: true } }),
  ]);
  const seen = new Map(reads.map((r) => [r.projectId, r.seenAt]));
  let n = 0;
  for (const [pid, m] of latest) {
    const s = seen.get(pid);
    if (!s || m.createdAt > s) n++;
  }
  return n;
}
