import "server-only";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { parseEvidence } from "@/lib/statusEvidence";
import { type ChecklistItem, parseChecklist, serializeChecklist, checklistComplete } from "@/lib/checklist";

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

// Reel/video turnaround tiers (a reel is just a vertical social video):
//   • Standard reel/video  → 1-2 days (48h)
//   • Premium reel/video   → 3 days (72h)   [label starts with "Premium"]
//   • Monthly content      → 7-10 BUSINESS days  [recurring social-plan client]
// PRECEDENCE: premium wins over monthly. A premium LISTING reel (e.g. a premium
// reel ordered with a property shoot) is a one-off premium deliverable, NOT
// recurring monthly content — so it keeps the 3-day premium SLA even when the
// client is on a social plan. Only NON-premium reels for a social client use the
// monthly window. Premium-ness rides on the deliverable LABEL ("Premium Reel"/
// "Premium Video"), set from the product map.
const REEL_VIDEO_TYPES = new Set(["SOCIAL_REEL", "VIDEO"]);
const PREMIUM_HOURS = 72;
const STANDARD_REEL_HOURS = 48;

// Add N business days (skip Sat/Sun) to a date.
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}

type DueOpts = { monthlyContent?: boolean; premium?: boolean };

// Turnaround due for one deliverable from an anchor date.
export function deliveryDueFrom(anchor: Date, deliverableType?: string | null, opts: DueOpts = {}): Date {
  if (deliverableType && REEL_VIDEO_TYPES.has(deliverableType)) {
    if (opts.premium) return new Date(anchor.getTime() + PREMIUM_HOURS * HOUR); // premium wins over monthly
    if (opts.monthlyContent) return addBusinessDays(anchor, 10); // 7-10 business days
    return new Date(anchor.getTime() + STANDARD_REEL_HOURS * HOUR);
  }
  const h = (deliverableType && TURNAROUND_HOURS[deliverableType]) || 48;
  return new Date(anchor.getTime() + h * HOUR);
}

const isPremiumLabel = (label?: string | null) => !!label && /premium/i.test(label);

// A project's overall delivery due = shoot date + the LONGEST turnaround among
// its ordered deliverables (premium reel/video pushes it out, monthly further).
export function standardDeliveryDue(
  shootDate: Date,
  deliverables: { type: string; label?: string | null }[],
  monthlyContent = false,
): Date {
  if (deliverables.length === 0) return new Date(shootDate.getTime() + 48 * HOUR);
  return deliverables
    .map((d) => deliveryDueFrom(shootDate, d.type, { monthlyContent, premium: isPremiumLabel(d.label) }))
    .reduce((a, b) => (a > b ? a : b));
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
  checklist: ChecklistItem[];
  deliverableType?: string;
  dueAt?: Date | null;
  description?: string; // pre-drafted message (e.g. the confirmation text)
};

// Friendly per-deliverable label for the consolidated QC checklist.
const QC_LABEL: Record<string, string> = {
  PHOTOS: "Photos", DRONE: "Drone / aerial", TWILIGHT: "Twilight", HEADSHOT: "Headshots",
  VIRTUAL_STAGING: "Virtual staging", VIDEO: "Video", SOCIAL_REEL: "Reel",
  FLOORPLAN: "Floor plan", MATTERPORT_3D: "Matterport 3D", ZILLOW_3D: "Zillow 3D tour", OTHER: "Other",
};
const guide = (steps: string[]): ChecklistItem[] => steps.map((label) => ({ label, done: false }));

// Media category label for a deliverable type — mirrors CATEGORY_LABEL in
// projectStatus.ts (kept here to avoid a circular import). Lets us tell, from a
// project's status evidence (which lists present/missing by category label),
// whether a given ordered deliverable is already live on Aryeo.
const TYPE_CATEGORY_LABEL: Record<string, string> = {
  PHOTOS: "Photos", DRONE: "Photos", TWILIGHT: "Photos", HEADSHOT: "Photos", VIRTUAL_STAGING: "Photos",
  VIDEO: "Video", SOCIAL_REEL: "Video",
  FLOORPLAN: "Floor plan",
  MATTERPORT_3D: "3D tour", ZILLOW_3D: "3D tour",
};

