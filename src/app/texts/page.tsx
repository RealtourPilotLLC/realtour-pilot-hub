import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { getClientTextTasks, DELIVER_TASK_TYPES } from "@/lib/queries";
import { etDayStartUtc } from "@/lib/datetime";
import { ClientTextsList, type ClientTextRow } from "@/components/texts/ClientTextsList";

export const dynamic = "force-dynamic";

// Client Texts — the day's confirmation + delivery texts, pulled out of the
// /today stack into their own review tab (Jordan: "separate the delivery and
// confirmation texts … in its own separate tab"). Same SmartTasks and the same
// send actions the old /today cards used; /today now shows a single rollup card
// pointing here. Every text is a draft a HUMAN sends — nothing goes out on its own.

export default async function TextsPage() {
  // Same guard pattern as /today: middleware gates when auth is enforced; here we
  // re-check role access for signed-in users (local dev runs sessionless/open).
  const me = await getCurrentUser().catch(() => null);
  if (me && !canAccess(me, "texts")) redirect("/");

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
    warnStale: t.taskType === "confirmation_text" && !!t.dueAt && t.dueAt < now,
    warnQcOpen: t.taskType === "delivery_text" && !!t.projectId && qcOpenSet.has(t.projectId),
  }));

  return (
    <div>
      <PageHeader
        eyebrow="Eastern time"
        title="Client Texts"
        subtitle="Today's confirmation and delivery texts — review each draft, then send."
      />
      <div className="p-4 sm:p-6">
        <ClientTextsList
          confirmations={rows.filter((r) => r.taskType === "confirmation_text")}
          deliveries={rows.filter((r) => r.taskType !== "confirmation_text")}
        />
      </div>
    </div>
  );
}
