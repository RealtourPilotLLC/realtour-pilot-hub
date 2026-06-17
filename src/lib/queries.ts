import { prisma } from "@/lib/prisma";
import { ProjectStatus } from "@prisma/client";

/** Projects for the pipeline board — light relations + counts. */
export async function getPipelineProjects() {
  return prisma.project.findMany({
    orderBy: [{ priority: "desc" }, { deliveryDue: "asc" }, { createdAt: "desc" }],
    include: {
      client: true,
      photographer: true,
      editor: true,
      va: true,
      deliverables: true,
      checklist: true,
      _count: { select: { activities: true } },
    },
  });
}

export type PipelineProject = Awaited<ReturnType<typeof getPipelineProjects>>[number];

/** A single project with everything for the detail view. */
export async function getProject(id: string) {
  return prisma.project.findUnique({
    where: { id },
    include: {
      client: true,
      photographer: true,
      editor: true,
      va: true,
      deliverables: { orderBy: { createdAt: "asc" } },
      checklist: { orderBy: { sortOrder: "asc" }, include: { assignee: true } },
      activities: { orderBy: { createdAt: "desc" }, include: { author: true } },
      uploads: { orderBy: { createdAt: "asc" }, include: { deliverable: true } },
      appointments: { orderBy: { startAt: "asc" }, include: { assignedTo: true } },
    },
  });
}

export type FullProject = NonNullable<Awaited<ReturnType<typeof getProject>>>;

export async function getTeam() {
  return prisma.teamMember.findMany({ orderBy: { name: "asc" } });
}

export async function getClients() {
  return prisma.client.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { projects: true } } },
  });
}

/** Aggregated data for the dashboard home. */
export async function getDashboardData() {
  const all = await prisma.project.findMany({
    include: {
      client: true,
      photographer: true,
      editor: true,
      checklist: true,
    },
  });

  const active = all.filter(
    (p) => p.status !== ProjectStatus.DELIVERED && p.status !== ProjectStatus.CANCELLED,
  );

  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const upcomingShoots = all
    .filter((p) => p.shootDate && p.shootDate >= now && p.shootDate <= soon)
    .sort((a, b) => (a.shootDate!.getTime() - b.shootDate!.getTime()));

  // "Needs attention": overdue, urgent, on-hold, or due today.
  const startOfTomorrow = new Date(now);
  startOfTomorrow.setHours(23, 59, 59, 999);
  const needsAttention = active
    .map((p) => {
      const reasons: string[] = [];
      if (p.deliveryDue && p.deliveryDue < now) reasons.push("Delivery overdue");
      else if (p.deliveryDue && p.deliveryDue <= startOfTomorrow) reasons.push("Due today");
      if (p.priority === "URGENT") reasons.push("Urgent");
      if (p.status === ProjectStatus.ON_HOLD) reasons.push("On hold");
      return { project: p, reasons };
    })
    .filter((x) => x.reasons.length > 0)
    .sort((a, b) => b.reasons.length - a.reasons.length);

  const recentActivity = await prisma.activity.findMany({
    take: 8,
    orderBy: { createdAt: "desc" },
    include: { author: true, project: true },
  });

  // Revenue in pipeline (active orders) and delivered this month.
  const pipelineRevenue = active.reduce((sum, p) => sum + (p.price ?? 0), 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const deliveredThisMonth = all.filter(
    (p) => p.deliveredAt && p.deliveredAt >= startOfMonth,
  );
  const revenueThisMonth = deliveredThisMonth.reduce((s, p) => s + (p.price ?? 0), 0);

  return {
    counts: {
      active: active.length,
      booked: all.filter((p) => p.status === ProjectStatus.BOOKED).length,
      editing: all.filter((p) => p.status === ProjectStatus.EDITING).length,
      review: all.filter((p) => p.status === ProjectStatus.REVIEW).length,
      deliveredThisMonth: deliveredThisMonth.length,
    },
    pipelineRevenue,
    revenueThisMonth,
    upcomingShoots,
    needsAttention,
    recentActivity,
  };
}
