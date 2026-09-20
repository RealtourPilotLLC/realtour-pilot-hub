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
  CalendarX,
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
// BEFORE opening — rows keep their unread styling for the whole time the panel
// is up, so nothing loses its dot while you are still reading it.
//
// WHY OPENING THE BELL NO LONGER MARKS EVERYTHING READ (Sep 20 2026). The click
// that opened the panel used to POST the watermark straight to now(), and it did
// that beside the list fetch rather than after it. Two things were wrong. The
// panel could only ever render 30 rows while the watermark retires EVERY older
// row, so James, sitting on 887 rows behind his watermark, was one click away
// from silently retiring 857 he had never been shown, 181 of them addressed to
// him by name — and with no second page and no /notifications screen there was
// nowhere to go and read them. And because the POST did not wait on the fetch,
// a 500 or a dropped connection on open still moved the watermark, wiping unread
// for rows the browser never received at all.
// So: the watermark is posted on CLOSE, never on open; only when the list
// actually arrived; carrying the ids of the newest and oldest rows that were on
// screen, which the server checks cover the whole unread span before it moves
// anything. Older rows are reachable now with "Load older". When the backlog is
// bigger than the panel will hold, the STICKY HEADER says so — at 200 rows a
// note at the end of the list is 200 rows below the fold, which is exactly the
// two people (james@, jordan.laurenspackman) this is for — and the only thing
// that clears it is the person pressing "Mark all read".

type Item = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string;
  createdAt: string;
};

type Feed = {
  items?: Item[];
  unread?: number;
  seenAt?: string | null;
  hasMore?: boolean;
};

