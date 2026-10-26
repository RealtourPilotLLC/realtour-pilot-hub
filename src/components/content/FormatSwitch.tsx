import { cn } from "@/lib/utils";
import { FORMAT_SWITCH_OPTIONS, type VideoFormat } from "@/lib/contentPolicy/videoFormat";

// ---------------------------------------------------------------------------
// THE PILLAR'S FORMAT SWITCH (Oct 26 2026, Jordan: "anyone that does skits,
// needs skit concepts as video topics ... They should be able to switch back
// and forth between direct to camera and skits for each pillar").
//
// Two buttons, "Talking to camera | Skits", each with its count, on every
// pillar heading of an account that does skits (the portal's topic bank and
// the office's Video Topics). It only filters which of the pillar's cards are
// listed; the caller keeps each pillar's choice. aria-pressed carries the
// state (the filled button), never a border colour: an unlayered
// `* { border-color }` rule in globals.css wins over Tailwind's border-colour
// utilities. 44px tall on a phone, compact from sm up.
// ---------------------------------------------------------------------------

export function FormatSwitch({ value, counts, onChange, label, className }: {
  value: VideoFormat;
  counts: Record<VideoFormat, number>;
  onChange: (f: VideoFormat) => void;
  /** What the group switches, for a screen reader (e.g. "Buyer Education: talking to camera or skits"). */
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex shrink-0 gap-0.5 rounded-lg bg-surface-2 p-0.5 normal-case tracking-normal", className)}>
      {FORMAT_SWITCH_OPTIONS.map((o) => {
        const on = o.format === value;
        return (
          <button key={o.format} type="button" aria-pressed={on} onClick={() => { if (!on) onChange(o.format); }}
            className={cn(
              "inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand sm:min-h-0 sm:px-2 sm:py-1 sm:text-[11px]",
              on ? "bg-brand-action text-white" : "text-muted hover:text-foreground",
            )}>
            {o.label}
            <span className="tabular-nums opacity-80">{counts[o.format]}</span>
          </button>
        );
      })}
    </div>
  );
}
