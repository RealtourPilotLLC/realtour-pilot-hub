"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { matchesSearch } from "./topics";

// ---------------------------------------------------------------------------
// Search on Resources and SOPs (Jordan, Oct 27 2026). The page is drawn on the
// server; this box hides what does not match as you type: every item carries
// its words in `data-search` (title, summary or description, category and an
// SOP's own text), a topic with nothing left hides, and "Nothing matches" says
// so. Without JavaScript every item simply stays visible.
// ---------------------------------------------------------------------------

export function ResourceSearch({ children, label = "Search resources and SOPs" }: { children: React.ReactNode; label?: string }) {
  const [q, setQ] = useState("");
  const [none, setNone] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let shown = 0;
    for (const item of el.querySelectorAll<HTMLElement>("[data-search]")) {
      const ok = matchesSearch(item.dataset.search ?? "", q);
      item.hidden = !ok;
      if (ok) shown++;
    }
    for (const group of el.querySelectorAll<HTMLElement>("[data-search-group]")) {
      group.hidden = !!q.trim() && !group.querySelector("[data-search]:not([hidden])");
    }
    setNone(!!q.trim() && shown === 0);
  }, [q]);
  return (
    <div className="space-y-6">
      <label className="relative block max-w-xl">
        <span className="sr-only">{label}</span>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-2" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={label}
          data-resource-search
          className="min-h-11 w-full rounded-xl border border-border bg-surface pl-9 pr-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        />
      </label>
      {none && <p role="status" className="text-sm text-muted">Nothing matches &ldquo;{q.trim()}&rdquo;.</p>}
      <div ref={root} className="space-y-8">{children}</div>
    </div>
  );
}
