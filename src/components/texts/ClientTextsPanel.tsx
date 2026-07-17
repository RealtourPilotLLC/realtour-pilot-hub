import { prisma } from "@/lib/prisma";
import { getClientTextTasks, DELIVER_TASK_TYPES } from "@/lib/queries";
import { etDayStartUtc } from "@/lib/datetime";
import { ClientTextsList, type ClientTextRow } from "@/components/texts/ClientTextsList";

// The day's confirmation + delivery texts as a mountable panel — lives on the
// Communications "Outbox" tab (Jordan: "keep comms all in one tab"). Same
// SmartTasks and send actions as the /today cards it replaced; every text is a
// draft a HUMAN sends — nothing goes out on its own.
export async function ClientTextsPanel() {
  const startToday = etDayStartUtc(new Date());
  const now = new Date();
  const tasks = await getClientTextTasks();

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
    // Overdue confirmation = the shoot may already have happened; double-check.
    // No due date at all = no shoot date on the job — nothing to confirm yet,
    // so it warns the same way instead of reading as safely sendable.
    warnStale: t.taskType === "confirmation_text" && (!t.dueAt || t.dueAt < now),
    warnQcOpen: t.taskType === "delivery_text" && !!t.projectId && qcOpenSet.has(t.projectId),
  }));

  return (
    <ClientTextsList
      confirmations={rows.filter((r) => r.taskType === "confirmation_text")}
      deliveries={rows.filter((r) => r.taskType !== "confirmation_text")}
    />
  );
}
