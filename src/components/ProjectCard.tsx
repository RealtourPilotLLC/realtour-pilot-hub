"use client";

import Link from "next/link";
import { CalendarDays, Package, AlertTriangle, Camera } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { PRIORITY_META } from "@/lib/pipeline";
import { formatMoney } from "@/lib/utils";
import type { PipelineProject } from "@/lib/queries";
import { cn } from "@/lib/utils";

function shootLabel(date: Date | null) {
  if (!date) return null;
  const d = new Date(date);
  const now = new Date();
  const days = Math.round((d.getTime() - new Date(now.toDateString()).getTime()) / 86400000);
  const fmt = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days === 0)
    return { text: `Today ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`, soon: true };
  if (days === 1) return { text: "Tomorrow", soon: true };
  if (days > 0 && days <= 7) return { text: fmt, soon: true };
  return { text: fmt, soon: false };
}

export function ProjectCard({
  project,
  onDragStart,
}: {
  project: PipelineProject;
  onDragStart?: (id: string) => void;
}) {
  const priority = PRIORITY_META[project.priority];
  const shoot = shootLabel(project.shootDate);
  const flagged = project.deliverables.some((d) => d.status === "FLAGGED");
  const itemCount = project.deliverables.length;
  const showPriority = project.priority === "HIGH" || project.priority === "URGENT";

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
      {/* Title + price */}
      <div className="flex items-start justify-between gap-2">
        <div className="truncate text-sm font-semibold leading-snug">{project.title}</div>
        {project.price != null && project.price > 0 && (
          <span className="shrink-0 text-xs font-semibold text-foreground/80">{formatMoney(project.price)}</span>
        )}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted">
        {project.client.name}
        {project.client.company ? ` · ${project.client.company}` : ""}
      </div>

      {showPriority && (
        <div className="mt-2">
          <Badge color={priority.color} soft={priority.soft}>
            {priority.label}
          </Badge>
        </div>
      )}

      {/* Footer meta */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 text-[11px] text-muted">
          {shoot && (
            <span className={cn("inline-flex items-center gap-1", shoot.soon && "font-medium text-foreground/80")}>
              <CalendarDays className="size-3" />
              {shoot.text}
            </span>
          )}
          {itemCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Package className="size-3" />
              {itemCount}
            </span>
          )}
          {flagged && (
            <span className="inline-flex items-center gap-1 font-medium text-danger">
              <AlertTriangle className="size-3" />
            </span>
          )}
        </div>
        {project.photographer ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted">
            <Avatar name={project.photographer.name} color={project.photographer.avatarColor} size={20} />
            <span className="max-w-[90px] truncate">{project.photographer.name.split(" ")[0]}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-2">
            <Camera className="size-3" /> Unassigned
          </span>
        )}
      </div>
    </Link>
  );
}
