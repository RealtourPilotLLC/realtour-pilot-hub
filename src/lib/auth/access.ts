// Role-based page access. Each "page" is a nav destination. A role has a default
// set of pages; a user's `permissions` JSON can override individual pages
// (true = grant, false = revoke) on top of their role. The OWNER sees everything;
// a couple of pages are owner-only and can never be granted to other roles.

export type PageKey =
  | "dashboard" | "tasks" | "pipeline" | "schedule" | "map"
  | "communications" | "clients" | "team" | "upload" | "editing" | "sales"
  | "billing" | "catalog" | "payouts" | "resources" | "assistant"
  | "training" | "feedback" | "connections" | "users" | "shoot" | "mypay" | "review" | "trends" | "day" | "settings" | "content" | "ops"
  | "photos";
// NOTE: "map", "billing", "payouts", "team" survive in this type only so stored
// per-user permission JSON keeps resolving and so canAccess() can treat them as
// legacy grants on the pages they merged into (see canAccess). They no longer
// appear in PAGES — their routes are redirect stubs with NO PageKey (like
// /texts), so pathKey() returns null and any signed-in user takes the hop.

// CREATIVE_MANAGER (Jordan, Oct 21 2026): "instead of James being admin,
// create a creative manager user type". The creative lead: oversees the whole
// creative process (shoots, videos, photos, the content program, the editors,
// the field team) without Kyle's office work (client inbox, scheduling admin,
// Aryeo delivery approvals, the office task list) and without money.
export type Role = "OWNER" | "ADMIN" | "CREATIVE_MANAGER" | "EDITOR" | "PHOTOGRAPHER";

export const ROLES: Role[] = ["OWNER", "ADMIN", "CREATIVE_MANAGER", "EDITOR", "PHOTOGRAPHER"];
export const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", ADMIN: "Admin", CREATIVE_MANAGER: "Creative manager", EDITOR: "Editor", PHOTOGRAPHER: "Photographer",
};

// ---------------------------------------------------------------------------
// TWO QUESTIONS, ASKED BY NAME (Oct 21 2026). Before the creative manager the
// hub asked `role === "OWNER" || role === "ADMIN"` in a few hundred places and
// meant one of two different things by it:
//   · isOffice: the owner and the office (Kyle). Client comms, scheduling,
//     billing questions, Aryeo deliveries, photo delivery approvals, the
//     office task list, settings. A creative manager is NOT the office.
//   · isCreativeLead: the owner, the office, and the creative manager. Review
//     Room verdicts and notes, the content program (strategy, topics, scripts,
//     script requests), editor briefs, shoot issues and photo flags, training.
// Neither is a money question: money stays canSeeMoney (OWNER only) below.
// ---------------------------------------------------------------------------
export const isOffice = (role: string | null | undefined): boolean => role === "OWNER" || role === "ADMIN";
export const isCreativeLead = (role: string | null | undefined): boolean => isOffice(role) || role === "CREATIVE_MANAGER";
/** The roles isCreativeLead admits, for requireRole lists and notification targets. */
export const CREATIVE_LEAD_ROLES: Role[] = ["OWNER", "ADMIN", "CREATIVE_MANAGER"];

