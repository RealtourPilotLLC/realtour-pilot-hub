import { CalendarClock, Camera, Check, FileText, Film, Lightbulb } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { journeySteps, type JourneyInput, type JourneyStepKey, type JourneyStepState } from "@/lib/contentStatus";
import type { OverviewRow } from "@/lib/programOverview";

// ---------------------------------------------------------------------------
// The month journey — one visual language for "where is this client's month?"
// used at card size on the Content Program dashboard and at hero size on the
// client workspace. Five steps:
//   Call → Topics → Scripts → Shoot → Delivered
// The step LOGIC lives in lib/contentStatus (pure, so the drills can hold it
// to account) and its input comes from lib/monthProgress.journeyInputFrom —
// the one month-progress reader the roster, the client file, the portal and
// the reminders all share (CP-10). This file only draws it.
// ---------------------------------------------------------------------------

export type { JourneyInput };

/**
 * The tracker for one roster row (UI-02). The row carries the SAME
 * journeyInputFrom(MonthProgress) the client file's hero draws, so a card and
 * the Overview it opens cannot show two different months. Only when the
 * reader returned nothing is it rebuilt from the row's own counts — and then
 * the Shoot node says it does not know, rather than guessing from a proxy.
 */
export function journeyFromOverview(r: OverviewRow): JourneyInput {
  if (r.journey) return r.journey;
  return {
    callStatus: r.planning.callStatus,
    topicsSelected: r.work.topicsSelected,
    scriptsReady: r.work.scriptsApproved,
    scriptsAwaiting: r.work.scriptsDrafting + r.work.scriptsReviewNeeded,
    videosOwed: r.production.owed,
    sessionsRequired: r.session.required,
    sessionsConfirmed: r.session.confirmed,
    sessionsFilmedConfirmed: r.session.filmedConfirmed,
    delivered: r.production.delivered,
    clientApproved: r.production.clientApproved,
    inReview: r.production.awaitingInternalReview,
    unknown: { shoot: "the month's progress could not be read — refresh to try again" },
    muted: r.historical || r.monthStatus === "SKIPPED",
  };
}

const ICON: Record<JourneyStepKey, LucideIcon> = { call: CalendarClock, topics: Lightbulb, scripts: FileText, shoot: Camera, delivered: Film };

const NODE: Record<JourneyStepState, string> = {
  done: "bg-success/15 text-success",
  active: "bg-brand/15 text-brand ring-2 ring-brand/40",
  warn: "bg-warning/15 text-warning",
  todo: "bg-surface-2 text-muted-2",
  // Unknown is its own shape, not a colour: a dashed ring and a "?" glyph,
  // with the reason in the title — so it reads the same without colour.
  unknown: "border-2 border-dashed border-muted-2 bg-surface text-muted",
};
const BAR: Record<JourneyStepState, string> = {
  done: "bg-success/50",
  active: "bg-brand/40",
  warn: "bg-warning/40",
  todo: "bg-border",
  unknown: "bg-border",
};

// Compact tracker for the dashboard cards: five labeled nodes with connectors.
export function MonthJourney({ input, size = "card" }: { input: JourneyInput; size?: "card" | "hero" }) {
  const steps = journeySteps(input);
  const hero = size === "hero";
  return (
    <div className="flex items-start">
      {steps.map((s, i) => {
        const Icon = ICON[s.key];
        const title = s.state === "unknown" ? `${s.label}: unknown — ${s.why ?? "not enough facts to say"}` : `${s.label}: ${s.detail}`;
        return (
          <div key={s.key} className={cn("flex min-w-0 flex-1 flex-col items-center", i > 0 && "-ml-px")}>
            <div className="flex w-full items-center">
              <span className={cn("h-0.5 flex-1 rounded", i === 0 ? "bg-transparent" : BAR[steps[i - 1].state === "todo" || s.state === "todo" ? "todo" : s.state === "warn" || steps[i - 1].state === "warn" ? "warn" : steps[i - 1].state])} />
              <span className={cn("flex shrink-0 items-center justify-center rounded-full", hero ? "size-9" : "size-7", NODE[s.state])} title={title} aria-label={title}>
                {s.state === "done" ? <Check className={hero ? "size-4.5" : "size-3.5"} />
                  : s.state === "unknown" ? <span className={cn("font-semibold leading-none", hero ? "text-base" : "text-xs")} aria-hidden>?</span>
                  : <Icon className={hero ? "size-4.5" : "size-3.5"} />}
              </span>
              <span className={cn("h-0.5 flex-1 rounded", i === steps.length - 1 ? "bg-transparent" : BAR[s.state === "todo" || steps[i + 1].state === "todo" ? "todo" : s.state])} />
            </div>
            <span className={cn("truncate font-medium", hero ? "mt-1.5 text-sm" : "mt-1 text-[9.5px]", s.state === "warn" ? "text-warning" : s.state === "todo" ? "text-muted-2" : "text-muted")}>
              {s.label}
            </span>
            {hero && (
              <span className={cn("mt-0.5 text-xs", s.state === "warn" ? "text-warning" : "text-muted-2")} title={s.why ?? undefined}>{s.detail}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// The delivered-videos meter under each card: a real progress bar beats a
// fraction for at-a-glance reading. `unknown` is the reader's sentence when the
// count cannot be trusted (the library is behind the pipeline) — the number is
// then marked with a "?" and the reason, never shown as a confident figure.
export function VideoMeter({ delivered, owed, inReview, unknown }: { delivered: number; owed: number; inReview: number; unknown?: string | null }) {
  const pct = owed > 0 ? Math.min(100, Math.round((delivered / owed) * 100)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-muted">Videos delivered</span>
        <span className="text-muted" title={unknown ?? undefined}>
          <span className={delivered >= owed && owed > 0 ? "font-semibold text-success" : "font-semibold text-foreground"}>{delivered}</span>
          /{owed}
          {unknown && <span className="ml-1 rounded border border-dashed border-muted-2 px-1 text-[10px] font-medium text-muted">? count unknown</span>}
          {inReview > 0 && <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">{inReview} in review</span>}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={cn("h-full rounded-full", delivered >= owed && owed > 0 ? "bg-success" : "bg-brand")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
