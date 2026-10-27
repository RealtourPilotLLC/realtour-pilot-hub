import Link from "next/link";
import { monthLabel } from "@/lib/contentProgram";
import { PLAN_VIEWS } from "@/lib/contentNav";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import { TopicsPanel } from "@/components/content/TopicsPanel";
import { ScriptsPanel } from "@/components/content/ScriptsPanel";
import { StrategyPanel } from "@/components/content/StrategyPanel";
import { StrategyCallCard } from "@/components/content/Workspace";
import { ScriptRequestsPanel } from "@/components/content/ScriptRequestsPanel";
import { ScriptUploadPanel } from "@/components/content/ScriptUploadPanel";
import { BulkPlanPanel } from "@/components/content/BulkPlanPanel";
import { CallSummaryCard } from "@/components/content/TopicBriefFold";
import { BriefReadOnly } from "@/components/brief/BriefReadOnly";
import { contentHref } from "@/lib/contentNav";
import { loadTopicsTab, loadScriptsTab, loadStrategyTab, loadScriptRequests, loadLegacyNotes } from "../programData";
import { loadStrategyTargets } from "../workspaceData";
import { KnowledgeView, StrategyNotesCard } from "./KnowledgeView";
import { CallsList } from "./CallsView";
import { loadCallList } from "@/lib/callList";
import { MonthHeader, SubNav, type TabCtx } from "./shared";

// ---------------------------------------------------------------------------
// PLAN (UI-02) — everything that decides WHAT gets filmed: the topics, the
// scripts, the strategy and pillars, the calls, and what we know about the
// client (what the AI kept from the calls, Oct 27 2026). One sub-view at a
// time, each paying only for its own queries.
//
// Scripts: ScriptsPanel is the ONLY staff approval surface, and it approves a
// version id (approveScriptVersionAction). The client's open change requests
// sit above it — they used to be visible only inside the Overview's retired
// script list.
// ---------------------------------------------------------------------------

/**
 * Oct 21 2026 (Jordan: "Since Mike creates his own creatives … so our team can
 * access it"): a client who plans their own videos has no topics or scripts
 * from us, so their own plan for the month (the creative brief: PDF, Word,
 * notes) sits where those would. Read-only here, opened through the brief's
 * own door; files are added or removed on Overview.
 */
async function ClientOwnPlan({ ctx }: { ctx: TabCtx }) {
  const { id, month } = ctx;
  if (!month || month.historical || !ctx.progress?.topics.clientSupplies) return null;
  const view = await import("@/lib/monthBrief").then(async (m) => m.briefView(await m.monthBrief(month.id), null)).catch(() => null);
  return (
    <div data-client-own-plan className="space-y-1.5">
      <BriefReadOnly brief={view} clientPlanned monthName={monthLabel(month.monthKey).split(" ")[0]} />
      <Link href={contentHref(id, { month: month.monthKey, anchor: "brief" })} className="inline-flex min-h-9 items-center text-[13px] font-medium text-brand hover:underline">
        Add or remove files on Overview
      </Link>
    </div>
  );
}

