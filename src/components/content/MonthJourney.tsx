import Link from "next/link";
import { CalendarClock, Camera, Check, FileText, Film, Lightbulb } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { journeySteps, type JourneyInput, type JourneyStepKey, type JourneyStepState } from "@/lib/contentStatus";
import type { OverviewRow } from "@/lib/programOverview";
import { contentHref } from "@/lib/contentNav";

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

/** Existing work views, explicitly pinned even for the current month. A copied
 * link must keep that month after the calendar turns. No workspace means no
 * invented milestone destination; its progress remains information. */
export function monthJourneyLinks(row: Pick<OverviewRow, "enrollmentId" | "monthId" | "monthKey" | "planning">): Partial<Record<JourneyStepKey, string>> {
  if (!row.monthId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.monthKey)) return {};
  const href = (tab: "plan" | "production", view: string) => {
    const target = contentHref(row.enrollmentId, { tab, view, month: row.monthKey });
    const [path, search] = target.split("?");
    const q = new URLSearchParams(search);
    q.set("month", row.monthKey);
    return `${path}?${q}`;
  };
  return {
    ...(row.planning.callStatus === "NOT_REQUIRED" ? {} : { call: href("plan", "calls") }),
    topics: href("plan", "topics"), scripts: href("plan", "scripts"),
    shoot: href("production", "sessions"),
    // The existing video library is explicitly all months. Do not label it
    // as the selected month's delivered-video destination.
  };
}

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

// Five recorded stages. Only supplied destinations turn them into links.
export function MonthJourney({ input, size = "card", hrefs = {}, contextLabel }: {
  input: JourneyInput; size?: "card" | "hero";
  hrefs?: Partial<Record<JourneyStepKey, string>>; contextLabel?: string;
}) {
  const steps = journeySteps(input);
  const hero = size === "hero";
  return (
    <div className="grid grid-cols-5 gap-1" aria-label={contextLabel ? `Month progress for ${contextLabel}` : "Month progress"}>
      {steps.map((s, i) => {
        const Icon = ICON[s.key];
        const title = s.state === "unknown" ? `${s.label}: unknown — ${s.why ?? "not enough facts to say"}` : `${s.label}: ${s.detail}`;
        const node = (
          <>
              <span className={cn("flex shrink-0 items-center justify-center rounded-full", hero ? "size-9" : "size-7", NODE[s.state])} aria-hidden>
                {s.state === "done" ? <Check className={hero ? "size-4.5" : "size-3.5"} />
                  : s.state === "unknown" ? <span className={cn("font-semibold leading-none", hero ? "text-base" : "text-xs")} aria-hidden>?</span>
                  : <Icon className={hero ? "size-4.5" : "size-3.5"} />}
              </span>
            <span className={cn("mt-1 break-words text-ui-status font-medium", s.state === "warn" ? "text-warning" : "text-muted")}>
              {s.label}
            </span>
          </>
        );
        const target = hrefs[s.key];
        return (
          <div key={s.key} className="min-w-0 text-center">
            <div className="relative">
              {i < steps.length - 1 && <span aria-hidden className={cn("absolute left-1/2 top-5 h-0.5 w-full", BAR[s.state === "todo" || steps[i + 1].state === "todo" ? "todo" : s.state])} />}
              {target ? <Link href={target} prefetch={false} aria-label={`${contextLabel ? `${contextLabel}: ` : ""}${title}. Open ${s.label.toLowerCase()}.`}
                className="relative flex min-h-11 min-w-11 flex-col items-center rounded-lg px-1 py-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{node}</Link>
                : <span className="relative flex min-h-11 flex-col items-center px-1 py-1" aria-label={title}>{node}</span>}
            </div>
            <p className={cn("mt-0.5 break-words text-ui-status", s.state === "warn" ? "text-warning" : "text-muted")}>{s.detail}</p>
          </div>
        );
      })}
      {steps.some((s) => s.why) && <ul className="col-span-5 mt-2 space-y-1 text-left text-sm text-warning">
        {steps.filter((s) => s.why).map((s) => <li key={s.key}>{s.label}: {s.why}</li>)}
      </ul>}
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
      <div className="flex flex-wrap items-center justify-between gap-1 text-ui-status">
        <span className="font-medium text-muted">Videos delivered</span>
        <span className="text-muted" title={unknown ?? undefined}>
          <span className={delivered >= owed && owed > 0 ? "font-semibold text-success" : "font-semibold text-foreground"}>{delivered}</span>
          /{owed}
          {unknown && <span className="ml-1 rounded border border-dashed border-muted-2 px-1 text-ui-status font-medium text-muted">? count unknown</span>}
          {inReview > 0 && <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-ui-status font-medium text-brand">{inReview} in review</span>}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={cn("h-full rounded-full", delivered >= owed && owed > 0 ? "bg-success" : "bg-brand")} style={{ width: `${pct}%` }} />
      </div>
      {unknown && <p className="mt-1 text-sm text-warning">Delivery count could not be confirmed: {unknown}.</p>}
    </div>
  );
}
