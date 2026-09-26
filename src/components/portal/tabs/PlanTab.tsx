import Link from "next/link";
import { CheckCheck, ChevronRight, PencilLine, ScrollText } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { PortalInterviewView, PortalStrategyView, PortalTopicsData } from "@/lib/portal";
import { planModel } from "@/lib/portalHome";
import type { PlanView } from "@/lib/portalNav";
import { SCRIPT_WORDS } from "@/lib/portalWords";
import { Card, Empty, LoadFailed, StatusChip, SubNav, fmtShort } from "@/components/portal/ui";
import { TopicBank } from "@/components/portal/TopicBank";
import { InterviewFlow } from "@/components/portal/InterviewFlow";
import { ScriptApprovalCard } from "@/components/portal/ScriptApprovalCard";
import { ScriptBody } from "@/components/portal/ScriptBody";
import { StrategyTab } from "@/components/portal/tabs/StrategyTab";
import { YourMonth, type YourMonthData } from "@/components/portal/YourMonth";

// ---------------------------------------------------------------------------
// MY PLAN — the v2 layout (UI-01, Sep 24 2026). What used to be one long
// Video Topics page (ideas, this month's picks, interviews and full scripts
// together) plus a separate My Strategy tab, as four clear subviews:
//
//   This month — the month's chosen topics, one next action each, carryovers
//                labelled, the capacity line (TopicBank view="month");
//   Scripts    — every script waiting on the client's read, with the words in
//                front of them and the two answers (ScriptApprovalCard, R1);
//   Topic bank — everything not on a month yet, Suggested first (view="bank");
//   Strategy   — the released strategy (StrategyTab, unchanged).
//
// ?iv=<id> opens one topic's questions (InterviewFlow) inside the plan. All
// of it is the shipped data: portalTopics / portalInterview / portalStrategy,
// partitioned by portalHome.planModel — no new query, no new rule.
//
// YOUR MONTH (§6.4 / §11, Sep 25 2026): the page is "Your Month" and its month
// view is the guided plan — route, topics, answers or the call, Book filming
// (or Schedule later), scripts — in components/portal/YourMonth. The counts on
// every subview come from the one planning reader (R01) through planModel.
// ---------------------------------------------------------------------------

export type PlanTabData = {
  view: PlanView;
  topics: PortalTopicsData | null;
  topicsFailed: boolean;
  interview: PortalInterviewView | null;
  interviewFailed: boolean;
  strategy: PortalStrategyView | null;
  strategyFailed: boolean;
  priorities: string[];
  monthKey: string;
  canAct: boolean;
  readOnly: boolean;
  filter: string | undefined;
  /** My Plan's own address for each subview (query-only). */
  hrefs: Record<PlanView, string>;
  /** The month view's guided plan: planning, this month's scheduling card and the slots. Absent → the plain month list. */
  yourMonth?: Omit<YourMonthData, "topics" | "readOnly" | "filter" | "hrefs"> & { scheduleHref: string } | null;
};

export function PlanTab({ d }: { d: PlanTabData }) {
  if (d.interviewFailed) return <div className="mt-6"><LoadFailed what="those questions" /></div>;
  // The questions sit inside the plan; "All topics" goes back to the month they belong to.
  if (d.interview) return <div className="mt-6"><InterviewFlow iv={d.interview} backHref={d.hrefs.month} canAct={d.canAct && !d.readOnly} /></div>;

  const plan = d.topics ? planModel(d.topics, d.monthKey) : null;
  const tabs = [
    { key: "month" as const, label: plan?.month ? `${monthLabel(plan.month.monthKey).split(" ")[0]}` : "This month", short: "Month" },
    { key: "scripts" as const, label: "Scripts", short: "Scripts", count: plan?.scripts.length ?? 0, countLabel: "waiting on you" },
    { key: "bank" as const, label: "Topic bank", short: "Bank" },
    { key: "strategy" as const, label: "Strategy", short: "Strategy" },
  ];
  return (
    <div className="mt-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Your Month</h1>
        <p className="mt-0.5 text-xs text-muted">Plan this month&rsquo;s videos step by step, read the scripts waiting on you, browse your bank of ideas and the strategy behind them.</p>
      </div>
      <SubNav label="Your Month" items={tabs.map((t) => ({ href: d.hrefs[t.key], label: t.label, short: t.short, active: d.view === t.key, count: t.count, countLabel: t.countLabel }))} />

      {d.view === "strategy" ? (
        <StrategyTab strategy={d.strategy} failed={d.strategyFailed} priorities={d.priorities} monthKey={d.monthKey} canSuggest={d.canAct} readOnly={d.readOnly} />
      ) : d.topicsFailed ? (
        <LoadFailed what="your plan" />
      ) : !d.topics || !plan ? null : d.view === "scripts" ? (
        <ScriptsView plan={plan} canAct={d.canAct} readOnly={d.readOnly} monthHref={d.hrefs.month} />
      ) : d.view === "month" && d.yourMonth ? (
        <YourMonth d={{
          ...d.yourMonth, topics: d.topics, readOnly: d.readOnly, filter: d.filter,
          // A21: "Schedule later" is per session. The filming step books the
          // schedule month's NEXT session, so it reads that session's choice —
          // not the month's first stamp, which on Pro would still say
          // "you chose to schedule later" about session 2 after session 1 was
          // deferred and then booked.
          planning: d.yourMonth.planning && d.yourMonth.schedule
            ? { ...d.yourMonth.planning, deferredAtISO: d.yourMonth.schedule.deferredAtISO }
            : d.yourMonth.planning,
          hrefs: { month: d.hrefs.month, bank: d.hrefs.bank, scripts: d.hrefs.scripts, schedule: d.yourMonth.scheduleHref },
        }} />
      ) : (
        <>
          {d.view === "month" && plan.month && (
            <p className="text-sm text-muted">
              {plan.month.selected} of {plan.month.owed} video{plan.month.owed === 1 ? "" : "s"} chosen for {monthLabel(plan.month.monthKey)}
              {plan.month.planning && <> · {plan.month.planning.headline.text}</>}
              {plan.month.selected < plan.month.owed && d.canAct && !d.readOnly && <> · <Link href={d.hrefs.bank} className="font-medium text-brand hover:underline">choose {plan.month.owed - plan.month.selected} more from your bank</Link></>}
            </p>
          )}
          <TopicBank
            groups={d.topics.groups} months={d.topics.months} archivedCount={d.topics.archivedCount} total={d.topics.total} strategyLabel={d.topics.strategyLabel}
            canAct={d.canAct} readOnly={d.readOnly}
            // The bank opens on what is still to choose from; a filter in the address wins.
            initialFilter={d.view === "bank" ? d.filter ?? "SUGGESTED" : undefined}
            tabHref={d.hrefs.month} view={d.view} initialMonthId={plan.month?.id ?? null} scriptsHref={d.hrefs.scripts}
          />
        </>
      )}
    </div>
  );
}

