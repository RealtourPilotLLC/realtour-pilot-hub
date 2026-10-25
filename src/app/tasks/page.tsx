import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { addressableKeys, authEnforced } from "@/lib/auth/guards";
import { canAccess, isOffice } from "@/lib/auth/access";
import { TasksTabs, type TasksTab } from "@/components/tasks/TasksTabs";
import { BoardView, boardNavigationCounts } from "@/components/tasks/BoardView";
import { DoneView, doneTodayCount } from "@/components/tasks/DoneView";
import { RevisionsView, SlackView, checklistCounts } from "@/components/tasks/ChecklistViews";
import { prisma } from "@/lib/prisma";
import { isSyntheticClientRow } from "@/lib/testClients";
import { resolveTasksRoute } from "@/lib/taskNavigation";

export const dynamic = "force-dynamic";

// Ownership is the entry view for operational tasks. Dedicated reply, revision,
// Slack and history readers retain their membership and actions. Legacy tab
// URLs map to the same work they showed before this navigation change.

export default async function TasksHubPage({ searchParams }: {
  searchParams: Promise<{ tab?: string; focus?: string; who?: string; task?: string; via?: string; test?: string; source?: string; type?: string }>;
}) {
  const sp = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/tasks"); // transient null never renders the ops queue
  if (me && !canAccess(me, "tasks")) redirect("/");

  // Editors only ever get their own scoped board (exactly the old /queue view) —
  // the Today stack and Done ledger cover the whole team's work, which was never
  // theirs to see. No tab bar for them: the board IS their tasks page.
  // The creative manager the same (Oct 21 2026): their own tasks, never Kyle's
  // office list (BoardView scopes them through taskScopeOf).
  const boardOnly = me?.role === "EDITOR" || me?.role === "CREATIVE_MANAGER";
  const route = resolveTasksRoute(sp);
  let tab: TasksTab = boardOnly ? "work" : route.tab;
  const boardParams = { ...sp, who: route.who };

  // A ?task= deep link has to land on the tab that HOLDS that row (Sep 16).
  // Slack asks now live only on the Slack tab, and every link minted before
  // today — the morning Slack DM, the home's Open Loops, a bookmark — points
  // at ?tab=other. Rather than leave those dead, resolve the row's source and
  // send it where it lives. One indexed lookup, only when ?task= is present.
  if (!boardOnly && sp.task && tab !== "done") {
    // …and it reads only a row this viewer is allowed to read (RTP-01, Sep
    // 16): findUnique on a bare ?task= id resolved ANY task in the table
    // before any per-row check, which told a caller whether an id exists and
    // where it came from. The office sees the whole board, so it stays
    // unscoped for them; anyone else must own the row by one of their keys.
    const office = !me || isOffice(me.role);
    const t = await prisma.smartTask
      .findFirst({
        where: office ? { id: sp.task } : { id: sp.task, assignedKey: { in: [...(await addressableKeys(me))] } },
        select: { source: true },
      })
      .catch(() => null);
    if (t?.source === "slack") tab = "slack";
  }

  // THE REPLIES TAB IS MESSAGES NOW (Oct 19 2026: "Messages merges
  // Communications and Client messages into one inbox"). Everything it showed
  // (every client waiting on a text or email reply with Reply and Handled, what
  // they sent, and the promises at risk) is on Messages · Waiting on us, from
  // the same read. Old links (?tab=comms, ?tab=today via /today, the Slack
  // digest's "Unanswered" line, ?via=email) land there; the test view rides
  // along. Oct 21 2026 (audit F15): the tab itself is gone. Every default
  // role that has Tasks has Messages, so it was drawn for nobody; a login
  // whose access was hand-set without Messages lands on its work board.
  if (tab === "comms") {
    if (me && !canAccess(me, "communications")) redirect("/tasks");
    redirect(sp.test === "1" ? "/communications?test=1" : "/communications");
  }

  const showTestRevisions = tab === "revisions" && sp.test === "1";
  const showTestOther = tab === "work" && sp.test === "1";
  const showTestSlack = tab === "slack" && sp.test === "1";
  const showTestDone = tab === "done" && sp.test === "1";
  const syntheticClientIds = boardOnly ? []
    : (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id);
  const excludedRevisionClientIds = showTestRevisions ? [] : syntheticClientIds;
  const excludedOtherClientIds = showTestOther ? [] : syntheticClientIds;
  const excludedSlackClientIds = showTestSlack ? [] : syntheticClientIds;
  const excludedDoneClientIds = showTestDone ? [] : syntheticClientIds;

  const [workCounts, doneN, checklists] = await Promise.all([
    boardOnly ? { all: 0, mine: 0, needsAssignment: 0 } : boardNavigationCounts({ excludeClientIds: excludedOtherClientIds }),
    // The owner's books-audit items and pay questions count for the owner alone (audit Oct 25 2026, F7).
    boardOnly ? 0 : doneTodayCount({ excludeClientIds: excludedDoneClientIds, hideOwnerPrivate: !!me && me.role !== "OWNER" }),
    boardOnly ? { revisions: 0, slack: 0 } : checklistCounts({ excludeRevisionClientIds: excludedRevisionClientIds, excludeSlackClientIds: excludedSlackClientIds }),
  ]);
  const tabs = boardOnly ? null : (
    <TasksTabs
      tab={tab}
      who={route.who}
      allCount={workCounts.all}
      mineCount={workCounts.mine}
      needsAssignmentCount={workCounts.needsAssignment}
      doneCount={doneN}
      revisionsCount={checklists.revisions}
      showTest={sp.test === "1"}
      slackCount={checklists.slack}
      updatedAt={new Date()}
    />
  );

  if (tab === "work") return <BoardView sp={boardParams} tabs={tabs} excludeClientIds={excludedOtherClientIds} excludeRelatedClientIds={syntheticClientIds} showTest={showTestOther} />;
  if (tab === "done") return <DoneView tabs={tabs} excludeClientIds={excludedDoneClientIds} showTest={showTestDone} />;
  if (tab === "revisions") return <RevisionsView tabs={tabs} excludeClientIds={excludedRevisionClientIds} showTest={showTestRevisions} />;
  // ?task=<id> lands on the row and highlights it — the digests deep-link here
  // now, and a link that drops you at the top of a 21-row list is not a link.
  return <SlackView tabs={tabs} focusTaskId={sp.task ?? null} excludeClientIds={excludedSlackClientIds} showTest={showTestSlack} />;
}
