"use client";
import { useState, useTransition } from "react";
import { ChevronDown, Check, Loader2, ScrollText } from "lucide-react";
import { useRouter } from "next/navigation";
import { resolveQboRow, type FlaggedQboRow } from "@/app/sales/booksReviewActions";

// The QuickBooks review desk — the classifier's flagged rows with their
// plain-English "what we saw" notes, finally on a screen (audit Aug 25: 60
// flagged rows, no surface ever rendered the notes). Each row: confirm the
// category, flip business/personal if needed, done. Decisions are final —
// the nightly re-classify never touches a reviewed row.
const CATEGORIES = [
  "OPERATING", "COST_OF_SALES", "OWNER_DRAW", "FINANCING", "REVENUE", "TRANSFER", "UNCATEGORISED",
];
const m = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

export function BooksReview({ rows }: { rows: FlaggedQboRow[] }) {
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const live = rows.filter((r) => !gone.has(r.id));
  if (rows.length === 0) return null;

  return (
    <details className="group overflow-hidden rounded-2xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-5 py-3 hover:bg-surface-2">
        <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
        <span className="flex items-center gap-2 text-sm font-semibold"><ScrollText className="size-4 text-warning" /> Ledger entries needing your call</span>
        <span className="rounded-full bg-warning/15 px-1.5 text-xs font-semibold text-warning">{live.length}</span>
        <span className="ml-auto text-[11px] text-muted-2">each has a note on what to decide</span>
      </summary>
      <div className="divide-y divide-border/60 border-t border-border">
        {live.slice(0, 60).map((r) => <Row key={r.id} r={r} onDone={(id) => { setGone((s) => new Set(s).add(id)); router.refresh(); }} />)}
        {live.length > 60 && <p className="px-5 py-2 text-[11px] text-muted-2">Showing 60 of {live.length} — the rest surface as these clear.</p>}
        {live.length === 0 && <p className="px-5 py-3 text-sm text-success">All reviewed. 🎉</p>}
      </div>
    </details>
  );
}

function Row({ r, onDone }: { r: FlaggedQboRow; onDone: (id: string) => void }) {
  const [cat, setCat] = useState(r.category ?? "UNCATEGORISED");
  const [personal, setPersonal] = useState(r.personal);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-muted-2">{r.txnDate.slice(5)}</span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {r.customerName || r.memo?.slice(0, 60) || r.accountName || r.type}
        </span>
        <span className="shrink-0 font-semibold tabular-nums">{m(r.amount)}</span>
      </div>
      {r.reviewNote && <p className="mt-1 text-xs text-muted">{r.reviewNote}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <select value={cat} onChange={(e) => setCat(e.target.value)}
          className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand">
          {CATEGORIES.map((c) => <option key={c} value={c}>{c.toLowerCase().replace(/_/g, " ")}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} className="accent-[var(--brand)]" />
          personal, not business
        </label>
        <button
          disabled={busy}
          onClick={() => start(async () => {
            const res = await resolveQboRow(r.id, { category: cat, personal });
            if (res.ok) onDone(r.id); else setErr(res.message);
          })}
          className="inline-flex items-center gap-1 rounded-lg bg-success/10 px-2.5 py-1 text-xs font-semibold text-success hover:bg-success/20 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Reviewed
        </button>
        {err && <span className="text-[11px] text-danger">{err}</span>}
      </div>
    </div>
  );
}
