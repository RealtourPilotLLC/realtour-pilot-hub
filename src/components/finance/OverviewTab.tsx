import Link from "next/link";
import {
  Wallet, TrendingUp, TrendingDown, PiggyBank, ArrowRight, ArrowUpRight,
  Landmark, Receipt, Users, AlertTriangle, CheckCircle2, CircleDollarSign, ScrollText, HandCoins,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { KpiCards } from "@/components/finance/KpiCards";
import { revenueByProcessor } from "@/lib/bookkeeping";
import { categoryBreakdown } from "@/lib/financeCategories";
import { SavingsPlan, type SavingsItemView } from "@/components/finance/SavingsPlan";
import { getCashPosition, getMonthlyPnl, monthBounds } from "@/lib/finance";
import { prisma } from "@/lib/prisma";
import { etDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

const YEAR_START = "2026-01-01";

// Rounded-dollar money format. Negative → en-dash prefix. Null → em-dash.
const m0 = (n: number | null | undefined) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
// Compact form for tight spots (donut center): $324,295 → $324k.
const abbr = (n: number) =>
  Math.abs(n) >= 1000 ? `$${Math.round(n / 1000).toLocaleString("en-US")}k` : `$${Math.round(n)}`;
const pct = (n: number | null | undefined) => (n == null ? "—" : `${n < 0 ? "−" : "+"}${Math.abs(Math.round(n * 100))}%`);

// Rail colors (from the shared PALETTE family) — kept consistent with the donut.
const RAIL = {
  quickbooks: { label: "QuickBooks Payments", color: "#5cb98a", sub: "bundles + monthly social" },
  stripe: { label: "Stripe", color: "#8b93e6", sub: "per-shoot card payments" },
  venmo: { label: "Venmo", color: "#6ba3d6", sub: "Stephen Kennedy" },
};

// Books-health snapshot straight off the classified ledger.
//
// `lastSynced` is when WE last pulled — it is NOT whether the books are current,
// and treating it as such is how a two-week hole stayed invisible: the nightly
// pull kept reporting "synced today" while the newest entry in QuickBooks was
// Aug 4 (Aug 2026 audit). `newestEntry` is the honest measure — the date of the
// most recent transaction the books actually contain — and `bankSince` counts
// the bank lines that have posted after it, i.e. the work still to be entered.
async function booksHealth() {
  const from = new Date(`${YEAR_START}T00:00:00Z`);
  const [grouped, needsReview, total, last, newest] = await Promise.all([
    prisma.qboTransaction.groupBy({ by: ["category"], where: { txnDate: { gte: from } }, _count: true, _sum: { amount: true } }),
    prisma.qboTransaction.count({ where: { txnDate: { gte: from }, needsReview: true } }),
    prisma.qboTransaction.count({ where: { txnDate: { gte: from } } }),
    prisma.qboTransaction.aggregate({ _max: { syncedAt: true } }),
    prisma.qboTransaction.aggregate({ _max: { txnDate: true } }),
  ]);
  const newestEntry = newest._max.txnDate as Date | null;
  // Only real money movement counts as "waiting to be entered" — internal
  // transfers and card paydowns aren't bookkeeping work.
  const bankSince = newestEntry
    ? await prisma.plaidTransaction.count({
        where: { date: { gt: newestEntry }, pending: false, financeKind: { in: ["BUSINESS", "INCOME"] } },
      })
    : 0;
  const daysBehind = newestEntry
    ? Math.floor((Date.now() - newestEntry.getTime()) / 86_400_000)
    : null;
  const cat: Record<string, { n: number; amount: number }> = {};
  for (const g of grouped) cat[g.category ?? "UNCLASSIFIED"] = { n: g._count, amount: g._sum.amount ?? 0 };
  return { cat, needsReview, total, lastSynced: last._max.syncedAt as Date | null, newestEntry, daysBehind, bankSince };
}

// A week is the point where "I'll get to it" has become "the numbers on this
// page are not the business" — expenses lag, so profit reads high until it lands.
const BOOKS_STALE_DAYS = 7;

// The owner's financial command center: revenue counted at the processor, the
// true (categorized) P&L, cash & runway, business-vs-personal, and how clean the
// books are — everything, at a glance. Read-only; the working forms live on Money.
export async function OverviewTab({ show }: { show: FinanceTab[] }) {
  const now = new Date();
  const endKey = now.toISOString().slice(0, 10);
  const monthStartKey = `${monthBounds(0).key}-01`; // yyyy-mm-01 for the current ET month

  const [rev, prevYear, cats, monthCats, cash, month, monthRev, health] = await Promise.all([
    revenueByProcessor(YEAR_START, endKey),
    revenueByProcessor("2025-01-01", "2025-12-31"),
    // ONE SOURCE OF TRUTH: the audited bank+card+Venmo ledger the Categories
    // tab uses — Overview, Personal and Categories all show the SAME numbers.
    categoryBreakdown(YEAR_START, endKey),
    categoryBreakdown(monthStartKey, endKey),
    getCashPosition(),
    getMonthlyPnl(0),
    // This-month revenue must count ALL THREE processor rails — the cash-basis
    // getMonthlyPnl counts Stripe alone, which silently drops every QuickBooks
    // Payments sale (e.g. the $9k SalesReceipt) and understates the month badly.
    revenueByProcessor(monthStartKey, endKey),
    booksHealth(),
  ]);
  // The $5k/mo savings checklist (best-effort: table may not exist pre-push).
  const savingsItems: SavingsItemView[] = await prisma.savingsItem
    .findMany({ orderBy: { rank: "asc" } })
    .then((rows) => rows.map((r) => ({ id: r.id, rank: r.rank, title: r.title, detail: r.detail, savesPerMonth: r.savesPerMonth, tier: r.tier, status: r.status })))
    .catch(() => []);

  // Revenue is the processor-counted total (the trustworthy top line); expenses
  // come from the audited categorized ledger. Profit pairs the two so every
  // finance page agrees.
  const revenue = rev.total;
  const businessExpenses = cats.businessTotal;
  const profit = revenue - businessExpenses;

  const daysElapsed = Math.max(1, (now.getTime() - new Date(`${YEAR_START}T00:00:00Z`).getTime()) / 864e5);
  const annualized = (revenue / daysElapsed) * 365;
  const growth = prevYear.total > 0 ? (annualized - prevYear.total) / prevYear.total : null;

  // This month, all three rails — profit from the same audited ledger.
  const monthRevenue = monthRev.total;
  const monthProfit = monthRevenue - monthCats.businessTotal;
  const monthPayrollPct = monthRevenue > 0 ? month.allPayroll / monthRevenue : null;

  const rails = [
    { key: "quickbooks", amount: rev.quickbooks, ...RAIL.quickbooks },
    { key: "stripe", amount: rev.stripe, ...RAIL.stripe },
    { key: "venmo", amount: rev.venmo, ...RAIL.venmo },
  ].filter((r) => r.amount > 0);

  // Itemize from the audited categories, grouped for glance-ability. A
  // catch-all "other" row guarantees the lines always foot to Net profit.
  const catSum = (...names: string[]) =>
    cats.business.filter((r) => names.includes(r.category)).reduce((s, r) => s + r.sum, 0);
  const gEditing = catSum("Video editing", "Photo editing");
  const gPeople = catSum("Creative specialist pay", "Consulting (Paul)");
  const gSoftware = catSum("Software & subscriptions", "Social media mgmt (resold)", "Marketing & networking");
  const gFees = catSum("Stripe processing fees", "QuickBooks Payments fees", "Bank, card & overdraft fees");
  const gGear = catSum("Gear & equipment", "Floorplans (CubiCasa)", "Travel & tolls (business)");
  const gOther = businessExpenses - gEditing - gPeople - gSoftware - gFees - gGear;

  const profitTone = profit < 0 ? "danger" : "success";
  const runwayTone = cash.projected == null ? "muted" : cash.projected < 0 ? "danger" : cash.projected < 5000 ? "warning" : "success";
  const bankTone = cash.bankBalance == null ? "muted" : cash.bankBalance < 0 ? "danger" : "muted";
  const netFlow = cash.comingIn30 - cash.goingOut30; // typical monthly cash flow

  return (
    <div>
      <PageHeader
        eyebrow="Finance"
        title="Overview"
        subtitle="Where you stand — everything, at a glance"
      />
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="overview" show={show} />

        {/* BOOKS BEHIND — the first thing on the page when the ledger has
            stopped keeping up, because every number below it is then reading
            high: revenue lands in the bank feed instantly, expenses only once
            they're entered. Silent until it matters. */}
        {health.daysBehind != null && health.daysBehind > BOOKS_STALE_DAYS && (
          <div className="flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning-soft p-4">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-warning">
                Your books are {health.daysBehind} days behind
              </p>
              <p className="mt-1 text-xs leading-relaxed text-foreground/85">
                The last transaction in QuickBooks is dated{" "}
                <strong>{health.newestEntry ? etDate(health.newestEntry) : "—"}</strong>
                {health.bankSince > 0 && (
                  <> and <strong>{health.bankSince}</strong> business transaction{health.bankSince === 1 ? " has" : "s have"} hit the
                  bank since</>
                )}
                . The bank feed on this page is current, so the profit figures below are
                running high until those are entered — the expenses simply aren&rsquo;t in yet.
              </p>
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                <Link href="/connections" className="font-medium text-brand hover:underline">Sync QuickBooks now</Link>
                <Link href="/sales?tab=money" className="font-medium text-brand hover:underline">Review the bank feed</Link>
              </div>
            </div>
          </div>
        )}

        {/* HERO — the four numbers that matter most, 2026 year-to-date */}
        <KpiCards
          items={[
            {
              key: "revenue", icon: <CircleDollarSign className="size-4" />, accent: "#5cb98a",
              label: "Revenue · 2026 YTD", value: m0(revenue),
              sub: growth != null ? `${pct(growth)} vs 2025 · ${m0(annualized)} annualized` : `${m0(annualized)} annualized`,
              detailTitle: "Revenue by processor rail",
              details: [
                { label: "Stripe (per-shoot card payments)", value: m0(rev.stripe) },
                { label: "QuickBooks Payments (bundles + social)", value: m0(rev.quickbooks) },
                { label: "Venmo (Stephen Kennedy)", value: m0(rev.venmo) },
                { label: "This month so far", value: m0(monthRevenue), sub: "all rails" },
              ],
            },
            {
              key: "profit", icon: profit < 0 ? <TrendingDown className="size-4" /> : <TrendingUp className="size-4" />,
              accent: profit < 0 ? "#ec6a6a" : "#5cb98a",
              label: "Net profit · YTD", value: m0(profit), tone: profitTone,
              sub: revenue > 0 ? `${Math.round((profit / revenue) * 100)}% margin · provisional` : "provisional",
              detailTitle: "How the profit is built",
              details: [
                { label: "Revenue (all 3 processors)", value: m0(revenue) },
                { label: "− Editing (video + photo)", value: m0(gEditing) },
                { label: "− Photographers, contractors & consulting", value: m0(gPeople) },
                { label: "− Software, marketing & resold services", value: m0(gSoftware) },
                { label: "− Processing, bank & overdraft fees", value: m0(gFees) },
                { label: "− Gear, floorplans & tolls", value: m0(gGear) },
                { label: "− Other business", value: m0(gOther) },
                { label: "= Net profit", value: m0(profit), sub: revenue > 0 ? `${Math.round((profit / revenue) * 100)}% margin` : undefined },
              ],
            },
            {
              key: "bank", icon: <Landmark className="size-4" />, accent: "#6ba3d6",
              label: "In the bank", value: m0(cash.bankBalance), tone: bankTone,
              sub: cash.bankAsOf ? `as of ${etDate(cash.bankAsOf)}` : "not set — add on Money",
            },
            {
              key: "ar", icon: <HandCoins className="size-4" />, accent: "#d4a95f",
              label: "Owed to you", value: m0(cash.arOutstanding),
              sub: "delivered, unpaid (AR)",
            },
          ]}
        />

        {/* SAVINGS PLAN — the $5k/mo cut checklist, tick-off-able */}
        {savingsItems.length > 0 && <SavingsPlan items={savingsItems} />}

        {/* CASH & RUNWAY */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Wallet className="size-4 text-brand" /> Cash &amp; runway
          </div>
          {cash.bankBalance != null ? (
            <div className={`rounded-xl p-4 ${runwayTone === "danger" ? "bg-danger-soft/40" : "bg-surface-2/50"}`}>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">Projected balance after a typical month</div>
              <div className={`text-3xl font-bold ${runwayTone === "danger" ? "text-danger" : runwayTone === "warning" ? "text-warning" : runwayTone === "success" ? "text-success" : "text-foreground"}`}>
                {m0(cash.projected)}
              </div>
              <p className="mt-1 text-xs text-muted">
                Starting from your bank, a typical month brings in about {m0(cash.comingIn30)} and spends {m0(cash.goingOut30)} — a net of {netFlow >= 0 ? "+" : ""}{m0(netFlow)}.
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-surface-2/50 p-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">Typical monthly cash flow</div>
              <div className={`text-3xl font-bold ${netFlow < 0 ? "text-danger" : "text-success"}`}>
                {netFlow >= 0 ? "+" : ""}{m0(netFlow)}<span className="ml-1 text-base font-medium text-muted-2">/mo</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                About {m0(cash.comingIn30)} comes in and {m0(cash.goingOut30)} goes out in a typical month. Add your bank balance on the <Link href="/sales?tab=money" className="font-medium text-brand hover:underline">Money</Link> tab for a full month-end projection.
              </p>
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="In the bank" value={m0(cash.bankBalance)} sub={cash.bankAsOf ? `as of ${etDate(cash.bankAsOf)}` : "not set"} tone={bankTone} />
            <Stat label="Money in ~30d" value={m0(cash.comingIn30)} sub="lands in checking" tone="success" />
            <Stat label="Money out ~30d" value={m0(cash.goingOut30)} sub="out of checking" tone="muted" />
            <Stat label="Owed to you (AR)" value={m0(cash.arOutstanding)} sub="delivered, unpaid" tone={cash.arOutstanding > 0 ? "success" : "muted"} />
          </div>
          {cash.arOutstanding > 0 && (
            <Link href="/sales?tab=unpaid" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
              Chase the {m0(cash.arOutstanding)} you're owed <ArrowRight className="size-3" />
            </Link>
          )}
        </section>

        {/* REVENUE BY PROCESSOR */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <TrendingUp className="size-4 text-brand" /> Revenue by processor
            </div>
            {growth != null && (
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${growth >= 0 ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>
                <ArrowUpRight className="size-3" /> {pct(growth)} YoY
              </span>
            )}
          </div>
          <p className="mb-4 text-xs text-muted">Counted where the money is processed — never at the bank, so payout deposits and personal-account detours can't double-count.</p>
          <Donut total={revenue} rails={rails} />
        </section>

        {/* TRUE P&L */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Receipt className="size-4 text-brand" /> Profit &amp; loss · 2026 YTD
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${profit < 0 ? "bg-danger/10 text-danger" : "bg-success/10 text-success"}`}>
              {m0(profit)} {profit < 0 ? "loss" : "profit"}
            </span>
          </div>
          <div className="divide-y divide-border/60 text-sm">
            <Row label="Revenue (all 3 processors)" value={m0(revenue)} strong />
            <Row label="− Editing (video + photo)" value={m0(gEditing)} icon={<Users className="size-3.5 text-muted-2" />} neg />
            <Row label="− Photographers, contractors & consulting" value={m0(gPeople)} icon={<Users className="size-3.5 text-muted-2" />} neg />
            <Row label="− Software, marketing & resold services" value={m0(gSoftware)} icon={<Receipt className="size-3.5 text-muted-2" />} neg />
            <Row label="− Processing, bank & overdraft fees" value={m0(gFees)} icon={<Receipt className="size-3.5 text-muted-2" />} neg />
            <Row label="− Gear, floorplans & tolls" value={m0(gGear)} icon={<TrendingUp className="size-3.5 text-muted-2" />} neg />
            {Math.abs(gOther) >= 1 && <Row label="− Other business" value={m0(gOther)} neg />}
            <Row label={profit < 0 ? "= Net loss" : "= Net profit"} value={m0(profit)} strong tone={profitTone}
              sub={revenue > 0 ? `${Math.round((profit / revenue) * 100)}% margin` : undefined} />
          </div>
          {cats.reviewTotal > 100 && (
            <p className="mt-3 flex items-start gap-1.5 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {m0(cats.reviewTotal)} still uncategorized (see Categories → To review) — the profit above firms up as they&apos;re tagged.
            </p>
          )}
        </section>

        {/* BUSINESS vs PERSONAL — the insight the checking balance hides */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <PiggyBank className="size-4 text-brand" /> Business vs. personal
          </div>
          <p className="mb-3 text-xs text-muted">Same audited ledger as the Categories tab — every account, card and Venmo, each dollar tagged business or personal.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface-2/40 p-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">Business cost · YTD</div>
              <div className="mt-0.5 text-2xl font-bold text-foreground">{m0(businessExpenses)}</div>
              <p className="mt-1 text-xs text-muted">Editing, photographers, software, fees, gear — audited across every account.</p>
            </div>
            <div className="rounded-xl border border-border bg-surface-2/40 p-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">Personal spending · YTD</div>
              <div className="mt-0.5 text-2xl font-bold text-warning">{m0(cats.personalTotal)}</div>
              <p className="mt-1 text-xs text-muted">Housing, family, nanny, food, cards — the full breakdown lives on the Personal tab.</p>
            </div>
          </div>
        </section>

        {/* BOOKS HEALTH */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ScrollText className="size-4 text-brand" /> Books health
            </div>
            <span className="text-[11px] text-muted-2">
              {health.newestEntry
                ? `entries through ${etDate(health.newestEntry)}`
                : health.lastSynced ? `synced ${etDate(health.lastSynced)}` : "not synced yet"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Ledger transactions" value={health.total.toLocaleString("en-US")} sub="classified in 2026" />
            <Stat label="Need review" value={health.needsReview.toLocaleString("en-US")}
              tone={health.needsReview > 0 ? "warning" : "success"} sub="flagged, not guessed" />
            <Stat
              label="Reconciliation"
              value={
                health.daysBehind != null && health.daysBehind > BOOKS_STALE_DAYS
                  ? `${health.daysBehind}d behind`
                  : health.needsReview > 0 ? "In progress" : "Clean"
              }
              tone={
                (health.daysBehind != null && health.daysBehind > BOOKS_STALE_DAYS) || health.needsReview > 0
                  ? "warning" : "success"
              }
              sub="bank feed vs. ledger"
            />
          </div>
          <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-surface-2/50 p-3 text-xs text-muted">
            {health.needsReview > 0 ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> : <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />}
            <span>
              Revenue is counted at the processor and is solid. Expenses are categorized from the QuickBooks ledger; the flagged
              items above (owner-vs-client transfers, deposit matches) are the last step — a short reconciliation your accountant closes.
              The ledger re-syncs and re-classifies nightly; sync QuickBooks on <Link href="/connections" className="font-medium text-brand hover:underline">Connections</Link> to pull it sooner.
            </span>
          </div>
        </section>

        {/* THIS MONTH + jump links */}
        <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Wallet className="size-4 text-brand" /> This month &amp; where to go next
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label={`${month.label} revenue`} value={m0(monthRevenue)} sub="collected · all 3 rails" tone="success" />
            <Stat label="This month payroll" value={m0(month.allPayroll)} sub="everyone paid" tone="muted" />
            <Stat label={`${month.label} profit`} value={m0(monthProfit)} sub="after all business costs" tone={monthProfit < 0 ? "danger" : "success"} />
            <Stat label="Payroll % of rev" value={monthPayrollPct == null ? "—" : `${Math.round(monthPayrollPct * 100)}%`} sub="~30–45% normal" tone={monthPayrollPct != null && monthPayrollPct > 0.5 ? "warning" : "muted"} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <JumpLink href="/sales?tab=money" icon={Wallet} label="Money — record cash, expenses, pay" />
            <JumpLink href="/sales?tab=unpaid" icon={Receipt} label="Unpaid — chase AR" />
            <JumpLink href="/sales?tab=payroll" icon={Users} label="Payroll — per-person pay" />
            <JumpLink href="/connections" icon={Landmark} label="Connections — sync QuickBooks / Stripe" />
          </div>
        </section>
      </div>
    </div>
  );
}

// ---- little building blocks ------------------------------------------------

function Kpi({ icon: Icon, accent, label, value, sub, tone }: {
  icon: LucideIcon; accent: string; label: string; value: string; sub?: string; tone?: "danger" | "success" | "warning" | "muted";
}) {
  const color = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 panel-shadow">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${accent}1a`, color: accent }}>
          <Icon className="size-4" />
        </span>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</span>
      </div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted-2">{sub}</div>}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "danger" | "success" | "warning" | "muted" }) {
  const color = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-2">{sub}</div>}
    </div>
  );
}

function Row({ label, value, strong, neg, tone, sub, icon }: {
  label: string; value: string; strong?: boolean; neg?: boolean; tone?: "danger" | "success" | "muted"; sub?: string; icon?: React.ReactNode;
}) {
  const color = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : neg ? "text-muted" : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon}
        <span className={`truncate ${strong ? "font-semibold" : "text-muted"}`}>{label}</span>
      </div>
      <div className="shrink-0 text-right">
        <div className={`tabular-nums ${strong ? "text-base font-bold" : "font-medium"} ${color}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-2">{sub}</div>}
      </div>
    </div>
  );
}

function JumpLink({ href, icon: Icon, label }: { href: string; icon: LucideIcon; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-surface-2 hover:text-foreground">
      <Icon className="size-3.5" /> {label}
    </Link>
  );
}

// SVG donut + legend for the three revenue rails, matching HubPie's technique
// (stacked circles, stroke-dasharray). Total in the center.
function Donut({ total, rails }: { total: number; rails: { key: string; label: string; color: string; sub: string; amount: number }[] }) {
  if (total <= 0 || rails.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted">No revenue recorded yet for 2026.</div>;
  }
  const r = 42, cx = 60, cy = 60, C = 2 * Math.PI * r;
  let offset = 0;
  const arcs = rails.map((s) => {
    const len = (s.amount / total) * C;
    const el = (
      <circle key={s.key} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={16}
        strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform={`rotate(-90 ${cx} ${cy})`} />
    );
    offset += len;
    return el;
  });
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-7">
      <svg viewBox="0 0 120 120" className="size-40 shrink-0">
        {arcs}
        <text x={cx} y={cy - 2} textAnchor="middle" className="fill-foreground" style={{ fontSize: 17, fontWeight: 700 }}>
          {abbr(total)}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="fill-muted" style={{ fontSize: 7, letterSpacing: 0.5 }}>
          2026 YTD
        </text>
      </svg>
      <div className="grid w-full gap-2">
        {rails.map((s) => (
          <div key={s.key} className="flex items-center gap-2.5 text-sm">
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-foreground/90">{s.label}</div>
              <div className="truncate text-[11px] text-muted-2">{s.sub}</div>
            </div>
            <span className="shrink-0 tabular-nums font-semibold text-foreground">{m0(s.amount)}</span>
            <span className="w-10 shrink-0 text-right tabular-nums text-xs text-muted">{Math.round((s.amount / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
