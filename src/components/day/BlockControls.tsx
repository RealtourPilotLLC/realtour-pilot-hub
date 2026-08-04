"use client";

import { useState, useTransition } from "react";
import { CalendarCheck, CalendarX, Loader2, Clock } from "lucide-react";
import { blockDayOnCalendar, rescheduleBlock, unblockTodo } from "@/app/day/actions";

// The calendar controls. Three things and no more: put the day on the calendar,
// move one block, take one block off. Anything else belongs in Google.

export function BlockDayButton({ dayKey, pending }: { dayKey: string; pending: number }) {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (pending === 0 && !msg) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() =>
          start(async () => {
            const r = await blockDayOnCalendar(dayKey);
            setMsg(
              r.error
                ? r.error
                : r.created === 0
                  ? "Nothing new to block."
                  : `${r.created} block${r.created === 1 ? "" : "s"} on your calendar${r.failed ? ` · ${r.failed} failed` : ""}.`,
            );
          })
        }
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-40"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <CalendarCheck className="size-3" />}
        Block {pending} on my calendar
      </button>
      {msg && <span className="text-[11px] text-muted-2">{msg}</span>}
    </div>
  );
}

/** Per-row: change the time, or give the time back. */
export function BlockRowControls({
  id,
  dayKey,
  onCalendar,
  hhmm,
  minutes,
}: {
  id: string;
  dayKey: string;
  onCalendar: boolean;
  hhmm: string;
  minutes: number;
}) {
  const [busy, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState(hhmm);
  const [err, setErr] = useState<string | null>(null);

  if (busy) return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-2" />;

  if (editing) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[11px] tabular-nums outline-none focus:border-brand"
        />
        <button
          onClick={() =>
            start(async () => {
              const r = await rescheduleBlock(id, dayKey, time, minutes);
              if (r.ok) setEditing(false);
              else setErr(r.error ?? "Didn't move.");
            })
          }
          className="rounded bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-white"
        >
          Move
        </button>
        <button onClick={() => { setEditing(false); setErr(null); }} className="text-[10px] text-muted-2 hover:text-foreground">
          Cancel
        </button>
        {err && <span className="text-[10px] text-danger">{err}</span>}
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        onClick={() => setEditing(true)}
        className="rounded p-1 text-muted-2 hover:bg-surface-2 hover:text-foreground"
        title="Move this block"
      >
        <Clock className="size-3.5" />
      </button>
      {onCalendar && (
        <button
          onClick={() => start(async () => { await unblockTodo(id); })}
          className="rounded p-1 text-muted-2 hover:bg-surface-2 hover:text-danger"
          title="Take it off my calendar"
        >
          <CalendarX className="size-3.5" />
        </button>
      )}
    </div>
  );
}