export const PAGES: { key: PageKey; label: string; href: string; ownerOnly?: boolean }[] = [
  { key: "dashboard", label: "Dashboard", href: "/" },
  // "tasks" is the merged Tasks hub — the old Today (/today), Daily Tasks
  // (/queue) and Task History (/history) pages are its tabs now; those routes
  // (plus /texts → the comms Outbox) live on only as redirect stubs. The stubs
  // deliberately have NO PageKey: any signed-in user may take the redirect hop,
  // and the destination page enforces access itself.
  { key: "tasks", label: "Tasks", href: "/tasks" },
  // THE PHOTOS DESK (Oct 22 2026): /ops/photo-delivery and every page under
  // it (the queue, each photo job, review mode, credits, settings). It rode
  // the `ops` key until Jordan gave the creative manager a VIEW-ONLY desk
  // ("so he can check photo quality across all jobs in one place"), which
  // needs a key of its own: `ops` also opens Kyle's list, which stays his.
  // MUST stay ahead of "ops" in this list: the proxy (pathKey) and the usage
  // labels take the first entry whose href prefixes the path. Who may ACT on
  // the desk is a separate question its pages and actions answer (isOffice;
  // app/ops/photo-delivery/data loadViewer `readOnly`).
  // Labelled as its menu door (Oct 23 2026: "Photo Delivery"), for People's
  // access switches and the Activity tab.
  { key: "photos", label: "Photo Delivery", href: "/ops/photo-delivery" },
  // Kyle's guided operating day (Jordan's Daily Operations & Client Experience
  // Structure, Sep 1 2026): time-blocked control tower with live data per block.
  // The menu door on this key (Oct 21 2026): Your list (/ops/checklist, owner
  // and office only). Photos moved to its own key above (Oct 22 2026). /ops
  // itself redirects to the dashboard.
  { key: "ops", label: "Operations", href: "/ops" },
  // The Review Room — the owner's quality desk: cuts editors submitted, photo
  // sets in QC, and open feedback follow-through. Owner/admin see all of that;
  // a PHOTOGRAPHER opening /review gets the same room narrowed to the jobs they
  // shot (Sep 18), and editors still receive their feedback on /edit.
  // "Video Delivery" as its menu door (Oct 23 2026).
  { key: "review", label: "Video Delivery", href: "/review" },
  { key: "pipeline", label: "Shoots", href: "/jobs" },
  // Schedule now owns both the day-list and the Map (the ?view=map tab). /map is
  // a redirect stub → /schedule?view=map, so "map" no longer needs its own key.
  { key: "schedule", label: "Schedule", href: "/schedule" },
  { key: "shoot", label: "My Shoots", href: "/shoot" },
  { key: "mypay", label: "My Performance", href: "/my-pay" },
  { key: "communications", label: "Messages", href: "/communications" },
  { key: "clients", label: "Clients", href: "/clients" },
  // Content Creator Program — monthly personal-branding clients: enrollment,
  // month workspaces, topics, scripts, agent profiles. Owner/admin.
  { key: "content", label: "Monthly Content", href: "/content" },
  { key: "upload", label: "Upload Portal", href: "/upload" },
  { key: "editing", label: "Editing Room", href: "/editing" },
  // "sales" is the merged Finance hub — Revenue (old /sales) + Unpaid (old
  // /billing) + Payroll (old /payouts) are its tabs now. /billing and /payouts
  // are redirect stubs, so "billing"/"payouts" no longer need their own keys.
  // Per-tab gating lives on the page: every tab but Unpaid is owner-only, and
  // Unpaid shows a non-owner with a `sales` grant no amounts (canSeeMoney).
  { key: "sales", label: "Finance", href: "/sales" },
  // Leading indicators: bookings by ORDER date, service mix, client spend trend.
  { key: "trends", label: "Trends", href: "/trends" },
  // The owner's own command centre: his day plan + his personal to-dos.
  // ownerOnly — it is one person's private list, not a shared queue.
  { key: "day", label: "My Day", href: "/day", ownerOnly: true },
  { key: "catalog", label: "Service Catalog", href: "/catalog" },
  { key: "resources", label: "Resources & SOPs", href: "/resources" },
  { key: "training", label: "Training", href: "/training" },
  { key: "assistant", label: "Ask the Hub", href: "/assistant" },
  { key: "feedback", label: "Report a hub problem", href: "/feedback" },
  // Platform rules the business runs on (editor routing today, more to come).
  // Owner + Kyle: "a full settings page … for me Owner and the Admin (kyle)".
  { key: "settings", label: "Settings", href: "/settings" },
  { key: "connections", label: "Connections", href: "/connections", ownerOnly: true },
  // "users" is the merged People hub — Team (old /team, admin-visible) + Logins &
  // access (old /users AppUser allowlist, owner-only). It can no longer be
  // ownerOnly: admins need the Team tab. The Logins tab gates owner-only on the
  // page itself. /team is a redirect stub → /users?tab=team.
  { key: "users", label: "People", href: "/users" },
];

const ALL = PAGES.map((p) => p.key);

