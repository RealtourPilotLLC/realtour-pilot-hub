import Link from "next/link";
import { Receipt, Banknote, LayoutDashboard, User, Users, Briefcase, PieChart, Sparkles, PiggyBank, Trophy, ArrowLeftRight } from "lucide-react";

// Tab bar for the merged Finance page, styled to match CommsTabs: brand pill =
// active, bordered pill = idle. Which tabs render depends on the viewer's role —
// everything except Unpaid is owner-only — so the caller passes the allowed tabs.
// ("money" and "revenue" left the type Oct 20 2026, audit G11: the page maps
// those old ?tab= links to Overview before a FinanceTab is ever chosen.)
export type FinanceTab = "overview" | "personal" | "people" | "jobs" | "spending" | "unpaid" | "payroll" | "paystructure" | "advisor" | "budget" | "bonus";

const TABS: { key: FinanceTab; label: string; href: string; icon: typeof Receipt }[] = [
  { key: "overview", label: "Overview", href: "/sales?tab=overview", icon: LayoutDashboard },
  { key: "advisor", label: "Advisor", href: "/sales?tab=advisor", icon: Sparkles },
  { key: "jobs", label: "Jobs", href: "/sales?tab=jobs", icon: Briefcase },
  { key: "people", label: "People", href: "/sales?tab=people", icon: Users },
  { key: "personal", label: "Personal", href: "/sales?tab=personal", icon: User },
  { key: "budget", label: "Budget", href: "/sales?tab=budget", icon: PiggyBank },
  { key: "spending", label: "Categories", href: "/sales?tab=spending", icon: PieChart },
  // "money" and "revenue" retired Aug 25 (audit): Money was ~70% a copy of
  // Overview with never-used entry forms; Revenue was unreachable and reported
  // Aryeo-price numbers that contradicted every other surface.
  { key: "unpaid", label: "Unpaid", href: "/sales?tab=unpaid", icon: Receipt },
  { key: "payroll", label: "Payroll", href: "/sales?tab=payroll", icon: Banknote },
  // Oct 21 2026: old per-shoot pay against the new yearly pay (lib/paySavings.ts). Owner only.
  { key: "paystructure", label: "Pay structure", href: "/sales?tab=paystructure", icon: ArrowLeftRight },
  { key: "bonus", label: "Bonus", href: "/sales?tab=bonus", icon: Trophy },
];

// On a phone the ten pills used to wrap into three or four rows above every
// tab (audit G19); they now sit on one row that scrolls sideways, edge to edge
// inside the page's p-4 gutter, and wrap as before from sm up.
export function FinanceTabs({ tab, show }: { tab: FinanceTab; show: FinanceTab[] }) {
  const pill = "inline-flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium sm:min-h-0";
  const active = `${pill} bg-brand-action text-white`;
  const idle = `${pill} border border-border text-muted hover:bg-surface-2`;
  return (
    <div className="-mx-4 mb-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
      {TABS.filter((t) => show.includes(t.key)).map((t) => {
        const Icon = t.icon;
        return (
          <Link key={t.key} href={t.href} className={tab === t.key ? active : idle}>
            <Icon className="mr-1.5 inline size-3.5" />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
