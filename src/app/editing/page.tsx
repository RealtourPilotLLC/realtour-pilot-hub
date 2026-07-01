import { PageHeader } from "@/components/PageHeader";
import { ProjectTracker } from "@/components/tracker/ProjectTracker";
import { buildTrackerRows } from "@/lib/tracker";
import { etAddDays } from "@/lib/datetime";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { slugForName } from "@/lib/assignees";
import { editorForDeliverable } from "@/lib/editors";

export const dynamic = "force-dynamic";

// The Editor dashboard is VIDEO-ONLY — photos are edited by AI, so editors only
// touch video/reel jobs. Same tracker layout as the pipeline, scoped to the
// in-flight editing stages and showing the editor as the assignee.
export default async function EditorQueuePage() {
  // Recently-delivered jobs power the "Delivered" tab (grouped by delivery date).
  // Bounded to the last 60 days so the query stays small.
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

  // Editors see only the jobs whose video routes to them; owner/admin see all.
  const me = await getCurrentUser().catch(() => null);
  const editorScope = me?.role === "EDITOR" ? (me.editorKey || (me.name ? slugForName(me.name) : null)) : null;
  const scoped = editorScope
    ? projects.filter((p) => {
        const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL") ?? p.deliverables[0];
        return editorForDeliverable(v?.type, v?.label, !!p.client?.socialClient) === editorScope;
      })
    : projects;

  const rows = buildTrackerRows(scoped).filter((r) => r.kind === "video");
  const inProduction = rows.filter((r) => r.status !== "DELIVERED").length;
  const waiting = rows.filter((r) => r.status === "SHOT").length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Video projects only"
        title="Editor Queue"
        subtitle={`${inProduction} video job${inProduction === 1 ? "" : "s"} in production · ${waiting} ready to start`}
      />
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
