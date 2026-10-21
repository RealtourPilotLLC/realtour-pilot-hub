"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The one on/off switch (Oct 21 2026, audit H17). Ten screens had hand-built
// copies with different sizes and knob offsets. This is the Settings look:
// a 44px tap box (phones) around a 24px track, green when on.
//
//   <Switch checked={on} onChange={setOn} aria-label="Upload reminder" />
//   <Switch checked={on} onChange={setOn} label="Weekdays only" description="…" />
//
// A native <button role="switch">, so Space and Enter work and it takes the
// app's focus ring. The caller owns the state: flip it at once (optimistic)
// and put it back if the save is refused. `busy` disables it while a save runs.
// Without a visible `label`, pass `aria-label`.

type Tone = "success" | "warning";
const ON: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
};

export function Switch({
  checked,
  onChange,
  tone = "success",
  busy = false,
  disabled,
  label,
  description,
  labelClassName,
  className,
  ...props
}: Omit<ComponentProps<"button">, "onChange" | "role" | "type" | "children" | "onClick"> & {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The track colour when on. "warning" for a switch whose ON state is the cautionary one. */
  tone?: Tone;
  /** A save is running: the switch is disabled and says so to screen readers. */
  busy?: boolean;
  /** Visible label beside the switch; the whole label is then the tap target. */
  label?: ReactNode;
  /** A muted line under the visible label (read as the switch's description). */
  description?: ReactNode;
  /** Classes for the wrapping <label> when `label` is given (e.g. a card). */
  labelClassName?: string;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const descId = `${id}-desc`;
  const hasLabel = label != null;
  const control = (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      aria-labelledby={hasLabel ? labelId : props["aria-labelledby"]}
      aria-describedby={hasLabel && description ? descId : props["aria-describedby"]}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg",
        "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "relative h-6 w-11 rounded-full transition-colors motion-reduce:transition-none",
          checked ? ON[tone] : "bg-surface-2 ring-1 ring-border-strong",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none",
            checked && "translate-x-5",
          )}
        />
      </span>
    </button>
  );
  if (!hasLabel) return control;
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", (disabled || busy) && "cursor-not-allowed", labelClassName)}>
      {control}
      <span className="min-w-0 pt-2.5">
        <span id={labelId} className="block text-sm font-medium">{label}</span>
        {description && <span id={descId} className="block text-ui-status text-muted">{description}</span>}
      </span>
    </label>
  );
}
