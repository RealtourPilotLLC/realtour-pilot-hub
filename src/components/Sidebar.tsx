"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListTodo,
  History,
  KanbanSquare,
  CalendarDays,
  Camera,
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
  GraduationCap,
  Upload,
  MessageSquare,
  MessageSquarePlus,
  Plug,
  LogOut,
  ShieldCheck,
  PenLine,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { canAccess, type PageKey } from "@/lib/auth/access";

export type ShellUser = {
  name: string | null;
  email: string;
  role: string;
  permissions?: string | null;
  impersonating?: boolean;
  realName?: string | null;
};

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  key?: PageKey; // internal pages carry a PageKey for role-gating
  soon?: boolean;
  external?: boolean; // opens in a new tab (e.g. the Script Studio app)
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const SECTIONS: NavSection[] = [
  {
    title: "Operations",
    items: [
      { label: "Dashboard", href: "/", icon: LayoutDashboard, key: "dashboard" },
      { label: "Daily Tasks", href: "/queue", icon: ListTodo, key: "tasks" },
      { label: "Task History", href: "/history", icon: History, key: "history" },
      { label: "Project Tracker", href: "/pipeline", icon: KanbanSquare, key: "pipeline" },
      { label: "Schedule", href: "/schedule", icon: CalendarDays, key: "schedule" },
      { label: "Map", href: "/map", icon: MapPinned, key: "map" },
      { label: "Communications", href: "/communications", icon: MessageCircle, key: "communications" },
      { label: "Clients", href: "/clients", icon: Users, key: "clients" },
      { label: "Team", href: "/team", icon: UserCog, key: "team" },
    ],
  },
  {
    title: "Creative",
    items: [
      { label: "My Shoots", href: "/shoot", icon: Camera, key: "shoot" },
      { label: "Upload Portal", href: "/upload", icon: Upload, key: "upload" },
      { label: "Editor Queue", href: "/editing", icon: Palette, key: "editing" },
    ],
  },
  {
    title: "Sales & Finance",
    items: [
      { label: "Sales Tracker", href: "/sales", icon: DollarSign, key: "sales" },
      { label: "Billing", href: "/billing", icon: Receipt, key: "billing" },
      { label: "Service Catalog", href: "/catalog", icon: Package, key: "catalog" },
      { label: "Payouts", href: "/payouts", icon: Wallet, key: "payouts" },
    ],
  },
  {
    title: "Marketing",
    items: [{ label: "Marketing", href: "/marketing", icon: Megaphone, key: "marketing" }],
  },
  {
    title: "Knowledge",
    items: [
      { label: "Resources & SOPs", href: "/resources", icon: BookOpen, key: "resources" },
      { label: "Training", href: "/training", icon: GraduationCap, key: "training" },
      { label: "Ask the Hub", href: "/assistant", icon: MessageSquare, key: "assistant" },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Feedback & requests", href: "/feedback", icon: MessageSquarePlus, key: "feedback" },
      { label: "Users", href: "/users", icon: ShieldCheck, key: "users" },
      { label: "Connections", href: "/connections", icon: Plug, key: "connections" },
    ],
  },
];

const ROLE_LABEL: Record<string, string> = { OWNER: "Owner", ADMIN: "Admin", EDITOR: "Editor", PHOTOGRAPHER: "Photographer" };

export function Sidebar({ user, scriptingUrl, onNavigate }: { user?: ShellUser | null; scriptingUrl?: string | null; onNavigate?: () => void }) {
  const pathname = usePathname();
  // When signed in, hide pages this person can't open. When not signed in (gate
  // still off, pre-cutover), show everything so the open app is unchanged.
  const can = (item: NavItem) => (item.key ? !user || canAccess(user, item.key) : true);
  // External link to the Script Studio app — owner/admin only, and only when it's
  // configured (SCRIPTING_BASE_URL set). Injected into the Creative section.
  const showScripting = !!scriptingUrl && (!user || user.role === "OWNER" || user.role === "ADMIN");
  const sections = SECTIONS.map((s) => {
    let items = s.items.filter(can);
    if (showScripting && s.title === "Creative") {
      items = [...items, { label: "Script Writing", href: scriptingUrl!, icon: PenLine, external: true }];
    }
    return { ...s, items };
  }).filter((s) => s.items.length > 0);

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
        {sections.map((section) => (
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
                    {item.external && <ExternalLink className="size-3.5 shrink-0 text-muted-2" />}
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
                ) : item.external ? (
                  <a key={item.href} href={item.href} target="_blank" rel="noopener noreferrer" className={classes} onClick={onNavigate}>
                    {content}
                  </a>
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

      <div className="space-y-1 border-t px-3 py-3">
        {/* Connections lives in the System nav section — no duplicate here. */}
        {user && (
          <div className="mt-1 flex items-center gap-2 rounded-lg bg-surface-2/60 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{user.name || user.email}</div>
              <div className="text-[11px] text-muted-2">{ROLE_LABEL[user.role] ?? user.role}</div>
            </div>
            <form action="/api/auth/logout" method="post">
              <button type="submit" title="Sign out" className="flex size-8 items-center justify-center rounded-lg text-muted-2 hover:bg-surface-2 hover:text-foreground">
                <LogOut className="size-4" />
              </button>
            </form>
          </div>
        )}
      </div>
    </aside>
  );
}
