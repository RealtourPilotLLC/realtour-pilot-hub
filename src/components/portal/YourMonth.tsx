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
import { PortalCallPicker } from "@/components/portal/PortalCallPicker";
import type { PortalCallBookingView } from "@/lib/callBooking";
import type { MonthBriefView } from "@/lib/monthBriefCore";
import { MonthBriefPanel } from "@/components/brief/MonthBriefPanel";
import { ScriptBody } from "@/components/portal/ScriptBody";
import type { PortalLateScript } from "@/lib/monthLateSession";

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
  /** W03: the month's strategy call, booked here (embed or API); null = not loaded → bookingUrl. */
  callBooking?: PortalCallBookingView | null;
  selectedSessionIndex?: number | null;
  can: { suggest: boolean; session: boolean };
  readOnly: boolean;
  filter?: string;
  hrefs: { month: string; bank: string; scripts: string; schedule: string };
  /** Oct 8 2026: a client who plans their own content — this month's creative brief (links scoped to this visit). */
  brief?: MonthBriefView | null;
  /**
   * Oct 12 2026 (lateSession.ts): an over month's session booked this month
   * too — its own scheduling card (gated by ITS plan) and its released
   * scripts, so the client can prep. Shown when `planning.late` is set.
   */
  late?: { schedule: PortalScheduleMonth | null; scripts: PortalLateScript[] } | null;
  /** The scheduler month the address asked for (a late month's id, or this month's). */
  selectedScheduleMonthId?: string | null;
};

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

function StepIcon({ step, n }: { step: YourMonthStep; n: number }) {
  if (step.state === "done") return <CheckCircle2 className="size-6 shrink-0 text-success" aria-hidden />;
  if (step.state === "waiting") return <Clock className="size-6 shrink-0 text-muted-2" aria-hidden />;
  if (step.state === "current") return <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-action text-xs font-bold text-white">{n}</span>;
  return <Circle className="size-6 shrink-0 text-muted-2" aria-hidden />;
}

const STATE_WORD: Record<YourMonthStep["state"], string> = { done: "Done", current: "Your next step", waiting: "In progress", todo: "Still to come" };

