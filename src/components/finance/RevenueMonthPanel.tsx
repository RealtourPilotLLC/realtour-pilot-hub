import { cn } from "@/lib/utils";
import type { RailKey, RevenueMonth } from "@/lib/revenueMonthCore";

// ---------------------------------------------------------------------------
// REVENUE THIS MONTH, ALL RAILS, GROSS AND NET (Oct 24 2026, Jordan: "add MTD
// Revenue for all revenue gross and net"). Inset in the dashboard's Financial
// Position card beside the Stripe panel; the arithmetic is revenueMonthCore.
// ---------------------------------------------------------------------------

const money = (n: number | null) => (n == null ? "Not known" : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const RAIL_SWATCH: Record<RailKey, string> = { quickbooks: "bg-brand", stripe: "bg-brand/55", venmo: "bg-brand/25" };

export function RevenueMonthPanel({ r }: { r: RevenueMonth | null }) {
  return (
    <section aria-labelledby="revenue-month-title" className="min-w-0 rounded-xl border border-border p-4" data-revenue-month>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 id="revenue-month-title" className="mr-auto text-base font-semibold tracking-tight">Revenue this month</h4>
        <span className="text-[12px] text-muted">All revenue: QuickBooks Payments, Stripe and Venmo</span>
      </div>
      {!r ? (
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">This month&rsquo;s revenue didn&rsquo;t load. Refresh to try again. This is not $0.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-surface-2/60 p-3" data-revenue="gross" data-value={r.gross}>
              <p className="text-[13px] text-muted">{r.monthLabel} gross</p>
              <p className="text-xl font-bold tabular-nums sm:text-2xl">{money(r.gross)}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted">Everything clients paid, before refunds and fees</p>
            </div>
            <div className="rounded-xl bg-surface-2/60 p-3" data-revenue="net" data-value={r.net ?? "unknown"}>
              <p className="text-[13px] text-muted">{r.monthLabel} net</p>
              <p className={cn("text-xl font-bold tabular-nums sm:text-2xl", r.net == null ? "text-base font-semibold text-muted" : "text-success")}>{money(r.net)}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted">
                {r.fees == null ? "A fee record didn't load, so net isn't known" : `After ${money(r.fees)} of processing fees${r.refunds ? ` and ${money(r.refunds)} refunded` : ""}`}
              </p>
            </div>
          </div>

          {r.gross > 0 && (
            <div aria-hidden className="mt-3 flex h-1.5 gap-px overflow-hidden rounded-full bg-surface-2">
              {r.rails.filter((x) => x.gross > 0).map((x) => <span key={x.key} className={RAIL_SWATCH[x.key]} style={{ width: `${(x.gross / r.gross) * 100}%` }} />)}
            </div>
          )}

          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted">
                <th scope="col" className="py-1 text-left font-semibold">Rail</th>
                <th scope="col" className="py-1 text-right font-semibold">Gross</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {r.rails.map((x) => (
                <tr key={x.key} data-rail={x.key} className="align-top">
                  <th scope="row" className="py-1.5 text-left font-medium">
                    <span className="inline-flex items-center gap-2"><span aria-hidden className={cn("size-2 shrink-0 rounded-full", RAIL_SWATCH[x.key])} />{x.label}</span>
                    {x.through && <span className="ml-1 text-[11px] font-normal text-muted">({x.through})</span>}
                    {x.missing && <span className="mt-0.5 block text-[11px] font-normal leading-snug text-warning" data-rail-missing>{x.missing}</span>}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">{money(x.gross)}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{money(x.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] leading-snug text-muted">
            Net takes off refunds and each rail&rsquo;s fee for taking the money: Stripe&rsquo;s card fees, QuickBooks Payments fees, Venmo&rsquo;s instant-transfer fees. The Stripe Capital loan and Stripe&rsquo;s billing aren&rsquo;t sales costs and stay out.
          </p>
        </>
      )}
    </section>
  );
}
