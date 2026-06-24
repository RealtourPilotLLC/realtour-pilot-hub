import { PageHeader } from "@/components/PageHeader";
import { ProjectTracker } from "@/components/tracker/ProjectTracker";
import { getPipelineProjects } from "@/lib/queries";
import { buildTrackerRows } from "@/lib/tracker";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const projects = await getPipelineProjects();
  const rows = buildTrackerRows(projects);
  const active = rows.filter((r) => r.status !== "DELIVERED" && r.status !== "CANCELLED").length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Last 2 weeks"
        title="Project Tracker"
        subtitle={`${active} active · sort by shoot or due date, set status inline`}
      />
      <ProjectTracker rows={rows} showBoards assignee="photographer" emptyLabel="No projects in the last two weeks." />
    </div>
  );
}