export async function PlanTab({ ctx, badges }: { ctx: TabCtx; badges: Record<string, number> }) {
  const { id, month, client, ownerEyes } = ctx;
  const v = ctx.view ?? "topics";
  const monthName = monthLabel(month?.monthKey ?? ctx.activeKey);
  const monthShort = monthName.split(" ")[0];
  const clientFirst = client.name.split(" ")[0] || client.name;
  const sub = <SubNav id={id} tab="plan" current={v} views={PLAN_VIEWS} month={month?.monthKey ?? null} badges={badges} />;

  if (v === "bulk") {
    // Oct 15 2026: the bulk plan board (bulkPlan.ts) — owner/admin only.
    const lib = await import("@/lib/bulkPlan");
    const { prisma } = await import("@/lib/prisma");
    const plan = ctx.staffEyes ? await lib.latestBulkPlanFor(id) : null;
    const [board, batches, clientFormat] = await Promise.all([
      plan ? lib.bulkBoard(plan.id) : Promise.resolve(null),
      plan ? prisma.contentImportBatch.findMany({ where: { kind: lib.BULK_IMPORT_KIND, enrollmentId: id, mode: "APPLIED" }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, fileName: true, createdAt: true, itemsCreated: true } }) : Promise.resolve([]),
      lib.clientScriptFormat(id),
    ]);
    return (
      <div className="space-y-5">
        {sub}
        {ctx.staffEyes ? (
          <BulkPlanPanel
            enrollmentId={id}
            clientFirst={client.name.split(" ")[0] || client.name}
            board={board}
            imports={batches.map((b) => ({ id: b.id, fileName: b.fileName, atISO: b.createdAt.toISOString(), count: b.itemsCreated }))}
            clientFormat={clientFormat}
            defaultMonthKey={month?.monthKey ?? ctx.activeKey}
          />
        ) : (
          <p className="text-sm text-muted">Bulk plans are for the owner and admins.</p>
        )}
      </div>
    );
  }

  if (v === "topics") {
    const d = await loadTopicsTab(id, month ? { id: month.id, monthKey: month.monthKey } : null);
    return (
      <div className="space-y-5">
        {sub}
        <MonthHeader ctx={ctx} tab="plan" view="topics" title={`Topics — ${monthName}`} />
        <ClientOwnPlan ctx={ctx} />
        {/* Oct 26 2026: what the client said on the month's call, per chosen topic (TopicBriefFold). Not on a month with no chosen topics. */}
        {month && d.briefs && d.briefs.chosenIds.length > 0 && <CallSummaryCard monthId={month.id} clientFirst={clientFirst} briefs={d.briefs} />}
        <TopicsPanel enrollmentId={id} month={month ? { id: month.id, label: monthName, short: monthShort, key: month.monthKey } : null} capacity={d.capacity} groups={d.groups} proposed={d.proposed} monthTopics={d.monthTopics}
          suggestions={d.suggestions} recommended={d.recommended} runs={d.runs} interviews={d.interviews} histories={d.histories} pillars={d.pillars} topicsPerPillar={d.topicsPerPillar} isOwner={ownerEyes} archivedCount={d.archivedCount} declined={d.declined} stock={d.stock} held={d.held}
          drafts={d.drafts} queueActive={d.queueActive} videoStyle={d.videoStyle} skitsPerMonth={d.skitsPerMonth} briefs={d.briefs?.byTopic ?? null} clientFirst={clientFirst} />
      </div>
    );
  }

  if (v === "scripts") {
    // Oct 12 2026: "Upload this month's scripts" — owner/admin, an open month
    // of a client we write for (not imported history, not client-planned).
    const uploadMonth = ctx.staffEyes && month && !month.historical && month.status === "OPEN" && !ctx.progress?.topics.clientSupplies ? month : null;
    const [requests, d, uploads] = await Promise.all([
      loadScriptRequests(month ? { id: month.id } : null),
      loadScriptsTab(id, month ? { id: month.id } : null),
      uploadMonth ? import("@/lib/scriptUpload").then((m) => m.monthUploads(id, uploadMonth.id)).catch(() => null) : Promise.resolve(null),
    ]);
    return (
      <div className="space-y-5">
        {sub}
        <MonthHeader ctx={ctx} tab="plan" view="scripts" title={`Scripts — ${monthName}`} />
        <ClientOwnPlan ctx={ctx} />
        {uploadMonth && uploads && (
          <ScriptUploadPanel enrollmentId={id} monthId={uploadMonth.id} monthName={monthShort} clientName={client.name.split(" ")[0] || client.name} batches={uploads.batches} monthHasScripts={uploads.monthHasScripts} />
        )}
        <ScriptRequestsPanel groups={requests} />
        <ScriptsPanel enrollmentId={id} scripts={d.scripts} queueCount={d.queueCount} scriptOwner={d.scriptOwner} owed={d.owed} revising={d.revising} drafting={d.drafting} queueActive={d.queueActive} questionRequests={d.questionRequests} removed={d.removed} clientFirst={clientFirst} />
      </div>
    );
  }

  if (v === "strategy") {
    const [d, targets, callNotes] = await Promise.all([
      loadStrategyTab(id, month ? { id: month.id, monthKey: month.monthKey, prioritiesJson: month.prioritiesJson, prioritiesSourceRef: month.prioritiesSourceRef } : null),
      loadStrategyTargets(id).catch(() => ({ targets: {}, sections: [], workingVersionNo: null })),
      // Oct 27 2026: price point, niche … one line each, kept by the knowledge curator.
      import("@/lib/knowledgeCurator").then((m) => m.strategyNotesFor(client.id)).catch(() => []),
    ]);
    return (
      <div className="space-y-5">
        {sub}
        <StrategyNotesCard notes={callNotes} />
        <StrategyPanel enrollmentId={id} versions={d.versions} proposals={d.proposals} pillars={d.pillars} owners={d.owners} staff={d.staff} isOwner={ownerEyes} month={d.month} targets={targets.targets} sections={targets.sections} workingVersionNo={targets.workingVersionNo} discovery={d.discovery} queueActive={d.queueActive} creativeIdentity={d.creativeIdentity} hasApprovedStrategy={d.hasApprovedStrategy} />
      </div>
    );
  }

  if (v === "calls") {
    // Oct 12 2026: each call on the month with its transcript and analysis
    // (callAnalysis.ts) — the card's "Analyze the call" lives on these.
    const [calls, monthCalls, gate] = await Promise.all([
      loadCallList(id),
      month ? import("@/lib/callAnalysis").then((m) => m.loadCallTranscripts({ monthId: month.id })).catch(() => []) : Promise.resolve([]),
      // Oct 21 2026: no booking link to hand out before the strategy is in the portal.
      import("@/lib/strategyGate").then((m) => m.strategyGateFor(id)).catch(() => null),
    ]);
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
              bookingClosed={gate && !gate.open ? "No strategy in the portal yet. Strategy calls open once it's released." : null}
              calls={monthCalls}
            />
          </div>
        ) : (
          <p className="text-sm text-muted">No month workspace yet — the call card appears with the month.</p>
        )}
        {/* Oct 27 2026: one plain line per call; how it was matched under Details (CallsView). */}
        <CallsList rows={calls} />
      </div>
    );
  }

  // KNOWLEDGE (Oct 27 2026): what the AI kept from the calls, read-only, no
  // review pile (KnowledgeView, lib/knowledgeCurator). Jordan: "AI should
  // handle it. And if it can't figure it out, then get rid of it."
  const [knowledge, notes] = await Promise.all([
    import("@/lib/knowledgeCurator").then((m) => m.loadKnowledgeView(client.id)),
    loadLegacyNotes(client.id),
  ]);
  return (
    <div className="space-y-5">
      {sub}
      <KnowledgeView data={knowledge} clientId={client.id} notes={notes} />
    </div>
  );
}
