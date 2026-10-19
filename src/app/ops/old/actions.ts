"use server";

import { revalidatePath } from "next/cache";
import { requireTaskAccess } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { etAddDays, etDayKey } from "@/lib/datetime";
import { parseTaskDeadlineDate } from "@/lib/taskDeadline";
import { MAX_PUSH_DAYS, PUSH_ACTION, PUSHES_BEFORE_FLAG, chaseDate } from "@/lib/taskAging";

// ---------------------------------------------------------------------------
// "NEW DATE" ON AN OLD ITEM (Oct 19 2026). An old item (lib/taskAging) can be
// Done, Not needed (the existing dismissal), or given a new date. A new date
// must be picked (no "snooze a week" button), it moves the CHASE date
// (SmartTask.followUpAt) and never the promise (dueAt): the job still reads
// as late everywhere a promise is judged, but the old-items list leaves it
// alone until the new date is 3 days gone too.
//
// Every push is an AuditLog row, so they are counted. The third push on the
// same item flags Jordan (a bell), and his Home lists it.
// ---------------------------------------------------------------------------

const CLOSED = ["COMPLETED", "CANCELLED"];

export async function pushOldItem(taskId: string, day: string): Promise<{ ok: boolean; message: string; pushes?: number }> {
  try {
    await requireTaskAccess(taskId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "No access." };
  }
  const parsed = parseTaskDeadlineDate(day);
  if (!parsed.ok || !parsed.dueAt) return { ok: false, message: "Pick the new date first." };
  const now = new Date();
  const today = etDayKey(now);
  if (day <= today) return { ok: false, message: "Pick a day after today." };
  if (day > etDayKey(etAddDays(now, MAX_PUSH_DAYS))) return { ok: false, message: `Pick a day within ${MAX_PUSH_DAYS} days.` };

  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const who = (me?.name ?? me?.email ?? "").trim() || "the office";

  const result = await prisma.$transaction(async (tx) => {
    const t = await tx.smartTask.findUnique({ where: { id: taskId }, select: { status: true, title: true, dueAt: true, followUpAt: true, assignedKey: true } });
    if (!t) return { ok: false as const, message: "That task no longer exists." };
    if (CLOSED.includes(t.status)) return { ok: false as const, message: "That task is already closed." };
    const changed = await tx.smartTask.updateMany({
      where: { id: taskId, status: t.status, followUpAt: t.followUpAt },
      data: { followUpAt: parsed.dueAt },
    });
    if (changed.count !== 1) return { ok: false as const, message: "The task changed while saving. Refresh and try again." };
    await tx.auditLog.create({
      data: {
        actor: me?.email ?? "local-dev",
        action: PUSH_ACTION,
        target: taskId,
        detail: JSON.stringify({ from: chaseDate(t)?.toISOString() ?? null, to: parsed.dueAt!.toISOString(), by: who }),
      },
    });
    const pushes = await tx.auditLog.count({ where: { action: PUSH_ACTION, target: taskId } });
    return { ok: true as const, title: t.title, assignedKey: t.assignedKey, pushes };
  });
  if (!result.ok) return result;

  // THE THIRD PUSH FLAGS JORDAN — one bell per push from the third on, so a
  // fourth push is news too. Keyed per task and count, never sent twice.
  if (result.pushes >= PUSHES_BEFORE_FLAG) {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "old_item_pushed",
      title: `${who.split(" ")[0]} pushed an old item ${result.pushes} times`,
      body: result.title,
      href: "/ops/old?who=all",
      targets: [{ roles: ["OWNER"] }],
      dedupeKey: `old-item-pushed-${taskId}-${result.pushes}`,
    });
  }
  revalidatePath("/");
  revalidatePath("/ops/old");
  revalidatePath("/tasks");
  const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(parsed.dueAt);
  return {
    ok: true,
    pushes: result.pushes,
    message: result.pushes >= PUSHES_BEFORE_FLAG ? `Moved to ${when}. That is push ${result.pushes}, so Jordan is told.` : `Moved to ${when}.`,
  };
}
