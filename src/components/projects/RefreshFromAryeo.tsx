"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Check, AlertTriangle } from "lucide-react";
import { refreshFromAryeo, type RefreshResult } from "@/app/projects/refreshActions";

// Pull this job's live truth from Aryeo on demand — media, appointment times,
// order items, payment. The result line names what actually moved, because a
// refresh that reports nothing is indistinguishable from a broken button.
export function RefreshFromAryeo({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const [pending, start] = useTransition();
  const [res, setRes] = useState<RefreshResult | null>(null);
  const router = useRouter();

  const run = () =>
    start(async () => {
      setRes(null);
      const r = await refreshFromAryeo(projectId).catch(() => ({
        ok: false,
        message: "Something went wrong reaching Aryeo — try again in a moment.",
      } as RefreshResult));
      setRes(r);
      if (r.ok) router.refresh(); // repaint the page with the fresh rows
    });

  return (
    <div className={compact ? "" : "space-y-1.5"}>
      <button
        type="button"
        onClick={run}
        disabled={pending}
        title="Pull the latest media, appointment and order details from Aryeo"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 disabled:opacity-60"
      >
        <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} />
        {pending ? "Checking Aryeo…" : "Refresh from Aryeo"}
      </button>
      {res && (
        <p
          className={`flex items-start gap-1.5 text-[11px] leading-relaxed ${res.ok ? (res.changed?.length ? "text-success" : "text-muted-2") : "text-danger"}`}
          role="status"
        >
          {res.ok ? <Check className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
          <span>{res.message}</span>
        </p>
      )}
    </div>
  );
}
