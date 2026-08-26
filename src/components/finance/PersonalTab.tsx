import { User, Wallet, CalendarDays, PieChart } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { KpiCards } from "@/components/finance/KpiCards";
import { personalTruth } from "@/lib/financeCategories";
import { etYearStartKey } from "@/lib/datetime";

export const dynamic = "force-dynamic";

const YEAR_START = etYearStartKey(); // ET year — never frozen at a hard-coded 2026 (audit)
const m0 = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const MONTH_LABEL = (key: string) => new Date(`${key}-01T12:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });

// Stable palette cycle so every category bar gets a distinct color.
const PALETTE_CYCLE = ["#8b93e6", "#d4a95f", "#6ba3d6", "#5cb98a", "#d782ac", "#b389d6", "#4fb3a6", "#e96320", "#ec6a6a", "#9aa4b2"];
const colorAt = (i: number) => PALETTE_CYCLE[i % PALETTE_CYCLE.length];

// Personal spending — now reading the SAME audited bank-truth engine as the
// Categories tab (all accounts + Venmo + cards), not just QBO owner draws.
export async function PersonalTab({ show }: { show: FinanceTab[] }) {
  const now = new Date();
  const endKey = now.toISOString().slice(0, 10);
  const monthKey = endKey.slice(0, 7);
  const data = await personalTruth(YEAR_START, endKey);
  // This-month view for the KPI drill-in (same engine, month-bounded).
  const monthData = await personalTruth(`${monthKey}-01`, endKey);

  const monthsElapsed = Math.max(1, (now.getTime() - new Date(`${YEAR_START}T00:00:00Z`).getTime()) / (30.44 * 864e5));
  const thisMonth = data.byMonth[monthKey] ?? 0;
  const avgMonth = data.total / monthsElapsed;
  const maxBucket = Math.max(1, ...data.byBucket.map((b) => b.amount));
  const months = Object.entries(data.byMonth).sort(([a], [b]) => a.localeCompare(b));
  const maxMonth = Math.max(1, ...months.map(([, v]) => v));

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Personal" subtitle="Where your own money goes — every personal dollar, sorted" />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="personal" show={show} />

        <KpiCards
          items={[
            {
              key: "month", icon: <Wallet className="size-4" />, accent: "#d4a95f",
              label: `${MONTH_LABEL(monthKey)} spend`, value: m0(thisMonth), sub: "this month so far",
              detailTitle: `${MONTH_LABEL(monthKey)} — where it went`,
              details: [
                ...monthData.byBucket.slice(0, 10).map((b) => ({ label: b.bucket, value: m0(b.amount), sub: "category" })),
                ...monthData.topVendors.slice(0, 6).map((v) => ({ label: v.vendor, value: m0(v.amount), sub: `${v.count}× · merchant` })),
              ],
            },
            {
              key: "ytd", icon: <CalendarDays className="size-4" />, accent: "#6ba3d6",
              label: "Personal · 2026 YTD", value: m0(data.total), sub: `${data.count} transactions`,
              detailTitle: "Year to date — by category",
              details: data.byBucket.slice(0, 14).map((b) => ({ label: b.bucket, value: m0(b.amount) })),
            },
            {
              key: "avg", icon: <User className="size-4" />, accent: "#8b93e6",
              label: "Average / month", value: m0(avgMonth), sub: "personal burn rate",
              detailTitle: "Spend by month",
              details: [...months].reverse().map(([key, v]) => ({ label: MONTH_LABEL(key), value: m0(v), sub: key })),
            },
            {
              // NOT a fifth bucket of spending — it is the funding pipe for money
              // already counted in the YTD figure. Labelled "of which" and given
              // a receipts panel so it can never read as additive again.
              key: "wife", icon: <PieChart className="size-4" />, accent: "#e96320",
              label: "…of which sent to ··4284", value: m0(data.toWife), sub: "already counted — not extra",
              detailTitle: "Money sent to your wife's account — where it was spent",
              details: [
                { label: "Sent to ··4284 (net YTD)", value: m0(data.toWife), sub: "the funding transfers" },
                { label: "Her spending already counted above", value: m0(data.wifeCounted), sub: "··4284 purchases + her Venmo payments" },
                { label: "Still uncategorised (in Review)", value: m0(data.wifeInReview), sub: "not in the total yet" },
                { label: "Unaccounted for", value: m0(data.wifeUnaccounted), sub: "gap between sent and found" },
              ],
            },
          ]}
        />

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
            {data.byBucket.map((b, i) => (
              <div key={b.bucket} className="flex items-center gap-3">
                <div className="w-40 shrink-0 truncate text-sm text-foreground/85">{b.bucket}</div>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full" style={{ width: `${(b.amount / maxBucket) * 100}%`, backgroundColor: colorAt(i) }} />
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
