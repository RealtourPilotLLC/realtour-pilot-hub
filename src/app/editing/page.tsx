import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { slugForName } from "@/lib/assignees";
import { EditorDay } from "@/components/editing/EditorDay";
import { AddToQueue } from "@/components/editing/AddToQueue";
import { FloatingStyleGuide } from "@/components/editing/FloatingStyleGuide";
import { SimpleQueue, type QueueRow } from "@/components/editing/SimpleQueue";
import { editorRouting } from "@/lib/settings";
import { editorForDeliverable, editorKeyForTeamName, editorMeta } from "@/lib/editors";
import { videoTier } from "@/lib/projectStatus";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { etAddDays } from "@/lib/datetime";
import { cleanBrief, parseShootBrief } from "@/lib/shoot";

export const dynamic = "force-dynamic";

// The customer's OWN words live in the Aryeo appointment brief — their intake
// answers ("Special Instructions for the photographer", "Order Notes"), which
// until now died on /shoot and never reached anyone editing the job.
const APPT = {
  appointments: { select: { description: true }, orderBy: { startAt: "asc" as const }, take: 1 },
};

// The order's editorially-relevant note: the special instructions first (that's
// where people actually write "shoot horizontal", "coming-soon teaser only"),
// then any Order Notes. Aryeo writes a literal "n/a" when the field was left
// blank — that's not a note, so drop it.
const realNote = (s?: string | null) => {
  const t = (s ?? "").trim();
  return t && !/^n\/?a\.?$/i.test(t) ? t : null;
};
function aryeoCustomerNote(description?: string | null): string | null {
  const parsed = description ? parseShootBrief(cleanBrief(description)) : null;
  if (!parsed) return null;
  const parts = [realNote(parsed.special), realNote(parsed.orderNotes)].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

// The Editor dashboard is VIDEO-ONLY — photos are edited by AI, so editors only
// touch video/reel jobs.
//   · EDITOR (Kim / John Mark) → their guided personal worklist (EditorDay).
//   · OWNER / ADMIN → the Slack-tracker view, rebuilt in-hub (Jordan: "make
//     this editor queue as simple as possible … I really like the way we have
//     it set up in Slack"): Queue | Upcoming edits | Delivered, one row per
//     job. The old SLA-panel + tracker-spreadsheet stack is gone — per-job
//     controls (reassign, review, chat) live on /edit/<id>.
// Project status → the Slack ladder's words, verbatim from the Loom.
const STATUS_LABEL: Record<string, string> = {
  // Past-shoot BOOKED/SCHEDULED = shot but raws not in yet → Slack's "Waiting".
  BOOKED: "Waiting",
  SCHEDULED: "Waiting",
  SHOT: "Ready for editing",
  EDITING: "In editing",
  REVIEW: "Ready for review",
  REVISION: "Revisions",
  DELIVERED: "Completed",
};

export default async function EditorQueuePage() {
  const me = await getCurrentUser().catch(() => null);
  const editorScope = me?.role === "EDITOR" ? (me.editorKey || (me.name ? slugForName(me.name) : null)) : null;

  if (me?.role === "EDITOR" && editorScope) {
    return <EditorDay editorScope={editorScope} editorName={me.name ?? "there"} />;
  }
  // An EDITOR whose login has no editorKey AND no name can't be scoped — fail
  // closed with a nudge, never fall through to the all-jobs view below.
  if (me?.role === "EDITOR") {
    return (
      <div>
        <PageHeader eyebrow="Video projects only" title="Editor Queue" />
        <p className="m-4 rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted sm:m-6">
          Your login isn&rsquo;t linked to an editor profile yet — ask Jordan to set your editor key and your
          queue will show up here.
        </p>
      </div>
    );
  }

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
      include: { client: true, editor: true, photographer: true, deliverables: true, ...APPT },
    }),
    // Upcoming edits — Jordan: "any shoot on the schedule upcoming should be in
    // an upcoming edits tab". Every future-dated booked/scheduled job with a
    // video deliverable, however far out.
    prisma.project.findMany({
      where: { status: { in: ["BOOKED", "SCHEDULED"] }, shootDate: { gte: now } },
      orderBy: { shootDate: "asc" },
      include: { client: true, editor: true, photographer: true, deliverables: true, ...APPT },
    }),
    prisma.project.findMany({
      where: { status: "DELIVERED", deliveredAt: { gte: deliveredCutoff } },
      orderBy: { deliveredAt: "desc" },
      take: 60,
      include: { client: true, editor: true, photographer: true, deliverables: true, ...APPT },
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
    // A REVISION project with no open VIDEO-lane revision was flipped by a
    // photo ask — show the video's own state instead (cut in the final folder
    // → Ready for review; otherwise still In editing).
    let effectiveStatus = p.status;
    if (!upcoming && p.status === "REVISION" && (revisionCount.get(p.id) ?? 0) === 0) {
      let finalVideo = 0;
      try {
        finalVideo = (JSON.parse(p.statusEvidence ?? "{}") as { dropbox?: { finalVideo?: number } })?.dropbox?.finalVideo ?? 0;
      } catch { /* unreadable evidence → assume still editing */ }
      effectiveStatus = finalVideo > 0 ? "REVIEW" : "EDITING";
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
      // Three different voices, kept separate on purpose: what the customer
      // asked for on the ORDER, what we've since written about this job, and
      // the client's standing style preferences.
      orderNotes: aryeoCustomerNote(p.appointments[0]?.description),
      customerNotes: p.notes ?? null,
      clientPrefs: p.client.editingPreferences ?? null,
      photographerNotes: p.editorBrief ?? null,
      videos: videos.length,
      hasScript: !!(p.reelScript || p.reelHook),
      comments: comments.get(p.id) ?? 0,
      rawUrl: dropboxWebUrl(folders.rawVideo),
      finalUrl: dropboxWebUrl(folders.finalVideo),
      shootISO: p.shootDate?.toISOString() ?? null,
      photographer: p.photographer?.name ?? null,
      openRevisions: revisionCount.get(p.id) ?? 0,
    };
  };

  const notDone = inflight.filter(hasVideo).map((p) => toRow(p));
  const upcomingRows = scheduled.filter(hasVideo).map((p) => toRow(p, true));
  const done = deliveredRaw.filter(hasVideo).map((p) => toRow(p));

  return (
    <div>
      <PageHeader
        eyebrow="Video projects only"
        title="Editor Queue"
        subtitle={`${notDone.length} open · ${upcomingRows.length} upcoming`}
        // Pop-up Style Guide — a draggable floating window (remembers where
        // you put it), so the guide can sit beside the queue while working.
        actions={<FloatingStyleGuide />}
      />
      {/* Wide on purpose — the Slack List is a wide table; max-w-4xl squeezed
          every column into a horizontal scroll. */}
      <div className="mx-auto max-w-7xl space-y-4 p-4 pb-16 sm:p-6">
        {/* Manual add — the human override for jobs the automatic handoff never
            picks up (video added after booking, old footage, non-Aryeo work). */}
        <AddToQueue />
        {/* Owners, admins and photographers can correct the notes; editors read
            them. realRole, so a "view as" preview can't write. */}
        <SimpleQueue
          notDone={notDone}
          upcoming={upcomingRows}
          done={done}
          canEditNotes={["OWNER", "ADMIN", "PHOTOGRAPHER"].includes(me?.realRole ?? "OWNER") && !me?.impersonating}
        />
      </div>
    </div>
  );
}
