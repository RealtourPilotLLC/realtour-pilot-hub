"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import {
  ProjectStatus,
  Priority,
  ActivityType,
  DeliverableStatus,
} from "@prisma/client";
import { stageMeta } from "@/lib/pipeline";
import { Aryeo } from "@/lib/integrations/aryeo";
import { getSecret } from "@/lib/integrations/connections";
import { resolveRevision } from "@/lib/comms";
import { closeObsoleteTasks } from "@/lib/tasks";

export type ApptResult = { ok: boolean; message: string };

// Refresh one appointment from Aryeo into our DB (after a write).
async function refreshAppointment(aryeoId: string, projectId: string) {
  try {
    const a = await Aryeo.appointment(aryeoId);
    await prisma.appointment.update({
      where: { aryeoId },
      data: {
        startAt: a.start_at ? new Date(a.start_at) : null,
        endAt: a.end_at ? new Date(a.end_at) : null,
        status: a.status ?? null,
        canCancel: a.can_cancel ?? false,
        canReschedule: a.can_reschedule ?? false,
        rescheduledAt: a.rescheduled_at ? new Date(a.rescheduled_at) : null,
        previousStartAt: a.previous_start_at ? new Date(a.previous_start_at) : null,
        rawJson: JSON.stringify(a),
      },
    });
    // Keep the project's shoot date / status in sync with a scheduled appt.
    if ((a.status || "").toUpperCase() === "SCHEDULED" && a.start_at) {
      await prisma.project.update({ where: { id: projectId }, data: { shootDate: new Date(a.start_at) } });
    }
  } catch {
    /* best-effort */
  }
}

/** Reschedule an appointment in Aryeo, then refresh locally. */
export async function rescheduleAppointmentAction(
  appointmentId: string,
  startAtISO: string,
  notifyCustomer: boolean,
): Promise<ApptResult> {
  if (!(await getSecret("aryeo"))) return { ok: false, message: "Aryeo is not connected." };
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) return { ok: false, message: "Appointment not found." };
  if (!appt.canReschedule) return { ok: false, message: "Aryeo says this appointment can't be rescheduled." };

  const start = new Date(startAtISO);
  if (isNaN(start.getTime())) return { ok: false, message: "Invalid date/time." };
  const end = new Date(start.getTime() + (appt.durationMin ?? 60) * 60000);

  try {
    await Aryeo.rescheduleAppointment(appt.aryeoId, {
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      notify_customer: notifyCustomer,
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Reschedule failed." };
  }

  await refreshAppointment(appt.aryeoId, appt.projectId);
  await prisma.activity.create({
    data: {
      projectId: appt.projectId,
      type: ActivityType.SYSTEM,
      body: `Appointment rescheduled to ${start.toLocaleString()}${notifyCustomer ? " (customer notified)" : ""}.`,
    },
  });
  revalidatePath(`/projects/${appt.projectId}`);
  revalidatePath("/schedule");
  revalidatePath("/pipeline");
  return { ok: true, message: "Appointment rescheduled." };
}

/** Cancel an appointment in Aryeo, then refresh locally. */
export async function cancelAppointmentAction(
  appointmentId: string,
  notifyCustomer: boolean,
): Promise<ApptResult> {
  if (!(await getSecret("aryeo"))) return { ok: false, message: "Aryeo is not connected." };
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) return { ok: false, message: "Appointment not found." };
  if (!appt.canCancel) return { ok: false, message: "Aryeo says this appointment can't be cancelled." };

  try {
    await Aryeo.cancelAppointment(appt.aryeoId, { notify_customer: notifyCustomer });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Cancel failed." };
  }

  await refreshAppointment(appt.aryeoId, appt.projectId);
  await prisma.activity.create({
    data: {
      projectId: appt.projectId,
      type: ActivityType.FLAG,
      body: `Appointment cancelled${notifyCustomer ? " (customer notified)" : ""}.`,
    },
  });
  revalidatePath(`/projects/${appt.projectId}`);
  revalidatePath("/schedule");
  revalidatePath("/pipeline");
  return { ok: true, message: "Appointment cancelled." };
}

/** Update a SmartTask's status (and stamp completion). */
export async function setSmartTaskStatus(taskId: string, status: string) {
  const t = await prisma.smartTask.update({
    where: { id: taskId },
    data: { status, completedAt: status === "COMPLETED" ? new Date() : null },
    select: { projectId: true },
  });
  revalidatePath("/queue");
  revalidatePath("/history");
  if (t.projectId) revalidatePath(`/projects/${t.projectId}`);
}

