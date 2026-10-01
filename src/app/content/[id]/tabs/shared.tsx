import Link from "next/link";
import type { ContentMonth } from "@prisma/client";
import { cn } from "@/lib/utils";
import { monthLabel } from "@/lib/contentProgram";
import { contentHref, type StaffTab } from "@/lib/contentNav";
import type { MonthProgress } from "@/lib/monthProgress";
import { MonthPicker, SkipMonthButton } from "@/components/content/MonthControls";

// What every tab of the client file is handed by the page shell (UI-02). The
// shell reads the enrollment, the client, the month list and the one
// MonthProgress once; each tab then loads only its own data.
export type TabCtx = {
  id: string;
  client: { id: string; name: string; email: string | null; phone: string | null; company: string | null; generalNotes: string | null; editingPreferences: string | null };
  enrollment: { package: string; status: string; videosPerMonth: number; sessionsPerMonth: number; strategyCallRequired: boolean; portalToken: string | null };
  months: ContentMonth[];
  /** the month on screen — the requested one, else this ET month, else the newest */
  month: ContentMonth | null;
  activeKey: string;
  /** Plan / Production sub-view */
  view: string | null;
  progress: MonthProgress | null;
  me: { id: string; role: string; name: string | null } | null;
  /** OWNER (or open local dev) — money, billing, the portal mirror */
  ownerEyes: boolean;
  /** OWNER or ADMIN (or open local dev) — the roles the program's write actions accept */
  staffEyes: boolean;
};

/** A tab's second row of links (Plan › Topics …). Wraps rather than scrolls at 375px. */
export function SubNav({ id, tab, current, views, month, badges = {} }: {
  id: string; tab: StaffTab; current: string | null; views: { key: string; label: string }[]; month: string | null; badges?: Record<string, number>;
}) {
  return (
    <nav aria-label="Section" className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
      {views.map((v) => (
        <Link
          key={v.key}
          href={contentHref(id, { tab, view: v.key, month })}
          aria-current={current === v.key ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 min-w-11 max-w-full items-center rounded-lg px-3 py-2 text-ui-secondary font-medium whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
            current === v.key ? "bg-surface-2 text-foreground" : "text-muted hover:bg-surface-2/60 hover:text-foreground",
          )}
        >
          {v.label}
          {(badges[v.key] ?? 0) > 0 && <span className="ml-1.5 shrink-0 rounded-full bg-brand-soft px-1.5 text-ui-status font-semibold text-brand">{badges[v.key]}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** The month's name, with history one dropdown away. `withSkip` adds the skip-month control (Overview only). */
export function MonthHeader({ ctx, tab, view, title, subtitle, withSkip = false }: {
  ctx: TabCtx; tab: StaffTab; view?: string | null; title?: string; subtitle?: string | null; withSkip?: boolean;
}) {
  const m = ctx.month;
  const key = m?.monthKey ?? ctx.activeKey;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="break-words text-2xl font-semibold tracking-tight">
          {title ?? monthLabel(key)}
          {m?.historical && <span className="ml-2 align-middle text-ui-status font-normal text-muted">imported history</span>}
          {m?.status === "SKIPPED" && <span className="ml-2 align-middle text-ui-status font-normal text-muted">skipped</span>}
        </h2>
        {subtitle && <p className="mt-1 break-words text-ui-secondary leading-relaxed text-muted">{subtitle}</p>}
      </div>
      {ctx.months.length > 0 && (
        <div className="flex max-w-full flex-wrap items-center gap-2 [&>span]:min-w-0 [&>span]:max-w-full [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:text-ui-secondary [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-brand [&_select]:min-h-11 [&_select]:min-w-0 [&_select]:max-w-full [&_select]:text-base [&_select]:focus-visible:outline-2 [&_select]:focus-visible:outline-offset-2 [&_select]:focus-visible:outline-brand">
          <MonthPicker
            months={ctx.months.map((x) => ({ key: x.monthKey, label: monthLabel(x.monthKey), historical: x.historical }))}
            currentKey={key}
            makeHref={contentHref(ctx.id, { tab, view: view ?? null, month: "MONTH" })}
          />
          {withSkip && m && <SkipMonthButton monthId={m.id} skipped={m.status === "SKIPPED"} />}
        </div>
      )}
    </div>
  );
}
