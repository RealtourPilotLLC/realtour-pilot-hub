"use client";

import { ChevronDown } from "lucide-react";
import { useDetailsMenu } from "@/components/ui/useDetailsMenu";
import { cn } from "@/lib/utils";

export type CheckboxOption = { value: string; label: string; hint?: string };

/**
 * A dropdown of checkboxes (Jordan, Oct 30 2026: "the dropdown for assignment
 * could be a dropdown of checkboxes"). Controlled: it reports every tick and
 * the parent decides when to save. The button reads back what is ticked, or
 * `emptyText` when nothing is.
 */
export function CheckboxDropdown({ label, options, value, onChange, emptyText = "None", disabled = false, className }: {
  label: string;
  options: CheckboxOption[];
  value: string[];
  onChange: (next: string[]) => void;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}) {
  const menu = useDetailsMenu();
  const picked = options.filter((o) => value.includes(o.value));
  const summary = picked.length ? picked.map((o) => o.label).join(", ") : emptyText;
  const toggle = (v: string, on: boolean) => onChange(on ? [...value.filter((x) => x !== v), v] : value.filter((x) => x !== v));
  return (
    <details {...menu.detailsProps} className={cn("relative", className)}>
      <summary
        {...menu.summaryProps}
        aria-label={`${label}: ${summary}`}
        aria-disabled={disabled || undefined}
        onClick={(e) => { if (disabled) { e.preventDefault(); return; } menu.summaryProps.onClick(e); }}
        className={cn(
          "flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm [&::-webkit-details-marker]:hidden",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
          disabled && "cursor-not-allowed opacity-60",
          !picked.length && "text-muted",
        )}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 transition-transform", menu.open && "rotate-180")} />
      </summary>
      <div
        {...menu.panelProps}
        role="group"
        aria-label={label}
        className="panel-shadow absolute left-0 z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border bg-surface p-1"
      >
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <label key={o.value} className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-surface-2 focus-within:outline-2 focus-within:outline-offset-[-2px] focus-within:outline-brand">
              <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => toggle(o.value, e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
              <span className="min-w-0">
                <span className={cn("block text-sm", on ? "font-medium text-foreground" : "text-foreground")}>{o.label}</span>
                {o.hint && <span className="block text-xs leading-snug text-muted">{o.hint}</span>}
              </span>
            </label>
          );
        })}
        {!options.length && <p className="px-2.5 py-2 text-sm text-muted">Nothing to choose yet.</p>}
      </div>
    </details>
  );
}