/**
 * Toggle one checklist item on a task. Low-friction completion: when every item
 * is checked the task auto-completes; unchecking an item on a completed task
 * reopens it. Returns the new checklist + whether the task is now complete.
 */
export async function toggleTaskChecklistItem(
  taskId: string,
  index: number,
): Promise<{ ok: boolean; items: { label: string; done: boolean }[]; completed: boolean }> {
  const { parseChecklist, serializeChecklist, checklistComplete } = await import("@/lib/checklist");
  const t = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { checklist: true, status: true, projectId: true } });
  if (!t) return { ok: false, items: [], completed: false };
  const items = parseChecklist(t.checklist);
  if (index < 0 || index >= items.length) return { ok: false, items, completed: false };
  items[index] = { ...items[index], done: !items[index].done };
  const completed = checklistComplete(items);
  await prisma.smartTask.update({
    where: { id: taskId },
    data: {
      checklist: serializeChecklist(items),
      // All boxes ticked → done. If they uncheck one on a completed task, reopen.
      ...(completed
        ? { status: "COMPLETED", completedAt: new Date() }
        : t.status === "COMPLETED"
          ? { status: "OPEN", completedAt: null }
          : {}),
    },
  });
  revalidatePath("/queue");
  revalidatePath("/history");
  if (t.projectId) revalidatePath(`/projects/${t.projectId}`);
  return { ok: true, items, completed };
}

/** Assign (or clear) a team member for a role on a project. */
export async function assignMember(
  projectId: string,
  role: "photographer" | "editor" | "va",
  memberId: string | null,
) {
  const field = role === "photographer" ? "photographerId" : role === "editor" ? "editorId" : "vaId";
  const member = memberId ? await prisma.teamMember.findUnique({ where: { id: memberId } }) : null;
  await prisma.project.update({ where: { id: projectId }, data: { [field]: memberId } });
  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.ASSIGNMENT,
      body: member ? `${role[0].toUpperCase() + role.slice(1)} set to ${member.name}.` : `${role} unassigned.`,
    },
  });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/schedule");
}

