import Link from "next/link";
import { TrendingUp, Receipt, Banknote, Wallet, LayoutDashboard, User, Users, Briefcase } from "lucide-react";

// Tab bar for the merged Finance page, styled to match CommsTabs: brand pill =
// active, bordered pill = idle. Which tabs render depends on the viewer's role —
// everything except Unpaid is owner-only — so the caller passes the allowed tabs.
export type FinanceTab = "overview" | "money" | "personal" | "people" | "jobs" | "revenue" | "unpaid" | "payroll";

const TABS: { key: FinanceTab; label: string; href: string; icon: typeof Receipt }[] = [
  { key: "overview", label: "Overview", href: "/sales?tab=overview", icon: LayoutDashboard },
  { key: "jobs", label: "Jobs", href: "/sales?tab=jobs", icon: Briefcase },
  { key: "people", label: "People", href: "/sales?tab=people", icon: Users },
  { key: "personal", label: "Personal", href: "/sales?tab=personal", icon: User },
  { key: "money", label: "Money", href: "/sales?tab=money", icon: Wallet },
  { key: "revenue", label: "Revenue", href: "/sales", icon: TrendingUp },
  { key: "unpaid", label: "Unpaid", href: "/sales?tab=unpaid", icon: Receipt },
  { key: "payroll", label: "Payroll", href: "/sales?tab=payroll", icon: Banknote },
];

export function FinanceTabs({ tab, show }: { tab: FinanceTab; show: FinanceTab[] }) {
  const active = "rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white";
  const idle = "rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2";
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
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
