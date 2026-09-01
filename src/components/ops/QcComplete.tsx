"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { completeQcTask } from "@/app/ops/actions";

// "We should have a way to mark it completed" (Jordan, Sep 1 — 195 Woodhill,
// whose floor plan was REMOVED from the order for a $50 discount, so the hub
// waits forever for a deliverable nobody owes). Asks for the reason in page,
// which lands on the project timeline so the close is explainable later.
export function QcComplete({ taskId, waitingOn }: { taskId: string; waitingOn: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const submit = () =>
    start(async () => {
      const r = await completeQcTask(taskId, note).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
      if (r.ok) { setOpen(false); setNote(""); router.refresh(); }
      else setErr(r.message);
    });

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setErr(null); }}
        title="Mark this job's QC done — e.g. the outstanding item was removed from the order"
        className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-success/10 hover:text-success"
      >
        Mark complete
      </button>
    );
  }
  return (
    <div className="mt-1.5 w-full rounded-lg border border-success/30 bg-success/10 p-2.5">
      <p className="text-[11px] font-medium text-foreground/80">
        {waitingOn.length > 0
          ? `Still waiting on ${waitingOn.join(", ")}. Why is this done anyway?`
          : "Why is this done?"}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setOpen(false); setNote(""); }
            if (e.key === "Enter" && !busy) { e.preventDefault(); submit(); }
          }}
          placeholder="e.g. floor plan removed from the order — client discounted $50"
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-brand"
        />
        <button
          disabled={busy}
          onClick={submit}
          className="inline-flex items-center gap-1.5 rounded-lg bg-success px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Complete
        </button>
        <button onClick={() => { setOpen(false); setNote(""); setErr(null); }} className="rounded-lg px-2 py-1.5 text-xs text-muted hover:text-foreground">
          Cancel
        </button>
      </div>
      {err && <p className="mt-1.5 text-[11px] font-medium text-danger">{err}</p>}
    </div>
  );
}
