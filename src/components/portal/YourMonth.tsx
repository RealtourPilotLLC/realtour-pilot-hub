import Link from "next/link";
import { CheckCircle2, ChevronRight, Circle, Clock, ExternalLink } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import type { PortalPlanning, PortalScheduleMonth, PortalSlotDay, PortalTopicsData } from "@/lib/portal";
import { yourMonthSteps, type YourMonthStep } from "@/lib/yourMonth";
import { cn } from "@/lib/utils";
import { LoadFailed } from "@/components/portal/ui";
import { TopicBank } from "@/components/portal/TopicBank";
import { PortalScheduler } from "@/components/portal/PortalScheduler";
import { RouteChoice, ScheduleLaterButton } from "@/components/portal/PlanningChoice";

// ---------------------------------------------------------------------------
// YOUR MONTH (§6.4 / §11, Sep 25 2026) — planning and scheduling as one
// guided page, the v2 plan's month view. The steps come from lib/yourMonth
// (pure), the numbers from the one planning reader (R01), the booking picker
// is the Schedule page's own PortalScheduler (same props, same actions), and
// the topics are TopicBank's month view. The Schedule page stays in the bar
// for appointments, rescheduling and cancelling; every old ?tab= still lands.
//
// Each step carries an id (#step-route, #step-topics, #step-answers,
// #step-call, #step-filming, #step-scripts) so Home's next step opens the plan
// exactly where that step is.
// ---------------------------------------------------------------------------

export type YourMonthData = {
  topics: PortalTopicsData;
  planning: PortalPlanning | null;
  planningFailed: boolean;
  /** This month's scheduling card; null = not loaded (see scheduleFailed) or no open month. */
  schedule: PortalScheduleMonth | null;
  scheduleFailed: boolean;
  slotDays: PortalSlotDay[];
  bookingUrl: string;
  can: { suggest: boolean; session: boolean };
  readOnly: boolean;
  filter?: string;
  hrefs: { month: string; bank: string; scripts: string; schedule: string };
};

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

function StepIcon({ step, n }: { step: YourMonthStep; n: number }) {
  if (step.state === "done") return <CheckCircle2 className="size-6 shrink-0 text-success" aria-hidden />;
  if (step.state === "waiting") return <Clock className="size-6 shrink-0 text-muted-2" aria-hidden />;
  if (step.state === "current") return <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">{n}</span>;
  return <Circle className="size-6 shrink-0 text-muted-2" aria-hidden />;
}

const STATE_WORD: Record<YourMonthStep["state"], string> = { done: "Done", current: "Your next step", waiting: "In progress", todo: "Still to come" };

