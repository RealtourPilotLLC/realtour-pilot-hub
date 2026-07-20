"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Landmark, Users, Receipt, Loader2, Plus, X, Check, ChevronDown } from "lucide-react";
import { usd } from "@/lib/money";
import { setCashSnapshot, setTeamPay, recordPayrollEntry, addExpense, deleteExpense } from "@/app/sales/moneyActions";

type Candidate = { id: string; name: string; payType: string; monthlyPay: number | null; hourlyRate: number | null; entryKey: string; payDateISO: string; recordedThisPeriod: number | null };
type Expense = { id: string; amount: number; category: string; vendor: string | null; note: string | null; spentAt: string; personal: boolean; recurring: boolean };

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function Card({ icon, title, blurb, children, defaultOpen }: { icon: React.ReactNode; title: string; blurb?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group rounded-2xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3">
        <span className="text-brand">{icon}</span>
        <span className="text-sm font-semibold">{title}</span>
        {blurb && <span className="hidden text-[11px] text-muted-2 sm:inline">· {blurb}</span>}
        <ChevronDown className="ml-auto size-4 text-muted-2 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border p-4">{children}</div>
    </details>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "w-full rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-sm";

export function MoneyEntry({ period, candidates, expenses }: {
  period: { startKey: string; payoutKey: string; label: string; monthLabel: string };
  candidates: Candidate[];
  expenses: Expense[];
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => { const r = await fn(); setMsg(r.message); if (r.ok) router.refresh(); });

  return (
    <div className="space-y-3">
      {msg && <p className="px-1 text-xs font-medium text-muted">{msg}</p>}

      {/* Bank balance */}
      <Card icon={<Landmark className="size-4" />} title="Update bank balance" blurb="anchors your runway" defaultOpen={candidates.every((c) => c.recordedThisPeriod == null)}>
        <BankForm busy={busy} run={run} />
      </Card>

      {/* Team pay — the invisible half */}
      <Card icon={<Users className="size-4" />} title="Editor & team pay" blurb="Kim, Remar, Kyle" defaultOpen>
        <p className="mb-3 text-xs text-muted">Record what you actually paid each person — monthly salary (Kim) once for {period.monthLabel}, hourly (Remar, Kyle) for this period ({period.label}). This is what makes your real profit show up.</p>
        <div className="space-y-2">
          {candidates.length === 0 && <p className="text-xs text-muted-2">No editors/ops set up yet.</p>}
          {candidates.map((c) => <TeamRow key={c.id} c={c} busy={busy} run={run} />)}
        </div>
      </Card>

      {/* Expenses */}
      <Card icon={<Receipt className="size-4" />} title="Expenses" blurb="software, gear, draws">
        <ExpenseForm busy={busy} run={run} />
        {expenses.length > 0 && (
          <div className="mt-3 divide-y divide-border/60 border-t border-border pt-2">
            {expenses.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{usd(e.amount)}</span> · {e.category}{e.vendor ? ` · ${e.vendor}` : ""}
                  {e.personal && <span className="ml-1 rounded bg-surface-2 px-1 text-[10px] text-muted-2">personal</span>}
                  {e.recurring && <span className="ml-1 rounded bg-surface-2 px-1 text-[10px] text-muted-2">monthly</span>}
                  <span className="ml-1 text-muted-2">· {e.spentAt}</span>
                </span>
                <button onClick={() => run(() => deleteExpense(e.id))} disabled={busy} className="shrink-0 text-muted-2 hover:text-danger"><X className="size-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function BankForm({ busy, run }: { busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const [bal, setBal] = useState("");
  const [asOf, setAsOf] = useState(todayKey());
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-36"><Field label="Balance (can be −)"><input value={bal} onChange={(e) => setBal(e.target.value)} placeholder="$" className={inputCls} inputMode="text" /></Field></div>
      <div className="w-40"><Field label="As of"><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={inputCls} /></Field></div>
      <button
        onClick={() => run(() => setCashSnapshot(bal, new Date(asOf + "T12:00:00Z").toISOString()))}
        disabled={busy || !bal.trim()}
        className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : "Save"}
      </button>
    </div>
  );
}

function TeamRow({ c, busy, run }: { c: Candidate; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const configured = c.payType === "MONTHLY_FLAT" || c.payType === "HOURLY";
  const [open, setOpen] = useState(false);
  const [payType, setPayType] = useState<"MONTHLY_FLAT" | "HOURLY">(c.payType === "HOURLY" ? "HOURLY" : "MONTHLY_FLAT");
  const [monthly, setMonthly] = useState(c.monthlyPay ? String(c.monthlyPay) : "");
  const [rate, setRate] = useState(c.hourlyRate ? String(c.hourlyRate) : "");
  const [hours, setHours] = useState("");
  const [amount, setAmount] = useState("");

  // Setup: first tell the Hub how this person is paid.
  if (!configured) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">{c.name} <span className="text-[11px] font-normal text-warning">— set up pay</span></div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-32"><Field label="Paid">
            <select value={payType} onChange={(e) => setPayType(e.target.value as "MONTHLY_FLAT" | "HOURLY")} className={inputCls}>
              <option value="MONTHLY_FLAT">Monthly flat</option>
              <option value="HOURLY">Hourly</option>
            </select>
          </Field></div>
          {payType === "MONTHLY_FLAT"
            ? <div className="w-28"><Field label="Per month"><input value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="$2,500" className={inputCls} /></Field></div>
            : <div className="w-24"><Field label="$ / hour"><input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="$" className={inputCls} /></Field></div>}
          <button
            onClick={() => run(() => setTeamPay(c.id, payType, payType === "MONTHLY_FLAT" ? monthly : null, payType === "HOURLY" ? rate : null))}
            disabled={busy} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >Save</button>
        </div>
      </div>
    );
  }

  // Configured: record what was paid this period.
  const recorded = c.recordedThisPeriod != null;
  const defaultAmount = c.payType === "MONTHLY_FLAT" ? (c.monthlyPay ? String(c.monthlyPay) : "") : "";
  return (
    <div className="rounded-lg border border-border bg-surface-2/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{c.name}
          <span className="ml-1.5 text-[11px] text-muted-2">
            {c.payType === "MONTHLY_FLAT" ? `${usd(c.monthlyPay ?? 0)}/mo` : `${usd(c.hourlyRate ?? 0)}/hr`}
          </span>
        </span>
        {recorded
          ? <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><Check className="size-3.5" /> {usd(c.recordedThisPeriod ?? 0)} recorded</span>
          : <button onClick={() => { setOpen((o) => !o); setAmount(defaultAmount); }} className="inline-flex items-center gap-1 text-xs font-medium text-brand"><Plus className="size-3.5" /> Record pay</button>}
      </div>
      {open && !recorded && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {c.payType === "HOURLY" && (
            <div className="w-20"><Field label="Hours"><input value={hours} onChange={(e) => { setHours(e.target.value); const h = parseFloat(e.target.value); if (!isNaN(h) && c.hourlyRate) setAmount(String(Math.round(h * c.hourlyRate * 100) / 100)); }} className={inputCls} inputMode="decimal" /></Field></div>
          )}
          <div className="w-28"><Field label="Amount paid"><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$" className={inputCls} /></Field></div>
          <button
            onClick={() => run(() => recordPayrollEntry({
              teamMemberId: c.id, periodStart: c.entryKey, payDateISO: c.payDateISO,
              basis: c.payType === "HOURLY" ? "HOURLY" : "MONTHLY_FLAT",
              hours: c.payType === "HOURLY" ? hours : null, rate: c.payType === "HOURLY" ? c.hourlyRate : c.monthlyPay, amount,
            }))}
            disabled={busy || !amount.trim()} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >Save</button>
        </div>
      )}
    </div>
  );
}

const CATEGORIES = ["software", "subscriptions", "gear", "travel", "contractor", "owner_draw", "other"];

function ExpenseForm({ busy, run }: { busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("software");
  const [vendor, setVendor] = useState("");
  const [spentAt, setSpentAt] = useState(todayKey());
  const [personal, setPersonal] = useState(false);
  const [recurring, setRecurring] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-24"><Field label="Amount"><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$" className={inputCls} /></Field></div>
        <div className="w-36"><Field label="Category">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
          </select>
        </Field></div>
        <div className="w-32"><Field label="Vendor (optional)"><input value={vendor} onChange={(e) => setVendor(e.target.value)} className={inputCls} /></Field></div>
        <div className="w-36"><Field label="Date"><input type="date" value={spentAt} onChange={(e) => setSpentAt(e.target.value)} className={inputCls} /></Field></div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} /> Personal / owner draw (not a business cost)</label>
        <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} /> Recurring monthly</label>
        <button
          onClick={() => run(() => addExpense({ amount, category, spentAtISO: new Date(spentAt + "T12:00:00Z").toISOString(), vendor, personal, recurring }))}
          disabled={busy || !amount.trim()} className="ml-auto rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >{busy ? <Loader2 className="size-4 animate-spin" /> : "Add expense"}</button>
      </div>
    </div>
  );
}
