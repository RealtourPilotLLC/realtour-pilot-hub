import type { HubStatsSlice } from "@/lib/hubChats";

// A lightweight SVG donut + legend for the question-category breakdown. No chart
// library: slices are drawn with stroke-dasharray on stacked circles.
export function HubPie({ total, slices }: { total: number; slices: HubStatsSlice[] }) {
  if (total === 0 || slices.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted">
        No questions yet. Ask the Hub a few things and usage will show up here.
      </div>
    );
  }

  const r = 42;
  const cx = 60;
  const cy = 60;
  const C = 2 * Math.PI * r;
  let offset = 0;
  const arcs = slices.map((s) => {
    const len = (s.count / total) * C;
    const el = (
      <circle
        key={s.key}
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={s.color}
        strokeWidth={16}
        strokeDasharray={`${len} ${C - len}`}
        strokeDashoffset={-offset}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    );
    offset += len;
    return el;
  });

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-7">
      <svg viewBox="0 0 120 120" className="size-40 shrink-0">
        {arcs}
        <text x={cx} y={cy - 3} textAnchor="middle" className="fill-foreground" style={{ fontSize: 20, fontWeight: 600 }}>
          {total}
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" className="fill-muted" style={{ fontSize: 8, letterSpacing: 0.5 }}>
          QUESTIONS
        </text>
      </svg>
      <div className="grid w-full grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {slices.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-sm">
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="flex-1 truncate text-foreground/85">{s.label}</span>
            <span className="tabular-nums font-medium text-foreground">{s.count}</span>
            <span className="w-9 text-right tabular-nums text-xs text-muted">{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
