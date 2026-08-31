import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { TasksTabs, type TasksTab } from "@/components/tasks/TasksTabs";
import { TodayView, todayCardCount } from "@/components/tasks/TodayView";
import { BoardView, boardOpenCount } from "@/components/tasks/BoardView";
import { DoneView, doneTodayCount } from "@/components/tasks/DoneView";
import { CommsView, RevisionsView, SlackView, checklistCounts } from "@/components/tasks/ChecklistViews";

export const dynamic = "force-dynamic";

// ONE Tasks hub (Jordan: "the toolbar has too many things — today, daily tasks,
// and task history could all be combined"), three tabs, same consolidation
// pattern as /communications: Today = the finish-able action stack (default,
// keeps ?guided=1 / ?focus=), Board = the full grouped queue (keeps ?who= /
// ?task=), Done = the day-by-day ledger. Each tab renders ONLY its own data;
// the old /today, /queue and /history routes redirect here with their params.

export default async function TasksHubPage({ searchParams }: {
  searchParams: Promise<{ tab?: string; guided?: string; focus?: string; who?: string; task?: string; via?: string }>;
}) {
  const sp = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/tasks"); // transient null never renders the ops queue
  if (me && !canAccess(me, "tasks")) redirect("/");

  // Editors only ever get their own scoped board (exactly the old /queue view) —
  // the Today stack and Done ledger cover the whole team's work, which was never
  // theirs to see. No tab bar for them: the board IS their tasks page.
  const boardOnly = me?.role === "EDITOR";
  const tab: TasksTab = boardOnly
    ? "board"
    : ["board", "done", "comms", "revisions", "slack"].includes(sp.tab ?? "")
      ? (sp.tab as TasksTab)
      : "today";

  const [todayN, boardN, doneN, checklists] = await Promise.all([
    boardOnly ? 0 : todayCardCount(),
    boardOpenCount(),
    boardOnly ? 0 : doneTodayCount(),
    // The Comms/Revisions/Slack checklists (Jordan, Sep 1) — comm items no
    // longer clog the board; the badges show what's waiting. Editors never
    // see client comms.
    boardOnly ? { comms: 0, revisions: 0, slack: 0 } : checklistCounts(),
  ]);
  const tabs = boardOnly ? null : (
    <TasksTabs
      tab={tab}
      todayCount={todayN}
      boardCount={boardN}
      doneCount={doneN}
      commsCount={checklists.comms}
      revisionsCount={checklists.revisions}
      slackCount={checklists.slack}
    />
  );

  if (tab === "board") return <BoardView sp={sp} tabs={tabs} />;
  if (tab === "done") return <DoneView tabs={tabs} />;
  if (tab === "comms") return <CommsView tabs={tabs} channel={sp.via === "email" ? "email" : "phone"} />;
  if (tab === "revisions") return <RevisionsView tabs={tabs} />;
  if (tab === "slack") return <SlackView tabs={tabs} />;
  return <TodayView sp={sp} tabs={tabs} />;
}
