"use client";
import { useEffect, useState, useTransition } from "react";
import { Loader2, Lock } from "lucide-react";
import { retagTxnAction, retagTxnsBulkAction, fetchCategoryTxnsAction } from "@/app/sales/spendingActions";

// The itemized charges inside ONE category, with re-tagging — the drill-in the
// Budget screen shows under a tapped row (Jordan Aug 25: "click on it, it's a
// dropdown and allows us to recategorize"). Self-contained: loads its own rows,
// owns its selection, and tells the parent when something moved so the page's
// totals can refresh. Same server actions as the Categories tab, so a hand-tag
// locks (🔒) and survives the nightly auto-categorizer either way.
export type CatOpt = { category: string; kind: string };
type Txn = { id: string; name: string; amount: number; date: string; kind: string; locked: boolean };

const m = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const EXCLUDE_OPT = "Not spend (money movement)";

export function CategoryTxnPanel({
  category, startKey, endKey, allCategories, onChanged,
}: {
  category: string;
  startKey: string;
  endKey: string;
  allCategories: CatOpt[];
  onChanged: () => void;
}) {
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  const bizCats = allCategories.filter((c) => c.kind === "BUSINESS").map((c) => c.category);
  const perCats = allCategories.filter((c) => c.kind === "PERSONAL").map((c) => c.category);
  const kindOf = (cat: string) => (cat === EXCLUDE_OPT ? "EXCLUDE" : allCategories.find((c) => c.category === cat)?.kind ?? "PERSONAL");

  const load = () => fetchCategoryTxnsAction(category, startKey, endKey).then(setTxns);
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [category, startKey, endKey]);

  const moveTxn = (id: string, toCat: string) =>
    start(async () => {
      await retagTxnAction(id, kindOf(toCat), toCat === EXCLUDE_OPT ? undefined : toCat);
      await load();
      onChanged();
    });
  const moveSelected = (toCat: string) =>
    start(async () => {
      await retagTxnsBulkAction([...sel], kindOf(toCat), toCat === EXCLUDE_OPT ? undefined : toCat);
      setSel(new Set());
      await load();
      onChanged();
    });
  const toggleSel = (id: string) =>
    setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const CatOptions = () => (
    <>
      <optgroup label="Business">{bizCats.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>
      <optgroup label="Personal">{perCats.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>
      <optgroup label="Other"><option value={EXCLUDE_OPT}>Not spend</option></optgroup>
    </>
  );

  if (txns === null) {
    return <div className="flex items-center gap-2 py-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> loading…</div>;
  }
  return (
    <div className="space-y-0.5">
      {txns.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 text-[11px]">
          <label className="flex cursor-pointer items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--brand,#6ba3d6)]"
              checked={txns.length > 0 && txns.every((t) => sel.has(t.id))}
              onChange={(e) => setSel(e.target.checked ? new Set(txns.map((t) => t.id)) : new Set())}
            />
            Select all
          </label>
          {sel.size > 0 && (
            <>
              <span className="font-medium">
                {sel.size} selected · {m(txns.filter((t) => sel.has(t.id)).reduce((s, t) => s + t.amount, 0))}
              </span>
              <select
                disabled={pending}
                value=""
                onChange={(e) => { if (e.target.value) moveSelected(e.target.value); }}
                className="rounded border border-border bg-surface px-1 py-0.5 text-[11px] outline-none focus:border-brand disabled:opacity-50"
                title="Move all selected charges"
              >
                <option value="" disabled>Move selected to…</option>
                <CatOptions />
              </select>
              <button disabled={pending} onClick={() => setSel(new Set())} className="text-muted-2 underline-offset-2 hover:underline disabled:opacity-50">Clear</button>
            </>
          )}
          {pending && <Loader2 className="size-3 animate-spin text-muted-2" />}
        </div>
      )}
      {txns.map((t) => (
        <div key={t.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-surface">
          <input
            type="checkbox"
            className="size-3.5 shrink-0 accent-[var(--brand,#6ba3d6)]"
            checked={sel.has(t.id)}
            onChange={() => toggleSel(t.id)}
            title="Select for bulk move"
          />
          <span className="min-w-0 flex-1 truncate" title={t.name}>
            <span className="text-muted-2">{t.date.slice(5)}</span> {t.name}
            {t.locked && <Lock className="ml-1 inline size-2.5 text-muted-2" />}
          </span>
          <span className="shrink-0 tabular-nums">{m(t.amount)}</span>
          <select
            disabled={pending}
            value={t.kind === "EXCLUDE" ? EXCLUDE_OPT : category}
            onChange={(e) => moveTxn(t.id, e.target.value)}
            className="w-32 shrink-0 rounded border border-border bg-surface px-1 py-0.5 text-[11px] outline-none focus:border-brand disabled:opacity-50"
            title="Recategorize this charge"
          >
            <CatOptions />
          </select>
        </div>
      ))}
      {txns.length === 0 && <div className="py-1 text-xs text-muted-2">No charges in this window.</div>}
    </div>
  );
}
