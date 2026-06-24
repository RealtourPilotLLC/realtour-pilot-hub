import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

// Shared card/section primitive — the one canonical "panel" used across the app
// so every page reads with the same rhythm: a `rounded-2xl border bg-surface`
// card, a `border-b` header row with an icon + title (+ optional count badge +
// right-aligned action), and a padded body.
//
//   <Section icon={Package} title="Ordered deliverables" count={3}>…</Section>
//
// Use `flush` when the body owns its own padding (e.g. a `divide-y` list whose
// rows are `px-5 py-3`), and `tone="warning"` for the amber highlight variant.
export function Section({
  icon: Icon,
  title,
  count,
  action,
  tone = "default",
  flush = false,
  bodyClassName,
  className,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  count?: number | string | null;
  action?: React.ReactNode;
  tone?: "default" | "warning";
  flush?: boolean;
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const warning = tone === "warning";
  return (
    <section
      className={cn(
        "panel-shadow overflow-hidden rounded-2xl border bg-surface",
        warning && "border-warning/30 bg-warning-soft/40",
        className,
      )}
    >
      <div className={cn("flex items-center gap-2.5 border-b px-5 py-3.5", warning && "border-warning/20")}>
        {Icon && (
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-lg",
              warning ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted",
            )}
          >
            <Icon className="size-4" />
          </span>
        )}
        <h2 className={cn("text-sm font-semibold", warning && "text-warning")}>{title}</h2>
        {count != null && (
          <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{count}</span>
        )}
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      {flush ? children : <div className={cn("px-5 py-4", bodyClassName)}>{children}</div>}
    </section>
  );
}
