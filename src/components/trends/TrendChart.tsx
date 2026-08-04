"use client";

import { useState } from "react";

// Hand-rolled time-series bars — the hub carries no chart library, so this
// follows the same div+inline-height pattern the finance tabs use. Two views
// (orders / dollars) because a flat order count can hide a collapsing ticket,
// which is exactly what happened in July.
export type Point = { key: string; label: string; count: number; revenue: number };

export function TrendChart({ daily, monthly }: { daily: Point[]; monthly: Point[] }) {
  const [span, setSpan] = useState<"90d" | "24m">("90d");
  const [metric, setMetric] = useState<"count" | "revenue">("count");
  const points = span === "90d" ? daily : monthly;
  const value = (p: Point) => (metric === "count" ? p.count : p.revenue);
  const max = Math.max(1, ...points.map(value));
  const fmt = (n: number) => (metric === "count" ? String(n) : `$${Math.round(n).toLocaleString("en-US")}`);
  const total = points.reduce((s, p) => s + value(p), 0);

  const Toggle = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${on ? "bg-brand text-white" : "border border-border text-muted hover:bg-surface-2"}`}
    >
      {children}
    </button>
  );

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 panel-shadow">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Bookings over time</h2>
        <div className="ml-auto flex items-center gap-1.5">
          <Toggle on={metric === "count"} onClick={() => setMetric("count")}>Orders</Toggle>
          <Toggle on={metric === "revenue"} onClick={() => setMetric("revenue")}>Dollars</Toggle>
          <span className="mx-1 h-4 w-px bg-border" />
          <Toggle on={span === "90d"} onClick={() => setSpan("90d")}>90 days</Toggle>
          <Toggle on={span === "24m"} onClick={() => setSpan("24m")}>24 months</Toggle>
        </div>
      </div>

      <div className="flex h-40 items-end gap-px" role="img" aria-label={`Bookings by ${span === "90d" ? "day" : "month"}`}>
        {points.map((p) => {
          const v = value(p);
          const h = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * 100) : 0;
          return (
            <div key={p.key} className="group relative flex h-full flex-1 items-end" title={`${p.label}: ${fmt(v)}`}>
              <div
                className={`w-full rounded-t transition-colors ${v === 0 ? "bg-border/40" : "bg-brand/70 group-hover:bg-brand"}`}
                style={{ height: `${h}%` }}
              />
              {/* Hover readout — cheaper and more reliable than a tooltip lib */}
              <span className="pointer-events-none absolute -top-1 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-black/85 px-1.5 py-0.5 text-[10px] font-medium text-white group-hover:block">
                {p.label} · {fmt(v)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-2">
        <span>{points[0]?.label}</span>
        <span className="font-medium text-muted">
          {fmt(total)} across {span === "90d" ? "90 days" : "24 months"}
        </span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}
