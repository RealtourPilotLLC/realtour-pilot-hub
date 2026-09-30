import "server-only";

import { prisma } from "@/lib/prisma";

export type DeliveryNoticeIncident = {
  outboxId: string;
  projectId: string;
  street: string;
  state: "pending" | "attempting" | "failed" | "unknown";
  queuedAtISO: string;
  taskId: string | null;
};

/** Job-level delivery text state from the existing outbox. A failed row has
 * released its dedupe key, so its delivery_text task is the only reliable way
 * to distinguish it from another kind of failed message on this project.
 * An accepted newer attempt supersedes an older failure. An unknown row keeps
 * its key and must be reconciled in OpenPhone before anyone sends again. */
export async function deliveryNoticeIncidents(projectId?: string): Promise<DeliveryNoticeIncident[]> {
  const messages = await prisma.outboxMessage.findMany({
    where: {
      ...(projectId ? { projectId } : { projectId: { not: null } }),
      state: { in: ["pending", "attempting", "failed", "unknown", "accepted"] },
      OR: [{ dedupeKey: { startsWith: "delivery:" } }, { state: "failed", taskId: { not: null } }],
    },
    select: { id: true, projectId: true, taskId: true, dedupeKey: true, state: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const taskIds = [...new Set(messages.filter((m) => m.state === "failed" && !m.dedupeKey).map((m) => m.taskId).filter((id): id is string => !!id))];
  const tasks = taskIds.length ? await prisma.smartTask.findMany({ where: { id: { in: taskIds }, taskType: "delivery_text" }, select: { id: true, status: true } }) : [];
  const taskOf = new Map(tasks.map((t) => [t.id, t]));
  const latest = new Map<string, (typeof messages)[number]>();
  for (const m of messages) {
    if (!m.projectId || latest.has(m.projectId)) continue;
    if (m.state === "failed" && !m.dedupeKey && (!m.taskId || !taskOf.has(m.taskId))) continue;
    latest.set(m.projectId, m);
  }
  const active = [...latest.values()].filter((m) => m.state !== "accepted" && (m.state !== "failed" || !m.taskId || !["COMPLETED", "CANCELLED"].includes(taskOf.get(m.taskId)?.status ?? "")));
  if (!active.length) return [];
  const projects = await prisma.project.findMany({ where: { id: { in: active.map((m) => m.projectId!) }, status: { not: "CANCELLED" } }, select: { id: true, title: true } });
  const titleOf = new Map(projects.map((p) => [p.id, p.title]));
  return active.flatMap((m) => {
    const title = titleOf.get(m.projectId!);
    return title ? [{
      outboxId: m.id,
      projectId: m.projectId!, street: title.split(",")[0].trim() || title,
      state: m.state as DeliveryNoticeIncident["state"], queuedAtISO: m.createdAt.toISOString(), taskId: m.taskId,
    }] : [];
  });
}

/** Resolve a focused Communications link without putting a phone or draft in
 * the URL. Refuse arbitrary outbox ids, including unrelated failed texts. */
export async function deliveryNoticeFocus(id: unknown) {
  if (typeof id !== "string" || !/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const row = await prisma.outboxMessage.findUnique({
    where: { id },
    select: { id: true, channel: true, toRef: true, body: true, state: true, createdAt: true, projectId: true, taskId: true, dedupeKey: true },
  }).catch(() => null);
  if (!row || row.channel !== "sms" || !row.projectId) return null;
  if (row.dedupeKey?.startsWith("delivery:")) return row;
  if (!row.taskId) return null;
  const task = await prisma.smartTask.findFirst({ where: { id: row.taskId, taskType: "delivery_text" }, select: { id: true } }).catch(() => null);
  return task ? row : null;
}
