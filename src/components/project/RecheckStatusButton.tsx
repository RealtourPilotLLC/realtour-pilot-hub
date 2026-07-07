"use client";

import { useState, useTransition } from "react";
import { RefreshCcw, Loader2 } from "lucide-react";
import { recheckProjectStatus } from "@/app/actions";

// "Re-check now" on the project's Status card: re-runs the Aryeo + Dropbox
// cross-check for THIS job so Kyle can clear a partial-delivery flag he just
// fixed instead of waiting up to an hour for the cron (audit crack #41).
export function RecheckStatusButton({ projectId }: { projectId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const run = () =>
    start(async () => {
      setMsg(null);
      const r = await recheckProjectStatus(projectId);
      setMsg(r.message);
    });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={run}
        disabled={pending}
        title="Re-run the Aryeo + Dropbox cross-check for this job now"
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCcw className="size-3" />}
        {pending ? "Re-checking…" : "Re-check now"}
      </button>
      {msg && <span className="text-[11px] text-muted-2">{msg}</span>}
    </span>
  );
}
