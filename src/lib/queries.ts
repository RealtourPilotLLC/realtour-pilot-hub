import { prisma } from "@/lib/prisma";
import { ProjectStatus } from "@prisma/client";
import { recentProjectWhere, isProjectRecent } from "@/lib/recency";
import { etDayStartUtc, etAddDays, etDayKey } from "@/lib/datetime";

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
      messages: {
        orderBy: { createdAt: "asc" },
        include: { replyTo: { select: { authorName: true, body: true } } },
      },
    },
  });
}

export type FullProject = NonNullable<Awaited<ReturnType<typeof getProject>>>;

export async function getTeam() {
  return prisma.teamMember.findMany({ orderBy: { name: "asc" } });
}

export type ConvoMember = {
  phone: string;
  key: string;
  name: string;
  clientId: string | null;
  segment: string | null;
  socialClient: boolean;
  socialPlan: string | null;
};

// Resolve a set of phone numbers (group participants) to names/clients, for the
// group-chat header, sender labels, and the members sidebar.
export async function resolveParticipants(phones: string[]): Promise<ConvoMember[]> {
  const keys = phones.map((p) => (p || "").replace(/\D/g, "").slice(-10)).filter((k) => k.length === 10);
  if (keys.length === 0) return [];
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true, phone: true, segment: true, socialClient: true, socialPlan: true } }),
    prisma.contact.findMany({ where: { phones: { not: null } }, select: { firstName: true, lastName: true, company: true, phones: true } }),
  ]);
  const byClient = new Map<string, (typeof clients)[number]>();
  for (const c of clients) { const k = (c.phone ?? "").replace(/\D/g, "").slice(-10); if (k.length === 10) byClient.set(k, c); }
  const byContact = new Map<string, string>();
  for (const ct of contacts) {
    const name = [ct.firstName, ct.lastName].filter(Boolean).join(" ").trim() || ct.company;
    if (!name) continue;
    let nums: string[] = [];
    try { nums = ct.phones ? JSON.parse(ct.phones) : []; } catch { nums = []; }
    for (const n of nums) { const k = n.replace(/\D/g, "").slice(-10); if (k.length === 10 && !byContact.has(k)) byContact.set(k, name); }
  }
  return phones
    .map((phone) => {
      const key = phone.replace(/\D/g, "").slice(-10);
      if (key.length !== 10) return null;
      const c = byClient.get(key);
      const fmt = `(${key.slice(0, 3)}) ${key.slice(3, 6)}-${key.slice(6)}`;
      return {
        phone, key,
        name: c?.name ?? byContact.get(key) ?? fmt,
        clientId: c?.id ?? null,
        segment: c?.segment ?? null,
        socialClient: c?.socialClient ?? false,
        socialPlan: c?.socialPlan ?? null,
      } as ConvoMember;
    })
    .filter((m): m is ConvoMember => m !== null);
}

// Resolve a phone number (from a conversation) to a client + their recent
// projects and activity, for the Communications sidebar.
export async function getConversationContext(rawPhone: string) {
  const k = (rawPhone || "").replace(/\D/g, "").slice(-10);
  if (k.length !== 10) return { client: null, projects: [], activities: [] };

  const clients = await prisma.client.findMany({
    select: {
      id: true, name: true, phone: true, email: true, backupEmail: true,
      company: true, segment: true, socialClient: true, socialPlan: true,
    },
  });
  let client = clients.find((c) => c.phone && c.phone.replace(/\D/g, "").slice(-10) === k) ?? null;
  if (!client) {
    const contacts = await prisma.contact.findMany({
      where: { clientId: { not: null } },
      select: { phones: true, clientId: true },
    });
    const hit = contacts.find((ct) => {
      try { return (JSON.parse(ct.phones || "[]") as string[]).some((ph) => ph.replace(/\D/g, "").slice(-10) === k); }
      catch { return false; }
    });
    if (hit?.clientId) client = clients.find((c) => c.id === hit.clientId) ?? null;
  }
  if (!client) return { client: null, projects: [], activities: [] };

  const [projects, activities] = await Promise.all([
    prisma.project.findMany({
      where: { clientId: client.id },
      orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 6,
      select: { id: true, title: true, status: true, shootDate: true, price: true },
    }),
    prisma.activity.findMany({
      where: { project: { clientId: client.id } },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { id: true, body: true, createdAt: true, type: true, project: { select: { title: true } } },
    }),
  ]);
  return { client, projects, activities };
}