/** Move a project to a new pipeline stage and log it on the timeline. */
export async function moveProjectStatus(projectId: string, status: ProjectStatus) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.status === status) return;

  await prisma.project.update({
    where: { id: projectId },
    data: {
      status,
      deliveredAt:
        status === ProjectStatus.DELIVERED ? new Date() : project.deliveredAt,
      // Moving a job to Delivered clears any open revision request.
      ...(status === ProjectStatus.DELIVERED
        ? { revisionRequestedAt: null, revisionNote: null }
        : {}),
    },
  });

  // Close out the revision task too when manually delivered.
  if (status === ProjectStatus.DELIVERED && project.revisionRequestedAt) {
    await prisma.smartTask.updateMany({
      where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  }

  // Clear obsolete production tasks when a job is delivered or cancelled.
  if (status === ProjectStatus.DELIVERED || status === ProjectStatus.CANCELLED) {
    await closeObsoleteTasks(projectId, status);
  }

  await prisma.activity.create({
    data: {
      projectId,
      type: ActivityType.STATUS_CHANGE,
      body: `Moved from ${stageMeta(project.status).label} to ${stageMeta(status).label}.`,
    },
  });

  revalidatePath("/pipeline");
  revalidatePath("/");
  revalidatePath(`/projects/${projectId}`);
}

// Draft a client reply in Jordan's voice for a comm task. DRAFT ONLY — returns
// the suggested text for a human to review and send; the hub never sends.
export async function draftTaskReply(
  taskId: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) {
    return { ok: false, error: "Connect the AI Assistant in Connections first." };
  }
  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    include: { client: { select: { name: true } } },
  });
  if (!task) return { ok: false, error: "Task not found." };
  try {
    const { draftReply } = await import("@/lib/integrations/ai");
    const text = await draftReply({
      channel: task.source === "gmail" ? "email" : "text",
      clientName: task.client?.name ?? null,
      propertyAddress: task.propertyAddress,
      message: task.description || task.title,
      note: task.reasonCreated,
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Draft failed." };
  }
}

// Send the smart delivery text (what was delivered + what's still in production)
// to the client via OpenPhone. Human-initiated from a delivery_text to-do.
export async function sendDeliveryText(taskId: string): Promise<{ ok: boolean; message: string }> {
  const task = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { projectId: true } });
  if (!task?.projectId) return { ok: false, message: "No project linked to this task." };
  const project = await prisma.project.findUnique({
    where: { id: task.projectId },
    select: { id: true, title: true, statusEvidence: true, client: { select: { name: true, phone: true } } },
  });
  if (!project) return { ok: false, message: "Project not found." };
  if (!project.client.phone) return { ok: false, message: "No phone number on file for this client." };

  const { phoneKey, OpenPhone, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const k = phoneKey(project.client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  const { deliveryMessage } = await import("@/lib/delivery");
  const body = deliveryMessage(project);
  try {
    await OpenPhone.sendMessage(from, `+1${k}`, body);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send." };
  }
  await prisma.activity.create({
    data: { projectId: project.id, type: "SYSTEM", body: `Delivery text sent to ${project.client.name}: ${body.slice(0, 160)}` },
  });
  await prisma.smartTask.update({ where: { id: taskId }, data: { status: "COMPLETED", completedAt: new Date() } });
  revalidatePath("/");
  revalidatePath("/queue");
  return { ok: true, message: "Delivery text sent." };
}

// Send the day-before confirmation text to the client via OpenPhone.
// Human-initiated from a confirmation_text to-do. Sends the freshly-rendered
// message (so the shoot time/photographer are current), logs it, and completes
// the task.
export async function sendConfirmationText(taskId: string): Promise<{ ok: boolean; message: string }> {
  const task = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { projectId: true } });
  if (!task?.projectId) return { ok: false, message: "No project linked to this task." };
  const project = await prisma.project.findUnique({
    where: { id: task.projectId },
    select: {
      id: true, title: true, shootDate: true,
      client: { select: { name: true, phone: true } },
      photographer: { select: { name: true } },
      deliverables: { select: { type: true } },
    },
  });
  if (!project) return { ok: false, message: "Project not found." };
  if (!project.client.phone) return { ok: false, message: "No phone number on file for this client." };

  const { phoneKey, OpenPhone, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const k = phoneKey(project.client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  const { confirmationMessage } = await import("@/lib/delivery");
  const body = confirmationMessage({
    title: project.title,
    shootDate: project.shootDate,
    client: { name: project.client.name },
    photographer: project.photographer,
    deliverables: project.deliverables,
  });
  try {
    await OpenPhone.sendMessage(from, `+1${k}`, body);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send." };
  }
  await prisma.activity.create({
    data: { projectId: project.id, type: "SYSTEM", body: `Confirmation text sent to ${project.client.name}: ${body.slice(0, 160)}` },
  });
  await prisma.smartTask.update({ where: { id: taskId }, data: { status: "COMPLETED", completedAt: new Date() } });
  revalidatePath("/");
  revalidatePath("/queue");
  return { ok: true, message: "Confirmation text sent." };
}

// Mark a revision request resolved (handled or dismissed as a false alarm).
export async function resolveRevisionAction(projectId: string) {
  await resolveRevision(projectId);
  revalidatePath("/pipeline");
  revalidatePath("/queue");
  revalidatePath("/");
  revalidatePath(`/projects/${projectId}`);
}

export async function toggleChecklistItem(itemId: string, done: boolean) {
  const item = await prisma.checklistItem.update({
    where: { id: itemId },
    data: { done },
  });
  revalidatePath(`/projects/${item.projectId}`);
  revalidatePath("/pipeline");
}

export async function addNote(
  projectId: string,
  body: string,
  type: ActivityType = ActivityType.NOTE,
) {
  const trimmed = body.trim();
  if (!trimmed) return;
  await prisma.activity.create({
    data: { projectId, body: trimmed, type },
  });
  revalidatePath(`/projects/${projectId}`);
}

export async function setProjectPriority(projectId: string, priority: Priority) {
  await prisma.project.update({ where: { id: projectId }, data: { priority } });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
  revalidatePath("/");
}

export async function assignTeamMember(
  projectId: string,
  field: "photographerId" | "editorId" | "vaId",
  memberId: string | null,
) {
  await prisma.project.update({
    where: { id: projectId },
    data: { [field]: memberId },
  });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/pipeline");
}

export async function setDeliverableStatus(
  deliverableId: string,
  status: DeliverableStatus,
) {
  const d = await prisma.deliverable.update({
    where: { id: deliverableId },
    data: { status },
  });
  revalidatePath(`/projects/${d.projectId}`);
}
