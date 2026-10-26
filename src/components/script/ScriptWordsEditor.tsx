"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { pointLabel } from "@/lib/scriptLayout";

// ---------------------------------------------------------------------------
// EDIT THE WORDS OF A SCRIPT (Oct 14 2026). One editor for the agent's portal
// and the photographer's shoot screen: the hook, each talking point, the close
// and the caption line, each in its own box, so the script keeps its shape
// (lib/scriptEdits refuses a broken one in plain words). A failed save keeps
// every word in the boxes.
// ---------------------------------------------------------------------------

export type EditableParts = { hook: string; points: { role: "re-hook" | "build-up" | "payoff" | null; text: string }[]; close: string; captionCta: string | null };
export type Words = { hook: string; points: string[]; close: string; captionCta?: string | null };

export function ScriptWordsEditor({ parts, onSave, onCancel, onSaved, intro, saveLabel = "Save the new wording" }: {
  parts: EditableParts;
  onSave: (w: Words) => Promise<{ ok: boolean; message: string }>;
  onCancel: () => void;
  onSaved?: (message: string) => void;
  intro?: string;
  /** Oct 20 2026: what the save button says (the office's "Save and send to her"). */
  saveLabel?: string;
}) {
  const [hook, setHook] = useState(parts.hook);
  const [points, setPoints] = useState(parts.points.map((p) => p.text));
  const [close, setClose] = useState(parts.close);
  const [caption, setCaption] = useState(parts.captionCta ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const save = () =>
    start(async () => {
      setErr(null);
      const r = await onSave({ hook, points, close, captionCta: parts.captionCta != null || caption.trim() ? caption : undefined }).catch(() => ({ ok: false, message: "That didn't save. Check your connection and try again." }));
      if (r.ok) onSaved?.(r.message);
      else setErr(r.message);
    });
  const box = "mt-1 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-base leading-relaxed outline-none focus:border-brand sm:text-sm";
  // Sized for a phone (about 30 characters a line), so a talking point reads whole without scrolling the box.
  // Oct 26 2026: a skit's lines each start a new line in the box, so each line is counted on its own.
  const rows = (t: string) => Math.min(14, Math.max(3, t.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 30)), 0) + 1));
  const label = "block text-[11px] font-bold uppercase tracking-wider text-brand";
  return (
    <div className="mt-2 space-y-3 rounded-xl border border-border bg-surface-2/40 p-3">
      {intro && <p className="text-xs text-muted">{intro}</p>}
      <label className="block"><span className={label}>Hook</span><textarea value={hook} onChange={(e) => setHook(e.target.value)} rows={rows(hook)} className={box} /></label>
      {points.map((t, i) => (
        <label key={i} className="block">
          <span className={label}>{pointLabel(i + 1, parts.points[i]?.role ?? null)}</span>
          <textarea value={t} onChange={(e) => setPoints((ps) => ps.map((x, j) => (j === i ? e.target.value : x)))} rows={rows(t)} className={box} />
        </label>
      ))}
      <label className="block"><span className={label}>Close / CTA</span><textarea value={close} onChange={(e) => setClose(e.target.value)} rows={rows(close)} className={box} /></label>
      {(parts.captionCta != null || caption) && (
        <label className="block"><span className={label}>Caption CTA (optional)</span><textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} className={box} /></label>
      )}
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={busy} className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-4 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand")}>
          {busy && <Loader2 className="size-4 animate-spin" />} {saveLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="min-h-11 rounded-xl border border-border px-4 text-sm text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>
      </div>
    </div>
  );
}
