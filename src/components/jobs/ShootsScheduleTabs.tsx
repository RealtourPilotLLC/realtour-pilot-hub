import Link from "next/link";
import { cn } from "@/lib/utils";
import { PROJECTS_LABEL } from "@/lib/sidebarNavigation";

// ---------------------------------------------------------------------------
// PROJECTS | SCHEDULE (Oct 22 2026, Jordan's approved menus). Schedule stopped
// being a menu door of its own; it is a tab on Projects ("Shoots" until Oct
// 27 2026), so one door reaches both pages. The two pages keep their own
// logic and routes: this is only the strip that links them. Drawn only for a
// reader who may open both, so neither tab is a door that bounces.
// ---------------------------------------------------------------------------

export function ShootsScheduleTabs({ current, includeTest = false, show = true }: { current: "projects" | "schedule"; includeTest?: boolean; show?: boolean }) {
  if (!show) return null;
  const q = includeTest ? "?test=1" : "";
  const tab = (key: "projects" | "schedule", href: string, label: string) => (
    <Link
      href={`${href}${q}`}
      aria-current={current === key ? "page" : undefined}
      className={cn(
        "inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        current === key ? "bg-brand-soft text-brand ring-1 ring-inset ring-brand/20" : "text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Projects and schedule" className="flex gap-1 border-b border-border px-4 py-2 sm:px-6">
      {tab("projects", "/jobs", PROJECTS_LABEL)}
      {tab("schedule", "/schedule", "Schedule")}
    </nav>
  );
}
