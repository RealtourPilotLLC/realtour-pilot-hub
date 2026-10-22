"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// ZOOM ON THE PHOTO REVIEW (Oct 22 2026). Jordan: "add a zoom feature on the
// photo review". The lightbox and review mode showed a photo only fitted to
// the screen, so a floating lamp, a seam in the sky or a lot line a few pixels
// off meant opening "Full size" in another tab and losing the finding boxes.
//
// This wraps the photo AND its finding boxes in one transformed box, so the
// boxes stay exactly on the picture at any zoom (BoxOverlay reads --zoom to
// keep its lines thin). The stage around it clips (overflow-hidden on the
// parent), so a zoomed photo fills the black area.
//   · scroll, pinch, or the + and - buttons; double-click or double-tap jumps
//     in at that spot, and again jumps back out;
//   · drag (or one finger) to move around while zoomed;
//   · keys: Z in and out at the middle, + and -, 0 fits;
//   · past 2x the full-size file is loaded behind the scenes and swapped in
//     when it arrives (the qc2048 preview turns soft beyond that); if the hub
//     has no full-size file the preview simply stays.
// A new photo starts fitted: the parents key this on the photo (and version).
// Same arithmetic as the lot lines tool's stage (LotLinesEditor), without the
// drawing.
// ---------------------------------------------------------------------------

const Z_MAX = 8;
const STEP = 1.5;
const DOUBLE_TAP_Z = 2.5;
const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type View = { z: number; x: number; y: number };
const FIT: View = { z: 1, x: 0, y: 0 };

