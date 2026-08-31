import "server-only";
import { prisma } from "@/lib/prisma";
import { findUnansweredInbound } from "@/lib/commsSla";
import { isNeedsAssigning } from "@/lib/triage";

// ---------------------------------------------------------------------------
// Kyle's Ops Day (Jordan's "Daily Operations & Client Experience Structure",
// Sep 1 2026) — the data behind the guided screen. Each schedule block gets
// its live payload from the SAME sources the rest of the hub reads, so the
// screen can never disagree with Tasks / Editor Queue / Communications.
// ---------------------------------------------------------------------------

const ET = "America/New_York";

function etDayKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: ET });
}
function etDayWindow(offsetDays: number): { start: Date; end: Date; key: string } {
  // DST-safe: resolve the ET offset at noon of the target day.
  const base = new Date();
  base.setUTCDate(base.getUTCDate()); // today, UTC
  const key = new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: ET });
  const noonUtc = new Date(`${key}T12:00:00Z`);
  const etHourAtNoon = Number(noonUtc.toLocaleString("en-US", { timeZone: ET, hour: "numeric", hour12: false }));
  const start = new Date(`${key}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() + (12 - etHourAtNoon));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end, key };
}

export type OpsShoot = {
  id: string;
  title: string;
  timeISO: string | null;
  photographer: string | null;
  services: string[];
  clientName: string;
  /** access / lockbox / special-instruction text when the order carries it */
  accessNote: string | null;
  specialRequests: string[];
  /** readiness flags for the prep blocks — empty = ready */
  gaps: string[];
  videoOrdered: boolean;
  debriefSubmitted: boolean;
};

export type OpsQcRow = {
  taskId: string;
  projectId: string;
  title: string;
  clientName: string | null;
  itemsLeft: number;
  dueISO: string | null;
  overdue: boolean;
  debrief: { shotOrder: string | null; removals: string | null; videoBrief: boolean; unsubmitted: boolean };
};

export type OpsLoop = { taskId: string; title: string; summary: string | null; dueISO: string | null; overdue: boolean; projectId: string | null };

export type OpsDay = {
  nowISO: string;
  todayShoots: OpsShoot[];
  tomorrowShoots: OpsShoot[];
  unanswered: { count: number; oldestHours: number | null; preview: { name: string; snippet: string; hours: number }[] };
  qc: OpsQcRow[];
  revisions: { projectId: string; title: string; ageDays: number }[];
  pipeline: { editing: number; review: number; revision: number; overdueTasks: number; dueTodayTasks: number };
  openLoops: OpsLoop[];
  needsAssigning: number;
  closeout: {
    todayShootsDone: boolean;
    todayDebriefsIn: number;
    todayDebriefsMissing: number;
    tomorrowGaps: number;
    unanswered: number;
    openQc: number;
    openRevisions: number;
  };
};

const DEBRIEF_GATE = Date.parse("2026-09-02T00:00:00-04:00");

function shootRow(p: {
  id: string; title: string; shootDate: Date | null;
  debriefSubmittedAt: Date | null;
  photographer: { name: string } | null;
  client: { name: string };
  deliverables: { type: string; label: string | null }[];
  activities: { type: string; body: string }[];
  appointments: { description: string | null }[];
}): OpsShoot {
  const services = [...new Set(p.deliverables.map((d) => d.label ?? d.type))];
  const videoOrdered = p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const special = p.activities.filter((a) => a.type === "SPECIAL_REQUEST").map((a) => a.body);
  // The access/lockbox brief rides the APPOINTMENT, not the project.
  const access = p.appointments.map((a) => a.description?.trim()).find(Boolean) ?? null;
  const gaps: string[] = [];
  if (!p.photographer) gaps.push("no photographer assigned");
  if (!access) gaps.push("no access / lockbox notes on the appointment");
  if (p.deliverables.length === 0) gaps.push("no services on the order");
  return {
    id: p.id,
    title: p.title.split(",")[0],
    timeISO: p.shootDate?.toISOString() ?? null,
    photographer: p.photographer?.name ?? null,
    services,
    clientName: p.client.name,
    accessNote: access ? access.slice(0, 400) : null,
    specialRequests: special,
    gaps,
    videoOrdered,
    debriefSubmitted: !!p.debriefSubmittedAt,
  };
}

const SHOOT_SELECT = {
  id: true, title: true, shootDate: true, debriefSubmittedAt: true,
  photographer: { select: { name: true } },
  client: { select: { name: true } },
  deliverables: { select: { type: true, label: true } },
  activities: { where: { type: "SPECIAL_REQUEST" as const }, select: { type: true, body: true } },
  appointments: { select: { description: true } },
} as const;

export async function buildOpsDay(): Promise<OpsDay> {
  const now = new Date();
  const today = etDayWindow(0);
  const tomorrow = etDayWindow(1);

  const [todayProjects, tomorrowProjects, qcTasks, loopTasks, revisionProjects, pipelineCounts, unansweredList, assignQueue] =
    await Promise.all([
      prisma.project.findMany({
        where: { shootDate: { gte: today.start, lt: today.end }, status: { notIn: ["CANCELLED", "ON_HOLD"] } },
        select: SHOOT_SELECT,
        orderBy: { shootDate: "asc" },
      }),
      prisma.project.findMany({
        where: { shootDate: { gte: tomorrow.start, lt: tomorrow.end }, status: { notIn: ["CANCELLED", "ON_HOLD"] } },
        select: SHOOT_SELECT,
        orderBy: { shootDate: "asc" },
      }),
      prisma.smartTask.findMany({
        where: { taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] } },
        select: {
          id: true, title: true, dueAt: true, checklist: true, projectId: true,
          project: {
            select: {
              title: true, shotOrderNotes: true, removalNotes: true, videoInstructions: true,
              debriefSubmittedAt: true, shootDate: true,
              client: { select: { name: true } },
            },
          },
        },
        orderBy: { dueAt: "asc" },
        take: 30,
      }),
      prisma.smartTask.findMany({
        where: {
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          taskType: { in: ["comms_followup", "internal_instruction", "callback", "client_reply"] },
        },
        select: { id: true, title: true, summary: true, dueAt: true, projectId: true, assignedKey: true, taskType: true },
        orderBy: [{ dueAt: "asc" }],
        take: 40,
      }),
      prisma.project.findMany({
        where: { status: "REVISION" },
        select: { id: true, title: true, revisionRequestedAt: true, updatedAt: true },
        orderBy: { updatedAt: "asc" },
        take: 15,
      }),
      Promise.all([
        prisma.project.count({ where: { status: "EDITING" } }),
        prisma.project.count({ where: { status: "REVIEW" } }),
        prisma.project.count({ where: { status: "REVISION" } }),
        prisma.smartTask.count({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] }, dueAt: { lt: now } } }),
        prisma.smartTask.count({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] }, dueAt: { gte: today.start, lt: today.end } } }),
      ]),
      findUnansweredInbound(now).catch(() => []),
      prisma.smartTask.findMany({
        where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
        select: { assignedKey: true, taskType: true },
        take: 400,
      }),
    ]);

  const qc: OpsQcRow[] = qcTasks.map((t) => {
    let itemsLeft = 0;
    try {
      const items = t.checklist ? (JSON.parse(t.checklist) as { done?: boolean }[]) : [];
      itemsLeft = items.filter((i) => !i.done).length;
    } catch { itemsLeft = 0; }
    const pr = t.project;
    return {
      taskId: t.id,
      projectId: t.projectId!,
      title: (pr?.title ?? t.title).split(",")[0],
      clientName: pr?.client?.name ?? null,
      itemsLeft,
      dueISO: t.dueAt?.toISOString() ?? null,
      overdue: !!t.dueAt && t.dueAt < now,
      debrief: {
        shotOrder: pr?.shotOrderNotes ?? null,
        removals: pr?.removalNotes && pr.removalNotes !== "Nothing needs removal — confirmed by the photographer." ? pr.removalNotes : null,
        videoBrief: !!pr?.videoInstructions,
        unsubmitted: !!pr?.shootDate && pr.shootDate.getTime() >= DEBRIEF_GATE && pr.shootDate < now && !pr.debriefSubmittedAt,
      },
    };
  });

  const openLoops: OpsLoop[] = loopTasks.map((t) => ({
    taskId: t.id,
    title: t.title,
    summary: t.summary,
    dueISO: t.dueAt?.toISOString() ?? null,
    overdue: !!t.dueAt && t.dueAt < now,
    projectId: t.projectId,
  }));

  const todayShoots = todayProjects.map(shootRow);
  const tomorrowShoots = tomorrowProjects.map(shootRow);
  const [editing, review, revision, overdueTasks, dueTodayTasks] = pipelineCounts;

  const shotAlready = todayShoots.filter((s) => s.timeISO && new Date(s.timeISO) < now);
  const debriefsIn = shotAlready.filter((s) => s.debriefSubmitted).length;

  return {
    nowISO: now.toISOString(),
    todayShoots,
    tomorrowShoots,
    unanswered: {
      count: unansweredList.length,
      oldestHours: unansweredList.length
        ? Math.max(...unansweredList.map((u) => Math.round(u.ageMin / 60)))
        : null,
      preview: unansweredList.slice(0, 5).map((u) => ({
        name: u.clientName || "Unknown",
        snippet: (u.snippet ?? "").slice(0, 90),
        hours: Math.round(u.ageMin / 60),
      })),
    },
    qc,
    revisions: revisionProjects.map((r) => ({
      projectId: r.id,
      title: r.title.split(",")[0],
      ageDays: Math.floor((now.getTime() - (r.revisionRequestedAt ?? r.updatedAt).getTime()) / 86_400_000),
    })),
    pipeline: { editing, review, revision, overdueTasks, dueTodayTasks },
    openLoops,
    needsAssigning: assignQueue.filter((t) => isNeedsAssigning(t)).length,
    closeout: {
      todayShootsDone: shotAlready.length === todayShoots.length,
      todayDebriefsIn: debriefsIn,
      todayDebriefsMissing: shotAlready.length - debriefsIn,
      tomorrowGaps: tomorrowShoots.reduce((s, x) => s + x.gaps.length, 0),
      unanswered: unansweredList.length,
      openQc: qc.length,
      openRevisions: revision,
    },
  };
}
