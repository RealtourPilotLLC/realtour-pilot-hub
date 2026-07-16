import type { ReactNode } from "react";
import type { Prisma } from "@prisma/client";
import { PageHeader } from "@/components/PageHeader";
import { TodayFeed, type TodayCard, type TodayShoot } from "@/components/today/TodayFeed";
import { prisma } from "@/lib/prisma";
import { MESSAGE_TASK_TYPES, DELIVER_TASK_TYPES, CLIENT_TEXT_TYPES, getClientTextTasks, getShootWindow, getHandledToday } from "@/lib/queries";
import { recentProjectWhere } from "@/lib/recency";
import { etDayStartUtc } from "@/lib/datetime";
import { isNeedsAssigning } from "@/lib/triage";
import { listAssignees } from "@/lib/assignees";
import { editorMeta, isDelegated } from "@/lib/editors";

// One finish-able stack: everything that needs Kyle TODAY, as action cards —
// work down, tap, done. Everything the system handles on its own stays hidden
// (a count in the footer), so the list can actually reach zero.
// (Moved from /today — now the Tasks hub's default tab.)

const ACTIVE = ["OPEN", "IN_PROGRESS", "WAITING_CLIENT", "WAITING_PHOTOGRAPHER", "WAITING_EDITOR", "WAITING_VENDOR", "WAITING_JORDAN", "BLOCKED"];
// QC/deliver work — the shared list minus delivery_text, which lives on the comms Outbox.
const CHECK_TYPES = DELIVER_TASK_TYPES.filter((t) => t !== "delivery_text");
const REPLY_TYPES = ["client_reply", "lead"];

// The stack's where clause — shared by the feed query and the hub tab badge so
// the count can never drift from what the tab renders.
function stackWhere(startToday: Date): Prisma.SmartTaskWhereInput {
  return {
    status: { in: ACTIVE },
    // EVERY assignee stays visible — Kyle's own + unassigned work, plus
    // anything delegated to ANYONE (editors, vendors, Jordan, photographers)
    // with a "→ Name" chip. Scoping to kyle+DELEGATE_KEYS made tasks assigned
    // to jordan/photographer keys vanish from every surface (audit critical).
    AND: [{
      OR: [
        // Messages/replies: always surface while open (someone is waiting).
        { taskType: { in: MESSAGE_TASK_TYPES } },
        // QC & deliver: while open on a recent job, any due date.
        { taskType: { in: CHECK_TYPES }, OR: [{ projectId: null }, { project: recentProjectWhere() }] },
        // Everything else (prep, to-dos): due by end of today INCLUDING
        // overdue — the stack must cover all of it, not hide it in "needs attention".
        // Confirmation/delivery texts are carved out to the Outbox; one rollup
        // card below stands in for all of them.
        {
          taskType: { notIn: [...MESSAGE_TASK_TYPES, ...CHECK_TYPES, ...CLIENT_TEXT_TYPES] },
          dueAt: { lte: new Date(startToday.getTime() + 24 * 3600_000 - 1) },
          OR: [{ projectId: null }, { project: recentProjectWhere() }],
        },
      ],
    }],
  };
}

// The hub tab badge: the feed's card count (stack tasks + the one texts rollup
// card when texts are waiting) via a cheap count, not the full include query.
export async function todayCardCount(): Promise<number> {
  const [n, textTasks] = await Promise.all([
    prisma.smartTask.count({ where: stackWhere(etDayStartUtc(new Date())) }),
    getClientTextTasks(),
  ]);
  return n + (textTasks.length > 0 ? 1 : 0);
}

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

export async function TodayView({ sp, tabs }: { sp: { guided?: string }; tabs: ReactNode }) {
  const startToday = etDayStartUtc(new Date());

  const [tasks, textTasks, shootWindow, handledToday, assignees] = await Promise.all([
    prisma.smartTask.findMany({
      where: stackWhere(startToday),
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
    // "→ Name" for ANY non-Kyle assignee (editor roster name when it's an
    // editor/vendor; capitalized slug otherwise — jordan, james, …).
    const delegatedTo = isDelegated(t.assignedKey)
      ? editorMeta(t.assignedKey)?.name ?? t.assignedKey
      : t.assignedKey && t.assignedKey !== "kyle"
        ? t.assignedKey.charAt(0).toUpperCase() + t.assignedKey.slice(1)
        : null;
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
      // or instructions. (Send drafts moved to the comms Outbox with their tasks.)
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
  // rollup card standing in for every text now reviewed on the comms Outbox.
  // Computed live from the same query that tab renders — no cron and no extra
  // task rows to create or auto-close, so it appears whenever texts are waiting
  // and vanishes on its own the moment the tab is cleared. The underlying
  // SmartTasks (dedupe, auto-close, the Board) are untouched; this is
  // presentation only.
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
        title="Tasks"
        subtitle="Everything that needs you today — work down the stack and you're done."
      />
      <div className="p-4 sm:p-6">
        {tabs}
        <TodayFeed cards={cards} shoots={shoots} handledToday={handledToday} assignees={chips} tomorrowCount={shootWindow.tomorrow.length} initialGuided={sp.guided === "1"} />
      </div>
    </div>
  );
}
