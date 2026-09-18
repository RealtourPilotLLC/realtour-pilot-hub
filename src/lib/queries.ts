import { prisma } from "@/lib/prisma";
import { ProjectStatus, type Prisma } from "@prisma/client";
import { recentProjectWhere, isProjectRecent } from "@/lib/recency";
import { clientTextWhere, CLIENT_TEXT_TYPES } from "@/lib/clientTexts";
import { etDayStartUtc, etAddDays, etDayKey } from "@/lib/datetime";

import { TRIAGE_TYPES } from "@/lib/triage";
import { getVideoSlaStatus } from "@/lib/projectStatus";
import type { QcMissBucket } from "@/lib/qc";
import { parseChecklist } from "@/lib/checklist";
import { countQcMisses } from "@/lib/tasks";
import { DEBRIEF_QC_LABELS } from "@/lib/debrief";
import { pinnedPromise } from "@/lib/turnaround";

// Re-export the QC types so the dashboard can consume them without reaching
// past this module — queries.ts is the dashboard's single data door.
export type { QcStats, QcMissBucket } from "@/lib/qc";

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
        // avatarUrl rides along with the name here and on every nested client
        // select in this file that NAMES the client — see BriefTask.clientAvatarUrl.
        include: { client: { select: { name: true, avatarUrl: true } } },
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
  avatarUrl: string | null; // the agent's Aryeo headshot — null when Aryeo has none
};

