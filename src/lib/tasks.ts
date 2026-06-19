import "server-only";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { parseEvidence } from "@/lib/statusEvidence";

// ---------------------------------------------------------------------------
// Phase 1 of the listener-first platform: turnaround rules + due-date/priority
// engine + package-driven task generation from real Aryeo projects.
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// Turnaround targets in hours by deliverable type (admin-editable later).
const TURNAROUND_HOURS: Record<string, number> = {
  PHOTOS: 20, // next morning
  DRONE: 20,
  FLOORPLAN: 36,
  MATTERPORT_3D: 36,
  ZILLOW_3D: 36,
  TWILIGHT: 20,
  VIRTUAL_STAGING: 48,
  SOCIAL_REEL: 48,
  VIDEO: 48,
  HEADSHOT: 24,
  OTHER: 48,
};

export function deliveryDueFrom(anchor: Date, deliverableType?: string | null): Date {
  const h = (deliverableType && TURNAROUND_HOURS[deliverableType]) || 48;
  return new Date(anchor.getTime() + h * HOUR);
}

export type Priority = "URGENT" | "HIGH" | "MEDIUM" | "LOW";

// Derive priority from due date + shoot proximity + status.
export function computePriority(opts: {
  dueAt?: Date | null;
  shootDate?: Date | null;
  status?: string;
  now?: Date;
}): Priority {
  const now = opts.now ?? new Date();
  const startToday = new Date(now.toDateString()).getTime();
  if (opts.dueAt) {
    const diff = opts.dueAt.getTime() - now.getTime();
    if (diff < 0) return "URGENT"; // overdue
    if (diff < 4 * HOUR) return "URGENT";
    if (diff < DAY) return "HIGH";
  }
  if (opts.shootDate) {
    const days = Math.floor((opts.shootDate.getTime() - startToday) / DAY);
    if (days >= 0 && days <= 1) return "URGENT"; // shoot today/tomorrow
    if (days > 1 && days <= 3) return "HIGH"; // within 72h
  }
  return "MEDIUM";
}

function dedupe(parts: (string | null | undefined)[]): string {
  return crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 24);
}

type TaskSpec = {
  taskType: string;
  title: string;
  reasonCreated: string;
  checklist: string[];
  deliverableType?: string;
  dueAt?: Date | null;
};

// Decide the expected tasks for one project, based on its pipeline stage.
function specsForProject(p: {
  status: string;
  title: string;
  shootDate: Date | null;
  deliverables: { type: string }[];
  statusEvidence?: string | null;
}): TaskSpec[] {
  const specs: TaskSpec[] = [];
  const shoot = p.shootDate;
  const primary = p.deliverables[0]?.type ?? "PHOTOS";

  // Partial delivery: the smart-status engine found ordered media that isn't
  // live on Aryeo even though the order looked done. Make it an explicit,
  // urgent task naming exactly what's missing — this is the leak Kyle forgets.
  const ev = parseEvidence(p.statusEvidence);
  if (ev && ev.missing.length > 0 && (ev.partial || p.status === "REVIEW")) {
    specs.push({
      taskType: "finish_delivery",
      title: `Finish delivery — ${p.title} (missing ${ev.missing.join(", ")})`,
      reasonCreated: ev.partial
        ? "Aryeo marked the order fulfilled but the cross-check found missing deliverables"
        : "In review — ordered deliverables not all live on Aryeo yet",
      deliverableType: primary,
      dueAt: new Date(),
      checklist: [
        `Produce / locate the missing item(s): ${ev.missing.join(", ")}`,
        "Upload them to the Aryeo listing",
        "Verify all ordered deliverables are now live",
        "Confirm the order is correctly marked delivered",
      ],
    });
  }

  if (p.status === "BOOKED" || p.status === "SCHEDULED") {
    specs.push({
      taskType: "appointment_prep",
      title: `Confirmation call — ${p.title}`,
      reasonCreated: "Day-before confirmation call (SOP)",
      deliverableType: primary,
      dueAt: shoot ? new Date(shoot.getTime() - DAY) : null,
      checklist: [
        "Confirm date, time & exact services ordered",
        "Confirm access — agent/seller meeting us, or lockbox? Get the code",
        "Ask what features to highlight + anything to avoid",
        "Confirm listing go-live date (+ song/branding for video)",
        "Remind them of the property prep list",
        "Offer an upgrade — twilight, drone, staging, 3D, floor plan",
        "State the turnaround so expectations are set",
      ],
    });
  }

  if (p.status === "SHOT" || p.status === "EDITING" || p.status === "REVIEW") {
    const anchor = shoot ?? new Date();
    for (const d of dedupeTypes(p.deliverables)) {
      specs.push({
        taskType: "media_qa",
        title: `QA ${labelFor(d)} — ${p.title}`,
        reasonCreated: "Media in production, needs quality check",
        deliverableType: d,
        dueAt: deliveryDueFrom(anchor, d),
        checklist: [
          "Confirm correct property / order",
          "All expected deliverables present",
          "Verticals straight, exposure & color correct",
          "No glare, people, cars, trash, signs",
          "Client-specific notes honored",
        ],
      });
    }
    specs.push({
      taskType: "delivery",
      title: `Deliver gallery — ${p.title}`,
      reasonCreated: "Ready to deliver after QA",
      deliverableType: primary,
      dueAt: deliveryDueFrom(anchor, primary),
      checklist: ["Final QA pass", "Deliver via Aryeo + branded email", "Mark Delivered", "Schedule feedback request"],
    });
  }

  return specs;
}

