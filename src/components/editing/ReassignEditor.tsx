"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { setEditVideoEditor } from "@/app/editing/actions";

// One-click reassign for owner/admin on a video tracker row. A tiny select of
// the video editors (Kim / Remar / Luma); picking one repoints the edit_video
// task + Project.editorId server-side, then the page revalidates.
const VIDEO_EDITORS: { key: string; name: string }[] = [
  { key: "kim", name: "Kim" },
  { key: "remar", name: "Remar" },
  { key: "luma", name: "Luma" },
];

export function ReassignEditor({ projectId, current }: { projectId: string; current: string | null }) {
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-1">
      {pending && <Loader2 className="size-3.5 animate-spin text-muted" />}
      <select
        aria-label="Reassign editor"
        defaultValue={current ?? ""}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          start(async () => {
            try {
              await setEditVideoEditor(projectId, v);
            } catch {
              /* revalidation resets the select on failure */
            }
          });
        }}
        className="rounded-md border bg-surface px-1.5 py-1 text-xs font-medium text-foreground disabled:opacity-60"
      >
        <option value="">Assign…</option>
        {VIDEO_EDITORS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.name}
          </option>
        ))}
      </select>
    </span>
  );
}
