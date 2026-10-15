"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { recordAutohdrReading } from "@/app/settings/autohdr/actions";

// Kyle's Monday reading. Empty boxes stay unset: unset is a real answer.

export function AutohdrReadingForm() {
  const [pending, start] = useTransition();
  const [credits, setCredits] = useState("");
  const [dollars, setDollars] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            const r = await recordAutohdrReading({ credits: credits || null, dollars: dollars || null, note: note || null });
            setMsg({ ok: r.ok, text: r.message });
            if (r.ok) { setCredits(""); setDollars(""); setNote(""); }
          } catch (err) {
            setMsg({ ok: false, text: err instanceof Error ? err.message : "That didn't save." });
          }
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted">Credits left
          <input value={credits} onChange={(e) => setCredits(e.target.value)} inputMode="numeric" placeholder="e.g. 420" className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-muted">Dollar balance (if shown)
          <input value={dollars} onChange={(e) => setDollars(e.target.value)} inputMode="decimal" placeholder="optional" className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
        </label>
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
      <button type="submit" disabled={pending || (!credits && !dollars)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
        {pending && <Loader2 className="size-3.5 animate-spin" />} Record reading
      </button>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
    </form>
  );
}