export function ZoomStage({
  children,
  hiRes,
  keys = true,
  onZoomedChange,
  className,
}: {
  /** The photo (and its overlays): laid out exactly as before, then zoomed as one. */
  children: ReactNode;
  /** The full-size file, loaded only once someone zooms past 2x. Null: keep the preview. */
  hiRes?: string | null;
  /** Z, +, - and 0. Off while a prompt, the cart or another tool is open. */
  keys?: boolean;
  /** Review mode stops swipe-to-next while zoomed. */
  onZoomedChange?: (zoomed: boolean) => void;
  className?: string;
}) {
  const [view, setView] = useState<View>(FIT);
  const viewRef = useRef<View>(FIT);
  const painted = useRef<View>(FIT);
  const boxRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean } | { kind: "pinch"; d0: number; z0: number; mx: number; my: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const [wantHi, setWantHi] = useState(false);
  const [hi, setHi] = useState<"loading" | "ready" | "failed">("loading");

  const apply = useCallback((v: View) => {
    viewRef.current = v;
    setView(v);
  }, []);
  useLayoutEffect(() => {
    painted.current = view;
  }, [view]);

  /** Keep the zoomed photo covering its own fitted box, so every corner is reachable and none of it drifts off. */
  const clamp = useCallback((v: View): View => {
    const el = boxRef.current;
    if (!el || v.z <= 1) return FIT;
    const w = el.offsetWidth, h = el.offsetHeight;
    return { z: v.z, x: clampN(v.x, w * (1 - v.z), 0), y: clampN(v.y, h * (1 - v.z), 0) };
  }, []);

  /** Zoom to z1 about a point on the screen (the cursor, a pinch's middle, or the photo's middle). */
  const zoomTo = useCallback(
    (z1: number, clientX?: number, clientY?: number) => {
      const el = boxRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // The fitted box's top-left on screen: the painted transform taken back off.
      const lx = r.left - painted.current.x, ly = r.top - painted.current.y;
      const cx = clientX ?? lx + el.offsetWidth / 2, cy = clientY ?? ly + el.offsetHeight / 2;
      const v = viewRef.current;
      const z = clampN(z1, 1, Z_MAX);
      const px = (cx - lx - v.x) / v.z, py = (cy - ly - v.y) / v.z;
      apply(clamp({ z, x: cx - lx - z * px, y: cy - ly - z * py }));
      if (z >= 2) setWantHi(true);
    },
    [apply, clamp],
  );

  const zoomed = view.z > 1.001;
  useEffect(() => {
    onZoomedChange?.(zoomed);
  }, [zoomed, onZoomedChange]);

  // The wheel has to be a native, non-passive listener: React's is passive, and
  // a Ctrl+wheel (a trackpad pinch) would otherwise zoom the whole browser page.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      // In proportion to the scroll: a trackpad sends many small steps, a mouse wheel a few big ones.
      zoomTo(viewRef.current.z * Math.exp(clampN(-e.deltaY, -240, 240) * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "z" || e.key === "Z") zoomTo(viewRef.current.z > 1.001 ? 1 : DOUBLE_TAP_Z);
      else if (e.key === "+" || e.key === "=") zoomTo(viewRef.current.z * STEP);
      else if (e.key === "-" || e.key === "_") zoomTo(viewRef.current.z / STEP);
      else if (e.key === "0") apply(FIT);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keys, zoomTo, apply]);

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    gesture.current = { kind: "pinch", d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z0: viewRef.current.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) startPinch();
    else if (pointers.current.size === 1) gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      zoomTo(g.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / g.d0), mx, my);
      // Two fingers moving together move the photo too.
      const v = viewRef.current;
      apply(clamp({ z: v.z, x: v.x + mx - g.mx, y: v.y + my - g.my }));
      g.mx = mx;
      g.my = my;
    } else if (g.kind === "pan") {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) > 6) g.moved = true;
      if (g.moved && viewRef.current.z > 1.001) apply(clamp({ z: viewRef.current.z, x: g.vx + dx, y: g.vy + dy }));
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 1) {
      // One finger left after a pinch: it pans from here.
      const [p] = [...pointers.current.values()];
      gesture.current = { kind: "pan", sx: p.x, sy: p.y, vx: viewRef.current.x, vy: viewRef.current.y, moved: true };
      return;
    }
    gesture.current = null;
    if (e.type === "pointercancel" || !g || g.kind !== "pan" || g.moved) return;
    // A tap (no drag): two in a row, close together, jump in at that spot or back out.
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.t < 320 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30) {
      lastTap.current = null;
      zoomTo(viewRef.current.z > 1.001 ? 1 : DOUBLE_TAP_Z, e.clientX, e.clientY);
    } else lastTap.current = { t: now, x: e.clientX, y: e.clientY };
  };

  const showHi = !!hiRes && wantHi && hi !== "failed";
  const btn = "inline-flex size-9 items-center justify-center rounded-full hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-35";

  return (
    <>
      <div
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={cn("relative inline-block max-w-full select-none", zoomed ? "cursor-grab touch-none active:cursor-grabbing" : "cursor-zoom-in touch-pan-y", className)}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: "0 0", willChange: "transform", ["--zoom" as string]: view.z }}
      >
        {showHi && (
          // Behind the boxes (they come later), over the preview; invisible until it has arrived.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hiRes!}
            alt=""
            aria-hidden
            draggable={false}
            decoding="async"
            onLoad={() => setHi("ready")}
            onError={() => setHi("failed")}
            className={cn("pointer-events-none absolute inset-0 h-full w-full", hi === "ready" ? "opacity-100" : "opacity-0")}
          />
        )}
        {children}
      </div>
      <div className="absolute bottom-2 right-2 z-10 flex items-center gap-0.5 rounded-full bg-black/65 p-0.5 text-white sm:bottom-3 sm:right-3" role="group" aria-label="Zoom">
        <button type="button" className={btn} onClick={() => zoomTo(view.z / STEP)} disabled={!zoomed} aria-label="Zoom out" title="Zoom out (-)">
          <Minus aria-hidden className="size-4" />
        </button>
        <span className="min-w-[3.25rem] text-center text-[12px] font-semibold tabular-nums" aria-live="polite">
          {Math.round(view.z * 100)}%
        </span>
        <button type="button" className={btn} onClick={() => zoomTo(view.z * STEP)} disabled={view.z >= Z_MAX} aria-label="Zoom in" title="Zoom in (Z or +, scroll, or double-click the photo)">
          <Plus aria-hidden className="size-4" />
        </button>
        <button type="button" className={btn} onClick={() => apply(FIT)} disabled={!zoomed} aria-label="Fit the photo" title="Fit (0)">
          <Maximize aria-hidden className="size-4" />
        </button>
        {showHi && hi === "loading" && <span className="px-1.5 text-[11px] text-white/75">Loading full size…</span>}
      </div>
    </>
  );
}

/** The full-size file the zoom swaps in (the hub's own copy only: never a paid download). */
export function fullSizeSrc(photoId: string, hash: string | null): string {
  return `/api/photo-delivery/download/${encodeURIComponent(photoId)}?which=current&v=${encodeURIComponent(hash ?? "")}`;
}