// Resolve a set of phone numbers (group participants) to names/clients, for the
// group-chat header, sender labels, and the members sidebar.
export async function resolveParticipants(phones: string[]): Promise<ConvoMember[]> {
  const keys = phones.map((p) => (p || "").replace(/\D/g, "").slice(-10)).filter((k) => k.length === 10);
  if (keys.length === 0) return [];
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true, phone: true, segment: true, socialClient: true, socialPlan: true, avatarUrl: true } }),
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
        avatarUrl: c?.avatarUrl ?? null,
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
      avatarUrl: true, // headshot for the conversation header (ConversationView)
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
        include: { project: { select: { id: true, title: true, client: { select: { name: true, avatarUrl: true } } } } },
      }),
      // Recently shot (as photographer)
      prisma.project.findMany({
        where: { photographerId: id },
        orderBy: { shootDate: { sort: "desc", nulls: "last" } },
        take: 6,
        select: { id: true, title: true, status: true, shootDate: true, client: { select: { name: true, avatarUrl: true } } },
      }),
      // Currently editing (as editor)
      prisma.project.findMany({
        where: { editorId: id, status: { in: ["SHOT", "EDITING", "REVIEW"] } },
        orderBy: { deliveryDue: { sort: "asc", nulls: "last" } },
        take: 8,
        select: { id: true, title: true, status: true, deliveryDue: true, client: { select: { name: true, avatarUrl: true } } },
      }),
      // Feedback on their shoots (creative scorecard). Rows an owner dismissed
      // as "not feedback" on /quality never reach a scorecard (Sep 16).
      prisma.feedback.findMany({
        where: { photographerId: id, dismissedAt: null },
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
// A CLIENT (or vendor/teammate on a live job) wrote in and is waiting. These
// surface until handled regardless of due date. internal_instruction / todo /
// vendor_update were REMOVED (audit Aug 25): padding this list made the
// "message to-dos" chip read 69 when only 3 were real client replies, and made
// the Today stack an unbounded 77-card wall. Instructions now surface via the
// triage pile + their due dates, like every other to-do.
export const MESSAGE_TASK_TYPES = ["client_reply", "comms_followup", "revision", "lead"];
// The ops pile: instructions and system to-dos — routed by assignment + due
// date, rolled up in Today's triage card, never counted as "messages".
export const OPS_PILE_TYPES = ["internal_instruction", "vendor_update", "todo"];

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
// The type list now lives with the canonical filter in @/lib/clientTexts;
// re-exported here so existing consumers (TodayView etc.) keep importing it.
export { CLIENT_TEXT_TYPES };

// Everything the /texts tab lists — and exactly what the /today rollup counts.
// Membership comes from the ONE shared rule (clientTextWhere) that the badge
// and the send-all batch also use, so no surface can drift from another.
export async function getClientTextTasks() {
  return prisma.smartTask.findMany({
    where: clientTextWhere(),
    // Phone decides whether Send is even possible; the client name feeds chips.
    include: { client: { select: { name: true, phone: true, avatarUrl: true } } },
    // Soonest due first; no-date confirmations (a shoot date still to chase)
    // surface on top rather than sinking below every dated row.
    orderBy: { dueAt: { sort: "asc", nulls: "first" } },
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
  // Jordan, Sep 2 2026: "if the agent has a profile photo in aryeo that should
  // be shown … in other places the clients are mentioned." So every row this
  // file returns with a clientName carries the headshot next to it
  // (Client.avatarUrl, mirrored nightly from Aryeo's customer avatar). null
  // means Aryeo has no photo — <Avatar src={…}> then draws the initials disc it
  // always did, so a surface can pass it straight through with no conditional.
  clientAvatarUrl: string | null;
  contactName: string | null;
  propertyAddress: string | null;
  overdue: boolean;
};

type RawTask = {
  id: string; title: string; taskType: string; priority: string;
  dueAt: Date | null; source: string; assignedKey: string | null; projectId: string | null;
  clientId: string | null; contactName: string | null;
  propertyAddress: string | null; client: { name: string; avatarUrl: string | null } | null;
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
    clientAvatarUrl: t.client?.avatarUrl ?? null,
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
        {}, // every assignee visible — jordan/photographer keys must not vanish (audit critical)
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
    include: { client: { select: { name: true, avatarUrl: true } } },
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
    include: { client: { select: { name: true, avatarUrl: true } } },
    orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
  });
  return tasks.map((t) => mapTask(t, startToday));
}

// ---------------------------------------------------------------------------
// Dashboard chip counts — HONEST, system-wide numbers. The old chips counted
// only the morning-brief slice (Kyle's due-today view), so the dashboard read
// "1 replies / 0 to assign" while 44 tasks were active and 34 sat unassigned.
// These count EVERY active task, so the glance can't understate the backlog.
// ---------------------------------------------------------------------------
export type ActionCounts = {
  replies: number; // open message-type tasks — someone wrote in and is waiting
  qc: number; // open QC/deliver-type tasks — content sitting in the pipeline
  late: number; // ANY active task past its dueAt
  toAssign: number; // triage-type tasks with no owner (isNeedsAssigning, in SQL)
};

export async function getActionCounts(): Promise<ActionCounts> {
  const [replies, qc, late, toAssign] = await Promise.all([
    prisma.smartTask.count({ where: { status: { in: BRIEF_ACTIVE }, taskType: { in: MESSAGE_TASK_TYPES } } }),
    // Same recency rule as the Board, so the chip never counts a card no list
    // can render (audit: a 28-day ON_HOLD QC ghost was chip-counted, invisible).
    prisma.smartTask.count({ where: { status: { in: BRIEF_ACTIVE }, taskType: { in: DELIVER_TASK_TYPES }, OR: [{ projectId: null }, { project: recentProjectWhere() }] } }),
    // Message-type tasks are recency-EXEMPT on every list that renders them —
    // the chip must count what the lists show (review finding).
    prisma.smartTask.count({ where: { status: { in: BRIEF_ACTIVE }, dueAt: { lt: new Date() }, OR: [{ projectId: null }, { project: recentProjectWhere() }, { taskType: { in: MESSAGE_TASK_TYPES } }] } }),
    // Same definition as isNeedsAssigning (src/lib/triage.ts) — delegatable work
    // that arrived without an owner — expressed in SQL so it counts system-wide
    // instead of only the brief slice.
    prisma.smartTask.count({ where: { status: { in: BRIEF_ACTIVE }, assignedKey: null, taskType: { in: [...TRIAGE_TYPES] } } }),
  ]);
  return { replies, qc, late, toAssign };
}

// The number on the dashboard's "Start your day →" button = the number of CARDS
// /today actually renders. It replicates /today's stack query EXACTLY
// (src/app/today/page.tsx): Kyle's own/unassigned + delegated work; message
// tasks at any due date; QC/deliver (minus delivery_text, which lives on /texts)
// while open on a recent job; everything else due by end of today INCLUDING
// overdue; client texts carved out and replaced by ONE rollup card when any are
// waiting. Kept here so /today can adopt this helper later and the two numbers
// can never drift.
export async function getTodayCardCount(): Promise<number> {
  // etEndOfTodayUtc is the DST-correct helper (clientTexts.ts documents why
  // now+24h is wrong around the clock changes — review finding).
  const { etEndOfTodayUtc } = await import("@/lib/clientTexts");
  const endToday = etEndOfTodayUtc();
  // /today's "check" step excludes delivery_text — those moved to /texts.
  const CHECK_TYPES = DELIVER_TASK_TYPES.filter((t) => t !== "delivery_text");
  const [stack, texts, triage] = await Promise.all([
    prisma.smartTask.count({
      where: {
        status: { in: BRIEF_ACTIVE },
        // every assignee visible — jordan/photographer keys must not vanish (audit critical)
        AND: [{
          OR: [
            // Messages/replies: always surface while open (someone is waiting).
            { taskType: { in: MESSAGE_TASK_TYPES } },
            // QC & deliver: while open on a recent job, any due date.
            { taskType: { in: CHECK_TYPES }, OR: [{ projectId: null }, { project: recentProjectWhere() }] },
            // Everything else: due by end of today INCLUDING overdue.
            {
              taskType: { notIn: [...MESSAGE_TASK_TYPES, ...CHECK_TYPES, ...CLIENT_TEXT_TYPES] },
              dueAt: { lte: endToday },
              OR: [{ projectId: null }, { project: recentProjectWhere() }],
            },
          ],
        }],
      },
    }),
    getClientTextTasks(),
    // The unowned-instructions rollup card (one per feed when the pile is
    // non-empty) — counted so the badge matches the feed (review finding).
    prisma.smartTask.count({ where: { status: { in: BRIEF_ACTIVE }, assignedKey: null, taskType: { in: ["internal_instruction", "todo", "vendor_update"] }, OR: [{ projectId: null }, { project: recentProjectWhere() }] } }),
  ]);
  // The texts/triage piles aren't cards — /today shows one rollup card each.
  return stack + (texts.length > 0 ? 1 : 0) + (triage > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Stuck jobs — the dashboard's real fires. The old "Blockers" panel listed
// overdue admin TASKS (e.g. two unsent confirmation texts) while PROJECTS days
// past their delivery promise were invisible on the whole page. This is
// project-level lateness: past deliveryDue, stuck in revision 2+ days (same
// threshold as getProactiveFlags' stale-revision branch), or shot 48h+ ago and
// still not delivered.
// ---------------------------------------------------------------------------
export type StuckJob = {
  id: string;
  title: string;
  reason: string; // "3 days late" · "revision stuck 4d" · "shot 3d ago, not delivered"
  stage: string; // pipeline status (SHOT / EDITING / REVISION / ...)
  daysLate: number; // whole days behind, for sorting/AC display
};

export async function getStuckJobs(): Promise<StuckJob[]> {
  const now = new Date();
  const DAY = 86400000;
  const projects = await prisma.project.findMany({
    where: {
      // "Active" = anything not finished — cancelled/delivered can't be stuck.
      // Neither can a job that was never shot (BOOKED, no shoot date) nor one
      // parked by decision (ON_HOLD): both headlined Kyle's fire panel as
      // "51 / 39 days late" off a deliveryDue left behind by a cancelled slot
      // (audit5 F2, Sep 8 2026 — 2705 Graystone Rd, 56 Hillview Rd).
      status: { notIn: ["CANCELLED", "DELIVERED", "ON_HOLD", "BOOKED"] },
      OR: [
        // Past the delivery promise — which only counts once the shoot has
        // happened and while nothing has gone out. A job delivered on time
        // and then reopened for a revision is "revision stuck Nd" (next
        // branch), not "N days late": 750 E Marshall St read "4 days late"
        // a day after the client had the gallery (audit5 skeptic).
        // …against the promise the job was SOLD under where one is pinned
        // (Sep 18). Both columns are matched here because the pin and the
        // recomputed column can now differ: the row is filtered again in JS
        // below on whichever of the two actually governs.
        { deliveryDue: { lt: now }, shootDate: { lte: now }, deliveredAt: null },
        { promisedDueAt: { lt: now }, shootDate: { lte: now }, deliveredAt: null },
        // Stale revision — 2+ days without closure (a fresh revision is step 1
        // on /today, not a fire; flagging at minute zero triple-listed them).
        { status: "REVISION", revisionRequestedAt: { lte: new Date(now.getTime() - 2 * DAY) } },
        // Shot 48h+ ago and the content still hasn't gone out.
        { status: { in: ["SHOT", "EDITING"] }, deliveredAt: null, shootDate: { lt: new Date(now.getTime() - 2 * DAY) } },
      ],
    },
    select: {
      id: true, title: true, status: true,
      deliveryDue: true, promisedDueAt: true, revisionRequestedAt: true, shootDate: true, deliveredAt: true,
    },
  });

  // A project can match several reasons — dedupe to ONE row with the WORST
  // reason (most days gone) so the row reads as bad as reality.
  const jobs = projects
    .map((p) => {
      const candidates: { reason: string; days: number }[] = [];
      // Mirrors the deliveryDue branch of the WHERE above — a row that matched
      // on the revision branch must not pick up a "days late" reason here.
      // The pinned promise governs when it exists: "3 days late" has to be
      // counted from the date the client was actually given, not from one a
      // settings change produced this morning.
      // …and never a pin left behind by a visit that was RESCHEDULED (review,
      // Sep 18). This read the raw column while the delivery board, the QC
      // card, the owner's dial and the photographer bonus all went through
      // livePromise, so a rebooked job could have headlined Kyle's fire panel
      // as "N days late" against a deadline quoted for the visit before —
      // which is the same 2705 Graystone / 56 Hillview failure the WHERE
      // clause above already guards against from the other side. The two
      // readings now agree by construction.
      const promisedDue = pinnedPromise(p) ?? p.deliveryDue;
      if (promisedDue && promisedDue < now && !p.deliveredAt && p.shootDate && p.shootDate <= now) {
        const d = (now.getTime() - promisedDue.getTime()) / DAY;
        const whole = Math.floor(d);
        candidates.push({
          // Under a day late still deserves the panel — say it in hours.
          reason: whole >= 1 ? `${whole} day${whole === 1 ? "" : "s"} late` : `${Math.max(1, Math.floor(d * 24))}h late`,
          days: d,
        });
      }
      if (p.status === "REVISION" && p.revisionRequestedAt && now.getTime() - p.revisionRequestedAt.getTime() >= 2 * DAY) {
        const d = (now.getTime() - p.revisionRequestedAt.getTime()) / DAY;
        candidates.push({ reason: `revision stuck ${Math.floor(d)}d`, days: d });
      }
      if ((p.status === "SHOT" || p.status === "EDITING") && !p.deliveredAt && p.shootDate && now.getTime() - p.shootDate.getTime() >= 2 * DAY) {
        const d = (now.getTime() - p.shootDate.getTime()) / DAY;
        candidates.push({ reason: `shot ${Math.floor(d)}d ago, not delivered`, days: d });
      }
      const worst = candidates.sort((a, b) => b.days - a.days)[0];
      return worst ? { id: p.id, title: p.title, reason: worst.reason, stage: p.status as string, days: worst.days } : null;
    })
    .filter((j): j is NonNullable<typeof j> => j !== null)
    .sort((a, b) => b.days - a.days); // worst fires first (sorted on raw days)

  return jobs.map(({ days, ...j }) => ({ ...j, daysLate: Math.floor(days) }));
}

// ---------------------------------------------------------------------------
// Owner pulse — "is the machine healthy?" in four numbers: on-time delivery %,
// median shoot→delivered turnaround, % of client texts answered within the
// hour, and open revisions. Trailing 30 days, with deltas vs the PRIOR 30 days
// so the arrows show direction rather than noise. Deliberately NO QC-pass-rate
// — that metric was judged gameable and is not shipped.
//
// BOTH delivery dials measure the BUSINESS, not the bookkeeping: rows whose
// deliveredAt was stamped by a catch-up pass on the pipeline board are left out
// (see backfillStampedDeliveries below). Each dial ships with a plain-English
// `*Basis` line saying exactly what it counted and what it set aside — the
// owner should never have to ask what a number on his own dashboard means.
// ---------------------------------------------------------------------------
export type OwnerPulse = {
  onTimePct: number | null; // % delivered on/before deliveryDue (30d)
  onTimeDelta: number | null; // pct-points vs prior 30d — positive = better
  turnaroundH: number | null; // median shoot→delivered hours (30d)
  turnaroundDeltaH: number | null; // hours vs prior 30d — NEGATIVE = better
  replyPct: number | null; // % inbound texts answered <1h (30d)
  replyDelta: number | null; // pct-points vs prior 30d — positive = better
  openRevisions: number; // active revision tasks right now
  // --- what the two delivery dials actually measured (render under them) ---
  onTimeBasis: string; // "17 of 54 jobs delivered in the last 30 days …"
  turnaroundBasis: string; // "Median shoot → delivered across 54 jobs …"
  backfillExcluded: number; // rows set aside as catch-up stamps (30d window)
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Catch-up stamps: deliveries the hub RECORDED at a moment that has nothing to
// do with when the client actually got their media.
//
// moveProjectStatus (src/app/actions.ts) writes `deliveredAt = now()` on every
// hand-move to Delivered and logs a STATUS_CHANGE "Moved from X to Delivered."
// One person clearing a stale board therefore mints a run of deliveries all
// stamped seconds apart. Nobody delivers three jobs in five minutes — that is
// bookkeeping, so we detect the RUN, not the individual move: three or more
// hand-moves chained at <= 5 minutes apart is a board-clearing pass, and the
// to-Delivered moves inside it are excluded from both delivery dials.
//
// Live proof (2 Sep 2026): one pass on 17 Aug — 16 hand-moves in 68 seconds —
// stamped six deliveries whose shoot→stamp spans ran 13 to 76 DAYS. They alone
// pushed median turnaround from 50h to 97h and on-time from 31% to 28%. A
// SINGLE hand-move is left alone: that is a real "I delivered this, mark it".
// Evidence-based flips (the hourly sweep's "Status re-evaluated: REVIEW →
// DELIVERED. All ordered deliverables confirmed live on Aryeo.") are never
// touched — those ARE deliveries, even when three land in the same second.
// ---------------------------------------------------------------------------
const BULK_PASS_GAP_MS = 5 * 60_000; // moves chained closer than this = one sitting
const BULK_PASS_MIN_MOVES = 3; // three-plus hand moves in one sitting = a catch-up pass
const STAMP_MATCH_MS = 2 * 60_000; // deliveredAt is written alongside its own move

/** projectId → the moment a board-clearing pass stamped it Delivered. */
async function backfillStampedDeliveries(since: Date): Promise<Map<string, Date>> {
  const moves = await prisma.activity.findMany({
    // Reach back one gap-width before the window so a pass straddling the
    // boundary is still seen whole (and still counted at full size).
    where: {
      type: "STATUS_CHANGE",
      body: { startsWith: "Moved from" },
      createdAt: { gte: new Date(since.getTime() - BULK_PASS_GAP_MS) },
    },
    select: { createdAt: true, body: true, projectId: true },
    orderBy: { createdAt: "asc" },
  });

  const stamped = new Map<string, Date>();
  let run: typeof moves = [];
  const closeRun = () => {
    if (run.length >= BULK_PASS_MIN_MOVES) {
      for (const m of run) {
        // Only the to-Delivered moves carry a deliveredAt stamp; the rest of the
        // pass (On Hold / Cancelled / back to In Editing) is just context that
        // proves someone was clearing the board.
        if (m.projectId && /to Delivered\.$/.test(m.body)) stamped.set(m.projectId, m.createdAt);
      }
    }
    run = [];
  };
  for (const m of moves) {
    if (run.length && m.createdAt.getTime() - run[run.length - 1].createdAt.getTime() > BULK_PASS_GAP_MS) closeRun();
    run.push(m);
  }
  closeRun();
  return stamped;
}

export async function getOwnerPulse(): Promise<OwnerPulse> {
  const now = Date.now();
  const d30 = new Date(now - 30 * 86400000);
  const d60 = new Date(now - 60 * 86400000);

  const [allDelivered, texts, openRevisions, backfilled] = await Promise.all([
    // Both 30d windows in one fetch, bucketed in JS below.
    prisma.project.findMany({
      where: { deliveredAt: { gte: d60 }, status: { not: "CANCELLED" } },
      // promisedDueAt is the deadline the job was SOLD under (Sep 18). It has
      // to be read here, not Project.deliveryDue alone: deliveryDue is
      // RECOMPUTED by the status sweep on every pass, so the day a turnaround
      // default moves, every delivered job is silently re-judged against a
      // promise nobody made. Measured before the premium reel moved to four
      // business days: 39 of the delivered premium jobs would have flipped
      // from late to on-time, re-scoring this dial and the photographer
      // quarterly bonus that reads the same pair of columns.
      select: { id: true, deliveredAt: true, deliveryDue: true, promisedDueAt: true, shootDate: true },
    }),
    // Texts only (calls/emails have different response norms), clientId set so
    // inbound/outbound can be paired per conversation. Ordered ASC so "the next
    // outbound" is a forward scan.
    prisma.commLog.findMany({
      where: { channel: "text", occurredAt: { gte: d60 }, clientId: { not: null } },
      select: { direction: true, clientId: true, occurredAt: true },
      orderBy: { occurredAt: "asc" },
    }),
    prisma.smartTask.count({ where: { taskType: "revision", status: { in: BRIEF_ACTIVE } } }),
    backfillStampedDeliveries(d60),
  ]);

  // Drop the catch-up stamps from BOTH windows (current and prior) so the delta
  // arrow compares like with like. A project is only dropped when its own
  // deliveredAt sits alongside the hand-move that wrote it — a job the pass
  // touched and that was LATER re-delivered for real keeps its real stamp.
  const isBackfillStamp = (p: { id: string; deliveredAt: Date | null }) => {
    const at = backfilled.get(p.id);
    return !!at && !!p.deliveredAt && Math.abs(p.deliveredAt.getTime() - at.getTime()) <= STAMP_MATCH_MS;
  };
  const delivered = allDelivered.filter((p) => !isBackfillStamp(p));
  const backfillExcluded = allDelivered.filter((p) => p.deliveredAt! >= d30 && isBackfillStamp(p)).length;

  const pct = (ok: number, total: number) => (total ? Math.round((ok / total) * 100) : null);

  // (a) on-time % — only judgeable when the project carried a due date AND the
  // stamp sits after the shoot. A job delivered, then bounced and REBOOKED has
  // its shootDate pushed to the new visit while deliveredAt still points at the
  // old delivery (1224 Gail Rd: stamped 8 Aug, re-shoot 24 Aug) — judging that
  // pair scored a free on-time win for a delivery that hasn't happened yet.
  // The turnaround dial already refused those rows; now both dials agree.
  // The promise it was sold under, falling back to the live column for a row
  // the pin has never covered (scripts/pin-promises.ts).
  // …and never a pin left behind by a visit that was rescheduled: a deadline
  // that precedes its own shoot belongs to the job we were booked for before,
  // not this one (turnaround.livePromise).
  const promiseOf = (p: { deliveryDue: Date | null; promisedDueAt: Date | null; shootDate: Date | null }) =>
    pinnedPromise(p) ?? p.deliveryDue;
  const judged = delivered.filter(
    (p) => p.deliveredAt && promiseOf(p) && (!p.shootDate || p.deliveredAt > p.shootDate),
  );
  const curJ = judged.filter((p) => p.deliveredAt! >= d30);
  const prevJ = judged.filter((p) => p.deliveredAt! < d30);
  const curOnTime = curJ.filter((p) => p.deliveredAt! <= promiseOf(p)!).length;
  const onTimePct = pct(curOnTime, curJ.length);
  const onTimePrev = pct(prevJ.filter((p) => p.deliveredAt! <= promiseOf(p)!).length, prevJ.length);

  // (b) median shoot→delivered hours (skip rows where delivery precedes the
  // shoot — rebooked jobs and backfilled data have a few).
  const measurable = (ps: typeof delivered) =>
    ps.filter((p) => p.shootDate && p.deliveredAt && p.deliveredAt > p.shootDate);
  const turnaround = (ps: typeof delivered) =>
    median(measurable(ps).map((p) => (p.deliveredAt!.getTime() - p.shootDate!.getTime()) / 3600000));
  const curDelivered = delivered.filter((p) => p.deliveredAt! >= d30);
  const curT = turnaround(curDelivered);
  const prevT = turnaround(delivered.filter((p) => p.deliveredAt! < d30));

  // (c) replies <1h — pair each inbound text with the NEXT outbound to the same
  // client; a never-answered inbound counts against the %.
  const byClient = new Map<string, { dir: string; at: number }[]>();
  for (const t of texts) {
    const arr = byClient.get(t.clientId!);
    const ev = { dir: t.direction, at: t.occurredAt.getTime() };
    if (arr) arr.push(ev);
    else byClient.set(t.clientId!, [ev]);
  }
  let curIn = 0, curFast = 0, prevIn = 0, prevFast = 0;
  for (const events of byClient.values()) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].dir !== "in") continue;
      let fast = false;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].dir !== "out") continue;
        fast = events[j].at - events[i].at <= 3600000;
        break;
      }
      // Bucket by when the INBOUND arrived (the reply may cross the boundary).
      if (events[i].at >= d30.getTime()) { curIn++; if (fast) curFast++; }
      else { prevIn++; if (fast) prevFast++; }
    }
  }
  const replyPct = pct(curFast, curIn);
  const replyPrev = pct(prevFast, prevIn);

  const delta = (a: number | null, b: number | null) => (a != null && b != null ? a - b : null);

  // Say it in words, on the page, next to the number. "28%" with no basis is
  // how a dial quietly turns into a data-quality report nobody trusts.
  const setAside = backfillExcluded
    ? ` ${backfillExcluded} ${backfillExcluded === 1 ? "job" : "jobs"} stamped by a catch-up pass on the board (not a real delivery moment) left out.`
    : "";
  const onTimeBasis = curJ.length
    ? `${curOnTime} of ${curJ.length} jobs delivered in the last 30 days met the date we promised.${setAside}`
    : `No job with a promised date was delivered in the last 30 days.${setAside}`;
  const nT = measurable(curDelivered).length;
  const turnaroundBasis = nT
    ? `Median shoot → delivered across ${nT} ${nT === 1 ? "job" : "jobs"} in the last 30 days.${setAside}`
    : `Nothing measurable delivered in the last 30 days.${setAside}`;

  return {
    onTimePct,
    onTimeDelta: delta(onTimePct, onTimePrev),
    turnaroundH: curT != null ? Math.round(curT) : null,
    turnaroundDeltaH: curT != null && prevT != null ? Math.round(curT - prevT) : null,
    replyPct,
    replyDelta: delta(replyPct, replyPrev),
    openRevisions,
    onTimeBasis,
    turnaroundBasis,
    backfillExcluded,
  };
}

