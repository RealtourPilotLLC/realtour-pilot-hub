"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** Keep old block anchors usable when the optional routine is collapsed. */
export function HomeRoutine({ dayKey, current, attention, children }: { dayKey: string; current: string; attention: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const openTarget = (hash: string) => {
      let id: string;
      try { id = decodeURIComponent(hash.replace(/^#/, "")); } catch { return; }
      const target = document.getElementById(id);
      if (ref.current && target && (ref.current === target || ref.current.contains(target))) ref.current.open = true;
    };
    const onHash = () => openTarget(window.location.hash);
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      const href = link?.getAttribute("href");
      if (!href) return;
      const url = new URL(href, window.location.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search) openTarget(url.hash);
    };
    try { if (sessionStorage.getItem(`home-routine:${dayKey}`) === "open" && ref.current) ref.current.open = true; } catch { /* local preference is optional */ }
    onHash();
    document.addEventListener("click", onClick, true);
    window.addEventListener("hashchange", onHash);
    return () => { document.removeEventListener("click", onClick, true); window.removeEventListener("hashchange", onHash); };
  }, [dayKey]);
  return (
    <details id="operating-routine" ref={ref} className="group/routine scroll-mt-32 rounded-2xl border border-border bg-surface" onToggle={(event) => {
      try { sessionStorage.setItem(`home-routine:${dayKey}`, event.currentTarget.open ? "open" : "closed"); } catch { /* local preference is optional */ }
    }}>
      <summary className="flex min-h-14 cursor-pointer items-start gap-3 p-4 focus-visible:outline-2 focus-visible:outline-brand">
        <ChevronDown aria-hidden="true" className="mt-1 size-4 shrink-0 -rotate-90 group-open/routine:rotate-0" />
        <span>
          <span className="block text-base font-semibold">Daily operating checklist</span>
          <span className="mt-1 block text-sm text-muted">Current block: {current}. {attention}</span>
        </span>
      </summary>
      <div className="border-t border-border p-3 sm:p-4">{children}</div>
    </details>
  );
}
