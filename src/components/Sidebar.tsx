"use client";

import Link from "next/link";
import { BrandWordmark } from "@/components/Brand";
import { usePathname } from "next/navigation";
import {
  Clapperboard,
  SlidersHorizontal,
  LayoutDashboard,
  ListTodo,
  CalendarDays,
  Camera,
  MessageCircle,
  Users,
  DollarSign,
  TrendingUp,
  Wallet,
  Palette,
  BookOpen,
  GraduationCap,
  Upload,
  MessageSquare,
  MessageSquareHeart,
  MessageSquarePlus,
  MonitorPlay,
  IdCard,
  Plug,
  LogOut,
  PenLine,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { canAccess, parsePermissions, ROLE_LABEL, type PageKey } from "@/lib/auth/access";
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
      // ONE HOME PER ROLE (Jordan, Sep 2: "I want the ops day screen essentially
      // combined with my dashboard"). "/" is now the merged morning screen —
      // what needs you today, the Ops Day time blocks with their live contents,
      // today's shoots, the owner's own list, then the money. Three nav items
      // retired into it:
      //   · Ops Day (/ops)          — the whole screen moved here; the route is
      //                               a redirect stub so every #block link and
      //                               ADMIN's homeFor("/ops") still land right.
      //   · My Day (/day)           — the owner's to-dos + business money are
      //                               the "Your list" and money sections here.
      //   · Project Tracker (/pipeline) — the delivery board is the Production
      //                               Pipeline block here.
      // The /day and /pipeline ROUTES are untouched and still reachable by URL
      // (and /projects/[id] still links back to the tracker) — nothing in this
      // hub is deleted for being off the menu, it just stops competing to be
      // the home screen.
      { label: "Home", href: "/", icon: LayoutDashboard, key: "dashboard" },
      // Today + Daily Tasks + Task History merged into the one Tasks hub
      // (tabs: Today / Board / Done) — Jordan: "the toolbar has too many things".
      { label: "Tasks", href: "/tasks", icon: ListTodo, key: "tasks" },
      // The owner's quality desk — cuts to review, photo QC, feedback loops.
      { label: "Review Room", href: "/review", icon: MonitorPlay, key: "review" },
      // Feedback about the WORK: what clients said (the delivery-text form +
      // unhappy texts/emails) and how each photographer is shooting. Distinct
      // from "Feedback & requests" in System, which is feedback about the HUB.
      // It rides the `review` PageKey the same way Style Guide rides
      // `resources`: identical audience (owner + admin; creatives read their
      // own results on /shoot/feedback), so no new permission to grant and a
      // per-user `review` override carries here too.
      { label: "Client & Team Feedback", href: "/quality", icon: MessageSquareHeart, key: "review" },
      // "Project Tracker" (/pipeline) retired from the nav — its delivery board
      // is the Production Pipeline block on Home. Route + PageKey stay.
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
      { label: "People", href: "/users", icon: IdCard, key: "users" },
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
      // Editors/admin/owner only — it is the video-editing reference, pure
      // clutter in a field shooter's small menu (audit).
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
      // Service Catalog folded into Resources (audit: zero opens in all
      // recorded history as a top-level door; the page itself stays reachable
      // from the Resources page).
      { label: "Training", href: "/training", icon: GraduationCap, key: "training" },
      { label: "Ask the Hub", href: "/assistant", icon: MessageSquare, key: "assistant" },
    ],
  },
  {
    title: "System",
    items: [
      // The HUB's own board — features to build, bugs to fix. Every role files
      // here. Feedback about the WORK is "Client & Team Feedback" in Operations.
      { label: "Feedback & requests", href: "/feedback", icon: MessageSquarePlus, key: "feedback" },
      { label: "Settings", href: "/settings", icon: SlidersHorizontal, key: "settings" },
      { label: "Connections", href: "/connections", icon: Plug, key: "connections" },
    ],
  },
];


export function Sidebar({ user, scriptingUrl, onNavigate }: { user?: ShellUser | null; scriptingUrl?: string | null; onNavigate?: () => void }) {
  const pathname = usePathname();
  // When signed in, hide pages this person can't open. When not signed in (gate
  // still off, pre-cutover), show everything so the open app is unchanged.
  const can = (item: NavItem) => (item.key ? !user || canAccess(user, item.key) : true);
  // External link to the Script Studio app — owner/admin only, and only when it's
  // configured (SCRIPTING_BASE_URL set). Injected into the Creative section.
  // Owner-only — the blanket-ADMIN external link put a scripting product Kyle
  // never uses in his menu (audit; a per-user grant needs a real PageKey first).
  const showScripting = !!scriptingUrl && (!user || user.role === "OWNER");
  // Creatives see /resources as a pure "SOP Center" (no forms/quick links), so
  // the nav label matches what the page actually is for them.
  const creative = !!user && (user.role === "EDITOR" || user.role === "PHOTOGRAPHER");
  // Parsed ONCE per render (was re-parsed twice per section — audit).
  const perms = parsePermissions(user?.permissions);
  const sections = SECTIONS.map((s) => {
    let items = s.items.filter(can);
    // Match on href, not key: the Creative "Style Guide" item also carries the
    // `resources` key (it rides that permission) and must keep its own label.
    if (creative) items = items.map((i) => (i.href === "/resources" ? { ...i, label: "SOP Center" } : i));
    // Style Guide is the video-editing reference — photographers don't need it.
    if (user && user.role === "PHOTOGRAPHER") items = items.filter((i) => i.href !== "/resources/video-styles");
    // "My Pay" is a person's own payout view. Photographers always have it;
    // owner/admin see it ONLY with an explicit mypay:true override (James:
    // admin powers for the creative-manager role, his own pay visible, the
    // company financials blocked). The blanket role filter here was eating
    // the override (Aug 24).
    const mypayGranted = "mypay" in perms && perms.mypay;
    if (user && user.role !== "PHOTOGRAPHER" && !mypayGranted) items = items.filter((i) => i.key !== "mypay");
    if (showScripting && s.title === "Creative") {
      items = [...items, { label: "Script Writing", href: scriptingUrl!, icon: PenLine, external: true }];
    }
    return { ...s, items };
  }).filter((s) => s.items.length > 0);

  return (
    // relative: the notification-bell panel anchors to the sidebar (opens upward).
    <aside className="relative flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface/95 backdrop-blur-xl lg:bg-surface/60">
      <div className="flex items-center gap-3 px-5 py-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
<img src="/brand/mark.svg" alt="RealTour Pilot" className="flex size-9 rounded-xl shadow-lg bg-white p-1" />
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">
            <BrandWordmark className="h-4" />
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
        {user ? (
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
        ) : (
          // No session (open local dev): the theme switch must not vanish with
          // the user chip — light/dark is a device preference, not an account one.
          <div className="mt-1 flex justify-end px-1">
            <ThemeToggle />
          </div>
        )}
      </div>
    </aside>
  );
}
