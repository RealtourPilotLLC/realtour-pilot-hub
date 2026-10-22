import { Clapperboard } from "lucide-react";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// MORE VIDEOS ORDERED THAN SET UP (Oct 22 2026). Jordan: "Joe's appointment
// yesterday had two videos ... make sure that doesn't happen again." When the
// order (or the office's videos-owed number) says more videos than this job
// has set up, the job page says so at the top, names what the order sells,
// and says how to fix it, instead of quietly showing one video. Gone the
// moment the two agree, and never on a delivered or cancelled job.
// ---------------------------------------------------------------------------

const DONE = new Set(["DELIVERED", "CANCELLED"]);

export async function VideoSetupNotice({ projectId }: { projectId: string }) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true, aryeoOrderId: true } }).catch(() => null);
  if (!project || DONE.has(project.status)) return null;
  const gap = await import("@/lib/videoSetup").then((m) => m.videoSetupGapFor(projectId)).catch(() => null);
  if (!gap) return null;
  const missing = gap.ordered - gap.setUp;
  return (
    <section data-video-setup-notice aria-labelledby={`video-setup-${projectId}`} className="rounded-2xl border border-danger/30 bg-danger-soft/40 p-4">
      <h2 id={`video-setup-${projectId}`} className="flex items-center gap-2 text-sm font-semibold">
        <Clapperboard aria-hidden className="size-4 text-danger" /> {gap.words}
      </h2>
      <p className="mt-1 text-sm text-foreground/80">
        {gap.products.length > 0 ? <>The order sells {gap.products.join(" and ")}. </> : null}
        {missing === 1 ? "One video has" : `${missing} videos have`} no editor slot, due date or instructions box yet.
        {project.aryeoOrderId ? " Press Refresh from Aryeo above to set it up from the order, or ask the office." : " Ask the office to set it up."}
      </p>
    </section>
  );
}
