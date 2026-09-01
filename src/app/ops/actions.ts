"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { CLOSED_BY_HAND } from "@/lib/tasks";
import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { ActivityType } from "@prisma/client";

/**
 * Close a QC card by hand with a reason (Jordan, Sep 1). The hub waits on
 * evidence from Aryeo, so a deliverable REMOVED from the order (195 Woodhill's
 * floor plan, discounted $50) leaves the card open forever with nothing a
 * human can do. This is the override — and it records WHY, because a silent
 * close is how work disappears.
 */
export async function completeQcTask(taskId: string, note: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const task = await prisma.smartTask.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, taskType: true, status: true },
  });
  if (!task) return { ok: false, message: "That card no longer exists." };
  if (task.status === "COMPLETED") return { ok: true, message: "Already done." };

  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name ?? "").trim();
  const reason = note.trim().slice(0, 300);

  const done = await prisma.smartTask.updateMany({
    where: { id: taskId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    // "closed-by-hand" is what stops the hourly reconciler from reopening
    // this card: it reopens any COMPLETED QC whose checklist still has
    // unticked boxes (a guard against auto-closes during signal blips), and a
    // human close never ticks boxes — so 195 Woodhill and 632 Greenridge came
    // back every hour after Kyle closed them with a reason (Sep 1 2026).
    data: { status: "COMPLETED", completedAt: new Date(), sourceDetail: CLOSED_BY_HAND },
  });
  if (done.count === 0) return { ok: true, message: "Already handled." };

  if (task.projectId) {
    await prisma.activity
      .create({
        data: {
          projectId: task.projectId,
          type: ActivityType.SYSTEM,
          body: `QC marked complete by hand${who ? ` by ${who}` : ""}${reason ? `: ${reason}` : " (no reason given)"}.`,
        },
      })
      .catch(() => {});
  }
  revalidatePath("/ops");
  revalidatePath("/tasks");
  if (task.projectId) revalidatePath(`/projects/${task.projectId}`);
  return { ok: true, message: "QC closed." };
}
