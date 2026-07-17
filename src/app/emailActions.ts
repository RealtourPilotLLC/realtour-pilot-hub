"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";

// Send the human-reviewed email reply behind a gmail-sourced task. The hub
// DRAFTS; a person reads, edits, and presses Send — this is that press. The
// reply goes out threaded (In-Reply-To/References) from the same mailbox the
// email arrived on, gets logged to comms memory, and closes the reply task.

export async function sendEmailReply(
  taskId: string,
  body: string,
  opts?: { expectedTo?: string; /** Revision acks: reply goes out but the edit work remains open. */ keepOpen?: boolean },
): Promise<{ ok: boolean; message: string; to?: string }> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "The reply is empty." };
  if (text.length > 20_000) return { ok: false, message: "That reply is too long." };

  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, source: true, sourceDetail: true, status: true, projectId: true, clientId: true, client: { select: { name: true } } },
  });
  if (!task) return { ok: false, message: "Task not found." };
  const sd = task.sourceDetail ?? "";
  if (task.source !== "gmail" || !sd.startsWith("gmail-thread:")) {
    return { ok: false, message: "This task didn't come from an email thread." };
  }
  const [, mailbox, threadId] = sd.split(":");
  if (!mailbox || !threadId) return { ok: false, message: "The email thread reference is incomplete." };

  // Atomically CLAIM the task before sending — a stale second tab / double
  // press must never email the client twice. Reverted if the send fails.
  // keepOpen (revision acknowledgements — the edit work remains) skips the
  // claim; its double-press guard is the button's busy state.
  if (!opts?.keepOpen) {
    const claimed = await prisma.smartTask.updateMany({
      where: { id: task.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    if (claimed.count === 0) return { ok: false, message: "Already handled — this reply was sent (or the task was closed)." };
  } else if (task.status === "COMPLETED" || task.status === "CANCELLED") {
    return { ok: false, message: "Already handled." };
  }

  const { sendGmailReply } = await import("@/lib/integrations/google");
  const sent = await sendGmailReply({ mailbox, threadId, body: text, expectedTo: opts?.expectedTo });
  if (!sent.ok) {
    if (!opts?.keepOpen) {
      await prisma.smartTask
        .updateMany({ where: { id: task.id }, data: { status: "OPEN", completedAt: null } })
        .catch(() => {});
    }
    if (sent.needsReconnect) {
      // Only Jordan can fix a missing send scope (/connections is owner-only):
      // ping him + mint the reconnect task, and don't tell an ADMIN to go do
      // something they can't open (audit finding #41). AWAITED — a floating
      // write gets killed by the serverless freeze right after this action
      // returns, which would silently lose the only ping this fix exists for.
      const { reportGmailSendBroken } = await import("@/lib/gmailHealth");
      await reportGmailSendBroken(`reply re: ${task.client?.name ?? "email task"}`, mailbox);
      const { getCurrentUser } = await import("@/lib/auth/user");
      const me = await getCurrentUser().catch(() => null);
      if (me && me.realRole !== "OWNER") {
        return { ok: false, message: "Gmail can't send yet — Jordan's been pinged to reconnect it. Reply from Gmail directly for now." };
      }
    }
    return { ok: false, message: sent.error };
  }
  // A send went through → this mailbox's scope is granted; retire its task.
  await (await import("@/lib/gmailHealth")).reportGmailSendWorking(mailbox);

  // Comms memory + project trail + close the to-do (same shape as a manual
  // reply the poller would have detected).
  const { logComm } = await import("@/lib/commLog");
  await logComm({
    channel: "email",
    direction: "out",
    clientId: task.clientId,
    clientName: task.client?.name ?? null,
    projectId: task.projectId,
    contactName: null,
    subject: sent.subject,
    body: text,
    source: "gmail",
    externalId: `hub-send-${taskId}-${Date.now()}`,
  }).catch(() => {});
  if (task.projectId) {
    await prisma.activity
      .create({ data: { projectId: task.projectId, type: "SYSTEM", body: `Email reply sent to ${sent.to}: ${text.slice(0, 160)}` } })
      .catch(() => {});
  }
  revalidatePath("/");
  revalidatePath("/tasks");
  if (task.projectId) revalidatePath(`/projects/${task.projectId}`);
  return { ok: true, message: `Sent to ${sent.to} — task closed.`, to: sent.to };
}

// Resolve WHO a reply would go to — the UI shows this next to the Send button
// so the human confirms the recipient before anything leaves, and the send
// pins it (expectedTo) so a thread update between look and press can't reroute
// the reply to someone else.
export async function resolveEmailRecipient(taskId: string): Promise<{ ok: boolean; to?: string; message?: string }> {
  await requireAdmin();
  const task = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { source: true, sourceDetail: true } });
  const sd = task?.sourceDetail ?? "";
  if (!task || task.source !== "gmail" || !sd.startsWith("gmail-thread:")) {
    return { ok: false, message: "Not an email-thread task." };
  }
  const [, mailbox, threadId] = sd.split(":");
  if (!mailbox || !threadId) return { ok: false, message: "The email thread reference is incomplete." };
  const { resolveGmailReplyTarget } = await import("@/lib/integrations/google");
  const r = await resolveGmailReplyTarget(mailbox, threadId);
  return r.ok ? { ok: true, to: r.to } : { ok: false, message: r.error };
}
