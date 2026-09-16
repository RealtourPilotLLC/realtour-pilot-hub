import Link from "next/link";
import { ListTodo, History, MessageSquare, Repeat2, Hash, RefreshCw } from "lucide-react";
import { etTime } from "@/lib/datetime";

export type TasksTab = "comms" | "revisions" | "slack" | "other" | "done";

// CommsTabs-style switcher for the Tasks hub — same consolidation pattern as
// /communications: every tab is shareable via ?tab= and the page renders ONLY
// the active tab's data. Counts reuse each view's own (cheap) count query.
// `updatedAt` is when THIS render read the database. Kyle's call (Sep 16):
// "I thought the Tasks page wasn't being updated any more" — the page is
// force-dynamic and rebuilds on every visit, but nothing on it ever said so,
// and a page whose numbers you can't date is a page you stop trusting. The
// badges beside each tab are that tab's own count query, so the strip reads
// as one live line: what is open, and when we last looked.
export function TasksTabs({ tab, otherCount, doneCount, commsCount = 0, revisionsCount = 0, slackCount = 0, updatedAt }: {
  tab: TasksTab; otherCount: number; doneCount: number;
  commsCount?: number; revisionsCount?: number; slackCount?: number;
  updatedAt?: Date;
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
      {updatedAt && (
        <span
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-2"
          title="This page reads the database on every visit — this is when it last did."
        >
          <RefreshCw className="size-3" /> Updated {etTime(updatedAt)}
        </span>
      )}
    </div>
  );
}
