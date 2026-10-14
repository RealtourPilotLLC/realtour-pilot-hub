import { etDateTime, etMonthDay } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// The 30-day balance sparkline for the credits page (plan 10.4), plain SVG
// from the BALANCE_SNAPSHOT rows (one point per 3 hours, see data.ts). The
// warning and critical levels are drawn as dashed lines so "how close are we"
// reads at a glance. Theme tokens only, so it works in light and dark.
// ---------------------------------------------------------------------------

export function BalanceSparkline({ points, warn, critical }: { points: { at: string; balance: number }[]; warn: number; critical: number }) {
  if (points.length < 2) {
    return <p className="text-sm text-muted">{points.length === 1 ? `One reading so far: ${points[0].balance.toLocaleString("en-US")} credits on ${etDateTime(points[0].at)}.` : "No balance readings in the last 30 days yet."}</p>;
  }
  const W = 640;
  const H = 140;
  const PAD = 6;
  const t0 = Date.parse(points[0].at);
  const t1 = Date.parse(points[points.length - 1].at);
  const values = points.map((p) => p.balance);
  const lo = Math.min(0, ...values, critical);
  const hi = Math.max(...values, warn) * 1.08 || 1;
  const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / Math.max(1, hi - lo)) * (H - 2 * PAD);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(Date.parse(p.at)).toFixed(1)},${y(p.balance).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const min = points.reduce((a, b) => (b.balance < a.balance ? b : a));
  const max = points.reduce((a, b) => (b.balance > a.balance ? b : a));
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label={`AutoHDR balance over the last 30 days: now ${last.balance}, lowest ${min.balance}, highest ${max.balance}`} preserveAspectRatio="none">
        <line x1={PAD} x2={W - PAD} y1={y(warn)} y2={y(warn)} stroke="var(--warning)" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line x1={PAD} x2={W - PAD} y1={y(critical)} y2={y(critical)} stroke="var(--danger)" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <path d={`${d} L${x(t1).toFixed(1)},${H - PAD} L${x(t0).toFixed(1)},${H - PAD} Z`} fill="var(--brand-soft)" stroke="none" />
        <path d={d} fill="none" stroke="var(--brand)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx={x(t1)} cy={y(last.balance)} r={3.5} fill="var(--brand)" />
      </svg>
      <figcaption className="mt-1 flex flex-wrap justify-between gap-2 text-[12px] text-muted">
        <span>{etMonthDay(points[0].at)}</span>
        <span>
          Lowest {min.balance.toLocaleString("en-US")} · highest {max.balance.toLocaleString("en-US")} · <span className="text-warning">warn {warn}</span> · <span className="text-danger">critical {critical}</span>
        </span>
        <span>{etMonthDay(last.at)}</span>
      </figcaption>
    </figure>
  );
}
