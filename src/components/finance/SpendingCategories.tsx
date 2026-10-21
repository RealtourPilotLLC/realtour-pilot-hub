"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Briefcase, User, ArrowLeftRight, Lock } from "lucide-react";
import { retagCategoryAction, retagTxnAction, retagTxnsBulkAction, fetchCategoryTxnsAction } from "@/app/sales/spendingActions";
import { usd0 as m } from "@/lib/money";

export type Row = { category: string; sum: number; count: number };
export type CatOpt = { category: string; kind: string };
type Txn = { id: string; name: string; amount: number; date: string; kind: string; locked: boolean };

const EXCLUDE_OPT = "Not spend (money movement)";
// A deposit that is Jordan's own money coming back (Oct 21 2026): money
// movement, filed with the other self-transfers so it leaves the review list.
const OWN_MONEY_OPT = "Own money moving (not income)";
const OWN_MONEY_CATEGORY = "Self-transfer (own accounts)";

export function SpendingCategories({
  business, personal, review, reviewIncoming = [], businessTotal, personalTotal, allCategories, startKey, endKey,
}: {
  business: Row[]; personal: Row[]; review: Row[]; reviewIncoming?: Row[]; businessTotal: number; personalTotal: number;
  allCategories: CatOpt[]; startKey: string; endKey: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [txns, setTxns] = useState<Record<string, Txn[]>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  const bizCats = allCategories.filter((c) => c.kind === "BUSINESS").map((c) => c.category);
  const perCats = allCategories.filter((c) => c.kind === "PERSONAL").map((c) => c.category);
  const kindOf = (cat: string) => (cat === EXCLUDE_OPT || cat === OWN_MONEY_OPT ? "EXCLUDE" : allCategories.find((c) => c.category === cat)?.kind ?? "PERSONAL");
  // The category a pick writes: "Not spend" keeps the row's own category.
  const catFor = (cat: string) => (cat === EXCLUDE_OPT ? undefined : cat === OWN_MONEY_OPT ? OWN_MONEY_CATEGORY : cat);
  const listed = (cat: string) => bizCats.includes(cat) || perCats.includes(cat);

  const load = (cat: string) => {
    setLoading(cat);
    return fetchCategoryTxnsAction(cat, startKey, endKey)
      .then((r) => setTxns((t) => ({ ...t, [cat]: r })))
      .finally(() => setLoading(null));
  };
  const toggle = (cat: string) => {
    setSel(new Set()); // selection is per-panel; switching panels clears it
    if (open === cat) { setOpen(null); return; }
    setOpen(cat);
    if (!txns[cat]) load(cat);
  };
  // Re-tag but KEEP the panel open and refresh its rows in place (no collapse).
  const moveCat = (cat: string, kind: string) => start(async () => { await retagCategoryAction(cat, kind); await load(cat); router.refresh(); });
  const moveTxn = (openCat: string, id: string, toCat: string) =>
    start(async () => {
      await retagTxnAction(id, kindOf(toCat), catFor(toCat));
      await load(openCat);
      router.refresh();
    });
  const toggleSel = (id: string) =>
    setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const moveSelected = (openCat: string, toCat: string) =>
    start(async () => {
      await retagTxnsBulkAction([...sel], kindOf(toCat), catFor(toCat));
      setSel(new Set());
      await load(openCat);
      router.refresh();
    });

  const max = Math.max(businessTotal, personalTotal, 1);

  // The choices for one line. Money IN (a deposit to identify) can be own
  // money moving or a refund from a vendor; money out takes any category.
  // Called as a function, like column() below.
  const options = (incoming: boolean) => (
    <>
      {incoming && <optgroup label="Not income"><option value={OWN_MONEY_OPT}>{OWN_MONEY_OPT}</option></optgroup>}
      <optgroup label={incoming ? "A refund: business" : "Business"}>{bizCats.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>
      <optgroup label={incoming ? "A refund: personal" : "Personal"}>{perCats.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>
      {!incoming && <optgroup label="Other"><option value={EXCLUDE_OPT}>Not spend</option></optgroup>}
    </>
  );

  // Called as a function, not a component made during render (it would remount every render).
  const column = ({ title, rows, accent, icon: Icon, total, incoming = false, hint }: { title: string; rows: Row[]; accent: string; icon: typeof Briefcase; total: number; incoming?: boolean; hint?: string }) => (
    <section className="rounded-2xl border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4" style={{ color: accent }} /> {title}</span>
        <span className="text-sm font-bold tabular-nums">{m(total)}</span>
      </div>
      {hint && <p className="border-b border-border/60 px-5 py-2 text-[11px] text-muted-2">{hint}</p>}
      <div className="divide-y divide-border/60">
        {rows.map((r) => (
          <div key={r.category}>
            <button onClick={() => toggle(r.category)} className="w-full px-5 py-2.5 text-left hover:bg-surface-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-1.5">
                  <ChevronRight className={`size-3.5 shrink-0 text-muted-2 transition-transform ${open === r.category ? "rotate-90" : ""}`} />
                  <span className="truncate">{r.category}{r.count ? <span className="ml-1.5 text-[11px] text-muted-2">{r.count}×</span> : null}</span>
                </span>
                <span className="shrink-0 font-medium tabular-nums">{m(r.sum)}</span>
              </div>
              <div className="ml-5 mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.sum / max) * 100)}%`, backgroundColor: accent }} />
              </div>
            </button>
            {open === r.category && (
              <div className="border-t border-border/60 bg-surface-2/40 px-4 py-3">
                {/* No whole-category move for deposits: each one is its own call. */}
                {!incoming && (
                  <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-muted-2">Move whole category to:</span>
                    {[["BUSINESS", "Business"], ["PERSONAL", "Personal"], ["EXCLUDE", "Not spend"]].map(([k, label]) => (
                      <button key={k} disabled={pending} onClick={() => moveCat(r.category, k)}
                        className="rounded-full border border-border bg-surface px-2 py-0.5 font-medium hover:bg-surface-2 disabled:opacity-50">{label}</button>
                    ))}
                    {pending && <Loader2 className="size-3 animate-spin text-muted-2" />}
                  </div>
                )}
                {loading === r.category ? (
                  <div className="flex items-center gap-2 py-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" /> loading…</div>
                ) : (
                  <div className="space-y-0.5">
                    {(txns[r.category] ?? []).length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 text-[11px]">
                        <label className="flex cursor-pointer items-center gap-1.5 text-muted">
                          <input
                            type="checkbox"
                            className="size-3.5 accent-[var(--brand,#6ba3d6)]"
                            checked={(txns[r.category] ?? []).length > 0 && (txns[r.category] ?? []).every((t) => sel.has(t.id))}
                            onChange={(e) => {
                              const all = (txns[r.category] ?? []).map((t) => t.id);
                              setSel(e.target.checked ? new Set(all) : new Set());
                            }}
                          />
                          Select all
                        </label>
                        {sel.size > 0 && (
                          <>
                            <span className="font-medium">
                              {sel.size} selected · {m((txns[r.category] ?? []).filter((t) => sel.has(t.id)).reduce((s, t) => s + t.amount, 0))}
                            </span>
                            <select
                              disabled={pending}
                              value=""
                              onChange={(e) => { if (e.target.value) moveSelected(r.category, e.target.value); }}
                              className="rounded border border-border bg-surface px-1 py-0.5 text-[11px] outline-none focus:border-brand disabled:opacity-50"
                              title="Move all selected charges"
                            >
                              <option value="" disabled>Move selected to…</option>
                              {options(incoming)}
                            </select>
                            <button disabled={pending} onClick={() => setSel(new Set())} className="text-muted-2 underline-offset-2 hover:underline disabled:opacity-50">Clear</button>
                          </>
                        )}
                      </div>
                    )}
                    {(txns[r.category] ?? []).map((t) => (
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
                        <span className="shrink-0 tabular-nums">{incoming ? `+${m(-t.amount)}` : m(t.amount)}</span>
                        <select
                          disabled={pending}
                          // A line still waiting (its category is not one of the
                          // choices) shows "Pick a category…", so EVERY choice,
                          // the first one included, is a change (Oct 21 2026: the
                          // list showed the first business category as if it were
                          // already chosen, and picking it did nothing).
                          value={t.kind === "EXCLUDE" && !incoming ? EXCLUDE_OPT : listed(r.category) ? r.category : ""}
                          onChange={(e) => { if (e.target.value) moveTxn(r.category, t.id, e.target.value); }}
                          className="w-32 shrink-0 rounded border border-border bg-surface px-1 py-0.5 text-[11px] outline-none focus:border-brand disabled:opacity-50"
                          title={incoming ? "Say what this deposit is" : "Recategorize this charge"}
                        >
                          {!listed(r.category) && <option value="" disabled>Pick a category…</option>}
                          {options(incoming)}
                        </select>
                      </div>
                    ))}
                    {(txns[r.category] ?? []).length === 0 && <div className="py-1 text-xs text-muted-2">No transactions.</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="px-5 py-6 text-center text-sm text-muted">Nothing here.</div>}
      </div>
    </section>
  );

  return (
    <div className="space-y-4">
      <p className="px-1 text-[11px] text-muted-2">Tap a category to see its charges. Re-tag one charge with its dropdown, tick several and “Move selected to…” to bulk-recategorize, or re-classify the whole category. Changes lock in (🔒) and survive the nightly re-sync.</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {column({ title: "Business costs", rows: business, accent: "#6ba3d6", icon: Briefcase, total: businessTotal })}
        {column({ title: "Personal spending", rows: personal, accent: "#d4a95f", icon: User, total: personalTotal })}
      </div>
      {review.length > 0 && column({ title: "To review: tag these", rows: review, accent: "#e0a53a", icon: ArrowLeftRight, total: review.reduce((s, r) => s + r.sum, 0) })}
      {reviewIncoming.length > 0 && column({
        title: "Money in to identify", rows: reviewIncoming, accent: "#5cb98a", icon: ArrowLeftRight,
        total: reviewIncoming.reduce((s, r) => s + r.sum, 0), incoming: true,
        hint: "Deposits into the business account that no rule could name. Pick “Own money moving” for your own transfers, or the vendor’s category for a refund. A client paying by check or Zelle is on no processor rail yet: leave it here for now.",
      })}
    </div>
  );
}