// ---------------------------------------------------------------------------
// Owner quality dials — two already-built helpers surfaced on the dashboard.
//
//   • VIDEO SLA (getVideoSlaStatus, projectStatus.ts): the SAME in-flight video
//     jobs the /editing "Video SLA" panel ranks. Aggregated here to ONE pair of
//     counts — how many videos are in editing, how many are past their delivery
//     window — so the owner sees the editing-bench heat as a single line without
//     the full table. NOTE these jobs mostly ALSO appear in getStuckJobs (shot
//     48h+ undelivered / past deliveryDue), so we never re-list them as fires —
//     we show a compact roll-up line that links into the /editing queue.
//   • QC quality: revision-after-delivery rate + misses per pass, over the QC
//     passes A HUMAN ACTUALLY WORKED. See ownerQcDial below for why that
//     qualifier is the whole point. qcPasses === 0 → the page shows its
//     "tracking starts" hint instead of a number nobody stood behind.
//
// Both are owner-only — call this behind the same gate as the pulse/money strips.
// ---------------------------------------------------------------------------
export type OwnerDials = {
  video: { inEditing: number; pastSla: number }; // in-flight video jobs / of those past SLA
  qc: OwnerQcDial; // qcPasses === 0 → dashboard hides the QC dial (empty-state guard)
};

