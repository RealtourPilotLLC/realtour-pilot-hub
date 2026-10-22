/** Presentation groups for destinations that Sidebar has already authorized. */
const SIDEBAR_GROUPS = [
  // "/ops/checklist" is Your list (Oct 21 2026): first under More → Lists.
  { id: "daily", title: "Daily work", frequent: true, paths: ["/", "/ops/checklist", "/tasks", "/schedule", "/communications"] },
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

// THE CREATIVE MANAGER'S DOORS (Oct 21 2026). The office's shape without
// the two office desks: Photos (photo delivery, Kyle's approval desk; the
// creative manager reviews photos on each shoot's job page) and Messages (the
// client inbox) give way to the Editing Room and the Content Program.
export const CREATIVE_MENU = [
  { href: "/", label: "Dashboard" },
  { href: "/jobs", label: "Shoots" },
  { href: "/review", label: "Videos" },
  { href: "/editing", label: "Editing Room" },
  { href: "/content", label: "Monthly Content" },
  { href: "/schedule", label: "Schedule" },
] as const;

/** Who gets the six-door menu: the owner, the office (ADMIN), the creative
 *  manager (their own doors, CREATIVE_MENU) and open local dev. */
export const usesOfficeMenu = (role: string | null | undefined) =>
  role == null || role === "OWNER" || role === "ADMIN" || role === "CREATIVE_MANAGER";

export function officeMenuDestinations<T extends Destination & { label: string }>(items: readonly T[], pathname: string, role?: string | null) {
  const activeHref = activeSidebarHref(items, pathname);
  const primary: T[] = [];
  const doors: readonly { href: string; label: string }[] = role === "CREATIVE_MANAGER" ? CREATIVE_MENU : OFFICE_MENU;
  for (const door of doors) {
    const item = items.find((i) => !i.external && i.href === door.href);
    if (item) primary.push({ ...item, label: door.label as string });
  }
  const isPrimary = (item: T) => primary.some((p) => p.href === item.href && !item.external);
  // More keeps the usual groups (Jordan: "the menu should be organized still
  // when you click more"): the same headings, in the same order, inside the fold.
  // What is left of "Daily work" and "Operations" once the six doors are out
  // (Your list, Tasks, My Day) reads as one "Lists" heading, first.
  const grouped = groupSidebarDestinations(items.filter((item) => !isPrimary(item)), pathname);
  const lists = grouped.filter((g) => g.id === "daily" || g.id === "operations").flatMap((g) => g.items);
  const restGroups = [
    ...(lists.length ? [{ id: "lists", title: "Lists", items: lists }] : []),
    ...grouped.filter((g) => g.id !== "daily" && g.id !== "operations").map((group) => ({ id: group.id, title: group.title, items: group.items })),
  ];
  const rest = restGroups.flatMap((group) => group.items);
  return [
    { id: "work", title: "Daily work", frequent: true, current: primary.some((item) => item.href === activeHref), activeHref, items: primary, subgroups: null },
    { id: "more", title: "More", frequent: false, current: rest.some((item) => item.href === activeHref), activeHref, items: rest, subgroups: restGroups },
  ].filter((group) => group.items.length > 0);
}
