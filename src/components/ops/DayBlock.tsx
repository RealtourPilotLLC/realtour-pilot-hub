"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// One time block on the home, as a <details> whose open state the PAGE
// decides and the PERSON can override.
//
// Until Sep 8 every block with anything in it rendered open, so at noon on an
// ordinary day 14 of 15 were expanded and the home was a 1,100-line wall
// (audit5 kyle-home F19). Now the server says which ONE block opens by default
// (page.tsx blockOpensByDefault — the block whose window holds now), and:
//   · a click on the header opens or closes any block. An OPEN sticks for the
//     session (sessionStorage, keyed by ET day, so a tab left open overnight
//     starts tomorrow fresh); a CLOSE holds only until the page's default
//     moves onto that block — Kyle peeking at QC at 9:10 and shutting it must
//     not leave the 9:30 "Now" block collapsed for the rest of the day
//     (review, Sep 8), so a close is never written to storage and a stored
//     open is dropped when the block is closed by hand;
//   · a jump — the jump bar, a "What needs you" row, a "N overdue →" link —
//     opens the block it lands on (DayBlockJumps below), since a closed
//     <details> would otherwise scroll into view still shut;
//   · the 90-second AutoRefresh re-renders the server props without touching
//     this state, so a block Kyle opened stays open through the refresh and
//     the default moves on to the next block on its own.
// No server import anywhere in here — it is a client component.
// ---------------------------------------------------------------------------

/** window event: open the block whose id is the detail (a jump landed on it) */
const OPEN_EVENT = "rtp:open-block";
const storageKey = (dayKey: string, id: string) => `rtp-block:${dayKey}:${id}`;

// decodeURIComponent throws a URIError on a malformed escape ("/#%E0"), and a
// throw inside a mount effect would blank the whole home through error.tsx
// (review, Sep 8). A hash we can't decode is simply not a block's id.
const safeDecode = (s: string): string => {
  try { return decodeURIComponent(s); } catch { return s; }
};
const hashKey = (): string => safeDecode(window.location.hash.replace(/^#/, ""));

export function DayBlock({ id, defaultOpen, dayKey, className, summaryClassName, summary, children }: {
  id: string;
  /** the page's answer for this render — the block in the current window */
  defaultOpen: boolean;
  /** ET calendar day, so yesterday's choices don't carry over */
  dayKey: string;
  className?: string;
  summaryClassName?: string;
  /** the header row (icon, title, time, count) — rendered by the server */
  summary: ReactNode;
  children: ReactNode;
}) {
  // null = follow the page's default; true/false = the person chose.
  const [choice, setChoice] = useState<boolean | null>(null);

  // Restore the session's choice after mount (never during render — the
  // server HTML and the first client render have to match). Only opens are
  // stored, so this can only ever open. A page that loaded with this block's
  // #hash (a bell link to /#loops) opens it here too: DayBlockJumps sits
  // above the blocks in the tree, so its mount effect would fire before these
  // listeners exist and the deep link would land shut.
  useEffect(() => {
    let v: string | null = null;
    try { v = sessionStorage.getItem(storageKey(dayKey, id)); } catch { /* private mode etc. */ }
    const landedHere = typeof window !== "undefined" && hashKey() === id;
    setChoice(landedHere || v === "1" ? true : null);
  }, [dayKey, id]);

  // The clock moved this block into its window (the default flipped to open):
  // a close made earlier in the session is forgotten so the "Now" block shows.
  useEffect(() => {
    if (defaultOpen) setChoice((c) => (c === false ? null : c));
  }, [defaultOpen]);

  // A jump landed here → open, and remember it like a click.
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return;
      setChoice(true);
      try { sessionStorage.setItem(storageKey(dayKey, id), "1"); } catch { /* ignore */ }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [dayKey, id]);

  const open = choice ?? defaultOpen;
  const toggle = (e: MouseEvent<HTMLElement>) => {
    // Controlled: React owns the `open` attribute, so the native toggle must
    // not fire underneath it (it would flip the DOM and leave state behind).
    e.preventDefault();
    const next = !open;
    setChoice(next);
    try {
      if (next) sessionStorage.setItem(storageKey(dayKey, id), "1");
      else sessionStorage.removeItem(storageKey(dayKey, id));
    } catch { /* ignore */ }
  };

  return (
    <details id={id} open={open} className={className}>
      <summary onClick={toggle} className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  );
}

/**
 * Render once beside the blocks. Turns every in-page anchor click (and a later
 * #hash change) into an OPEN_EVENT for the matching block, so a jump never
 * lands on a collapsed card; the hash the page LOADED with is handled by each
 * DayBlock on mount (see above). Anchors that point at a section rather than
 * a block ("#shoots", "#needs-you") dispatch too — nobody is listening, which
 * is fine.
 */
export function DayBlockJumps() {
  useEffect(() => {
    const dispatch = (key: string) => {
      if (key) window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: key }));
    };
    const fromHash = () => dispatch(hashKey());
    // Capture phase, so it runs before next/link's own handler and before the
    // browser scrolls; the block is open by the time the scroll lands.
    const onClick = (e: globalThis.MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      const i = href.indexOf("#");
      if (i < 0) return;
      const path = href.slice(0, i);
      if (path && path !== window.location.pathname) return; // another page's anchor
      dispatch(safeDecode(href.slice(i + 1)));
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("hashchange", fromHash);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("hashchange", fromHash);
    };
  }, []);
  return null;
}
