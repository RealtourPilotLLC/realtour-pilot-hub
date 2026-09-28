"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { addReworkCostAction, voidReworkCostAction } from "@/app/projects/reworkActions";
import { CAUSE_LABEL, ISSUE_CAUSES } from "@/lib/issueCauses";

// Owner-only rework entry. The evidence list is what the hub already holds for
// this job — Stripe refunds, QuickBooks refunds/credit memos, revision rounds —
// OFFERED, never attached for you; "manual" is a person's own figure.

type Candidate = { ref: string; label: string; kindHint: string };
const KINDS: [string, string][] = [
  ["EDITOR_LABOR", "Editor time"],
  ["VENDOR", "Vendor re-run"],
  ["TRAVEL", "Travel"],
  ["RESHOOT_PAY", "Reshoot pay"],
  ["REFUND", "Refund"],
  ["CREDIT", "Credit given"],
  ["OTHER", "Other"],
];

export function ReworkCostForm({ projectId, candidates }: { projectId: string; candidates: Candidate[] }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("EDITOR_LABOR");
  const [amount, setAmount] = useState("");
  const [basis, setBasis] = useState("actual");
  const [evidence, setEvidence] = useState("manual");
  const [cause, setCause] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-surface-2">
        Add rework cost…
      </button>
    );
  }
  return (
    <form
      className="mt-3 space-y-2 rounded-xl border bg-surface-2/40 p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            const r = await addReworkCostAction({ projectId, kind, amount, basis, evidenceRef: evidence, issueCause: cause || null, note });
            setMsg({ ok: r.ok, text: r.message });
            if (r.ok) { setAmount(""); setNote(""); setEvidence("manual"); setOpen(false); }
          } catch (err) {
            setMsg({ ok: false, text: err instanceof Error ? err.message : "That didn't save." });
          }
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted">What
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm">
            {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted">Amount ($)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-muted">Actual or estimate
          <select value={basis} onChange={(e) => setBasis(e.target.value)} className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm">
            <option value="actual">Actual (it was paid / given)</option>
            <option value="estimate">Estimate</option>
          </select>
        </label>
        <label className="text-xs text-muted">Cause (optional)
          <select value={cause} onChange={(e) => setCause(e.target.value)} className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm">
            <option value="">Not tagged</option>
            {ISSUE_CAUSES.filter((c) => c !== "UNCLASSIFIED").map((c) => <option key={c} value={c}>{CAUSE_LABEL[c]}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-xs text-muted">Evidence
        <select
          value={evidence}
          onChange={(e) => {
            setEvidence(e.target.value);
            const hint = candidates.find((c) => c.ref === e.target.value)?.kindHint;
            if (hint && KINDS.some(([k]) => k === hint)) setKind(hint);
          }}
          className="mt-0.5 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm"
        >
          <option value="manual">Manual — my own figure</option>
          {candidates.map((c) => <option key={c.ref} value={c.ref}>{c.label}</option>)}
        </select>
      </label>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full rounded-lg border bg-surface px-2 py-1.5 text-sm" />
      <div className="flex gap-2">
        <button type="submit" disabled={pending || !amount} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {pending && <Loader2 className="size-3.5 animate-spin" />} Record
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-surface-2">Cancel</button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? "text-success" : "text-warning"}`}>{msg.text}</p>}
    </form>
  );
}

export function VoidReworkButton({ projectId, id }: { projectId: string; id: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => {
          try { setMsg((await voidReworkCostAction(projectId, id)).message); } catch (e) { setMsg(e instanceof Error ? e.message : "Couldn't void it."); }
        })}
        className="text-[11px] text-muted underline-offset-2 hover:underline disabled:opacity-50"
      >
        Void
      </button>
      {msg && <span className="text-[11px] text-muted-2">{msg}</span>}
    </span>
  );
}
