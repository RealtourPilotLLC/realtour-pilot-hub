import type { QueueTask, DeliverableStatus } from "@/components/queue/TaskCard";
import { parseChecklist } from "@/lib/checklist";

// One place that turns a SmartTask row (with its client) into the shape the
// TaskCard renders — used by both the Daily Tasks queue and the project page so
// they never drift. For a QC task the checklist JSON becomes a read-only
// live/pending deliverable status (the checklist is no longer an interactive UI).
export type TaskRow = {
  id: string;
  title: string;
  taskType: string;
  status: string;
  priority: string;
  dueAt: Date | null;
  createdAt: Date | null;
  reasonCreated: string | null;
  summary: string | null;
  description: string | null;
  checklist: string | null;
  source: string;
  sourceDetail: string | null;
  assignedKey: string | null;
  projectId: string | null;
  clientId: string | null;
  propertyAddress: string | null;
  client: { name: string } | null;
};

export function taskToView(t: TaskRow): QueueTask {
  const deliverables: DeliverableStatus[] =
    t.taskType === "media_qa" ? parseChecklist(t.checklist).map((i) => ({ label: i.label, done: i.done })) : [];
  return {
    id: t.id,
    title: t.title,
    taskType: t.taskType,
    status: t.status,
    priority: t.priority,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    createdAt: t.createdAt ? t.createdAt.toISOString() : null,
    reasonCreated: t.reasonCreated,
    summary: t.summary,
    description: t.description,
    deliverables,
    source: t.source,
    sourceDetail: t.sourceDetail,
    assignedKey: t.assignedKey,
    projectId: t.projectId,
    clientId: t.clientId,
    clientName: t.client?.name ?? null,
    propertyAddress: t.propertyAddress,
  };
}
