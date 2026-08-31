import type { ReactNode } from "react";
import type { Prisma } from "@prisma/client";
import { PageHeader } from "@/components/PageHeader";
import { TodayFeed, type TodayCard, type TodayShoot } from "@/components/today/TodayFeed";
import { prisma } from "@/lib/prisma";
import { MESSAGE_TASK_TYPES, DELIVER_TASK_TYPES, CLIENT_TEXT_TYPES, getClientTextTasks, getShootWindow, getHandledToday } from "@/lib/queries";
import { etEndOfTodayUtc } from "@/lib/clientTexts";
import { recentProjectWhere } from "@/lib/recency";
import { etDayStartUtc } from "@/lib/datetime";
import { isNeedsAssigning } from "@/lib/triage";
import { receivedByLabel } from "@/lib/taskSource";
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
    // Comm-type tasks moved to the Comms tab (engine keeps tracking silently).
    taskType: { notIn: ["client_reply", "comms_followup", "callback"] },
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
          // ET calendar end-of-day via the documented DST-correct helper.
          dueAt: { lte: etEndOfTodayUtc() },
          OR: [{ projectId: null }, { project: recentProjectWhere() }],
        },
      ],
    }],
  };
}

// The hub tab badge: the feed's card count (stack tasks + the one texts rollup
// card when texts are waiting) via a cheap count, not the full include query.
export async function todayCardCount(): Promise<number> {
  const [n, textTasks, triage] = await Promise.all([
    prisma.smartTask.count({ where: stackWhere(etDayStartUtc(new Date())) }),
    getClientTextTasks(),
    prisma.smartTask.count({ where: { status: { in: ACTIVE }, assignedKey: null, taskType: { in: ["internal_instruction", "todo", "vendor_update"] }, OR: [{ projectId: null }, { project: recentProjectWhere() }] } }),
  ]);
  // + one rollup card each for waiting texts and the unowned pile (review:
  // the badge must match what the feed renders).
  return n + (textTasks.length > 0 ? 1 : 0) + (triage > 0 ? 1 : 0);
}

function verbFor(taskType: string): TodayCard["verb"] {
  if (REPLY_TYPES.includes(taskType)) return "reply";
  if (CHECK_TYPES.includes(taskType)) return "check";
  return "do";
}

// Same-action tasks fold into one card (Jordan Aug 25: "Send Gary's photos"
// belongs in a "Send photos" card listing everyone — not N near-identical
// cards). Two ways in: a known action family (send videos / send photos /
// booking links), or an exact title stem before the "—" (the engines' own
// "{action} — {address}" convention: "QC & deliver — …", "Find the raw video
// — …"). Stems only group when ≥2 cards share one — the feed handles that.
function groupKeyFor(verb: TodayCard["verb"], title: string): string | null {
  if (verb === "reply") return null; // conversations stay per-person
  const t = title.trim();
  if (/strategy-call booking link/i.test(t)) return "Send strategy-call booking links";
  if (/^send\b/i.test(t) && /(video|reel|footage)/i.test(t)) return "Send finished videos";
  if (/^send\b/i.test(t) && /(photo|image|picture|galler)/i.test(t)) return "Send photos";
  const dash = t.split("—")[0].trim();
  if (dash && dash !== t && dash.length >= 6) return dash;
  return null;
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

  const [tasks, textTasks, shootWindow, handledToday, assignees, triageCount] = await Promise.all([
    prisma.smartTask.findMany({
      where: stackWhere(startToday),
      include: { client: { select: { name: true, phone: true } } },
      orderBy: { dueAt: "asc" },
    }),
    getClientTextTasks(),
    getShootWindow(),
    getHandledToday(),
    listAssignees(),
    // The unowned instruction pile — one rollup card, not N walls of text.
    prisma.smartTask.count({ where: { status: { in: ACTIVE }, assignedKey: null, taskType: { in: ["internal_instruction", "todo", "vendor_update"] }, OR: [{ projectId: null }, { project: recentProjectWhere() }] } }),
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
      // When the message landed + which inbox/line got it (Jordan Aug 25).
      receivedAt: t.createdAt.toISOString(),
      receivedBy: receivedByLabel(t.source, t.sourceDetail),
      groupKey: groupKeyFor(verb, t.title),
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
      receivedAt: null,
      receivedBy: null,
      groupKey: null,
    });
  }

  // "44 Slack to-dos to triage" — the pile is real work, but it belongs in ONE
  // card that opens the triage board, not as 44 separate cards drowning the
  // client work (audit Aug 25; same presentation-only pattern as the texts
  // rollup above).
  if (triageCount > 0) {
    cards.push({
      id: "triage-rollup",
      verb: "do",
      delegatedTo: null,
      taskType: "triage_pile", // sentinel — TodayFeed renders a link to the triage board
      typeLabel: "to assign",
      title: `${triageCount} to-do${triageCount === 1 ? "" : "s"} need an owner`,
      summary: null,
      draft: null,
      quote: null,
      body: "Slack instructions and system to-dos that arrived without an owner. Open the triage board, tap a name on each, and they move to that person's list.",
      clientId: null,
      clientName: null,
      hasPhone: false,
      street: null,
      projectId: null,
      source: "slack",
      priority: "HIGH",
      status: "OPEN",
      dueAt: null,
      overdue: false,
      triage: false,
      warnStale: false,
      warnQcOpen: false,
      receivedAt: null,
      receivedBy: null,
      groupKey: null,
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
  // Whose screen is this? "I'll do it" must mean the VIEWER — Jordan tapping
  // it assigns Jordan, Kyle tapping it assigns Kyle (Aug 24: the chip was
  // hard-bound to Kyle, so the owner kept assigning Kyle by accident).
  // Resolved by teamMemberId/email, and when it CAN'T be resolved the chips
  // all show real names — a wrong "I'll do it" is worse than none (Aug 25).
  const { getCurrentUser } = await import("@/lib/auth/user");
  const { viewerAssigneeKey } = await import("@/lib/assignees");
  const me = await getCurrentUser().catch(() => null);
  const viewerKey = viewerAssigneeKey(me, assignees) ?? "";

  return (
    <div>
      <PageHeader
        eyebrow="Eastern time"
        title="Tasks"
        subtitle="Everything that needs you today — work down the stack and you're done."
      />
      <div className="p-4 sm:p-6">
        {tabs}
        <TodayFeed cards={cards} shoots={shoots} handledToday={handledToday} assignees={chips} viewerKey={viewerKey} tomorrowCount={shootWindow.tomorrow.length} initialGuided={sp.guided === "1"} />
      </div>
    </div>
  );
}
