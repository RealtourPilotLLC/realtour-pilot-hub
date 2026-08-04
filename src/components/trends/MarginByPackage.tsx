import { Scale } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { getPackageMargins } from "@/lib/packageMargin";

// Reads a PRECOMPUTED row. Costing the year runs the payroll engine, which
// resolves mileage through the public OSRM router — that took a 60-second
// serverless function down in production while running in 3s locally. The engine
// now runs once a night in the cron; this is a single row read.

const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function MarginByPackageSkeleton() {
  return (
    <Section icon={Scale} title="Margin by package" action={<span className="text-[11px] text-muted-2">working out the real cost…</span>}>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-7 animate-pulse rounded bg-surface-2" />
        ))}
      </div>
    </Section>
  );
}

export async function MarginByPackage() {
  const stored = await getPackageMargins();
  if (!stored) {
    return (
      <Section icon={Scale} title="Margin by package" action={<span className="text-[11px] text-muted-2">not built yet</span>}>
        <p className="text-sm text-muted">
          Costing every shoot runs the full payroll engine, so it is worked out once a night rather than while you wait. The first figures
          land with tonight&rsquo;s run.
        </p>
      </Section>
    );
  }
  const margins = stored.data;

  // Unpriced bundle components (a $0 line riding inside a paid package) carry no
  // revenue of their own — the money sits on the priced line.
  const rows = margins.rows.filter((r) => r.orders >= 2 && r.revenue > 0).slice(0, 14);
  if (rows.length === 0) return null;

  return (
    <Section
      icon={Scale}
      title="Margin by package"
      action={
        <span className="text-[11px] text-muted-2">
          {margins.jobs} shoots costed · {usd0(margins.margin)} margin overall
          {margins.marginPct != null ? ` (${Math.round(margins.marginPct)}%)` : ""}
          {stored.ageHours > 30 ? ` · figures from ${Math.round(stored.ageHours / 24)}d ago` : ""}
        </span>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-2">
              <th className="pb-2 font-medium">Package</th>
              <th className="pb-2 text-right font-medium">Orders</th>
              <th className="pb-2 text-right font-medium">Revenue</th>
              <th className="pb-2 text-right font-medium">Cost</th>
              <th className="pb-2 text-right font-medium">Margin</th>
              <th className="pb-2 text-right font-medium">Margin %</th>
              <th className="pb-2 text-right font-medium">Per order</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((p) => {
              // A package with NO modelled cost is not a 100%-margin product —
              // it is one whose cost we do not track (virtual add-ons are billed
              // by an outside vendor and never touch payroll or the editing
              // rates). Printing "100%" there would be the single most
              // misleading number on the page.
              const untracked = p.cost <= 0;
              const pctv = p.marginPct;
              const tone = untracked || pctv == null
                ? "text-muted-2"
                : pctv >= 50
                  ? "text-success"
                  : pctv >= 25
                    ? "text-foreground"
                    : "text-danger";
              return (
                <tr key={p.label}>
                  <td className="max-w-[15rem] truncate py-2 pr-2" title={p.label}>{p.label}</td>
                  <td className="py-2 text-right tabular-nums text-muted">{p.orders}</td>
                  <td className="py-2 text-right tabular-nums">{usd0(p.revenue)}</td>
                  <td className="py-2 text-right tabular-nums text-muted">
                    {untracked ? (
                      <span title="No shoot pay and no in-house editing rate applies — the outside vendor bill is not modelled per job">
                        not tracked
                      </span>
                    ) : (
                      usd0(p.cost)
                    )}
                  </td>
                  <td className="py-2 text-right font-semibold tabular-nums">{untracked ? "—" : usd0(p.margin)}</td>
                  <td className={`py-2 text-right font-semibold tabular-nums ${tone}`}>
                    {untracked || pctv == null ? "—" : `${Math.round(pctv)}%`}
                  </td>
                  <td className="py-2 text-right tabular-nums text-muted-2">{untracked ? "—" : usd0(p.perOrderMargin)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-2">
        Cost is the real photographer payroll plus the real editing bill from the Finance engines, split across the packages on each order
        by what actually drives it: shoot pay follows the eligible invoice (so virtual add-ons, which need no shoot, carry none of it),
        video editing follows the videos an item produces at $299 / $120 / $40, photo editing follows the photo items. This table counts by
        SHOOT date — cost happens when the work happens — so it will not tie exactly to the order-dated revenue above.
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-2">
        Two things make these margins read a little high, both worth knowing:{" "}
        {margins.photoCostKnown < 0.95 && (
          <>
            photo-editing cost is only counted on the {Math.round(margins.photoCostKnown * 100)}% of jobs whose raw folders have been
            counted (about 2-3% of revenue missing overall), and{" "}
          </>
        )}
        your own shoots carry no shoot pay, because you don&rsquo;t pay yourself one — so a package you personally shoot looks cheaper to
        deliver than it will once someone else is shooting it.
      </p>
      {margins.unpricedJobs > 0 && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-2">
          {margins.unpricedJobs} monthly-social session{margins.unpricedJobs === 1 ? " is" : "s are"} left out: Video Starter, Accelerator
          and Pro clients pay a recurring invoice in QuickBooks, and their Aryeo order is priced at $0 on purpose so they can book the
          session they have already paid for without paying twice. Those shoots cost {usd0(margins.unpricedCost)} to deliver and the
          revenue sits on the QuickBooks rail — counting them here would print a fake loss against a product that is actually one of your
          better ones.
        </p>
      )}
    </Section>
  );
}
