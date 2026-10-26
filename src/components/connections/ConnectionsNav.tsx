"use client";

import type { ReactNode } from "react";
import { Activity, Clapperboard, Landmark, LayoutGrid, Plug, RefreshCw } from "lucide-react";
import { HashViews, ViewNavLink } from "@/components/ui/HashViews";

// THE CONNECTIONS SHELL (Oct 26 2026, same shape as Settings): the section
// menu in a side column (chips that wrap on a phone), the open section beside
// it, opening on the overview. Bank accounts is a page of its own, so its
// entry is a plain link.

const ICONS = { overview: LayoutGrid, services: Plug, feeds: Activity, syncs: RefreshCw, media: Clapperboard, banks: Landmark } as const;
export type ConnectionsSectionId = keyof typeof ICONS;

export function ConnectionsNav({ sections, children }: { sections: { id: ConnectionsSectionId; label: string; href?: string; badge?: ReactNode }[]; children: ReactNode }) {
  return (
    <HashViews initial="overview" className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start lg:gap-8">
      <nav aria-label="Connections sections" className="mb-5 lg:sticky lg:top-4 lg:mb-0">
        <ul className="flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5">
          {sections.map((s) => (
            <li key={s.id} className={s.href ? "lg:mt-2 lg:border-t lg:border-border lg:pt-2" : undefined}>
              <ViewNavLink id={s.id} href={s.href} label={s.label} icon={ICONS[s.id]} badge={s.badge} />
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 space-y-4">{children}</div>
    </HashViews>
  );
}
