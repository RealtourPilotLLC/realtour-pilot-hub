// ---------------------------------------------------------------------------
// THE STAFF CLIENT FILE'S ADDRESS BOOK (UI-02, Sep 24 2026).
//
// The client file had grown to eleven tabs (Overview, Strategy, Video Topics,
// Scripts, Content, Brand & Assets, Settings, Facts, Import, Client file,
// Messages, Their portal), three of which did the same job twice with weaker
// rules. It is now SIX primary tabs, two of them with a small sub-navigation:
//
//   Overview · Plan (topics / scripts / strategy / calls / knowledge)
//   · Production (sessions / videos / revisions) · Brand · Messages · Settings
//
// plus Import as a secondary page reached from the Tools menu, and the
// client's portal as a separate owner-only Preview page.
//
// Everything that builds a link into the client file comes through here, and
// every link ever built the OLD way still lands: notification bells are stored
// with their href, so `?tab=ideas` from a July bell has to open Plan › Topics
// for as long as that row exists. resolveStaffTab accepts every historical key
// for ever; the drill holds that table.
//
// PURE — no prisma, no server-only — so the libs that write bell hrefs, the
// server actions, the page and client components can all import it.
// ---------------------------------------------------------------------------

export type StaffTab = "overview" | "plan" | "production" | "brand" | "messages" | "settings" | "import";
export type PlanView = "topics" | "scripts" | "strategy" | "calls" | "knowledge";
export type ProductionView = "sessions" | "videos" | "revisions";

/** The six primary tabs, in the order they sit on the bar. Import is reached from Tools, not here. */
export const STAFF_TABS: { key: Exclude<StaffTab, "import">; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "plan", label: "Plan" },
  { key: "production", label: "Production" },
  { key: "brand", label: "Brand" },
  { key: "messages", label: "Messages" },
  { key: "settings", label: "Settings" },
];

export const PLAN_VIEWS: { key: PlanView; label: string }[] = [
  { key: "topics", label: "Topics" },
  { key: "scripts", label: "Scripts" },
  { key: "strategy", label: "Strategy" },
  { key: "calls", label: "Calls" },
  { key: "knowledge", label: "Knowledge" },
];

export const PRODUCTION_VIEWS: { key: ProductionView; label: string }[] = [
  { key: "sessions", label: "Sessions" },
  { key: "videos", label: "Videos" },
  { key: "revisions", label: "Revisions" },
];

/** The view a tab opens on when the URL names none. */
export const DEFAULT_VIEW: Partial<Record<StaffTab, string>> = { plan: "topics", production: "sessions" };

const PRIMARY = new Set<string>(["overview", "plan", "production", "brand", "messages", "settings", "import"]);
const VIEWS: Partial<Record<StaffTab, Set<string>>> = {
  plan: new Set(PLAN_VIEWS.map((v) => v.key)),
  production: new Set(PRODUCTION_VIEWS.map((v) => v.key)),
};

/**
 * Every key the client file has EVER answered to, and where it lives now.
 * `moved` marks the one key whose contents were split four ways (the old
 * Client file): the landing tab shows one line saying where each part went.
 */
export const LEGACY_TAB_MAP: Record<string, { tab: StaffTab; view: string | null; moved?: boolean }> = {
  month: { tab: "overview", view: null },
  strategy: { tab: "plan", view: "strategy" },
  ideas: { tab: "plan", view: "topics" },
  topics: { tab: "plan", view: "topics" },
  "video-topics": { tab: "plan", view: "topics" },
  scripts: { tab: "plan", view: "scripts" },
  facts: { tab: "plan", view: "knowledge" },
  notes: { tab: "plan", view: "knowledge" },
  knowledge: { tab: "plan", view: "knowledge" },
  calls: { tab: "plan", view: "calls" },
  call: { tab: "plan", view: "calls" },
  content: { tab: "production", view: "videos" },
  videos: { tab: "production", view: "videos" },
  library: { tab: "production", view: "videos" },
  sessions: { tab: "production", view: "sessions" },
  revisions: { tab: "production", view: "revisions" },
  profile: { tab: "brand", view: null },
  assets: { tab: "brand", view: null },
  file: { tab: "brand", view: null, moved: true },
};

export type ResolvedTab = {
  tab: StaffTab;
  view: string | null;
  /** the URL was not canonical — send the browser to contentHref(...) */
  redirect: boolean;
  /** the old "Their portal" tab, opened by someone allowed to see it */
  preview: boolean;
  /** came from ?tab=file — show the one-line "the client file was split" notice */
  moved: boolean;
};

/**
 * Where a (tab, view) pair from a URL belongs. A canonical pair returns
 * redirect:false, so feeding any output back in never loops.
 */
