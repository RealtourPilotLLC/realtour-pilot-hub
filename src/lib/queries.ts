import { prisma } from "@/lib/prisma";
import { ProjectStatus } from "@prisma/client";
import { recentProjectWhere, isProjectRecent } from "@/lib/recency";
import { etDayStartUtc, etAddDays, etDayKey } from "@/lib/datetime";
import { DELEGATE_KEYS } from "@/lib/editors";

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
  // First of the month in ET. The server runs in UTC, so `new Date(y, m, 1)`
  // would bucket "this month" on the UTC month — off by a few hours near month
  // boundaries (and a whole month for the first/last hours of a month).
  const monthStart = etDayStartUtc(new Date(etDayKey(now).slice(0, 8) + "01T12:00:00Z"));

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
export const MESSAGE_TASK_TYPES = ["client_reply", "comms_followup", "revision", "lead", "internal_instruction", "vendor_update", "todo"];

// Content-pipeline tasks — QC, deliver, post-delivery text, feedback, image
// fixes. Kyle works these as the content lands, not on a formal due date, so the
// brief's "QC & deliver content" step shows them while OPEN on a recent job
// (any due date) rather than only when due today, and they don't double up in
// Needs Attention.
export const DELIVER_TASK_TYPES = ["media_qa", "delivery", "delivery_text", "feedback_review", "image_fixes", "finish_delivery"];

// Client texts — the day-before shoot confirmation and the "your content is
// ready" delivery text. Jordan wants these off the /today stack and on their own
// review tab (/texts, owner/admin only), with /today carrying a single
// "check today's client texts" rollup instead of one card per text.
export const CLIENT_TEXT_TYPES = ["confirmation_text", "delivery_text"];

// Everything the /texts tab lists — and exactly what the /today rollup counts.
// One query serves both so the rollup number can never drift from the tab.
// The filters match what the /today feed applied back when these rendered as
// individual send cards: Kyle's own/unassigned + delegated work, due by end of
// today INCLUDING overdue, on a recent (or unlinked) job.
export async function getClientTextTasks() {
  const endToday = new Date(etDayStartUtc(etAddDays(new Date(), 1)).getTime() - 1);
  return prisma.smartTask.findMany({
    where: {
      status: { in: BRIEF_ACTIVE },
      taskType: { in: CLIENT_TEXT_TYPES },
      dueAt: { lte: endToday },
      AND: [
        { OR: [{ assignedKey: null }, { assignedKey: "kyle" }, { assignedKey: { in: [...DELEGATE_KEYS] } }] },
        { OR: [{ projectId: null }, { project: recentProjectWhere() }] },
      ],
    },
    // Phone decides whether Send is even possible; the client name feeds chips.
    include: { client: { select: { name: true, phone: true } } },
    // Soonest due first — overdue confirmations naturally float to the top.
    orderBy: { dueAt: "asc" },
  });
}
export type ClientTextTask = Awaited<ReturnType<typeof getClientTextTasks>>[number];

export type BriefTask = {
  id: string;
  title: string;
  taskType: string;
  priority: string;
  dueAt: string | null;
  source: string;
  assignedKey: string | null;
  projectId: string | null;
  clientId: string | null;
  clientName: string | null;
  contactName: string | null;
  propertyAddress: string | null;
  overdue: boolean;
};

