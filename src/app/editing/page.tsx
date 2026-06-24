import { PageHeader } from "@/components/PageHeader";
import { ProjectTracker } from "@/components/tracker/ProjectTracker";
import { buildTrackerRows } from "@/lib/tracker";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// The Editor dashboard is VIDEO-ONLY — photos are edited by AI, so editors only
// touch video/reel jobs. Same tracker layout as the pipeline, scoped to the
// in-flight editing stages and showing the editor as the assignee.
export default async function EditorQueuePage() {
  const projects = await prisma.project.findMany({
    where: { status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } },
    orderBy: [{ deliveryDue: { sort: "asc", nulls: "last" } }, { shootDate: { sort: "asc", nulls: "last" } }],
    include: { client: true, photographer: true, editor: true, deliverables: true },
  });

  const rows = buildTrackerRows(projects).filter((r) => r.kind === "video");
  const waiting = rows.filter((r) => r.status === "SHOT").length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Video projects only"
        title="Editor Queue"
        subtitle={`${rows.length} video job${rows.length === 1 ? "" : "s"} in production · ${waiting} ready to start`}
      />
      <ProjectTracker
        rows={rows}
        showBoards={false}
        defaultStatus="editing"
        assignee="editor"
        emptyLabel="No video jobs in production right now."
      />
    </div>
  );
}
