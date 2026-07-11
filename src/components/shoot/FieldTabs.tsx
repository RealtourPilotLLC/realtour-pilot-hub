import Link from "next/link";
import { Camera, MessageSquareHeart } from "lucide-react";
import { cn } from "@/lib/utils";

// The field platform's two surfaces: the shoots list and the quality-feedback
// hub. Plain links (server-safe) — highlighting comes from the page rendering
// it, not usePathname. `asId` carries an owner/admin "?as=" preview through.
export function FieldTabs({ active, asId, feedbackCount }: {
  active: "shoots" | "feedback";
  asId?: string | null;
  feedbackCount?: number;
}) {
  const suffix = asId ? `?as=${asId}` : "";
  const tabs = [
    { key: "shoots" as const, label: "Shoots", href: `/shoot${suffix}`, icon: Camera },
    { key: "feedback" as const, label: "Quality feedback", href: `/shoot/feedback${suffix}`, icon: MessageSquareHeart },
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
            {t.key === "feedback" && (feedbackCount ?? 0) > 0 && (
              <span className="rounded-full bg-warning/15 px-1.5 text-[11px] font-semibold text-warning">
                {feedbackCount}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
