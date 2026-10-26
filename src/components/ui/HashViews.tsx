"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// ONE SECTION AT A TIME, CHOSEN BY THE #… IN THE ADDRESS (Oct 26 2026, Jordan:
// "clean up and organize the settings page so its an actual nice settings
// page dashboard and same with the connections page"). Settings and
// Connections both open on an overview; every section is one press away, and
// the address says which one is open, so Back works and a link can name it.
//
// Every section stays MOUNTED and is only hidden, so a half-typed form
// survives a trip to another section. A hash names either a section (#team) or
// anything inside one (#coaching, #topaz): the section holding it opens and the
// page scrolls to it, so every existing /settings#… link still lands.
//
// The server renders the `initial` section; the hash is read after hydration
// (the server never sees it).
// ---------------------------------------------------------------------------

const HashViewContext = createContext("");
/** The id of the open section ("" outside a HashViews). */
export const useHashView = () => useContext(HashViewContext);

export function HashViews({ initial, onNavigate, className, children }: { initial: string; onNavigate?: () => void; className?: string; children: ReactNode }) {
  const [view, setView] = useState(initial);
  // A fresh object per navigation, so pressing the open section again still scrolls to it.
  const [target, setTarget] = useState<{ id: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const navigated = useRef(onNavigate);
  useEffect(() => { navigated.current = onNavigate; }, [onNavigate]);

  /** Opens the section holding the hash's target. False when the hash names nothing in here. */
  const open = useCallback((hash: string): boolean => {
    let id: string;
    try { id = decodeURIComponent(hash.replace(/^#/, "")); } catch { return false; }
    if (!id) { setView(initial); setTarget(null); return true; }
    const el = document.getElementById(id);
    const section = el?.closest<HTMLElement>("[data-view]");
    if (!el || !section || !root.current?.contains(section)) return false;
    setView(section.dataset.view ?? initial);
    setTarget({ id });
    return true;
  }, [initial]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the hash is known only in the browser, after hydration
    open(window.location.hash);
    const onHash = () => { if (open(window.location.hash)) navigated.current?.(); };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, [open]);

  // After the section is showing: open any <details> around the target, scroll
  // to it and move focus there (a section's own heading, for a section).
  useEffect(() => {
    if (!target) return;
    const el = document.getElementById(target.id);
    if (!el) return;
    for (let node: HTMLElement | null = el; node && root.current?.contains(node); node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true;
    }
    el.scrollIntoView({ block: "start" });
    const focus = el.matches("[data-view]") ? el.querySelector<HTMLElement>("h2") ?? el : el;
    // Focus moves for screen readers; a heading needs no ring of its own.
    if (!focus.matches("a, button, input, select, textarea, summary, [tabindex]")) { focus.tabIndex = -1; focus.classList.add("focus:outline-none"); }
    focus.focus({ preventScroll: true });
  }, [target]);

  return (
    <HashViewContext.Provider value={view}>
      <div
        ref={root}
        className={className}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href^='#']");
          if (!anchor || !event.currentTarget.contains(anchor)) return;
          const hash = anchor.getAttribute("href")!;
          if (!open(hash)) return;
          event.preventDefault();
          if (window.location.hash !== hash) window.history.pushState(null, "", hash);
          navigated.current?.();
        }}
      >
        {children}
      </div>
    </HashViewContext.Provider>
  );
}

/** A section: shown while it is the open one. */
export function HashView({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  const view = useHashView();
  return <section id={id} data-view={id} aria-labelledby={`${id}-heading`} hidden={view !== id} className={cn("scroll-mt-28", className)}>{children}</section>;
}

/**
 * One entry in a section menu: a chip that wraps on a phone, a row in the side
 * column from lg up. `href` (a page, not a section) makes it a plain link.
 */
export function ViewNavLink({ id, href, label, icon: Icon, badge, inactive = false }: { id: string; href?: string; label: string; icon: LucideIcon; badge?: ReactNode; inactive?: boolean }) {
  const view = useHashView();
  const active = !href && !inactive && view === id;
  return (
    <a
      href={href ?? `#${id}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        "lg:flex lg:min-h-10 lg:rounded-lg lg:border-0 lg:bg-transparent lg:px-2.5 lg:hover:bg-surface-2",
        active && "bg-brand/10 text-brand lg:bg-surface-2 lg:text-foreground",
      )}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", active ? "text-brand" : "text-muted-2")} />
      <span className="min-w-0 flex-1">{label}</span>
      {badge}
    </a>
  );
}
