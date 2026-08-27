import Link from "next/link";
import { Bell } from "lucide-react";
import { requirePageAccess } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { slugForName } from "@/lib/assignees";
import { AddToQueue } from "@/components/editing/AddToQueue";
import { FloatingStyleGuide } from "@/components/editing/FloatingStyleGuide";
import { SimpleQueue, type QueueRow } from "@/components/editing/SimpleQueue";
import { editorRouting } from "@/lib/settings";
import { editorForDeliverable, editorKeyForTeamName, editorMeta } from "@/lib/editors";
import { videoTier } from "@/lib/projectStatus";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { etAddDays } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// The Editor dashboard is VIDEO-ONLY — photos are edited by AI, so editors only
// touch video/reel jobs.
//   · OWNER / ADMIN → the Slack-tracker view, rebuilt in-hub (Jordan: "make
//     this editor queue as simple as possible … I really like the way we have
//     it set up in Slack"): Queue | Upcoming edits | Delivered, one row per
//     job. The old SLA-panel + tracker-spreadsheet stack is gone — per-job
//     controls (reassign, review, chat) live on /edit/<id>.
//   · EDITOR (Kim / John Mark) → the SAME queue (Jordan, Aug 27: "I want them
//     to see the same queue I do, just with the jobs assigned to them and no
//     editor section"), scoped to rows whose resolved editor is them, plus
//     their "For you" notification feed — this page IS their channel (Jordan
//     Aug 25: dashboard notifications, no Slack/SMS). The old bespoke
//     EditorDay worklist is gone.
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
  await requirePageAccess("editing");
  const me = await getCurrentUser().catch(() => null);
  const editorScope = me?.role === "EDITOR" ? (me.editorKey || (me.name ? slugForName(me.name) : null)) : null;

  // An EDITOR whose login has no editorKey AND no name can't be scoped — fail
  // closed with a nudge, never fall through to the all-jobs view below.
  if (me?.role === "EDITOR" && !editorScope) {
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

  // THE EDITOR'S VIEW — the same table, filtered to rows whose resolved editor
  // (open task → Project.editor → routing rules, exactly what the owner's
  // Editor column shows) is them. Rows are creative-safe by construction: a
  // QueueRow carries no money fields.
  if (me?.role === "EDITOR" && editorScope) {
    const mine = (rows: QueueRow[]) => rows.filter((r) => r.editorKey === editorScope);
    const myNotDone = mine(notDone);
    const myUpcoming = mine(upcomingRows);
    const myDone = mine(done);
    const overdue = myNotDone.filter((r) => r.late).length;

    // Their notification feed — raws landed, revisions, review verdicts. The
    // bell rows addressed to this editor, on the page they actually open.
    const pings = await prisma.notification.findMany({
      where: { userKey: `editor:${editorScope}`, createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, title: true, href: true, createdAt: true },
    });

    return (
      <div>
        <PageHeader
          eyebrow="Your edits"
          title={`Hi ${(me.name ?? "there").split(" ")[0]}`}
          subtitle={
            myNotDone.length
              ? `${myNotDone.length} to edit${overdue ? ` · ${overdue} overdue` : ""} · ${myUpcoming.length} upcoming`
              : "Nothing waiting — you're all caught up."
          }
          actions={<FloatingStyleGuide />}
        />
        <div className="mx-auto max-w-7xl space-y-4 p-4 pb-16 sm:p-6">
          {pings.length > 0 && (
            <Section icon={Bell} title="For you" count={pings.length}>
              <ul className="divide-y divide-border">
                {pings.map((n) => (
                  <li key={n.id}>
                    <Link href={n.href} className="flex items-center justify-between gap-3 py-2 hover:bg-surface-2/50">
                      <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
                      <span className="shrink-0 text-[11px] text-muted-2">
                        {n.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <SimpleQueue notDone={myNotDone} upcoming={myUpcoming} done={myDone} hideEditor />
        </div>
      </div>
    );
  }

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
        {/* Rows click straight through to /edit/<id> — the notes (customer +
            shoot) live there now, not in the table. */}
        <SimpleQueue notDone={notDone} upcoming={upcomingRows} done={done} />
      </div>
    </div>
  );
}
