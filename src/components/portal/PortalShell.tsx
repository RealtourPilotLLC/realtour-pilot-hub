import Link from "next/link";
import { BrandWordmark } from "@/components/Brand";
import {
  BookOpen, CalendarClock, Clapperboard, ClipboardList, Eye, Home, KeyRound, MessageSquare, MoreHorizontal, Palette, PauseCircle, ScrollText, Settings, type LucideIcon,
} from "lucide-react";
import type { ReadOnlyNotice } from "@/lib/portal";
import { primaryDestOf, type NavItem, type PortalDest } from "@/lib/portalNav";
import { CountBadge } from "@/components/portal/ui";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE v2 PORTAL FRAME (UI-01, Sep 24 2026): header, notices and navigation
// around whichever destination PortalPage renders. Server-only markup — no
// client state, so nothing can be left "open" and nothing needs JS to work.
//
//   phone (<640px)   a fixed bottom bar, Home · Plan · Library · Schedule ·
//                    More, each 48px tall with an icon, a word and a count;
//   tablet           the same five as a segmented bar under the header;
//   desktop (≥1024)  a compact left rail: the four, then More's pages listed
//                    inline so nothing on a wide screen hides behind a click.
//
// Every link is query-only (portalNav.portalHref) and every control shows a
// focus ring. Content never scrolls sideways at 375px: the columns are
// min-w-0 and long words break.
// ---------------------------------------------------------------------------

const ICON: Record<PortalDest, LucideIcon> = {
  home: Home, plan: ClipboardList, library: Clapperboard, schedule: CalendarClock, more: MoreHorizontal,
  brand: Palette, messages: MessageSquare, resources: BookOpen, team: Settings, terms: ScrollText,
};
const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
type Linked = NavItem & { href: string };

export type ShellNotices = {
  readOnly: ReadOnlyNotice | null;
  /** Staff looking through the owner iframe; `exitHref` when this is a ?layout=v2 preview. */
  staff: { who: string; clientName: string; exitHref: string | null } | null;
  offerSignIn: boolean;
  viewOnlySeat: boolean;
};

