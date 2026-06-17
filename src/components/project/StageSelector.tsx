"use client";

import { useTransition } from "react";
import { ChevronDown } from "lucide-react";
import { ALL_STAGES, stageMeta } from "@/lib/pipeline";
import { moveProjectStatus } from "@/app/actions";
import type { ProjectStatus } from "@prisma/client";

export function StageSelector({
  projectId,
  status,
}: {
  projectId: string;
  status: ProjectStatus;
}) {
  const [isPending, startTransition] = useTransition();
  const meta = stageMeta(status);

  return (
    <div className="relative inline-flex">
      <select
        value={status}
        disabled={isPending}
        onChange={(e) => {
          const next = e.target.value as ProjectStatus;
          startTransition(async () => {
            await moveProjectStatus(projectId, next);
          });
        }}
        className="cursor-pointer appearance-none rounded-lg border py-1.5 pl-3 pr-8 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
        style={{ color: meta.color, backgroundColor: meta.soft, borderColor: `${meta.color}55` }}
      >
        {ALL_STAGES.map((s) => (
          <option key={s.status} value={s.status} style={{ color: "#0f172a" }}>
            {s.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2"
        style={{ color: meta.color }}
      />
    </div>
  );
}
