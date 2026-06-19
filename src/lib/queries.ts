import { prisma } from "@/lib/prisma";
import { ProjectStatus } from "@prisma/client";
import { recentProjectWhere, isProjectRecent } from "@/lib/recency";

/** Projects for the pipeline board — current work only (last-30-day window). */
export async function getPipelineProjects() {
  return prisma.project.findMany({
    where: recentProjectWhere(),
    // Chronological: soonest shoot first within each column (the board re-sorts
    // the Delivered column by most-recently-delivered).
    orderBy: [
      { shootDate: { sort: "asc", nulls: "last" } },
      { deliveryDue: { sort: "asc", nulls: "last" } },
      { orderedAt: "desc" },
    ],
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
      smartTasks: {
        where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
        orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
        include: { client: { select: { name: true } } },
      },
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

// Kyle's morning brief: everything due today or overdue, pulled from the
// comms listeners (OpenPhone texts/calls, Slack, Gmail) + the next-day delivery
// SLA + day-before/after calls. This is the first thing he sees each morning.
const BRIEF_ACTIVE = [
  "OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER",
  "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED",
];

export type BriefTask = {
  id: string;
  title: string;
  taskType: string;
  priority: string;
  dueAt: string | null;
  source: string;
  projectId: string | null;
  clientName: string | null;
  propertyAddress: string | null;
  overdue: boolean;
};

type RawTask = {
  id: string; title: string; taskType: string; priority: string;
  dueAt: Date | null; source: string; projectId: string | null;
  propertyAddress: string | null; client: { name: string } | null;
};
function mapTask(t: RawTask, startToday: Date): BriefTask {
  return {
    id: t.id,
    title: t.title,
    taskType: t.taskType,
    priority: t.priority,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    source: t.source,
    projectId: t.projectId,
    clientName: t.client?.name ?? null,
    propertyAddress: t.propertyAddress,
    overdue: !!t.dueAt && t.dueAt < startToday,
  };
}

// Today's to-dos only (overdue rolls into Needs Attention instead).
export async function getMorningBrief(): Promise<BriefTask[]> {
  const now = new Date();
  const startToday = new Date(now.toDateString());
  const endToday = new Date(startToday.getTime() + 86400000 - 1);

  const tasks = await prisma.smartTask.findMany({
    where: {
      status: { in: BRIEF_ACTIVE },
      dueAt: { gte: startToday, lte: endToday },
      OR: [{ projectId: null }, { project: recentProjectWhere() }],
    },
    include: { client: { select: { name: true } } },
    orderBy: { dueAt: "asc" },
  });
  return tasks.map((t) => mapTask(t, startToday));
}

// Overdue, still-open to-dos — the things not finished on prior days.
export async function getOverdueTasks(): Promise<BriefTask[]> {
  const startToday = new Date(new Date().toDateString());
  const tasks = await prisma.smartTask.findMany({
    where: {
      status: { in: BRIEF_ACTIVE },
      dueAt: { lt: startToday },
      OR: [{ projectId: null }, { project: recentProjectWhere() }],
    },
    include: { client: { select: { name: true } } },
    orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
  });
  return tasks.map((t) => mapTask(t, startToday));
}

// Shoots happening today / tomorrow — driven off APPOINTMENTS, not the single
// project.shootDate, so an order with multiple appointments shows every shoot
// on its own day (and with the photographer assigned to that specific visit).
export async function getShootWindow() {
  const startToday = new Date(new Date().toDateString());
  const startTomorrow = new Date(startToday.getTime() + 86400000);
  const startDayAfter = new Date(startToday.getTime() + 2 * 86400000);

  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gte: startToday, lt: startDayAfter },
      status: { not: "CANCELED" },
      project: { status: { notIn: ["CANCELLED", "DELIVERED"] } },
    },
    orderBy: { startAt: "asc" },
    include: {
      project: { select: { id: true, title: true, client: { select: { name: true } } } },
      assignedTo: { select: { name: true } },
    },
  });

  const map = (a: (typeof appts)[number]) => ({
    id: a.project.id,
    apptId: a.id,
    title: a.project.title,
    shootDate: a.startAt!,
    client: a.project.client,
    photographer: a.assignedTo,
  });
  return {
    today: appts.filter((a) => a.startAt! < startTomorrow).map(map),
    tomorrow: appts.filter((a) => a.startAt! >= startTomorrow).map(map),
  };
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

  // Match the rest of the hub's "last 2 weeks + moving forward" view so the
  // dashboard counts line up with the pipeline.
  const recent = all.filter(isProjectRecent);
  const active = recent.filter(
    (p) => p.status !== ProjectStatus.DELIVERED && p.status !== ProjectStatus.CANCELLED,
  );

  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Next 7 days of shoots — from appointments, so multi-appointment orders show
  // every visit (not just the project's single primary shootDate).
  const upcomingShoots = (
    await prisma.appointment.findMany({
      where: {
        startAt: { gte: now, lte: soon },
        status: { not: "CANCELED" },
        project: { status: { notIn: ["CANCELLED", "DELIVERED"] } },
      },
      orderBy: { startAt: "asc" },
      include: { project: { select: { id: true, title: true } }, assignedTo: { select: { name: true } } },
    })
  ).map((a) => ({
    id: a.project.id,
    apptId: a.id,
    title: a.project.title,
    shootDate: a.startAt!,
    photographer: a.assignedTo,
  }));

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
