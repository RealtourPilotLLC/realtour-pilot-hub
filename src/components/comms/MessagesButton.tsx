"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Users } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE MESSAGES ICON (Jordan, Oct 27 2026 Loom, 26:50: "if they do send us a
// message, I would like a little icon here, and I would like messages on our
// dashboards, so like a messages button or something on the main dashboard
// for Kyle, me, and James ... same with the editors"; 38:54: "we should have
// like a messages thing up here at all times and if there's any team messages
// it gets shown up there that there's an unread message").
//
// Beside the bell (the phone's top bar, the desktop sidebar's footer) and as
// a "Messages" button on the dashboards. Its number is what this person has
// not read: client conversations waiting on us (Jordan and Kyle, who answer
// clients) plus team chat threads with something new. For the office it opens
// a small menu, Client messages and Team messages; for James and the editors
// it opens their team message center. Numbers come from /api/messages/unread,
// one shared poll for every mounted icon, every two minutes while the tab is
// visible. Since Oct 28 2026 (the team channel: "so all team members can
// message") a photographer has a team center too and sees the icon: it opens
// the channel and their own shoots' threads.
// ---------------------------------------------------------------------------

type Counts = { clients: number; team: number; clientsHref: string | null; teamHref: string | null };

const listeners = new Set<(c: Counts) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let last: Counts | null = null;

function read(): Promise<void> {
  inFlight ??= (async () => {
    try {
      const res = await fetch("/api/messages/unread", { cache: "no-store" });
      if (!res.ok) return;
      const c = (await res.json()) as Counts;
      last = c;
      for (const l of listeners) l(c);
    } catch {
      // the next poll retries
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function subscribe(fn: (c: Counts) => void): () => void {
  listeners.add(fn);
  if (last) fn(last);
  if (!timer) {
    void read();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, 120_000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Before the first read: where the icon goes by role alone. */
export function messagesFallbackHref(role: string | null | undefined): string | null {
  if (role === "OWNER" || role === "ADMIN") return "/communications";
  if (role === "CREATIVE_MANAGER" || role === "EDITOR" || role === "PHOTOGRAPHER") return "/editing/messages";
  return null;
}

/** The panel's width (w-64), clamped to the window on a phone. */
const PANEL_W = 256;

export function MessagesButton({ variant, role }: { variant: "header" | "sidebar" | "dashboard"; role?: string | null }) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribe(setCounts), []);

  // WHERE THE PANEL GOES (Jordan, Oct 28 2026: "when clicking messages it gets
  // half hidden"). The sidebar and the page header both have backdrop blur, a
  // stacking context: an inline panel there sat under the page (the 256px
  // panel is wider than the sidebar). Every variant now portals to <body>,
  // placed from the button: upward from the sidebar footer, down from the
  // dashboard button, kept inside the window.
  useEffect(() => {
    if (!open) return;
    const at = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(PANEL_W, window.innerWidth - 16);
      const left = Math.max(8, Math.min(variant === "sidebar" ? r.left : r.right - w, window.innerWidth - w - 8));
      setPlace(variant === "sidebar" ? { left, bottom: window.innerHeight - r.top + 6, width: w } : { left, top: r.bottom + 4, width: w });
    };
    at();
    window.addEventListener("resize", at);
    window.addEventListener("scroll", at, true);
    return () => {
      window.removeEventListener("resize", at);
      window.removeEventListener("scroll", at, true);
    };
  }, [open, variant]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const fallback = messagesFallbackHref(role);
  const clientsHref = counts ? counts.clientsHref : fallback === "/communications" ? fallback : null;
  const teamHref = counts ? counts.teamHref : fallback === "/editing/messages" ? fallback : fallback ? "/communications?tab=team" : null;
  if (!clientsHref && !teamHref) return null;
  const clients = counts?.clients ?? 0;
  const team = counts?.team ?? 0;
  const total = clients + team;
  const both = !!clientsHref && !!teamHref;
  const label = total > 0 ? `Messages, ${total} unread` : "Messages";

  const badge = total > 0 && (
    <span
      data-messages-unread={total}
      className={cn(
        "flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-action px-1 text-[10px] font-semibold leading-none text-white",
        variant === "dashboard" ? "ml-0.5" : "absolute -right-0.5 -top-0.5",
      )}
    >
      {total > 99 ? "99+" : total}
    </span>
  );
  const face =
    variant === "dashboard" ? (
      <>
        <MessageSquare aria-hidden className="size-3.5" /> Messages {badge}
      </>
    ) : (
      <>
        <MessageSquare aria-hidden className={variant === "header" ? "size-5" : "size-4"} />
        {badge}
      </>
    );
  const faceClass =
    variant === "dashboard"
      ? "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      : cn(
          "relative flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-2 hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
          variant === "header" && "text-foreground/80",
        );

  if (!both) {
    return (
      <Link href={(clientsHref ?? teamHref) as string} aria-label={label} title={label} data-messages-button={variant} className={faceClass}>
        {face}
      </Link>
    );
  }

  const row = (href: string, Icon: typeof Users, text: string, n: number) => (
    <Link
      href={href}
      onClick={() => setOpen(false)}
      className="flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm hover:bg-surface-2"
    >
      <Icon aria-hidden className="size-4 text-muted-2" />
      <span className="flex-1 font-medium">{text}</span>
      {n > 0 ? <span className="rounded-full bg-brand-action px-1.5 text-[11px] font-semibold text-white">{n} unread</span> : <span className="text-xs text-muted-2">all read</span>}
    </Link>
  );
  const panel = open && (
    <div
      ref={panelRef}
      role="menu"
      aria-label="Messages"
      // z-[1400]: above the mobile drawer (z-1300), like the bell's panel.
      className={cn("fixed z-[1400] w-64 rounded-xl border border-border bg-surface p-1.5 shadow-xl", variant === "header" && "right-2 top-14")}
      style={variant === "header" ? undefined : place ?? { visibility: "hidden" }}
    >
      {row(clientsHref, MessageSquare, "Client messages", clients)}
      {row(teamHref, Users, "Team messages", team)}
    </div>
  );
  return (
    <div ref={wrapRef} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={label} title={label} aria-expanded={open} aria-haspopup="menu" data-messages-button={variant} className={faceClass}>
        {face}
      </button>
      {open ? createPortal(panel, document.body) : null}
    </div>
  );
}
