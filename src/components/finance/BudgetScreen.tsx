"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PiggyBank, Plus, Sparkles, Trash2, Wallet } from "lucide-react";
import { Markdown } from "@/components/ui/Markdown";
import { saveBudgetTargetAction, removeBudgetTargetAction } from "@/app/sales/budgetActions";
import { aiSetupBudgetAction } from "@/app/sales/advisorActions";

export type BudgetRow = { category: string; target: number; note: string | null; spent: number; avg3mo: number };

const m0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const MONTH = (key: string) => new Date(`${key}-01T12:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

export function BudgetScreen({
  rows, unbudgeted, monthKey, dayOfMonth, daysInMonth, totalSpent,
}: {
  rows: BudgetRow[];
  unbudgeted: { category: string; spent: number; avg3mo: number }[];
  monthKey: string; dayOfMonth: number; daysInMonth: number; totalSpent: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const budgetedSpent = rows.reduce((s, r) => s + r.spent, 0);
  const pace = dayOfMonth / daysInMonth; // fraction of the month elapsed
  const projected = (totalSpent / Math.max(1, dayOfMonth)) * daysInMonth;

  const save = (category: string, value: string) => {
    const n = Number(value.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) return;
    start(async () => { await saveBudgetTargetAction(category, n); router.refresh(); });
  };
  const remove = (category: string) => start(async () => { await removeBudgetTargetAction(category); router.refresh(); });

  const runAi = async () => {
    setAiBusy(true);
    setAiSummary(null);
    try {
      const r = await aiSetupBudgetAction();
      setAiSummary(r.error ?? r.summary);
      router.refresh();
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={<PiggyBank className="size-4" />} accent="#5cb98a" label="Monthly budget" value={rows.length ? m0(totalTarget) : "—"} sub={rows.length ? `${rows.length} categories` : "not set up yet"} />
        <Kpi icon={<Wallet className="size-4" />} accent="#6ba3d6" label={`${MONTH(monthKey)} so far`} value={m0(totalSpent)} sub={`day ${dayOfMonth} of ${daysInMonth}`} />
        <Kpi
          icon={<Wallet className="size-4" />} accent={rows.length && projected > totalTarget ? "#ec6a6a" : "#8b93e6"}
          label="On pace for" value={m0(projected)}
          sub={rows.length ? (projected > totalTarget ? `${m0(projected - totalTarget)} over budget` : `${m0(totalTarget - projected)} under budget`) : "vs no budget yet"}
        />
        <Kpi icon={<PiggyBank className="size-4" />} accent="#d4a95f" label="Left to spend" value={rows.length ? m0(Math.max(0, totalTarget - budgetedSpent)) : "—"} sub="in budgeted categories" />
      </div>

      {/* AI setup / rebalance */}
      <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-brand" /> {rows.length ? "Rebalance with your Advisor" : "Let your Advisor set this up"}</span>
            <p className="mt-0.5 text-[11px] text-muted-2">
              {rows.length
                ? "It re-reads your last 3 months and adjusts every target, keeping fixed costs realistic and cutting where the savings plan says to."
                : "It reads your real spending history and writes a target for every category — fixed costs stay honest, the cuttable stuff gets cut."}
            </p>
          </div>
          <button onClick={runAi} disabled={aiBusy} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {aiBusy ? <><Loader2 className="size-4 animate-spin" /> building…</> : rows.length ? "Rebalance budget" : "Build my budget"}
          </button>
        </div>
        {aiSummary && (
          <div className="mt-3 rounded-xl border border-border/60 bg-surface-2/50 p-3">
            <Markdown content={aiSummary} className="text-sm" />
          </div>
        )}
        <p className="mt-2 text-[10px] text-muted-2">You can also just tell the Advisor in chat — “raise groceries to $700”, “cut subscriptions” — and it updates this screen.</p>
      </section>

      {/* BUDGET ROWS */}
      {rows.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-5 py-3 text-sm font-semibold">
            <span>{MONTH(monthKey)} budget</span>
            <span className="tabular-nums text-muted">{m0(budgetedSpent)} of {m0(totalTarget)}</span>
          </div>
          <div className="divide-y divide-border/60">
            {rows.map((r) => {
              const frac = r.target > 0 ? r.spent / r.target : r.spent > 0 ? 1 : 0;
              const over = r.spent > r.target;
              const hot = !over && frac > pace + 0.12; // ahead of the month's pace
              const bar = over ? "#ec6a6a" : hot ? "#e0a53a" : "#5cb98a";
              return (
                <div key={r.category} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">{r.category}</span>
                    <span className="shrink-0 tabular-nums text-muted">{m0(r.spent)} /</span>
                    <input
                      defaultValue={Math.round(r.target)}
                      onChange={(e) => setEdits((s) => ({ ...s, [r.category]: e.target.value }))}
                      onBlur={() => { if (edits[r.category] != null && edits[r.category] !== String(Math.round(r.target))) save(r.category, edits[r.category]); }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      disabled={pending}
                      inputMode="numeric"
                      className="w-20 shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-right text-sm tabular-nums outline-none focus:border-brand disabled:opacity-50"
                      title="Monthly target — edit and press Enter"
                    />
                    <button onClick={() => remove(r.category)} disabled={pending} className="shrink-0 text-muted-2 hover:text-danger disabled:opacity-40" title="Remove from budget">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, frac * 100)}%`, backgroundColor: bar }} />
                    {/* month-pace marker */}
                    <div className="absolute top-0 h-full w-px bg-foreground/30" style={{ left: `${pace * 100}%` }} />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-muted-2">
                    <span className="truncate">{r.note ?? `3-mo average ${m0(r.avg3mo)}`}</span>
                    <span className="shrink-0 tabular-nums">{over ? `${m0(r.spent - r.target)} over` : `${m0(r.target - r.spent)} left`}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* UNBUDGETED */}
      {unbudgeted.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface">
          <div className="border-b border-border px-5 py-3">
            <span className="text-sm font-semibold">Spending without a budget</span>
            <p className="mt-0.5 text-[11px] text-muted-2">Categories with {MONTH(monthKey)} spending but no target — tap + to budget one at its 3-month average.</p>
          </div>
          <div className="divide-y divide-border/60">
            {unbudgeted.map((u) => (
              <div key={u.category} className="flex items-center justify-between gap-3 px-5 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{u.category}</span>
                <span className="shrink-0 tabular-nums text-muted">{m0(u.spent)} this mo · avg {m0(u.avg3mo)}</span>
                <button
                  onClick={() => save(u.category, String(Math.max(25, Math.round(u.avg3mo))))}
                  disabled={pending}
                  className="shrink-0 rounded-full border border-border bg-surface-2 p-1 text-muted hover:text-foreground disabled:opacity-40"
                  title={`Budget at ${m0(Math.max(25, u.avg3mo))}/mo`}
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="px-1 text-[11px] text-muted-2">
        Actuals come from the same audited ledger as every Finance tab (all accounts, cards and Venmo — transfers excluded). The gray tick on each bar marks where the month is; a bar past its tick is spending faster than the month.
      </p>
    </div>
  );
}

function Kpi({ icon, accent, label, value, sub }: { icon: React.ReactNode; accent: string; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 panel-shadow">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${accent}1a`, color: accent }}>{icon}</span>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted-2">{sub}</div>}
    </div>
  );
}
