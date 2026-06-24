"use client";

import { useState, useTransition } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { summarizeDay } from "@/app/history/actions";

// "Write recap" button → AI narrative of the day. On-demand to keep cost down.
export function DayRecap({ dayKey }: { dayKey: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      setErr(null);
      const r = await summarizeDay(dayKey);
      if (r.ok && r.text) setText(r.text);
      else setErr(r.message ?? "Could not generate a recap.");
    });

  if (text) {
    return (
      <div className="border-b border-border bg-brand-soft/40 px-4 py-3">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
          <Sparkles className="size-3.5" /> Day recap
        </div>
        <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{text}</p>
      </div>
    );
  }

  return (
    <div className="border-b border-border px-4 py-2">
      <button
        onClick={run}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand hover:bg-brand/20 disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        {pending ? "Writing recap…" : "Write a recap of this day"}
      </button>
      {err && <span className="ml-2 text-xs text-danger">{err}</span>}
    </div>
  );
}