/** Scripts waiting on the client's read, the words in full, the two answers beside them. */
function ScriptsView({ plan, canAct, readOnly, monthHref }: { plan: ReturnType<typeof planModel>; canAct: boolean; readOnly: boolean; monthHref: string }) {
  // A script answered a moment ago stays a card, in the same keyed list, so
  // the ScriptApprovalCard that sent the answer keeps its result line (Sep 24).
  const just = new Set(plan.justDecided.map((t) => t.id));
  const cards = [...plan.scripts, ...plan.justDecided.filter((t) => !plan.scripts.some((x) => x.id === t.id))];
  const earlier = plan.decidedScripts.filter((t) => !just.has(t.id));
  return (
    <div className="space-y-4">
      {cards.length === 0 ? (
        <Empty icon={ScrollText}>
          No scripts are waiting on you. When we share one, it lands here for your read-through — <Link href={monthHref} className="font-medium text-brand hover:underline">see this month&rsquo;s topics</Link>.
        </Empty>
      ) : (
        cards.map((t) => (
          <section key={t.id} id={`script-${t.id}`} aria-labelledby={`script-title-${t.id}`} className="scroll-mt-24">
            <Card tone="brand">
              <div className="flex flex-wrap items-center gap-1.5">
                <h2 id={`script-title-${t.id}`} className="min-w-0 flex-1 basis-48 break-words text-base font-semibold">{t.title}</h2>
                <StatusChip word={t.script?.decision === "APPROVED" ? SCRIPT_WORDS.APPROVED : t.script?.decision ? SCRIPT_WORDS.CHANGES_REQUESTED : SCRIPT_WORDS.AWAITING} />
              </div>
              <p className="mt-0.5 text-[11px] text-muted-2">
                {t.selection ? `For ${monthLabel(t.selection.monthKey)}` : t.pillarName}
                {t.scriptText?.versionLabel ? ` · script ${t.scriptText.versionLabel}` : ""}
              </p>
              {t.scriptText && <div className="mt-2 rounded-xl border border-border bg-surface-2/40 px-3 py-2"><ScriptBody body={t.scriptText.body} size="xs" /></div>}
              {canAct && !readOnly && t.script ? (
                <ScriptApprovalCard script={t.script} large />
              ) : (
                <p className="mt-2 text-xs text-muted">{readOnly ? "Scripts can’t be approved while your program is paused or ended." : "The program owner approves scripts on this account."}</p>
              )}
            </Card>
          </section>
        ))
      )}
      {earlier.length > 0 && (
        <details className="rounded-2xl border border-border bg-surface/70 p-4 text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Scripts you&rsquo;ve already answered ({earlier.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {earlier.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 flex-1 basis-40 break-words">{t.title}</span>
                {t.script?.decision === "APPROVED" ? <StatusChip word={SCRIPT_WORDS.APPROVED} /> : <StatusChip word={SCRIPT_WORDS.CHANGES_REQUESTED} />}
                {t.script?.decidedAtISO && <span className="text-[11px] text-muted-2">{fmtShort(t.script.decidedAtISO)}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {plan.monthTopics.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <CheckCheck className="size-3.5" aria-hidden /> This month:
          {plan.month ? `${plan.month.selected} of ${plan.month.owed}` : plan.monthTopics.length} topic{(plan.month?.owed ?? plan.monthTopics.length) === 1 ? "" : "s"} chosen — <Link href={monthHref} className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline">open the month <ChevronRight className="size-3" aria-hidden /></Link>
          {plan.toAnswer.length > 0 && <span className="inline-flex items-center gap-1"><PencilLine className="size-3" aria-hidden /> {plan.toAnswer.length} still need{plan.toAnswer.length === 1 ? "s" : ""} your answers</span>}
        </p>
      )}
    </div>
  );
}
