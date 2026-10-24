/** Presentation groups for destinations that Sidebar has already authorized. */
const SIDEBAR_GROUPS = [
  // "/ops/checklist" is Your list (Oct 21 2026): first under More → Lists.
  { id: "daily", title: "Daily work", frequent: true, paths: ["/", "/ops/checklist", "/tasks", "/schedule", "/communications"] },
  // Oct 19 2026: photo delivery and the Shoots board (owner and office; the
  // photo desk view only for the creative manager since Oct 22). Every role
  // but editors reads these as doors of their role menu below.
  { id: "operations", title: "Operations", frequent: true, paths: ["/jobs", "/ops/photo-delivery", "/media", "/day"] },
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
// THE ROLE MENUS (Jordan, Oct 22 2026: "The 4 menus and alerts are good").
// Each of the four people who live in the hub gets the doors of their own
// day, in this order and with these labels, and everything else they can open
// folded under "More" in plain groups. Built from what each person actually
// opened in the 30 days before (People → Activity): Kyle never opened
// Messages, Schedule, Shoots or his checklist from the old six doors while
// the Editing Room (his most used page) sat under More; James's Upload Portal
// and Jordan's Editing Room and Monthly Content were buried the same way.
// Nothing is removed: a door is a label on a destination Sidebar already
// authorized, never a permission. Editors keep the groups above.
//
// Oct 19 2026's six office doors (Dashboard, Shoots, Photos, Videos,
// Messages, Schedule) were the first version of this; Schedule is now a tab
// on Shoots (one door reaches both pages).
//
// Oct 23 2026 (Jordan: "Instead of Photo and Video, I want it to be Photo
// Delivery and Video Delivery"): the photo desk's door reads Photo Delivery
// and the videos page's door Video Delivery, on every role menu that has
// them. Kyle's door read "Ready to send": it is Video Delivery too, so
// everyone says the same name, and it still opens that section. A
// photographer's "My Videos" is their own view and keeps its label.
// ---------------------------------------------------------------------------

/** The two delivery doors' one name each (Oct 23 2026). */
export const PHOTO_DELIVERY_LABEL = "Photo Delivery";
export const VIDEO_DELIVERY_LABEL = "Video Delivery";

/** One door: the destination it labels (`href`, what access and the active
 *  state are read from) and, when the door opens a section of that page, the
 *  link it actually follows (`link`). */
export type MenuDoor = { href: string; label: string; link?: string };

/** Jordan: oversight first, money under More (Finance leads it). */
export const OWNER_MENU: readonly MenuDoor[] = [
  { href: "/", label: "Dashboard" },
  { href: "/review", label: VIDEO_DELIVERY_LABEL },
  { href: "/editing", label: "Editing Room" },
  { href: "/content", label: "Monthly Content" },
  { href: "/ops/photo-delivery", label: PHOTO_DELIVERY_LABEL },
  { href: "/communications", label: "Messages" },
  { href: "/jobs", label: "Shoots" },
];

/** Kyle (the office): his list, the client inbox, photo approvals, the videos
 *  he sends (Video Delivery, opened at its Ready to send section), the
 *  Editing Room he works in most, and Shoots. */
export const OFFICE_MENU: readonly MenuDoor[] = [
  { href: "/", label: "Dashboard" },
  { href: "/ops/checklist", label: "Your list" },
  { href: "/communications", label: "Messages" },
  { href: "/ops/photo-delivery", label: PHOTO_DELIVERY_LABEL },
  { href: "/review", label: VIDEO_DELIVERY_LABEL, link: "/review#ready-to-send" },
  { href: "/editing", label: "Editing Room" },
  { href: "/jobs", label: "Shoots" },
];

/** James (the creative manager): the creative process end to end, his own
 *  uploads (he still shoots) and his scorecard. No office desks, no money.
 *  Photo Delivery (Jordan, Oct 22 2026): the photo desk, view only, to check
 *  photo quality across every job; it sits where the owner's menu has it. */
export const CREATIVE_MENU: readonly MenuDoor[] = [
  { href: "/", label: "Dashboard" },
  { href: "/review", label: VIDEO_DELIVERY_LABEL },
  { href: "/editing", label: "Editing Room" },
  { href: "/content", label: "Monthly Content" },
  { href: "/ops/photo-delivery", label: PHOTO_DELIVERY_LABEL },
  { href: "/upload", label: "Uploads" },
  { href: "/jobs", label: "Shoots" },
  { href: "/my-pay", label: "My Performance" },
];

/** Harrison and every photographer: the field day. The Editing Room is not a
 *  door for them (a shoot's brief still opens from the shoot); Help is the
 *  SOP Center, with Training, Ask the Hub and the problem report under More. */
export const FIELD_MENU: readonly MenuDoor[] = [
  { href: "/shoot", label: "My Shoots" },
  { href: "/upload", label: "Upload" },
  { href: "/review", label: "My Videos" },
  { href: "/my-pay", label: "My Performance" },
  { href: "/resources", label: "Help" },
];

/** The doors for a role; null = this role keeps the grouped menu (editors). */
export function menuFor(role: string | null | undefined): readonly MenuDoor[] | null {
  if (role == null || role === "OWNER") return OWNER_MENU;
  if (role === "ADMIN") return OFFICE_MENU;
  if (role === "CREATIVE_MANAGER") return CREATIVE_MENU;
  if (role === "PHOTOGRAPHER") return FIELD_MENU;
  return null;
}

/** Who gets a role menu (doors + More): everyone but editors (and unknown roles). */
export const usesRoleMenu = (role: string | null | undefined) => menuFor(role) != null;
/** @deprecated The Oct 19 name; every role menu, not only the office's. */
export const usesOfficeMenu = usesRoleMenu;

// MORE, IN PLAIN GROUPS (Oct 22 2026). The order puts each reader's next most
// useful screens first: money leads for the owner (nobody else has it), then
// lists and the schedule, the rest of the work, clients, the team, the
// reader's own page, reference and help, then settings.
const MORE_GROUPS = [
  { id: "money", title: "Money", paths: ["/sales", "/trends"] },
  { id: "lists", title: "Lists & schedule", paths: ["/ops/checklist", "/tasks", "/schedule", "/day"] },
  // Media (Oct 23 2026): the one door the media library adds, here under More, never a role door.
  { id: "work", title: "Work", paths: ["/", "/jobs", "/ops/photo-delivery", "/communications", "/review", "/media", "/editing", "/upload", "/shoot"] },
  { id: "clients", title: "Clients", paths: ["/content", "/content/activity", "/clients"] },
  { id: "team", title: "Team", paths: ["/users", "/quality", "/coaching", "/training"] },
  { id: "me", title: "Me", paths: ["/my-pay"] },
  { id: "reference", title: "Reference & help", paths: ["/resources/video-styles", "/resources", "/assistant"] },
  { id: "administration", title: "Settings", paths: ["/settings", "/connections", "/feedback"] },
] as const;

export function officeMenuDestinations<T extends Destination & { label: string; link?: string }>(items: readonly T[], pathname: string, role?: string | null) {
  const activeHref = activeSidebarHref(items, pathname);
  const primary: T[] = [];
  const doors = menuFor(role) ?? OWNER_MENU;
  for (const door of doors) {
    const item = items.find((i) => !i.external && i.href === door.href);
    if (item) primary.push({ ...item, label: door.label, ...(door.link ? { link: door.link } : {}) });
  }
  const isPrimary = (item: T) => primary.some((p) => p.href === item.href && !item.external);
  const rest = items.filter((item) => !isPrimary(item));
  const groupOf = (item: Destination) => item.external ? "reference" : MORE_GROUPS.find((g) => g.paths.some((href) => href === item.href))?.id ?? "administration";
  // More keeps its headings inside the fold (Jordan: "the menu should be
  // organized still when you click more").
  const restGroups = MORE_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    items: rest.filter((item) => groupOf(item) === group.id).sort((a, b) => {
      const rank = (item: Destination) => {
        const index = (group.paths as readonly string[]).findIndex((href) => href === item.href);
        return index < 0 ? group.paths.length : index;
      };
      return rank(a) - rank(b);
    }),
  })).filter((group) => group.items.length > 0);
  const ordered = restGroups.flatMap((group) => group.items);
  return [
    { id: "work", title: "Daily work", frequent: true, current: primary.some((item) => item.href === activeHref), activeHref, items: primary, subgroups: null },
    { id: "more", title: "More", frequent: false, current: ordered.some((item) => item.href === activeHref), activeHref, items: ordered, subgroups: restGroups },
  ].filter((group) => group.items.length > 0);
}
