import { Briefcase, User, AlertTriangle, ArrowLeftRight, Wallet, CreditCard } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FinanceTabs, type FinanceTab } from "@/components/finance/FinanceTabs";
import { categoryBreakdown, vendorBreakdown, cardPaydowns } from "@/lib/financeCategories";
import { revenueByProcessor } from "@/lib/bookkeeping";
import { SpendingCategories } from "@/components/finance/SpendingCategories";
import { VendorTable } from "@/components/finance/VendorTable";
import { KpiCards } from "@/components/finance/KpiCards";
import { Store } from "lucide-react";

export const dynamic = "force-dynamic";
const m = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// "Where the money goes" — every 2026 bank/card/Venmo dollar categorized as
// BUSINESS or PERSONAL, with self-transfers / card paydowns / top-ups excluded
// as movement (not spend). Built from src/lib/financeCategories.ts.
export async function SpendingTab({ show }: { show: FinanceTab[] }) {
  const year = new Date().getUTCFullYear();
  const start = `${year}-01-01`, end = `${year}-12-31`;
  const [b, rev, vb, cards] = await Promise.all([
    categoryBreakdown(start, end),
    revenueByProcessor(start, end),
    vendorBreakdown(start, end),
    cardPaydowns(start, end),
  ]);

  const revenue = rev.total;
  const profit = revenue - b.businessTotal;
  const marginPct = revenue > 0 ? Math.round((profit / revenue) * 100) : 0;
  // Categories the owner can move a charge into (from the live breakdown).
  const allCategories = [
    ...b.business.map((r) => ({ category: r.category, kind: "BUSINESS" })),
    ...b.personal.map((r) => ({ category: r.category, kind: "PERSONAL" })),
  ];

  return (
    <div>
      <PageHeader eyebrow="Finance" title="Categories" subtitle={`Every ${year} dollar — business vs personal, by category`} />
      <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        <FinanceTabs tab="spending" show={show} />

        {/* Summary strip — tap a card for its breakdown */}
        <KpiCards
          items={[
            {
              key: "revenue", icon: <Briefcase className="size-4" />, accent: "#5cb98a",
              label: "Revenue", value: m(revenue), sub: "all rails",
              detailTitle: "Revenue by processor rail",
              details: [
                { label: "Stripe (per-shoot card payments)", value: m(rev.stripe) },
                { label: "QuickBooks Payments (bundles + social)", value: m(rev.quickbooks) },
                { label: "Venmo (Stephen Kennedy)", value: m(rev.venmo) },
              ],
            },
            {
              key: "business", icon: <Briefcase className="size-4" />, accent: "#6ba3d6",
              label: "Business costs", value: m(b.businessTotal), sub: `${b.business.length} categories`,
              detailTitle: "Biggest business categories",
              details: b.business.slice(0, 12).map((r) => ({ label: r.category, value: m(r.sum), sub: r.count ? `${r.count}×` : undefined })),
            },
            {
              key: "profit", icon: <Wallet className="size-4" />, accent: profit > 0 ? "#5cb98a" : "#ec6a6a",
              label: "True profit", value: m(profit), sub: `${marginPct}% margin`,
              detailTitle: "The math",
              details: [
                { label: "Revenue (all rails)", value: m(revenue) },
                { label: "− Business costs", value: m(b.businessTotal) },
                { label: "= True profit", value: m(profit), sub: `${marginPct}% margin` },
              ],
            },
            {
              key: "personal", icon: <User className="size-4" />, accent: "#d4a95f",
              label: "Personal spend", value: m(b.personalTotal), sub: "consumption (excl. transfers)",
              detailTitle: "Biggest personal categories",
              details: b.personal.slice(0, 12).map((r) => ({ label: r.category, value: m(r.sum), sub: r.count ? `${r.count}×` : undefined })),
            },
          ]}
        />

        {b.reviewTotal > 100 && (
          <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <span><span className="font-medium">{m(b.reviewTotal)}</span> still needs a call — see “To review” below. Re-tagging any row is coming next; for now these sit out of the totals above.</span>
          </div>
        )}

        {/* Interactive: business / personal / review — tap to drill in and re-tag */}
        <SpendingCategories
          business={b.business} personal={b.personal} review={b.review}
          businessTotal={b.businessTotal} personalTotal={b.personalTotal}
          allCategories={allCategories}
          startKey={start} endKey={end}
        />

        {/* VENDORS — YTD + average monthly per payee */}
        <section className="rounded-2xl border border-border bg-surface">
          <div className="border-b border-border px-5 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold"><Store className="size-4 text-brand" /> Vendors & payees</span>
            <p className="mt-0.5 text-[11px] text-muted-2">Every payee grouped — what you&apos;ve paid so far this year and what it runs per month ({vb.months.toFixed(1)} months elapsed).</p>
          </div>
          <div className="overflow-x-auto scroll-thin">
            <VendorTable vendors={vb.vendors.filter((v) => v.ytd >= 40)} />
          </div>
          <p className="border-t border-border px-5 py-2 text-[11px] text-muted-2">Showing payees over $40 YTD. Tap a column header to sort. Money-movement (transfers, card paydowns) excluded.</p>
        </section>

        {/* CREDIT-CARD PAYMENTS — cash sent to each card, and who funded it */}
        {cards.total > 0 && (
          <section className="rounded-2xl border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div>
                <span className="flex items-center gap-2 text-sm font-semibold"><CreditCard className="size-4 text-brand" /> Credit-card payments</span>
                <p className="mt-0.5 text-[11px] text-muted-2">Cash sent to your cards this year. The purchases on those cards are already counted in the categories above, so these never double into the totals.</p>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-bold tabular-nums">{m(cards.total)}</div>
                <div className="text-[11px] tabular-nums text-muted-2">{m(cards.thisMonth)} this mo.</div>
              </div>
            </div>
            <div className="divide-y divide-border/60">
              {cards.byCard.map((c) => (
                <div key={c.card} className="flex items-center justify-between gap-3 px-5 py-2 text-sm">
                  <span className="truncate">{c.card}<span className="ml-1.5 text-[11px] text-muted-2">{c.count}×</span></span>
                  <span className="shrink-0 tabular-nums">{m(c.sum)}<span className="ml-2 text-[11px] text-muted-2">{m(c.avgMonthly)}/mo</span></span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-2 text-[11px] text-muted-2">
              <span>Funded from <span className="font-medium text-[#6ba3d6]">business checking {m(cards.fromBusiness)}</span></span>
              <span>· <span className="font-medium text-[#d4a95f]">personal accounts {m(cards.fromPersonal)}</span></span>
            </div>
          </section>
        )}

        {/* Excluded — money movement (read-only; card paydowns have their own spot above) */}
        <Section title="Excluded — money movement, not spend" icon={ArrowLeftRight} note="Transfers between your own accounts and Stripe top-ups. Counted nowhere so they never inflate the totals. Card payments have their own card above.">
          {b.excluded.filter((r) => r.category !== "Credit-card paydown").map((r) => <Line key={r.category} label={r.category} value={r.sum} count={r.count} muted />)}
        </Section>

        <p className="px-1 text-[11px] text-muted-2">
          Personal spending is consumption on your connected accounts — transfers to your wife’s account and card paydowns are money-movement and sit in “Excluded” below, while her card’s actual spending is counted. Bank + card + Venmo, {year}.
        </p>
      </div>
    </div>
  );
}

function Section({ title, icon: Icon, note, children }: { title: string; icon: typeof Briefcase; note: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface">
      <div className="border-b border-border px-5 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-muted" /> {title}</span>
        <p className="mt-0.5 text-[11px] text-muted-2">{note}</p>
      </div>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  );
}

function Line({ label, value, count, muted }: { label: string; value: number; count?: number; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 px-5 py-2 text-sm ${muted ? "text-muted" : ""}`}>
      <span className="truncate">{label}{count ? <span className="ml-1.5 text-[11px] text-muted-2">{count}×</span> : null}</span>
      <span className="shrink-0 tabular-nums">{m(value)}</span>
    </div>
  );
}

function Kpi({ icon: Icon, accent, label, value, sub }: { icon: typeof Briefcase; accent: string; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 panel-shadow">
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${accent}1a`, color: accent }}><Icon className="size-4" /></span>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted-2">{sub}</div>}
    </div>
  );
}
