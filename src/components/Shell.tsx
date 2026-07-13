"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { NotificationsBell } from "@/components/NotificationsBell";
import { Sidebar, type ShellUser } from "@/components/Sidebar";
import { FeedbackWidget } from "@/components/feedback/FeedbackWidget";
import { ViewAsBanner } from "@/components/ViewAsBanner";
import { cn } from "@/lib/utils";

// App chrome: a static sidebar on desktop (lg+), and a slide-in drawer with a
// hamburger top bar on mobile. Keeps the whole hub usable on a phone. On the
// auth pages (login / invite) it renders bare — no sidebar, no chrome.
export function Shell({ user, scriptingUrl, children }: { user: ShellUser | null; scriptingUrl?: string | null; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Count in-app navigations this session so back controls (BackLink) can tell a
  // real "previous page" from a cold deep link and route accordingly.
  useEffect(() => {
    try {
      sessionStorage.setItem("rtp_nav", String(Number(sessionStorage.getItem("rtp_nav") || "0") + 1));
    } catch {
      /* ignore */
    }
  }, [pathname]);

  // Usage beacon → the owner-only Activity trail. Identity comes from the
  // SESSION server-side; "view as" previews are skipped there too (belt) and
  // here (suspenders) so a preview never pollutes the previewed person's trail.
  useEffect(() => {
    if (!user || user.impersonating) return;
    if (pathname === "/login" || pathname.startsWith("/invite")) return;
    fetch("/api/activity", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pathname }),
    }).catch(() => { /* tracking must never break navigation */ });
    // Only re-fire on real path changes — user identity is stable per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const bare = pathname === "/login" || pathname.startsWith("/invite");

  if (bare) return <>{children}</>;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <Sidebar user={user} scriptingUrl={scriptingUrl} />
      </div>

      {/* Mobile drawer + backdrop. z must clear Leaflet map panes/controls
          (~z-index 1000), or the menu slides in *behind* the map on mobile. */}
      <div
        className={cn(
          "fixed inset-0 z-[1200] bg-black/60 transition-opacity lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-[1300] transition-transform duration-200 ease-out lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar user={user} scriptingUrl={scriptingUrl} onNavigate={() => setOpen(false)} />
      </div>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-border bg-surface/80 px-4 py-2.5 backdrop-blur-xl lg:hidden">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            className="flex size-9 items-center justify-center rounded-lg text-foreground/80 hover:bg-surface-2"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <div className="flex items-center gap-2">
            <div
              className="flex size-7 items-center justify-center rounded-lg text-[11px] font-bold text-white ring-1 ring-white/10"
              style={{ background: "linear-gradient(135deg, #f97316, #e96320 55%, #c2410c)" }}
            >
              RP
            </div>
            <span className="text-sm font-semibold tracking-tight">
              Real<span className="text-brand">Tour</span> Pilot
            </span>
          </div>
          <div className="ml-auto">
            <NotificationsBell variant="header" />
          </div>
        </header>

        {user?.impersonating && <ViewAsBanner name={user.name} />}
        <main className="flex-1 overflow-y-auto scroll-thin">{children}</main>
      </div>

      {/* Always-on feedback launcher (Kyle → review board) */}
      <FeedbackWidget />
    </div>
  );
}
