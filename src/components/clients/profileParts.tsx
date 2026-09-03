import type { RevisionAsk } from "@/lib/clientProfile";

// Small pieces shared by the two working-profile cards (the full owner/admin one
// and the editor's). No "use client" and no server imports, so either side can
// render them.

export function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-xl border bg-background/40 px-3 py-2 text-center">
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-2">{label}</div>
    </div>
  );
}

export function Bullets({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {icon} {title}
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-sm leading-relaxed text-foreground/90">
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand/60" />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The client's actual recent change requests, read live (never baked into the
// stored profile) so a revision asked this morning shows up this morning.
// Dates are ET, like everywhere else in the hub.
//
// Just the list — no heading of its own. Both cards gather these under their
// one "Past Revision Requests" title (Jordan, Sep 2 2026: "Revisions should be
// titled (Past Revision Requests)"), and when this component carried its own
// "Recent revision asks" heading the full card ended up with two stacked
// titles about the same thing.
export function RecentAsks({ asks }: { asks: RevisionAsk[] }) {
  if (!asks.length) return null;
  return (
    <ul className="space-y-2">
      {asks.map((a, i) => (
        <li key={i} className="rounded-xl border bg-background/40 px-3 py-2">
          <div className="text-[11px] text-muted-2">
            {a.when}
            {a.project ? ` · ${a.project}` : ""}
          </div>
          <p className="mt-0.5 text-sm leading-relaxed text-foreground/90">{a.text}</p>
        </li>
      ))}
    </ul>
  );
}