// ---------------------------------------------------------------------------
// The QC dial, measured over MANNED passes only.
//
// "QC misses per job 6.8" was not a quality number. Every media_qa card carries
// failure-mode rows Kyle is supposed to tick ("Verticals & horizontals straight",
// "People / camera in mirrors gone", …) — but the interactive checklist UI was
// removed (see the reconciler in src/lib/tasks.ts: "The checklist is no longer
// an interactive UI"), so nobody CAN tick them. The card then closes by machine:
// the delivered-sweep (closeObsoleteTasks, completedBy "auto:delivered") or the
// hourly reconciler's evidence auto-close. Both snapshot the untouched rows as
// "misses". The dial was counting the absence of a UI.
//
// Live proof (2 Sep 2026): of the 83 QC cards closed in 30 days, 64 were closed
// by the delivered-sweep and NOT ONE carried a single human tick. All time, of
// the 148 records that carry rows a person is meant to tick, ZERO have one
// ticked — this dial has never once measured a human. So the number is retired
// rather than patched: `qcPasses` now counts only passes somebody actually
// worked, and `avgMisses` / `reopenedRate` / `byMiss` are computed over exactly
// those. With none on record the dial reports nothing at all, which is the
// truth — not 6.8, and not a reassuring 0.
//
// completedBy CANNOT be used to tell human from machine: both the reconciler
// and setSmartTaskStatus stamp `assignedKey ?? "kyle"`, and every QC card is
// minted assigned to Kyle — which is why 19 of these passes look like "kyle"
// and none of them were his.
// ---------------------------------------------------------------------------
export type OwnerQcDial = {
  windowDays: number;
  /** QC passes a HUMAN actually worked (at least one box ticked). 0 means the
   *  dial has nothing to say — NOT that quality is perfect. */
  qcPasses: number;
  avgMisses: number; // mean unticked human rows, across manned passes only
  reopenedRate: number; // % of manned passes a revision later bounced
  byMiss: QcMissBucket[]; // which rows got skipped most, manned passes only
  // --- what the dial set aside, so the page can say so out loud ---
  totalPasses: number; // every QC card that closed in the window
  unmannedPasses: number; // of those, closed without a single box ticked
  deliverySweepPasses: number; // of those, closed by the delivered-sweep specifically
  basis: string; // one plain-English line for the dashboard
};