export function YourMonth({ d }: { d: YourMonthData }) {
  const p = d.planning;
  const month = d.topics.months.find((m) => m.id === p?.monthId) ?? d.topics.months[0] ?? null;
  const planning = p?.planning ?? month?.planning ?? null;
  if (d.planningFailed || (p && !planning)) return <LoadFailed what="this month's plan" />;
  if (!p || !month || !planning) {
    return <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">Your next program month isn&rsquo;t open yet. We&rsquo;ll set it up and it will show here.</p>;
  }
  const s = d.schedule;
  const steps = yourMonthSteps({
    monthLabel: monthLabel(month.monthKey).split(" ")[0],
    planning: { callMode: p.callMode, planningMode: p.planningMode, callStatus: p.callStatus, callAtISO: p.callAtISO, noCallEligible: p.noCallEligible, chosenAtISO: p.chosenAtISO, deferredAtISO: p.deferredAtISO, officePlanned: p.officePlanned },
    month: planning,
    schedule: s ? {
      locked: s.locked, reason: s.reason, earliestISO: s.earliestISO, sessionsRequired: s.sessionsRequired, sessionsMissing: s.sessionsMissing,
      pendingRequest: s.requests.some((r) => (r.status === "REQUESTED" && r.bookingState !== "CONFLICT") || r.status === "RESCHEDULE_REQUESTED"),
      capacityRemaining: s.capacity.remaining,
    } : null,
    can: d.can, readOnly: d.readOnly,
    hrefs: { bank: d.hrefs.bank, month: `${d.hrefs.month}#this-month`, scripts: d.hrefs.scripts, bookingUrl: d.bookingUrl },
    timezone: p.timezone,
    clientPlanned: p.clientPlanned ? { briefFiles: d.brief?.files.length ?? 0, briefNotes: !!d.brief?.notes?.text.trim() } : null,
  });
  const clientPlanned = p.clientPlanned;
  const route = p.planningMode === "WRITTEN" ? "WRITTEN" : p.planningMode === "CALL" ? "CALL" : "UNDECIDED";
  // Oct 12 2026: a month the office planned (its scripts uploaded) has no route for the client to choose.
  const canChoose = p.noCallEligible && d.can.session && !d.readOnly && !p.officePlanned;
  const current = steps.find((x) => x.state === "current") ?? null;
  const topicsAreCurrent = current?.key === "topics" || current?.key === "answers" || (current?.key === "call" && planning.call === "HELD");

  return (
    <div className="space-y-4">
      {/* The month in one sentence, and precise progress. */}
      <section aria-labelledby="your-month-headline" className="panel-shadow rounded-2xl border border-brand/30 bg-brand-soft/30 p-4 backdrop-blur">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-brand">{monthLabel(month.monthKey)}</div>
        <h2 id="your-month-headline" className="mt-1 break-words text-lg font-semibold leading-snug">{planning.headline.text}</h2>
        {p.catchUp && <p className="mt-1 text-sm font-medium text-brand">{p.catchUp.line}</p>}
        {clientPlanned ? (
          <p className="mt-0.5 text-sm text-muted">{month.owed} video{month.owed === 1 ? "" : "s"} this month · you plan them, we film and edit them</p>
        ) : (
          <p className="mt-0.5 text-sm text-muted">
            {month.selected} of {month.owed} video{month.owed === 1 ? "" : "s"} chosen
            {month.overflow > 0 && <> · {month.overflow} extra{month.overflow === 1 ? "" : "s"} waiting {month.overflow === 1 ? "its" : "their"} turn</>}
            {planning.progress && <> · {planning.progress}</>}
          </p>
        )}
        {current?.cta && (
          current.cta.external
            ? <a href={current.cta.href} target="_blank" rel="noopener noreferrer" className={cn("mt-3 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-action px-5 text-sm font-semibold text-white shadow hover:opacity-90 sm:w-auto", focusRing)}>{current.cta.label} <ExternalLink className="size-4" aria-hidden /></a>
            : <Link href={current.key === "topics" ? "#this-month" : current.cta.href} className={cn("mt-3 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-action px-5 text-sm font-semibold text-white shadow hover:opacity-90 sm:w-auto", focusRing)}>{current.cta.label} <ChevronRight className="size-4" aria-hidden /></Link>
        )}
      </section>

      {/* Oct 12 2026: an over month's session, booked now beside this month's (lateSession.ts). */}
      {p.late && <LateSessionCard d={d} late={p.late} hostName={monthLabel(month.monthKey).split(" ")[0]} />}

      {/* The steps, in the order the month runs. */}
      <ol aria-label="Your month, step by step" className="space-y-2">
        {steps.map((step, i) => (
          <li key={step.key} id={`step-${step.key}`} aria-current={step.state === "current" ? "step" : undefined}
            className={cn("scroll-mt-24 rounded-2xl border bg-surface/70 backdrop-blur", step.state === "current" ? "border-brand/40 p-4 shadow-sm" : "border-border px-4 py-3")}>
            <div className="flex items-start gap-3">
              <StepIcon step={step} n={i + 1} />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{step.state === "todo" && step.cta ? "Also ready for you" : STATE_WORD[step.state]}</div>
                <h3 className={cn("break-words font-semibold leading-snug", step.state === "current" ? "text-base" : "text-sm")}>{step.title}</h3>
                {step.detail && <p className="mt-1 text-sm text-muted">{step.detail}</p>}
                {step.state === "current" && step.cta && (step.key === "topics" || step.key === "answers" || step.key === "scripts") && (
                  <Link href={step.key === "topics" ? "#this-month" : step.cta.href} className={cn("mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-brand hover:underline", focusRing)}>{step.cta.label} <ChevronRight className="size-4" aria-hidden /></Link>
                )}
                {step.cta && step.state !== "current" && step.key !== "filming" && !(step.key === "call" && !!d.callBooking?.booked) && (
                  step.cta.external
                    ? <a href={step.cta.href} target="_blank" rel="noopener noreferrer" className={cn("mt-1.5 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline", focusRing)}>{step.cta.label} <ExternalLink className="size-4" aria-hidden /></a>
                    : <Link href={step.cta.href} className={cn("mt-1.5 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline", focusRing)}>{step.cta.label} <ChevronRight className="size-4" aria-hidden /></Link>
                )}

                {step.state === "done" && step.key === "topics" && <Link href={d.hrefs.bank} className={cn("inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline", focusRing)}>Browse more ideas <ChevronRight className="size-4" aria-hidden /></Link>}
                {step.state === "done" && step.key === "scripts" && <Link href={d.hrefs.scripts} className={cn("inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline", focusRing)}>View scripts <ChevronRight className="size-4" aria-hidden /></Link>}

                {/* The opening prompt: two equal cards while the month is
                    undecided; afterwards, folded under "Change how you plan
                    this month", with "Undo my choice". ONE element in one
                    place for both, so it stays mounted across the refresh a
                    choice makes and its Undo stays on screen (Oct 6). */}
                {step.key === "route" && canChoose && (route !== "UNDECIDED" || step.state === "current") && (
                  <div className={route === "UNDECIDED" ? "mt-3" : "mt-2"}>
                    <RouteChoice monthId={p.monthId} current={route} chosen={!!p.chosenAtISO} callBooked={p.callStatus === "SCHEDULED"} undoBlocked={p.undoBlocked} blocked={p.switchBlocked} />
                  </div>
                )}

                {/* W03: book (or change) the strategy call right here — never
                    once the call has been held. */}
                {step.key === "call" && d.callBooking && planning.call !== "HELD" && step.state !== "done" && (
                  d.callBooking.booked ? (
                    <details className="mt-1">
                      <summary className={cn("flex min-h-11 cursor-pointer items-center text-sm font-medium text-brand hover:underline", focusRing)}>Manage your strategy call</summary>
                      <PortalCallPicker view={d.callBooking} />
                    </details>
                  ) : step.state === "current" ? <PortalCallPicker view={d.callBooking} /> : null
                )}

                {/* Oct 8 2026: the client's own brief for the month — files and notes, right here. */}
                {step.key === "brief" && (
                  <div className="mt-3">
                    <MonthBriefPanel mode="portal" monthId={p.monthId} files={d.brief?.files ?? []} notes={d.brief?.notes ?? null} canEdit={d.can.suggest && !d.readOnly} />
                  </div>
                )}

                {/* Book filming — the Schedule page's own picker, embedded. */}
                {step.key === "filming" && (d.scheduleFailed ? (
                  <div className="mt-2"><LoadFailed what="your filming calendar" /></div>
                ) : s && step.state === "current" && !s.locked && p.late ? (
                  // Both sessions are booked from the one card above (Oct 13 2026: or the one session for both months).
                  <Link href="#step-late" className={cn("mt-1.5 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand hover:underline", focusRing)}>{p.late.combine.combined ? `Book it above: one session for your ${p.late.label} and ${p.late.hostLabel} videos` : `Book it above, beside your ${p.late.label} session`} <ChevronRight className="size-4" aria-hidden /></Link>
                ) : s && step.state === "current" && !s.locked ? (
                  <div className="mt-3">
                    <PortalScheduler key={`${s.monthId}:${d.selectedSessionIndex ?? "next"}`} months={[s]} bookingUrl={d.bookingUrl} days={d.slotDays} readOnly={!d.can.session || d.readOnly} timezone={p.timezone} selectedMonthId={s.monthId} selectedSessionIndex={d.selectedSessionIndex} embedded />
                    {d.can.session && !d.readOnly && s.sessionsMissing > 0 && s.capacity.remaining > 0 && (
                      <ScheduleLaterButton monthId={s.monthId} deferred={!!p.deferredAtISO} />
                    )}
                  </div>
                ) : step.state === "done" ? (
                  <Link href={d.hrefs.schedule} className={cn("mt-1.5 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline", focusRing)}>Reschedule or cancel <ChevronRight className="size-4" aria-hidden /></Link>
                ) : s && !s.locked ? (
                  <Link href={d.hrefs.schedule} className={cn("mt-1.5 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline", focusRing)}>Manage filming in Schedule <ChevronRight className="size-4" aria-hidden /></Link>
                ) : null)}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {/* Keep the full bank in reach when choosing or answering, then fold it
          so a later action does not compete with a second work area. A client
          who plans their own content has no topics to choose (Oct 8 2026). */}
      {!clientPlanned && <section id="this-month" aria-label="This month's topics" className="scroll-mt-24">
        <details open={topicsAreCurrent} className="rounded-2xl border border-border bg-surface/70 px-4 py-3">
          <summary className={cn("min-h-11 cursor-pointer py-2 text-sm font-semibold", focusRing)}>This month&rsquo;s topics · {month.selected} of {month.owed} chosen</summary>
          <div className="mt-3 space-y-3">
            <Link href={d.hrefs.bank} className={cn("inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline", focusRing)}>Browse the full topic bank <ChevronRight className="size-4" aria-hidden /></Link>
            <TopicBank
              key={month.id}
              groups={d.topics.groups} months={d.topics.months} archivedCount={d.topics.archivedCount} total={d.topics.total} strategyLabel={d.topics.strategyLabel}
              canAct={d.can.suggest} readOnly={d.readOnly} initialFilter={d.filter}
              tabHref={d.hrefs.month} view="month" initialMonthId={month.id} scriptsHref={d.hrefs.scripts}
            />
          </div>
        </details>
      </section>}
    </div>
  );
}

/**
 * "Your September session still needs booking, and October's too" (Oct 12
 * 2026). One scheduler with both sessions, the way a two-session month books:
 * the late month's tab is gated by ITS plan (scripts ready), this month's by
 * this month's own. Its scripts are right here, words in full, to prep from.
 */
function LateSessionCard({ d, late, hostName }: { d: YourMonthData; late: NonNullable<PortalPlanning["late"]>; hostName: string }) {
  const s = d.schedule;
  // Oct 13 2026: one session for both months has ONE tab (the late month's); this month has none of its own.
  const combined = late.combine.combined;
  const months = (combined ? [d.late?.schedule ?? null] : [d.late?.schedule ?? null, s])
    .filter((m, i, all): m is PortalScheduleMonth => !!m && all.findIndex((x) => x?.monthId === m.monthId) === i);
  const scripts = d.late?.scripts ?? [];
  const pick = d.selectedScheduleMonthId && months.some((m) => m.monthId === d.selectedScheduleMonthId) ? d.selectedScheduleMonthId : late.monthId;
  return (
    <section id="step-late" aria-labelledby="late-session-line" className="scroll-mt-24 rounded-2xl border border-brand/40 bg-surface/70 p-4 shadow-sm backdrop-blur">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">{late.label} session</div>
      <h3 id="late-session-line" className="break-words text-base font-semibold leading-snug">{late.line}</h3>
      <p className="mt-1 text-sm text-muted">
        {combined
          ? `This one session films your ${late.label} and ${hostName} videos together, so it opens once your ${late.label} scripts are ready and ${hostName} is planned.`
          : <>
              {late.scriptsReady ? `Your ${late.label} scripts are ready, so you can book that session now.` : `We're finishing your ${late.label} scripts. That session opens as soon as they're ready.`}
              {s ? ` ${hostName}'s session follows ${hostName}'s own plan.` : ""}
            </>}
      </p>
      {/* Oct 13 2026: one Video Accelerator session for both months is the office's call (Settings on the client file), never the client's. */}
      {d.scheduleFailed ? (
        <div className="mt-2"><LoadFailed what="your filming calendar" /></div>
      ) : months.length > 0 ? (
        <div className="mt-3">
          <PortalScheduler key={`late:${pick}:${d.selectedSessionIndex ?? "next"}`} months={months} bookingUrl={d.bookingUrl} days={d.slotDays} readOnly={!d.can.session || d.readOnly} timezone={d.planning?.timezone} selectedMonthId={pick} selectedSessionIndex={pick === s?.monthId ? d.selectedSessionIndex : null} embedded />
        </div>
      ) : null}
      {scripts.length > 0 ? (
        <details className="mt-3 rounded-xl border border-border bg-surface-2/40 px-3 py-2">
          <summary className={cn("flex min-h-11 cursor-pointer items-center text-sm font-semibold", focusRing)}>Your {late.label} scripts ({scripts.length})</summary>
          <ul className="mt-2 space-y-4">
            {scripts.map((sc, i) => (
              <li key={sc.topicId ?? i}>
                <h4 className="break-words text-sm font-semibold">{sc.title}</h4>
                <div className="mt-1 max-w-[70ch]"><ScriptBody body={sc.body} /></div>
              </li>
            ))}
          </ul>
        </details>
      ) : late.sentOutside ? (
        <p className="mt-3 text-sm text-muted">We sent your {late.label} scripts to you directly. Have them handy for the session.</p>
      ) : null}
    </section>
  );
}
