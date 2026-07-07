import { PageHeader } from "@/components/PageHeader";
import { TodayFeed, type TodayCard, type TodayShoot } from "@/components/today/TodayFeed";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { MESSAGE_TASK_TYPES, DELIVER_TASK_TYPES, getShootWindow, getHandledToday } from "@/lib/queries";
import { recentProjectWhere } from "@/lib/recency";
import { etDayStartUtc } from "@/lib/datetime";
import { isNeedsAssigning } from "@/lib/triage";
import { listAssignees } from "@/lib/assignees";
import { DELEGATE_KEYS, editorMeta, isDelegated } from "@/lib/editors";

export const dynamic = "force-dynamic";

// One finish-able stack: everything that needs Kyle TODAY, as action cards —
// work down, tap, done. Everything the system handles on its own stays hidden
// (a count in the footer), so the list can actually reach zero.

const ACTIVE = ["OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED"];
// QC/deliver work — the shared list minus delivery_text, which is a SEND card here.
const CHECK_TYPES = DELIVER_TASK_TYPES.filter((t) => t !== "delivery_text");
const SEND_TYPES = ["confirmation_text", "delivery_text"];
const REPLY_TYPES = ["client_reply", "lead"];

function verbFor(taskType: string, hasDraft: boolean): TodayCard["verb"] {
  if (REPLY_TYPES.includes(taskType)) return "reply";
  if (SEND_TYPES.includes(taskType) && hasDraft) return "send";
  if (CHECK_TYPES.includes(taskType)) return "check";
  return "do";
}

const TYPE_LABEL: Record<string, string> = {
  client_reply: "reply", lead: "new lead", confirmation_text: "confirmation",
  delivery_text: "delivery text", media_qa: "QC", delivery: "delivery",
  image_fixes: "photo fixes", feedback_review: "feedback", finish_delivery: "finish delivery",
  internal_instruction: "team task", todo: "to-do", vendor_update: "vendor",
  comms_followup: "job instruction", revision: "revision", appointment_prep: "shoot prep",
};

export default async function TodayPage() {
  // Same guard pattern as /queue: middleware gates when auth is enforced; here we
  // re-check role access for signed-in users (local dev runs sessionless/open).
  const me = await getCurrentUser().catch(() => null);
  if (me && !canAccess(me, "today")) redirect("/");
  const startToday = etDayStartUtc(new Date());
  const now = new Date();

  const [tasks, shootWindow, handledToday, assignees] = await Promise.all([
    prisma.smartTask.findMany({
      where: {
        status: { in: ACTIVE },
        // Kyle's own + unassigned work, PLUS anything delegated to an editor/
        // vendor (Kim/Remar/Luma/…) — they never log in, so delegated tasks
        // surface in Kyle's "Do" stack with a "→ Kim" chip instead of vanishing.
        OR: [{ assignedKey: null }, { assignedKey: "kyle" }, { assignedKey: { in: [...DELEGATE_KEYS] } }],
        AND: [{
          OR: [
            // Messages/replies: always surface while open (someone is waiting).
            { taskType: { in: MESSAGE_TASK_TYPES } },
            // QC & deliver: while open on a recent job, any due date.
            { taskType: { in: CHECK_TYPES }, OR: [{ projectId: null }, { project: recentProjectWhere() }] },
            // Everything else (confirmations, prep): due by end of today INCLUDING
            // overdue — the stack must cover all of it, not hide it in "needs attention".
            {
              taskType: { notIn: [...MESSAGE_TASK_TYPES, ...CHECK_TYPES] },
              dueAt: { lte: new Date(startToday.getTime() + 24 * 3600_000 - 1) },
              OR: [{ projectId: null }, { project: recentProjectWhere() }],
            },
          ],
        }],
      },
      include: { client: { select: { name: true, phone: true } } },
      orderBy: { dueAt: "asc" },
    }),
    getShootWindow(),
    getHandledToday(),
    listAssignees(),
  ]);

  // A delivery text sent while the job's QC is still open would tell the client
  // "everything's over" prematurely — flag it. Check ALL open QC tasks (any assignee).
  const dtProjects = tasks.filter((t) => t.taskType === "delivery_text" && t.projectId).map((t) => t.projectId!);
  const openQc = dtProjects.length
    ? await prisma.smartTask.findMany({
        where: { projectId: { in: dtProjects }, taskType: { in: CHECK_TYPES }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        select: { projectId: true },
      })
    : [];
  const qcOpenSet = new Set(openQc.map((t) => t.projectId));

  const cards: TodayCard[] = tasks.map((t) => {
    const hasDraft = SEND_TYPES.includes(t.taskType) && !!t.description;
    // Delegated work lands in "Do these" — Kyle's action is to check on the
    // person it's with, not to reply/send/QC himself.
    const delegatedTo = isDelegated(t.assignedKey) ? editorMeta(t.assignedKey)?.name ?? t.assignedKey : null;
    const verb = delegatedTo ? "do" : verbFor(t.taskType, hasDraft);
    return {
      id: t.id,
      verb,
      delegatedTo,
      taskType: t.taskType,
      typeLabel: TYPE_LABEL[t.taskType] ?? t.taskType.replace(/_/g, " "),
      title: t.title,
      summary: t.summary,
      // What the body means depends on the verb: a ready-to-send draft, the
      // client's quoted message, or instructions.
      draft: verb === "send" ? t.description : null,
      quote: verb === "reply" ? t.description : null,
      body: verb === "do" || verb === "check" ? t.description : null,
      clientId: t.clientId,
      clientName: t.contactName ?? t.client?.name ?? null,
      hasPhone: !!t.client?.phone,
      street: t.propertyAddress ? t.propertyAddress.split(",")[0].trim() : null,
      projectId: t.projectId,
      source: t.source,
      priority: t.priority,
      status: t.status,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      overdue: !!t.dueAt && t.dueAt < startToday,
      triage: isNeedsAssigning(t),
      // Overdue confirmation = the shoot may already have happened; double-check.
      warnStale: t.taskType === "confirmation_text" && !!t.dueAt && t.dueAt < now,
      warnQcOpen: t.taskType === "delivery_text" && !!t.projectId && qcOpenSet.has(t.projectId),
    };
  });

  const fmtTime = (d: Date | null) =>
    d ? d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "";
  const shoots: TodayShoot[] = shootWindow.today.map((s) => ({
    key: s.apptId,
    id: s.id,
    title: s.title.split(",")[0],
    time: fmtTime(s.shootDate),
    photographer: s.photographer?.name ?? null,
  }));

  const chips = assignees.map((a) => ({ key: a.key, name: a.name }));

  return (
    <div>
      <PageHeader
        eyebrow="Eastern time"
        title="Today"
        subtitle="Everything that needs you — work down the stack and you're done."
      />
      <div className="p-4 sm:p-6">
        <TodayFeed cards={cards} shoots={shoots} handledToday={handledToday} assignees={chips} tomorrowCount={shootWindow.tomorrow.length} />
      </div>
    </div>
  );
}
