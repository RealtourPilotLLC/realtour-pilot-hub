"use client";

import { useState, useTransition } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { runProgramSweep } from "@/app/content/actions";

// Manual re-sync: enrollments ↔ Aryeo flag, current months, shoot attachment.
export function SweepButton() {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-[11px] text-muted">{note}</span>}
      <button
        onClick={() => start(async () => { const r = await runProgramSweep(); setNote(r.message); })}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        Sync now
      </button>
    </div>
  );
}
