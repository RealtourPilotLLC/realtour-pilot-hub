import Link from "next/link";
import { UserCog, ShieldCheck } from "lucide-react";

// Tab bar for the merged People page (Team | Logins & access), styled to match
// CommsTabs. The Logins tab is owner-only, so the caller passes which tabs the
// viewer is allowed to see (admins see Team only).
export type PeopleTab = "team" | "logins";

const TABS: { key: PeopleTab; label: string; href: string; icon: typeof UserCog }[] = [
  { key: "team", label: "Team", href: "/users?tab=team", icon: UserCog },
  { key: "logins", label: "Logins & access", href: "/users?tab=logins", icon: ShieldCheck },
];

export function PeopleTabs({ tab, show }: { tab: PeopleTab; show: PeopleTab[] }) {
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
