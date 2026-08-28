"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireTaskAccess, requireAdmin } from "@/lib/auth/guards";
import { analyzeBrief } from "@/lib/revisionBrief";

// Who may act on a revision brief: the editor it's assigned to, plus
// owner/admin — the same gate the revision task itself uses, so a brief can
// never be a side door into another lane's work.
async function requireBriefAccess(briefId: string): Promise<{ projectId: string }> {
  const brief = await prisma.revisionBrief.findUnique({
    where: { id: briefId },
    select: { projectId: true, taskId: true },
  });
  if (!brief) throw new Error("That request no longer exists.");
  if (brief.taskId) {
    const task = await prisma.smartTask.findUnique({ where: { id: brief.taskId }, select: { id: true } });
    if (task) {
      await requireTaskAccess(task.id);
      return { projectId: brief.projectId };
    }
  }
  // No task behind it (or it was deleted) → admin only.
  await requireAdmin();
  return { projectId: brief.projectId };
}

/** Tick / untick one item on the work order. */
export async function setBriefItemDone(
  briefId: string,
  itemId: string,
  done: boolean,
): Promise<{ ok: boolean; message: string }> {
  let projectId: string;
  try {
    ({ projectId } = await requireBriefAccess(briefId));
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const row = await prisma.revisionBrief.findUnique({ where: { id: briefId }, select: { doneJson: true } });
  if (!row) return { ok: false, message: "That request no longer exists." };
  let current: string[] = [];
  try {
    if (row.doneJson) current = JSON.parse(row.doneJson) as string[];
  } catch { /* corrupt list → start clean rather than refusing the tick */ }
  const next = done ? [...new Set([...current, itemId])] : current.filter((i) => i !== itemId);
  await prisma.revisionBrief.update({ where: { id: briefId }, data: { doneJson: JSON.stringify(next) } });
  revalidatePath(`/edit/${projectId}`);
  return { ok: true, message: done ? "Ticked off." : "Reopened." };
}

/**
 * Re-run the analysis. Owner/admin only — this spends a model call, and the
 * editor's tick-offs are keyed to item ids that a re-analysis renumbers.
 */
export async function reanalyzeBrief(briefId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const row = await prisma.revisionBrief.findUnique({ where: { id: briefId }, select: { projectId: true } });
  if (!row) return { ok: false, message: "That request no longer exists." };
  // A fresh split renumbers the items, so old ticks would land on the wrong
  // lines — clear them rather than silently mis-marking the editor's work.
  await prisma.revisionBrief.update({ where: { id: briefId }, data: { doneJson: null } });
  const ok = await analyzeBrief(briefId);
  revalidatePath(`/edit/${row.projectId}`);
  return ok
    ? { ok: true, message: "Re-read the request." }
    : { ok: false, message: "The AI couldn't read it — the client's full words are still below." };
}
