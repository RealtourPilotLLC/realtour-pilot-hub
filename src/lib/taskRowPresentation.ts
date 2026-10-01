import type { QueueTask } from "@/components/queue/TaskCard";
import { isNeedsAssigning } from "@/lib/triage";

export type TaskRowAction = { label: string; focus: "details" | "assign" | "draft"; href?: string };

/** Navigation only: opening task work never completes it, sends or starts editing. */
export function taskRowAction(task: Pick<QueueTask, "taskType" | "assignedKey" | "status" | "projectId" | "outputId">, editorView = false): TaskRowAction {
  if (task.status === "COMPLETED") return { label: "View completion", focus: "details" };
  if (task.status === "CANCELLED") return { label: "View details", focus: "details" };
  if (isNeedsAssigning(task)) return { label: "Assign", focus: "assign" };
  if (task.taskType === "edit_video" && task.projectId) return { label: "Open edit", focus: "details", href: `/edit/${task.projectId}` };
  // A task may cover several outputs. Keep its complete request in view rather
  // than guessing a cut from a property, a title, or the newest submission.
  if (task.taskType === "revision") return task.projectId && task.outputId
    ? { label: "Open revised output", focus: "details", href: `/edit/${encodeURIComponent(task.projectId)}#brief-${encodeURIComponent(task.outputId)}` }
    : { label: "Review revision", focus: "details" };
  if (["confirmation_text", "delivery_text"].includes(task.taskType)) return { label: "Review text", focus: "details" };
  if (["client_reply", "lead", "feedback_review"].includes(task.taskType)) return { label: "Review reply", focus: editorView ? "details" : "draft" };
  if (["comms_followup", "callback"].includes(task.taskType)) return { label: "Review message", focus: "details" };
  if (["media_qa", "image_fixes", "delivery", "finish_delivery"].includes(task.taskType)) return { label: "Review work", focus: "details" };
  return { label: "Open task", focus: "details" };
}
