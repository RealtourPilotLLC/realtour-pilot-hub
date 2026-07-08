import Link from "next/link";
import { Sun, ListTodo, History } from "lucide-react";

export type TasksTab = "today" | "board" | "done";

// CommsTabs-style switcher for the Tasks hub — same consolidation pattern as
// /communications: every tab is shareable via ?tab= and the page renders ONLY
// the active tab's data. Counts reuse each view's own (cheap) count query.
export function TasksTabs({ tab, todayCount, boardCount, doneCount }: {
  tab: TasksTab; todayCount: number; boardCount: number; doneCount: number;
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
      <Link href="/tasks" className={tab === "today" ? active : idle}>
        <Sun className="mr-1.5 inline size-3.5" />
        Today
        {badge(todayCount, tab === "today")}
      </Link>
      <Link href="/tasks?tab=board" className={tab === "board" ? active : idle}>
        <ListTodo className="mr-1.5 inline size-3.5" />
        Board
        {badge(boardCount, tab === "board")}
      </Link>
      <Link href="/tasks?tab=done" className={tab === "done" ? active : idle}>
        <History className="mr-1.5 inline size-3.5" />
        Done
        {badge(doneCount, tab === "done")}
      </Link>
    </div>
  );
}
