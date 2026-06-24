"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListTodo,
  History,
  KanbanSquare,
  CalendarDays,
  MapPinned,
  MessageCircle,
  Users,
  UserCog,
  DollarSign,
  Wallet,
  Receipt,
  Package,
  Megaphone,
  Palette,
  BookOpen,
  Upload,
  MessageSquare,
  MessageSquarePlus,
  Plug,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  soon?: boolean;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const SECTIONS: NavSection[] = [
  {
    title: "Operations",
    items: [
      { label: "Dashboard", href: "/", icon: LayoutDashboard },
      { label: "Daily Tasks", href: "/queue", icon: ListTodo },
      { label: "Task History", href: "/history", icon: History },
      { label: "Project Tracker", href: "/pipeline", icon: KanbanSquare },
      { label: "Schedule", href: "/schedule", icon: CalendarDays },
      { label: "Map", href: "/map", icon: MapPinned },
      { label: "Communications", href: "/communications", icon: MessageCircle },
      { label: "Clients", href: "/clients", icon: Users },
      { label: "Team", href: "/team", icon: UserCog },
    ],
  },
  {
    title: "Creative",
    items: [
      { label: "Upload Portal", href: "/upload", icon: Upload },
      { label: "Editor Queue", href: "/editing", icon: Palette },
    ],
  },
  {
    title: "Sales & Finance",
    items: [
      { label: "Sales Tracker", href: "/sales", icon: DollarSign },
      { label: "Billing", href: "/billing", icon: Receipt },
      { label: "Service Catalog", href: "/catalog", icon: Package },
      { label: "Payouts", href: "/payouts", icon: Wallet },
    ],
  },
  {
    title: "Marketing",
    items: [{ label: "Campaigns", href: "/marketing", icon: Megaphone }],
  },
  {
    title: "Knowledge",
    items: [
      { label: "Resources & SOPs", href: "/resources", icon: BookOpen },
      { label: "Ask the Hub", href: "/assistant", icon: MessageSquare },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Feedback & requests", href: "/feedback", icon: MessageSquarePlus },
      { label: "Connections", href: "/connections", icon: Plug },
    ],
  },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface/95 backdrop-blur-xl lg:bg-surface/60">
      <div className="flex items-center gap-3 px-5 py-5">
        <div
          className="flex size-9 items-center justify-center rounded-xl text-sm font-bold text-white shadow-lg ring-1 ring-white/10"
          style={{ background: "linear-gradient(135deg, #f97316, #e96320 55%, #c2410c)" }}
        >
          RP
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">
            Real<span className="text-brand">Tour</span> Pilot
          </div>
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">Operations Hub</div>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto scroll-thin px-3 py-2">
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-2">
              {section.title}
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                const Icon = item.icon;
                const content = (
                  <>
                    <Icon className="size-4 shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    {item.soon && (
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-2">
                        soon
                      </span>
                    )}
                  </>
                );
                const classes = cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all",
                  active
                    ? "bg-brand-soft text-brand ring-1 ring-inset ring-brand/20"
                    : "text-foreground/65 hover:bg-surface-2 hover:text-foreground",
                  item.soon && "cursor-default opacity-60 hover:bg-transparent",
                );
                return item.soon ? (
                  <div key={item.href} className={classes} title="Coming in a later milestone">
                    {content}
                  </div>
                ) : (
                  <Link key={item.href} href={item.href} className={classes} onClick={onNavigate}>
                    {content}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t px-3 py-3">
        <Link
          href="/connections"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
        >
          <Settings className="size-4" />
          <span>Settings &amp; connections</span>
        </Link>
      </div>
    </aside>
  );
}