// Decide the expected tasks for one project, based on its pipeline stage.
function specsForProject(p: {
  status: string;
  title: string;
  shootDate: Date | null;
  deliverables: { type: string; label?: string | null }[];
  statusEvidence?: string | null;
  monthlyContent?: boolean;
}): TaskSpec[] {
  const specs: TaskSpec[] = [];
  const shoot = p.shootDate;
  const primary = p.deliverables[0]?.type ?? "PHOTOS";
  const monthly = !!p.monthlyContent;
  // Which deliverable types are premium (3-4 day reel/video) on this project.
  const premiumTypes = new Set(p.deliverables.filter((d) => isPremiumLabel(d.label)).map((d) => d.type));
  const dueOpts = (type: string) => ({ monthlyContent: monthly, premium: premiumTypes.has(type) });

  // What's already live on Aryeo (from the status cross-check). Used to retire
  // QA / "deliver gallery" work for a category the moment it's delivered — even
  // while the rest of the order (e.g. a reel) is still in production. Staged
  // delivery: photos go out next-day, the reel days later.
  const ev = parseEvidence(p.statusEvidence);
  const presentLabels = new Set(ev?.present ?? []);
  const isDelivered = (type: string) => {
    const lbl = TYPE_CATEGORY_LABEL[type];
    return !!lbl && presentLabels.has(lbl);
  };
  const galleryDelivered = presentLabels.has("Photos");

  // NOTE: there's no separate "finish delivery" leak task. Each still-pending
  // deliverable already gets its own per-item QA task below (due at that item's
  // turnaround, auto-closing when it goes live), and the project page's Status
  // card surfaces any partial / missing items — so a standalone catch-all task
  // was just duplicate, often-stale noise (e.g. "missing Video" on a reel that
  // was actually on track). Removed in favor of the per-deliverable tasks.

  if (p.status === "BOOKED" || p.status === "SCHEDULED") {
    specs.push({
      taskType: "confirmation_text",
      title: `Confirmation text — ${p.title}`,
      reasonCreated: "Day-before confirmation text (SOP)",
      deliverableType: primary,
      dueAt: shoot ? new Date(shoot.getTime() - DAY) : null,
      // description (the drafted text) is filled in at creation time, where the
      // client name + shoot time + photographer are available.
      checklist: guide([
        "Review the drafted confirmation text below",
        "Send it to the client via OpenPhone",
        "Confirm access — someone meeting us, or a lockbox? Get the code",
        "Note what to highlight / avoid + that the property will be ready",
        "Offer an upgrade if it fits — twilight, drone, staging, 3D, floor plan",
      ]),
    });
  }

  if (p.status === "SHOT" || p.status === "EDITING" || p.status === "REVIEW") {
    const anchor = shoot ?? new Date();
    // ONE consolidated QC task per project: a checkbox per deliverable category,
    // pre-checked for anything already live on Aryeo. Replaces the old per-item
    // "QA <type>" tasks. Due at the SOONEST pending item's turnaround. Only the
    // pending (unchecked) items are work; if everything's live we skip it (and
    // the reconciler closes any existing one).
    const qcTypes = dedupeTypes(p.deliverables);
    const qcItems: ChecklistItem[] = qcTypes.map((d) => ({ label: `QC ${QC_LABEL[d] ?? labelFor(d)}`, done: isDelivered(d) }));
    const pendingDues = qcTypes.filter((d) => !isDelivered(d)).map((d) => deliveryDueFrom(anchor, d, dueOpts(d)).getTime());
    if (qcItems.length > 0 && qcItems.some((i) => !i.done)) {
      specs.push({
        taskType: "media_qa",
        title: `QC — ${p.title}`,
        reasonCreated: "Media in production — quality-check each deliverable",
        dueAt: pendingDues.length ? new Date(Math.min(...pendingDues)) : null,
        checklist: qcItems,
      });
    }
    // The "deliver gallery" step is done once the photos are live (staged
    // delivery sends photos first); don't keep nagging while the reel renders.
    if (!galleryDelivered) {
      specs.push({
        taskType: "delivery",
        title: `Deliver gallery — ${p.title}`,
        reasonCreated: "Ready to deliver after QC",
        deliverableType: primary,
        dueAt: deliveryDueFrom(anchor, primary, dueOpts(primary)),
        checklist: guide(["Final QC pass", "Deliver via Aryeo + branded email", "Mark Delivered", "Schedule feedback request"]),
      });
    }
  }

  return specs;
}

