"use client";

import { useEffect, useRef, useState } from "react";
import { isPublicRoute } from "@/lib/publicRoutes";
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
// Public routes come from the shared list so a new one can never be gated in
// middleware but still drawn with staff chrome (or the reverse).

// The Editor Queue opens the style guide in a 440px floating window; chrome
// inside that popup would be chrome inside chrome. Internal, not public — kept
// separate from the list above so the two reasons never get confused.
const BARE_EXACT = ["/resources/video-styles/embed"];

export function isBare(pathname: string): boolean {
  if (BARE_EXACT.includes(pathname)) return true;
  return isPublicRoute(pathname);
}

// App chrome: a static sidebar on desktop (lg+), and a slide-in drawer with a
// hamburger top bar on mobile. Keeps the whole hub usable on a phone. On the
// auth pages (login / invite) and every client-facing route it renders bare —
// no sidebar, no chrome (see isBare above).
export function Shell({ user, scriptingUrl, children }: { user: ShellUser | null; scriptingUrl?: string | null; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // THE CLOSED DRAWER WAS STILL IN THE PAGE (audit, Sep 18 2026). It is kept
  // mounted and slid off-screen with a transform, which moves it visually and
  // nothing else: every link in it stayed in the tab order and stayed readable
  // by a screen reader, so tabbing from the hamburger on a phone walked through
  // an invisible menu. `inert` takes the whole subtree out of the tab order,
  // out of the accessibility tree and out of hit-testing, while leaving the
  // transform free to animate.
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  function containDrawerFocus(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const links = [...(drawerRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((element) => element.getClientRects().length > 0);
    if (!links.length) { e.preventDefault(); return; }
    const first = links[0];
    const last = links[links.length - 1];
    if (e.shiftKey && (document.activeElement === first || !drawerRef.current?.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !drawerRef.current?.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  }

  // Escape closes it, as every dialog on the web does.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus follows the drawer: into it when it opens, back to the button that
  // opened it when it closes. Without the second half, closing the menu drops
  // focus onto <body> and the next Tab starts from the top of the document.
  useEffect(() => {
    if (open) drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    else if (document.activeElement && drawerRef.current?.contains(document.activeElement)) menuButtonRef.current?.focus();
  }, [open]);


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
      <a href="#staff-main" inert={open} className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[1400] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-lg">
        Skip to content
      </a>
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
        ref={drawerRef}
        id="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        inert={!open}
        onKeyDown={containDrawerFocus}
        className={cn(
          "fixed inset-y-0 left-0 z-[1300] flex flex-col transition-transform duration-200 ease-out lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <button type="button" onClick={() => setOpen(false)} className="ml-3 mt-3 inline-flex min-h-11 shrink-0 self-start items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
          <X className="size-4" /> Close menu
        </button>
        <div className="min-h-0 flex-1">
          <Sidebar user={user} scriptingUrl={scriptingUrl} onNavigate={() => setOpen(false)} />
        </div>
      </div>

      {/* Main column */}
      <div inert={open} className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-border bg-surface/80 px-4 py-2.5 backdrop-blur-xl lg:hidden">
          <button
            ref={menuButtonRef}
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav-drawer"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground/80 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
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
        <main id="staff-main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-x-none scroll-thin">{children}</main>
      </div>

      {/* Always-on feedback launcher (Kyle → review board) */}
      <div inert={open}><FeedbackWidget /></div>
    </div>
  );
}
