"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { settingsGroupMatches, type SettingsGroupDef } from "@/lib/settingsNavigation";
import { SettingsSearchContext } from "@/components/settings/SettingsSearchContext";

/** Open all disclosures around a legacy hash target, including nested cards. */
export function revealSettingsAnchor(root: HTMLElement, hash: string): boolean {
  let id: string;
  try { id = decodeURIComponent(hash.replace(/^#/, "")); } catch { return false; }
  const target = document.getElementById(id);
  if (!target || !root.contains(target)) return false;
  for (let node: HTMLElement | null = target; node && root.contains(node); node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
  // A group anchor belongs to the section just outside its disclosure.
  target.querySelector<HTMLDetailsElement>("details[data-settings-disclosure]")?.setAttribute("open", "");
  target.scrollIntoView({ block: "start" });
  const focus = target.matches("[data-settings-group]") ? target.querySelector<HTMLElement>("summary") : target;
  if (focus) { if (!focus.matches("a, button, input, select, textarea, summary, [tabindex]")) focus.tabIndex = -1; focus.focus({ preventScroll: true }); }
  return true;
}

// Plain anchors still work before hydration. Filtering is presentation only:
// every server-authorized group and form stays mounted with its current input.
export function SettingsNav({ groups, children }: { groups: SettingsGroupDef[]; children?: ReactNode }) {
  const [query, setQuery] = useState("");
  const [destination, setDestination] = useState<{ hash: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const matches = groups.filter((group) => settingsGroupMatches(group, query));
  const filtering = !!query.trim();
  useEffect(() => {
    if (root.current && window.location.hash) revealSettingsAnchor(root.current, window.location.hash);
    const onHash = () => { setQuery(""); setDestination({ hash: window.location.hash }); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => { if (destination && root.current) revealSettingsAnchor(root.current, destination.hash); }, [destination]);

  const chip = "inline-flex min-h-11 items-center rounded-full border border-border bg-surface px-3 text-sm font-medium text-muted transition-colors hover:border-brand/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
  return <SettingsSearchContext.Provider value={query}>
    <div ref={root} className="space-y-5" onClick={(event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href^='#']");
      if (!anchor || !event.currentTarget.contains(anchor)) return;
      const hash = anchor.getAttribute("href")!;
      let target: HTMLElement | null;
      try { target = document.getElementById(decodeURIComponent(hash.slice(1))); } catch { return; }
      if (!target || !event.currentTarget.contains(target)) return;
      event.preventDefault();
      if (window.location.hash !== hash) window.history.pushState(null, "", hash);
      setQuery("");
      setDestination({ hash });
    }}>
      <div className="space-y-3">
        <label htmlFor="settings-search" className="block text-sm font-semibold">Find a setting</label>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 focus-within:border-brand">
          <Search aria-hidden className="size-4 shrink-0 text-muted" />
          <input ref={search} id="settings-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try reviewer coverage, reminders, or quiet hours" className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none" aria-describedby="settings-search-help settings-search-results" />
          {filtering && <button type="button" className="min-h-11 rounded-md px-2 text-sm font-medium text-brand" onClick={() => { setQuery(""); search.current?.focus(); }}>Clear</button>}
        </div>
        <p id="settings-search-help" className="text-sm text-muted">Search setting labels. Each section keeps its own Save controls; searching or closing a section preserves your input.</p>
        <nav aria-label="Settings sections" data-settings-nav>
          <ul className="flex flex-wrap gap-1.5">
            <li><a href="#readiness" className={chip}>Readiness</a></li>
            {groups.map((group) => <li key={group.id}><a href={`#${group.id}`} className={chip}>{group.short}</a></li>)}
          </ul>
        </nav>
        <p id="settings-search-results" role="status" className="text-sm text-muted">{filtering ? `${matches.length} of ${groups.length} sections match “${query.trim()}”.` : "Choose a section to view its rules. Loaded values below describe the page when it was opened; Readiness explains dependencies and effective scope."}</p>
        {filtering && matches.length === 0 && <div className="rounded-xl border border-border bg-surface p-4 text-sm">
          <p className="font-medium">No setting labels match this search.</p>
          <p className="mt-1 text-muted">Try a shorter phrase or a section name. Your entered values are still here.</p>
          <button type="button" className="mt-2 min-h-11 rounded-lg border border-border px-3 font-medium text-brand" onClick={() => { setQuery(""); search.current?.focus(); }}>Show all settings</button>
        </div>}
      </div>
      {children}
    </div>
  </SettingsSearchContext.Provider>;
}
