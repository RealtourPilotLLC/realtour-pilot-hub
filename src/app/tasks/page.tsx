import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { clientTextWhere } from "@/lib/clientTexts";
import { TasksTabs, type TasksTab } from "@/components/tasks/TasksTabs";
import { TodayView, todayCardCount } from "@/components/tasks/TodayView";
import { BoardView, boardOpenCount } from "@/components/tasks/BoardView";
import { DoneView, doneTodayCount } from "@/components/tasks/DoneView";
import { UnansweredPill } from "@/components/tasks/UnansweredPill";
import { replyWaitingSummary } from "@/lib/replyQueue";

export const dynamic = "force-dynamic";

// ONE Tasks hub (Jordan: "the toolbar has too many things — today, daily tasks,
// and task history could all be combined"), three tabs, same consolidation
// pattern as /communications: Today = the finish-able action stack (default,
// keeps ?guided=1 / ?focus=), Board = the full grouped queue (keeps ?who= /
// ?task=), Done = the day-by-day ledger. Each tab renders ONLY its own data;
// the old /today, /queue and /history routes redirect here with their params.

export default async function TasksHubPage({ searchParams }: {
  searchParams: Promise<{ tab?: string; guided?: string; focus?: string; who?: string; task?: string }>;
}) {
  const sp = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/tasks"); // transient null never renders the ops queue
  if (me && !canAccess(me, "tasks")) redirect("/");

  // Editors only ever get their own scoped board (exactly the old /queue view) —
  // the Today stack and Done ledger cover the whole team's work, which was never
  // theirs to see. No tab bar for them: the board IS their tasks page.
  const boardOnly = me?.role === "EDITOR";
  const tab: TasksTab = boardOnly ? "board" : sp.tab === "board" || sp.tab === "done" ? sp.tab : "today";

  const [todayN, boardN, doneN, replies] = await Promise.all([
    boardOnly ? 0 : todayCardCount(),
    boardOpenCount(),
    boardOnly ? 0 : doneTodayCount(),
    // Inbound texts still owed an answer. Counted from the comms log, not from
    // reply TASKS, so the texts nobody ever filed a task for still show up —
    // those are the ones that get forgotten. Editors never see client comms.
    boardOnly ? { count: 0, oldestHours: 0 } : replyWaitingSummary(),
  ]);
  const tabs = boardOnly ? null : (
    <div className="flex flex-wrap items-center gap-2">
      <TasksTabs tab={tab} todayCount={todayN} boardCount={boardN} doneCount={doneN} />
      {/* Send-All moved to its one home, the comms Outbox (audit). */}
      {replies.count > 0 && <UnansweredPill count={replies.count} oldestHours={replies.oldestHours} />}
    </div>
  );

  if (tab === "board") return <BoardView sp={sp} tabs={tabs} />;
  if (tab === "done") return <DoneView tabs={tabs} />;
  return <TodayView sp={sp} tabs={tabs} />;
}
