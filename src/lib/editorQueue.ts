import "server-only";
import { prisma } from "@/lib/prisma";
import { editorRouting } from "@/lib/settings";
import { editorForDeliverable, editorKeyForTeamName, editorMeta } from "@/lib/editors";
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
export const STATUS_LABEL: Record<string, string> = {
  // Past-shoot BOOKED/SCHEDULED = shot but raws not in yet → Slack's "Waiting".
  BOOKED: "Waiting",
  SCHEDULED: "Waiting",
  SHOT: "Ready for editing",
  EDITING: "In editing",
  REVIEW: "Ready for review",
  REVISION: "Revisions",
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
      },
      orderBy: [{ deliveryDue: { sort: "asc", nulls: "last" } }, { shootDate: { sort: "asc", nulls: "last" } }],
      include: { client: true, editor: true, photographer: true, deliverables: true },
    }),
    // Upcoming edits — Jordan: "any shoot on the schedule upcoming should be in
    // an upcoming edits tab". Every future-dated booked/scheduled job with a
    // video deliverable, however far out.
    prisma.project.findMany({
      where: { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { gte: now } },
      orderBy: { shootDate: "asc" },
      include: { client: true, editor: true, photographer: true, deliverables: true },
    }),
    prisma.project.findMany({
      where: { status: "DELIVERED", deliveredAt: { gte: deliveredCutoff } },
      orderBy: { deliveredAt: "desc" },
      take: 60,
      include: { client: true, editor: true, photographer: true, deliverables: true },
    }),
  ]);

  // The truth about WHO has an in-flight edit is the open task's assignedKey
  // (reassignments land there) — the routing rules only PREDICT for jobs with
  // no task yet. Without this, every row showed the current rule's editor and
  // misattributed Kim's and Luma's in-flight work to John Mark.
  const allIds = [...inflight, ...scheduled, ...deliveredRaw].map((p) => p.id);
  const [openTasks, msgCounts] = await Promise.all([
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

  type P = (typeof inflight)[number];
  const hasVideo = (p: P) => p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const toRow = (p: P, upcoming = false): QueueRow => {
    const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    const monthly = isMonthlyContentJob(p.deliverables);
    const tier: QueueRow["tier"] = monthly ? "branding" : videoTier(p.deliverables) === "premium" ? "premium" : "standard";
    const assigned = taskEditor.get(p.id) ?? null;
    const routeKey = assigned ?? editorKeyForTeamName(p.editor?.name) ?? editorForDeliverable(v?.type, v?.label, monthly, rules);
    const videos = p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    const folders = projectFolderPaths(p);
    // Dropbox truth (from the evidence sweep, so it refreshes hourly) — drives
    // the uploaded-or-not dot on the RAW/Final link chips and the REVISION
    // guard below.
    let rawIn = 0;
    let finalIn = 0;
    try {
      const ev = (JSON.parse(p.statusEvidence ?? "{}") as { dropbox?: { rawVideo?: number; finalVideo?: number } | null })?.dropbox;
      rawIn = ev?.rawVideo ?? 0;
      finalIn = ev?.finalVideo ?? 0;
    } catch { /* unreadable evidence → treat as empty */ }
    // A REVISION project with no open VIDEO-lane revision was flipped by a
    // photo ask — show the video's own state instead (cut in the final folder
    // → Ready for review; otherwise still In editing).
    let effectiveStatus = p.status;
    if (!upcoming && p.status === "REVISION" && (revisionCount.get(p.id) ?? 0) === 0) {
      effectiveStatus = finalIn > 0 ? "REVIEW" : "EDITING";
    }
    return {
      id: p.id,
      street: (p.addressLine || p.title.split(",")[0] || "Job").trim(),
      client: p.client.name,
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
      videos: videos.length,
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
