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
