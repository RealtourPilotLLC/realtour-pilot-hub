"use client";

import Link from "next/link";
import { useId } from "react";
import { BrandWordmark } from "@/components/Brand";
import { usePathname } from "next/navigation";
import {
  Activity,
  Clapperboard,
  House,
  Sun,
  Images,
  SlidersHorizontal,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  CalendarDays,
  Camera,
  MessageCircle,
  Users,
  DollarSign,
  TrendingUp,
  Wallet,
  Palette,
  BookOpen,
  GraduationCap,
  Upload,
  MessageSquare,
  MessageSquareHeart,
  MessageSquarePlus,
  MonitorPlay,
  Radar,
  IdCard,
  Plug,
  LogOut,
  PenLine,
  ExternalLink,
  ChevronDown,
  Film,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { canAccess, isCreativeLead, isOffice, parsePermissions, ROLE_LABEL, type PageKey } from "@/lib/auth/access";
import { NotificationsBell } from "@/components/NotificationsBell";
import { MessagesButton } from "@/components/comms/MessagesButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Avatar } from "@/components/ui/Avatar";
import { groupSidebarDestinations, officeMenuDestinations, OTHER_PAGES_ARIA, PHOTO_DELIVERY_LABEL, PROJECTS_LABEL, usesRoleMenu, VIDEO_DELIVERY_LABEL } from "@/lib/sidebarNavigation";

export type ShellUser = {
  name: string | null;
  email: string;
  role: string;
  permissions?: string | null;
  impersonating?: boolean;
  realName?: string | null;
  /** Oct 14 2026: pay is hidden for this login, so "My Pay" is their performance and bonus page. */
  payHidden?: boolean;
  /** Oct 30 2026: their profile photo (lib/teamPhoto), null for the initials. */
  photoSrc?: string | null;
};

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  key?: PageKey; // internal pages carry a PageKey for role-gating
  soon?: boolean;
  external?: boolean; // opens in a new tab (e.g. the Script Studio app)
  /** Oct 22 2026: a role door that opens a section of its page (Kyle's
   *  Video Delivery → /review#ready-to-send). `href` stays the destination
   *  that access and the active state are read from. */
  link?: string;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const SECTIONS: NavSection[] = [
  {
    title: "Operations",
    items: [
      // THE DASHBOARD (Jordan, Oct 19 2026, night: "The home page should
      // really be a dashboard to oversee everything going on, and then the
      // other pages are for more in-depth adjustments and changes"). "/" is
      // one dashboard for the owner and the office; the first of the six
      // doors (sidebarNavigation's role menus set the door labels; Oct 23
      // 2026: Photo Delivery and Video Delivery). Retired into
      // it over time, routes untouched and reachable by URL:
      //   · Ops Day (/ops)          — Sep 2 into Home; on Oct 19 "Shoots and
      //                               exceptions", that night a redirect to the
      //                               dashboard (Kyle's checklist is its own
      //                               page, /ops/checklist, behind "Kyle's day").
      //   · My Day (/day)           — the owner's own list; under More since
      //                               it left the dashboard (Oct 19 night).
      //   · Project Tracker (/pipeline) — the delivery board; the Shoots board
      //                               (/jobs) is its successor.
      // Nothing in this hub is deleted for being off the menu.
      { label: "Dashboard", href: "/", icon: LayoutDashboard, key: "dashboard" },
      // SHOOTS (Oct 19 2026, night; Jordan renamed "Jobs" to "Shoots"): every
      // shoot in progress with its photos and video side by side. The
      // `pipeline` PageKey: /jobs is that page in PAGES, so it is what the
      // middleware and the page itself check (Oct 20 2026, audit A21: the door
      // tested `ops`, so an override on either key showed a door that bounced
      // or hid one that worked). Owner + office by default, as before.
      // Oct 27 2026 (Jordan's Loom): "Projects" (PROJECTS_LABEL), every photo,
      // video, floor plan and tour per job; the route stays /jobs.
      { label: PROJECTS_LABEL, href: "/jobs", icon: House, key: "pipeline" },
      // Today + Daily Tasks + Task History merged into the one Tasks hub
      // (tabs: Today / Board / Done) — Jordan: "the toolbar has too many things".
      { label: "Tasks", href: "/tasks", icon: ListTodo, key: "tasks" },
      // The owner's quality desk — cuts to review, photo QC, feedback loops.
      // "Video Review Room" (Jordan, Oct 19 2026): the label only; the /review
      // route and the `review` PageKey keep their names. "Videos" in the
      // six-door menu (owner and office); photographers keep this label.
      // Oct 22 2026: "Videos" everywhere (the page went by three names).
      // Oct 23 2026 (Jordan): "Video Delivery", on every menu, Kyle's door
      // included (it read "Ready to send"); only a photographer's own door
      // keeps "My Videos" (sidebarNavigation FIELD_MENU).
      { label: VIDEO_DELIVERY_LABEL, href: "/review", icon: MonitorPlay, key: "review" },
      // PHOTO DELIVERY (Oct 14 2026, docs/photo-delivery): the queue, AI QC,
      // the AutoHDR Fix Cart and the delivery check. Its own `photos` PageKey
      // since Oct 22 2026 (it rode `ops` before): owner and office, and the
      // creative manager, who reads the desk VIEW ONLY. "Photo Delivery" on
      // every menu (Oct 23 2026, Jordan; it read "Photos" on the role menus).
      // The old /ops/video-delivery screen, Special requests, Scheduling and
      // Old items stopped being menu entries on Oct 19 2026 (Kyle's checklist
      // holds them), and so did Messages (/ops/messages, merged into
      // Communications, which is "Messages" in the six-door menu) and Shoots &
      // exceptions (/ops, now the dashboard) that night.
      { label: PHOTO_DELIVERY_LABEL, href: "/ops/photo-delivery", icon: Images, key: "photos" },
      // MEDIA (Oct 23 2026): every finished video and listing, by type and
      // date, to watch and download. One door under More (Jordan: "don't
      // change the menu"): owner, office and creative manager.
      { label: "Media", href: "/media", icon: Film, key: "media" },
      // YOUR LIST (Jordan, Oct 21 2026; audit A9): the daily checklist
      // (/ops/checklist) gets a door of its own under More → Lists. Same key
      // the page checks (`ops`), and only for owner and office logins, who
      // are the only ones the page lets in (filtered below). An office login
      // sees their own list; the owner sees Kyle's, as on the dashboard card.
      { label: "Your list", href: "/ops/checklist", icon: ListChecks, key: "ops" },
      // The owner's own list and day plan (ownerOnly PageKey "day").
      { label: "My Day", href: "/day", icon: Sun, key: "day" },
      // Feedback about the WORK: what clients said (the delivery-text form +
      // unhappy texts/emails) and how each photographer is shooting. Distinct
      // from "Feedback & requests" in System, which is feedback about the HUB.
      // It rides the `review` PageKey the same way Style Guide rides
      // `resources`: identical audience (owner + admin; creatives read their
      // own results on /shoot/feedback), so no new permission to grant and a
      // per-user `review` override carries here too.
      { label: "Team feedback", href: "/quality", icon: MessageSquareHeart, key: "review" },
      // Feedback about how we TALK to clients: the end-of-day audit of the
      // messages the office sent from the company line, and the one-thing-to-try
      // note it writes (Jordan, Sep 21 2026). It sits next to Client & Team
      // Feedback because it is the same desk — that one is about the work, this
      // one is about the conversation.
      //
      // Rides the `review` PageKey, exactly as its neighbour does: same audience
      // (owner + admin), so no new permission to grant and a per-user `review`
      // override carries here too. /coaching itself has no PageKey, so
      // middleware only checks you are signed in and the page's own owner /
      // coached-roster check is the real gate — see the header comment there.
      { label: "Communication coaching", href: "/coaching", icon: Radar, key: "review" },
      // "Project Tracker" (/pipeline) retired from the nav — its delivery board
      // is the Production Pipeline block on Home. Route + PageKey stay.
      // Schedule now carries the Map as its ?view=map tab (List | Map toggle in
      // the header), so the standalone "Map" item is gone — one appointment
      // window, two views that can't drift apart.
      { label: "Schedule", href: "/schedule", icon: CalendarDays, key: "schedule" },
      { label: "Communications", href: "/communications", icon: MessageCircle, key: "communications" },
      // Client Assets is a TAB on the Clients page (header action), not a nav
      // item — Jordan: "client assets should be in the clients tab".
      { label: "Clients", href: "/clients", icon: Users, key: "clients" },
      { label: "Monthly Content", href: "/content", icon: Clapperboard, key: "content" },
      // Oct 14 2026 (Jordan): every program client's portal activity. Owner and admin only (filtered below).
      { label: "Client activity", href: "/content/activity", icon: Activity, key: "content" },
      // People = the merged Team (workload cards, admin-visible) + Logins &
      // access (AppUser allowlist, owner-only) hub. Lives in Operations next to
      // Clients — both are "who we work with" directories, and it reads cleaner
      // here than buried in System. The old System "Users" item is gone.
      { label: "People", href: "/users", icon: IdCard, key: "users" },
    ],
  },
  {
    title: "Creative",
    items: [
      { label: "My Shoots", href: "/shoot", icon: Camera, key: "shoot" },
      { label: "My Pay", href: "/my-pay", icon: Wallet, key: "mypay" },
      { label: "Upload Portal", href: "/upload", icon: Upload, key: "upload" },
      // "Editing Room" is the label only (Jordan, Sep 2: "Instead of editor
      // queue, I want it to be called Editing Room"). The /editing route, the
      // `editing` PageKey and the editorQueue.ts helpers keep their names.
      { label: "Editing Room", href: "/editing", icon: Palette, key: "editing" },
      // The editors' reference: video types, style specs, example players,
      // music + tools. Jordan: "everything all in one spot for the editors."
      // Rides the `resources` PageKey (every role has it), so no new
      // permission — the page lives at /resources/video-styles and middleware
      // already resolves that path to `resources`.
      // Editors/admin/owner only — it is the video-editing reference, pure
      // clutter in a field shooter's small menu (audit).
      { label: "Style Guide", href: "/resources/video-styles", icon: Clapperboard, key: "resources" },
    ],
  },
  {
    // Finance = Revenue (old Sales Tracker) + Unpaid (old Billing) + Payroll
    // (old Payouts) as one page's tabs. The three-item "Sales & Finance" section
    // collapses to a single item. Service Catalog moved out to Knowledge (it's a
    // price reference, not money that moves). Marketing is retired from the nav
    // and its coming-soon page is gone (there is no /marketing route); add a
    // page and an item here if social scheduling ever ships.
    title: "Finance",
    items: [
      { label: "Finance", href: "/sales", icon: DollarSign, key: "sales" },
      { label: "Trends", href: "/trends", icon: TrendingUp, key: "trends" },
    ],
  },
  {
    title: "Knowledge",
    items: [
      { label: "Resources & SOPs", href: "/resources", icon: BookOpen, key: "resources" },
      // Service Catalog folded into Resources (audit: zero opens in all
      // recorded history as a top-level door; the page itself stays reachable
      // from the Resources page).
      { label: "Training", href: "/training", icon: GraduationCap, key: "training" },
      { label: "Ask the Hub", href: "/assistant", icon: MessageSquare, key: "assistant" },
    ],
  },
  {
    title: "System",
    items: [
      // The HUB's own board — features to build, bugs to fix. Every role files
      // here. Feedback about the WORK is "Client & Team Feedback" in Operations.
      { label: "Report a hub problem", href: "/feedback", icon: MessageSquarePlus, key: "feedback" },
      { label: "Settings", href: "/settings", icon: SlidersHorizontal, key: "settings" },
      { label: "Connections", href: "/connections", icon: Plug, key: "connections" },
    ],
  },
];


export function Sidebar({ user, scriptingUrl, onNavigate }: { user?: ShellUser | null; scriptingUrl?: string | null; onNavigate?: () => void }) {
  const pathname = usePathname();
  const navigationId = useId(); // Desktop and drawer sidebars are both mounted.
  // When signed in, hide pages this person can't open. When not signed in (gate
  // still off, pre-cutover), show everything so the open app is unchanged.
  const can = (item: NavItem) => (item.key ? !user || canAccess(user, item.key) : true);
  // External link to the Script Studio app — owner/admin only, and only when it's
  // configured (SCRIPTING_BASE_URL set). Injected into the Creative section.
  // Owner-only — the blanket-ADMIN external link put a scripting product Kyle
  // never uses in his menu (audit; a per-user grant needs a real PageKey first).
  const showScripting = !!scriptingUrl && (!user || user.role === "OWNER");
  // Creatives see /resources as a pure "SOP Center" (no forms/quick links), so
  // the nav label matches what the page actually is for them.
  const creative = !!user && (user.role === "EDITOR" || user.role === "PHOTOGRAPHER");
  // Parsed ONCE per render (was re-parsed twice per section — audit).
  const perms = parsePermissions(user?.permissions);
  const authorized = SECTIONS.map((s) => {
    let items = s.items.filter(can);
    // Match on href, not key: the Creative "Style Guide" item also carries the
    // `resources` key (it rides that permission) and must keep its own label.
    if (creative) items = items.map((i) => (i.href === "/resources" ? { ...i, label: "SOP Center" } : i));
    // Style Guide is the video-editing reference — photographers don't need it.
    // "Client & Team Feedback" (/quality) rides the same `review` key the Review
    // Room does, and that page redirects anyone who isn't owner/admin — so a
    // photographer has been carrying a nav item that bounced them home since it
    // shipped. /review itself answers them properly now (Sep 18); this one still
    // doesn't, so it comes off their menu rather than staying a dead door.
    //
    // "Comms coaching" comes off their menu for a different reason: the page
    // works for them (a photographer on the coached roster reads their own
    // notes there), but the roster is empty by default and today the people who
    // answer the company line are the ops desk. A menu item that says "nothing
    // here for you" to five photographers is the dead door this filter exists
    // to prevent — and the Slack note a coached person receives carries the
    // link, so nobody who IS coached has to find it in a menu.
    // Oct 22 2026 (Jordan's approved menus): the Editing Room is no door for a
    // photographer either. Their read-only board is still there by URL, and a
    // shoot's own page links its brief; the menu was leading with it.
    if (user && user.role === "PHOTOGRAPHER") {
      items = items.filter(
        (i) => i.href !== "/resources/video-styles" && i.href !== "/quality" && i.href !== "/coaching" && i.href !== "/editing",
      );
    }
    // Oct 22 2026: the Style Guide (the editors' reference) and Communication
    // coaching are off the office's menu; both stay reachable by URL, and the
    // coaching note Kyle receives carries its own link.
    if (user && user.role === "ADMIN") items = items.filter((i) => i.href !== "/resources/video-styles" && i.href !== "/coaching");
    // The creative manager (Oct 21 2026) keeps Client & Team Feedback (their
    // photographer and editor tabs) but not Communication coaching: that page
    // is about how the office answers clients on the company line.
    // Oct 22 2026: Photo Delivery is one of their doors now (the desk, view only:
    // its `photos` key); Your list stays off their menu (the filter below).
    if (user && user.role === "CREATIVE_MANAGER") items = items.filter((i) => i.href !== "/coaching");
    // The photo desk's pages admit the owner, the office and the creative
    // manager only (Oct 22 2026), so a `photos` override on anyone else
    // would be a door that bounces.
    // …unless Jordan granted Photo Delivery by name (Oct 23 2026 audit: he gave
    // Harrison the page and the door never showed); the desk admits them view only.
    if (user && !isCreativeLead(user.role) && !canAccess(user, "photos")) items = items.filter((i) => i.href !== "/ops/photo-delivery");
    // The media library is staff-only (lib/mediaAccess).
    if (user && !isCreativeLead(user.role)) items = items.filter((i) => i.href !== "/media");
    // Client activity is the owner's, the admin's and the creative manager's
    // view of the content program (the page redirects anyone else).
    if (user && !isCreativeLead(user.role)) items = items.filter((i) => i.href !== "/content/activity");
    // So is Your list (Oct 21 2026): the checklist page sends anyone else home.
    if (user && user.role !== "OWNER" && user.role !== "ADMIN") items = items.filter((i) => i.href !== "/ops/checklist");
    // The owner's door opens Kyle's list (the page's default for the owner), so it isn't "Your list" there.
    if (!user || user.role === "OWNER") items = items.map((i) => (i.href === "/ops/checklist" ? { ...i, label: "Daily checklist" } : i));
    // "My Pay" is a person's own payout view. Photographers always have it;
    // owner/admin see it ONLY with an explicit mypay:true override (James:
    // admin powers for the creative-manager role, his own pay visible, the
    // company financials blocked). The blanket role filter here was eating
    // the override (Aug 24).
    // Oct 21 2026: the creative manager holds it by role default (My
    // Performance), so the filter only strips it from the owner and the
    // office; canAccess has already answered for everyone else, overrides
    // included in both directions.
    const mypayGranted = "mypay" in perms && perms.mypay;
    if (user && isOffice(user.role) && !mypayGranted) items = items.filter((i) => i.key !== "mypay");
    // Oct 14 2026: with pay hidden, the same page is their performance and bonus tracker.
    if (user?.payHidden) items = items.map((i) => (i.key === "mypay" ? { ...i, label: "My Performance" } : i));
    if (showScripting && s.title === "Creative") {
      items = [...items, { label: "Script Writing", href: scriptingUrl!, icon: PenLine, external: true }];
    }
    return { ...s, items };
  }).filter((s) => s.items.length > 0);

  // Group only AFTER the existing access rules and role exceptions. These
  // categories are navigation, never new permissions or replacement pages.
  // The owner, the office, the creative manager and photographers each get
  // their own doors with the rest folded under More (sidebarNavigation's role
  // menus, Oct 22 2026); editors keep the groups.
  const destinations = authorized.flatMap((section) => section.items);
  const sections = usesRoleMenu(user?.role) ? officeMenuDestinations(destinations, pathname, user?.role) : groupSidebarDestinations(destinations, pathname);
  const renderItem = (item: NavItem) => {
    const active = sections.some((section) => section.activeHref === item.href);
    const Icon = item.icon;
    const content = <>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="flex-1">{item.label}</span>
      {item.external && <ExternalLink className="size-3.5 shrink-0 text-muted-2" aria-hidden />}
      {item.soon && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-2">soon</span>}
    </>;
    const classes = cn(
      "flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
      active ? "bg-brand-soft text-brand ring-1 ring-inset ring-brand/20" : "text-muted hover:bg-surface-2 hover:text-foreground",
      item.soon && "cursor-default opacity-60 hover:bg-transparent",
    );
    return item.soon ? <div key={item.href} className={classes} title="Coming in a later milestone">{content}</div>
      : item.external ? <a key={item.href} href={item.href} target="_blank" rel="noopener noreferrer" className={classes} onClick={onNavigate}>{content}</a>
      : <Link key={item.href} href={item.link ?? item.href} aria-current={active ? "page" : undefined} className={classes} onClick={onNavigate}>{content}</Link>;
  };

  return (
    // relative: the notification-bell panel anchors to the sidebar (opens upward).
    <aside className="relative flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface/95 backdrop-blur-xl lg:bg-surface/60">
      <div className="flex items-center gap-3 px-5 py-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
<img src="/brand/mark.svg" alt="Realtour Pilot" className="flex size-9 rounded-xl shadow-lg bg-white p-1" />
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">
            <BrandWordmark className="h-4" />
          </div>
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">Operations Hub</div>
        </div>
      </div>

      <nav aria-label="Staff navigation" className="flex-1 space-y-3 overflow-y-auto scroll-thin px-3 py-2">
        {sections.map((section) => {
          // If overrides remove all normal work doors, the first authorized
          // group still provides a visible initial link for the mobile drawer.
          // Every section stays open (Oct 23 2026, Jordan: "remove the 'more'
          // dropdown on the menu and just keep it open"). The fold below stays
          // for a section a future menu marks folded on purpose.
          const expanded: boolean = true;
          // Reporting a broken hub must remain one click away even when the
          // administrative pages are folded. Preserve its existing grant.
          const shortcut = !expanded ? section.items.filter((item) => item.href === "/feedback") : [];
          const folded = section.items.filter((item) => !shortcut.includes(item));
          // The role menu's other pages keep their groups' headings. With no
          // "More" title above them (Jordan, Oct 27 2026) each group heading
          // reads like "Daily work": the same size and colour, one level.
          const subgroups = "subgroups" in section && Array.isArray(section.subgroups) ? section.subgroups : null;
          const titled = !!section.title;
          const renderList = (list: typeof section.items) => subgroups
            ? <div className={titled ? "space-y-2.5" : "space-y-3"}>{subgroups.map((g) => {
                const inGroup = g.items.filter((item) => list.includes(item as (typeof list)[number]));
                return inGroup.length ? <div key={g.id} data-sidebar-subgroup={g.id}>
                  {titled
                    ? <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-brand/80">{g.title}</p>
                    : <h2 className="px-3 pb-1.5 text-sm font-semibold text-brand">{g.title}</h2>}
                  <div className="space-y-0.5">{inGroup.map((item) => renderItem(item as (typeof list)[number]))}</div>
                </div> : null;
              })}</div>
            : <div className="space-y-0.5">{list.map(renderItem)}</div>;
          const named = titled ? { "aria-labelledby": `${navigationId}-${section.id}` } : { "aria-label": OTHER_PAGES_ARIA };
          return <section key={section.id} data-sidebar-group={section.id} {...named}>
            {expanded ? <>
              {titled && <h2 id={`${navigationId}-${section.id}`} className="px-3 pb-1.5 text-sm font-semibold text-brand">{section.title}</h2>}
              {renderList(section.items)}
            </> : <>
              {folded.length > 0 ? <details className="group/sidebar">
                <summary id={`${navigationId}-${section.id}`} tabIndex={0} className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 text-sm font-semibold text-brand hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
                  {section.title}<ChevronDown aria-hidden className="size-4 shrink-0 transition-transform group-open/sidebar:rotate-180" />
                </summary>
                {renderList(folded)}
              </details> : <h2 id={`${navigationId}-${section.id}`} className="px-3 text-sm font-semibold text-brand">{section.title}</h2>}
              {shortcut.map(renderItem)}
            </>}
          </section>;
        })}
      </nav>

      <div className="space-y-1 border-t px-3 py-3">
        {/* Connections lives in the System nav section — no duplicate here. */}
        {user ? (
          <div className="mt-1 space-y-2 rounded-lg bg-surface-2/60 px-3 py-2">
            {/* Oct 30 2026: your name opens your profile (photo, phone, clock, notifications). */}
            <Link href="/profile" onClick={onNavigate} title="Your profile" className="-mx-1 flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg px-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
              <Avatar name={user.name || user.email} src={user.photoSrc} size={32} color="#4f46e5" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{user.name || user.email}</span>
                <span className="block text-[11px] text-muted-2">{ROLE_LABEL[user.role] ?? user.role} · Your profile</span>
              </span>
            </Link>
            <div className="flex items-center justify-end gap-2">
              <ThemeToggle />
              {/* Oct 27 2026 Loom: the messages icon, beside the bell (always on screen on a desktop). */}
              <MessagesButton variant="sidebar" role={user.role} />
              <NotificationsBell />
              <form action="/api/auth/logout" method="post">
                <button type="submit" title="Sign out" className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-2 hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                  <LogOut className="size-4" />
                </button>
              </form>
            </div>
          </div>
        ) : (
          // No session (open local dev): the theme switch must not vanish with
          // the user chip — light/dark is a device preference, not an account one.
          <div className="mt-1 flex justify-end px-1">
            <ThemeToggle />
          </div>
        )}
      </div>
    </aside>
  );
}
