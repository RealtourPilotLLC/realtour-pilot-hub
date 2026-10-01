import { isNeedsAssigning } from "@/lib/triage";

export type TasksTab = "work" | "comms" | "revisions" | "slack" | "done";
export type TaskWorkRow = { assignedKey: string | null; taskType: string };

/** Keep bookmarked source tabs and owner links meaningful after the new entry view. */
export function resolveTasksRoute(sp: { tab?: string; who?: string; task?: string }) {
  const legacyBoard = sp.tab === "other" || sp.tab === "board";
  const mapped = legacyBoard ? "work" : sp.tab === "today" ? "comms" : sp.tab;
  const tab: TasksTab = ["work", "comms", "revisions", "slack", "done"].includes(mapped ?? "")
    ? mapped as TasksTab : "work";
  // Existing task links must not disappear behind the new default My work filter.
  const who = (sp.who ?? (legacyBoard || sp.task ? "all" : "me")).toLowerCase();
  return { tab, who };
}

/** Routine unassigned work still belongs to Kyle; delegatable work needs assignment. */
export function taskWorkOwner(row: TaskWorkRow): string | null {
  return isNeedsAssigning(row) ? null : row.assignedKey || "kyle";
}

export function taskWorkCounts(rows: TaskWorkRow[], viewerKey: string | null) {
  return {
    all: rows.length,
    mine: viewerKey ? rows.filter((row) => taskWorkOwner(row) === viewerKey).length : 0,
    needsAssignment: rows.filter(isNeedsAssigning).length,
  };
}

export function taskWorkHref(opts: { who?: string; showTest?: boolean; source?: string; type?: string } = {}) {
  const query = new URLSearchParams({ tab: "work", who: opts.who ?? "all" });
  if (opts.showTest) query.set("test", "1");
  if (opts.source) query.set("source", opts.source);
  if (opts.type) query.set("type", opts.type);
  return `/tasks?${query}`;
}
