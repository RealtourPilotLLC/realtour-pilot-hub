"use client";

import Link from "next/link";
import { CalendarDays, CheckSquare, MessageCircle, AlertTriangle } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { PRIORITY_META, DELIVERABLE_META } from "@/lib/pipeline";
import type { PipelineProject } from "@/lib/queries";
import { cn } from "@/lib/utils";

function dueLabel(due: Date | null) {
  if (!due) return null;
  const d = new Date(due);
  const now = new Date();
  const days = Math.round((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  const text =
    days < 0
      ? `${Math.abs(days)}d overdue`
      : days === 0
        ? "Due today"
        : days === 1
          ? "Due tomorrow"
          : `Due in ${days}d`;
  const overdue = days < 0;
  const urgent = days <= 1;
  return { text, overdue, urgent };
}

export function ProjectCard({
  project,
  onDragStart,
}: {
  project: PipelineProject;
  onDragStart?: (id: string) => void;
}) {
  const priority = PRIORITY_META[project.priority];
  const due = dueLabel(project.deliveryDue);
  const doneCount = project.checklist.filter((c) => c.done).length;
  const flagged = project.deliverables.some((d) => d.status === "FLAGGED");
  const assignees = [project.photographer, project.editor, project.va].filter(Boolean);

  return (
    <Link
      href={`/projects/${project.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", project.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.(project.id);
      }}
      className="group block cursor-grab rounded-xl border bg-surface p-3 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{project.title}</div>
          <div className="truncate text-xs text-muted">
            {project.client.name}
            {project.client.company ? ` · ${project.client.company}` : ""}
          </div>
        </div>
        {project.priority !== "NORMAL" && project.priority !== "LOW" && (
          <Badge color={priority.color} soft={priority.soft}>
            {priority.label}
          </Badge>
        )}
      </div>

      {project.deliverables.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {project.deliverables.slice(0, 4).map((d) => (
            <span
              key={d.id}
              className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted"
            >
              {DELIVERABLE_META[d.type].label}
              {d.quantity > 1 ? ` ×${d.quantity}` : ""}
            </span>
          ))}
          {project.deliverables.length > 4 && (
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
              +{project.deliverables.length - 4}
            </span>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] text-muted">
          {due && (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                due.overdue && "font-semibold text-danger",
                !due.overdue && due.urgent && "font-medium text-warning",
              )}
            >
              <CalendarDays className="size-3" />
              {due.text}
            </span>
          )}
          {project.checklist.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <CheckSquare className="size-3" />
              {doneCount}/{project.checklist.length}
            </span>
          )}
          {project._count.activities > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="size-3" />
              {project._count.activities}
            </span>
          )}
          {flagged && (
            <span className="inline-flex items-center gap-1 font-medium text-danger">
              <AlertTriangle className="size-3" />
              Flag
            </span>
          )}
        </div>
        <div className="flex -space-x-1.5">
          {assignees.map(
            (m) =>
              m && (
                <span key={m.id} className="ring-2 ring-surface rounded-full">
                  <Avatar name={m.name} color={m.avatarColor} size={22} />
                </span>
              ),
          )}
        </div>
      </div>
    </Link>
  );
}
