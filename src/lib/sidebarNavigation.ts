/** Presentation groups for destinations that Sidebar has already authorized. */
const SIDEBAR_GROUPS = [
  { id: "daily", title: "Daily work", frequent: true, paths: ["/", "/tasks", "/schedule", "/communications"] },
  { id: "production", title: "Production", frequent: true, paths: ["/editing", "/review", "/upload", "/shoot"] },
  // Open by default (Oct 5 2026): the office is onboarding clients into the
  // Content Program this week, and a folded group hid both doors.
  { id: "clients", title: "Clients", frequent: true, paths: ["/content", "/clients"] },
  { id: "team", title: "Team & learning", frequent: false, paths: ["/users", "/quality", "/coaching", "/training"] },
  { id: "reference", title: "Reference", frequent: false, paths: ["/resources/video-styles", "/resources", "/assistant"] },
  { id: "administration", title: "Administration", frequent: false, paths: ["/settings", "/connections", "/feedback", "/sales", "/trends", "/my-pay"] },
] as const;

type Destination = { href: string; external?: boolean };

/** Longest internal route wins, including resources and its Style Guide. */
export function activeSidebarHref(items: readonly Destination[], pathname: string): string | null {
  return items.filter((item) => !item.external && (item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

export function groupSidebarDestinations<T extends Destination>(items: readonly T[], pathname: string) {
  const activeHref = activeSidebarHref(items, pathname);
  const groupOf = (item: Destination) => item.external ? "reference" : SIDEBAR_GROUPS.find((group) => group.paths.some((href) => href === item.href))?.id ?? "administration";
  return SIDEBAR_GROUPS.map((group) => {
    const ordered = items.filter((item) => groupOf(item) === group.id).sort((a, b) => {
      const rank = (item: Destination) => {
        const index = group.paths.findIndex((href) => href === item.href);
        return index < 0 ? group.paths.length : index;
      };
      return rank(a) - rank(b);
    });
    return { id: group.id, title: group.title, frequent: group.frequent, current: ordered.some((item) => item.href === activeHref), activeHref, items: ordered };
  }).filter((group) => group.items.length > 0);
}
