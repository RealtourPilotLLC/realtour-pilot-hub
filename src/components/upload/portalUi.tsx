"use client";

import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// The upload page's building blocks (Oct 23 2026 revamp). A numbered card for
// each of the three steps, a plain card for the agent's requests, and a fold
// for everything that is detail (standards, policies, item lists, reports):
// the detail is never removed, only one tap away. Theme tokens only, so both
// themes read; every control is at least 44px tall for a phone in the field.
// ---------------------------------------------------------------------------

export function PortalCard({
  n, icon, title, subtitle, done, id, children, className, right,
}: {
  n?: number;
  icon?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  done?: boolean;
  id?: string;
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <section id={id} data-portal-card={id ?? title} className={cn("min-w-0 rounded-2xl border bg-surface p-4 sm:p-5", className)}>
      <div className="flex items-start gap-3">
        {(n != null || icon) && (
          <span
            aria-hidden
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold",
              done ? "bg-success/15 text-success" : n != null ? "bg-brand-action text-brand-fg" : "bg-brand-soft text-brand",
            )}
          >
            {done ? <Check className="size-4.5" /> : n != null ? n : icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className="mt-4 min-w-0">{children}</div>
    </section>
  );
}

/** An expandable section: closed it is one line that says what is inside. */
export function Fold({
  title, summary, open, onToggle, children, tone = "plain", className, id,
}: {
  title: ReactNode;
  summary?: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
  tone?: "plain" | "warning" | "danger" | "brand";
  className?: string;
  id?: string;
}) {
  return (
    <details
      id={id}
      className={cn(
        "group rounded-xl border",
        tone === "warning" ? "border-warning/40 bg-warning/5" : tone === "danger" ? "border-danger/30 bg-danger/5" : tone === "brand" ? "border-brand/30 bg-brand-soft/20" : "border-border bg-surface",
        className,
      )}
      open={open}
      onToggle={onToggle ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open) : undefined}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          {title}
          {summary && <span className="ml-1.5 font-normal text-muted">{summary}</span>}
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border px-3.5 py-3">{children}</div>
    </details>
  );
}

/** A small status chip. */
export function StatusChip({ tone, children }: { tone: "ok" | "warn" | "muted" | "brand" | "danger"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        tone === "ok" && "bg-success/15 text-success",
        tone === "warn" && "bg-warning/15 text-warning",
        tone === "danger" && "bg-danger/15 text-danger",
        tone === "brand" && "bg-brand-soft text-brand",
        tone === "muted" && "bg-surface-2 text-muted",
      )}
    >
      {children}
    </span>
  );
}

/** Initials in a disc (the roster and the shared instructions). */
export function Initials({ name, size = 32 }: { name: string; size?: number }) {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-brand/30 bg-brand-soft font-semibold text-brand"
    >
      {ini}
    </span>
  );
}
