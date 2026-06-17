import { PageHeader } from "@/components/PageHeader";
import { PipelineBoard } from "@/components/PipelineBoard";
import { getPipelineProjects } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const projects = await getPipelineProjects();
  const active = projects.filter(
    (p) => p.status !== "DELIVERED" && p.status !== "CANCELLED",
  ).length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Pipeline"
        subtitle={`Every shoot from booked to delivered · ${active} active`}
        actions={
          <span className="hidden text-xs text-muted sm:block">
            Drag cards between columns to update status
          </span>
        }
      />
      <PipelineBoard projects={projects} />
    </div>
  );
}
