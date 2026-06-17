"use client";

import { useState, useTransition } from "react";
import { PIPELINE_STAGES, SIDE_STATES } from "@/lib/pipeline";
import { ProjectCard } from "@/components/ProjectCard";
import { moveProjectStatus } from "@/app/actions";
import type { PipelineProject } from "@/lib/queries";
import type { ProjectStatus } from "@prisma/client";
import { cn } from "@/lib/utils";

export function PipelineBoard({ projects }: { projects: PipelineProject[] }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<ProjectStatus | null>(null);
  const [isPending, transition] = useTransition();

  // Optimistic local copy so cards jump columns instantly.
  const [items, setItems] = useState(projects);

  // Keep in sync if server data changes (after revalidate).
  if (projects !== items && !isPending && dragId === null) {
    // shallow compare by id+status signature
    const sig = (arr: PipelineProject[]) =>
      arr.map((p) => p.id + p.status).join(",");
    if (sig(projects) !== sig(items)) setItems(projects);
  }

  function handleDrop(status: ProjectStatus) {
    setOverStage(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const current = items.find((p) => p.id === id);
    if (!current || current.status === status) return;

    setItems((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status } : p)),
    );
    transition(async () => {
      await moveProjectStatus(id, status);
    });
  }

  const columns = [...PIPELINE_STAGES];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 gap-3 overflow-x-auto scroll-thin px-6 py-4">
        {columns.map((stage) => {
          const colItems = items.filter((p) => p.status === stage.status);
          const isOver = overStage === stage.status;
          return (
            <div
              key={stage.status}
              className="flex w-72 shrink-0 flex-col"
              onDragOver={(e) => {
                e.preventDefault();
                setOverStage(stage.status);
              }}
              onDragLeave={(e) => {
                // only clear if leaving the column entirely
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setOverStage((s) => (s === stage.status ? null : s));
                }
              }}
              onDrop={() => handleDrop(stage.status)}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: stage.color }}
                  />
                  <span className="text-sm font-semibold">{stage.label}</span>
                  <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">
                    {colItems.length}
                  </span>
                </div>
              </div>
              <div
                className={cn(
                  "flex flex-1 flex-col gap-2 rounded-xl border border-dashed p-2 transition-colors",
                  isOver
                    ? "border-brand bg-brand-soft/50"
                    : "border-transparent bg-surface-2/40",
                )}
              >
                {colItems.map((p) => (
                  <ProjectCard key={p.id} project={p} onDragStart={setDragId} />
                ))}
                {colItems.length === 0 && (
                  <div className="flex h-20 items-center justify-center rounded-lg text-xs text-muted-2">
                    {isOver ? "Drop here" : "—"}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Off-pipeline states */}
      {SIDE_STATES.some((s) => items.some((p) => p.status === s.status)) && (
        <div className="border-t bg-surface px-6 py-3">
          <div className="flex gap-6">
            {SIDE_STATES.map((stage) => {
              const colItems = items.filter((p) => p.status === stage.status);
              if (colItems.length === 0) return null;
              return (
                <div
                  key={stage.status}
                  className="flex-1"
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverStage(stage.status);
                  }}
                  onDrop={() => handleDrop(stage.status)}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: stage.color }}
                    />
                    <span className="text-sm font-semibold">{stage.label}</span>
                    <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">
                      {colItems.length}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {colItems.map((p) => (
                      <div key={p.id} className="w-72">
                        <ProjectCard project={p} onDragStart={setDragId} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
