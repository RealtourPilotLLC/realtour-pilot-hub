import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";
import { SecondShootControl } from "@/components/jobs/SecondShootControl";

// ---------------------------------------------------------------------------
// The office's "Waiting on a second shoot" card (Oct 22 2026, lib/secondShoot),
// on the job page and the editor's brief. Jordan, Kyle and James only (the
// role a "view as" preview shows decides, so a preview never sees buttons it
// could not press). Nothing on a cancelled job, a job with no video, or once
// every video is finished and none waits.
// ---------------------------------------------------------------------------

const OFFICE = new Set(["OWNER", "ADMIN", "CREATIVE_MANAGER"]);

export async function SecondShootCard({ projectId }: { projectId: string }) {
  const viewer = await getCurrentUser().catch(() => null);
  if (viewer && !OFFICE.has(viewer.role)) return null;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true } }).catch(() => null);
  if (!project || project.status === "CANCELLED") return null;
  const rows = await import("@/lib/secondShoot").then((m) => m.secondShootViewRows(projectId)).catch(() => []);
  if (!rows.some((r) => r.waiting || !r.finished)) return null;
  return <SecondShootControl projectId={projectId} rows={rows} />;
}
