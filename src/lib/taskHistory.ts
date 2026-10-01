import { prisma } from "@/lib/prisma";
import { etDayStartUtc } from "@/lib/datetime";
import { isDismissedSummary, dismissedReason, dismissedBy } from "@/lib/triage";
import { taskClientScopeWhere, type TaskClientScope } from "@/lib/taskClientScope";

/** The Done tab and Other badge use the same scope and completion rule. */
export async function doneTodayCount(opts: TaskClientScope = {}): Promise<number> {
  return prisma.smartTask.count({
    where: { status: "COMPLETED", completedAt: { gte: etDayStartUtc(new Date()) }, AND: [taskClientScopeWhere(opts)] },
  });
}

export type ClosedRow = {
  id: string;
  title: string;
  taskType: string;
  summary: string | null;
  at: Date;
  projectId: string | null;
  byHand: boolean;
  reason: string | null;
  who: string | null;
};

/** Dismissed/auto-closed work is historical context, never completed output. */
export async function closedWithoutDoing(days: number, opts: TaskClientScope = {}): Promise<ClosedRow[]> {
  const rows = await prisma.smartTask.findMany({
    where: { status: "CANCELLED", updatedAt: { gte: new Date(Date.now() - days * 86_400_000) }, AND: [taskClientScopeWhere(opts)] },
    // Cancelled rows have no completedAt: this dates the closure itself.
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: { id: true, title: true, taskType: true, summary: true, updatedAt: true, projectId: true },
  });
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    taskType: t.taskType,
    summary: t.summary,
    at: t.updatedAt,
    projectId: t.projectId,
    byHand: isDismissedSummary(t.summary),
    reason: dismissedReason(t.summary),
    who: dismissedBy(t.summary),
  }));
}
