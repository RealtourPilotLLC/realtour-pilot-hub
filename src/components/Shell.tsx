"use client";

import { useEffect, useState } from "react";
import { BrandWordmark } from "@/components/Brand";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { NotificationsBell } from "@/components/NotificationsBell";
import { Sidebar, type ShellUser } from "@/components/Sidebar";
import { FeedbackWidget } from "@/components/feedback/FeedbackWidget";
import { ViewAsBanner } from "@/components/ViewAsBanner";
import { cn } from "@/lib/utils";

// Routes that render with NO app chrome. Kept as a list (not an inline `||`
// chain) so it reads next to middleware's PUBLIC_PREFIXES and a missing entry
// is obvious. A prefix matches the path itself and anything under it, on a
// segment boundary — "/portal" and "/portal/<token>" match, "/portals" doesn't.
const BARE_PREFIXES = [
  "/login",
  "/invite", // token-link account setup, opened before a session exists
  "/learn", // public training-lesson share link
  "/portal", // THE CLIENT HUB — a client's only view of us
  "/privacy",
  "/terms", // public legal pages OAuth reviewers open signed out
];

// The Editor Queue opens the style guide in a 440px floating window; chrome
// inside that popup would be chrome inside chrome. Internal, not public — kept
// separate from the list above so the two reasons never get confused.
const BARE_EXACT = ["/resources/video-styles/embed"];

export function isBare(pathname: string): boolean {
  if (BARE_EXACT.includes(pathname)) return true;
  if (BARE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  // The client-facing feedback form is /feedback/<projectId> (one segment); the
  // bare /feedback board is the INTERNAL request board and keeps its chrome.
  // Same rule as isPublic() in src/middleware.ts.
  if (/^\/feedback\/[^/]+$/.test(pathname)) return true;
  return false;
}

// App chrome: a static sidebar on desktop (lg+), and a slide-in drawer with a
// hamburger top bar on mobile. Keeps the whole hub usable on a phone. On the
// auth pages (login / invite) and every client-facing route it renders bare —
// no sidebar, no chrome (see isBare above).
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

  // Bare (no sidebar, no bell, no feedback widget, nothing that links into the
  // hub): every route a signed-OUT visitor can open. Clients only ever see two
  // of these — the content portal and the post-delivery feedback form — and an
  // audit (Sep 2) caught BOTH shipping the entire staff sidebar in their HTML:
  // 21 hub links including /sales, /my-pay, /users and /connections, plus the
  // "Send feedback" staff widget floating on top at z-1400. The pages each try
  // to hide it with a `fixed inset-0 z-50` cover, which the widget and the
  // mobile drawer sit above and which does nothing for view-source or a screen
  // reader. Chrome has to be absent, not covered — so it is decided here.
  //
  // THIS LIST MIRRORS `PUBLIC_PREFIXES` / `isPublic()` IN src/middleware.ts —
  // same prefixes, same one-segment /feedback rule. A new public route must be
  // added to both: middleware decides who may load it, this decides what they
  // see once it loads.
  const bare = isBare(pathname);

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
            {/* eslint-disable-next-line @next/next/no-img-element */}
<img src="/brand/mark.svg" alt="RealTour Pilot" className="flex size-7 rounded-lg bg-white p-1" />
            <span className="text-sm font-semibold tracking-tight">
              <BrandWordmark className="h-4" />
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
