import Link from "next/link";
import { ListTodo, History, MessageSquare, Repeat2, Hash, RefreshCw, UserRound, UserPlus } from "lucide-react";
import { etTime } from "@/lib/datetime";
import { taskWorkHref, type TasksTab } from "@/lib/taskNavigation";
export type { TasksTab } from "@/lib/taskNavigation";

// Ownership leads the operational board. Specialist queues retain their own
// membership, actions, counts and shareable URLs.
export function TasksTabs({ tab, who, allCount, mineCount, needsAssignmentCount, doneCount, commsCount = 0, revisionsCount = 0, slackCount = 0, updatedAt, showTest = false }: {
  tab: TasksTab; who: string; allCount: number; mineCount: number; needsAssignmentCount: number; doneCount: number;
  commsCount?: number; revisionsCount?: number; slackCount?: number;
  updatedAt?: Date; showTest?: boolean;
}) {
  const active = "rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
  const idle = "rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
  const badge = (n: number, on: boolean) => n > 0 ? (
    <span className={`ml-1.5 rounded-full px-1.5 text-xs font-semibold ${on ? "bg-white/20" : "bg-brand/15 text-brand"}`}>{n}</span>
  ) : null;
  const mine = tab === "work" && who === "me";
  const needsAssignment = tab === "work" && who === "needs-assigning";
  const all = tab === "work" && who === "all";
  const workTest = tab === "work" && showTest;
  const sourceLink = (target: TasksTab) => `/tasks?tab=${target}${tab === target && showTest ? "&test=1" : ""}`;
  return (
    <div className="mb-4 space-y-3">
      <nav aria-label="Task work views" className="flex flex-wrap items-center gap-1.5">
        <Link href={taskWorkHref({ who: "me", showTest: workTest })} aria-current={mine ? "page" : undefined} className={mine ? active : idle}>
          <UserRound aria-hidden="true" className="mr-1.5 inline size-4" />My work{badge(mineCount, mine)}
        </Link>
        <Link href={taskWorkHref({ who: "needs-assigning", showTest: workTest })} aria-current={needsAssignment ? "page" : undefined} className={needsAssignment ? active : idle}>
          <UserPlus aria-hidden="true" className="mr-1.5 inline size-4" />Needs assignment{badge(needsAssignmentCount, needsAssignment)}
        </Link>
        <Link href={taskWorkHref({ who: "all", showTest: workTest })} aria-current={all ? "page" : undefined} className={all ? active : idle}>
          <ListTodo aria-hidden="true" className="mr-1.5 inline size-4" />All work{badge(allCount, all)}
        </Link>
        <Link href={sourceLink("done")} aria-current={tab === "done" ? "page" : undefined} className={tab === "done" ? active : idle} title="Completed work; badge counts today">
          <History aria-hidden="true" className="mr-1.5 inline size-4" />Completed{badge(doneCount, tab === "done")}
        </Link>
        {updatedAt && <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-2" title="Read from the database on this visit">
          <RefreshCw aria-hidden="true" className="size-3" /> Updated {etTime(updatedAt)}
        </span>}
      </nav>
      <nav aria-label="Specialist task queues" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm text-muted">Specialist queues</span>
        <Link href={sourceLink("comms")} aria-current={tab === "comms" ? "page" : undefined} className={tab === "comms" ? active : idle}>
          <MessageSquare aria-hidden="true" className="mr-1.5 inline size-4" />Replies{badge(commsCount, tab === "comms")}
        </Link>
        <Link href={sourceLink("revisions")} aria-current={tab === "revisions" ? "page" : undefined} className={tab === "revisions" ? active : idle}>
          <Repeat2 aria-hidden="true" className="mr-1.5 inline size-4" />Revisions{badge(revisionsCount, tab === "revisions")}
        </Link>
        <Link href={sourceLink("slack")} aria-current={tab === "slack" ? "page" : undefined} className={tab === "slack" ? active : idle}>
          <Hash aria-hidden="true" className="mr-1.5 inline size-4" />Slack{badge(slackCount, tab === "slack")}
        </Link>
      </nav>
      <p className="text-sm text-muted">Work views show operational tasks. Use the specialist queues for client replies, revision follow-through, and Slack asks.</p>
    </div>
  );
}
