// Role-based page access. Each "page" is a nav destination. A role has a default
// set of pages; a user's `permissions` JSON can override individual pages
// (true = grant, false = revoke) on top of their role. The OWNER sees everything;
// a couple of pages are owner-only and can never be granted to other roles.

export type PageKey =
  | "dashboard" | "tasks" | "pipeline" | "schedule" | "map"
  | "communications" | "clients" | "team" | "upload" | "editing" | "sales"
  | "billing" | "catalog" | "payouts" | "resources" | "assistant"
  | "training" | "feedback" | "connections" | "users" | "shoot" | "mypay" | "review" | "trends" | "day" | "settings" | "content" | "ops";
// NOTE: "map", "billing", "payouts", "team" survive in this type only so stored
// per-user permission JSON keeps resolving and so canAccess() can treat them as
// legacy grants on the pages they merged into (see canAccess). They no longer
// appear in PAGES — their routes are redirect stubs with NO PageKey (like
// /texts), so pathKey() returns null and any signed-in user takes the hop.

export type Role = "OWNER" | "ADMIN" | "EDITOR" | "PHOTOGRAPHER";

export const ROLES: Role[] = ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"];
export const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", ADMIN: "Admin", EDITOR: "Editor", PHOTOGRAPHER: "Photographer",
};

export const PAGES: { key: PageKey; label: string; href: string; ownerOnly?: boolean }[] = [
  { key: "dashboard", label: "Dashboard", href: "/" },
  // "tasks" is the merged Tasks hub — the old Today (/today), Daily Tasks
  // (/queue) and Task History (/history) pages are its tabs now; those routes
  // (plus /texts → the comms Outbox) live on only as redirect stubs. The stubs
  // deliberately have NO PageKey: any signed-in user may take the redirect hop,
  // and the destination page enforces access itself.
  { key: "tasks", label: "Tasks", href: "/tasks" },
  // Kyle's guided operating day (Jordan's Daily Operations & Client Experience
  // Structure, Sep 1 2026): time-blocked control tower with live data per block.
  { key: "ops", label: "Ops Day", href: "/ops" },
  // The Review Room — the owner's quality desk: cuts editors submitted, photo
  // sets in QC, and open feedback follow-through. Owner/admin by default;
  // creatives receive their feedback on their own surfaces (/shoot, /edit).
  { key: "review", label: "Review Room", href: "/review" },
  { key: "pipeline", label: "Project Tracker", href: "/pipeline" },
  // Schedule now owns both the day-list and the Map (the ?view=map tab). /map is
  // a redirect stub → /schedule?view=map, so "map" no longer needs its own key.
  { key: "schedule", label: "Schedule", href: "/schedule" },
  { key: "shoot", label: "My Shoots", href: "/shoot" },
  { key: "mypay", label: "My Pay", href: "/my-pay" },
  { key: "communications", label: "Communications", href: "/communications" },
  { key: "clients", label: "Clients", href: "/clients" },
  // Content Creator Program — monthly personal-branding clients: enrollment,
  // month workspaces, topics, scripts, agent profiles. Owner/admin.
  { key: "content", label: "Content Program", href: "/content" },
  { key: "upload", label: "Upload Portal", href: "/upload" },
  { key: "editing", label: "Editor Queue", href: "/editing" },
  // "sales" is the merged Finance hub — Revenue (old /sales) + Unpaid (old
  // /billing) + Payroll (old /payouts) are its tabs now. /billing and /payouts
  // are redirect stubs, so "billing"/"payouts" no longer need their own keys.
  // Per-tab gating lives on the page: Unpaid = admin-visible, Payroll = owner-only.
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
  { key: "feedback", label: "Feedback & requests", href: "/feedback" },
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
  ADMIN: [
    "dashboard", "ops", "tasks", "review", "pipeline", "schedule", "shoot",
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
  PHOTOGRAPHER: ["shoot", "mypay", "upload", "resources", "training", "assistant"],
};

// Where to send a user who lands somewhere they can't access — and their
// post-login home. Everyone starts on their WORK surface: Kyle (admin) in the
// Tasks hub (Today tab), editors in their queue, photographers in My Shoots.
// Only the owner lands on the overview dashboard. Used by the middleware
// redirect — every target is in that role's ROLE_PAGES, so there's no redirect loop.
export function homeFor(role: string | null | undefined): string {
  switch (role) {
    case "PHOTOGRAPHER": return "/shoot";
    case "EDITOR": return "/editing";
    // Kyle lands on his guided operating day (Jordan, Sep 1) — Tasks stays one tap away.
    case "ADMIN": return "/ops";
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
export function contentTier(role: string): "OWNER" | "ADMIN" | "CREATIVE" {
  if (role === "OWNER") return "OWNER";
  if (role === "ADMIN") return "ADMIN";
  return "CREATIVE";
}

// The money rule, stated once for the whole hub. Jordan, Sep 2 2026: "everyone
// filtered by role but Kyle should not have access to any money related info."
// Only OWNER sees dollars — revenue, P&L, margins, pay rates, client lifetime
// spend, balances, invoice amounts. Everyone else gets the operations, never the
// figures. Accepts an app role ("ADMIN") or a content tier ("CREATIVE") because
// pages think in roles and Ask the Hub thinks in tiers; "OWNER" means the same
// thing in both vocabularies, so one comparison covers both.
export function canSeeMoney(roleOrTier: string | null | undefined): boolean {
  return roleOrTier === "OWNER";
}
