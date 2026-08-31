import Link from "next/link";
import { ListTodo, History, MessageSquare, Repeat2, Hash } from "lucide-react";

export type TasksTab = "comms" | "revisions" | "slack" | "other" | "done";

// CommsTabs-style switcher for the Tasks hub — same consolidation pattern as
// /communications: every tab is shareable via ?tab= and the page renders ONLY
// the active tab's data. Counts reuse each view's own (cheap) count query.
export function TasksTabs({ tab, otherCount, doneCount, commsCount = 0, revisionsCount = 0, slackCount = 0 }: {
  tab: TasksTab; otherCount: number; doneCount: number;
  commsCount?: number; revisionsCount?: number; slackCount?: number;
}) {
  const active = "rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white";
  const idle = "rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2";
  const badge = (n: number, on: boolean) =>
    n > 0 ? (
      <span className={`ml-1.5 rounded-full px-1.5 text-xs font-semibold ${on ? "bg-white/20" : "bg-brand/15 text-brand"}`}>
        {n}
      </span>
    ) : null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <Link href="/tasks" className={tab === "comms" ? active : idle}>
        <MessageSquare className="mr-1.5 inline size-3.5" />
        Comms
        {badge(commsCount, tab === "comms")}
      </Link>
      <Link href="/tasks?tab=revisions" className={tab === "revisions" ? active : idle}>
        <Repeat2 className="mr-1.5 inline size-3.5" />
        Revisions
        {badge(revisionsCount, tab === "revisions")}
      </Link>
      <Link href="/tasks?tab=slack" className={tab === "slack" ? active : idle}>
        <Hash className="mr-1.5 inline size-3.5" />
        Slack
        {badge(slackCount, tab === "slack")}
      </Link>
      <Link href="/tasks?tab=other" className={tab === "other" ? active : idle}>
        <ListTodo className="mr-1.5 inline size-3.5" />
        Other
        {badge(otherCount, tab === "other")}
      </Link>
      <Link href="/tasks?tab=done" className={tab === "done" ? active : idle}>
        <History className="mr-1.5 inline size-3.5" />
        Done
        {badge(doneCount, tab === "done")}
      </Link>
    </div>
  );
}
