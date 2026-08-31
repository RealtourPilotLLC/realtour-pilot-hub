import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { TasksTabs, type TasksTab } from "@/components/tasks/TasksTabs";
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
  // Comms is the front door now (Jordan, Sep 1: Today + Board removed —
  // "they should just be going to Comms, Revisions and Slack; the rest can
  // go to an Other tab"). Old links: ?tab=board|today land sensibly.
  const rawTab = sp.tab === "board" ? "other" : sp.tab === "today" ? "comms" : sp.tab;
  const tab: TasksTab = boardOnly
    ? "other"
    : ["other", "done", "comms", "revisions", "slack"].includes(rawTab ?? "")
      ? (rawTab as TasksTab)
      : "comms";

  const [otherN, doneN, checklists] = await Promise.all([
    boardOpenCount(),
    boardOnly ? 0 : doneTodayCount(),
    boardOnly ? { comms: 0, revisions: 0, slack: 0 } : checklistCounts(),
  ]);
  const tabs = boardOnly ? null : (
    <TasksTabs
      tab={tab}
      otherCount={otherN}
      doneCount={doneN}
      commsCount={checklists.comms}
      revisionsCount={checklists.revisions}
      slackCount={checklists.slack}
    />
  );

  if (tab === "other") return <BoardView sp={sp} tabs={tabs} />;
  if (tab === "done") return <DoneView tabs={tabs} />;
  if (tab === "revisions") return <RevisionsView tabs={tabs} />;
  if (tab === "slack") return <SlackView tabs={tabs} />;
  return <CommsView tabs={tabs} channel={sp.via === "email" ? "email" : "phone"} />;
}
