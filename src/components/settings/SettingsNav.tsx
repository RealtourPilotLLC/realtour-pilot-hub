import type { SettingsGroupDef } from "@/components/settings/SettingsGroup";

// The section chips at the top of Settings (11-settings-grouping). Plain
// anchors, so they work before any script loads and a copied link lands on the
// group. They WRAP rather than scroll sideways: at 375 px a horizontal strip
// hides half the groups behind a swipe nobody knows to make, and a page that
// scrolls sideways is the one thing the phone layout must never do.
export function SettingsNav({ groups }: { groups: SettingsGroupDef[] }) {
  const chip =
    "inline-flex min-h-9 items-center rounded-full border border-border bg-surface px-3 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
  return (
    <nav aria-label="Settings sections" data-settings-nav>
      <ul className="flex flex-wrap gap-1.5">
        <li>
          <a href="#readiness" className={chip}>Readiness</a>
        </li>
        {groups.map((g) => (
          <li key={g.id}>
            <a href={`#${g.id}`} className={chip}>{g.short}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