// ---------------------------------------------------------------------------
// Team member detail — one person's page: schedule (upcoming shoots), KPIs
// (shoots, edits, feedback rating), and a recent upload-activity feed.
// ---------------------------------------------------------------------------
export async function getTeamMemberDetail(id: string) {
  const member = await prisma.teamMember.findUnique({ where: { id } });
  if (!member) return null;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [upcoming, recentShoots, editingNow, feedback, uploads, shotCount, editCount] =
    await Promise.all([
      // Upcoming assigned shoots (next 30 days)
      prisma.appointment.findMany({
        where: {
          assignedToId: id,
          startAt: { gte: etDayStartUtc(now) },
          status: { not: "CANCELED" },
          project: { status: { notIn: ["CANCELLED", "DELIVERED"] } },
        },
        orderBy: { startAt: "asc" },
        take: 12,
        include: { project: { select: { id: true, title: true, client: { select: { name: true } } } } },
      }),
      // Recently shot (as photographer)
      prisma.project.findMany({
        where: { photographerId: id },
        orderBy: { shootDate: { sort: "desc", nulls: "last" } },
        take: 6,
        select: { id: true, title: true, status: true, shootDate: true, client: { select: { name: true } } },
      }),
      // Currently editing (as editor)
      prisma.project.findMany({
        where: { editorId: id, status: { in: ["SHOT", "EDITING", "REVIEW"] } },
        orderBy: { deliveryDue: { sort: "asc", nulls: "last" } },
        take: 8,
        select: { id: true, title: true, status: true, deliveryDue: true, client: { select: { name: true } } },
      }),
      // Feedback on their shoots (creative scorecard)
      prisma.feedback.findMany({
        where: { photographerId: id },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      // Recent uploads by them
      prisma.uploadedFile.findMany({
        where: { uploadedById: id },
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { project: { select: { id: true, title: true } } },
      }),
      prisma.project.count({ where: { photographerId: id, shootDate: { gte: monthStart } } }),
      prisma.project.count({ where: { editorId: id, deliveredAt: { gte: monthStart } } }),
    ]);

  const rated = feedback.filter((f) => f.rating != null);
  const avgRating = rated.length ? rated.reduce((s, f) => s + (f.rating ?? 0), 0) / rated.length : null;

  return {
    member,
    upcoming,
    recentShoots,
    editingNow,
    feedback,
    uploads,
    kpis: {
      shootsThisMonth: shotCount,
      editsThisMonth: editCount,
      avgRating,
      ratingCount: rated.length,
    },
  };
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

// Message/communication tasks — things someone wrote in and is waiting on a
// reply for. These belong in the brief's "Check your messages" step and should
// stay there until handled (NOT roll off when they're no longer due "today",
// and NOT get buried in Needs Attention). Email/text/Slack/lead all land here.
const MESSAGE_TASK_TYPES = ["client_reply", "revision", "lead", "internal_instruction", "vendor_update"];

export type BriefTask = {
  id: string;
  title: string;
  taskType: string;
  priority: string;
  dueAt: string | null;
  source: string;
  projectId: string | null;
  clientId: string | null;
  clientName: string | null;
  propertyAddress: string | null;
  overdue: boolean;
};

type RawTask = {
  id: string; title: string; taskType: string; priority: string;
  dueAt: Date | null; source: string; projectId: string | null;
  clientId: string | null;
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
    clientId: t.clientId,
    clientName: t.client?.name ?? null,
    propertyAddress: t.propertyAddress,
    overdue: !!t.dueAt && t.dueAt < startToday,
  };
}

// Today's to-dos only (overdue rolls into Needs Attention instead).
export async function getMorningBrief(): Promise<BriefTask[]> {
  const startToday = etDayStartUtc(new Date());
  const endToday = new Date(etDayStartUtc(etAddDays(new Date(), 1)).getTime() - 1);

  const tasks = await prisma.smartTask.findMany({
    where: {
      status: { in: BRIEF_ACTIVE },
      OR: [
        // Messages/replies (email, text, Slack, lead, revision): always surface
        // in "Check your messages" while open — any due date, any project age.
        // Someone wrote in and is waiting, so it shouldn't roll into Needs
        // Attention or get hidden because the project is outside the window.
        { taskType: { in: MESSAGE_TASK_TYPES } },
        // Everything else (deliveries, shoots, QC): due today, recent project.
        {
          taskType: { notIn: MESSAGE_TASK_TYPES },
          dueAt: { gte: startToday, lte: endToday },
          OR: [{ projectId: null }, { project: recentProjectWhere() }],
        },
      ],
    },
    include: { client: { select: { name: true } } },
    orderBy: { dueAt: "asc" },
  });
  return tasks.map((t) => mapTask(t, startToday));
}

// Overdue, still-open to-dos — the things not finished on prior days.
export async function getOverdueTasks(): Promise<BriefTask[]> {
  const startToday = etDayStartUtc(new Date());
  const tasks = await prisma.smartTask.findMany({
    where: {
      status: { in: BRIEF_ACTIVE },
      dueAt: { lt: startToday },
      // Message/reply tasks live in "Check your messages" (they show there
      // regardless of due date), so keep them out of Needs Attention.
      taskType: { notIn: MESSAGE_TASK_TYPES },
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
  // Day boundaries in EASTERN time (the business runs on ET) so a late-evening
  // shoot doesn't roll into "tomorrow" under UTC.
  const startToday = etDayStartUtc(new Date());
  const startTomorrow = etDayStartUtc(etAddDays(new Date(), 1));
  const startDayAfter = etDayStartUtc(etAddDays(new Date(), 2));

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

  const recentActivity = await prisma.activity.findMany({
    take: 8,
    orderBy: { createdAt: "desc" },
    include: { author: true, project: true },
  });

  // Revenue in pipeline (active orders) and delivered this month.
  const pipelineRevenue = active.reduce((sum, p) => sum + (p.price ?? 0), 0);
  // Month boundary in ET (server is UTC) so deliveries don't slip months at the
  // ET-evening rollover on the 1st.
  const startOfMonth = etDayStartUtc(new Date(etDayKey(now).slice(0, 8) + "01T12:00:00Z"));
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
    recentActivity,
  };
}

// ---------------------------------------------------------------------------
// Customer detail — the CRM page. Everything about one client in one place:
// contact info, notes, every order (most-recent first), open to-dos, and a
// merged activity timeline (status changes, comms, feedback).
// ---------------------------------------------------------------------------
const RECENT_PROJECT_ORDER = [
  { orderedAt: { sort: "desc" as const, nulls: "last" as const } },
  { shootDate: { sort: "desc" as const, nulls: "last" as const } },
  { createdAt: "desc" as const },
];

export async function getClientDetail(id: string) {
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      projects: {
        orderBy: RECENT_PROJECT_ORDER,
        include: {
          deliverables: { select: { id: true, type: true, label: true, status: true } },
          photographer: { select: { name: true, avatarColor: true } },
          _count: { select: { uploads: true } },
        },
      },
      contacts: true,
      parent: { select: { id: true, name: true } },
      teamMembers: { select: { id: true, name: true } },
      smartTasks: {
        where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
        orderBy: { dueAt: "asc" },
      },
    },
  });
  if (!client) return null;

  const projectIds = client.projects.map((p) => p.id);
  const titleById = new Map(client.projects.map((p) => [p.id, p.title]));
  const [activities, feedback] = await Promise.all([
    prisma.activity.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    prisma.feedback.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Merge into one reverse-chron timeline.
  type TimelineItem = {
    id: string;
    at: Date;
    kind: "activity" | "feedback";
    body: string;
    projectId: string | null;
    projectTitle: string | null;
    activityType?: string;
    rating?: number | null;
    sentiment?: string | null;
  };
  const timeline: TimelineItem[] = [
    ...activities.map((a) => ({
      id: a.id,
      at: a.createdAt,
      kind: "activity" as const,
      body: a.body,
      projectId: a.projectId,
      projectTitle: titleById.get(a.projectId) ?? null,
      activityType: a.type,
    })),
    ...feedback.map((f) => ({
      id: f.id,
      at: f.createdAt,
      kind: "feedback" as const,
      body: f.body,
      projectId: f.projectId,
      projectTitle: titleById.get(f.projectId) ?? null,
      rating: f.rating,
      sentiment: f.sentiment,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  // Lifetime spend excludes cancelled orders, to match the segment chip's math.
  const totalSpend = client.projects
    .filter((p) => p.status !== "CANCELLED")
    .reduce((sum, p) => sum + (p.price ?? 0), 0);

  return { client, timeline, totalSpend };
}

// ---------------------------------------------------------------------------
// Task history + daily recap — what got done, by day.
// ---------------------------------------------------------------------------
export type HistoryTask = {
  id: string;
  title: string;
  taskType: string;
  completedAt: string;
  clientName: string | null;
  propertyAddress: string | null;
  projectId: string | null;
};
export type HistoryDelivery = {
  id: string;
  title: string;
  deliveredAt: string;
  clientName: string | null;
};

// Completed tasks over the last N days (newest first), for the history page.
export async function getTaskHistory(days = 45): Promise<HistoryTask[]> {
  const since = etDayStartUtc(etAddDays(new Date(), -days));
  const tasks = await prisma.smartTask.findMany({
    where: { status: "COMPLETED", completedAt: { gte: since } },
    orderBy: { completedAt: "desc" },
    select: {
      id: true, title: true, taskType: true, completedAt: true,
      propertyAddress: true, projectId: true, client: { select: { name: true } },
    },
  });
  return tasks
    .filter((t) => t.completedAt)
    .map((t) => ({
      id: t.id,
      title: t.title,
      taskType: t.taskType,
      completedAt: t.completedAt!.toISOString(),
      clientName: t.client?.name ?? null,
      propertyAddress: t.propertyAddress,
      projectId: t.projectId,
    }));
}

export type HistoryShoot = {
  id: string; // appointment id
  projectId: string;
  title: string;
  at: string;
  time: string;
  clientName: string | null;
  photographer: string | null;
};

// Shoots (appointments) that occurred over the last N days, for the daily recap.
export async function getShootHistory(days = 45): Promise<HistoryShoot[]> {
  const since = etDayStartUtc(etAddDays(new Date(), -days));
  const appts = await prisma.appointment.findMany({
    where: { startAt: { gte: since, lte: new Date() }, status: { not: "CANCELED" } },
    orderBy: { startAt: "desc" },
    select: {
      id: true, startAt: true,
      project: { select: { id: true, title: true, client: { select: { name: true } } } },
      assignedTo: { select: { name: true } },
    },
  });
  return appts
    .filter((a) => a.startAt && a.project)
    .map((a) => ({
      id: a.id,
      projectId: a.project!.id,
      title: a.project!.title,
      at: a.startAt!.toISOString(),
      time: a.startAt!.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }),
      clientName: a.project!.client?.name ?? null,
      photographer: a.assignedTo?.name ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Billing — delivered Aryeo jobs that still owe money (accounts receivable).
// ---------------------------------------------------------------------------
export type BillingRow = {
  id: string;
  title: string;
  clientName: string | null;
  orderedAt: string | null;
  deliveredAt: string | null;
  invoiceTotal: number | null; // dollars
  outstanding: number; // dollars
  paymentStatus: string | null;
  invoiceUrl: string | null;
  paymentUrl: string | null;
  aryeoOrderId: string | null;
  aryeoListingId: string | null;
  deliverables: string[]; // distinct labels of what was delivered
  openTasks: number;
};

export async function getBillingRows(): Promise<{ rows: BillingRow[]; totalOutstanding: number }> {
  const projects = await prisma.project.findMany({
    where: { AND: [{ OR: [{ status: "DELIVERED" }, { deliveredAt: { not: null } }] }, { balanceAmount: { gt: 0 } }] },
    orderBy: [{ deliveredAt: { sort: "desc", nulls: "last" } }, { orderedAt: "desc" }],
    select: {
      id: true, title: true, orderedAt: true, deliveredAt: true,
      price: true, balanceAmount: true, paymentStatus: true, invoiceUrl: true, paymentUrl: true,
      aryeoOrderId: true, aryeoListingId: true,
      client: { select: { name: true } },
      deliverables: { select: { label: true, type: true } },
      smartTasks: { where: { status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true } },
    },
  });

  const rows: BillingRow[] = projects.map((p) => ({
    id: p.id,
    title: p.title,
    clientName: p.client?.name ?? null,
    orderedAt: p.orderedAt ? p.orderedAt.toISOString() : null,
    deliveredAt: p.deliveredAt ? p.deliveredAt.toISOString() : null,
    invoiceTotal: p.price ?? null,
    outstanding: (p.balanceAmount ?? 0) / 100, // balanceAmount is cents
    paymentStatus: p.paymentStatus ?? null,
    invoiceUrl: p.invoiceUrl ?? null,
    paymentUrl: p.paymentUrl ?? null,
    aryeoOrderId: p.aryeoOrderId ?? null,
    aryeoListingId: p.aryeoListingId ?? null,
    deliverables: [...new Set(p.deliverables.map((d) => d.label || d.type).filter(Boolean))] as string[],
    openTasks: p.smartTasks.length,
  }));
  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);
  return { rows, totalOutstanding };
}

// Projects delivered over the last N days, to round out the daily recap.
export async function getDeliveryHistory(days = 45): Promise<HistoryDelivery[]> {
  const since = etDayStartUtc(etAddDays(new Date(), -days));
  const projects = await prisma.project.findMany({
    where: { deliveredAt: { gte: since } },
    orderBy: { deliveredAt: "desc" },
    select: { id: true, title: true, deliveredAt: true, client: { select: { name: true } } },
  });
  return projects
    .filter((p) => p.deliveredAt)
    .map((p) => ({ id: p.id, title: p.title, deliveredAt: p.deliveredAt!.toISOString(), clientName: p.client?.name ?? null }));
}