async function ownerQcDial(days = 30): Promise<OwnerQcDial> {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const records = await prisma.qcRecord.findMany({
    where: { completedAt: { gte: since } },
    select: { itemsChecked: true, missCount: true, reopenedByRevisionAt: true, completedBy: true },
  });

  // "Is this row one Kyle has to tick?" — asked through countQcMisses so the
  // auto-evidence rule lives in ONE place (src/lib/tasks.ts). A single unticked
  // item scores 1 iff countQcMisses treats it as a human row; evidence rows
  // ("QC Photos", "Deliver the gallery", the cull guidance line) score 0.
  //
  // ...MINUS the debrief dispatch lines, which countQcMisses does not exclude
  // but which no human ever ticks: specsForProject emits them pre-decided from
  // the photographer's own debrief ("Shot order noted…" is hard-coded done:true;
  // "Verify removals…" keys off removalNotes; "Photographer submitted…" off
  // debriefSubmittedAt — src/lib/tasks.ts ~415-433). Counting them as Kyle-ticks
  // makes machine-set rows look like human work: without this line four cards
  // read as "worked" on 2 Sep purely because the spec had ticked those two rows.
  const isHumanRow = (label: string) =>
    !DEBRIEF_QC_LABELS.has(label) && countQcMisses([{ label, done: false }]) === 1;

  const manned: { misses: number; unticked: string[]; reopened: boolean }[] = [];
  let unmannedPasses = 0;
  // The delivered-sweep (closeObsoleteTasks) is the single biggest closer and
  // stamps itself; the rest are the reconciler's evidence auto-close and human
  // "Complete" presses that never touched a box. All three are unmanned — this
  // count just lets the page name the biggest one.
  let deliverySweepPasses = 0;
  for (const r of records) {
    const items = parseChecklist(r.itemsChecked);
    const humanRows = items.filter((i) => isHumanRow(i.label));
    // MANNED = the card had rows for a person to tick and at least ONE of them
    // was ticked. That single tick is the only proof in the data that someone
    // was at the checklist. Requiring ALL of them would be self-defeating: such
    // a pass has zero misses by definition, so the miss rate could only ever
    // read 0. A part-ticked card is the interesting one — it closed with real
    // work left unticked, and THAT is the miss the owner wants to see.
    if (humanRows.length === 0 || !humanRows.some((i) => i.done)) {
      unmannedPasses++;
      if (r.completedBy === "auto:delivered") deliverySweepPasses++;
      continue;
    }
    // Misses are counted off THESE rows, not the stored missCount — that column
    // was written by countQcMisses and so carries the debrief rows too.
    const unticked = humanRows.filter((i) => !i.done).map((i) => i.label);
    manned.push({ misses: unticked.length, unticked, reopened: !!r.reopenedByRevisionAt });
  }

  const missByLabel = new Map<string, number>();
  for (const p of manned) for (const label of p.unticked) missByLabel.set(label, (missByLabel.get(label) ?? 0) + 1);
  const byMiss: QcMissBucket[] = [...missByLabel.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  const totalMisses = manned.reduce((s, p) => s + p.misses, 0);
  const reopened = manned.filter((p) => p.reopened).length;
  const basis = manned.length
    ? `Counts only the ${manned.length} of ${records.length} QC ${records.length === 1 ? "card" : "cards"} closed in the last ${days} days that somebody actually worked. The other ${unmannedPasses} closed with not one box ticked (${deliverySweepPasses} of them automatically, the moment the job delivered) and are not evidence of anything.`
    : records.length
      ? `Not measuring QC quality: not one of the ${records.length} QC ${records.length === 1 ? "card" : "cards"} closed in the last ${days} days had a single box ticked — ${deliverySweepPasses} closed automatically the moment the job delivered, the rest were closed without opening the checklist. "Misses per job" was retired: it was counting boxes nobody was at the screen to tick.`
      : `No QC card has closed in the last ${days} days.`;

  return {
    windowDays: days,
    qcPasses: manned.length,
    avgMisses: manned.length ? Math.round((totalMisses / manned.length) * 10) / 10 : 0,
    reopenedRate: manned.length ? Math.round((reopened / manned.length) * 1000) / 10 : 0,
    byMiss,
    totalPasses: records.length,
    unmannedPasses,
    deliverySweepPasses,
    basis,
  };
}

export async function getOwnerDials(): Promise<OwnerDials> {
  const [projects, qc] = await Promise.all([
    // Mirror /editing's `inflightVideo`: non-delivered production stages that
    // ordered a video/reel. Same statuses + deliverable filter the Editor Queue
    // uses, so the dashboard's count can't drift from that page.
    prisma.project.findMany({
      where: { status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } },
      select: {
        shootDate: true,
        status: true,
        client: { select: { socialClient: true } },
        tierOverride: true,
        packageName: true,
        appointments: { select: { status: true, startAt: true } },
        deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
      },
    }),
    ownerQcDial(30),
  ]);

  let inEditing = 0;
  let pastSla = 0;
  for (const p of projects) {
    // getVideoSlaStatus returns null when no video was ordered / no shoot date —
    // that filters non-video jobs for us (same rule the SLA panel applies).
    const sla = getVideoSlaStatus({
      shootDate: p.shootDate,
      status: p.status,
      // Same handover as /edit's header: the owner's past-SLA dial must read
      // the office tier and the latest leg (Sep 16).
      appointments: p.appointments,
      tierOverride: p.tierOverride,
      packageName: p.packageName,
      deliverables: p.deliverables,
      client: p.client,
    });
    if (!sla) continue;
    inEditing++;
    if (sla.overdue) pastSla++;
  }

  return { video: { inEditing, pastSla }, qc };
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
  // The window used to hard-stop at tomorrow, which hid a busy week (9 shoots)
  // behind a "Tomorrow: N" one-liner. It now runs today + the NEXT 7 DAYS so
  // the dashboard's week strip can show the real load; `today`/`tomorrow` keep
  // their original meaning for existing callers (/today's footer count).
  const endWindow = etDayStartUtc(etAddDays(new Date(), 8));

  const appts = await prisma.appointment.findMany({
    where: {
      startAt: { gte: startToday, lt: endWindow },
      status: { not: "CANCELED" },
      project: { status: { notIn: ["CANCELLED", "DELIVERED"] } },
    },
    orderBy: { startAt: "asc" },
    include: {
      project: { select: { id: true, title: true, client: { select: { name: true, avatarUrl: true } } } },
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
    tomorrow: appts.filter((a) => a.startAt! >= startTomorrow && a.startAt! < startDayAfter).map(map),
    // Tomorrow through day 7 — feeds the dashboard's "This week" strip.
    week: appts.filter((a) => a.startAt! >= startTomorrow).map(map),
  };
}
export type ShootWindow = Awaited<ReturnType<typeof getShootWindow>>;

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
          deliverables: { where: { removedFromOrderAt: null }, select: { id: true, type: true, label: true, status: true } },
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
    // `sentiment` is the effective value (an owner's re-read on /quality lands
    // there); a row dismissed as "not feedback" stays off the timeline (Sep 16).
    prisma.feedback.findMany({
      where: { projectId: { in: projectIds }, dismissedAt: null },
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
  clientAvatarUrl: string | null; // see BriefTask.clientAvatarUrl
  propertyAddress: string | null;
  projectId: string | null;
};
export type HistoryDelivery = {
  id: string;
  title: string;
  deliveredAt: string;
  clientName: string | null;
  clientAvatarUrl: string | null; // see BriefTask.clientAvatarUrl
};

// Completed tasks over the last N days (newest first), for the history page.
export async function getTaskHistory(days = 45): Promise<HistoryTask[]> {
  const since = etDayStartUtc(etAddDays(new Date(), -days));
  const tasks = await prisma.smartTask.findMany({
    where: { status: "COMPLETED", completedAt: { gte: since } },
    orderBy: { completedAt: "desc" },
    select: {
      id: true, title: true, taskType: true, completedAt: true,
      propertyAddress: true, projectId: true, client: { select: { name: true, avatarUrl: true } },
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
      clientAvatarUrl: t.client?.avatarUrl ?? null,
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
  clientAvatarUrl: string | null; // see BriefTask.clientAvatarUrl
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
      project: { select: { id: true, title: true, client: { select: { name: true, avatarUrl: true } } } },
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
      clientAvatarUrl: a.project!.client?.avatarUrl ?? null,
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
  clientAvatarUrl: string | null; // see BriefTask.clientAvatarUrl
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
  // A QuickBooks payment from this customer, on/after the order, covering the
  // balance — Aryeo's paid-status lags for QuickBooks-rail clients, so this
  // "owed" row may already be settled. A hint to verify, never an auto-clear.
  possiblyPaidQbo: boolean;
};

/** Rows no longer counted as owed — either REMOVED (cancelled appointment /
 *  test order) or MARKED PAID by hand. Shown collapsed under Finance → Unpaid
 *  so neither action is invisible, and both can be undone (review HIGH). */
export async function getClearedArRows(): Promise<
  {
    id: string; title: string; clientName: string; clientAvatarUrl: string | null; outstanding: number /* dollars */;
    kind: "removed" | "paid"; at: string; note: string | null;
  }[]
> {
  const rows = await prisma.project.findMany({
    where: {
      AND: [
        { OR: [{ status: "DELIVERED" }, { deliveredAt: { not: null } }] },
        { balanceAmount: { gt: 0 } },
        { OR: [{ arRemovedAt: { not: null } }, { paidMarkedAt: { not: null } }] },
      ],
    },
    select: {
      id: true, title: true, balanceAmount: true,
      arRemovedAt: true, arRemovedNote: true, paidMarkedAt: true, paidMarkedNote: true,
      client: { select: { name: true, avatarUrl: true } },
    },
    take: 100,
  });
  // Sorted by when it was CLEARED — updatedAt is bumped by the Aryeo money
  // mirror on every sync, which would scramble this list (review).
  return rows
    .map((r) => {
      const paid = r.paidMarkedAt != null;
      return {
        id: r.id,
        title: r.title,
        clientName: r.client?.name ?? "Unknown",
        clientAvatarUrl: r.client?.avatarUrl ?? null,
        outstanding: (r.balanceAmount ?? 0) / 100, // balanceAmount is CENTS
        kind: (paid ? "paid" : "removed") as "removed" | "paid",
        at: ((paid ? r.paidMarkedAt : r.arRemovedAt) as Date).toISOString(),
        note: paid ? r.paidMarkedNote : r.arRemovedNote,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export async function getBillingRows(): Promise<{ rows: BillingRow[]; totalOutstanding: number }> {
  const projects = await prisma.project.findMany({
    // arRemovedAt = the owner took it off the AR list (cancelled appointment /
    // test order) — the row stays in the DB, just not in what's owed.
    // arRemovedAt = the owner took it off AR (cancelled/test); paidMarkedAt =
    // the owner confirmed the money came in (Aryeo's paid flag lags). Either
    // way it is no longer OWED, so it leaves this list.
    where: {
      AND: [
        { OR: [{ status: "DELIVERED" }, { deliveredAt: { not: null } }] },
        { balanceAmount: { gt: 0 } },
        { arRemovedAt: null },
        { paidMarkedAt: null },
        // An order that no longer exists in Aryeo can't be collected through
        // it — the orphan sweep flags these and asks the owner what to do.
        { aryeoMissingAt: null },
      ],
    },
    orderBy: [{ deliveredAt: { sort: "desc", nulls: "last" } }, { orderedAt: "desc" }],
    select: {
      id: true, title: true, orderedAt: true, deliveredAt: true,
      price: true, balanceAmount: true, paymentStatus: true, invoiceUrl: true, paymentUrl: true,
      aryeoOrderId: true, aryeoListingId: true,
      client: { select: { name: true, avatarUrl: true } },
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

  // CROSS-CHECK vs QuickBooks: for each unpaid order, is there a Payment/
  // SalesReceipt from the same customer, on/after the order date, of at least
  // the outstanding amount? One grouped pull — no per-row queries.
  const names = [...new Set(projects.map((p) => p.client?.name).filter((n): n is string => !!n))];
  const paidHints = new Set<string>();
  if (names.length) {
    try {
      const oldestOrder = projects.reduce<Date | null>((min, p) => (p.orderedAt && (!min || p.orderedAt < min) ? p.orderedAt : min), null);
      const qboPays = await prisma.qboTransaction.findMany({
        where: {
          type: { in: ["Payment", "SalesReceipt"] },
          ...(oldestOrder ? { txnDate: { gte: oldestOrder } } : {}),
          OR: names.map((n) => ({ customerName: { contains: n, mode: "insensitive" as const } })),
        },
        select: { customerName: true, amount: true, txnDate: true },
      });
      for (const p of projects) {
        const nm = p.client?.name;
        if (!nm) continue;
        const owed = (p.balanceAmount ?? 0) / 100;
        const hit = qboPays.some(
          (q) =>
            q.customerName?.toLowerCase().includes(nm.toLowerCase()) &&
            q.amount >= owed - 0.01 &&
            (!p.orderedAt || q.txnDate >= p.orderedAt),
        );
        if (hit) paidHints.add(p.id);
      }
    } catch { /* hint only — AR renders without it */ }
  }

  const rows: BillingRow[] = projects.map((p) => ({
    id: p.id,
    title: p.title,
    clientName: p.client?.name ?? null,
    clientAvatarUrl: p.client?.avatarUrl ?? null,
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
    possiblyPaidQbo: paidHints.has(p.id),
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
    select: { id: true, title: true, deliveredAt: true, client: { select: { name: true, avatarUrl: true } } },
  });
  return projects
    .filter((p) => p.deliveredAt)
    .map((p) => ({ id: p.id, title: p.title, deliveredAt: p.deliveredAt!.toISOString(), clientName: p.client?.name ?? null, clientAvatarUrl: p.client?.avatarUrl ?? null }));
}

// ---------------------------------------------------------------------------
// Proactive flags — "what to worry about" without being asked. Surfaces the
// STRATEGIC risks the tactical Needs-Attention panel misses: aging receivables,
// VIP clients gone quiet, and stale revisions. Rule-based + fast.
// ---------------------------------------------------------------------------
export type ProactiveFlag = {
  id: string;
  severity: "high" | "medium" | "low";
  kind: "ar" | "vip-quiet" | "revision" | "delivery-exception";
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

  // 0) A DELIVERY NOBODY CAN CONFIRM. First, and ahead of money, because it is
  // the only flag here about a client who may be waiting on something they paid
  // for and never got. The reconciliation writes these against live Aryeo reads
  // — never the cached evidence blob, which is stale on delivered jobs and was
  // the whole Sep 17 wrong answer — and it only ever raises a flag: it never
  // changes a status, never re-sends a file and never contacts anybody. Clearing
  // one is a person's job.
  try {
    const { deliveryExceptionFlags } = await import("@/lib/deliveryExceptions");
    for (const f of await deliveryExceptionFlags(2)) flags.push(f);
  } catch {
    /* a flag source that cannot be read must not take the panel down */
  }

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

// ---------------------------------------------------------------------------
// FLAGGED FOR YOU — the top of a person's home.
//
// Jordan, Sep 7 2026: "When I flag something for someone, it should pop up on
// their home screen at the top (Flagged by Jordan for immediate review and
// resolution), with a link to the things that were flagged so they can just
// click and see what I flagged and the feedback I gave. I think we have this
// for the photographers but need it for Kyle."
//
// A flag is a SmartTask carrying flaggedBy/flaggedAt — stamped only when a
// PERSON deliberately sends work to someone (photo flags in the lightbox, a
// shoot issue raised on a job). System-minted rows never carry it, so this
// banner can never fill up with the hourly engine's own output.
// ---------------------------------------------------------------------------
export type FlaggedItem = {
  taskId: string;
  title: string;
  note: string | null;
  flaggedBy: string;
  flaggedAtISO: string;
  href: string;
  projectTitle: string | null;
};

export async function getFlaggedForMe(opts: {
  /** the viewer's editor/assignee key ("kyle", "kim", …), when they have one */
  assignedKey?: string | null;
  /** the viewer's TeamMember id, when they have one */
  memberId?: string | null;
  role: string;
}): Promise<FlaggedItem[]> {
  const mine: Prisma.SmartTaskWhereInput[] = [];
  if (opts.assignedKey) mine.push({ assignedKey: opts.assignedKey });
  if (opts.memberId) mine.push({ ownerId: opts.memberId });
  // An OWNER sees flags raised BY someone else for the office (a photographer's
  // shoot issue), not the ones he raised himself — his own flag reaching his
  // own banner would be a mirror.
  if (mine.length === 0) return [];

  const rows = await prisma.smartTask.findMany({
    where: {
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      flaggedAt: { not: null },
      OR: mine,
    },
    orderBy: [{ flaggedAt: "desc" }],
    take: 6,
    select: {
      id: true, title: true, summary: true, description: true, projectId: true,
      flaggedBy: true, flaggedAt: true, taskType: true,
      project: { select: { title: true } },
    },
  });

  return rows.map((t) => ({
    taskId: t.id,
    title: t.title,
    // The FEEDBACK itself — the words the flagger typed, which is the thing
    // worth reading. summary is the composed sentence; description carries the
    // per-item notes when there are several.
    note: (t.description?.trim() || t.summary?.trim() || null)?.slice(0, 400) ?? null,
    flaggedBy: t.flaggedBy ?? "the office",
    flaggedAtISO: t.flaggedAt!.toISOString(),
    // Straight to the thing, not to a task list: photo flags open the job's
    // gallery, everything else opens the job.
    href: t.projectId
      ? t.taskType === "image_fixes" ? `/projects/${t.projectId}?tab=flags` : `/projects/${t.projectId}`
      : "/tasks",
    projectTitle: t.project?.title?.split(",")[0] ?? null,
  }));
}
