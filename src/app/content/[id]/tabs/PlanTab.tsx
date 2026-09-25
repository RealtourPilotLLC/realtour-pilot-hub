import Link from "next/link";
import { PhoneCall } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { monthLabel } from "@/lib/contentProgram";
import { PLAN_VIEWS } from "@/lib/contentNav";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import { TopicsPanel } from "@/components/content/TopicsPanel";
import { ScriptsPanel } from "@/components/content/ScriptsPanel";
import { StrategyPanel } from "@/components/content/StrategyPanel";
import { FactsPanel } from "@/components/content/FactsPanel";
import { StrategyCallCard, NotesCard, ScriptRequestsPanel } from "@/components/content/Workspace";
import { loadTopicsTab, loadScriptsTab, loadStrategyTab, loadFactsTab, loadCallsTab, loadScriptRequests, loadLegacyNotes } from "../programData";
import { loadFieldProposals, loadStrategyTargets } from "../workspaceData";
import { MonthHeader, SubNav, type TabCtx } from "./shared";

// ---------------------------------------------------------------------------
// PLAN (UI-02) — everything that decides WHAT gets filmed: the topics, the
// scripts, the strategy and pillars, the calls, and what we know about the
// client (facts, and the field changes a call proposes). One sub-view at a
// time, each paying only for its own queries.
//
// Scripts: ScriptsPanel is the ONLY staff approval surface, and it approves a
// version id (approveScriptVersionAction). The client's open change requests
// sit above it — they used to be visible only inside the Overview's retired
// script list.
// ---------------------------------------------------------------------------

const CALL_WORDS: Record<string, string> = { MONTHLY_STRATEGY: "Monthly strategy call", BRAND_DISCOVERY: "Brand discovery call" };
const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "no time";

export async function PlanTab({ ctx, badges }: { ctx: TabCtx; badges: Record<string, number> }) {
  const { id, month, client, ownerEyes } = ctx;
  const v = ctx.view ?? "topics";
  const monthName = monthLabel(month?.monthKey ?? ctx.activeKey);
  const monthShort = monthName.split(" ")[0];
  const sub = <SubNav id={id} tab="plan" current={v} views={PLAN_VIEWS} month={month?.monthKey ?? null} badges={badges} />;

  if (v === "topics") {
    const d = await loadTopicsTab(id, month ? { id: month.id, monthKey: month.monthKey } : null);
    return (
      <div className="space-y-5">
        {sub}
        <MonthHeader ctx={ctx} tab="plan" view="topics" title={`Topics — ${monthName}`} />
        <TopicsPanel enrollmentId={id} month={month ? { id: month.id, label: monthName, short: monthShort } : null} capacity={d.capacity} groups={d.groups} proposed={d.proposed} monthTopics={d.monthTopics}
          suggestions={d.suggestions} recommended={d.recommended} runs={d.runs} interviews={d.interviews} histories={d.histories} pillars={d.pillars} topicsPerPillar={d.topicsPerPillar} isOwner={ownerEyes} archivedCount={d.archivedCount} declined={d.declined} stock={d.stock} held={d.held} />
      </div>
    );
  }

  if (v === "scripts") {
    const [requests, d] = await Promise.all([
      loadScriptRequests(month ? { id: month.id } : null),
      loadScriptsTab(id, month ? { id: month.id } : null),
    ]);
    return (
      <div className="space-y-5">
        {sub}
        <MonthHeader ctx={ctx} tab="plan" view="scripts" title={`Scripts — ${monthName}`} />
        <ScriptRequestsPanel groups={requests} />
        <ScriptsPanel scripts={d.scripts} queueCount={d.queueCount} scriptOwner={d.scriptOwner} owed={d.owed} />
      </div>
    );
  }

  if (v === "strategy") {
    const [d, targets] = await Promise.all([
      loadStrategyTab(id, month ? { id: month.id, monthKey: month.monthKey, prioritiesJson: month.prioritiesJson, prioritiesSourceRef: month.prioritiesSourceRef } : null),
      loadStrategyTargets(id).catch(() => ({ targets: {}, sections: [] })),
    ]);
    return (
      <div className="space-y-5">
        {sub}
        <StrategyPanel enrollmentId={id} versions={d.versions} proposals={d.proposals} pillars={d.pillars} mapping={d.mapping} owners={d.owners} staff={d.staff} isOwner={ownerEyes} month={d.month} targets={targets.targets} sections={targets.sections} discovery={d.discovery} />
      </div>
    );
  }

  if (v === "calls") {
    const calls = await loadCallsTab(id);
    return (
      <div className="space-y-5">
        {sub}
        <MonthHeader ctx={ctx} tab="plan" view="calls" title={`Calls — ${monthName}`} />
        {month ? (
          <div id="call" className="scroll-mt-20">
            {/* The month's call: status, booking link, and the hand-paste transcript fallback. */}
            <StrategyCallCard
              monthId={month.id}
              status={month.strategyCallStatus}
              at={month.strategyCallAt?.toISOString() ?? null}
              hasTranscript={!!month.transcriptText}
              transcriptProcessed={!!month.transcriptProcessedAt}
              required={ctx.enrollment.strategyCallRequired}
              bookingUrl={STRATEGY_CALL_BOOKING_URL}
            />
          </div>
        ) : (
          <p className="text-sm text-muted">No month workspace yet — the call card appears with the month.</p>
        )}
        <Section icon={PhoneCall} title="Every call on record" count={calls.length} flush
          action={<Link href="/content/monitoring#calls" className="text-[12px] font-medium text-brand hover:underline">Unmatched calls →</Link>}>
          <div className="divide-y divide-border">
            {calls.length === 0 && <p className="px-5 py-3 text-sm text-muted">No call records for this client yet.</p>}
            {calls.map((c) => (
              <div key={c.id} className="px-5 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium">{CALL_WORDS[c.callType] ?? c.callType.toLowerCase().replace(/_/g, " ")}</span>
                  <span className="text-muted">{fmtWhen(c.scheduledStartISO)}</span>
                  {c.monthKey && <span className="text-[11px] text-muted-2">for {monthLabel(c.monthKey)}</span>}
                </div>
                <div className="text-[12px] text-muted">
                  {c.status.toLowerCase().replace(/_/g, " ")} · transcript {c.transcriptState.toLowerCase().replace(/_/g, " ")}
                  {c.matchState && c.matchState !== "MATCHED" ? ` · ${c.matchState.toLowerCase().replace(/_/g, " ")}` : ""}
                </div>
                {c.lastError && <div className="text-[12px] text-warning">{c.lastError.slice(0, 160)}</div>}
              </div>
            ))}
          </div>
        </Section>
      </div>
    );
  }

  // KNOWLEDGE — facts (with the profile/strategy changes a call proposes) and the legacy notes.
  const [facts, proposals, notes] = await Promise.all([
    loadFactsTab(client.id, id),
    loadFieldProposals(client.id).catch(() => []),
    loadLegacyNotes(client.id),
  ]);
  return (
    <div className="space-y-5">
      {sub}
      <FactsPanel clientId={client.id} facts={facts.facts} counts={facts.counts} months={facts.months} projects={facts.projects} fieldProposals={proposals} />
      {/* Moved here from the old Client file. The customer note itself lives on Brand, beside the profile it describes. */}
      <div className="max-w-2xl">
        <p className="mb-2 text-[12px] text-muted-2">Legacy notes — still read by the AI while they migrate to facts.</p>
        <NotesCard clientId={client.id} notes={notes} />
      </div>
    </div>
  );
}
