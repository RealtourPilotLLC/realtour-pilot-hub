"use client";

import { useMemo, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { PIPELINE_STAGES, SIDE_STATES } from "@/lib/pipeline";
import { ProjectCard } from "@/components/ProjectCard";
import { moveProjectStatus } from "@/app/actions";
import type { PipelineProject } from "@/lib/queries";
import type { ProjectStatus } from "@prisma/client";
import { cn, formatMoney } from "@/lib/utils";

const ALL = [...PIPELINE_STAGES, ...SIDE_STATES];

export function PipelineBoard({ projects }: { projects: PipelineProject[] }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<ProjectStatus | null>(null);
  const [isPending, transition] = useTransition();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<ProjectStatus>>(
    () => new Set<ProjectStatus>(["DELIVERED" as ProjectStatus]),
  );
  const [items, setItems] = useState(projects);

  // Default the mobile tab to the first pipeline stage that has work.
  const firstActive = (PIPELINE_STAGES.find((s) => projects.some((p) => p.status === s.status)) ?? PIPELINE_STAGES[1]).status;
  const [mobileStage, setMobileStage] = useState<ProjectStatus>(firstActive);

  const toggleCollapsed = (s: ProjectStatus) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  // Keep in sync if server data changes (after revalidate).
  if (projects !== items && !isPending && dragId === null) {
    const sig = (arr: PipelineProject[]) => arr.map((p) => p.id + p.status).join(",");
    if (sig(projects) !== sig(items)) setItems(projects);
  }

  function handleDrop(status: ProjectStatus) {
    setOverStage(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const current = items.find((p) => p.id === id);
    if (!current || current.status === status) return;
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, status } : p)));
    transition(async () => { await moveProjectStatus(id, status); });
  }

  // Search filter (address / client / photographer).
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      !q
        ? items
        : items.filter(
            (p) =>
              p.title.toLowerCase().includes(q) ||
              p.client?.name?.toLowerCase().includes(q) ||
              p.photographer?.name?.toLowerCase().includes(q),
          ),
    [items, q],
  );

  // Lead active columns with the hottest work so URGENT/HIGH jobs never sink
  // below routine ones. Stable sort keeps the query's shoot-date order within
  // each priority band.
  const PRANK: Record<string, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, NORMAL: 2, LOW: 3 };
  const forStage = (s: ProjectStatus) => {
    const list = filtered.filter((p) => p.status === s);
    if (s === "DELIVERED") {
      return [...list].sort(
        (a, b) => new Date(b.deliveredAt ?? b.updatedAt).getTime() - new Date(a.deliveredAt ?? a.updatedAt).getTime(),
      );
    }
    return [...list].sort((a, b) => (PRANK[a.priority] ?? 2) - (PRANK[b.priority] ?? 2));
  };
  const sumValue = (list: PipelineProject[]) => list.reduce((s, p) => s + (p.price ?? 0), 0);

  // Stages that appear as mobile tabs: pipeline stages always, side states only if populated.
  const mobileTabs = ALL.filter((s) => PIPELINE_STAGES.includes(s) || items.some((p) => p.status === s.status));
  const mobileItems = forStage(mobileStage);

  return (
    <div className="flex h-full flex-col">
      {/* Search */}
      <div className="px-4 pt-3 sm:px-6">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search address, client, or photographer…"
            className="w-full rounded-xl border border-border bg-surface-2 py-2 pl-9 pr-8 text-sm outline-none focus:border-brand"
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-2 hover:text-foreground">
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* MOBILE: stage tabs + single-column list */}
      <div className="lg:hidden">
        <div className="flex gap-1.5 overflow-x-auto scroll-thin px-4 py-3">
          {mobileTabs.map((s) => {
            const n = filtered.filter((p) => p.status === s.status).length;
            const active = mobileStage === s.status;
            return (
              <button
                key={s.status}
                onClick={() => setMobileStage(s.status)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                  active ? "border-border-strong bg-surface-2 text-foreground" : "border-border text-muted hover:text-foreground",
                )}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
                {s.short}
                <span className={cn("rounded-full px-1.5 text-[10px]", active ? "bg-background" : "bg-surface-2")}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="space-y-2 px-4 pb-6">
          {mobileItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-2">No projects in this stage.</p>
          ) : (
            mobileItems.map((p) => <ProjectCard key={p.id} project={p} />)
          )}
        </div>
      </div>

      {/* DESKTOP: kanban board */}
      <div className="hidden flex-1 gap-3 overflow-x-auto scroll-thin px-6 py-4 lg:flex">
        {PIPELINE_STAGES.map((stage) => {
          const colItems = forStage(stage.status);
          const isOver = overStage === stage.status;
          const isCollapsed = collapsed.has(stage.status);
          const value = sumValue(colItems);
          return (
            <div
              key={stage.status}
              className={cn("flex shrink-0 flex-col", isCollapsed ? "w-44" : "w-72")}
              onDragOver={(e) => { e.preventDefault(); setOverStage(stage.status); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage((s) => (s === stage.status ? null : s)); }}
              onDrop={() => handleDrop(stage.status)}
            >
              <button
                type="button"
                onClick={() => toggleCollapsed(stage.status)}
                className="mb-2 flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left hover:bg-surface-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: stage.color }} />
                  <span className="truncate text-sm font-semibold">{stage.label}</span>
                  <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{colItems.length}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {value > 0 && !isCollapsed && <span className="text-[11px] font-medium text-muted-2">{formatMoney(value)}</span>}
                  {isCollapsed ? <ChevronRight className="size-4 text-muted-2" /> : <ChevronDown className="size-4 text-muted-2" />}
                </div>
              </button>
              {isCollapsed ? (
                <div className={cn("flex flex-1 items-center justify-center rounded-xl border border-dashed p-2 text-center text-xs text-muted-2 transition-colors", isOver ? "border-brand bg-brand-soft/50" : "border-transparent bg-surface-2/40")}>
                  {isOver ? "Drop here" : `${colItems.length} hidden — click to expand`}
                </div>
              ) : (
                <div className={cn("flex flex-1 flex-col gap-2 rounded-xl border border-dashed p-2 transition-colors", isOver ? "border-brand bg-brand-soft/50" : "border-transparent bg-surface-2/40")}>
                  {colItems.map((p) => (
                    <ProjectCard key={p.id} project={p} onDragStart={setDragId} />
                  ))}
                  {colItems.length === 0 && (
                    <div className="flex h-20 items-center justify-center rounded-lg text-xs text-muted-2">{isOver ? "Drop here" : "—"}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* DESKTOP: off-pipeline states */}
      {SIDE_STATES.some((s) => items.some((p) => p.status === s.status)) && (
        <div className="hidden border-t bg-surface px-6 py-3 lg:block">
          <div className="flex gap-6">
            {SIDE_STATES.map((stage) => {
              const colItems = forStage(stage.status);
              if (colItems.length === 0) return null;
              return (
                <div key={stage.status} className="flex-1"
                  onDragOver={(e) => { e.preventDefault(); setOverStage(stage.status); }}
                  onDrop={() => handleDrop(stage.status)}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: stage.color }} />
                    <span className="text-sm font-semibold">{stage.label}</span>
                    <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{colItems.length}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {colItems.map((p) => (
                      <div key={p.id} className="w-72"><ProjectCard project={p} onDragStart={setDragId} /></div>
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
