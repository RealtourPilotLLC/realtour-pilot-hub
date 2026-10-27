// What a side panel on Jordan's dashboard shows. Plain data only: the server
// sections build these and the client shell renders them, so nothing here
// may hold a function or a Date.
import type { AssignSeed, ClientIssueRow, RowAction, Tone } from "@/lib/ownerDashboard";
import type { DelegatedRow, EmailRow, MeetingRow } from "@/lib/ownerWork";
import type { BottleneckTopic } from "@/lib/ownerTopicsCore";

export type RosterOption = { key: string; name: string };

/** A row button the client shell runs itself (a task panel needs the server's read: rows carry `open` for that). */
export type ShellAction = Exclude<RowAction, { kind: "task" }>;

export type ListRow = {
  id: string;
  title: string;
  sub?: string | null;
  tone?: Tone | null;
  href?: string | null;
  assign?: AssignSeed | null;
  /** the row's own button (Oct 27 2026), shown instead of Assign */
  action?: ShellAction | null;
  /** clicking the row opens this panel instead of following href */
  open?: PanelSpec | null;
};

export type PanelSpec =
  | { kind: "assign"; seed: AssignSeed; heading?: string }
  | { kind: "task"; task: DelegatedRow }
  | { kind: "list"; title: string; subtitle?: string | null; rows: ListRow[]; empty?: string }
  | { kind: "email"; row: EmailRow }
  | { kind: "issue"; row: ClientIssueRow }
  | { kind: "meeting"; row: MeetingRow }
  /** a bottleneck topic (Loom, Oct 27 2026): its records, and Review / Delegate / Make it my task / Mark handled / Snooze */
  | { kind: "topic"; topic: BottleneckTopic; rows: ListRow[] }
  | { kind: "info"; title: string; lines: { label: string; value: string }[] };
