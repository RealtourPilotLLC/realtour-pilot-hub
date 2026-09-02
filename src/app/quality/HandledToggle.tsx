"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Undo2 } from "lucide-react";
import { setFeedbackHandled } from "./actions";

// Close-the-loop control on a client feedback row. Optimistic locally so the
// row doesn't flicker, but the server action is the truth — a rejection (the
// action is owner/admin) rolls the label back and says why instead of looking
// like it saved (the same mistake the platform board's Approve buttons made).
export function HandledToggle({ id, handled }: { id: string; handled: boolean }) {
  const [on, setOn] = useState(handled);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggle = () =>
    start(async () => {
      setErr(null);
      const next = !on;
      setOn(next);
      // A REJECTED call returns {ok:false}; a call that never lands — offline,
      // a dropped connection, an unexpected server throw — REJECTS the promise.
      // Both have to roll the label back, or the row keeps saying "Handled" for
      // a write that didn't happen (same failure the action's own try/catch
      // covers on the server side).
      try {
        const r = await setFeedbackHandled(id, next);
        if (!r.ok) {
          setOn(!next);
          setErr(r.message ?? "That didn't save.");
        }
      } catch {
        setOn(!next);
        setErr("That didn't save — check your connection.");
      }
    });

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={toggle}
        disabled={pending}
        className={
          on
            ? "inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
            : "inline-flex items-center gap-1 rounded-lg bg-success/10 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/20 disabled:opacity-50"
        }
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : on ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
        {on ? "Handled — undo" : "Mark handled"}
      </button>
      {err && <span className="text-[11px] text-danger">{err}</span>}
    </span>
  );
}