// Default page set per role (OWNER = all). Anything not listed can still be
// granted to a person via a per-user override (except owner-only pages).
const ROLE_PAGES: Record<Role, PageKey[]> = {
  OWNER: ALL,
  // ADMIN = "full ops access, no money" (Jordan, Sep 2 2026). That sentence is
  // now the ROLE DEFAULT, not seven hand-set toggles per person: before this,
  // Kyle carried {sales:false,trends:false,review,upload,catalog,settings,feedback}
  // and James carried a different blob, so a new admin arrived with the WRONG
  // access until someone remembered to edit them. Read the list below as the
  // policy itself.
  //   OPS, granted: the whole run-the-business surface — the day (ops/tasks/
  //   dashboard), the work (review, upload, editing, pipeline, schedule, shoot),
  //   the people-facing side (communications, clients, content, users), and the
  //   reference shelf (catalog, resources, training, assistant, feedback,
  //   settings). "shoot" is here because an ops admin runs the field day and
  //   James shoots; /shoot deliberately carries no pricing (per-person pay lives
  //   on /my-pay, which is NOT a default — James holds it as a real exception).
  //   MONEY, denied: "sales" (the Finance hub — Revenue, Unpaid AR, Payroll) and
  //   "trends" (revenue/spend leading indicators). Both stay owner-only by
  //   default. This matches Ask the Hub, which is money-blind below OWNER too.
  // Genuine exceptions still work: a per-user permissions blob overrides any key
  // in either direction (see canAccess), e.g. James's {"mypay":true}.
  // No "map"/"billing"/"payouts"/"team" here: those merged away and canAccess()
  // maps their legacy grants onto schedule/sales/users below.
  // "photos" (Oct 22 2026) is the photo desk that rode "ops" until then: the
  // office keeps it by default, exactly as before.
  ADMIN: [
    "dashboard", "ops", "photos", "tasks", "review", "pipeline", "schedule", "shoot",
    "communications", "clients", "content", "users", "upload", "editing",
    "catalog", "resources", "training", "assistant", "feedback", "settings",
  ],
  // No "dashboard": the overview page carries ops counts + owner money strips
  // that aren't an editor's business — middleware bounces them to /editing.
  // ONE work surface (audit Aug 25): /editing is the editor's queue AND home;
  // Tasks duplicated it and Upload Portal exposed the whole company's shoot
  // roster for no editing purpose.
  EDITOR: ["editing", "resources", "training", "assistant"],
  // Photographers live entirely in the field platform: their own shoots (which
  // already carry their scoped schedule, maps, route + pay), the upload checklist
  // (scoped to their jobs), SOPs, and Ask the Hub (auto-gated to the CREATIVE
  // content tier — owner/admin-only knowledge + comms are filtered out for them).
  // They get NO ops/dashboard, schedule, map, clients, comms, billing, pipeline.
  // "mypay" = their OWN pay for the current/next period (shoot pay + mileage,
  // no invoices) with a flag-a-question loop to Jordan.
  // "review" was here for ONE page (Sep 17): /review/<job> when a tag on a cut
  // sent them there. Since Sep 18 it is the Room proper — Jordan: "I want to be
  // able to share the review room with the photographer who shot the video …
  // they should be notified just like I am, with access to the review room."
  // The index at /review now answers a photographer with THEIR OWN cuts (the
  // jobs they shot) instead of redirecting them; the office's cross-client
  // queue, the photo-QC rail and the scoreboards stay owner/admin. Ownership,
  // not a tag, is the test — see photographerOwnsShoot.
  //
  // "editing" is the same sentence for the edit lane: "They should also see the
  // editing room and be able to make changes to their notes or instructions,
  // but not full control like I do or Kyle does." /editing renders them a
  // READ-ONLY board of jobs they shot, whose only writable thing is the brief
  // they themselves wrote for the editor — no status pill, no reassign, no
  // override dialog, no other photographer's jobs, and no money on any row.
  // The page gates it, and every write behind it goes through requireShootAccess.
  PHOTOGRAPHER: ["shoot", "mypay", "upload", "resources", "training", "assistant", "review", "editing"],
  // CREATIVE MANAGER (Oct 21 2026, James). Everything creative, nothing that
  // is Kyle's office work or money:
  //   granted: the creative dashboard, Shoots (pipeline) and the job pages
  //   (money-blind like every non-owner page), the team schedule, the Video
  //   Review Room, the Editing Room, the Upload Portal and My Shoots (James
  //   still shoots premium work), the Content Program, Clients (brand,
  //   profile, notes; never billing), their own tasks, the reference shelf
  //   (resources, training, Ask the Hub at the ADMIN tier, the feedback
  //   board), and My Performance ("mypay": pay stays hidden for everyone but
  //   the owner, settings.payHiddenFor, so the page is the KPI scorecard).
  //   "photos" (Jordan, Oct 22 2026: "give James a VIEW-ONLY Photos desk so
  //   he can check photo quality across all jobs in one place"): the queue
  //   and every photo job, READ ONLY. Approving, delivering, fixes, AutoHDR,
  //   decisions on findings, credits and the desk's settings stay Kyle's and
  //   Jordan's: the pages draw none of those controls for a viewer outside
  //   the office, and every one of those server actions requires the office
  //   (requireAdmin or requireOwner).
  //   NOT granted: "communications" (the client texts and email inbox Kyle
  //   answers), "ops" (Your list is Kyle's checklist), "users", "settings",
  //   "catalog" (a price list), "sales", "trends", "day", "connections". A
  //   per-user override still opens or closes any of these in either
  //   direction (canAccess).
  CREATIVE_MANAGER: [
    "dashboard", "tasks", "review", "pipeline", "schedule", "shoot", "mypay",
    "clients", "content", "upload", "editing", "photos",
    "resources", "training", "assistant", "feedback",
  ],
};

