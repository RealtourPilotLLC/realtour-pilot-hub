import Link from "next/link";
import { Inbox, Mail, MessageCircle, Reply, Send, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MESSAGES_TABS, messagesHref, type MessagesTab } from "@/components/comms/messagesNav";

// The tab bar of Messages. Each tab's number lives here and only here: the
// view under it does not print the same count again in its header or its
// section titles. A number is left off when it is zero, or when it would cost
// a read the current view does not need (Email's "new in the last two days"
// comes from the email view's own query).

const ICON: Record<MessagesTab, LucideIcon> = {
  waiting: Inbox,
  texts: Reply,
  email: Mail,
  team: Users,
  outbox: Send,
  all: MessageCircle,
};

export type TabCount = { n: number; tone?: "danger" | "brand" };

export function MessagesTabs({ tab, counts, test = false }: { tab: MessagesTab; counts: Partial<Record<MessagesTab, TabCount>>; test?: boolean }) {
  return (
    <nav aria-label="Messages views" className="mb-4 flex flex-wrap items-center gap-1.5">
      {MESSAGES_TABS.map((t) => {
        const Icon = ICON[t.key];
        const active = t.key === tab;
        const c = counts[t.key];
        return (
          <Link
            key={t.key}
            href={messagesHref(t.key, { test })}
            title={t.title}
            aria-current={active ? "page" : undefined}
            data-tab={t.key}
            className={cn(
              "inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium",
              active ? "bg-brand-action text-white" : "border border-border text-muted hover:bg-surface-2",
            )}
          >
            <Icon aria-hidden className="mr-1.5 size-3.5" />
            {t.label}
            {c && c.n > 0 && (
              <span
                data-count={t.key}
                className={cn(
                  "ml-1.5 rounded-full px-1.5 text-xs font-semibold tabular-nums",
                  active ? "bg-white/20" : c.tone === "danger" ? "bg-danger-soft text-danger" : "bg-brand/15 text-brand",
                )}
              >
                {c.n}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
