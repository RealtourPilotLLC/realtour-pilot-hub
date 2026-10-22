"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Loader2 } from "lucide-react";
import { refreshUnpaidFromAryeo } from "@/app/billing/actions";

/** Re-read every unpaid invoice from Aryeo now (Oct 22 2026), then redraw the list. */
export function RefreshUnpaid() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          start(async () => {
            setNote(null);
            const r = await refreshUnpaidFromAryeo().catch(() => ({ ok: false, message: "That didn't reach the hub. Press it again." }));
            setNote({ ok: r.ok, text: r.message });
            router.refresh();
          })
        }
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground hover:bg-surface-2 disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        {busy ? "Checking Aryeo…" : "Refresh from Aryeo"}
      </button>
      {note && <p role="status" className={`max-w-xs text-right text-[11px] ${note.ok ? "text-muted" : "text-warning"}`}>{note.text}</p>}
    </div>
  );
}