// Where to send a user who lands somewhere they can't access — and their
// post-login home. Everyone starts on their WORK surface: editors in their
// queue, photographers in My Shoots, owner and admins on Home. Used by the
// middleware redirect — every target is in that role's ROLE_PAGES, so there's
// no redirect loop.
export function homeFor(role: string | null | undefined): string {
  switch (role) {
    case "PHOTOGRAPHER": return "/shoot";
    case "EDITOR": return "/editing";
    // Kyle and James land on Home: the Ops Day merged into "/" (Jordan, Sep 2:
    // "the ops day screen essentially combined with my dashboard") and /ops is
    // a redirect stub now. Pointing here at "/ops" cost every admin login and
    // every middleware bounce an extra hop through that stub (audit, Sep 8
    // 2026). "dashboard" is in ADMIN's ROLE_PAGES, so there is no loop.
    case "ADMIN": return "/";
    // The creative manager's home is "/" too: the dashboard draws its
    // creative overview for this role (app/page.tsx), never Kyle's office list.
    case "CREATIVE_MANAGER": return "/";
    default: return "/";
  }
}

export function parsePermissions(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

type AccessUser = { role: string; permissions?: string | null };

// Can this user open this page?
export function canAccess(user: AccessUser, key: PageKey): boolean {
  if (user.role === "OWNER") return true;
  const page = PAGES.find((p) => p.key === key);
  if (page?.ownerOnly) return false; // never for non-owners, even via override
  const perms = parsePermissions(user.permissions);
  // Consolidated pages absorb the permission keys of the routes they merged, so
  // nobody's stored grants lose access on the consolidation. Same pattern the
  // Tasks hub used (today/history → tasks):
  //   schedule ← map            (Map is now the ?view=map tab)
  //   sales    ← billing/payouts (Finance = Revenue | Unpaid | Payroll tabs)
  //   users    ← team            (People = Team | Logins tabs)
  // Honour ANY of the merged keys as an override on the destination page.
  // (The legacy merged-key mapping — today/history/map/billing/payouts/team —
  // was removed Aug 25: a live scan found zero stored legacy grants.)
  if (key in perms) return !!perms[key];
  // The photo desk rode the `ops` key until Oct 22 2026: a stored `ops`
  // override keeps deciding it until someone sets a `photos` one, so nobody's
  // access to it moved when it got a key of its own.
  if (key === "photos" && "ops" in perms) return !!perms.ops;
  const role = (ROLE_PAGES[user.role as Role] ?? []) as PageKey[];
  return role.includes(key);
}

// The effective default for a page (before overrides) — used to show the toggle
// baseline in the Users UI.
export function roleHasByDefault(role: string, key: PageKey): boolean {
  if (role === "OWNER") return true;
  return (ROLE_PAGES[role as Role] ?? []).includes(key);
}

// Map an app role to the content-sensitivity tier the Hub/comms gating uses.
// The creative manager reads at the ADMIN tier (Oct 21 2026): it is money-free
// below OWNER (canSeeMoney), and the client context a creative lead needs
// (client profiles, strategies, the team's SOPs) sits there.
export function contentTier(role: string): "OWNER" | "ADMIN" | "CREATIVE" {
  if (role === "OWNER") return "OWNER";
  if (role === "ADMIN" || role === "CREATIVE_MANAGER") return "ADMIN";
  return "CREATIVE";
}

// The money rule, stated once for the whole hub. Jordan, Sep 2 2026: "everyone
// filtered by role but Kyle should not have access to any money related info."
// Only OWNER sees dollars — revenue, P&L, margins, pay rates, client lifetime
// spend, balances, invoice amounts. Everyone else gets the operations, never the
// figures. Accepts an app role ("ADMIN") or a content tier ("CREATIVE") because
// pages think in roles and Ask the Hub thinks in tiers; "OWNER" means the same
// thing in both vocabularies, so one comparison covers both.
//
// A PAGE GRANT IS NEVER A MONEY GRANT (Jordan, Oct 21 2026). canAccess() above
// decides whether someone may OPEN a page, and a per-person override can open
// Finance, Trends or the Catalog for a non-owner. What that page then prints
// in dollars is this function's call, never canAccess's: pages pass the
// viewer's role here (the previewed role under "view as") and render amounts
// only when it says yes. Nothing about a permissions blob can make it say yes.
export function canSeeMoney(roleOrTier: string | null | undefined): boolean {
  return roleOrTier === "OWNER";
}
