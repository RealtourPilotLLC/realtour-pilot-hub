import { CalendarClock, Camera, Check, FileText, Film, Lightbulb } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// The month journey — one visual language for "where is this client's month?"
// used at card size on the Content Program dashboard and at hero size on the
// client workspace. Five steps, derived from the SAME pipeline counts the
// roster reads, so the tracker can never disagree with the numbers:
//   Call → Topics → Scripts → Shoot → Delivered
// ---------------------------------------------------------------------------

export type JourneyInput = {
  callStatus: string; // NOT_REQUIRED | NOT_SCHEDULED | SCHEDULED | COMPLETED | SKIPPED
  topicsSelected: number;
  scriptsReady: number;
  videosOwed: number;
  sessionsScheduled: number;
  sessionsRequired: number;
  shotCount: number;
  delivered: number;
  inReview: number;
  /** historical/imported months read as record-keeping, never as warnings */
  muted?: boolean;
};

type StepState = "done" | "active" | "warn" | "todo";
type Step = { key: string; label: string; icon: LucideIcon; state: StepState; detail: string };

export function journeySteps(j: JourneyInput): Step[] {
  const owed = Math.max(j.videosOwed, 1);
  const call: Step = (() => {
    if (j.callStatus === "NOT_REQUIRED") return { key: "call", label: "Call", icon: CalendarClock, state: "done", detail: "not needed" };
    if (j.callStatus === "SKIPPED") return { key: "call", label: "Call", icon: CalendarClock, state: "done", detail: "skipped" };
    if (j.callStatus === "COMPLETED") return { key: "call", label: "Call", icon: CalendarClock, state: "done", detail: "done" };
    if (j.callStatus === "SCHEDULED") return { key: "call", label: "Call", icon: CalendarClock, state: "active", detail: "booked" };
    return { key: "call", label: "Call", icon: CalendarClock, state: "warn", detail: "not booked" };
  })();
  const topics: Step = {
    key: "topics", label: "Topics", icon: Lightbulb, detail: `${j.topicsSelected}/${owed}`,
    state: j.topicsSelected >= owed ? "done" : j.topicsSelected > 0 ? "active" : call.state === "done" ? "warn" : "todo",
  };
  const scripts: Step = {
    key: "scripts", label: "Scripts", icon: FileText, detail: `${j.scriptsReady}/${owed}`,
    state: j.scriptsReady >= owed ? "done" : j.scriptsReady > 0 ? "active" : topics.state === "done" ? "warn" : "todo",
  };
  const shoot: Step = {
    key: "shoot", label: "Shoot", icon: Camera, detail: `${j.sessionsScheduled}/${Math.max(j.sessionsRequired, 1)} booked`,
    state:
      j.shotCount > 0 && j.sessionsScheduled >= j.sessionsRequired ? "done"
      : j.sessionsScheduled > 0 ? "active"
      : "warn",
  };
  const delivered: Step = {
    key: "delivered", label: "Delivered", icon: Film, detail: `${j.delivered}/${owed}`,
    state: j.videosOwed > 0 && j.delivered >= j.videosOwed ? "done" : j.delivered > 0 ? "active" : "todo",
  };
  const steps = [call, topics, scripts, shoot, delivered];
  // Imported history: show what happened, never nag about what didn't.
  if (j.muted) for (const s of steps) if (s.state === "warn") s.state = "todo";
  return steps;
}

const NODE: Record<StepState, string> = {
  done: "bg-success/15 text-success",
  active: "bg-brand/15 text-brand ring-2 ring-brand/40",
  warn: "bg-warning/15 text-warning",
  todo: "bg-surface-2 text-muted-2",
};
const BAR: Record<StepState, string> = {
  done: "bg-success/50",
  active: "bg-brand/40",
  warn: "bg-warning/40",
  todo: "bg-border",
};

// Compact tracker for the dashboard cards: five labeled nodes with connectors.
export function MonthJourney({ input, size = "card" }: { input: JourneyInput; size?: "card" | "hero" }) {
  const steps = journeySteps(input);
  const hero = size === "hero";
  return (
    <div className="flex items-start">
      {steps.map((s, i) => (
        <div key={s.key} className={cn("flex min-w-0 flex-1 flex-col items-center", i > 0 && "-ml-px")}>
          <div className="flex w-full items-center">
            <span className={cn("h-0.5 flex-1 rounded", i === 0 ? "bg-transparent" : BAR[steps[i - 1].state === "todo" || s.state === "todo" ? "todo" : s.state === "warn" || steps[i - 1].state === "warn" ? "warn" : steps[i - 1].state])} />
            <span className={cn("flex shrink-0 items-center justify-center rounded-full", hero ? "size-9" : "size-7", NODE[s.state])} title={`${s.label}: ${s.detail}`}>
              {s.state === "done" ? <Check className={hero ? "size-4.5" : "size-3.5"} /> : <s.icon className={hero ? "size-4.5" : "size-3.5"} />}
            </span>
            <span className={cn("h-0.5 flex-1 rounded", i === steps.length - 1 ? "bg-transparent" : BAR[s.state === "todo" || steps[i + 1].state === "todo" ? "todo" : s.state])} />
          </div>
          <span className={cn("mt-1 truncate font-medium", hero ? "text-[11px]" : "text-[9.5px]", s.state === "warn" ? "text-warning" : s.state === "todo" ? "text-muted-2" : "text-muted")}>
            {s.label}
          </span>
          {hero && (
            <span className={cn("text-[10px]", s.state === "warn" ? "text-warning" : "text-muted-2")}>{s.detail}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// The delivered-videos meter under each card: a real progress bar beats a
// fraction for at-a-glance reading.
export function VideoMeter({ delivered, owed, inReview }: { delivered: number; owed: number; inReview: number }) {
  const pct = owed > 0 ? Math.min(100, Math.round((delivered / owed) * 100)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-muted">Videos delivered</span>
        <span className="text-muted">
          <span className={delivered >= owed && owed > 0 ? "font-semibold text-success" : "font-semibold text-foreground"}>{delivered}</span>
          /{owed}
          {inReview > 0 && <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">{inReview} in review</span>}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={cn("h-full rounded-full", delivered >= owed && owed > 0 ? "bg-success" : "bg-brand")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
