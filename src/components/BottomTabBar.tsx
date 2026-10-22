"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Camera, Clapperboard, LayoutDashboard, Menu, MonitorPlay, Palette, Trophy, Upload, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { canAccess, type PageKey } from "@/lib/auth/access";
import { activeSidebarHref } from "@/lib/sidebarNavigation";
import type { ShellUser } from "@/components/Sidebar";

// ---------------------------------------------------------------------------
// THE PHONE TAB BAR (Oct 22 2026, Jordan's approved menus). The two people who
// work the hub from a phone, the creative manager and the photographers, get
// their four most used doors as a bar at the bottom of the screen, plus Menu
// for everything else (the drawer). Phones only (the desktop sidebar shows
// the same doors); a tab is drawn only when Sidebar's access rule would show
// its door, so nothing here is a door that bounces.
//
// It sits in the main column BELOW the scrolling <main>, not over it: the
// frame is the visible screen (Shell, h-dvh), so the bar never covers the
// last row of a page and needs no padding guess. The home indicator's inset
// is added under it.
// ---------------------------------------------------------------------------

type Tab = { href: string; label: string; icon: LucideIcon; key: PageKey };

const CREATIVE_TABS: Tab[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, key: "dashboard" },
  { href: "/review", label: "Videos", icon: MonitorPlay, key: "review" },
  { href: "/editing", label: "Editing", icon: Palette, key: "editing" },
  { href: "/upload", label: "Uploads", icon: Upload, key: "upload" },
];

const FIELD_TABS: Tab[] = [
  { href: "/shoot", label: "My Shoots", icon: Camera, key: "shoot" },
  { href: "/upload", label: "Upload", icon: Upload, key: "upload" },
  { href: "/review", label: "My Videos", icon: Clapperboard, key: "review" },
  { href: "/my-pay", label: "Performance", icon: Trophy, key: "mypay" },
];

/** The tabs for this login, or null when it has no bar (owner, office, editors). */
export function bottomTabsFor(user: ShellUser | null | undefined): Tab[] | null {
  if (!user) return null;
  const tabs = user.role === "CREATIVE_MANAGER" ? CREATIVE_TABS : user.role === "PHOTOGRAPHER" ? FIELD_TABS : null;
  if (!tabs) return null;
  const shown = tabs.filter((t) => canAccess(user, t.key));
  return shown.length >= 2 ? shown : null;
}

export function BottomTabBar({ user, onMenu, menuOpen }: { user: ShellUser | null; onMenu: () => void; menuOpen: boolean }) {
  const pathname = usePathname();
  const tabs = bottomTabsFor(user);
  if (!tabs) return null;
  const active = activeSidebarHref(tabs, pathname);
  const cell = "flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand";
  return (
    <nav aria-label="Quick links" className="shrink-0 border-t border-border bg-surface/95 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
      <div className="flex items-stretch">
        {tabs.map((t) => {
          const on = active === t.href;
          const Icon = t.icon;
          return (
            <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined} className={cn(cell, on ? "text-brand" : "text-muted hover:text-foreground")}>
              <Icon aria-hidden className="size-5" />
              <span className="max-w-full truncate">{t.label}</span>
            </Link>
          );
        })}
        <button type="button" onClick={onMenu} aria-expanded={menuOpen} aria-controls="mobile-nav-drawer" className={cn(cell, "text-muted hover:text-foreground")}>
          <Menu aria-hidden className="size-5" />
          <span>Menu</span>
        </button>
      </div>
    </nav>
  );
}
