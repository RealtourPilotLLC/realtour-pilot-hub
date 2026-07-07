"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  AtSign,
  Bell,
  CalendarClock,
  CalendarPlus,
  Camera,
  Clapperboard,
  DollarSign,
  Film,
  MessageSquareHeart,
  PackageCheck,
  Undo2,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// The in-app notification bell. Mounted twice: the mobile top bar (panel drops
// down, fixed + above the drawer/Leaflet z-stack) and the desktop sidebar footer
// (panel opens UPWARD — the row sits at the viewport bottom). Data comes from
// /api/notifications, already scoped server-side to the signed-in user's role +
// tm:/editor: keys. Unread = rows newer than the seenAt watermark CAPTURED
// BEFORE opening — opening marks everything seen (badge → 0) but rows keep
// their unread styling until the panel closes.

type Item = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string;
  createdAt: string;
};

const KIND_ICON: Record<string, LucideIcon> = {
  order_booked: CalendarPlus,
  order_paid: DollarSign,
  delivery_out: PackageCheck,
  revision_raised: Undo2,
  revision_resolved: Undo2,
  appointment_change: CalendarClock,
  new_lead: UserPlus,
  raws_landed: Film,
  edit_finished: Clapperboard,
  shoot_completed: Camera,
  client_feedback: MessageSquareHeart,
  mention: AtSign,
  system: AlertTriangle,
};

// Compact relative time for the rows: "3m" / "2h" / "Mon" (older than a week
// falls back to "Jun 30" so a stale "Mon" can't read as yesterday).
function timeago(iso: string): string {
  const d = new Date(iso);
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(d);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

export function NotificationsBell({ variant = "sidebar" }: { variant?: "sidebar" | "header" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  // The PRE-open watermark rows are highlighted against (see header comment).
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null); // portaled on mobile — checked separately for outside-click

  const fetchData = useCallback(async (updateSeen: boolean) => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: Item[]; unread?: number; seenAt?: string | null };
      setItems(data.items ?? []);
      setUnread(data.unread ?? 0);
      if (updateSeen) setSeenAt(data.seenAt ?? null);
    } catch {
      /* the next poll retries */
    }
  }, []);

  // Fetch on mount + poll every 60s while the tab is visible. While the panel is
  // open, polls must not advance the highlight watermark mid-read.
  useEffect(() => {
    fetchData(true);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") fetchData(!openRef.current);
    }, 60_000);
    return () => clearInterval(t);
  }, [fetchData]);

  const markSeen = useCallback(() => {
    setUnread(0);
    fetch("/api/notifications", { method: "POST" }).catch(() => {});
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // Rows read; drop the unread styling for the next open.
    setSeenAt(new Date().toISOString());
  }, []);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    fetchData(false); // refresh the list, but keep the pre-open watermark
    markSeen(); // badge → 0 immediately
  };

  // Outside click / Escape close the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const seenTs = seenAt ? new Date(seenAt).getTime() : 0;

  const panel = open && (
    <div
      ref={panelRef}
      className={cn(
        "overflow-y-auto scroll-thin rounded-xl border border-border bg-surface shadow-xl",
        variant === "header"
          ? "fixed inset-x-2 top-14 z-[1400] max-h-[70vh]" // above the drawer (z-1300) + Leaflet (~1000)
          : "absolute inset-x-2 bottom-20 z-50 max-h-96", // opens upward from the sidebar footer
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-sm font-semibold">Notifications</div>
        <button
          onClick={markSeen}
          className="text-xs font-medium text-muted-2 hover:text-foreground"
        >
          Mark all read
        </button>
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-2">Nothing new</div>
      ) : (
        <div className="divide-y divide-border">
          {items.map((it) => {
            const Icon = KIND_ICON[it.kind] ?? Bell;
            const isUnread = new Date(it.createdAt).getTime() > seenTs;
            return (
              <button
                key={it.id}
                onClick={() => {
                  close();
                  router.push(it.href);
                }}
                className={cn(
                  "flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-surface-2",
                  isUnread && "bg-surface-2/60",
                )}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-2" />
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-sm font-medium">{it.title}</div>
                  {it.body && <div className="truncate text-xs text-muted-2">{it.body}</div>}
                </div>
                <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
                  <span className="text-[11px] text-muted-2">{timeago(it.createdAt)}</span>
                  {isUnread && <span className="size-1.5 rounded-full bg-brand" />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div ref={wrapRef} className={variant === "header" ? "relative" : undefined}>
      <button
        onClick={toggle}
        aria-label="Notifications"
        className={cn(
          "relative flex items-center justify-center rounded-lg text-muted-2 hover:bg-surface-2 hover:text-foreground",
          variant === "header" ? "size-9 text-foreground/80" : "size-8",
        )}
      >
        <Bell className={variant === "header" ? "size-5" : "size-4"} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {/* The mobile header has backdrop-blur (a stacking context), so its fixed
          panel must PORTAL to <body> or later page chrome paints over it. The
          sidebar panel stays inline — it anchors to the aside and opens upward. */}
      {variant === "header" ? (open ? createPortal(panel, document.body) : null) : panel}
    </div>
  );
}
