"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

// Expandable KPI strip: same look as the old static Kpi cards, but a card with
// `details` opens a full-width breakdown panel under the strip (tap again or
// tap another card to switch). Icons arrive pre-rendered from the server.
export type KpiDetail = { label: string; value: string; sub?: string };
export type KpiItem = {
  key: string;
  icon: ReactNode;
  accent: string;
  label: string;
  value: string;
  sub?: string;
  tone?: "danger" | "success" | "warning" | "muted";
  detailTitle?: string;
  details?: KpiDetail[];
};

export function KpiCards({ items }: { items: KpiItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const active = items.find((i) => i.key === open && i.details?.length);

  const toneColor = (t?: KpiItem["tone"]) =>
    t === "danger" ? "text-danger" : t === "success" ? "text-success" : t === "warning" ? "text-warning" : "text-foreground";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {items.map((it) => {
          const expandable = (it.details?.length ?? 0) > 0;
          const isOpen = open === it.key && expandable;
          const Card = (
            <>
              <div className="flex items-center gap-2">
                <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${it.accent}1a`, color: it.accent }}>
                  {it.icon}
                </span>
                <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-2">{it.label}</span>
                {expandable && <ChevronDown className={`ml-auto size-3.5 shrink-0 text-muted-2 transition-transform ${isOpen ? "rotate-180" : ""}`} />}
              </div>
              <div className={`mt-2 text-2xl font-bold tabular-nums ${toneColor(it.tone)}`}>{it.value}</div>
              {it.sub && <div className="mt-0.5 truncate text-[11px] text-muted-2">{it.sub}</div>}
            </>
          );
          return expandable ? (
            <button
              key={it.key}
              onClick={() => setOpen(isOpen ? null : it.key)}
              className={`rounded-2xl border bg-surface p-4 text-left panel-shadow transition-colors hover:bg-surface-2/60 ${isOpen ? "border-brand/60" : "border-border"}`}
            >
              {Card}
            </button>
          ) : (
            <div key={it.key} className="rounded-2xl border border-border bg-surface p-4 panel-shadow">{Card}</div>
          );
        })}
      </div>

      {active && (
        <section className="rounded-2xl border border-brand/40 bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">{active.detailTitle ?? active.label}</span>
            <button onClick={() => setOpen(null)} className="text-[11px] text-muted-2 underline-offset-2 hover:underline">Close</button>
          </div>
          <div className="max-h-80 divide-y divide-border/50 overflow-y-auto scroll-thin">
            {active.details!.map((d, i) => (
              <div key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {d.label}
                  {d.sub && <span className="ml-1.5 text-[11px] text-muted-2">{d.sub}</span>}
                </span>
                <span className="shrink-0 font-medium tabular-nums">{d.value}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
