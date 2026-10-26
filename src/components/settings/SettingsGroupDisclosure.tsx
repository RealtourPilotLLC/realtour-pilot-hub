"use client";

import { useContext, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { settingsCardMatches, settingsGroupMatches, type SettingsCardKey, type SettingsGroupDef } from "@/lib/settingsNavigation";
import { SettingsSearchContext } from "@/components/settings/SettingsSearchContext";
import { SETTINGS_GROUP_ICONS } from "@/components/settings/settingsIcons";
import { useHashView } from "@/components/ui/HashViews";
import { cn } from "@/lib/utils";

// A SECTION OF SETTINGS (Oct 26 2026): its heading, the sentence saying what
// it decides, its key values at a glance, then its cards. Shown while it is the
// open section or, during a search, while anything in it matches. Hidden, never
// unmounted, so unsaved input survives.
export function SettingsGroupDisclosure({ group, snapshot, children }: { group: SettingsGroupDef; snapshot?: ReactNode; children: ReactNode }) {
  const query = useContext(SettingsSearchContext);
  const view = useHashView();
  const searching = !!query.trim();
  const shown = searching ? settingsGroupMatches(group, query) : view === group.id;
  const Icon = SETTINGS_GROUP_ICONS[group.id];

  return <section id={group.id} data-view={group.id} data-settings-group={group.id} aria-labelledby={`${group.id}-heading`} hidden={!shown} className="scroll-mt-28 space-y-4">
    <header className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      {!searching && <a href="#overview" className="-mt-1 mb-2 inline-flex min-h-9 items-center gap-1 text-ui-status font-medium text-muted hover:text-foreground lg:hidden">
        <ArrowLeft aria-hidden className="size-3.5" /> All settings
      </a>}
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand"><Icon aria-hidden className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 id={`${group.id}-heading`} className="text-lg font-semibold tracking-tight">{group.title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">{group.summary}</p>
        </div>
      </div>
      {snapshot && <div className="mt-4 border-t border-border pt-4">{snapshot}</div>}
    </header>
    {children}
  </section>;
}

export function SettingsSearchCard({ settingKey, anchor, children }: { settingKey: SettingsCardKey; anchor?: string; children: ReactNode }) {
  const query = useContext(SettingsSearchContext);
  return <div data-settings-card={settingKey} id={anchor ?? settingKey} hidden={!settingsCardMatches(settingKey, query)} className="scroll-mt-28">{children}</div>;
}

/** The overview and the readiness report: shown while open, and never during a search. */
export function SettingsView({ id, className, children }: { id: "overview" | "readiness"; className?: string; children: ReactNode }) {
  const query = useContext(SettingsSearchContext);
  const view = useHashView();
  return <div id={id} data-view={id} hidden={!!query.trim() || view !== id} className={cn("scroll-mt-28", className)}>{children}</div>;
}
