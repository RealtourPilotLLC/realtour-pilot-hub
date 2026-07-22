import Link from "next/link";
import { Wallet, TrendingDown, TrendingUp, AlertTriangle, ArrowRight, Camera, Users, CreditCard, Receipt } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { MoneyEntry } from "@/components/finance/MoneyEntry";
import { getMonthlyPnl, getCashPosition, getPayrollTrend, monthBounds } from "@/lib/finance";
import { payPeriodFor, periodBounds } from "@/lib/payroll";
import { prisma } from "@/lib/prisma";
import { etDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

const m0 = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "danger" | "success" | "muted" }) {
  const color = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-2">{sub}</div>}
    </div>
  );
}

// Owner "Money" dashboard — the executive summary the business never had: cash
// runway, this month's real P&L (revenue minus EVERYONE paid), and payroll as a
// share of revenue. Reads the same trusted sources as the drill-down tabs.
export async function MoneyTab({ show }: { show: FinanceTab[] }) {
  const period = payPeriodFor();
  const pb = periodBounds(period);
  // MONTHLY_FLAT staff (Kim) are recorded once per CALENDAR MONTH, keyed on the
  // month (yyyy-mm-01), so they can't be booked into a P&L month 2–3× (once per
  // bi-weekly payout). HOURLY staff (Remar/Kyle) stay per bi-weekly period.
  const monthKey = monthBounds(0).key; // yyyy-mm
  const monthlyPeriodStart = `${monthKey}-01`;
  const [pnl, prev, cash, trend, candidates, expenses] = await Promise.all([
    getMonthlyPnl(0),
    getMonthlyPnl(1),
    getCashPosition(),
    getPayrollTrend(4),
    prisma.teamMember.findMany({
      where: { OR: [{ payType: { in: ["MONTHLY_FLAT", "HOURLY"] } }, { name: { in: ["Kim Miguel", "Remar", "Kyle Smith"] } }] },
      select: {
        id: true, name: true, payType: true, monthlyPay: true, hourlyRate: true,
        payrollEntries: { where: { periodStart: { in: [period.startKey, monthlyPeriodStart] } }, select: { periodStart: true, amount: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.expense.findMany({ orderBy: { spentAt: "desc" }, take: 12, select: { id: true, amount: true, category: true, vendor: true, note: true, spentAt: true, personal: true, recurring: true } }),
  ]);

  const projTone = cash.projected == null ? "muted" : cash.projected < 0 ? "danger" : cash.projected < 5000 ? "muted" : "success";
  const profitTone = pnl.profit < 0 ? "danger" : "success";
  const maxTrendPct = Math.max(0.5, ...trend.map((t) => t.pct ?? 0));

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Money" subtitle="Your real picture — cash, profit, and where every dollar goes" />
      <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="money" show={show} />

        {/* CASH POSITION — the "will I make payroll?" hero */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Wallet className="size-4 text-brand" /> Cash position
          </div>
          {cash.bankBalance == null ? (
            <div className="rounded-xl border border-dashed border-border bg-surface-2/40 p-4 text-center text-sm text-muted">
              Add your business checking balance below to see your runway and month-end projection.
            </div>
          ) : (
            <div className="rounded-xl bg-surface-2/50 p-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">Projected balance after a typical month</div>
              <div className={`text-3xl font-bold ${projTone === "danger" ? "text-danger" : projTone === "success" ? "text-success" : "text-foreground"}`}>
                {m0(cash.projected)}
              </div>
              <p className="mt-1 text-xs text-muted">
                {cash.projected != null && cash.projected < 0
                  ? "Tight — collecting the money you're owed below is the fastest fix."
                  : `A typical month brings in about ${m0(cash.comingIn30)} and spends ${m0(cash.goingOut30)}.`}
              </p>
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="In the bank" value={m0(cash.bankBalance)} sub={cash.bankAsOf ? `as of ${etDate(cash.bankAsOf)}` : "not set"} tone={cash.bankBalance != null && cash.bankBalance < 0 ? "danger" : "muted"} />
            <Stat label="Owed to you (AR)" value={m0(cash.arOutstanding)} sub="delivered, unpaid" tone={cash.arOutstanding > 0 ? "success" : "muted"} />
            <Stat label="Money in ~30d" value={m0(cash.comingIn30)} sub="typical month" tone="success" />
            <Stat label="Going out ~30d" value={m0(cash.goingOut30)} sub="typical month" tone="muted" />
          </div>
          {cash.arOutstanding > 0 && (
            <Link href="/sales?tab=unpaid" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
              Chase the {m0(cash.arOutstanding)} you're owed <ArrowRight className="size-3" />
            </Link>
          )}
        </section>

        {/* THIS MONTH'S P&L */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {pnl.profit < 0 ? <TrendingDown className="size-4 text-danger" /> : <TrendingUp className="size-4 text-success" />}
              {pnl.label} — profit &amp; loss
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${pnl.profit < 0 ? "bg-danger/10 text-danger" : "bg-success/10 text-success"}`}>
              {m0(pnl.profit)} {pnl.profit < 0 ? "loss" : "profit"}
            </span>
          </div>
          {pnl.revenueIsEstimate && (
            <p className="mb-2 flex items-center gap-1.5 text-[11px] text-warning">
              <AlertTriangle className="size-3.5" /> Revenue is estimated from Aryeo — connect Stripe on Connections for your actual collected amount.
            </p>
          )}
          <div className="divide-y divide-border/60 text-sm">
            <Row label="Money collected" value={m0(pnl.revenue)} strong sub={`delivered this month: ${m0(pnl.invoiced)}`} />
            <Row label="− Photographers" value={m0(pnl.photographerPay)} icon={<Camera className="size-3.5 text-muted-2" />} neg />
            <Row label="− Editors & team (Kim / Remar / Kyle)" value={m0(pnl.teamPay)} icon={<Users className="size-3.5 text-muted-2" />} neg
              hint={pnl.teamPay === 0 ? "record their pay below to see true profit" : undefined} />
            <Row label="− Card processing fees" value={m0(pnl.cardFees)} icon={<CreditCard className="size-3.5 text-muted-2" />} neg />
            <Row label="− Other expenses" value={m0(pnl.expenses)} icon={<Receipt className="size-3.5 text-muted-2" />} neg />
            <Row label={pnl.profit < 0 ? "= Net loss" : "= Net profit"} value={m0(pnl.profit)} strong tone={profitTone}
              sub={pnl.margin != null ? `${pct(pnl.margin)} margin` : undefined} />
          </div>
        </section>

        {/* PAYROLL AS % OF REVENUE — the "am I overpaying?" answer */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <Users className="size-4 text-brand" /> Payroll vs revenue
          </div>
          <p className="mb-3 text-xs text-muted">
            Everyone you pay, as a share of what you collect. For a media agency, ~30–45% is a normal range — higher months are usually a revenue dip, not overpaying.
          </p>
          <div className="flex items-end gap-3">
            {trend.map((t) => {
              const h = t.pct != null ? Math.max(6, (t.pct / maxTrendPct) * 90) : 3;
              const hot = (t.pct ?? 0) > 0.5;
              return (
                <div key={t.key} className="flex flex-1 flex-col items-center gap-1">
                  <span className={`text-[11px] font-semibold ${hot ? "text-danger" : "text-foreground"}`}>{pct(t.pct)}</span>
                  <div className="flex h-24 w-full items-end">
                    <div className={`w-full rounded-t ${hot ? "bg-danger/70" : "bg-brand/70"}`} style={{ height: `${h}%` }} />
                  </div>
                  <span className="text-[10px] text-muted-2">{t.label.split(" ")[0].slice(0, 3)}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* ENTRY — the surfaces that make the numbers real */}
        <MoneyEntry
          period={{ startKey: period.startKey, payoutKey: period.payoutKey, label: `${etDate(pb.start)} – ${etDate(pb.end)}`, monthLabel: pnl.label }}
          candidates={candidates.map((c) => {
            const isMonthly = c.payType === "MONTHLY_FLAT";
            const entryKey = isMonthly ? monthlyPeriodStart : period.startKey;
            // Server-built pay date, always inside the target month (avoids the
            // browser's local timezone shifting it across a month boundary).
            const payDateISO = isMonthly
              ? new Date(`${monthKey}-15T12:00:00Z`).toISOString()
              : new Date(`${period.payoutKey}T12:00:00Z`).toISOString();
            return {
              id: c.id, name: c.name, payType: c.payType, monthlyPay: c.monthlyPay, hourlyRate: c.hourlyRate,
              entryKey, payDateISO,
              recordedThisPeriod: c.payrollEntries.find((e) => e.periodStart === entryKey)?.amount ?? null,
            };
          })}
          expenses={expenses.map((e) => ({
            id: e.id, amount: e.amount, category: e.category, vendor: e.vendor, note: e.note,
            spentAt: etDate(e.spentAt), personal: e.personal, recurring: e.recurring,
          }))}
        />
      </div>
    </div>
  );
}

function Row({ label, value, strong, neg, tone, sub, hint, icon }: {
  label: string; value: string; strong?: boolean; neg?: boolean; tone?: "danger" | "success" | "muted"; sub?: string; hint?: string; icon?: React.ReactNode;
}) {
  const color = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : neg ? "text-muted" : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className={`truncate ${strong ? "font-semibold" : "text-muted"}`}>{label}</span>
        {hint && <span className="hidden shrink-0 text-[11px] text-warning sm:inline">· {hint}</span>}
      </div>
      <div className="shrink-0 text-right">
        <div className={`${strong ? "text-base font-bold" : "font-medium"} ${color}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-2">{sub}</div>}
      </div>
    </div>
  );
}
