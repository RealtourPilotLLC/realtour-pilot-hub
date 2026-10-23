"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";

// ---------------------------------------------------------------------------
// A <details> "More" menu whose list can't be cut off (Oct 23 2026).
//
// Jordan's screenshot: the More menu on a monthly content script card opened
// past the card's bottom edge and the card (Section: overflow-hidden, rounded)
// clipped it, so only "Approve only (send later)" showed. An absolute list
// lives inside its card's box; this one is placed `position: fixed` against
// the screen when it opens, under the button when there is room and above it
// when there is not, so no ancestor's overflow can hide an item. Too tall for
// either side, it scrolls inside itself.
//
// The menu stays a <details>: its items are in the page from the first
// render (no portal), so Tab moves from More straight into them, Enter and
// Space on More open and close it, Escape closes it and puts focus back on
// More, and a press anywhere else closes it. Scrolling the page or resizing
// the window closes it too, rather than leave a fixed list floating away from
// its button.
// ---------------------------------------------------------------------------

const GAP = 4;
const EDGE = 8;

/**
 * Where the list goes, against the screen: under the button when it fits
 * there, else on whichever side has more room (above, when the button sits
 * low), never past the screen's edges; taller than that side, it scrolls.
 */
export function placeMenu(button: { top: number; bottom: number; left: number }, list: { width: number; height: number }, screen: { width: number; height: number }): { placement: "below" | "above"; style: CSSProperties } {
  const width = Math.min(list.width, screen.width - EDGE * 2);
  const below = screen.height - button.bottom - GAP - EDGE;
  const above = button.top - GAP - EDGE;
  const up = list.height > below && above > below;
  const left = Math.max(EDGE, Math.min(button.left, screen.width - width - EDGE));
  const base: CSSProperties = { position: "fixed", left, right: "auto", margin: 0, overflowY: "auto" };
  return up
    ? { placement: "above", style: { ...base, top: "auto", bottom: screen.height - button.top + GAP, maxHeight: Math.max(above, 0) } }
    : { placement: "below", style: { ...base, top: button.bottom + GAP, bottom: "auto", maxHeight: Math.max(below, 0) } };
}

export function useDetailsMenu() {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<CSSProperties | null>(null);

  const close = useCallback((focusButton = false) => {
    setOpen(false);
    setPlaced(null);
    if (focusButton) detailsRef.current?.querySelector("summary")?.focus();
  }, []);

  // The browser's own toggle is replaced so the list is placed before it is
  // painted (a native toggle would show it clipped for a frame first).
  const onSummaryClick = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    if (open) close();
    else setOpen(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDetailsElement>) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    const summary = detailsRef.current?.querySelector("summary");
    const panel = panelRef.current;
    if (!summary || !panel) return;
    const r = summary.getBoundingClientRect();
    setPlaced(placeMenu(r, { width: panel.offsetWidth, height: panel.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }).style);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!detailsRef.current?.contains(e.target as Node)) close();
    };
    const moved = (e: Event) => {
      // The list's own scroll is not the page moving.
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      const inside = !!detailsRef.current?.contains(document.activeElement);
      close(inside);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [open, close]);

  return {
    /** On the <details>. */
    detailsProps: { ref: detailsRef, open, onKeyDown },
    /** On the <summary>. */
    summaryProps: { onClick: onSummaryClick, "aria-expanded": open },
    /** On the list. Unplaced (the first render, or no script yet) it keeps its own classes. */
    panelProps: { ref: panelRef, style: placed ?? undefined },
    open,
    close,
  };
}