export function YourMonth({ d }: { d: YourMonthData }) {
  const p = d.planning;
  const month = d.topics.months.find((m) => m.id === p?.monthId) ?? d.topics.months[0] ?? null;
  const planning = p?.planning ?? month?.planning ?? null;
  if (d.planningFailed || (p && !planning)) return <LoadFailed what="this month's plan" />;
  if (!p || !month || !planning) {
    return <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">Your next program month isn&rsquo;t open yet — we&rsquo;ll set it up and it will show here.</p>;
  }
  const s = d.schedule;
  const steps = yourMonthSteps({
    monthLabel: monthLabel(month.monthKey).split(" ")[0],
    planning: { callMode: p.callMode, planningMode: p.planningMode, callStatus: p.callStatus, callAtISO: p.callAtISO, noCallEligible: p.noCallEligible, chosenAtISO: p.chosenAtISO, deferredAtISO: p.deferredAtISO },
    month: planning,
    schedule: s ? {
      locked: s.locked, reason: s.reason, earliestISO: s.earliestISO, sessionsRequired: s.sessionsRequired, sessionsMissing: s.sessionsMissing,
      pendingRequest: s.requests.some((r) => (r.status === "REQUESTED" && r.bookingState !== "CONFLICT") || r.status === "RESCHEDULE_REQUESTED"),
      capacityRemaining: s.capacity.remaining,
    } : null,
    can: d.can, readOnly: d.readOnly,
    hrefs: { bank: d.hrefs.bank, month: `${d.hrefs.month}#this-month`, scripts: d.hrefs.scripts, bookingUrl: d.bookingUrl },
    timezone: p.timezone,
  });
  const route = p.planningMode === "WRITTEN" ? "WRITTEN" : p.planningMode === "CALL" ? "CALL" : "UNDECIDED";
  const canChoose = p.noCallEligible && d.can.session && !d.readOnly;
  const current = steps.find((x) => x.state === "current") ?? null;

  return (
    <div className="space-y-4">
      {/* The month in one sentence, and precise progress. */}
      <section aria-labelledby="your-month-headline" className="panel-shadow rounded-2xl border border-brand/30 bg-brand-soft/30 p-4 backdrop-blur">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-brand">{monthLabel(month.monthKey)}</div>
        <h2 id="your-month-headline" className="mt-1 break-words text-lg font-semibold leading-snug">{planning.headline.text}</h2>
        <p className="mt-0.5 text-sm text-muted">
          {month.selected} of {month.owed} video{month.owed === 1 ? "" : "s"} chosen
          {month.overflow > 0 && <> · {month.overflow} extra{month.overflow === 1 ? "" : "s"} waiting {month.overflow === 1 ? "its" : "their"} turn</>}
          {planning.progress && <> · {planning.progress}</>}
        </p>
        {current?.cta && (
          current.cta.external
            ? <a href={current.cta.href} target="_blank" rel="noopener noreferrer" className={cn("mt-3 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand px-5 text-sm font-semibold text-white shadow hover:opacity-90 sm:w-auto", focusRing)}>{current.cta.label} <ExternalLink className="size-4" aria-hidden /></a>
            : <Link href={current.cta.href} className={cn("mt-3 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand px-5 text-sm font-semibold text-white shadow hover:opacity-90 sm:w-auto", focusRing)}>{current.cta.label} <ChevronRight className="size-4" aria-hidden /></Link>
        )}
      </section>

      {/* The steps, in the order the month runs. */}
      <ol aria-label="Your month, step by step" className="space-y-2">
        {steps.map((step, i) => (
          <li key={step.key} id={`step-${step.key}`} aria-current={step.state === "current" ? "step" : undefined}
            className={cn("scroll-mt-24 rounded-2xl border bg-surface/70 p-4 backdrop-blur", step.state === "current" ? "border-brand/40 shadow-sm" : "border-border")}>
            <div className="flex items-start gap-3">
              <StepIcon step={step} n={i + 1} />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-2">{STATE_WORD[step.state]}</div>
                <h3 className="break-words text-sm font-semibold leading-snug">{step.title}</h3>
                {step.detail && <p className="mt-0.5 text-xs text-muted">{step.detail}</p>}
                {step.cta && step.state !== "current" && step.key !== "filming" && (
                  step.cta.external
                    ? <a href={step.cta.href} target="_blank" rel="noopener noreferrer" className={cn("mt-1.5 inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-brand hover:underline sm:min-h-0", focusRing)}>{step.cta.label} <ExternalLink className="size-3" aria-hidden /></a>
                    : <Link href={step.cta.href} className={cn("mt-1.5 inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-brand hover:underline sm:min-h-0", focusRing)}>{step.cta.label} <ChevronRight className="size-3" aria-hidden /></Link>
                )}

                {/* The opening prompt: two equal cards while the month is
                    undecided; afterwards, folded, for a change of mind. */}
                {step.key === "route" && canChoose && (route === "UNDECIDED" ? (
                  <div className="mt-3"><RouteChoice monthId={p.monthId} current={route} /></div>
                ) : (
                  <details className="mt-2">
                    <summary className={cn("flex min-h-11 cursor-pointer items-center text-xs font-medium text-muted hover:text-foreground sm:min-h-0", focusRing)}>Change how you plan this month</summary>
                    <div className="mt-2"><RouteChoice monthId={p.monthId} current={route} /></div>
                  </details>
                ))}

                {/* Book filming — the Schedule page's own picker, embedded. */}
                {step.key === "filming" && (d.scheduleFailed ? (
                  <div className="mt-2"><LoadFailed what="your filming calendar" /></div>
                ) : s && step.state !== "done" && !s.locked ? (
                  <div className="mt-3">
                    <PortalScheduler months={[s]} bookingUrl={d.bookingUrl} days={d.slotDays} readOnly={!d.can.session || d.readOnly} timezone={p.timezone} embedded />
                    {d.can.session && !d.readOnly && s.sessionsMissing > 0 && s.capacity.remaining > 0 && (
                      <ScheduleLaterButton monthId={s.monthId} deferred={!!p.deferredAtISO} />
                    )}
                  </div>
                ) : step.state === "done" ? (
                  <Link href={d.hrefs.schedule} className={cn("mt-1.5 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-muted hover:underline sm:min-h-0", focusRing)}>Reschedule or cancel <ChevronRight className="size-3" aria-hidden /></Link>
                ) : null)}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {/* This month's topics — each with its own next action and its step. */}
      <section id="this-month" aria-labelledby="this-month-title" className="scroll-mt-24 space-y-2">
        <h2 id="this-month-title" className="text-base font-semibold">This month&rsquo;s topics</h2>
        <TopicBank
          groups={d.topics.groups} months={d.topics.months} archivedCount={d.topics.archivedCount} total={d.topics.total} strategyLabel={d.topics.strategyLabel}
          canAct={d.can.suggest} readOnly={d.readOnly} initialFilter={d.filter}
          tabHref={d.hrefs.month} view="month" initialMonthId={month.id} scriptsHref={d.hrefs.scripts}
        />
      </section>
    </div>
  );
}
