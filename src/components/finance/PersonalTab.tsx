import { User, Wallet, CalendarDays, PieChart } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { personalSpending } from "@/lib/bookkeeping";

export const dynamic = "force-dynamic";

const YEAR_START = "2026-01-01";
const m0 = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const MONTH_LABEL = (key: string) => new Date(`${key}-01T12:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });

// Category → color (from the shared PALETTE family) so bars read as one system.
const BUCKET_COLOR: Record<string, string> = {
  "Rent & housing": "#8b93e6",
  "Dining & delivery": "#d4a95f",
  "Shopping": "#6ba3d6",
  "Cash & ATM": "#9aa4b2",
  "Convenience & snacks": "#d782ac",
  "Subscriptions & streaming": "#b389d6",
  "Groceries": "#5cb98a",
  "Personal care & health": "#4fb3a6",
  "Family & kids": "#e96320",
  "Loans & financing": "#ec6a6a",
  "Fuel & auto": "#d4a95f",
  "Other": "#6a6a6a",
};
const color = (b: string) => BUCKET_COLOR[b] ?? "#6a6a6a";

// Personal spending — the owner-draw side, made legible: where your own money
// goes, by category, month, and vendor. Read-only glance.
export async function PersonalTab({ show }: { show: FinanceTab[] }) {
  const now = new Date();
  const endKey = now.toISOString().slice(0, 10);
  const monthKey = endKey.slice(0, 7);
  const data = await personalSpending(YEAR_START, endKey);

  const monthsElapsed = Math.max(1, (now.getTime() - new Date(`${YEAR_START}T00:00:00Z`).getTime()) / (30.44 * 864e5));
  const thisMonth = data.byMonth[monthKey] ?? 0;
  const avgMonth = data.total / monthsElapsed;
  const biggest = data.byBucket[0];
  const maxBucket = Math.max(1, ...data.byBucket.map((b) => b.amount));
  const months = Object.entries(data.byMonth).sort(([a], [b]) => a.localeCompare(b));
  const maxMonth = Math.max(1, ...months.map(([, v]) => v));

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Personal" subtitle="Where your own money goes — every personal dollar, sorted" />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="personal" show={show} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi icon={Wallet} accent="#d4a95f" label={`${MONTH_LABEL(monthKey)} spend`} value={m0(thisMonth)} sub="this month so far" />
          <Kpi icon={CalendarDays} accent="#6ba3d6" label="Personal · 2026 YTD" value={m0(data.total)} sub={`${data.count} transactions`} />
          <Kpi icon={User} accent="#8b93e6" label="Average / month" value={m0(avgMonth)} sub="personal burn rate" />
          <Kpi icon={PieChart} accent={color(biggest?.bucket ?? "Other")} label="Biggest category" value={biggest ? m0(biggest.amount) : "—"} sub={biggest?.bucket ?? "—"} />
        </div>

        {/* MONTHLY TREND */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <CalendarDays className="size-4 text-brand" /> Personal spend by month
          </div>
          <div className="flex items-end gap-2 sm:gap-3" style={{ height: 150 }}>
            {months.map(([key, v]) => (
              <div key={key} className="flex flex-1 flex-col items-center justify-end gap-1">
                <span className="text-[10px] font-semibold tabular-nums text-foreground/80">{m0(v)}</span>
                <div className="flex w-full items-end justify-center" style={{ height: 108 }}>
                  <div className="w-full max-w-[42px] rounded-t bg-brand/70" style={{ height: `${Math.max(4, (v / maxMonth) * 108)}px` }} />
                </div>
                <span className="text-[10px] text-muted-2">{MONTH_LABEL(key)}</span>
              </div>
            ))}
          </div>
        </section>

        {/* BY CATEGORY */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <PieChart className="size-4 text-brand" /> Where it goes
          </div>
          <div className="space-y-2.5">
            {data.byBucket.map((b) => (
              <div key={b.bucket} className="flex items-center gap-3">
                <div className="w-40 shrink-0 truncate text-sm text-foreground/85">{b.bucket}</div>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full" style={{ width: `${(b.amount / maxBucket) * 100}%`, backgroundColor: color(b.bucket) }} />
                </div>
                <div className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">{m0(b.amount)}</div>
                <div className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-2">{Math.round((b.amount / data.total) * 100)}%</div>
              </div>
            ))}
          </div>
        </section>

        {/* TOP VENDORS */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <User className="size-4 text-brand" /> Top places your money went
          </div>
          <div className="divide-y divide-border/60">
            {data.topVendors.map((v) => (
              <div key={v.vendor} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0 truncate text-sm font-medium text-foreground/90">{v.vendor}</div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-[11px] text-muted-2">{v.count}×</span>
                  <span className="w-20 text-right text-sm font-semibold tabular-nums">{m0(v.amount)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, accent, label, value, sub }: { icon: LucideIcon; accent: string; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 panel-shadow">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${accent}1a`, color: accent }}>
          <Icon className="size-4" />
        </span>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted-2">{sub}</div>}
    </div>
  );
}