type RawTask = {
  id: string; title: string; taskType: string; priority: string;
  dueAt: Date | null; source: string; assignedKey: string | null; projectId: string | null;
  clientId: string | null; contactName: string | null;
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
    assignedKey: t.assignedKey,
    projectId: t.projectId,
    clientId: t.clientId,
    clientName: t.client?.name ?? null,
    contactName: t.contactName,
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
      // The brief is Kyle's day: his own + unassigned work (which defaults to
      // him) PLUS anything delegated to an editor/vendor (Kim/Remar/Luma/…).
      // Delegated work renders as its own "Delegated — check on these" group —
      // Kim/Remar/Luma never log in, so a task assigned to them that only lived
      // on their /queue section was effectively invisible to every human
      // (audit crack #4: an URGENT client-ETA task sat overdue addressed to a
      // vendor). Kyle stays the human checkpoint on all delegated work.
      AND: [
        { OR: [{ assignedKey: null }, { assignedKey: "kyle" }, { assignedKey: { in: [...DELEGATE_KEYS] } }] },
        { OR: [
        // Messages/replies (email, text, Slack, lead, revision): always surface
        // in "Check your messages" while open — any due date, any project age.
        // Someone wrote in and is waiting, so it shouldn't roll into Needs
        // Attention or get hidden because the project is outside the window.
        { taskType: { in: MESSAGE_TASK_TYPES } },
        // QC & deliver content: surface while OPEN on a recent job, ANY due date.
        // Content gets QC'd as it lands (a shoot's media often comes in a day or
        // two before the formal turnaround due date), so don't hide it until due.
        {
          taskType: { in: DELIVER_TASK_TYPES },
          OR: [{ projectId: null }, { project: recentProjectWhere() }],
        },
        // Everything else (confirmations, shoot prep): due today, recent project.
        {
          taskType: { notIn: [...MESSAGE_TASK_TYPES, ...DELIVER_TASK_TYPES] },
          dueAt: { gte: startToday, lte: endToday },
          OR: [{ projectId: null }, { project: recentProjectWhere() }],
        },
        ] },
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
      // Message tasks live in "Check your messages" and content tasks live in
      // "QC & deliver content" (both show there regardless of due date), so keep
      // them out of Needs Attention to avoid double-listing.
      taskType: { notIn: [...MESSAGE_TASK_TYPES, ...DELIVER_TASK_TYPES] },
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

// Tasks completed today (ET) — the dashboard's "handled" count and /today's
// footer share this so the two never disagree.
export async function getHandledToday(): Promise<number> {
  return prisma.smartTask.count({
    where: { status: "COMPLETED", completedAt: { gte: etDayStartUtc(new Date()) } },
  });
}

// The owner's money glance — three aggregates, no row fetches. (Replaced the
// old getDashboardData, which pulled every project row for stat cards nobody
// acted on.)
export async function getOwnerStats(): Promise<{
  revenueThisMonth: number;
  deliveredThisMonth: number;
  pipelineRevenue: number;
  activeCount: number;
}> {
  // Month boundary in ET (server is UTC) so deliveries don't slip months at the
  // ET-evening rollover on the 1st.
  const startOfMonth = etDayStartUtc(new Date(etDayKey(new Date()).slice(0, 8) + "01T12:00:00Z"));
  const ACTIVE = ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] as ProjectStatus[];
  const [month, pipeline] = await Promise.all([
    prisma.project.aggregate({
      where: { deliveredAt: { gte: startOfMonth }, status: { not: "CANCELLED" } },
      _sum: { price: true },
      _count: true,
    }),
    prisma.project.aggregate({
      where: { status: { in: ACTIVE } },
      _sum: { price: true },
      _count: true,
    }),
  ]);
  return {
    revenueThisMonth: month._sum.price ?? 0,
    deliveredThisMonth: month._count,
    pipelineRevenue: pipeline._sum.price ?? 0,
    activeCount: pipeline._count,
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
  lastNudgedAt: string | null; // when we last chased this payment (AR follow-up)
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

  // lastNudgedAt is a freshly-added column — read it in a separate best-effort
  // pass so /billing keeps rendering even if this code deploys before the
  // migration lands (the shared prod DB would otherwise 500 the whole page).
  const nudged = new Map<string, Date>();
  try {
    const n = await prisma.project.findMany({
      where: { id: { in: projects.map((p) => p.id) } },
      select: { id: true, lastNudgedAt: true },
    });
    for (const r of n) if (r.lastNudgedAt) nudged.set(r.id, r.lastNudgedAt);
  } catch { /* column not migrated yet — rows just show no nudge history */ }

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
    lastNudgedAt: nudged.get(p.id)?.toISOString() ?? null,
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

// ---------------------------------------------------------------------------
// Proactive flags — "what to worry about" without being asked. Surfaces the
// STRATEGIC risks the tactical Needs-Attention panel misses: aging receivables,
// VIP clients gone quiet, and stale revisions. Rule-based + fast.
// ---------------------------------------------------------------------------
export type ProactiveFlag = {
  id: string;
  severity: "high" | "medium" | "low";
  kind: "ar" | "vip-quiet" | "revision";
  title: string;
  detail: string;
  href: string;
};

// Returns the top ≤3 freshest flags (not a 12-row wall — freshness is the MVP
// mechanism, do not raise the cap back up) plus the single largest AR balance
// for the owner's money strip (computed here so /billing isn't queried twice).
export async function getProactiveFlags(): Promise<{
  flags: ProactiveFlag[];
  topAr: { name: string; total: number } | null;
}> {
  const flags: ProactiveFlag[] = [];
  let topAr: { name: string; total: number } | null = null;
  const now = Date.now();
  const daysSince = (d: Date | string | null | undefined): number | null =>
    d ? Math.floor((now - new Date(d).getTime()) / 86400000) : null;
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

  // 1) Aging accounts receivable — group delivered+unpaid jobs by client.
  try {
    const { rows } = await getBillingRows();
    const byClient = new Map<string, { name: string; total: number; oldest: number; count: number }>();
    for (const r of rows) {
      const age = daysSince(r.deliveredAt) ?? 0;
      const key = r.clientName ?? r.id;
      const cur = byClient.get(key);
      if (!cur) byClient.set(key, { name: r.clientName ?? "Unknown", total: r.outstanding, oldest: age, count: 1 });
      else { cur.total += r.outstanding; cur.oldest = Math.max(cur.oldest, age); cur.count += 1; }
    }
    const balances = [...byClient.values()];
    const biggest = balances.slice().sort((a, b) => b.total - a.total)[0];
    if (biggest) topAr = { name: biggest.name, total: biggest.total };
    // FRESH risk first (30-60d), not the same ancient zombie balance headlining
    // every day — those are already visible (and nudgeable) on /billing.
    const aged = balances.filter((c) => c.oldest >= 30).sort((a, b) => a.oldest - b.oldest).slice(0, 5);
    for (const c of aged) {
      flags.push({
        id: `ar-${c.name}`,
        severity: c.oldest >= 60 ? "high" : "medium",
        kind: "ar",
        title: `${c.name} owes ${money(c.total)}`,
        detail: `${c.count} delivered job${c.count > 1 ? "s" : ""} unpaid · oldest ${c.oldest} days`,
        href: "/billing",
      });
    }
  } catch { /* non-fatal */ }

  // 2) VIP / high-volume clients who have gone quiet (no comms in 21+ days).
  try {
    const vips = await prisma.client.findMany({
      where: { segment: { in: ["vip", "heavy"] } },
      select: { id: true, name: true, segment: true },
      take: 60,
    });
    if (vips.length) {
      const ids = vips.map((v) => v.id);
      const lastComm = await prisma.commLog.groupBy({ by: ["clientId"], where: { clientId: { in: ids } }, _max: { occurredAt: true } });
      const lastMap = new Map(lastComm.map((l) => [l.clientId, l._max.occurredAt]));
      const quiet = vips
        .map((v) => ({ v, ago: daysSince(lastMap.get(v.id) ?? null) }))
        .filter((x) => x.ago === null || x.ago >= 21)
        // Freshest quietness first — a VIP who JUST crossed 21 days is a save;
        // one silent for a year is a churn statistic.
        .sort((a, b) => (a.ago ?? 99999) - (b.ago ?? 99999))
        .slice(0, 4);
      for (const q of quiet) {
        flags.push({
          id: `vip-${q.v.id}`,
          severity: (q.ago ?? 999) >= 45 ? "high" : "medium",
          kind: "vip-quiet",
          title: `${q.v.name} has gone quiet`,
          detail: q.ago === null
            ? `${(q.v.segment ?? "vip").toUpperCase()} client · no comms on record`
            : `${(q.v.segment ?? "vip").toUpperCase()} client · no contact in ${q.ago} days`,
          href: `/clients/${q.v.id}`,
        });
      }
    }
  } catch { /* non-fatal */ }

  // 3) STALE revisions only — a revision the team is actively working is not a
  // risk (it's step 1 on /today); it becomes one after 2+ days without closure.
  // (Flagging from minute zero triple-listed every fresh revision across the
  // dashboard.)
  try {
    const revs = await prisma.project.findMany({
      where: { status: "REVISION", revisionRequestedAt: { lte: new Date(now - 2 * 86400000) } },
      select: { id: true, title: true, revisionRequestedAt: true },
      orderBy: { revisionRequestedAt: "desc" },
      take: 5,
    });
    for (const r of revs) {
      const ago = daysSince(r.revisionRequestedAt);
      flags.push({
        id: `rev-${r.id}`,
        severity: (ago ?? 0) >= 3 ? "high" : "medium",
        kind: "revision",
        title: `${r.title.split(",")[0]} is stuck in revision`,
        detail: ago != null ? `Requested ${ago} day${ago === 1 ? "" : "s"} ago` : "Revision in progress",
        href: `/projects/${r.id}`,
      });
    }
  } catch { /* non-fatal */ }

  const rank = { high: 0, medium: 1, low: 2 };
  return { flags: flags.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 3), topAr };
}
