"use client";

import { useTransition } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { resolveRevisionAction } from "@/app/actions";

// Marks a client revision request handled (or dismisses a false alarm). The
// next status recompute returns the job to Delivered.
export function RevisionResolveButton({ projectId }: { projectId: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => resolveRevisionAction(projectId))}
      className="inline-flex items-center gap-1.5 rounded-lg bg-[#ea580c] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
      Mark revision resolved
    </button>
  );
}
