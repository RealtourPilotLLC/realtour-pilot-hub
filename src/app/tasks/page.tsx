import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess } from "@/lib/auth/access";
import { TasksTabs, type TasksTab } from "@/components/tasks/TasksTabs";
import { BoardView, boardOpenCount } from "@/components/tasks/BoardView";
import { DoneView, doneTodayCount } from "@/components/tasks/DoneView";
import { CommsView, RevisionsView, SlackView, checklistCounts } from "@/components/tasks/ChecklistViews";
import { unansweredCommsBoard } from "@/lib/commsBoard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ONE Tasks hub (Jordan: "the toolbar has too many things — today, daily tasks,
// and task history could all be combined"), same consolidation pattern as
// /communications: Comms (the front door), Revisions, Slack, Other (the grouped
// queue — keeps ?who= / ?task=), Done (the day-by-day ledger). Each tab renders
// ONLY its own data, and each tab's badge is that view's OWN count query, so a
// badge can never point at a list that doesn't contain it.
//
// ?guided=1 was dropped from the accepted params (Sep 2): the guided one-card
// walkthrough went with /today on Aug 31, and this router never passed the
// param anywhere — a route that advertises a param it ignores is how a dead
// link survives a restructure (audit fault #9). Nothing links to it now.

export default async function TasksHubPage({ searchParams }: {
  searchParams: Promise<{ tab?: string; focus?: string; who?: string; task?: string; via?: string }>;
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
  const explicit = ["other", "done", "comms", "revisions", "slack"].includes(rawTab ?? "");
  let tab: TasksTab = boardOnly ? "other" : explicit ? (rawTab as TasksTab) : "comms";

  // A ?task= deep link has to land on the tab that HOLDS that row (Sep 16).
  // Slack asks now live only on the Slack tab, and every link minted before
  // today — the morning Slack DM, the home's Open Loops, a bookmark — points
  // at ?tab=other. Rather than leave those dead, resolve the row's source and
  // send it where it lives. One indexed lookup, only when ?task= is present.
  if (!boardOnly && sp.task && tab !== "done") {
    const t = await prisma.smartTask
      .findUnique({ where: { id: sp.task }, select: { source: true } })
      .catch(() => null);
    if (t?.source === "slack") tab = "slack";
  }

  const [otherN, doneN, checklists, phoneWaiting] = await Promise.all([
    boardOpenCount(),
    boardOnly ? 0 : doneTodayCount(),
    boardOnly ? { comms: 0, revisions: 0, slack: 0 } : checklistCounts(),
    // Only to decide which side of Comms to open on — see commsChannel below.
    boardOnly ? 0 : unansweredCommsBoard("phone").then((g) => g.length).catch(() => 0),
  ]);
  // The Comms badge counts Phone + Email, so defaulting to Phone when nobody is
  // waiting on a text lands a "Comms 5" tab on "Nobody is waiting on a text
  // reply" — the same fault the dashboard chips were just fixed for (#9). When
  // the phone side is empty and the badge isn't, open Email. An explicit ?via=
  // always wins.
  const commsChannel: "phone" | "email" =
    sp.via === "email" ? "email"
      : sp.via === "phone" ? "phone"
        : phoneWaiting === 0 && checklists.comms > 0 ? "email" : "phone";
  // Land where the work is (Kyle, Sep 16: "I thought this page had stopped
  // updating"). Opening on an empty Comms tab while 21 Slack asks sat one tab
  // over is the same fault the Phone/Email default was just fixed for: a tab
  // strip that says 21 and a page that says "nobody is waiting". An explicit
  // ?tab= always wins.
  if (!boardOnly && !explicit && checklists.comms === 0 && checklists.slack > 0) tab = "slack";
  const tabs = boardOnly ? null : (
    <TasksTabs
      tab={tab}
      otherCount={otherN}
      doneCount={doneN}
      commsCount={checklists.comms}
      revisionsCount={checklists.revisions}
      slackCount={checklists.slack}
      updatedAt={new Date()}
    />
  );

  if (tab === "other") return <BoardView sp={sp} tabs={tabs} />;
  if (tab === "done") return <DoneView tabs={tabs} />;
  if (tab === "revisions") return <RevisionsView tabs={tabs} />;
  // ?task=<id> lands on the row and highlights it — the digests deep-link here
  // now, and a link that drops you at the top of a 21-row list is not a link.
  if (tab === "slack") return <SlackView tabs={tabs} focusTaskId={sp.task ?? null} />;
  return <CommsView tabs={tabs} channel={commsChannel} />;
}
