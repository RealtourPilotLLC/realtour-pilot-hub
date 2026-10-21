"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Loader2, X } from "lucide-react";
import { dismissTask, setSmartTaskStatus } from "@/app/actions";
import { pushOldItem } from "@/app/ops/old/actions";

// The ways out of a task on Kyle's checklist (Oct 19 2026): Done, Not needed,
// or (for an item from earlier days) a new date. "New date" opens a date
// picker and nothing is saved until a day is picked; the server counts the
// pushes and tells Jordan on the third. Done and Not needed are the hub's
// existing task actions, unchanged.

const btn = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-medium disabled:opacity-60";

export function OldItemActions({ taskId, minDay, maxDay, allowNewDate = true }: { taskId: string; minDay?: string; maxDay?: string; allowNewDate?: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [picking, setPicking] = useState(false);
  const [day, setDay] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; message: string } | undefined>, okText: (m: string) => string) =>
    start(async () => {
      setErr(null);
      const r = await fn().catch(() => ({ ok: false, message: "Couldn't save. Try again." }));
      if (r && !r.ok) { setErr(r.message); return; }
      setDone(okText(r?.message ?? ""));
      router.refresh();
    });

  if (done) {
    return <p role="status" className="text-sm font-medium text-success">{done}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!picking ? (
        <>
          <button type="button" disabled={busy} onClick={() => run(() => setSmartTaskStatus(taskId, "COMPLETED"), () => "Done.")} className={`${btn} border-success/40 bg-success/10 text-success hover:bg-success/20`}>
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Check aria-hidden className="size-4" />} Done
          </button>
          <button type="button" disabled={busy} onClick={() => run(() => dismissTask(taskId, "not needed"), () => "Closed as not needed.")} className={`${btn} border-border text-muted hover:bg-surface-2 hover:text-foreground`}>
            <X aria-hidden className="size-4" /> Not needed
          </button>
          {allowNewDate && (
            <button type="button" disabled={busy} onClick={() => setPicking(true)} className={`${btn} border-border text-muted hover:bg-surface-2 hover:text-foreground`}>
              <CalendarClock aria-hidden className="size-4" /> New date
            </button>
          )}
        </>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!day) { setErr("Pick the new date first."); return; }
            run(() => pushOldItem(taskId, day), (m) => m || "Moved.");
          }}
        >
          <label className="sr-only" htmlFor={`new-date-${taskId}`}>New date</label>
          <input
            id={`new-date-${taskId}`}
            type="date"
            required
            min={minDay}
            max={maxDay}
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="min-h-11 rounded-lg border border-border bg-surface px-3 text-sm"
          />
          <button type="submit" disabled={busy || !day} className={`${btn} border-brand/40 bg-brand-action text-white hover:opacity-90`}>
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null} Save date
          </button>
          <button type="button" disabled={busy} onClick={() => { setPicking(false); setDay(""); setErr(null); }} className={`${btn} border-border text-muted hover:bg-surface-2`}>
            Cancel
          </button>
        </form>
      )}
      {err && <p role="alert" className="w-full text-sm text-danger">{err}</p>}
    </div>
  );
}
