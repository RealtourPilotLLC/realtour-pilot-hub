"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Clapperboard,
  SlidersHorizontal,
  LayoutDashboard,
  Sun,
  ListTodo,
  KanbanSquare,
  CalendarDays,
  Camera,
  MessageCircle,
  Users,
  DollarSign,
  TrendingUp,
  Wallet,
  Package,
  Palette,
  BookOpen,
  GraduationCap,
  Upload,
  MessageSquare,
  MessageSquarePlus,
  MonitorPlay,
  Plug,
  LogOut,
  PenLine,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { canAccess, type PageKey } from "@/lib/auth/access";
import { NotificationsBell } from "@/components/NotificationsBell";
import { ThemeToggle } from "@/components/ThemeToggle";

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
      // Owner-only (ownerOnly in PAGES) — his day plan and personal to-dos.
      { label: "My Day", href: "/day", icon: Sun, key: "day" },
      // Today + Daily Tasks + Task History merged into the one Tasks hub
      // (tabs: Today / Board / Done) — Jordan: "the toolbar has too many things".
      { label: "Tasks", href: "/tasks", icon: ListTodo, key: "tasks" },
      // The owner's quality desk — cuts to review, photo QC, feedback loops.
      { label: "Review Room", href: "/review", icon: MonitorPlay, key: "review" },
      { label: "Project Tracker", href: "/pipeline", icon: KanbanSquare, key: "pipeline" },
      // Schedule now carries the Map as its ?view=map tab (List | Map toggle in
      // the header), so the standalone "Map" item is gone — one appointment
      // window, two views that can't drift apart.
      { label: "Schedule", href: "/schedule", icon: CalendarDays, key: "schedule" },
      { label: "Communications", href: "/communications", icon: MessageCircle, key: "communications" },
      // Client Assets is a TAB on the Clients page (header action), not a nav
      // item — Jordan: "client assets should be in the clients tab".
      { label: "Clients", href: "/clients", icon: Users, key: "clients" },
      { label: "Content Program", href: "/content", icon: Clapperboard, key: "content" },
      // People = the merged Team (workload cards, admin-visible) + Logins &
      // access (AppUser allowlist, owner-only) hub. Lives in Operations next to
      // Clients — both are "who we work with" directories, and it reads cleaner
      // here than buried in System. The old System "Users" item is gone.
      { label: "People", href: "/users", icon: Users, key: "users" },
    ],
  },
  {
    title: "Creative",
    items: [
      { label: "My Shoots", href: "/shoot", icon: Camera, key: "shoot" },
      { label: "My Pay", href: "/my-pay", icon: Wallet, key: "mypay" },
      { label: "Upload Portal", href: "/upload", icon: Upload, key: "upload" },
      { label: "Editor Queue", href: "/editing", icon: Palette, key: "editing" },
      // The editors' reference: video types, style specs, example players,
      // music + tools. Jordan: "everything all in one spot for the editors."
      // Rides the `resources` PageKey (every role has it), so no new
      // permission — the page lives at /resources/video-styles and middleware
      // already resolves that path to `resources`.
      { label: "Style Guide", href: "/resources/video-styles", icon: Clapperboard, key: "resources" },
    ],
  },
  {
    // Finance = Revenue (old Sales Tracker) + Unpaid (old Billing) + Payroll
    // (old Payouts) as one page's tabs. The three-item "Sales & Finance" section
    // collapses to a single item. Service Catalog moved out to Knowledge (it's a
    // price reference, not money that moves). Marketing is retired from the nav
    // entirely (coming-soon stub) — re-add a { label: "Marketing", href:
    // "/marketing", icon: Megaphone, key: "marketing" } item here once social
    // scheduling actually ships; the /marketing route stays reachable meanwhile.
    title: "Finance",
    items: [
      { label: "Finance", href: "/sales", icon: DollarSign, key: "sales" },
      { label: "Trends", href: "/trends", icon: TrendingUp, key: "trends" },
    ],
  },
  {
    title: "Knowledge",
    items: [
      { label: "Resources & SOPs", href: "/resources", icon: BookOpen, key: "resources" },
      // Service Catalog is a static price reference — knowledge, not finance.
      { label: "Service Catalog", href: "/catalog", icon: Package, key: "catalog" },
      { label: "Training", href: "/training", icon: GraduationCap, key: "training" },
      { label: "Ask the Hub", href: "/assistant", icon: MessageSquare, key: "assistant" },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Feedback & requests", href: "/feedback", icon: MessageSquarePlus, key: "feedback" },
      { label: "Settings", href: "/settings", icon: SlidersHorizontal, key: "settings" },
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
  // Creatives see /resources as a pure "SOP Center" (no forms/quick links), so
  // the nav label matches what the page actually is for them.
  const creative = !!user && (user.role === "EDITOR" || user.role === "PHOTOGRAPHER");
  const sections = SECTIONS.map((s) => {
    let items = s.items.filter(can);
    // Match on href, not key: the Creative "Style Guide" item also carries the
    // `resources` key (it rides that permission) and must keep its own label.
    if (creative) items = items.map((i) => (i.href === "/resources" ? { ...i, label: "SOP Center" } : i));
    // "My Pay" is the photographer's own payout view — owner/admin use /payouts,
    // so keep it out of their nav even though canAccess(OWNER) allows everything.
    if (user && user.role !== "PHOTOGRAPHER") items = items.filter((i) => i.key !== "mypay");
    if (showScripting && s.title === "Creative") {
      items = [...items, { label: "Script Writing", href: scriptingUrl!, icon: PenLine, external: true }];
    }
    return { ...s, items };
  }).filter((s) => s.items.length > 0);

  return (
    // relative: the notification-bell panel anchors to the sidebar (opens upward).
    <aside className="relative flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface/95 backdrop-blur-xl lg:bg-surface/60">
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
                // Longest-prefix wins: "Style Guide" (/resources/video-styles)
                // and "Resources & SOPs" (/resources) share a prefix, and both
                // lighting up reads as a bug. The item is active only if no
                // sibling nav item matches the path more specifically.
                const matches = (href: string) =>
                  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
                const active =
                  matches(item.href) &&
                  !sections.some((sec) =>
                    sec.items.some(
                      (o) => o.href.length > item.href.length && matches(o.href),
                    ),
                  );
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
            <ThemeToggle />
            <NotificationsBell />
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
