"use client";

import { useState, useTransition } from "react";
import { GraduationCap, Loader2, Send, Trash2 } from "lucide-react";
import { discardCoachingAction, sendCoachingAction } from "@/app/ops/photo-delivery/actions";

// The photographer coaching note (prompt pack 10, plan 12 item 3). For the
// first month every note is a draft the owner reads, edits if needed, and
// sends (or discards); it reaches the photographer by their usual staff
// channel. Owner only: the page renders this card for the owner alone.
export type CoachingView = { photographerName: string; note: string; preShootReminders: string[]; status: "draft" | "sent" | "discarded" };

export function CoachingCard({ jobId, coaching }: { jobId: string; coaching: CoachingView }) {
  const [note, setNote] = useState(coaching.note);
  const [reminders, setReminders] = useState<string[]>(coaching.preShootReminders.slice(0, 3));
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, start] = useTransition();
  const first = coaching.photographerName.split(" ")[0];
  const done = coaching.status !== "draft";
  return (
    <section aria-label="Coaching note" className="panel-shadow space-y-2 rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <GraduationCap aria-hidden className="size-4 text-brand" /> Coaching note for {first}
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">{coaching.status === "draft" ? "Waiting for your approval" : coaching.status === "sent" ? "Sent" : "Discarded"}</span>
      </div>
      <label className="sr-only" htmlFor={`coach-${jobId}`}>Coaching note</label>
      <textarea
        id={`coach-${jobId}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={done}
        rows={5}
        className="w-full rounded-lg border bg-surface-2 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-80"
      />
      <div className="space-y-1">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted">Before the next shoot</p>
        {reminders.map((r, i) => (
          <input
            key={i}
            aria-label={`Reminder ${i + 1}`}
            value={r}
            disabled={done}
            onChange={(e) => setReminders((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
            className="w-full rounded-lg border bg-surface-2 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-80"
          />
        ))}
      </div>
      {!done && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => start(async () => setMsg(await sendCoachingAction({ jobId, note, reminders })))}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-3.5 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Send aria-hidden className="size-4" />} Send to {first}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => start(async () => setMsg(await discardCoachingAction(jobId)))}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-3.5 text-sm font-medium hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 aria-hidden className="size-4" /> Discard
          </button>
        </div>
      )}
      {msg && <p role="status" className={`text-[12px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </section>
  );
}
