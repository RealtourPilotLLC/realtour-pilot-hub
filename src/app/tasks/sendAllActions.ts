"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { clientTextWhere } from "@/lib/clientTexts";

// ---------------------------------------------------------------------------
// "Send all" for the drafted client texts (confirmation + delivery). The hub
// NEVER auto-sends to clients — this batch flow keeps a human in charge of
// every message: the panel lists each freshly-rendered draft, Jordan/Kyle can
// edit any of them or untick ones to skip, and "Send all" fires the ticked
// ones one by one. Each send logs to the project and completes its task, same
// as the per-card Send button.
// ---------------------------------------------------------------------------

export type DraftedText = {
  taskId: string;
  taskType: "confirmation_text" | "delivery_text";
  projectId: string;
  clientName: string;
  street: string;
  /** Freshly rendered message (shoot time / photographer current as of now). */
  body: string;
  /** Why this row can't send (no phone / invalid) — shown, excluded from batch. */
  blocked: string | null;
  /** Confirmation for a shoot that already started (or has no date yet) — loads UNTICKED with a warning. */
  warnStale: boolean;
  dueAt: string | null;
  overdue: boolean;
};

export async function listDraftedTexts(): Promise<{ ok: boolean; message?: string; rows?: DraftedText[] }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Not allowed." };
  }

  // ONE membership rule for every client-text surface (panel, badge, /today
  // rollup, this batch) — see clientTextWhere for why each clause exists.
  const tasks = await prisma.smartTask.findMany({
    where: clientTextWhere(),
    select: { id: true, taskType: true, projectId: true, dueAt: true },
    orderBy: [{ taskType: "asc" }, { dueAt: "asc" }],
  });
  if (tasks.length === 0) return { ok: true, rows: [] };

  const projects = await prisma.project.findMany({
    where: { id: { in: tasks.map((t) => t.projectId!) } },
    select: {
      id: true, title: true, shootDate: true, statusEvidence: true,
      client: { select: { name: true, phone: true } },
      photographer: { select: { name: true } },
      deliverables: { select: { type: true } },
    },
  });
  const byId = new Map(projects.map((p) => [p.id, p]));
  const { phoneKey } = await import("@/lib/integrations/openphone");
  const { deliveryMessage, confirmationMessage } = await import("@/lib/delivery");

  const rows: DraftedText[] = [];
  for (const t of tasks) {
    const p = byId.get(t.projectId!);
    if (!p) continue;
    const body =
      t.taskType === "delivery_text"
        ? deliveryMessage(p)
        : confirmationMessage({
            title: p.title,
            shootDate: p.shootDate,
            client: { name: p.client.name },
            photographer: p.photographer,
            deliverables: p.deliverables,
          });
    const blocked = !p.client.phone
      ? "No phone on file"
      : phoneKey(p.client.phone).length !== 10
        ? "Phone number looks invalid"
        : null;
    rows.push({
      taskId: t.id,
      taskType: t.taskType as DraftedText["taskType"],
      projectId: p.id,
      clientName: p.client.name,
      street: p.title.split(",")[0].trim(),
      body,
      blocked,
      // "Confirming your shoot at 10 AM" sent at 2pm reads insane — the
      // per-card surface warns about this; the BATCH (one tap, many texts)
      // must too, and load these unticked. NO shoot date is just as unsendable:
      // the draft has no time to confirm, so it warns + loads unticked too.
      // A null dueAt is unsendable-by-default too: the task minted before the
      // shoot was scheduled, and the reconciler may not have caught up with a
      // freshly-set shootDate yet — one tap on "Send all" must never fire a
      // confirmation days early. (The Outbox panel warns on the same signal.)
      warnStale:
        t.taskType === "confirmation_text" && (!t.dueAt || !p.shootDate || p.shootDate.getTime() < Date.now()),
      dueAt: t.dueAt?.toISOString() ?? null,
      overdue: !!t.dueAt && t.dueAt.getTime() < Date.now(),
    });
  }
  return { ok: true, rows };
}

/**
 * Send ONE drafted text — with the (possibly human-edited) body the panel
 * showed. Logs to the project and completes the task, exactly like the
 * per-card send.
 */
export async function sendDraftText(taskId: string, body: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "Message is empty." };
  if (text.length > 1200) return { ok: false, message: "Message is too long for a text." };

  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, taskType: true, projectId: true, status: true },
  });
  if (!task || !["confirmation_text", "delivery_text"].includes(task.taskType)) {
    return { ok: false, message: "Not a drafted-text task." };
  }
  if (!task.projectId) return { ok: false, message: "No project linked." };

  const project = await prisma.project.findUnique({
    where: { id: task.projectId },
    select: { id: true, client: { select: { name: true, phone: true } } },
  });
  if (!project?.client.phone) return { ok: false, message: "No phone number on file." };

  const { phoneKey, OpenPhone, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const k = phoneKey(project.client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  // Atomically CLAIM the task before texting — the batch panel racing the
  // per-card Send button (or a second tab) must never double-text the client.
  // Reverted on send failure so the task stays retryable.
  const claimed = await prisma.smartTask.updateMany({
    where: { id: task.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, message: "Already handled." };

  try {
    await OpenPhone.sendMessage(from, `+1${k}`, text);
  } catch (e) {
    await prisma.smartTask
      .updateMany({ where: { id: task.id }, data: { status: "OPEN", completedAt: null } })
      .catch(() => {});
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send." };
  }
  const label = task.taskType === "delivery_text" ? "Delivery text" : "Confirmation text";
  await prisma.activity.create({
    data: { projectId: project.id, type: "SYSTEM", body: `${label} sent to ${project.client.name}: ${text.slice(0, 160)}` },
  });
  revalidatePath("/");
  revalidatePath("/tasks");
  revalidatePath(`/projects/${task.projectId}`);
  return { ok: true, message: `${label} sent.` };
}
