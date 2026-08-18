"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clapperboard, ExternalLink, GripHorizontal, X } from "lucide-react";

// The Style Guide as a floating window on the Editor Queue — Jordan: "the
// style guide should be able to be popped up in the editor queue and also be
// able to be dragged around the screen and placed wherever they want it."
//
// · The launcher button lives in the queue's PageHeader (owner view and the
//   editor's EditorDay both).
// · The window is position:fixed, dragged by its title bar (pointer capture),
//   resizable from the bottom-right corner (native CSS resize), and remembers
//   where you left it (localStorage) — "placed wherever they want it" sticks
//   across visits.
// · The content is an iframe on /resources/video-styles/embed: the SAME
//   server-rendered guide (players, music, tools), just without the app
//   chrome — one source of truth, nothing duplicated.
// · While dragging, a transparent overlay covers the iframe so pointer events
//   keep reaching the drag handler (iframes swallow them otherwise).

const STORE = "rtp_style_win";
type Win = { x: number; y: number; w: number; h: number };

function clamp(win: Win): Win {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(320, win.w), vw - 16);
  const h = Math.min(Math.max(280, win.h), vh - 16);
  return {
    w,
    h,
    x: Math.min(Math.max(8, win.x), vw - w - 8),
    y: Math.min(Math.max(8, win.y), vh - h - 8),
  };
}

export function FloatingStyleGuide() {
  const [open, setOpen] = useState(false);
  const [win, setWin] = useState<Win | null>(null);
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const grip = useRef<{ dx: number; dy: number } | null>(null);

  const persist = (w: Win) => {
    try {
      localStorage.setItem(STORE, JSON.stringify(w));
    } catch { /* private mode etc. — the window still works, it just forgets */ }
  };

  const openWindow = () => {
    let stored: Win | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(STORE) || "null");
    } catch { /* corrupt store → defaults */ }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(460, vw - 24);
    const h = Math.min(640, vh - 24);
    // Default: docked to the right, vertically centered — next to the queue.
    setWin(clamp(stored ?? { w, h, x: vw - w - 20, y: Math.max(8, (vh - h) / 2) }));
    setOpen(true);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!win) return;
    grip.current = { dx: e.clientX - win.x, dy: e.clientY - win.y };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!grip.current) return;
    setWin((w) => (w ? clamp({ ...w, x: e.clientX - grip.current!.dx, y: e.clientY - grip.current!.dy }) : w));
  };
  const onPointerUp = () => {
    grip.current = null;
    setDragging(false);
    setWin((w) => {
      if (w) persist(w);
      return w;
    });
  };

  // Native CSS resize changes the element's size outside React — mirror it back
  // into state (so clamping stays honest) and persist the new size.
  useEffect(() => {
    const el = frameRef.current;
    if (!open || !el) return;
    const ro = new ResizeObserver(() => {
      setWin((w) => {
        if (!w || (w.w === el.offsetWidth && w.h === el.offsetHeight)) return w;
        const next = { ...w, w: el.offsetWidth, h: el.offsetHeight };
        persist(next);
        return next;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  return (
    <>
      <button
        onClick={() => (open ? setOpen(false) : openWindow())}
        title="Pop up the Video Style Guide — drag it wherever you want"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground/80 hover:bg-surface-2 hover:text-foreground"
      >
        <Clapperboard className="size-4 text-brand" />
        Style Guide
      </button>

      {/* Portaled to <body>: the launcher lives inside the PageHeader, whose
          backdrop-blur makes it the containing block for position:fixed —
          rendered in place, the window's coordinates were offset by the
          sidebar and it hung off the right edge of the screen. */}
      {open && win && createPortal(
        <div
          ref={frameRef}
          style={{ left: win.x, top: win.y, width: win.w, height: win.h }}
          // z-[1100]: above every page control (status menu is z-40), below the
          // mobile nav drawer (z-1200/1300). `resize` needs overflow-hidden to
          // grow its bottom-right handle.
          className="fixed z-[1100] flex resize flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        >
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="flex shrink-0 cursor-grab touch-none select-none items-center gap-2 border-b border-border bg-surface-2/80 px-3 py-2 active:cursor-grabbing"
          >
            <Clapperboard className="size-4 shrink-0 text-brand" />
            <span className="truncate text-sm font-semibold">Video Style Guide</span>
            <GripHorizontal className="size-4 shrink-0 text-muted-2" />
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <a
                href="/resources/video-styles"
                target="_blank"
                rel="noopener noreferrer"
                title="Open the full Style Guide page"
                onPointerDown={(e) => e.stopPropagation()}
                className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </a>
              <button
                onClick={() => setOpen(false)}
                onPointerDown={(e) => e.stopPropagation()}
                title="Close"
                className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </span>
          </div>
          <div className="relative min-h-0 flex-1">
            <iframe src="/resources/video-styles/embed" title="Video Style Guide" className="size-full border-0" />
            {dragging && <div className="absolute inset-0" />}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
