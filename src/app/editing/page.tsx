import { PageHeader } from "@/components/PageHeader";
import { ProjectTracker } from "@/components/tracker/ProjectTracker";
import { buildTrackerRows } from "@/lib/tracker";
import { etAddDays } from "@/lib/datetime";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { slugForName } from "@/lib/assignees";
import { EditorDay } from "@/components/editing/EditorDay";
import { VideoSlaPanel } from "@/components/editing/VideoSlaPanel";

export const dynamic = "force-dynamic";

// The Editor dashboard is VIDEO-ONLY — photos are edited by AI, so editors only
// touch video/reel jobs.
//   · EDITOR (Kim / Remar) → a guided personal worklist (EditorDay): their open
//     edits + revisions sorted by SLA, plus the week's incoming shoots.
//   · OWNER / ADMIN → the accountability view: a live Video-SLA panel (past-due
//     jobs surfaced, one-click reassign) ABOVE the preserved tracker spreadsheet.
export default async function EditorQueuePage() {
  const me = await getCurrentUser().catch(() => null);
  const editorScope = me?.role === "EDITOR" ? (me.editorKey || (me.name ? slugForName(me.name) : null)) : null;

  // EDITOR: their own guided day, DB-scoped to their assignedKey.
  if (me?.role === "EDITOR" && editorScope) {
    return <EditorDay editorScope={editorScope} editorName={me.name ?? "there"} />;
  }

  // OWNER / ADMIN: recently-delivered jobs power the "Delivered" tab (bounded to
  // 60 days so the query stays small).
  const deliveredCutoff = etAddDays(new Date(), -60);
  const projects = await prisma.project.findMany({
    where: {
      OR: [
        { status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } },
        { status: "DELIVERED", deliveredAt: { gte: deliveredCutoff } },
      ],
    },
    orderBy: [{ deliveryDue: { sort: "asc", nulls: "last" } }, { shootDate: { sort: "asc", nulls: "last" } }],
    include: { client: true, photographer: true, editor: true, deliverables: true },
  });

  const rows = buildTrackerRows(projects).filter((r) => r.kind === "video");
  const inProduction = rows.filter((r) => r.status !== "DELIVERED").length;
  const waiting = rows.filter((r) => r.status === "SHOT").length;

  // SLA panel: only the in-flight (non-delivered) video jobs — a live countdown
  // + reassign per row, past-due surfaced red.
  const inflightVideo = projects.filter(
    (p) => p.status !== "DELIVERED" && p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL"),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Video projects only"
        title="Editor Queue"
        subtitle={`${inProduction} video job${inProduction === 1 ? "" : "s"} in production · ${waiting} ready to start`}
      />
      {inflightVideo.length > 0 && (
        <div className="px-4 pt-4 sm:px-6">
          <VideoSlaPanel projects={inflightVideo} />
        </div>
      )}
      <ProjectTracker
        rows={rows}
        showBoards={false}
        defaultStatus="editing"
        assignee="editor"
        hrefBase="/edit"
        emptyLabel="No video jobs in production right now."
      />
    </div>
  );
}
