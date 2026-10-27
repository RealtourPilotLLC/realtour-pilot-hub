import { prisma } from "@/lib/prisma";
import { getClientTextTasks, DELIVER_TASK_TYPES } from "@/lib/queries";
import { etDayStartUtc } from "@/lib/datetime";
import { confirmationInWindow } from "@/lib/clientTexts";
import { ClientTextsList, type ClientTextRow } from "@/components/texts/ClientTextsList";

// The day's confirmation + delivery texts as a mountable panel — lives on the
// Communications "Outbox" tab (Jordan: "keep comms all in one tab"). Same
// SmartTasks and send actions as the /today cards it replaced; every text is a
// draft a HUMAN sends — nothing goes out on its own.
export async function ClientTextsPanel({ excludeClientIds }: { excludeClientIds?: string[] } = {}) {
  const startToday = etDayStartUtc(new Date());
  const now = new Date();
  const tasks = await getClientTextTasks({ excludeClientIds });

  // A delivery text sent while the job's QC is still open would tell the client
  // "everything's over" prematurely — flag it. Check ALL open QC tasks (any
  // assignee); this warning moved here with the delivery-text cards from /today.
  const qcTypes = DELIVER_TASK_TYPES.filter((t) => t !== "delivery_text");
  const dtProjects = tasks.filter((t) => t.taskType === "delivery_text" && t.projectId).map((t) => t.projectId!);
  const openQc = dtProjects.length
    ? await prisma.smartTask.findMany({
        where: { projectId: { in: dtProjects }, taskType: { in: qcTypes }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        select: { projectId: true },
      })
    : [];
  const qcOpenSet = new Set(openQc.map((t) => t.projectId));
  // The live shoot of each confirmation (Oct 27 2026): the Outbox lists a
  // confirmation only while its shoot is ahead and no later than tomorrow
  // (lib/clientTexts), so this warns only when the shoot moved or passed
  // between that read and this one.
  const confProjects = tasks.filter((t) => t.taskType === "confirmation_text" && t.projectId).map((t) => t.projectId!);
  const shoots = new Map(
    (confProjects.length ? await prisma.project.findMany({ where: { id: { in: confProjects } }, select: { id: true, shootDate: true } }) : []).map((p) => [p.id, p.shootDate]),
  );

  const rows: ClientTextRow[] = tasks.map((t) => ({
    id: t.id,
    taskType: t.taskType,
    title: t.title,
    summary: t.summary,
    // The pre-written message lives on the task description (both types) — it
    // preloads the review box below.
    draft: t.description,
    clientName: t.contactName ?? t.client?.name ?? null,
    hasPhone: !!t.client?.phone,
    street: t.propertyAddress ? t.propertyAddress.split(",")[0].trim() : null,
    projectId: t.projectId,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    overdue: !!t.dueAt && t.dueAt < startToday,
    // Judged on the job's LIVE shoot, not the row's dueAt (Oct 27 2026): a
    // dueAt of "the day before" is in the past all of the day before, which
    // made every on-time confirmation read "may be out of date".
    warnStale: t.taskType === "confirmation_text" && !confirmationInWindow(t.projectId ? shoots.get(t.projectId) : null, now),
    warnQcOpen: t.taskType === "delivery_text" && !!t.projectId && qcOpenSet.has(t.projectId),
  }));

  return (
    <ClientTextsList
      confirmations={rows.filter((r) => r.taskType === "confirmation_text")}
      deliveries={rows.filter((r) => r.taskType !== "confirmation_text")}
    />
  );
}
