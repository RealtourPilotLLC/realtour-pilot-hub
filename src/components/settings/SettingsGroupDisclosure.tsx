"use client";

import { useContext, useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { settingsCardMatches, settingsGroupMatches, type SettingsCardKey, type SettingsGroupDef } from "@/lib/settingsNavigation";
import { SettingsSearchContext } from "@/components/settings/SettingsSearchContext";

export function SettingsGroupDisclosure({ group, snapshot, children }: { group: SettingsGroupDef; snapshot?: ReactNode; children: ReactNode }) {
  const query = useContext(SettingsSearchContext);
  const ref = useRef<HTMLDetailsElement>(null);
  const matching = settingsGroupMatches(group, query);
  useEffect(() => {
    if (query.trim() && matching && ref.current) ref.current.open = true;
  }, [query, matching]);

  return <section id={group.id} data-settings-group={group.id} aria-labelledby={`${group.id}-heading`} hidden={!matching} className="scroll-mt-28">
    <details ref={ref} data-settings-disclosure className="group/settings-section rounded-2xl border border-border bg-surface">
      <summary className="block min-h-11 cursor-pointer list-none rounded-2xl p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
          <h2 id={`${group.id}-heading`} className="flex items-start justify-between gap-3 text-base font-semibold tracking-tight">
            {group.title}<ChevronDown aria-hidden className="mt-0.5 size-5 shrink-0 text-muted transition-transform group-open/settings-section:rotate-180" />
          </h2>
          <span className="mt-1 block text-sm leading-relaxed text-muted">{group.summary}</span>
          {snapshot && <span className="mt-2 block text-sm leading-relaxed text-foreground"><span className="font-medium">Loaded values: </span>{snapshot}</span>}
      </summary>
      {/* Keep forms mounted when collapsed or filtered so unsaved input survives. */}
      <div className="space-y-4 border-t border-border p-3 sm:p-4">{children}</div>
    </details>
  </section>;
}

export function SettingsSearchCard({ settingKey, anchor, children }: { settingKey: SettingsCardKey; anchor?: string; children: ReactNode }) {
  const query = useContext(SettingsSearchContext);
  return <div data-settings-card={settingKey} id={anchor ?? settingKey} hidden={!settingsCardMatches(settingKey, query)} className="scroll-mt-28">{children}</div>;
}

export function SettingsSearchOverview({ children }: { children: ReactNode }) {
  const query = useContext(SettingsSearchContext);
  return <div hidden={!!query.trim()}>{children}</div>;
}
