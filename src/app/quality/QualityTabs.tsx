import Link from "next/link";
import { Camera, Clapperboard, MessageSquareHeart } from "lucide-react";
import { cn } from "@/lib/utils";

// The halves of "feedback about the work": what CLIENTS said, the quality
// signals on the PHOTOGRAPHERS who shot it, and (§8.4, Sep 25) how each
// EDITOR's versions fare in review. Plain links (server-safe) — the active tab
// comes from the page, not usePathname, so nothing here has to be a client
// component. `only` narrows the bar for a viewer who may see one tab (an
// editor sees their own review results and nothing else here).
export type QualityTab = "clients" | "photographers" | "editors";

export function QualityTabs({ active, counts, only }: {
  active: QualityTab;
  counts?: { clients?: number; photographers?: number; editors?: number };
  only?: QualityTab[];
}) {
  const all = [
    {
      key: "clients" as const, label: "Client feedback", href: "/quality?tab=clients", icon: MessageSquareHeart,
      count: counts?.clients, hint: "responses not yet marked handled",
    },
    {
      key: "photographers" as const, label: "Photographer feedback", href: "/quality?tab=photographers", icon: Camera,
      count: counts?.photographers, hint: "capture notes still open to fix",
    },
    {
      key: "editors" as const, label: "Editor quality", href: "/quality?tab=editors", icon: Clapperboard,
      count: counts?.editors, hint: "revision issues waiting on a cause",
    },
  ];
  const tabs = only ? all.filter((t) => only.includes(t.key)) : all;
  return (
    <div className="mb-4 flex items-center gap-1 rounded-2xl border bg-surface p-1">
      {tabs.map((t) => {
        const is = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={is ? "page" : undefined}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
              is ? "bg-brand-soft text-brand" : "text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            <t.icon className="size-4" /> {t.label}
            {(t.count ?? 0) > 0 && (
              <span
                title={`${t.count} ${t.hint}`}
                className={cn("rounded-full px-1.5 text-[11px] font-semibold", is ? "bg-brand/15 text-brand" : "bg-surface-2 text-muted")}
              >
                {t.count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
