// ---------------------------------------------------------------------------
// THE PORTAL'S ADDRESSES (UI-01, Sep 24 2026) — pure, so the pages, the client
// components and the drill all read the same map.
//
// The client IA is five destinations — Home · Your Month (key "plan") ·
// Content Library · Messages · More (Brand Profile, Filming sessions,
// Resources, Settings & Team, Terms). Until Oct 6 2026 that was the "v2" layout behind
// `portal_layout_v2`, beside the old six tabs ("v1"); since Jordan's "I want
// to just be fully transitioned to the new layout" (Oct 6 2026) it is the
// only layout, for everyone.
//
// Two rules this file exists to keep:
//   · LINKS STAY QUERY-ONLY. Every href starts with "?" and never carries a
//     path segment, so the enrollment token in /portal/<token> is never
//     written into the page (PortalPage.tsx's header explains why).
//   · EVERY OLD LINK STILL LANDS. Reminder emails, notifications and bookmarks
//     carry the old tab keys — ?tab=videos, topics, ideas, strategy, profile,
//     settings, library… Each resolves to its page here; unknown → Home. A
//     stray `layout=v2` from an old staff-preview link is simply ignored.
//
// MESSAGES IN THE BAR (Jordan, Oct 21 2026; audit E13). Schedule held one of
// the five bar slots with a read-only copy of Home's "coming up" and Your
// Month's steps, while Messages, the only two-way channel, sat under More.
// Messages now has Schedule's slot (with its unread count); the list folded
// into Home and Your Month (components/portal/ComingUp.tsx); requesting,
// changing or cancelling a session stays in Your Month, and More links there
// ("Filming sessions"). An old ?tab=schedule lands on Your Month.
// ---------------------------------------------------------------------------

export const PORTAL_DESTS = ["home", "plan", "library", "messages", "more", "brand", "resources", "team", "terms"] as const;
export type PortalDest = (typeof PORTAL_DESTS)[number];

/** My Plan's subviews: this month's topics, scripts awaiting approval, the topic bank, the strategy. */
export const PLAN_VIEWS = ["month", "scripts", "bank", "strategy"] as const;
export type PlanView = (typeof PLAN_VIEWS)[number];

/**
 * Which block of per-page data PortalPage loads for an address. The names are
 * the old tab keys (the loaders were written against them); "more" loads
 * nothing page-specific. Internal only — never written into a link.
 */
export type PortalDataTab = "home" | "videos" | "topics" | "strategy" | "resources" | "messages" | "profile" | "settings" | "terms" | "more";

export type PortalRoute = {
  /** The page this address renders. */
  dest: PortalDest;
  /** Set only when dest is "plan". */
  planView: PlanView | null;
  /** The data block PortalPage loads for it. */
  dataTab: PortalDataTab;
};

/** Every key the address bar has ever carried, and the current keys, → the destination. */
const DEST_OF: Record<string, { dest: PortalDest; planView?: PlanView }> = {
  home: { dest: "home" },
  videos: { dest: "library" },
  library: { dest: "library" },
  topics: { dest: "plan", planView: "bank" },
  ideas: { dest: "plan", planView: "bank" },
  strategy: { dest: "plan", planView: "strategy" },
  plan: { dest: "plan" },
  // Oct 21 2026: the Schedule page is retired; its sessions are booked, changed and listed in Your Month.
  schedule: { dest: "plan", planView: "month" },
  resources: { dest: "resources" },
  messages: { dest: "messages" },
  profile: { dest: "brand" },
  brand: { dest: "brand" },
  settings: { dest: "team" },
  team: { dest: "team" },
  terms: { dest: "terms" },
  more: { dest: "more" },
};

/** A destination's data block. */
const DATA_OF: Record<PortalDest, PortalDataTab> = {
  home: "home", library: "videos", resources: "resources", messages: "messages",
  brand: "profile", team: "settings", terms: "terms", more: "more",
  plan: "topics", // pv=strategy → "strategy", below
};

const isPlanView = (v: unknown): v is PlanView => typeof v === "string" && (PLAN_VIEWS as readonly string[]).includes(v);

/**
 * The address's query as plain strings (Sep 24). Next hands a REPEATED search
 * param over as string[] (`?q=a&q=b` → { q: ["a","b"] }) whatever the page's
 * type says, and a reader that calls a string method on it throws in render —
 * `?tab=library&q=a&q=b` errored the Content Library. The first value
 * wins; anything that is not a string (or an array starting with one) is
 * dropped. Every portal entry point passes its searchParams through this.
 */
export function firstQueryValues<T extends Record<string, string | undefined>>(raw: Record<string, unknown> | null | undefined): T {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === "string") out[k] = first;
  }
  return out as T;
}

/**
 * One address → the page it renders. `pv` picks the Plan subview for
 * `?tab=plan`; an old key that names a subview (topics → bank, strategy →
 * strategy) wins over a stray `pv`.
 */
