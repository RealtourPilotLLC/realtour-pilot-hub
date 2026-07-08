import { PageHeader } from "@/components/PageHeader";
import { TodayFeed, type TodayCard, type TodayShoot } from "@/components/today/TodayFeed";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { MESSAGE_TASK_TYPES, DELIVER_TASK_TYPES, CLIENT_TEXT_TYPES, getClientTextTasks, getShootWindow, getHandledToday } from "@/lib/queries";
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
// QC/deliver work — the shared list minus delivery_text, which lives on /texts.
const CHECK_TYPES = DELIVER_TASK_TYPES.filter((t) => t !== "delivery_text");
const REPLY_TYPES = ["client_reply", "lead"];

function verbFor(taskType: string): TodayCard["verb"] {
  if (REPLY_TYPES.includes(taskType)) return "reply";
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

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ guided?: string }> }) {
  const sp = await searchParams;
  // Same guard pattern as /queue: middleware gates when auth is enforced; here we
  // re-check role access for signed-in users (local dev runs sessionless/open).
  const me = await getCurrentUser().catch(() => null);
  if (me && !canAccess(me, "today")) redirect("/");
  const startToday = etDayStartUtc(new Date());

  const [tasks, textTasks, shootWindow, handledToday, assignees] = await Promise.all([
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
            // Everything else (prep, to-dos): due by end of today INCLUDING
            // overdue — the stack must cover all of it, not hide it in "needs attention".
            // Confirmation/delivery texts are carved out to /texts; one rollup
            // card below stands in for all of them.
            {
              taskType: { notIn: [...MESSAGE_TASK_TYPES, ...CHECK_TYPES, ...CLIENT_TEXT_TYPES] },
              dueAt: { lte: new Date(startToday.getTime() + 24 * 3600_000 - 1) },
              OR: [{ projectId: null }, { project: recentProjectWhere() }],
            },
          ],
        }],
      },
      include: { client: { select: { name: true, phone: true } } },
      orderBy: { dueAt: "asc" },
    }),
    getClientTextTasks(),
    getShootWindow(),
    getHandledToday(),
    listAssignees(),
  ]);

  const cards: TodayCard[] = tasks.map((t) => {
    // Delegated work lands in "Do these" — Kyle's action is to check on the
    // person it's with, not to reply/send/QC himself.
    const delegatedTo = isDelegated(t.assignedKey) ? editorMeta(t.assignedKey)?.name ?? t.assignedKey : null;
    const verb = delegatedTo ? "do" : verbFor(t.taskType);
    return {
      id: t.id,
      verb,
      delegatedTo,
      taskType: t.taskType,
      typeLabel: TYPE_LABEL[t.taskType] ?? t.taskType.replace(/_/g, " "),
      title: t.title,
      summary: t.summary,
      // What the body means depends on the verb: the client's quoted message,
      // or instructions. (Send drafts moved to /texts with their tasks.)
      draft: null,
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
      warnStale: false,
      warnQcOpen: false,
    };
  });

  // Jordan's "one task per day to check the delivery/confirmation texts": ONE
  // rollup card standing in for every text now reviewed on /texts. Computed live
  // from the same query that tab renders — no cron and no extra task rows to
  // create or auto-close, so it appears whenever texts are waiting and vanishes
  // on its own the moment the tab is cleared. The underlying SmartTasks (dedupe,
  // auto-close, /queue) are untouched; this is presentation only.
  if (textTasks.length > 0) {
    const confirmations = textTasks.filter((t) => t.taskType === "confirmation_text").length;
    const deliveries = textTasks.length - confirmations;
    // Inherit the most urgent priority + soonest due so the rollup sorts where
    // the loudest of its texts would have.
    const rank: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const priority = textTasks.reduce((best, t) => ((rank[t.priority] ?? 9) < (rank[best] ?? 9) ? t.priority : best), "LOW");
    cards.push({
      id: "client-texts-rollup",
      verb: "check",
      delegatedTo: null,
      taskType: "client_texts", // sentinel — TodayFeed renders a link to /texts
      typeLabel: "client texts",
      title: "Check today's client texts",
      summary: null,
      draft: null,
      quote: null,
      body: `${confirmations} confirmation${confirmations === 1 ? "" : "s"} + ${deliveries} delivery text${deliveries === 1 ? "" : "s"} waiting`,
      clientId: null,
      clientName: null,
      hasPhone: false,
      street: null,
      projectId: null,
      source: "system",
      priority,
      status: "OPEN",
      dueAt: textTasks[0].dueAt ? textTasks[0].dueAt.toISOString() : null, // query is dueAt-asc
      overdue: textTasks.some((t) => !!t.dueAt && t.dueAt < startToday),
      triage: false,
      warnStale: false,
      warnQcOpen: false,
    });
  }

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
        <TodayFeed cards={cards} shoots={shoots} handledToday={handledToday} assignees={chips} tomorrowCount={shootWindow.tomorrow.length} initialGuided={sp.guided === "1"} />
      </div>
    </div>
  );
}
