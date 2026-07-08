// Role-based page access. Each "page" is a nav destination. A role has a default
// set of pages; a user's `permissions` JSON can override individual pages
// (true = grant, false = revoke) on top of their role. The OWNER sees everything;
// a couple of pages are owner-only and can never be granted to other roles.

export type PageKey =
  | "dashboard" | "tasks" | "pipeline" | "schedule" | "map"
  | "communications" | "clients" | "team" | "upload" | "editing" | "sales"
  | "billing" | "catalog" | "payouts" | "marketing" | "resources" | "assistant"
  | "training" | "feedback" | "connections" | "users" | "shoot" | "mypay";
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
  { key: "pipeline", label: "Project Tracker", href: "/pipeline" },
  // Schedule now owns both the day-list and the Map (the ?view=map tab). /map is
  // a redirect stub → /schedule?view=map, so "map" no longer needs its own key.
  { key: "schedule", label: "Schedule", href: "/schedule" },
  { key: "shoot", label: "My Shoots", href: "/shoot" },
  { key: "mypay", label: "My Pay", href: "/my-pay" },
  { key: "communications", label: "Communications", href: "/communications" },
  { key: "clients", label: "Clients", href: "/clients" },
  { key: "upload", label: "Upload Portal", href: "/upload" },
  { key: "editing", label: "Editor Queue", href: "/editing" },
  // "sales" is the merged Finance hub — Revenue (old /sales) + Unpaid (old
  // /billing) + Payroll (old /payouts) are its tabs now. /billing and /payouts
  // are redirect stubs, so "billing"/"payouts" no longer need their own keys.
  // Per-tab gating lives on the page: Unpaid = admin-visible, Payroll = owner-only.
  { key: "sales", label: "Finance", href: "/sales" },
  { key: "catalog", label: "Service Catalog", href: "/catalog" },
  { key: "marketing", label: "Campaigns", href: "/marketing" },
  { key: "resources", label: "Resources & SOPs", href: "/resources" },
  { key: "training", label: "Training", href: "/training" },
  { key: "assistant", label: "Ask the Hub", href: "/assistant" },
  { key: "feedback", label: "Feedback & requests", href: "/feedback" },
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
  // Finance ("sales") and People ("users") are admin-visible so Kyle reaches the
  // Unpaid tab (old /billing) and the Team tab (old /team). The *owner-only*
  // slices — Finance's Revenue + Payroll tabs, People's Logins tab — gate on the
  // page itself, exactly as /sales, /payouts and /users did before the merge
  // (admins only ever saw Unpaid + the Team directory). No "map"/"billing"/
  // "payouts"/"team" here: those merged away and canAccess() maps their legacy
  // grants onto schedule/sales/users below.
  ADMIN: [
    "dashboard", "tasks", "pipeline", "schedule", "shoot",
    "communications", "clients", "users", "upload", "editing", "sales",
    "catalog", "resources", "training", "assistant", "feedback",
  ],
  // No "dashboard": the overview page carries ops counts + owner money strips
  // that aren't an editor's business — middleware bounces them to /editing.
  EDITOR: ["tasks", "editing", "upload", "resources", "training", "assistant"],
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
    case "ADMIN": return "/tasks";
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
  const LEGACY: Partial<Record<PageKey, PageKey[]>> = {
    tasks: ["tasks", "today" as PageKey, "history" as PageKey],
    schedule: ["schedule", "map"],
    sales: ["sales", "billing", "payouts"],
    users: ["users", "team"],
  };
  const keys = LEGACY[key] ?? [key];
  const overridden = keys.filter((k) => k in perms);
  if (overridden.length > 0) return overridden.some((k) => !!perms[k]);
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
