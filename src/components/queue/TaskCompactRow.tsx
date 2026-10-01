"use client";

import Link from "next/link";
import { Clock, Loader2 } from "lucide-react";
import { sourceMeta, taskTypeLabel } from "@/lib/taskSource";
import { taskWorkOwner } from "@/lib/taskNavigation";
import { taskRowAction, type TaskRowAction } from "@/lib/taskRowPresentation";
import type { QueueTask } from "@/components/queue/TaskCard";

const control = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";

export function TaskCompactRow({ task, assignees, editorView, busy, dueInfo, assignmentNote, onAssign, onOpen }: {
  task: QueueTask;
  assignees: { key: string; name: string }[];
  editorView?: boolean;
  busy: boolean;
  dueInfo: { text: string; overdue: boolean } | null;
  assignmentNote: string | null;
  onAssign: (key: string) => void;
  onOpen: (focus: TaskRowAction["focus"]) => void;
}) {
  const action = taskRowAction(task, editorView);
  const owner = taskWorkOwner(task) ?? "";
  const source = sourceMeta(task.source, task);
  const overdue = dueInfo?.overdue && task.status !== "COMPLETED";
  const completedSteps = task.deliverables.filter((item) => item.done).length;
  return (
    <article id={`task-${task.id}`} data-task-row className="scroll-mt-24 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <button type="button" aria-haspopup="dialog" onClick={() => onOpen("details")} className="min-h-11 w-full rounded-md text-left text-sm font-semibold leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            {task.title}
          </button>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span>{taskTypeLabel(task.taskType)}</span>
            <span>· {source.label}</span>
            {(task.contactName ?? task.clientName) && <span>· {task.contactName ?? task.clientName}</span>}
            {task.propertyAddress && <span className="break-words">· {task.propertyAddress}</span>}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span className={task.priority === "URGENT" ? "font-medium text-danger" : task.priority === "HIGH" ? "font-medium text-warning" : ""}>{task.priority.toLowerCase()} priority</span>
            <span>{task.status.toLowerCase().replaceAll("_", " ")}</span>
            <span className={overdue ? "font-medium text-danger" : ""}><Clock aria-hidden="true" className="mr-1 inline size-3.5" />{dueInfo ? `${overdue ? "Overdue" : "Due"} · ${dueInfo.text}` : "No due date"}</span>
            {task.deliverables.length > 0 && <span>{completedSteps}/{task.deliverables.length} steps recorded</span>}
          </p>
        </div>
        <div className="flex max-w-full flex-wrap items-end gap-2 sm:ml-auto">
          {task.status !== "COMPLETED" && task.status !== "CANCELLED" && (
            <label className="block max-w-full text-sm text-muted">
              <span className="mb-1 block">Owner</span>
              <select aria-label={`Owner for ${task.title}`} value={owner} disabled={busy} onChange={(event) => onAssign(event.target.value)} className="min-h-11 max-w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-brand">
                {!owner && <option value="">Unassigned</option>}
                {owner && !assignees.some((person) => person.key === owner) && <option value={owner}>{owner}</option>}
                {assignees.map((person) => <option key={person.key} value={person.key}>{person.name}</option>)}
              </select>
            </label>
          )}
          {action.href ? <Link href={action.href} className={`${control} bg-brand-action text-brand-fg`}>{action.label}</Link> : (
            <button type="button" aria-haspopup="dialog" disabled={busy} onClick={() => onOpen(action.focus)} className={`${control} bg-brand-action text-brand-fg`}>{busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}{action.label}</button>
          )}
        </div>
      </div>
      {busy && <p role="status" className="mt-2 text-sm text-muted">Updating this task…</p>}
      {assignmentNote && <p role="alert" className="mt-2 text-sm text-danger">{assignmentNote}</p>}
    </article>
  );
}