function dedupeTypes(deliverables: { type: string }[]): string[] {
  return [...new Set(deliverables.map((d) => d.type))].slice(0, 4);
}
function labelFor(t: string) {
  return t.replace(/_/g, " ").toLowerCase();
}

// Create a "client reply / callback" task from an inbound communication, matched
// to a client (+ their latest project). One open reply task per client is kept
// (deduped) so a burst of texts doesn't spawn duplicates.
export async function createCommTask(opts: {
  clientId: string;
  clientName: string;
  projectId?: string | null;
  propertyAddress?: string | null;
  kind: "text" | "missed_call" | "voicemail";
  snippet?: string;
  source?: string;
}): Promise<boolean> {
  const key = dedupe([opts.clientId, "client_reply"]);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") return false;

  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const verb = opts.kind === "text" ? "Reply to" : "Call back";
  const reason =
    opts.kind === "text"
      ? "Inbound text from client (OpenPhone)"
      : opts.kind === "voicemail"
        ? "Voicemail from client (OpenPhone)"
        : "Missed call from client (OpenPhone)";
  // Replies due within a few hours; callbacks sooner.
  const dueAt = new Date(Date.now() + (opts.kind === "text" ? 4 : 1) * HOUR);

  const data = {
    taskType: "client_reply",
    title: `${verb} ${opts.clientName}`,
    description: opts.snippet ? opts.snippet.slice(0, 240) : null,
    reasonCreated: reason,
    checklist: JSON.stringify([
      "Read the full conversation in Communications",
      "Match to the right order if multiple",
      "Reply / call back",
      "Log outcome",
    ]),
    source: opts.source ?? "openphone",
    priority: "HIGH" as const,
    dueAt,
    clientId: opts.clientId,
    projectId: opts.projectId ?? null,
    propertyAddress: opts.propertyAddress ?? null,
    ownerId: kyle?.id ?? null,
    dedupeKey: key,
  };

  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
  } else {
    await prisma.smartTask.create({ data });
  }
  return true;
}

// Production tasks that become obsolete once a job is delivered/cancelled.
const PRODUCTION_TASK_TYPES = ["appointment_prep", "media_qa", "delivery", "finish_delivery"];

// Close out a project's now-obsolete open tasks when it reaches a terminal
// state, so Daily Tasks doesn't show ghost work on finished/cancelled jobs.
//   DELIVERED  → complete the production tasks (QA/deliver/prep/finish)
//   CANCELLED  → cancel every open task on the job
// Comm-driven tasks (client_reply / revision) are left alone — still actionable.
export async function closeObsoleteTasks(projectId: string, projectStatus: string): Promise<number> {
  if (projectStatus === "CANCELLED") {
    const r = await prisma.smartTask.updateMany({
      where: { projectId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "CANCELLED" },
    });
    return r.count;
  }
  if (projectStatus === "DELIVERED") {
    const r = await prisma.smartTask.updateMany({
      where: {
        projectId,
        taskType: { in: PRODUCTION_TASK_TYPES },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await createCareCallTask(projectId);
    return r.count;
  }
  return 0;
}

// When a job is delivered, queue Kyle's day-after care call (the SOP touchpoint
// that drives reviews + referrals). Deduped one per project.
export async function createCareCallTask(projectId: string): Promise<void> {
  const key = dedupe([projectId, "care_call"]);
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, clientId: true, deliveredAt: true },
  });
  if (!project) return;
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const base = project.deliveredAt ?? new Date();
  await prisma.smartTask.create({
    data: {
      taskType: "care_call",
      title: `Care call — ${project.title}`,
      reasonCreated: "Day-after-delivery care call (SOP)",
      checklist: JSON.stringify([
        "Confirm they can access the delivery link",
        "Satisfaction check + handle any edits",
        "Ask for a Google review (offer one back)",
        "Pitch the referral program ($100 credit each)",
        "Ask about their next listing",
        "Log the outcome on the client",
      ]),
      source: "system",
      priority: "HIGH",
      dueAt: new Date(base.getTime() + DAY),
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: key,
    },
  });
}

// Generate (idempotently) the expected tasks for every ACTIVE project.
export async function generateTasksForActiveProjects(): Promise<{ created: number; projects: number }> {
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const projects = await prisma.project.findMany({
    where: { status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW"] } },
    include: { deliverables: { select: { type: true } }, client: { select: { id: true } } },
  });

  let created = 0;
  for (const p of projects) {
    const specs = specsForProject({
      status: p.status,
      title: p.title,
      shootDate: p.shootDate,
      deliverables: p.deliverables,
      statusEvidence: p.statusEvidence,
    });
    for (const s of specs) {
      const key = dedupe([p.id, s.taskType, s.deliverableType]);
      const exists = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
      if (exists) continue;
      const priority = computePriority({ dueAt: s.dueAt, shootDate: p.shootDate, status: p.status });
      await prisma.smartTask.create({
        data: {
          taskType: s.taskType,
          title: s.title,
          reasonCreated: s.reasonCreated,
          checklist: JSON.stringify(s.checklist),
          source: "aryeo",
          priority,
          dueAt: s.dueAt ?? null,
          deliverableType: s.deliverableType ?? null,
          projectId: p.id,
          clientId: p.client.id,
          propertyAddress: p.title,
          ownerId: kyle?.id ?? null,
          dedupeKey: key,
        },
      });
      created++;
    }
  }
  return { created, projects: projects.length };
}