const KIND_ICON: Record<string, LucideIcon> = {
  order_booked: CalendarPlus,
  order_canceled: CalendarX,
  order_paid: DollarSign,
  delivery_out: PackageCheck,
  revision_raised: Undo2,
  revision_resolved: Undo2,
  appointment_change: CalendarClock,
  new_lead: UserPlus,
  raws_landed: Film,
  edit_started: Clapperboard,
  edit_finished: Clapperboard,
  edit_assigned: Clapperboard,
  shoot_completed: Camera,
  client_feedback: MessageSquareHeart,
  review_feedback: MessageSquareHeart, // capture/edit feedback from the owner's review
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
  const [hasMore, setHasMore] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // The PRE-open watermark rows are highlighted against (see header comment).
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const openRef = useRef(open);
  // close() runs from document listeners, so the rows it reports to the server
  // have to come from a ref rather than from the closure's stale state.
  const itemsRef = useRef<Item[]>([]);
  // MIRRORED IN AN EFFECT, NOT DURING RENDER (Sep 20 2026). Writing a ref in the
  // render body is what react-hooks/refs refuses, and under React 19 it is a
  // real hazard rather than a style note: a render that is thrown away still
  // performs the write, so a discarded render can leave these pointing at rows
  // that were never committed — and `markShownSeen` reports exactly these ids
  // to the server as "the person saw these". The commit is the only moment we
  // can honestly claim that from.
  useEffect(() => {
    openRef.current = open;
    itemsRef.current = items;
  }, [open, items]);
  // Only a list that actually arrived may move the watermark. A swallowed fetch
  // error must leave it exactly where it was.
  const listLoadedRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null); // portaled on mobile — checked separately for outside-click

  // The badge only. Used on mount and by the 60s poll, so an idle tab is not
  // pulling a screenful of rows every minute for a number.
  const fetchCount = useCallback(async (updateSeen: boolean) => {
    try {
      const res = await fetch("/api/notifications?count=1", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Feed;
      setUnread(data.unread ?? 0);
      if (updateSeen) setSeenAt(data.seenAt ?? null);
    } catch {
      /* the next poll retries */
    }
  }, []);

  // The list itself, fetched when the panel opens.
  const fetchList = useCallback(async () => {
    setLoadingList(true);
    setLoadFailed(false);
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const data = (await res.json()) as Feed;
      setItems(data.items ?? []);
      setUnread(data.unread ?? 0);
      setHasMore(!!data.hasMore);
      listLoadedRef.current = true;
    } catch {
      // An empty panel must not read as "nothing new" — say it failed and leave
      // the watermark exactly where it was (see listLoadedRef).
      setLoadFailed(true);
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadOlder = useCallback(async () => {
    const tail = itemsRef.current[itemsRef.current.length - 1];
    if (!tail) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/notifications?before=${encodeURIComponent(tail.id)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as Feed;
      const have = new Set(itemsRef.current.map((p) => p.id));
      const fresh = (data.items ?? []).filter((i) => !have.has(i.id));
      if (fresh.length === 0) {
        // A page that adds nothing means the cursor did not resolve to a real
        // row — the button would stay lit and inert on every further click. The
        // route now answers an unresolvable cursor with an empty page and
        // hasMore false; this stops us regardless of what came back.
        setHasMore(false);
        return;
      }
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...fresh.filter((i) => !seen.has(i.id))];
      });
      setHasMore(!!data.hasMore);
    } catch {
      /* leave the list as it is; the button is still there to retry */
    } finally {
      setLoadingMore(false);
    }
  }, []);

  // Badge on mount + poll every 60s while the tab is visible. While the panel is
  // open the poll must not touch the highlight watermark or the list the person
  // is reading (they may have loaded older pages under it).
  useEffect(() => {
    fetchCount(true);
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && !openRef.current) fetchCount(true);
    }, 60_000);
    return () => clearInterval(t);
  }, [fetchCount]);

  // Advance the watermark over what was actually on screen. The server re-checks
  // that this window covers the whole unread span and refuses to move otherwise,
  // so the worst this can do is leave rows unread.
  const markShownSeen = useCallback(() => {
    if (!listLoadedRef.current) return;
    const rows = itemsRef.current;
    if (rows.length === 0) return;
    fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newestId: rows[0].id, oldestId: rows[rows.length - 1].id }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<Feed>) : null))
      .then((d) => {
        if (!d) return;
        if (typeof d.unread === "number") setUnread(d.unread);
        if (d.seenAt !== undefined) setSeenAt(d.seenAt ?? null);
      })
      .catch(() => {});
  }, []);

  const markAllRead = useCallback(() => {
    setUnread(0);
    setSeenAt(new Date().toISOString());
    fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    markShownSeen();
  }, [markShownSeen]);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    // Refresh the list, but keep the pre-open watermark so the rows you came to
    // read still carry their dots. Nothing is marked seen until you close.
    setItems([]);
    setHasMore(false);
    listLoadedRef.current = false;
    void fetchList();
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
  // Rows still behind the watermark that the panel has not put on screen. This
  // is the number that used to vanish on a click.
  const behind = Math.max(0, unread - items.filter((it) => new Date(it.createdAt).getTime() > seenTs).length);

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
      {/* STICKY, and the backlog line lives up here rather than by the button
          that acts on it. This panel is the scroll container, and its first page
          now stretches to 200 rows: for the two people the held watermark was
          built for — james@ at 887 unread and jordan.laurenspackman at 352 — a
          note in the footer sits roughly 200 rows below the fold, so the lived
          experience would be a badge stuck at 99+ with no visible reason for it.
          The count, the reason and the way out all have to be on screen from the
          first row. */}
      <div className="sticky top-0 z-10 border-b border-border bg-surface px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">
            Notifications
            {unread > 0 && <span className="ml-1.5 font-normal text-muted-2">{unread} unread</span>}
          </div>
          <button
            onClick={markAllRead}
            className="text-xs font-medium text-muted-2 hover:text-foreground"
          >
            Mark all read
          </button>
        </div>
        {/* hasMore, not just behind > 0: toggle() clears it before the fetch, so
            this cannot flash "887 of them are further down" over an empty panel
            while the list is still in flight, and the line never points at a
            "Load older" button that isn't rendered. */}
        {hasMore && behind > 0 && (
          <div className="pt-1 text-[11px] leading-snug text-muted-2">
            {behind} of {behind === 1 ? "them is" : "them are"} further down than this list goes —
            load older to read them, or mark all read to clear the badge.
          </div>
        )}
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-2">
          {loadingList
            ? "Loading"
            : loadFailed
              ? "That did not load. Close this and open it again in a moment."
              : "Nothing new"}
        </div>
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
      {hasMore && (
        // Sticky too, for the same reason the header is: at 200 rows a button
        // pinned to the end of the list is a button nobody reaches.
        <div className="sticky bottom-0 z-10 border-t border-border bg-surface px-3 py-2">
          <button
            onClick={loadOlder}
            disabled={loadingMore}
            className="w-full rounded-lg border border-border py-1.5 text-xs font-medium text-muted-2 hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
          >
            {loadingMore ? "Loading" : "Load older"}
          </button>
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
            {/* Was "9+", which read the same at 10 rows behind and at 887. */}
            {unread > 99 ? "99+" : unread}
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
