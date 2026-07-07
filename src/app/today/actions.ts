"use server";

import { requireAdmin } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { OpenPhone, defaultOpenPhoneNumber, phoneKey } from "@/lib/integrations/openphone";
import { closeReplyForOutbound } from "@/lib/tasks";

// Send a reply text for a SPECIFIC task's client via OpenPhone, then complete
// that exact task (closeReplyForOutbound is street-inference based and can miss
// when a client has several open replies — Today's cards are per-task, so we
// close deterministically). Human-initiated: Kyle reviews the draft and taps Send.
export async function sendReplyForTask(taskId: string, body: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "Write a message first." };

  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, clientId: true, projectId: true, client: { select: { phone: true, name: true } } },
  });
  if (!task) return { ok: false, message: "That task no longer exists." };
  if (!task.clientId || !task.client?.phone) return { ok: false, message: "No phone number on file for this client." };
  const k = phoneKey(task.client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  try {
    await OpenPhone.sendMessage(from, `+1${k}`, text);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send text." };
  }

  if (task.projectId) {
    await prisma.activity.create({
      data: { projectId: task.projectId, type: "SYSTEM", body: `Text sent to ${task.client.name}: ${text.slice(0, 200)}` },
    }).catch(() => {});
  }
  // Close THIS task first (deterministic), then let the generic sweep close any
  // sibling reply task the text also answers.
  await prisma.smartTask.updateMany({
    where: { id: task.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  await closeReplyForOutbound(task.clientId, text).catch(() => {});
  revalidatePath("/today");
  revalidatePath("/queue");
  revalidatePath("/");
  return { ok: true, message: "Reply sent." };
}
