"use client";

import { useTransition } from "react";
import { Play, Loader2 } from "lucide-react";
import { moveProjectStatus } from "@/app/actions";

// Editor clicks this on an uploaded job → moves it to "In production" (EDITING).
export function StartEditButton({ projectId }: { projectId: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        start(() => moveProjectStatus(projectId, "EDITING"));
      }}
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Start edit
    </button>
  );
}
