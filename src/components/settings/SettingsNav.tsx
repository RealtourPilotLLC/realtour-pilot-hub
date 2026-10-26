"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Gauge, LayoutGrid, Search } from "lucide-react";
import { settingsGroupMatches, type SettingsGroupDef } from "@/lib/settingsNavigation";
import { SettingsSearchContext } from "@/components/settings/SettingsSearchContext";
import { SETTINGS_GROUP_ICONS } from "@/components/settings/settingsIcons";
import { HashViews, ViewNavLink } from "@/components/ui/HashViews";

// THE SETTINGS SHELL (Oct 26 2026): search and the section menu in a side
// column (chips that wrap on a phone), the open section beside it. Opens on
// the overview; #team, #coaching and every other anchor open their section
// (components/ui/HashViews). Searching shows every matching card at once, in
// its section. Filtering and switching are presentation only: every
// server-authorized group and form stays mounted with its current input.
export function SettingsNav({ groups, badges, children }: { groups: SettingsGroupDef[]; badges?: Partial<Record<string, ReactNode>>; children?: ReactNode }) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const matches = groups.filter((group) => settingsGroupMatches(group, query));
  const filtering = !!query.trim();
  const clear = useCallback(() => setQuery(""), []);

  return <SettingsSearchContext.Provider value={query}>
    <HashViews initial="overview" onNavigate={clear} className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start lg:gap-8">
      <aside className="mb-5 space-y-3 lg:sticky lg:top-4 lg:mb-0">
        <label htmlFor="settings-search" className="sr-only">Find a setting</label>
        <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 focus-within:border-brand">
          <Search aria-hidden className="size-4 shrink-0 text-muted" />
          <input ref={search} id="settings-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a setting" className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none lg:text-sm" aria-describedby="settings-search-results" />
          {filtering && <button type="button" className="min-h-11 rounded-md px-1 text-sm font-medium text-brand" onClick={() => { setQuery(""); search.current?.focus(); }}>Clear</button>}
        </div>
        <nav aria-label="Settings sections" data-settings-nav>
          <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5">
            <li><ViewNavLink id="overview" label="Overview" icon={LayoutGrid} inactive={filtering} /></li>
            {groups.map((group) => <li key={group.id}><ViewNavLink id={group.id} label={group.short} icon={SETTINGS_GROUP_ICONS[group.id]} badge={badges?.[group.id]} inactive={filtering} /></li>)}
            <li className="lg:mt-2 lg:border-t lg:border-border lg:pt-2"><ViewNavLink id="readiness" label="Readiness" icon={Gauge} badge={badges?.readiness} inactive={filtering} /></li>
          </ul>
        </nav>
      </aside>
      <div className="min-w-0 space-y-4">
        <p id="settings-search-results" role="status" className={filtering ? "text-sm text-muted" : "sr-only"}>{filtering ? `${matches.length} of ${groups.length} sections match “${query.trim()}”. Clear the search to go back.` : "Choose a section to see its settings. Each card keeps its own Save."}</p>
        {filtering && matches.length === 0 && <div className="rounded-2xl border border-border bg-surface p-4 text-sm">
          <p className="font-medium">No setting labels match this search.</p>
          <p className="mt-1 text-muted">Try a shorter phrase or a section name. Your entered values are still here.</p>
          <button type="button" className="mt-2 min-h-11 rounded-lg border border-border px-3 font-medium text-brand" onClick={() => { setQuery(""); search.current?.focus(); }}>Show all settings</button>
        </div>}
        {children}
      </div>
    </HashViews>
  </SettingsSearchContext.Provider>;
}
