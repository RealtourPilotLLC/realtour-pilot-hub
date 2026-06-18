import "server-only";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

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
}): TaskSpec[] {
  const specs: TaskSpec[] = [];
  const shoot = p.shootDate;
  const primary = p.deliverables[0]?.type ?? "PHOTOS";

  if (p.status === "BOOKED" || p.status === "SCHEDULED") {
    specs.push({
      taskType: "appointment_prep",
      title: `Prep shoot — ${p.title}`,
      reasonCreated: "Upcoming Aryeo appointment",
      deliverableType: primary,
      dueAt: shoot ? new Date(shoot.getTime() - DAY) : null,
      checklist: [
        "Confirm address, gate/lockbox code, parking",
        "Confirm photographer assignment",
        "Confirm ordered deliverables & special requests",
        "Send appointment reminder if needed",
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