function dedupeTypes(deliverables: { type: string }[]): string[] {
  // Drone aerial photos are part of the photo set — QA them together, so a job
  // with photos + drone gets ONE "QA photos" task, not separate drone/photo QAs.
  const norm = (t: string) => (t === "DRONE" ? "PHOTOS" : t);
  return [...new Set(deliverables.map((d) => norm(d.type)))].slice(0, 4);
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
  // AI-derived, specific action ("Reschedule 320 Tarbert to Thursday").
  aiTitle?: string | null;
  aiDetail?: string | null;
  // Provenance ref (e.g. "gmail-thread:hello@…:<threadId>") so the listener can
  // auto-close the task once we've replied in that thread.
  threadRef?: string | null;
}): Promise<boolean> {
  const key = dedupe([opts.clientId, "client_reply"]);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") return false;

  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const verb = opts.kind === "text" ? "Reply to" : "Call back";
  const sourceName =
    opts.source === "gmail" ? "Gmail" : opts.source === "slack" ? "Slack" : "OpenPhone";
  const reason =
    opts.kind === "text"
      ? `Inbound message from client (${sourceName})`
      : opts.kind === "voicemail"
        ? "Voicemail from client (OpenPhone)"
        : "Missed call from client (OpenPhone)";
  // Replies due within a few hours; callbacks sooner.
  const dueAt = new Date(Date.now() + (opts.kind === "text" ? 4 : 1) * HOUR);

  const title = opts.aiTitle ? `${opts.aiTitle} (${opts.clientName})` : `${verb} ${opts.clientName}`;
  const description = [opts.aiDetail, opts.snippet?.slice(0, 280)].filter(Boolean).join("\n\n") || null;

  const data = {
    taskType: "client_reply",
    title: title.slice(0, 120),
    description,
    reasonCreated: reason,
    checklist: JSON.stringify([
      "Read the full conversation in Communications",
      "Match to the right order if multiple",
      "Reply / call back",
      "Log outcome",
    ]),
    source: opts.source ?? "openphone",
    sourceDetail: opts.threadRef ?? null,
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

// File an instruction/follow-up task on a SPECIFIC project from an inbound text
// that named that property — even when the sender isn't the project's client
// (a photographer like Harrison, or a coordinator like Ruthie). Deduped to one
// open task per (project, sender) so a back-and-forth refreshes instead of piling up.
export async function createProjectFollowupTask(opts: {
  projectId: string;
  clientId?: string | null;
  propertyAddress?: string | null;
  senderName: string;
  text: string;
  source?: string;
  aiTitle?: string | null;
  aiDetail?: string | null;
}): Promise<boolean> {
  const key = dedupe([opts.projectId, "comms_followup", opts.senderName]);
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const street = (opts.propertyAddress ?? "this job").split(",")[0];
  const title = (opts.aiTitle || `${opts.senderName} re ${street}`).slice(0, 120);
  const description = [opts.aiDetail, opts.text.slice(0, 300)].filter(Boolean).join("\n\n") || null;
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  const data = {
    taskType: "comms_followup",
    title,
    description,
    reasonCreated: `${opts.senderName} texted about this job (${opts.source ?? "openphone"})`,
    checklist: JSON.stringify([
      "Read the full message in Communications",
      "Action the request on this job",
      "Reply / confirm with the sender",
      "Log the outcome",
    ]),
    source: opts.source ?? "openphone",
    priority: "HIGH" as const,
    dueAt: new Date(Date.now() + 4 * HOUR),
    clientId: opts.clientId ?? null,
    projectId: opts.projectId,
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

// Close a client's open "reply" task — call this once we've responded (an
// outbound OpenPhone text, an answered Gmail thread, etc.). Returns true if a
// task was closed. There's at most one open client_reply per client (dedupeKey).
export async function closeClientReplyTask(clientId: string): Promise<boolean> {
  const r = await prisma.smartTask.updateMany({
    where: { clientId, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  return r.count > 0;
}

// When a deliverable goes back into revision (e.g. Luma "Revision Request
// Received" on a reel), reflect it in the project's QC task: reopen it and mark
// the revised deliverable's checkbox as needing a re-QC (unchecked). Creates the
// QC task if the job had already been delivered + its QC completed.
// `categories` = QC labels like ["Reel"] / ["Photos"]; empty = generic re-QC.
export async function reflectRevisionInQc(projectId: string, categories: string[]): Promise<void> {
  const existing = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "media_qa" },
    orderBy: { createdAt: "desc" },
  });

  const markRevised = (items: ChecklistItem[]): ChecklistItem[] => {
    const out = [...items];
    if (categories.length === 0) {
      if (!out.some((i) => /re-?qc after revision/i.test(i.label))) out.push({ label: "Re-QC after revision", done: false });
      return out;
    }
    for (const c of categories) {
      const idx = out.findIndex((i) => i.label.toLowerCase().includes(c.toLowerCase()));
      if (idx >= 0) out[idx] = { label: out[idx].label.includes("(revision)") ? out[idx].label : `${out[idx].label} (revision)`, done: false };
      else out.push({ label: `QC ${c} (revision)`, done: false });
    }
    return out;
  };

  if (existing) {
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: {
        status: "OPEN",
        completedAt: null,
        priority: "HIGH",
        dueAt: new Date(),
        checklist: serializeChecklist(markRevised(parseChecklist(existing.checklist))),
      },
    });
    return;
  }

  // No QC task (job was delivered + QC closed) → make one for the re-QC.
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, clientId: true } });
  if (!project) return;
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "media_qa",
      title: `QC — ${project.title}`,
      reasonCreated: "Deliverable back in revision — re-QC the new version",
      checklist: serializeChecklist(markRevised([])),
      source: "revision",
      priority: "HIGH",
      dueAt: new Date(),
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: dedupe([projectId, "media_qa"]),
    },
  });
}

