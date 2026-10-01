import Link from "next/link";
import { UserCog, ShieldCheck, Activity } from "lucide-react";

// Tab bar for the merged People page (Team | Logins & access | Activity),
// styled to match CommsTabs. Logins + Activity are owner-only, so the caller
// passes which tabs the viewer is allowed to see (admins see Team only).
export type PeopleTab = "team" | "logins" | "activity";

const TABS: { key: PeopleTab; label: string; href: string; icon: typeof UserCog }[] = [
  { key: "team", label: "Team", href: "/users?tab=team", icon: UserCog },
  { key: "logins", label: "Logins & access", href: "/users?tab=logins", icon: ShieldCheck },
  { key: "activity", label: "Activity", href: "/users?tab=activity", icon: Activity },
];

export function PeopleTabs({ tab, show }: { tab: PeopleTab; show: PeopleTab[] }) {
  const base = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
  const active = `${base} border-transparent bg-brand-action text-brand-fg`;
  const idle = `${base} border-border-strong text-foreground hover:bg-surface-2`;
  return (
    <nav aria-label="People sections" className="mb-4 flex flex-wrap items-center gap-2">
      {TABS.filter((t) => show.includes(t.key)).map((t) => {
        const Icon = t.icon;
        return (
          <Link key={t.key} href={t.href} aria-current={tab === t.key ? "page" : undefined} className={tab === t.key ? active : idle}>
            <Icon aria-hidden className="size-4 shrink-0" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