export function PortalShell({ clientName, dest, nav, notices, footer, children }: {
  clientName: string | null;
  dest: PortalDest;
  nav: { primary: Linked[]; more: Linked[] };
  notices: ShellNotices;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const active = primaryDestOf(dest);
  const rail = nav.primary.filter((i) => i.dest !== "more");
  return (
    // The Shell renders /portal bare (isBare in src/components/Shell.tsx); this
    // full-viewport layer is the portal's own scroll surface.
    <div className="portal-light fixed inset-0 z-50 overflow-y-auto overflow-x-hidden bg-background text-foreground">
      <a href="#portal-main" className="sr-only rounded-lg bg-surface px-3 py-2 text-sm font-semibold focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-30 focus:shadow">Skip to content</a>
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 h-72" style={{ background: "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--brand) 14%, transparent), transparent 70%)" }} />
      <div className="relative mx-auto max-w-3xl px-4 pb-28 sm:px-6 sm:pb-24 lg:grid lg:max-w-5xl lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-x-8 lg:pb-16">
        {/* BRAND + NAME */}
        <header className="flex items-center gap-3 pt-4 sm:pt-6 lg:col-span-2">
          <BrandWordmark variant="onLight" className="h-5 sm:h-6" />
          <div className="ml-auto min-w-0 text-right">
            <div className="truncate text-sm font-semibold leading-tight">{clientName}</div>
            <div className="text-[11px] text-muted-2">Content Program</div>
          </div>
        </header>

        {/* DESKTOP RAIL */}
        <nav aria-label="Portal sections" className="hidden lg:block">
          <div className="sticky top-6 mt-6 space-y-1">
            {rail.map((i) => <RailLink key={i.dest} i={i} active={active === i.dest} />)}
            <div className="px-3 pb-1 pt-5 text-[10px] font-semibold uppercase tracking-widest text-muted-2">More</div>
            {nav.more.map((i) => <RailLink key={i.dest} i={i} active={dest === i.dest} small />)}
          </div>
        </nav>

        <div className="min-w-0">
          {/* TABLET BAR */}
          <nav aria-label="Portal sections" className="mt-5 hidden gap-1 rounded-2xl border border-border bg-surface/70 p-1 backdrop-blur sm:flex lg:hidden">
            {nav.primary.map((i) => {
              const Icon = ICON[i.dest];
              const on = active === i.dest;
              return (
                <Link key={i.dest} href={i.href} aria-current={on ? "page" : undefined} className={cn("flex min-h-11 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 text-[13px] font-semibold", focus, on ? "bg-brand text-white shadow" : "text-muted hover:text-foreground")}>
                  <Icon className="size-4" aria-hidden /> {i.short}
                  <CountBadge n={i.badge} label={i.dest === "more" ? "unread" : "waiting"} className={on ? "bg-white text-brand" : ""} />
                </Link>
              );
            })}
          </nav>

          <Notices n={notices} clientName={clientName} />

          <main id="portal-main" tabIndex={-1} className="min-w-0 break-words focus:outline-none">
            {children}
          </main>
          {footer}
        </div>
      </div>

      {/* PHONE BAR — Home · Plan · Library · Schedule · More, 48px targets. */}
      <nav aria-label="Portal sections" className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur sm:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <ul className="mx-auto grid max-w-3xl grid-cols-5">
          {nav.primary.map((i) => {
            const Icon = ICON[i.dest];
            const on = active === i.dest;
            return (
              <li key={i.dest}>
                <Link href={i.href} aria-current={on ? "page" : undefined} className={cn("flex min-h-12 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-semibold", focus, "focus-visible:-outline-offset-2", on ? "text-brand" : "text-muted")}>
                  <span className="relative">
                    <Icon className="size-5" aria-hidden />
                    {i.badge > 0 && <CountBadge n={i.badge} label={i.dest === "more" ? "unread" : "waiting"} className="absolute -right-3 -top-1.5 min-w-4 px-1 text-[10px] leading-4" />}
                  </span>
                  {i.short}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function RailLink({ i, active, small = false }: { i: Linked; active: boolean; small?: boolean }) {
  const Icon = ICON[i.dest];
  return (
    <Link href={i.href} aria-current={active ? "page" : undefined} className={cn("flex min-h-11 items-center gap-2.5 rounded-xl px-3 font-semibold", small ? "text-[13px]" : "text-sm", focus, active ? "bg-brand text-white shadow" : "text-muted hover:bg-surface hover:text-foreground")}>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{i.label}</span>
      <CountBadge n={i.badge} label={i.dest === "messages" ? "unread" : "waiting"} className={active ? "bg-white text-brand" : ""} />
    </Link>
  );
}

/** The same four notices as v1, in the same words. */
function Notices({ n, clientName }: { n: ShellNotices; clientName: string | null }) {
  return (
    <>
      {n.readOnly && (
        <div className="mt-5 flex flex-wrap items-start gap-2 rounded-2xl border border-border bg-surface/80 p-3.5 text-sm">
          <PauseCircle className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1 basis-56">
            <div className="font-semibold">{n.readOnly.title}</div>
            <div className="text-xs text-muted">{n.readOnly.body}</div>
          </div>
          <a href={n.readOnly.cta.href} target="_blank" rel="noopener noreferrer" className={cn("inline-flex min-h-11 shrink-0 items-center rounded-lg bg-brand px-3 text-xs font-semibold text-white", focus)}>{n.readOnly.cta.label}</a>
        </div>
      )}
      {n.staff && (
        <div className="mt-5 flex flex-wrap items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft/40 p-3.5 text-sm">
          <Eye className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 flex-1 basis-56 text-xs">
            You&rsquo;re viewing this as <span className="font-semibold">{n.staff.who}</span>, on {clientName ?? n.staff.clientName}&rsquo;s behalf. Anything you submit here is recorded as <span className="font-semibold">you, on their behalf</span> — never as them.
            {n.staff.exitHref && <> This is a <span className="font-semibold">preview of the new layout</span>; the client still sees the current one.</>}
          </div>
          {n.staff.exitHref && <Link href={n.staff.exitHref} className={cn("inline-flex min-h-11 shrink-0 items-center rounded-lg border border-border bg-surface px-3 text-xs font-semibold", focus)}>Back to the current layout</Link>}
        </div>
      )}
      {n.offerSignIn && (
        <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-brand/30 bg-brand-soft/40 p-3.5 text-sm">
          <KeyRound className="size-4 shrink-0 text-brand" aria-hidden />
          <span className="min-w-0 flex-1 basis-48 text-xs">Set up your sign-in — a personal link by email, so this page is yours wherever you open it. This link keeps working too.</span>
          <Link href="/portal/login" className={cn("inline-flex min-h-11 items-center rounded-lg bg-brand px-3 text-xs font-semibold text-white", focus)}>Sign in with email</Link>
        </div>
      )}
      {n.viewOnlySeat && (
        <div className="mt-5 flex items-start gap-2 rounded-2xl border border-border bg-surface/80 p-3.5 text-xs text-muted">
          <Eye className="mt-0.5 size-4 shrink-0" aria-hidden /> You have view-only access to this program. The program owner can make changes.
        </div>
      )}
    </>
  );
}
