import { Check } from "lucide-react";
import type { TimelineStep } from "@/lib/videoTimeline";

// ---------------------------------------------------------------------------
// THE VIDEO'S TIMELINE, SMALL, IN THE JOB BAR (Jordan, Oct 27 2026: "a little
// timeline ... of where, what stage the video project is at"). One row of
// steps from lib/videoTimeline: what happened (with its date), the step it is
// on now, and what is still to come. It wraps on a phone instead of scrolling.
// ---------------------------------------------------------------------------

export function StageStrip({ steps, tz = "America/New_York" }: { steps: TimelineStep[]; tz?: string }) {
  if (!steps.length) return null;
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" }) : null;
  const current = steps.find((s) => s.state === "current");
  return (
    <ol aria-label="Where this video is" data-stage-strip={current?.key ?? "done"} className="flex flex-wrap items-start gap-x-1 gap-y-2">
      {steps.map((s, i) => (
        <li key={i} data-stage={s.key} data-stage-state={s.state} aria-current={s.state === "current" ? "step" : undefined} className="flex items-start gap-1">
          <span className="flex flex-col items-start">
            <span
              className={`inline-flex min-h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium ${
                s.state === "current"
                  ? "bg-brand-action text-brand-fg"
                  : s.state === "done"
                    ? "bg-success/10 text-success"
                    : "border border-dashed border-border text-muted-2"
              }`}
            >
              {s.state === "done" && <Check aria-hidden className="size-3" />}
              {s.label}
            </span>
            {when(s.atISO) && <span className="mt-0.5 px-2.5 text-[11px] text-muted">{when(s.atISO)}</span>}
          </span>
          {i < steps.length - 1 && <span aria-hidden className="mt-3 h-px w-3 bg-border" />}
        </li>
      ))}
    </ol>
  );
}
