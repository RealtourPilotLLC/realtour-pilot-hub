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
    },
  });

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
