"use client";

import { useState, useTransition } from "react";
import { ChevronDown } from "lucide-react";
import { ALL_STAGES, stageMeta } from "@/lib/pipeline";
import { ink } from "@/components/ui/Badge";
import { moveProjectStatus } from "@/app/actions";
import type { ProjectStatus } from "@prisma/client";

// Oct 20 2026 (audit A17): the select wrote the stage on change, so one
// mis-tap on a phone delivered or cancelled a job (Delivered also clears the
// open revision request), a refusal from the server blew up the transition,
// and a "view as" preview offered a control that could only fail. Delivered
// and Cancelled now ask first, a refusal is said in words, and a preview
// shows the stage without the control.
const ASK_FIRST: Partial<Record<ProjectStatus, string>> = {
  DELIVERED: "Mark this job Delivered? It clears the revision request and closes the job's open revision tasks.",
  CANCELLED: "Cancel this job? Its open work is closed and it leaves the lists.",
};

export function StageSelector({
  projectId,
  status,
  readOnly = false,
}: {
  projectId: string;
  status: ProjectStatus;
  /** a "view as" preview: the stage, never the control */
  readOnly?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const meta = stageMeta(status);
  const style = { color: ink(meta.color), backgroundColor: meta.soft, borderColor: `${meta.color}55` };

  if (readOnly) {
    return (
      <span className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-semibold" style={style} title="Read-only while viewing as someone else">
        {meta.label}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="relative inline-flex">
        <select
          value={status}
          disabled={isPending}
          aria-label="Job stage"
          onChange={(e) => {
            const next = e.target.value as ProjectStatus;
            const ask = ASK_FIRST[next];
            // Not confirmed: the select is controlled, so it falls back to the saved stage.
            if (ask && !window.confirm(ask)) return;
            setError(null);
            startTransition(async () => {
              try {
                await moveProjectStatus(projectId, next);
              } catch (err) {
                setError(err instanceof Error && err.message ? err.message : "The stage didn't change. Try again.");
              }
            });
          }}
          className="min-h-11 cursor-pointer appearance-none rounded-lg border pl-3 pr-8 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
          style={style}
        >
          {ALL_STAGES.map((s) => (
            <option key={s.status} value={s.status} style={{ color: "#0f172a" }}>
              {s.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2"
          style={{ color: ink(meta.color) }}
        />
      </div>
      {error && <p role="alert" className="max-w-64 text-right text-xs text-danger">{error}</p>}
    </div>
  );
}
