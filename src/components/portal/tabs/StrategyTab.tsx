import { Compass, Sparkles, Target } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { PortalStrategyView } from "@/lib/portal";
import { Card, CardTitle, Empty, LoadFailed, fmtShort } from "@/components/portal/ui";
import { PortalRichText } from "@/components/portal/PortalRichText";
import { ProposeCorrection } from "@/components/portal/ProposeCorrection";

// MY STRATEGY (spec §3): the released version — version number + approval
// date, the accessible summary (brand foundation), this month's priorities
// kept apart, then the full document in its own structure. Corrections go to
// the team as proposals; nothing here edits the strategy.
export function StrategyTab({ strategy, failed, priorities, monthKey, canSuggest, readOnly }: {
  strategy: PortalStrategyView | null;
  failed: boolean;
  priorities: string[];
  monthKey: string;
  canSuggest: boolean;
  readOnly: boolean;
}) {
  if (failed) return <div className="mt-6"><LoadFailed what="your strategy" /></div>;
  if (!strategy) {
    return (
      <div className="mt-6">
        <Empty icon={Compass}>Your strategy hasn&rsquo;t been shared here yet. It appears after your brand discovery and first strategy call.</Empty>
      </div>
    );
  }
  const s = strategy.summary;
  return (
    <div className="mt-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">My Strategy</h1>
        <p className="mt-0.5 text-xs text-muted">Version {strategy.versionNo}{strategy.approvedAtISO ? ` · approved ${fmtShort(strategy.approvedAtISO)}` : ""} · shared {fmtShort(strategy.releasedAtISO)}{strategy.newerPending ? " · an updated version is being prepared" : ""}</p>
      </div>

      {/* Brand foundation — the permanent part */}
      {s && (s.brandMessage || s.audience.length || s.goals.length || s.pillars.length > 0) && (
        <Card>
          <CardTitle icon={Sparkles}>Your brand foundation</CardTitle>
          <dl className="mt-2 space-y-2 text-sm">
            {s.brandMessage && <div><dt className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Brand message</dt><dd className="mt-0.5 leading-relaxed text-foreground/90">{s.brandMessage}</dd></div>}
            {s.brandVoice && <div><dt className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Voice</dt><dd className="mt-0.5 leading-relaxed text-foreground/90">{s.brandVoice}</dd></div>}
            {s.audience.length > 0 && <div><dt className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Who it&rsquo;s for</dt><dd className="mt-0.5 leading-relaxed text-foreground/90">{s.audience.join(" · ")}</dd></div>}
            {s.goals.length > 0 && <div><dt className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Goals</dt><dd className="mt-0.5"><ul className="space-y-0.5">{s.goals.map((g, i) => <li key={i} className="flex gap-2 leading-relaxed text-foreground/90"><span className="text-brand">·</span><span>{g}</span></li>)}</ul></dd></div>}
            {s.pillars.length > 0 && <div><dt className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Content pillars</dt><dd className="mt-0.5"><ul className="space-y-1">{s.pillars.map((p, i) => <li key={i} className="leading-relaxed text-foreground/90"><span className="font-semibold">{p.name}</span>{p.purpose ? <span className="text-muted"> — {p.purpose}</span> : null}</li>)}</ul></dd></div>}
          </dl>
        </Card>
      )}

      {/* This month's priorities — kept apart from the foundation */}
      <Card>
        <CardTitle icon={Target}>{monthLabel(monthKey)} priorities</CardTitle>
        {priorities.length > 0 ? (
          <ul className="mt-2 space-y-1">{priorities.map((p, i) => <li key={i} className="flex gap-2 text-sm leading-relaxed text-foreground/90"><span className="text-brand">·</span><span>{p}</span></li>)}</ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No priorities set for this month yet — they come out of your strategy call (or your written answers).</p>
        )}
      </Card>

      {/* Full document, source structure preserved */}
      <Card>
        <CardTitle icon={Compass}>The full strategy</CardTitle>
        <div className="mt-3 space-y-2">
          {strategy.sections.map((sec) => (
            <details key={sec.id} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
              <summary className="cursor-pointer text-sm font-bold">{sec.heading}</summary>
              <PortalRichText text={sec.body} />
            </details>
          ))}
          {strategy.sections.length === 0 && <p className="text-sm text-muted">The document has no client-facing sections beyond the summary above.</p>}
        </div>
        {canSuggest && !readOnly && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-2 text-xs text-muted">Something changed, or something&rsquo;s not quite right? Tell us — we review every correction before it changes your strategy.{strategy.proposalsOpen ? ` (${strategy.proposalsOpen} of yours waiting for review.)` : ""}</p>
            <ProposeCorrection sections={strategy.sections.map((s) => ({ id: s.id, heading: s.heading }))} />
          </div>
        )}
      </Card>
    </div>
  );
}
