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
  const row = await prisma.revisionBrief.findUnique({ where: { id: briefId }, select: { projectId: true, doneJson: true } });
  if (!row) return { ok: false, message: "That request no longer exists." };
  // THE LOCK COMES FIRST (§8.3, Sep 25). This used to wipe the editor's ticks
  // and THEN ask analyzeBrief, which refuses a re-read once any of the
  // request's items has been worked — so a refused re-read still cost the
  // editor every tick they had made. Now: the ticks are mirrored onto their
  // issues first (a tick IS the editor saying "done", and syncBriefTicks is
  // how that reaches the issue list), then the lock is asked, and a locked
  // request is refused with nothing touched.
  const { briefIssuesLocked, syncBriefTicks } = await import("@/lib/revisionIssues");
  await syncBriefTicks(row.projectId);
  if (await briefIssuesLocked(briefId)) {
    return { ok: false, message: "Not re-read: its items are already being worked (fixed, classified or verified) — re-reading would renumber them. The ticks are kept." };
  }
  // A fresh split renumbers the items, so old ticks would land on the wrong
  // lines — cleared for the re-read, and put back if the re-read did not
  // happen (the model failed, or somebody acted in the meantime), because then
  // the items were not renumbered and the ticks still point at the right lines.
  const before = row.doneJson;
  if (before) await prisma.revisionBrief.updateMany({ where: { id: briefId, doneJson: before }, data: { doneJson: null } });
  const ok = await analyzeBrief(briefId);
  if (!ok && before) await prisma.revisionBrief.updateMany({ where: { id: briefId, doneJson: null }, data: { doneJson: before } });
  revalidatePath(`/edit/${row.projectId}`);
  return ok
    ? { ok: true, message: "Re-read the request." }
    : { ok: false, message: "The AI couldn't read it — the client's full words are still below." };
}
