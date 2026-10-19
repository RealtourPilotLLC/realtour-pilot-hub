/** Presentation groups for destinations that Sidebar has already authorized. */
const SIDEBAR_GROUPS = [
  { id: "daily", title: "Daily work", frequent: true, paths: ["/", "/tasks", "/schedule", "/communications"] },
  // Oct 19 2026: photo delivery and the Shoots board (owner and office). The
  // office's own logins see these as doors of the six-door menu below.
  { id: "operations", title: "Operations", frequent: true, paths: ["/jobs", "/ops/photo-delivery", "/day"] },
  { id: "production", title: "Production", frequent: true, paths: ["/editing", "/review", "/upload", "/shoot"] },
  // Open by default (Oct 5 2026): the office is onboarding clients into the
  // Content Program this week, and a folded group hid both doors.
  { id: "clients", title: "Clients", frequent: true, paths: ["/content", "/content/activity", "/clients"] },
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

// ---------------------------------------------------------------------------
// THE OFFICE MENU (Jordan, Oct 19 2026, night: one dashboard, six doors). The
// owner and every office login (ADMIN) get six doors, in this order and with
// these labels, and everything else they can open folded under "More".
// Nothing is removed: More holds every other authorized destination, in the
// usual group order. Editors and photographers keep the groups above.
// ---------------------------------------------------------------------------

export const OFFICE_MENU = [
  { href: "/", label: "Dashboard" },
  { href: "/jobs", label: "Shoots" },
  { href: "/ops/photo-delivery", label: "Photos" },
  { href: "/review", label: "Videos" },
  { href: "/communications", label: "Messages" },
  { href: "/schedule", label: "Schedule" },
] as const;

/** Who gets the six-door menu: the owner, the office (ADMIN), and open local dev. */
export const usesOfficeMenu = (role: string | null | undefined) => role == null || role === "OWNER" || role === "ADMIN";

export function officeMenuDestinations<T extends Destination & { label: string }>(items: readonly T[], pathname: string) {
  const activeHref = activeSidebarHref(items, pathname);
  const primary: T[] = [];
  for (const door of OFFICE_MENU) {
    const item = items.find((i) => !i.external && i.href === door.href);
    if (item) primary.push({ ...item, label: door.label as string });
  }
  const isPrimary = (item: T) => primary.some((p) => p.href === item.href && !item.external);
  const rest = groupSidebarDestinations(items.filter((item) => !isPrimary(item)), pathname).flatMap((group) => group.items);
  return [
    { id: "work", title: "Daily work", frequent: true, current: primary.some((item) => item.href === activeHref), activeHref, items: primary },
    { id: "more", title: "More", frequent: false, current: rest.some((item) => item.href === activeHref), activeHref, items: rest },
  ].filter((group) => group.items.length > 0);
}
