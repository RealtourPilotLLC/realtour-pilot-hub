import { Compass, Sparkles, Target } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { PortalStrategyView } from "@/lib/portal";
import { Card, CardTitle, Empty, LoadFailed, fmtShort } from "@/components/portal/ui";
import { StrategyDocView, isPageMarker, stripPageMarkers } from "@/components/content/StrategyDocView";
import { DiscoveryCard } from "@/components/portal/DiscoveryCard";
import type { PortalStrategyGate } from "@/lib/yourMonth";

// MY STRATEGY (spec §3): the released version — version number + approval
// date, the accessible summary (brand foundation), this month's priorities
// kept apart, then the full document in its own structure. Nothing here
// edits the strategy. (The "propose a correction" box was switched off on Oct
// 13 2026 and deleted with its action on Oct 20, audit E9: a correction is a
// message to the office.)
//
// U01 (Sep 25 2026): the full document renders through the same structured
// view as the staff Strategy tab — labelled rows, real lists, one card per
// pillar — over the released sections portalStrategy already filtered (the
// framework, caption lists and the team's working notes never reach here).
export function StrategyTab({ strategy, failed, priorities, monthKey, gate = null }: {
  strategy: PortalStrategyView | null;
  failed: boolean;
  priorities: string[];
  monthKey: string;
  /** Oct 21 2026: the closed strategy gate: the empty state names the discovery call and what comes next. */
  gate?: PortalStrategyGate | null;
}) {
  if (failed) return <div className="mt-6"><LoadFailed what="your strategy" /></div>;
  if (!strategy && gate) return <div className="mt-6"><DiscoveryCard gate={gate} /></div>;
  if (!strategy) {
    return (
      <div className="mt-6">
        <Empty icon={Compass}>Your strategy hasn&rsquo;t been shared here yet. We build it from your brand discovery call, and it will show here once it&rsquo;s ready.</Empty>
      </div>
    );
  }
  // Oct 27 2026 (Jordan: "1 of 3 ... it shows on the client portal too"): PDF page markers never show here.
  const raw = strategy.summary;
  const s = raw ? { ...raw, goals: raw.goals.filter((g) => !isPageMarker(g)).map((g) => stripPageMarkers(g).trim()).filter(Boolean) } : null;
  return (
    <div className="mt-6 space-y-4">
      <div>
        {/* PlanTab's heading names this page ("Content strategy"); this is the released version's own line. */}
        <h2 className="text-xl font-semibold tracking-tight">Your strategy</h2>
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
            {s.pillars.length > 0 && <div><dt className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Content pillars</dt><dd className="mt-0.5"><ul className="space-y-1">{s.pillars.map((p, i) => <li key={i} className="leading-relaxed text-foreground/90"><span className="font-semibold">{p.name}</span>{p.purpose ? <span className="text-muted">: {p.purpose}</span> : null}</li>)}</ul></dd></div>}
          </dl>
        </Card>
      )}

      {/* This month's priorities — kept apart from the foundation */}
      <Card>
        <CardTitle icon={Target}>{monthLabel(monthKey)} priorities</CardTitle>
        {priorities.length > 0 ? (
          <ul className="mt-2 space-y-1">{priorities.map((p, i) => <li key={i} className="flex gap-2 text-sm leading-relaxed text-foreground/90"><span className="text-brand">·</span><span>{p}</span></li>)}</ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No priorities set for this month yet. They come from your strategy call or your written answers.</p>
        )}
      </Card>

      {/* Full document, source structure preserved */}
      <Card>
        <CardTitle icon={Compass}>The full strategy</CardTitle>
        <div className="mt-3">
          <StrategyDocView
            sections={strategy.sections.map((sec) => ({ id: sec.id, heading: sec.heading, text: sec.body }))}
            collapsible
            openFirst
            empty={<p className="text-sm text-muted">The document has no client-facing sections beyond the summary above.</p>}
          />
        </div>
      </Card>
    </div>
  );
}
