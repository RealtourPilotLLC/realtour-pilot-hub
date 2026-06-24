"use client";

import Link from "next/link";
import { CalendarDays, Package, AlertTriangle, Camera, CircleAlert, CheckCircle2, RefreshCcw, Clock } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { SocialBadge } from "@/components/clients/SocialBadge";
import { DroneBadge, hasDroneOps } from "@/components/project/DroneBadge";
import { PRIORITY_META } from "@/lib/pipeline";
import { formatMoney } from "@/lib/utils";
import { statusFlag } from "@/lib/statusEvidence";
import type { PipelineProject } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { etDaysAgo, etTime, etMonthDay } from "@/lib/datetime";

function shootLabel(date: Date | null) {
  if (!date) return null;
  const d = new Date(date);
  // Bucket by ET calendar day — the server runs UTC, so naive date math would
  // mislabel a shoot's day (and time) by 4-5 hours.
  const daysUntil = -etDaysAgo(d);
  if (daysUntil === 0) return { text: `Today ${etTime(d)}`, soon: true };
  if (daysUntil === 1) return { text: "Tomorrow", soon: true };
  if (daysUntil > 1 && daysUntil <= 7) return { text: etMonthDay(d), soon: true };
  return { text: etMonthDay(d), soon: false };
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
  const flag = statusFlag(project.status, project.statusEvidence);

  return (
    <Link
      href={`/projects/${project.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", project.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.(project.id);
      }}
      className="panel-shadow lift group block cursor-grab rounded-xl border bg-surface p-3 active:cursor-grabbing"
    >
      {/* Title + price */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 truncate text-sm font-semibold leading-snug">{project.title}</div>
        {project.price != null && project.price > 0 && (
          <span className="shrink-0 text-xs font-semibold text-foreground/80">{formatMoney(project.price)}</span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
        <span className="min-w-0 truncate">
          {project.client.name}
          {project.client.company ? ` · ${project.client.company}` : ""}
        </span>
        <SegmentBadge segment={project.client.segment} size="xs" />
        <SocialBadge socialClient={project.client.socialClient} socialPlan={project.client.socialPlan} size="xs" />
        {hasDroneOps(project.deliverables) && <DroneBadge size="xs" />}
      </div>

      {showPriority && (
        <div className="mt-2">
          <Badge color={priority.color} soft={priority.soft}>
            {priority.label}
          </Badge>
        </div>
      )}

      {flag && (
        <div
          className={cn(
            "mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium",
            flag.kind === "missing"
              ? "bg-danger/10 text-danger"
              : flag.kind === "revision"
                ? "bg-[#d4a95f]/12 text-[#d4a95f]"
                : flag.kind === "pending"
                  ? "bg-[#6ba3d6]/12 text-[#6ba3d6]"
                  : "bg-success/10 text-success",
          )}
        >
          {flag.kind === "missing" ? (
            <CircleAlert className="size-3 shrink-0" />
          ) : flag.kind === "revision" ? (
            <RefreshCcw className="size-3 shrink-0" />
          ) : flag.kind === "pending" ? (
            <Clock className="size-3 shrink-0" />
          ) : (
            <CheckCircle2 className="size-3 shrink-0" />
          )}
          <span className="truncate">{flag.label}</span>
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
