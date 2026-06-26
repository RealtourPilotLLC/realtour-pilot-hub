// Role-based page access. Each "page" is a nav destination. A role has a default
// set of pages; a user's `permissions` JSON can override individual pages
// (true = grant, false = revoke) on top of their role. The OWNER sees everything;
// a couple of pages are owner-only and can never be granted to other roles.

export type PageKey =
  | "dashboard" | "tasks" | "history" | "pipeline" | "schedule" | "map"
  | "communications" | "clients" | "team" | "upload" | "editing" | "sales"
  | "billing" | "catalog" | "payouts" | "marketing" | "resources" | "assistant"
  | "feedback" | "connections" | "users" | "shoot";

export type Role = "OWNER" | "ADMIN" | "EDITOR" | "PHOTOGRAPHER";

export const ROLES: Role[] = ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"];
export const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", ADMIN: "Admin", EDITOR: "Editor", PHOTOGRAPHER: "Photographer",
};

export const PAGES: { key: PageKey; label: string; href: string; ownerOnly?: boolean }[] = [
  { key: "dashboard", label: "Dashboard", href: "/" },
  { key: "tasks", label: "Daily Tasks", href: "/queue" },
  { key: "history", label: "Task History", href: "/history" },
  { key: "pipeline", label: "Project Tracker", href: "/pipeline" },
  { key: "schedule", label: "Schedule", href: "/schedule" },
  { key: "map", label: "Map", href: "/map" },
  { key: "shoot", label: "My Shoots", href: "/shoot" },
  { key: "communications", label: "Communications", href: "/communications" },
  { key: "clients", label: "Clients", href: "/clients" },
  { key: "team", label: "Team", href: "/team" },
  { key: "upload", label: "Upload Portal", href: "/upload" },
  { key: "editing", label: "Editor Queue", href: "/editing" },
  { key: "sales", label: "Sales Tracker", href: "/sales" },
  { key: "billing", label: "Billing", href: "/billing" },
  { key: "catalog", label: "Service Catalog", href: "/catalog" },
  { key: "payouts", label: "Payouts", href: "/payouts" },
  { key: "marketing", label: "Campaigns", href: "/marketing" },
  { key: "resources", label: "Resources & SOPs", href: "/resources" },
  { key: "assistant", label: "Ask the Hub", href: "/assistant" },
  { key: "feedback", label: "Feedback & requests", href: "/feedback" },
  { key: "connections", label: "Connections", href: "/connections", ownerOnly: true },
  { key: "users", label: "Users", href: "/users", ownerOnly: true },
];

const ALL = PAGES.map((p) => p.key);

// Default page set per role (OWNER = all). Anything not listed can still be
// granted to a person via a per-user override (except owner-only pages).
const ROLE_PAGES: Record<Role, PageKey[]> = {
  OWNER: ALL,
  ADMIN: [
    "dashboard", "tasks", "history", "pipeline", "schedule", "map", "shoot",
    "communications", "clients", "team", "upload", "editing", "billing",
    "catalog", "resources", "assistant", "feedback",
  ],
  EDITOR: ["dashboard", "tasks", "editing", "upload", "resources", "assistant"],
  PHOTOGRAPHER: ["dashboard", "shoot", "schedule", "map", "upload", "resources"],
};

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