export function resolvePortalRoute(q: { tab?: string | null; pv?: string | null }): PortalRoute {
  const hit = DEST_OF[q.tab ?? ""] ?? { dest: "home" as const };
  const planView: PlanView | null = hit.dest !== "plan" ? null : hit.planView ?? (isPlanView(q.pv) ? q.pv : "month");
  const dataTab: PortalDataTab = hit.dest === "plan" ? (planView === "strategy" ? "strategy" : "topics") : DATA_OF[hit.dest];
  return { dest: hit.dest, planView, dataTab };
}

/** Destinations that live under More — the bottom bar lights "More" for them. */
export const MORE_DESTS: readonly PortalDest[] = ["more", "brand", "resources", "team", "terms"];
export const primaryDestOf = (dest: PortalDest): PortalDest => (MORE_DESTS.includes(dest) ? "more" : dest);

/**
 * A query-only link. `base` is the query that must survive every click
 * (`e=<enrollmentId>` on /portal/me, the selected month/session); `extra`
 * is appended as-is ("pv=scripts", "v=<id>", "q=kitchen&st=review").
 */
export function portalHref(base: string, dest: PortalDest, extra?: string | null): string {
  const b = base.replace(/^[?&]+/, "");
  const x = (extra ?? "").replace(/^[?&]+/, "");
  return `?${b ? `${b}&` : ""}tab=${dest}${x ? `&${x}` : ""}`;
}

/**
 * The tab-key href signature (`href("topics", "iv=…")`) answered with the
 * current addresses — so the components written against the old tab keys
 * (ScheduleTab, the appointment cards, SetupCard's links) link to the right
 * page. The name is historical (it was the "v2" answer beside v1's).
 */
export function v2HrefFor(base: string): (tab: string, extra?: string) => string {
  return (tab, extra) => {
    const r = resolvePortalRoute({ tab });
    // "topics" from a shared component means the bank; everything else keeps its own view.
    const pv = r.dest === "plan" && r.planView && r.planView !== "month" ? `pv=${r.planView}` : "";
    return portalHref(base, r.dest, [pv, extra ?? ""].filter(Boolean).join("&"));
  };
}

/** The query pairs a GET form must repeat as hidden fields to stay on this page (e=, month=, session=). */
export function baseQueryPairs(base: string): [string, string][] {
  return [...new URLSearchParams(base.replace(/^\?/, "")).entries()].filter(([k]) => k !== "tab");
}

// ---- navigation --------------------------------------------------------------

export type NavItem = {
  dest: PortalDest; label: string; short: string; badge: number; hint?: string | null;
  /** A spot on the destination's page ("step-filming"): More's Filming sessions opens Your Month's filming step. */
  anchor?: string | null;
};
export type NavBadges = { plan?: number; library?: number; messages?: number; brand?: number };

/**
 * The navigation. Resources is listed ONLY when at least one guide is
 * published — an empty Resources page is not a launch feature (audit §6).
 * Messages is always listed: CP-13's conversation exists, and a paused or
 * view-only seat still reads it (the page says why it cannot write). Since
 * Oct 21 2026 it is in the bar, carrying its own unread count.
 */
export function portalNav(input: { publishedResources: number; badges?: NavBadges }): { primary: NavItem[]; more: NavItem[] } {
  const b = input.badges ?? {};
  const n = (x: number | undefined) => (typeof x === "number" && x > 0 ? x : 0);
  const more: NavItem[] = [
    { dest: "brand", label: "Brand Profile", short: "Brand", badge: n(b.brand), hint: "Colors, logo, fonts, links, music" },
    // Oct 21 2026: requesting, changing or cancelling a session, reachable from More (it happens in Your Month).
    { dest: "plan", label: "Filming sessions", short: "Sessions", badge: 0, hint: "Book, change or cancel a session in Your Month", anchor: "step-filming" },
    ...(input.publishedResources > 0 ? [{ dest: "resources" as const, label: "Resources", short: "Resources", badge: 0, hint: "Short guides for each step" }] : []),
    { dest: "team", label: "Settings & Team", short: "Settings", badge: 0, hint: "Your account and who else is on it" },
    { dest: "terms", label: "Terms", short: "Terms", badge: 0, hint: "How the program works" },
  ];
  const primary: NavItem[] = [
    { dest: "home", label: "Home", short: "Home", badge: 0 },
    // §11 (Sep 25 2026): "Your Month" — planning and booking as one guided
    // page. The destination key stays "plan", so every link still lands.
    { dest: "plan", label: "Your Month", short: "Month", badge: n(b.plan) },
    { dest: "library", label: "Content Library", short: "Library", badge: n(b.library) },
    // Oct 21 2026: Messages has Schedule's old slot, with its unread replies.
    { dest: "messages", label: "Messages", short: "Messages", badge: n(b.messages) },
    { dest: "more", label: "More", short: "More", badge: 0 },
  ];
  return { primary, more };
}
