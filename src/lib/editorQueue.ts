import "server-only";
import { prisma } from "@/lib/prisma";
import { editorRouting } from "@/lib/settings";
import { type EditorKey, editorForDeliverable, editorKeyForTeamName, editorMeta, VIDEO_LANE_KEYS } from "@/lib/editors";
import { appBase } from "@/lib/appUrl";
import { cutKeyOf } from "@/lib/reviewCuts";
import { videoTier } from "@/lib/projectStatus";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { actualFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { etAddDays } from "@/lib/datetime";
import { EDIT_ROUND_SUMMARY, OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { WAITING_HOLD_PREFIX } from "@/lib/queueWaiting";
import {
  computedVideosOwed,
  computedView,
  effectiveDue,
  effectivePriority,
  effectiveTier,
  effectiveTypeDetail,
  effectiveVideosOwed,
  overrideView,
  statusPinned,
} from "@/lib/editOverrides";
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
  // Jobs the office put back to Waiting (Sep 11, queueWaiting.ts) stay in Not
  // Done however old the shoot: the 7-day window below is for stale bookings
  // nobody touched, and a hold is the opposite — the office is watching for
  // that footage. Dateless (BOOKED) holds ride here too; a held job whose
  // shoot is still ahead lands in Upcoming as before.
  const heldIds = (
    await prisma.appSetting.findMany({ where: { key: { startsWith: WAITING_HOLD_PREFIX } }, select: { key: true } })
  ).map((r) => r.key.slice(WAITING_HOLD_PREFIX.length));
  const heldSet = new Set(heldIds);
  const [inflight, scheduled, deliveredRaw] = await Promise.all([
    prisma.project.findMany({
      // Past-shoot BOOKED/SCHEDULED jobs belong here too (as "Waiting"): the
      // shoot happened but raws haven't landed — they were falling between
      // the Not-Done and Upcoming rails and vanishing entirely (Aug 18 audit:
      // four monthly jobs actively being shot were invisible). 7-day window
      // so ancient stale bookings don't pile up — except a held one (above).
      where: {
        OR: [
          { status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } },
          { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { lt: now, gte: etAddDays(now, -7) } },
          { status: { in: ["BOOKED", "SCHEDULED"] }, id: { in: heldIds }, OR: [{ shootDate: { lt: now } }, { shootDate: null }] },
          // A Waiting the office PINNED through the override dialog (Sep 13,
          // editOverrides.ts) is the same kind of watched job as a hold: it
          // stays in Not Done past the 7-day window until the office moves it.
          { status: { in: ["BOOKED", "SCHEDULED"] }, statusPinnedAt: { not: null }, OR: [{ shootDate: { lt: now } }, { shootDate: null }] },
        ],
        aryeoMissingAt: null,
      },
      orderBy: [{ deliveryDue: { sort: "asc", nulls: "last" } }, { shootDate: { sort: "asc", nulls: "last" } }],
      include: { client: true, editor: true, photographer: true, deliverables: { where: OWED_DELIVERABLE_WHERE } },
    }),
    // Upcoming edits — Jordan: "any shoot on the schedule upcoming should be in
    // an upcoming edits tab". Every future-dated booked/scheduled job with a
    // video deliverable, however far out.
    prisma.project.findMany({
      where: { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { gte: now }, aryeoMissingAt: null },
      orderBy: { shootDate: "asc" },
      include: { client: true, editor: true, photographer: true, deliverables: { where: OWED_DELIVERABLE_WHERE } },
    }),
    prisma.project.findMany({
      where: { status: "DELIVERED", deliveredAt: { gte: deliveredCutoff } },
      orderBy: { deliveredAt: "desc" },
      take: 60,
      include: { client: true, editor: true, photographer: true, deliverables: { where: OWED_DELIVERABLE_WHERE } },
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
      // assignedManually: a NULL key on a hand-pinned task is not "nobody has
      // got round to it yet", it is the owner deliberately taking the job off
      // the bench (see UNPINNED below). summary: a "Round N — …" edit card is
      // the video lane's redo signal (see ROUND ON THE CARD below).
      select: { projectId: true, assignedKey: true, taskType: true, assignedManually: true, summary: true },
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
  const VIDEO_LANE = new Set<string>(VIDEO_LANE_KEYS);
  const taskEditor = new Map<string, string>();
  for (const t of openTasks) if (t.projectId && t.assignedKey && t.taskType === "edit_video") taskEditor.set(t.projectId, t.assignedKey);
  // UNASSIGNED ON PURPOSE. Jordan, Sep 7: "I want to be able to unassign
  // projects from editors… that way, our editors don't see jobs that are not
  // assigned to them." Without this the ladder below falls through to the
  // routing rules and predicts John or Kim right back onto the row — the job
  // would reappear in the queue it was just taken out of. A hand-pinned task
  // with no key (assignedManually + assignedKey null), or a project pinned to
  // nobody (editorManual with no editorId), is that deliberate "nobody", and
  // it stops the prediction. An unpinned row still predicts, exactly as before
  // — an upcoming shoot nobody has touched is still John's or Kim's on the
  // rules, and taking that away would empty their Upcoming tab.
  const unpinned = new Set<string>();
  for (const t of openTasks)
    if (t.projectId && !t.assignedKey && t.assignedManually && (t.taskType === "edit_video" || t.taskType === "revision"))
      unpinned.add(t.projectId);
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
  // ROUND ON THE CARD (Sep 8). A Review Room send-back and the queue's own
  // "Revisions" flip no longer mint a revision task — they add a round to
  // the job's edit_video card (one card per cut; tasks.addRoundToEditCard),
  // whose summary then starts "Round N — …" until the editor hands the next
  // version in. That open round IS the editor owing a redo, so it counts
  // like a bounced cut: without it the flip stopped sticking — the next
  // render put the row straight back on Ready for review / In editing off
  // the old cut (Sep 8 review).
  const roundOwed = new Set<string>();
  for (const t of openTasks)
    if (t.taskType === "edit_video" && t.projectId && EDIT_ROUND_SUMMARY.test(t.summary ?? "")) roundOwed.add(t.projectId);
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

  // The hub's real origin for the row's Copy-link button. Built here, on the
  // server, NOT from window.location in the browser: Jordan copies these off
  // his own machine to paste to John and Kim, and a localhost link would be
  // dead on arrival in Manila. appBase() is the one place that knows the
  // public host (hub.realtourpilot.com in production).
  const base = appBase();

  type P = (typeof inflight)[number];
  const hasVideo = (p: P) => p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const toRow = (p: P, upcoming = false): QueueRow => {
    const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    const monthly = isMonthlyContentJob(p.deliverables);
    // The hub's own verdict; the office's override (Sep 13) is applied to the
    // row below, and both travel on it (`computed` / `overrides`) so the
    // dialog can show what "Use the hub's value" hands back.
    const computedTier: QueueRow["tier"] = monthly ? "branding" : videoTier(p.deliverables) === "premium" ? "premium" : "standard";
    const tier: QueueRow["tier"] = effectiveTier(p, computedTier);
    const assigned = taskEditor.get(p.id) ?? null;
    // "Nobody" is a real answer, not a gap: an owner who unassigned this job
    // (task pin, or the project pinned to no editor) means it, so the routing
    // rules do not get to guess a name back onto the row.
    const takenOff = unpinned.has(p.id) || (p.editorManual && !p.editorId);
    const routeKey =
      assigned ??
      editorKeyForTeamName(p.editor?.name) ??
      // An upcoming job handed to the outside shop has no task and no
      // TeamMember — the vendor key on the project is the only record of it.
      ((p.editorVendorKey ?? null) as EditorKey | null) ??
      (takenOff ? null : editorForDeliverable(v?.type, v?.label, monthly, rules));
    const videos = p.deliverables.filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    // The BATCH size, not the number of order rows: a monthly plan is ONE
    // deliverable whose quantity is the batch (Starter 2 / Accelerator 4 /
    // Pro 8), so counting rows told the editor "1 video" for a 4-video
    // session (audit HIGH). videosFilmed, when the photographer reported it,
    // is the most truthful number of all. It is also how many cuts have to be
    // approved before the job's video work is finished.
    // The office's number (videosOwedOverride) wins over both (Sep 13).
    const computedVideos = computedVideosOwed(p, videos);
    const videosOwed = effectiveVideosOwed(p, videos);
    // The job's OWN folder (a same-street re-shoot or a month-moved shoot lives
    // off the convention path — audit, Sep 8).
    const folders = actualFolderPaths(p);
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
        // A round still open on the edit card outranks a waiting cut too: the
        // human said "Revisions" on the queue (or the Room bounced it) and
        // the editor has not handed the next version in yet.
        effectiveStatus =
          cut.revising > 0 || roundOwed.has(p.id) ? "REVISION"
          : cut.waiting > 0 ? "REVIEW"
          : cut.approved >= Math.max(1, videosOwed) ? "APPROVED"
          // Part of the batch passed, the rest was never handed in — a
          // 4-video month with cut 1 approved is progress, not done.
          : "EDITING";
      } else if (p.status === "REVIEW" || (p.status === "REVISION" && (revisionCount.get(p.id) ?? 0) === 0 && !roundOwed.has(p.id))) {
        // The Room holds nothing for this job. Most jobs never pass through it
        // (folder discovery is off by default), so a file in the Final folder
        // or a video already live on Aryeo still counts as a cut. Neither one
        // present means nothing was handed in — REVIEW is a lie — and a
        // REVISION with no open VIDEO-lane ask was flipped by a photo ask
        // (Janice's "remove the closets photos" did exactly that). A stale
        // zero (Dropbox couldn't be read this pass) proves nothing, so the row
        // stays where it is rather than guessing.
        // Nothing handed in reads "Ready for editing", not "In editing" (Sep
        // 10, Jordan: nothing is in editing until the editor says so on this
        // pill — and the status here is REVIEW/REVISION, so nobody has). Same
        // words Kyle's QC card gives these jobs (reviewCuts.videoStatesFor).
        effectiveStatus = finalIn > 0 || videoLive ? "REVIEW" : dropboxStale ? p.status : "SHOT";
      }
    }
    // THE OFFICE'S PIN (Sep 13, editOverrides.ts). A pinned status is the
    // office's word over the cuts: the row reads Project.status itself — the
    // value the override dialog wrote and every engine now leaves alone —
    // instead of the cut-derived ladder above, and `overrides.statusPinned`
    // is the marker the row draws the pin from. Upcoming rows too: a pinned
    // job reads what was pinned, wherever its shoot date sits.
    const pinned = statusPinned(p);
    if (pinned) effectiveStatus = p.status;
    const computedTypeDetail = videos.map((d) => d.label || d.type).join(" · ");
    const computedDue = upcoming ? null : p.deliveryDue ?? null;
    const due = upcoming ? p.shootDate ?? null : effectiveDue(p, computedDue);
    return {
      id: p.id,
      url: `${base}/edit/${p.id}`,
      street: (p.addressLine || p.title.split(",")[0] || "Job").trim(),
      client: p.client.name,
      // `include: { client: true }` above already carries Client.avatarUrl —
      // the agent's Aryeo headshot, shown beside the name in the queue row
      // (Jordan, Sep 2). A photo is creative-safe; nothing else from the
      // client record joins it.
      clientAvatarUrl: p.client.avatarUrl,
      tier,
      typeDetail: effectiveTypeDetail(p, computedTypeDetail),
      status: upcoming && !pinned ? "Waiting" : STATUS_LABEL[effectiveStatus] ?? effectiveStatus,
      // The office is holding this job in Waiting (Sep 11): the pill on the
      // editor's queue greys every option on such a row — only the office or
      // the photographer's upload-page submit moves it on. A marker on a job
      // that is no longer on Waiting is stale and does not count.
      held: heldSet.has(p.id) && (p.status === "BOOKED" || p.status === "SCHEDULED"),
      editor: (assigned ? editorMeta(assigned)?.name ?? assigned : null) ?? p.editor?.name ?? (routeKey ? editorMeta(routeKey)?.name ?? routeKey : null),
      // The key behind the name, for the row's reassign select. Same truth
      // ladder as the display: open task → Project.editor → routing rules.
      editorKey: routeKey,
      auto: !assigned && !p.editor && !!routeKey,
      // Upcoming rows show the shoot date here (no clock has started); every
      // other row shows the delivery due — the office's date when set.
      dueISO: due?.toISOString() ?? null,
      late: !upcoming && p.status !== "DELIVERED" && !!due && due < now,
      priority: effectivePriority(p, p.priority),
      videos: videosOwed,
      // What the office set (null = nothing) and what the hub would say on its
      // own — the two columns of the override dialog (Sep 13).
      overrides: overrideView(p),
      computed: computedView({
        dueAt: computedDue,
        videosOwed: computedVideos,
        tier: computedTier,
        typeDetail: computedTypeDetail,
        priority: p.priority,
      }),
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

// `id` (Sep 16): the list rows deep-link to the newest message itself
// (?t=<projectId>#msg-<id>) now that the board anchors every message.
export type LatestMsg = { id: string; body: string; authorName: string; createdAt: Date };

// Newest message per project, one query (distinct keeps the first row per
// projectId in createdAt-desc order).
export async function latestMessagePerProject(projectIds: string[]): Promise<Map<string, LatestMsg>> {
  if (projectIds.length === 0) return new Map();
  const rows = await prisma.projectMessage.findMany({
    where: { projectId: { in: projectIds } },
    orderBy: { createdAt: "desc" },
    distinct: ["projectId"],
    select: { id: true, projectId: true, body: true, authorName: true, createdAt: true },
  });
  return new Map(rows.map((r) => [r.projectId, { id: r.id, body: r.body, authorName: r.authorName ?? "Someone", createdAt: r.createdAt }]));
}

// A viewer's fold on a thread (ThreadRead.closedAt, Sep 16) holds only while
// nothing newer than the fold has been posted: postProjectMessage clears the
// column on every post, but a message written straight to the table (the
// shoot-complete line, a task note) must reopen the row on sight too, or a
// closed thread could swallow a new message. One rule for every reader.
export const threadIsClosed = (closedAt: Date | null | undefined, latest: { createdAt: Date } | null | undefined): boolean =>
  !!closedAt && !(latest && latest.createdAt > closedAt);

// How many of these threads have a message newer than the viewer's read
// watermark — the badge on the queue's Messages button. A thread the viewer
// closed (and nobody has posted on since) does not count.
export async function unreadThreadCount(userKey: string | null, projectIds: string[]): Promise<number> {
  if (!userKey || projectIds.length === 0) return 0;
  const [latest, reads] = await Promise.all([
    latestMessagePerProject(projectIds),
    prisma.threadRead.findMany({ where: { userKey }, select: { projectId: true, seenAt: true, closedAt: true } }),
  ]);
  const seen = new Map(reads.map((r) => [r.projectId, r]));
  let n = 0;
  for (const [pid, m] of latest) {
    const s = seen.get(pid);
    if (threadIsClosed(s?.closedAt, m)) continue;
    if (!s || m.createdAt > s.seenAt) n++;
  }
  return n;
}

// ---- Team chat by property (Sep 16, Kyle call) ------------------------------
// The one conversation list behind /editing/messages AND Communications →
// Team. An editor's list is their lane of the video queue, exactly as before
// (the same resolved-editor ladder buildEditorQueue runs). The office's list
// is wider than the video queue was: every job that has a thread at all
// (photo-only jobs included — 358 N Church's chat never appeared before) plus
// every job in flight, so a job with no thread yet is still one click from
// starting one.

export type ChatConversation = {
  id: string;
  street: string;
  client: string;
  /** The rail's word for the job's state ("In editing", "Ready for review"…). */
  status: string;
  /** Sort weight for jobs without a thread: shoot/delivery date, nulls last. */
  sortAt: Date | null;
};

export type ChatScope = { kind: "editor"; editorKey: string } | { kind: "office" };

export async function teamChatConversations(scope: ChatScope): Promise<ChatConversation[]> {
  if (scope.kind === "editor") {
    const { notDone, upcoming, done } = await buildEditorQueue();
    return [...notDone, ...upcoming, ...done]
      .filter((r) => r.editorKey === scope.editorKey)
      .map((r) => ({ id: r.id, street: r.street, client: r.client, status: r.status, sortAt: r.dueISO ? new Date(r.dueISO) : null }));
  }
  const now = new Date();
  const [threaded, active] = await Promise.all([
    prisma.projectMessage.groupBy({ by: ["projectId"] }),
    prisma.project.findMany({
      where: {
        aryeoMissingAt: null,
        OR: [
          { status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } },
          // Booked work close enough to talk about: last week's shoots whose
          // raws may still be landing, and the next two weeks on the schedule.
          { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { gte: etAddDays(now, -7), lte: etAddDays(now, 14) } },
        ],
      },
      select: { id: true },
    }),
  ]);
  const ids = Array.from(new Set([...threaded.map((t) => t.projectId), ...active.map((p) => p.id)]));
  if (ids.length === 0) return [];
  const projects = await prisma.project.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      title: true,
      addressLine: true,
      status: true,
      shootDate: true,
      deliveryDue: true,
      client: { select: { name: true } },
    },
  });
  return projects.map((p) => ({
    id: p.id,
    street: (p.addressLine || p.title.split(",")[0] || "Job").trim(),
    client: p.client.name,
    status: STATUS_LABEL[p.status] ?? p.status,
    sortAt: p.deliveryDue ?? p.shootDate ?? null,
  }));
}