export function resolveStaffTab(tab?: string | null, view?: string | null, isOwner = false): ResolvedTab {
  const t = (tab ?? "").trim();
  const v = (view ?? "").trim() || null;
  if (t === "" || t === "overview") {
    // A stray view on the overview is dropped, not honoured.
    return { tab: "overview", view: null, redirect: t === "overview" ? false : v !== null, preview: false, moved: false };
  }
  if (t === "portal") {
    // The live-portal mirror acts on the client's behalf — it is the owner's
    // window (page.tsx's old ownerEyes rule), and moved to its own page.
    return isOwner
      ? { tab: "overview", view: null, redirect: false, preview: true, moved: false }
      : { tab: "overview", view: null, redirect: true, preview: false, moved: false };
  }
  if (PRIMARY.has(t)) {
    const tabKey = t as StaffTab;
    const allowed = VIEWS[tabKey];
    if (!allowed) return { tab: tabKey, view: null, redirect: v !== null, preview: false, moved: false };
    if (v === null) return { tab: tabKey, view: DEFAULT_VIEW[tabKey] ?? null, redirect: false, preview: false, moved: false };
    if (allowed.has(v)) return { tab: tabKey, view: v, redirect: false, preview: false, moved: false };
    return { tab: tabKey, view: DEFAULT_VIEW[tabKey] ?? null, redirect: true, preview: false, moved: false };
  }
  const legacy = LEGACY_TAB_MAP[t];
  if (legacy) return { tab: legacy.tab, view: legacy.view, redirect: true, preview: false, moved: !!legacy.moved };
  // Unknown key: the overview, with a clean URL.
  return { tab: "overview", view: null, redirect: true, preview: false, moved: false };
}

/** The ET month key — contentProgram.etMonthKey's formula, restated here only because that module is server-only. */
function etMonthKeyPure(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(d);
  return `${p.find((x) => x.type === "year")!.value}-${p.find((x) => x.type === "month")!.value}`;
}

export type ContentHrefOpts = {
  tab?: StaffTab | null;
  view?: string | null;
  /** a month key; omitted from the URL when it is the current ET month (the page's default) */
  month?: string | null;
  /** an in-page anchor, without the "#" */
  anchor?: string | null;
  moved?: boolean;
  now?: Date;
};

/** THE one way to link into a client file. */
export function contentHref(enrollmentId: string, opts: ContentHrefOpts = {}): string {
  const q = new URLSearchParams();
  const tab = opts.tab ?? "overview";
  if (tab !== "overview") q.set("tab", tab);
  if (tab !== "overview" && opts.view) q.set("view", opts.view);
  if (opts.month && opts.month !== etMonthKeyPure(opts.now ?? new Date())) q.set("month", opts.month);
  if (opts.moved) q.set("moved", "1");
  const qs = q.toString();
  return `/content/${enrollmentId}${qs ? `?${qs}` : ""}${opts.anchor ? `#${opts.anchor.replace(/^#/, "")}` : ""}`;
}

/**
 * monthProgress's next steps point at anchors that lived on the old one-page
 * Overview (#call, #topics, #scripts, #sessions). Those sections now live on
 * Plan and Production; this turns such an href into the tab that holds it and
 * passes any other href through untouched.
 */
export function resolveStepHref(enrollmentId: string, href: string, month?: string | null): string {
  const map: Record<string, { tab: StaffTab; view: string }> = {
    "#call": { tab: "plan", view: "calls" },
    "#topics": { tab: "plan", view: "topics" },
    "#scripts": { tab: "plan", view: "scripts" },
    "#sessions": { tab: "production", view: "sessions" },
  };
  const hit = map[href];
  return hit ? contentHref(enrollmentId, { ...hit, month }) : href;
}

/**
 * Who may open the client's live portal from the staff side. The mirror is
 * signed in AS STAFF on the client's behalf, so it stays the owner's alone —
 * the same `me ? OWNER : !authEnforced()` shape as every owner-eyes check.
 * Uses the EFFECTIVE role: an owner previewing Kyle sees what Kyle sees.
 */
export function canPreviewPortal(me: { role: string } | null | undefined, enforced: boolean): boolean {
  return me ? me.role === "OWNER" : !enforced;
}

/** The roster's layout: an explicit ?view wins, then the remembered cookie, then cards. */
export type RosterView = "cards" | "table";
export const ROSTER_VIEW_COOKIE = "rtp_content_view";
export function resolveRosterView(param?: string | null, cookie?: string | null): RosterView {
  const read = (v: string | null | undefined): RosterView | null => (v === "table" || v === "rows" ? "table" : v === "cards" ? "cards" : null);
  return read(param) ?? read(cookie) ?? "cards";
}
