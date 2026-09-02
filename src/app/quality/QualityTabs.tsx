import Link from "next/link";
import { Camera, MessageSquareHeart } from "lucide-react";
import { cn } from "@/lib/utils";

// The two halves of "feedback about the work": what CLIENTS said, and the
// quality signals on the PHOTOGRAPHERS who shot it. Plain links (server-safe)
// — the active tab comes from the page, not usePathname, so nothing here has
// to be a client component.
export type QualityTab = "clients" | "photographers";

export function QualityTabs({ active, counts }: {
  active: QualityTab;
  counts?: { clients?: number; photographers?: number };
}) {
  const tabs = [
    {
      key: "clients" as const, label: "Client feedback", href: "/quality?tab=clients", icon: MessageSquareHeart,
      count: counts?.clients, hint: "responses not yet marked handled",
    },
    {
      key: "photographers" as const, label: "Photographer feedback", href: "/quality?tab=photographers", icon: Camera,
      count: counts?.photographers, hint: "capture notes still open to fix",
    },
  ];
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
