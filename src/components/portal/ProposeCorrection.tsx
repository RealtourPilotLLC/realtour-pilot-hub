"use client";

import { useState, useTransition } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";
import { portalProposeStrategyCorrection } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";

// "Suggest a correction" under the released strategy (spec §3): creates a
// ContentStrategyProposal for the team — the strategy itself never changes here.
export function ProposeCorrection({ sections }: { sections: { id: string; heading: string }[] }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState("");
  const [text, setText] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  if (done) return <p role="status" className="text-xs font-medium text-success">{done}</p>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        <MessageSquarePlus className="size-3.5" /> Suggest a correction
      </button>
    );
  }
  return (
    <div className="space-y-2">
      {sections.length > 0 && (
        <select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Which part" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand">
          <option value="">Which part? (optional)</option>
          {sections.map((s) => <option key={s.id} value={s.heading}>{s.heading}</option>)}
        </select>
      )}
      <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="What's off, and what's right? We review it and update your strategy if it changes anything." aria-label="Your correction" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand" />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy || text.trim().length < 3} onClick={() => start(async () => { const r = await portalProposeStrategyCorrection(portalAuthFromLocation(), { summary: text, section }).catch(() => ({ ok: false, message: "That didn't send — try again." })); if (r.ok) setDone(r.message); else setErr(r.message); })} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
          {busy && <Loader2 className="size-3 animate-spin" />} Send correction
        </button>
        <button type="button" onClick={() => { setOpen(false); setErr(null); }} className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>
      </div>
      {err && <p role="alert" className="text-[11px] text-danger">{err}</p>}
    </div>
  );
}