// Production tasks that become obsolete once a job is delivered/cancelled.
const PRODUCTION_TASK_TYPES = ["confirmation_text", "appointment_prep", "media_qa", "delivery", "finish_delivery"];

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
    await createDeliveryTextTask(projectId);
    return r.count;
  }
  return 0;
}

// When a job is delivered, queue Kyle's post-delivery client TEXT (we dropped
// care calls — no one answers). The drafted, status-aware message + feedback
// link is attached so Kyle just reviews and sends. Deduped one per project.
export async function createDeliveryTextTask(projectId: string): Promise<void> {
  const key = dedupe([projectId, "delivery_text"]);
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key } })) return;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, clientId: true, statusEvidence: true, client: { select: { name: true } } },
  });
  if (!project) return;
  const { deliveryMessage } = await import("@/lib/delivery");
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "delivery_text",
      title: `Send delivery text — ${project.title}`,
      description: deliveryMessage(project),
      reasonCreated: "Delivered — send the post-delivery client text + feedback link",
      checklist: JSON.stringify([
        "Review the drafted message below",
        "Send it to the client via OpenPhone",
        "Watch for a feedback reply (auto-logs to the project)",
      ]),
      source: "system",
      priority: "MEDIUM",
      dueAt: new Date(),
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
  const { confirmationMessage } = await import("@/lib/delivery");
  // Retire legacy PER-DELIVERABLE "QA <type>" tasks (they had a deliverableType).
  // They're replaced by ONE consolidated QC task per project (deliverableType
  // null) with a checkbox per deliverable.
  await prisma.smartTask.updateMany({
    where: { taskType: "media_qa", deliverableType: { not: null }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED" },
  });
  // Retire legacy "Confirmation call" tasks — we send a confirmation TEXT now
  // (the confirmation_text task below carries the drafted message + send button).
  await prisma.smartTask.updateMany({
    where: { taskType: "appointment_prep", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED" },
  });
  const projects = await prisma.project.findMany({
    where: { status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW"] } },
    include: {
      deliverables: { select: { type: true, label: true } },
      client: { select: { id: true, name: true, socialClient: true } },
      photographer: { select: { name: true } },
    },
  });

  let created = 0;
  for (const p of projects) {
    const specs = specsForProject({
      status: p.status,
      title: p.title,
      shootDate: p.shootDate,
      deliverables: p.deliverables,
      statusEvidence: p.statusEvidence,
      monthlyContent: p.client.socialClient,
    });
    // Reconcile: close any open production task that's no longer expected. This
    // retires "QA photos" / "Deliver gallery" once the photos are live (even
    // while a reel is still rendering), and clears a stale "finish delivery"
    // when its missing items showed up or fell back inside their window.
    const expectedKeys = new Set(specs.map((s) => dedupe([p.id, s.taskType, s.deliverableType])));
    await prisma.smartTask.updateMany({
      where: {
        projectId: p.id,
        taskType: { in: ["media_qa", "delivery", "finish_delivery"] },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        NOT: { dedupeKey: { in: [...expectedKeys] } },
      },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    for (const s of specs) {
      const key = dedupe([p.id, s.taskType, s.deliverableType]);
      const exists = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
      if (exists) {
        if (exists.status === "COMPLETED" || exists.status === "CANCELLED") continue;
        // For the consolidated QC task, re-sync its checklist each run: an item
        // is checked if it's live on Aryeo OR Kyle already ticked it manually
        // (manual checks are preserved). If every item ends up checked, the task
        // auto-completes. Also keep the due date fresh.
        if (s.taskType === "media_qa") {
          const prev = parseChecklist(exists.checklist);
          const prevDone = new Map(prev.map((i) => [i.label, i.done]));
          const merged: ChecklistItem[] = s.checklist.map((i) => ({ label: i.label, done: i.done || (prevDone.get(i.label) ?? false) }));
          const allDone = checklistComplete(merged);
          await prisma.smartTask.update({
            where: { id: exists.id },
            data: {
              checklist: serializeChecklist(merged),
              ...(s.dueAt ? { dueAt: s.dueAt, priority: computePriority({ dueAt: s.dueAt, shootDate: p.shootDate, status: p.status }) } : {}),
              ...(allDone ? { status: "COMPLETED", completedAt: new Date() } : {}),
            },
          });
          continue;
        }
        // Keep delivery due dates fresh when turnaround rules change.
        if (s.taskType === "delivery" && s.dueAt && exists.dueAt?.getTime() !== s.dueAt.getTime()) {
          await prisma.smartTask.update({
            where: { id: exists.id },
            data: { dueAt: s.dueAt, priority: computePriority({ dueAt: s.dueAt, shootDate: p.shootDate, status: p.status }) },
          });
        }
        continue;
      }
      const priority = computePriority({ dueAt: s.dueAt, shootDate: p.shootDate, status: p.status });
      // Pre-draft the confirmation text so Kyle just reviews + sends.
      const description =
        s.taskType === "confirmation_text"
          ? confirmationMessage({ title: p.title, shootDate: p.shootDate, client: { name: p.client.name ?? "" }, photographer: p.photographer, deliverables: p.deliverables })
          : s.description ?? null;
      await prisma.smartTask.create({
        data: {
          taskType: s.taskType,
          title: s.title,
          description,
          reasonCreated: s.reasonCreated,
          checklist: serializeChecklist(s.checklist),
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
