import Link from "next/link";
import { BrandWordmark } from "@/components/Brand";
import {
  BookOpen, CalendarClock, Clapperboard, Compass, Eye, Home, KeyRound, Lightbulb, LogOut, MessageSquare, MoreHorizontal, PauseCircle, ScrollText, Settings, UserRound,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { etMonthKey, monthLabel } from "@/lib/contentProgram";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import {
  recordPortalVisit, enrollmentHasMembership, portalScheduleMonths, companySlotDays, portalPlanning, portalTopics, portalInterview, portalStrategy, portalMonthProgress, readOnlyNotice, homeSessionView,
  type PortalViewer, type PortalScheduleMonth, type PortalSlotDay, type PortalTopicsData, type PortalInterviewView, type PortalStrategyView, type PortalPlanning,
} from "@/lib/portal";
import { can } from "@/lib/portalAccess";
import { withMediaToken, mediaScopeOf, mediaToken } from "@/lib/portalMedia";
import { syncEnrollmentVideos, portalVideoList, videoForEnrollment, libraryAttention, videoState, type VideoListPage } from "@/lib/contentVideos";
import { cutHistory, type CutVersion } from "@/lib/clientDecisions";
import { postingKitFor, type PostingKit } from "@/lib/postingKit";
import { publishedResources, type ResourceGroupView } from "@/lib/portalResources";
import { PortalProfile } from "@/components/portal/PortalProfile";
import { SettingsTab, type SettingsData } from "@/components/portal/tabs/SettingsTab";
import { LoadFailed } from "@/components/portal/ui";
import { signOutPortal } from "@/app/portal/login/actions";
import { HomeTab, type HomeData } from "@/components/portal/tabs/HomeTab";
import { VideosList, VideoDetail, type VideoDetailData } from "@/components/portal/tabs/VideosTab";
import { TopicsTab } from "@/components/portal/tabs/TopicsTab";
import { StrategyTab } from "@/components/portal/tabs/StrategyTab";
import { ScheduleTab } from "@/components/portal/tabs/ScheduleTab";
import { ResourcesTab } from "@/components/portal/tabs/ResourcesTab";
import { MessagesTab, type MessagesTabData } from "@/components/portal/tabs/MessagesTab";
import { ContactTeam } from "@/components/portal/ContactTeam";
import { cn } from "@/lib/utils";
// UI-01 — the v2 layout (lib/portalLayout.ts decides who gets it).
import { resolvePortalRoute, portalHref, v2HrefFor, baseQueryPairs, portalNav, firstQueryValues, type PlanView } from "@/lib/portalNav";
import { portalLayoutDecision, libraryRows, reviewDeadlines } from "@/lib/portalLayout";
import { homeActions, planModel, libraryView, type HomeAction } from "@/lib/portalHome";
import { isLibraryFilter } from "@/lib/portalWords";
import { PortalShell } from "@/components/portal/PortalShell";
import { HomeV2 } from "@/components/portal/tabs/HomeTab";
import { LibraryV2, VideoDetailV2, type LibraryV2Data } from "@/components/portal/tabs/VideosTab";
import { PlanTab, type PlanTabData } from "@/components/portal/tabs/PlanTab";
import { MoreTab, TermsCard } from "@/components/portal/tabs/MoreTab";

// ---------------------------------------------------------------------------
// THE CLIENT PORTAL PAGE — one component, two routes. /portal/<token> (the
// link) and /portal/me (a signed-in person) both resolve a PortalViewer and
// hand it here; the page never looks at a cookie or a token itself.
//
// Navigation (spec §1, Sep 17): Home · My Videos · Video Topics · My Strategy
// · Schedule · Resources on a wide screen; Home · Videos · Topics · Strategy ·
// More on a phone, where More holds Schedule, Resources and the account
// (My Brand Profile, Terms, sign in/out). Every tab has a real page behind
// it. Each tab loads ONLY its own data, and every load is wrapped so a
// failure renders as "couldn't load", never as an empty program.
//
// Strict rules hold: released content only, never money, never internal
// notes. Nothing in this HTML carries the enrollment token — tab links are
// query-only, <video src> and download hrefs carry a six-hour media token
// bound to that one cut/video and this viewer's seat/link, and the client
// components read the address bar when they call an action.
//
// TWO LAYOUTS (UI-01, Sep 24 2026). The layout above is "v1" and is what every
// real client sees until Jordan turns on `portal_layout_v2`; its render below
// is deliberately left exactly as it was. "v2" — Home · My Plan · Content
// Library · Schedule · More, in PortalShell — is served to TEST clients, to
// everyone once the switch is on, and to staff who add ?layout=v2. Both read
// the same address (lib/portalNav.resolvePortalRoute: old ?tab= links land in
// either layout) and load their data through the same per-tab blocks below.
// ---------------------------------------------------------------------------

export type PortalTab = "home" | "videos" | "topics" | "strategy" | "schedule" | "resources" | "messages" | "profile" | "settings" | "terms";
const MAIN_TABS: { key: PortalTab; label: string; short: string; icon: typeof Home }[] = [
  { key: "home", label: "Home", short: "Home", icon: Home },
  { key: "videos", label: "My Videos", short: "Videos", icon: Clapperboard },
  { key: "topics", label: "Video Topics", short: "Topics", icon: Lightbulb },
  { key: "strategy", label: "My Strategy", short: "Strategy", icon: Compass },
  { key: "schedule", label: "Schedule", short: "Schedule", icon: CalendarClock },
  { key: "resources", label: "Resources", short: "Resources", icon: BookOpen },
];
const PHONE_BAR: PortalTab[] = ["home", "videos", "topics", "strategy"];
// Old links (`?tab=library`, `?tab=ideas`) keep landing somewhere sensible, and
// the v2 keys (plan, brand, team, more) degrade to the nearest v1 tab — one
// map for both layouts, in lib/portalNav.ts.
export const portalTabOf = (raw: string | undefined): PortalTab => resolvePortalRoute({ tab: raw }).v1Tab;

/** Everything the address bar may carry besides the tab. `pv` is My Plan's subview, `q`/`st` the Library's search and status filter, `layout=v2` a staff preview (all v2). */
export type PortalQuery = { tab?: string; v?: string; iv?: string; year?: string; page?: string; filter?: string; r?: string; pv?: string; q?: string; st?: string; layout?: string };

// Client-facing program terms. The AppSetting `portal-terms` overrides this
// default wholesale (blank lines split paragraphs; "## " starts a heading) —
// so the owner can rewrite the language without a deploy.
const DEFAULT_TERMS = `## The program
Your Content Program includes the monthly videos, filming sessions, scripting, editing and delivery described in your package. We plan each month together on your strategy call, film it at your session, and deliver finished videos to this portal.

## Scheduling
Strategy calls come first — we plan the month on that call, then film it. Sessions are booked after your call, and we ask for at least a few business days between the call and the shoot so scripts are ready. Need to move a session? Give us 48 hours' notice and we'll reschedule without fuss.

## Revisions
Every video comes with revision rounds to get it right. Ask right here in the portal — pause the video, tell us what to change, and it goes straight to your editor.

## Your content
Finished videos are yours to post, share and run ads with. Raw footage stays with us. We may feature finished work in our own portfolio unless you ask us not to.

## Cancellation
Month-to-month plans can cancel with notice before the next billing date. Annual commitments run their term as agreed. Questions about billing? Text Jordan directly — this portal never handles payment details.`;

const ID_RE = /^[a-z0-9]{10,40}$/i;
/** try/catch as a value: ok with the data, or failed (logged) — the tabs render both honestly. */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false }> {
  try { return { ok: true, data: await fn() }; } catch (e) { console.error(`[portal] ${what} failed`, e); return { ok: false }; }
}

export async function PortalPage({ viewer, path, baseQuery = "", query: rawQuery = {} }: {
  viewer: PortalViewer;
  /** What PortalVisit records — the pathname, never the query. */
  path: string;
  /** Query that must survive tab changes (`e=<enrollmentId>` on /portal/me). */
  baseQuery?: string;
  query?: PortalQuery;
}) {
  const { enrollment, actor, access } = viewer;
  // One string per key, whatever the address repeats (portalNav.firstQueryValues).
  const query = firstQueryValues<PortalQuery>(rawQuery);
  await recordPortalVisit(viewer, path);

  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true, brandColors: true, portalVideoStyle: true, portalPreferences: true } });
  // Where this address lands, and in which layout.
  const route = resolvePortalRoute({ tab: query.tab, pv: query.pv });
  const tab: PortalTab = route.v1Tab;
  const { layout, why } = await portalLayoutDecision(viewer, client?.name, query);
  const v2 = layout === "v2";
  /** What this visit loads: v1's tab, or nothing tab-specific for v2's More page. */
  const dataTab: PortalTab | "more" = v2 && route.dest === "more" ? "more" : tab;
  const readOnly = access !== "FULL";
  const perms = {
    request: can(viewer, "requestChanges"),
    approve: can(viewer, "approveEdits"),
    comment: can(viewer, "comment"),
    suggest: can(viewer, "suggest"),
    profile: can(viewer, "editBrandProfile"),
    session: can(viewer, "requestSession"),
  };
  const monthKey = etMonthKey();
  const scope = mediaScopeOf(viewer);
  // Greet the PERSON when we know one. A collaborator or viewer signed into
  // Cara's program was opened with "Hi Cara" — the account's name, not theirs
  // (review, Sep 17). The link seat has no person, so it keeps the account's.
  const first = ((actor.kind === "CLIENT" ? actor.name : null) || client?.name || "there").split(/\s+/)[0];
  const href = (t: string, extra?: string) => `?${baseQuery ? `${baseQuery}&` : ""}tab=${t}${extra ? `&${extra}` : ""}`;
  // v2 links carry `layout=v2` only on a staff preview — a TEST client and the
  // switch need nothing in the address. `tabHref` is the one the shared data
  // below builds links with: v1's href in v1 (unchanged), v2 addresses in v2.
  const v2Base = [baseQuery, why === "STAFF_PREVIEW" ? "layout=v2" : ""].filter(Boolean).join("&");
  const v2Href = v2HrefFor(v2Base);
  const tabHref = v2 ? v2Href : href;
  const who = actor.kind === "CLIENT" ? (actor.name || actor.email) : actor.kind === "STAFF" ? (actor.staffName || "Staff") : null;
  // "Set up your sign-in" — a link visit on a program that already has a person
  // with a seat (transition Stage B). Offered ONLY while the magic-link email
  // can actually go out: with `portal_login_email` off, this banner sends the
  // client to a form that takes their address and sends nothing, on every tab
  // of every portal including paused and ended ones (review blocker, Sep 17).
  const { portalLoginEmailEnabled } = await import("@/lib/portalAccess");
  const emailSignInLive = await portalLoginEmailEnabled().catch(() => false);
  const offerSignIn = emailSignInLive && actor.kind === "TOKEN" && (await enrollmentHasMembership(enrollment.id));

  // ---- per-tab data --------------------------------------------------------
  let home: HomeData | null = null;
  let videosPage: { ok: true; data: VideoListPage } | { ok: false } | null = null;
  let detail: VideoDetailData | null = null;
  let topicsRes: { ok: true; data: PortalTopicsData } | { ok: false } | null = null;
  let interviewRes: { ok: true; data: PortalInterviewView | null } | { ok: false } | null = null;
  let strategyRes: { ok: true; data: PortalStrategyView | null } | { ok: false } | null = null;
  let priorities: string[] = [];
  let planningRes: { ok: true; data: PortalPlanning | null } | { ok: false } | null = null;
  let scheduleRes: { ok: true; data: PortalScheduleMonth[] } | { ok: false } | null = null;
  let slotDays: PortalSlotDay[] = [];
  let sessions: { id: string; shootDate: Date | null; title: string | null; addressLine: string | null; status: string }[] = [];
  let resourcesRes: { ok: true; data: ResourceGroupView[] } | { ok: false } | null = null;

  if (dataTab === "home" || dataTab === "videos") {
    // The library's logical videos are built from the cuts and delivery rows
    // (idempotent, additive) before they are read.
    await attempt("video sync", () => syncEnrollmentVideos(enrollment));
  }
  if (dataTab === "home") {
    const [planning, schedule, videos, topics, released, month, progress, attention] = await Promise.all([
      attempt("planning", () => portalPlanning(enrollment)),
      attempt("schedule", () => portalScheduleMonths(enrollment)),
      attempt("videos", () => portalVideoList(enrollment, { page: 1, perPage: 24 })),
      attempt("topics", () => portalTopics(enrollment)),
      attempt("strategy", () => prisma.contentStrategyVersion.count({ where: { enrollmentId: enrollment.id, releasedAt: { not: null } } })),
      prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, monthKey }, select: { videosOwed: true } }),
      // The month through lib/monthProgress (CP-10): sessions and the meter
      // read the same facts Jordan's roster and the client file do.
      attempt("progress", () => portalMonthProgress(enrollment, monthKey)),
      // Library-wide, not page one: "N waiting on you" is a library fact.
      attempt("attention", () => libraryAttention(enrollment)),
    ]);
    home = {
      first, monthKey, videosOwed: month?.videosOwed ?? enrollment.videosPerMonth,
      program: progress.ok ? { delivered: progress.data.production.delivered, total: progress.data.production.total } : null, countsFailed: !progress.ok,
      progress: progress.ok ? progress.data : null,
      planning: planning.ok ? planning.data : null, planningFailed: !planning.ok,
      schedule: schedule.ok ? schedule.data.find((m) => m.monthKey === monthKey) ?? schedule.data[0] ?? null : null, scheduleFailed: !schedule.ok,
      bookingUrl: STRATEGY_CALL_BOOKING_URL,
      videos: videos.ok ? { rows: videos.data.rows, total: videos.data.total } : null, videosFailed: !videos.ok,
      attention: attention.ok ? attention.data : null,
      topics: topics.ok ? topics.data : null, topicsFailed: !topics.ok,
      strategyReleased: released.ok ? released.data > 0 : null,
      perms: { session: perms.session, suggest: perms.suggest, request: perms.request, approve: perms.approve }, readOnly,
      readOnlyState: readOnly ? (enrollment.status === "PAUSED" ? "PAUSED" : "ENDED") : null,
    };
    // CP-06: the account-setup checklist — derived from what is on file, only
    // for someone who can act on it, and never on a paused/ended program.
    if (!readOnly && perms.profile) {
      const setup = await attempt("setup", async () => (await import("@/lib/portalSetup")).setupChecklist(viewer));
      if (setup.ok) home.setup = { ...setup.data, items: setup.data.items.map((i) => ({ ...i, href: `${tabHref(i.tab)}#${i.anchor}` })) };
    }
  }
  if (dataTab === "videos") {
    const vId = query.v && ID_RE.test(query.v) ? query.v : null;
    if (vId) {
      const video = await videoForEnrollment(enrollment, vId).catch(() => null);
      if (video) {
        const [hist, kit, deliveredSrc] = await Promise.all([
          attempt("cut history", () => (video.currentSubmissionId ? cutHistory(viewer, video.currentSubmissionId) : Promise.resolve([] as CutVersion[]))),
          attempt("posting kit", () => postingKitFor(viewer, video)),
          prisma.contentVideoSource.findFirst({ where: { videoId: video.id, kind: "PORTAL_VIDEO" }, orderBy: { isFinal: "desc" }, select: { portalVideoId: true } })
            .then(async (s) => (s?.portalVideoId ? prisma.portalVideo.findUnique({ where: { id: s.portalVideoId }, select: { playback: true, thumb: true } }) : null)).catch(() => null),
        ]);
        const versions = hist.ok ? hist.data.map((v) => ({ ...v, assetUrl: v.assetUrl ? withMediaToken(v.assetUrl, scope) : null })) : [];
        // CP-02: the review deadline and rounds used ride on the CURRENT version
        // into CutReview — from the window the server enforces; null (nothing
        // shown) while revision_policy is off.
        const reviewing = versions.find((x) => x.isCurrent);
        if (reviewing) reviewing.review = await import("@/lib/reviewWindows").then((m) => m.reviewPanelFor(viewer, reviewing.submissionId)).catch(() => null);
        const pillar = video.pillarId ? await prisma.contentPillar.findUnique({ where: { id: video.pillarId }, select: { name: true } }).catch(() => null) : null;
        const kitData: PostingKit | null = kit.ok ? kit.data : null;
        // The state comes from the video row itself, through the one derivation
        // the list uses — never from whichever page happened to be fetched.
        const current = versions.find((x) => x.isCurrent);
        const state = await videoState(enrollment.id, video).catch(() =>
          current?.clientState === "YOU_APPROVED" ? "APPROVED" : current?.clientState === "AWAITING_YOUR_DECISION" ? "FOR_REVIEW" : current?.clientState === "YOU_REQUESTED_CHANGES" ? "CHANGES_IN_PROGRESS" : video.status === "DELIVERED" ? "DELIVERED" : "IN_PRODUCTION",
        );
        detail = {
          video: {
            id: video.id, title: video.title ?? "Video", monthKey: video.monthKey, kind: video.kind, state, filmedAtISO: video.filmedAt?.toISOString() ?? null, deliveredAtISO: video.deliveredAt?.toISOString() ?? null, pillarName: pillar?.name ?? null, format: video.format,
            // CP-12: older backfill is "Previous content", never labelled with a month we can't vouch for.
            section: await import("@/lib/contentVideos").then((m) => m.videoLibrarySection(video)).catch(() => "RECENT" as const),
          },
          versions, versionsFailed: !hist.ok,
          kit: kitData, kitFailed: !kit.ok,
          // A delivered (Aryeo/Mux) file plays directly — it is a CDN URL, not a hub cut, so no token applies.
          delivered: deliveredSrc?.playback && !/^\/api\/review\/cut\//.test(deliveredSrc.playback) ? { playback: deliveredSrc.playback, thumb: deliveredSrc.thumb } : null,
          // The download door: a media token over the VIDEO id, scoped to this viewer.
          downloadHref: kitData?.access.download ? `/api/portal/download/${video.id}?m=${encodeURIComponent(mediaToken(video.id, scope))}` : null,
          perms: { comment: perms.comment, request: perms.request, approve: perms.approve, suggest: perms.suggest }, readOnly,
          // Only the emailed-link seat can never approve; point it at the door
          // that leads to one that can — when that door actually opens.
          signInHref: actor.kind === "TOKEN" && emailSignInLive ? "/portal/login" : null,
        };
      }
    }
    if (!detail && !v2) {
      const year = query.year && /^\d{4}$/.test(query.year) ? Number(query.year) : null;
      const page = query.page && /^\d{1,4}$/.test(query.page) ? Number(query.page) : 1;
      // CP-12: `filter=previous` is the flat "Previous content" section.
      videosPage = await attempt("videos", () => portalVideoList(enrollment, { year, page, section: query.filter === "previous" ? "previous" : null }));
    }
  }
  if (dataTab === "topics") {
    const ivId = query.iv && ID_RE.test(query.iv) ? query.iv : null;
    if (ivId) interviewRes = await attempt("interview", () => portalInterview(enrollment, ivId));
    if (!ivId || (interviewRes?.ok && !interviewRes.data)) topicsRes = await attempt("topics", () => portalTopics(enrollment));
  }
  if (dataTab === "strategy") {
    const [s, m] = await Promise.all([
      attempt("strategy", () => portalStrategy(enrollment)),
      prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, monthKey }, select: { prioritiesJson: true } }).catch(() => null),
    ]);
    strategyRes = s;
    if (m?.prioritiesJson) { const { monthPriorities } = await import("@/lib/contentStrategy"); priorities = monthPriorities(m.prioritiesJson); }
  }
  if (dataTab === "schedule") {
    const [p, s, sess] = await Promise.all([
      attempt("planning", () => portalPlanning(enrollment)),
      attempt("schedule months", () => portalScheduleMonths(enrollment)),
      prisma.project.findMany({
        where: { clientId: enrollment.clientId, contentMonthId: { not: null }, status: { not: "CANCELLED" }, shootDate: { not: null } },
        orderBy: { shootDate: "desc" }, take: 24, select: { id: true, shootDate: true, status: true, title: true, addressLine: true, contentMonthId: true },
      }).catch(() => []),
    ]);
    planningRes = p; scheduleRes = s;
    // Only this enrollment's months (a project on another program's month is not a session here).
    const monthIds = new Set((await prisma.contentMonth.findMany({ where: { enrollmentId: enrollment.id }, select: { id: true } })).map((m) => m.id));
    sessions = sess.filter((x) => x.contentMonthId && monthIds.has(x.contentMonthId));
    // Live Aryeo slots only when a picker could actually render — to book, or
    // (CP-04) to move a session. The viewer's OWN package's product: a Starter
    // client gets the two-hour calendar, not Accelerator's four-hour one.
    if (s.ok && perms.session && !readOnly && s.data.some((m) => !m.locked && (m.capacity.remaining > 0 || m.requests.some((r) => r.canChange)))) {
      const pkg = (await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { package: true } }).catch(() => null))?.package ?? null;
      slotDays = await companySlotDays({ package: pkg }).catch(() => []);
    }
  }
  if (dataTab === "resources") resourcesRes = await attempt("resources", () => publishedResources());

  // CP-13 — THE PROGRAM CONVERSATION and how to reach the office. The unread
  // count rides on every tab (the menu badge and Home's "new reply" row read
  // it); the thread loads only on its own tab and is marked read AFTER it is
  // counted, so the page can show where the new replies start. Staff through
  // the owner iframe move their own marker, never the client's.
  const pm = await import("@/lib/programMessages");
  const contact = await pm.portalContact();
  const canMessage = can(viewer, "message");
  const readerKey = pm.readerKeyFor(viewer);
  const messagesUnread = dataTab === "messages" ? 0 : await pm.unreadForReader(enrollment.id, readerKey).catch(() => 0);
  let messagesRes: { ok: true; data: MessagesTabData } | { ok: false } | null = null;
  if (dataTab === "messages") {
    messagesRes = await attempt("messages", async () => {
      const t = await pm.threadFor(enrollment.id, readerKey, { audience: "client" });
      await pm.markThreadRead(enrollment.id, readerKey).catch(() => {});
      const { refusalMessage } = await import("@/lib/portalAccess");
      return {
        messages: t.messages, unreadBefore: t.unread,
        ownerFirst: t.owner.label && t.owner.label !== "unassigned" ? t.owner.label.split(/\s+/)[0] : contact.name,
        canMessage, refusal: canMessage ? null : refusalMessage(viewer, "message"), contact, hint: pm.VIDEO_CHANGES_HINT,
      };
    });
  }
  if (home) home.messages = messagesUnread > 0 ? { unread: messagesUnread, href: tabHref("messages") } : null;

  // THE BRAND PROFILE (CP-06). Prefill — Jordan: seed from what we already
  // know; the client overwrites — applies ONLY to a column that was never set
  // (NULL). A column the client cleared ("") stays empty: the old truthiness
  // test put the AI's read straight back after every clear.
  let brand: import("@/lib/brandProfile").PortalBrandView | null = null;
  let brandFailed = false;
  const suggested = { brandColors: "", videoStyle: "", preferences: "" };
  if (dataTab === "profile") {
    const view = await attempt("brand profile", async () => (await import("@/lib/brandProfile")).portalBrandProfileView(enrollment.clientId));
    if (view.ok) brand = view.data; else brandFailed = true;
    if (brand && (brand.columns.videoStyle == null || brand.columns.preferences == null)) {
      const { getPortalPrefill } = await import("@/lib/portalPrefill");
      const extracted = await getPortalPrefill(enrollment.id, enrollment.clientId).catch(() => ({ videoStyle: "", preferences: "" }));
      suggested.videoStyle = extracted.videoStyle;
      suggested.preferences = extracted.preferences;
    }
    if (brand && brand.columns.brandColors == null) {
      const ap = await prisma.agentProfile.findUnique({ where: { clientId: enrollment.clientId }, select: { brandJson: true } }).catch(() => null);
      const hexes = [...new Set(((ap?.brandJson ?? "").match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? []))];
      suggested.brandColors = hexes.join(", ");
    }
  }
  let settings: SettingsData | null = null;
  if (dataTab === "settings") {
    const { teamSeats } = await import("@/lib/portalTeam");
    const team = can(viewer, "manageTeam") ? await attempt("team", () => teamSeats(viewer)) : null;
    settings = {
      who: actor.kind === "CLIENT" ? { name: actor.name, email: actor.email, role: actor.membershipRole } : null,
      viewerKind: actor.kind, readOnly, programStatus: enrollment.status,
      canManageTeam: can(viewer, "manageTeam"),
      team: team && team.ok && team.data.ok ? { seats: team.data.seats, invitationsOn: team.data.invitationsOn } : null,
      teamFailed: !!team && (!team.ok || !team.data.ok),
      signInEmailOn: emailSignInLive,
      profileHref: tabHref("profile"),
      // v2 names the page as its nav does, and the office line comes from the
      // owner-editable contact. v1 passes neither (its element tree stays
      // HEAD's) and SettingsTab falls back to its own words and Kyle's line.
      ...(v2 ? { profileLabel: "Brand Profile", contactLine: `call or text ${contact.name} at ${contact.display}` } : {}),
    };
  }
  const termsSetting = dataTab === "terms" ? await prisma.appSetting.findUnique({ where: { key: "portal-terms" } }).catch(() => null) : null;
  const terms = (termsSetting?.value?.trim() || DEFAULT_TERMS).split(/\n\s*\n/);

  if (v2) {
    // ---- v2: what the navigation counts, from the readers the tabs use ----
    // Loaded on every page so a badge never appears on one tab and vanishes on
    // the next; each is wrapped, and an unreadable count is no badge, not zero.
    const [attn, topicsAll, guides, setupMore] = await Promise.all([
      home?.attention ? Promise.resolve({ ok: true as const, data: home.attention }) : attempt("attention", () => libraryAttention(enrollment)),
      topicsRes?.ok ? Promise.resolve(topicsRes) : home?.topics ? Promise.resolve({ ok: true as const, data: home.topics }) : attempt("topics", () => portalTopics(enrollment)),
      resourcesRes ?? attempt("resources", () => publishedResources()),
      dataTab === "more" && !readOnly && perms.profile
        ? attempt("setup", async () => (await import("@/lib/portalSetup")).setupChecklist(viewer, { folder: false }))
        : Promise.resolve(null),
    ]);
    const plan = topicsAll.ok ? planModel(topicsAll.data, monthKey) : null;
    const published = guides.ok ? guides.data.reduce((n, g) => n + g.resources.length, 0) : 0;
    const nav = portalNav({ publishedResources: published, badges: { plan: plan?.scripts.length, library: attn.ok ? attn.data.needReview : 0, messages: messagesUnread } });
    const linked = { primary: nav.primary.map((i) => ({ ...i, href: portalHref(v2Base, i.dest) })), more: nav.more.map((i) => ({ ...i, href: portalHref(v2Base, i.dest) })) };

    // ---- Home: the one next step ----
    let actions: { primary: HomeAction | null; more: HomeAction[] } = { primary: null, more: [] };
    if (home) {
      const pageRows = home.videos?.rows ?? [];
      let waiting = pageRows.filter((r) => r.state === "FOR_REVIEW");
      // The count is library-wide; page one may not hold every one of them.
      if ((home.attention?.needReview ?? 0) > waiting.length) {
        const all = await attempt("library", () => libraryRows(enrollment));
        if (all.ok) waiting = all.data.rows.filter((r) => r.state === "FOR_REVIEW");
      }
      const deadlines = await reviewDeadlines(viewer, waiting).catch(() => new Map<string, { iso: string; label: string }>());
      const soonest = [...deadlines.values()].sort((a, b) => a.iso.localeCompare(b.iso))[0] ?? null;
      const reviewCount = home.attention?.needReview ?? waiting.length;
      const readyPage = pageRows.filter((r) => (r.state === "APPROVED" || r.state === "DELIVERED") && r.downloadable);
      const readyCount = home.attention?.readyToUse ?? readyPage.length;
      const sv = homeSessionView(home.progress, home.schedule, { canBook: perms.session, readOnly });
      const hp = home.topics ? planModel(home.topics, monthKey) : plan;
      actions = homeActions({
        status: enrollment.status, readOnly, perms,
        review: { count: reviewCount, single: reviewCount === 1 && waiting.length === 1 ? { id: waiting[0].id, title: waiting[0].title } : null, soonestDeadlineLabel: soonest?.label ?? null },
        scripts: (hp?.scripts ?? []).map((t) => ({ topicId: t.id, title: t.title })),
        unread: messagesUnread,
        planning: home.planning ? { planningMode: home.planning.planningMode, callStatus: home.planning.callStatus, noCallEligible: home.planning.noCallEligible } : null,
        month: hp?.month ? { monthKey: hp.month.monthKey, label: monthLabel(hp.month.monthKey), owed: hp.month.owed, selected: hp.month.selected } : null,
        toAnswer: (hp?.toAnswer ?? []).map((t) => ({ title: t.title, missing: t.plan?.missing ?? 0 })),
        session: { offerBooking: sv.offerBooking, required: sv.required, missing: sv.missing },
        addressNeeded: home.schedule?.sessions.filter((x) => x.addressNeeded).length ?? 0,
        setup: home.setup ? { complete: home.setup.complete, remaining: Math.max(0, home.setup.total - home.setup.done) } : null,
        ready: { count: readyCount, withFile: home.attention ? home.attention.readyWithFile > 0 : readyPage.length > 0, single: readyCount === 1 && readyPage.length === 1 ? { id: readyPage[0].id, title: readyPage[0].title } : null },
      }, v2Base);
    }

    // ---- Content Library: search + filters over the whole library ----
    let library: LibraryV2Data | null = null;
    let libraryFailed = false;
    if (route.dest === "library" && !detail) {
      const all = await attempt("library", () => libraryRows(enrollment));
      if (all.ok) {
        const view = libraryView(all.data.rows, { q: query.q, st: isLibraryFilter(query.st) ? query.st : "all", page: query.page && /^\d{1,4}$/.test(query.page) ? Number(query.page) : 1 });
        const deadlines = await reviewDeadlines(viewer, view.review).catch(() => new Map<string, { iso: string; label: string }>());
        library = { view, deadlines: Object.fromEntries([...deadlines].map(([id, d]) => [id, d.label])), hidden: baseQueryPairs(v2Base), incomplete: !all.data.complete };
      } else libraryFailed = true;
    }

    const planHrefs: Record<PlanView, string> = {
      month: portalHref(v2Base, "plan"), scripts: portalHref(v2Base, "plan", "pv=scripts"), bank: portalHref(v2Base, "plan", "pv=bank"), strategy: portalHref(v2Base, "plan", "pv=strategy"),
    };

    // ---- Your Month: the guided plan needs the month's planning, its
    // scheduling card and (to book) the live slots — the same loads the
    // Schedule page makes, each wrapped so a failure reads "couldn't load".
    let yourMonth: PlanTabData["yourMonth"] = null;
    if (route.dest === "plan" && route.planView === "month" && !interviewRes) {
      const [p, sm] = await Promise.all([
        attempt("planning", () => portalPlanning(enrollment)),
        attempt("schedule months", () => portalScheduleMonths(enrollment)),
      ]);
      const thisMonth = p.ok && p.data && sm.ok ? sm.data.find((m) => m.monthId === p.data!.monthId) ?? null : null;
      let days: PortalSlotDay[] = [];
      if (thisMonth && perms.session && !readOnly && !thisMonth.locked && (thisMonth.capacity.remaining > 0 || thisMonth.requests.some((r) => r.canChange))) {
        const pkg = (await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { package: true } }).catch(() => null))?.package ?? null;
        days = await companySlotDays({ package: pkg }).catch(() => []);
      }
      yourMonth = {
        planning: p.ok ? p.data : null, planningFailed: !p.ok,
        schedule: thisMonth, scheduleFailed: !sm.ok,
        slotDays: days, bookingUrl: STRATEGY_CALL_BOOKING_URL,
        can: { suggest: perms.suggest, session: perms.session },
        scheduleHref: portalHref(v2Base, "schedule"),
      };
    }
    const setupLeft = setupMore?.ok && !setupMore.data.complete ? Math.max(0, setupMore.data.total - setupMore.data.done) : null;
    return (
      <PortalShell
        clientName={client?.name ?? null}
        dest={route.dest}
        nav={linked}
        notices={{
          readOnly: readOnly ? readOnlyNotice(enrollment.status) : null,
          staff: actor.kind === "STAFF" ? { who: who ?? "Staff", clientName: client?.name ?? "", exitHref: why === "STAFF_PREVIEW" ? href(tab) : null } : null,
          offerSignIn,
          viewOnlySeat: actor.kind === "CLIENT" && actor.membershipRole === "VIEWER" && !readOnly,
        }}
        // CP-13: the conversation when this viewer may use it, the office line always.
        footer={route.dest !== "messages" ? <ContactTeam contact={contact} messagesHref={canMessage ? v2Href("messages") : null} className="mt-8" /> : null}
      >
        {route.dest === "home" && home && <HomeV2 d={home} actions={actions} href={v2Href} />}
        {route.dest === "plan" && route.planView && (
          <PlanTab d={{
            view: route.planView,
            topics: topicsAll.ok ? topicsAll.data : null, topicsFailed: !topicsAll.ok,
            interview: interviewRes?.ok ? interviewRes.data : null, interviewFailed: !!interviewRes && !interviewRes.ok,
            strategy: strategyRes?.ok ? strategyRes.data : null, strategyFailed: !!strategyRes && !strategyRes.ok, priorities,
            monthKey, canAct: perms.suggest, readOnly, filter: query.filter, hrefs: planHrefs, yourMonth,
          }} />
        )}
        {route.dest === "library" && (detail ? <VideoDetailV2 d={detail} href={v2Href} /> : <LibraryV2 d={library} failed={libraryFailed} href={v2Href} />)}
        {route.dest === "schedule" && (
          <ScheduleTab
            planning={planningRes?.ok ? planningRes.data : null} planningFailed={!!planningRes && !planningRes.ok}
            months={scheduleRes?.ok ? scheduleRes.data : []} scheduleFailed={!!scheduleRes && !scheduleRes.ok}
            slotDays={slotDays} bookingUrl={STRATEGY_CALL_BOOKING_URL} sessions={sessions} perms={{ session: perms.session }} readOnly={readOnly}
            topicsHref={planHrefs.month} topicsLabel="Your Month" routeHref={`${planHrefs.month}#step-route`}
          />
        )}
        {route.dest === "more" && (
          <MoreTab d={{
            items: linked.more, setupLeft, who, staff: actor.kind === "STAFF", clientFirst: (client?.name || "the client").split(/\s+/)[0],
            canSignOut: actor.kind === "CLIENT", offerSignIn,
          }} />
        )}
        {route.dest === "brand" && (
          <div className="mt-6 space-y-4">
            <h1 className="text-xl font-semibold tracking-tight">Brand Profile</h1>
            {brand ? <PortalProfile view={brand} suggested={suggested} readOnly={!perms.profile} /> : brandFailed ? <LoadFailed what="your brand profile" /> : null}
          </div>
        )}
        {route.dest === "messages" && <MessagesTab d={messagesRes?.ok ? messagesRes.data : null} failed={!!messagesRes && !messagesRes.ok} />}
        {route.dest === "resources" && <ResourcesTab groups={resourcesRes?.ok ? resourcesRes.data : null} failed={!!resourcesRes && !resourcesRes.ok} open={query.r} contact={contact} messagesHref={canMessage ? v2Href("messages") : null} />}
        {route.dest === "team" && settings && <SettingsTab d={settings} />}
        {route.dest === "terms" && <TermsCard blocks={terms} />}
      </PortalShell>
    );
  }

  // ======================== v1 — today's page, unchanged ========================
  const account = { who, staff: actor.kind === "STAFF", first, profileHref: href("profile"), settingsHref: href("settings"), termsHref: href("terms"), messagesHref: href("messages"), unread: messagesUnread, tab, canSignOut: actor.kind === "CLIENT", offerSignIn };

  return (
    // The Shell renders /portal bare (isBare in src/components/Shell.tsx); this
    // full-viewport layer is the portal's own scroll surface.
    <div className="portal-light fixed inset-0 z-50 overflow-y-auto bg-background text-foreground">
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 h-72" style={{ background: "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--brand) 14%, transparent), transparent 70%)" }} />
      <div className="relative mx-auto max-w-3xl p-4 pb-28 sm:p-6 sm:pb-24">
        {/* BRAND + NAME + ACCOUNT MENU */}
        <div className="flex items-center gap-3 pt-4">
          <BrandWordmark variant="onLight" className="h-5 sm:h-6" />
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <div className="min-w-0 text-right">
              <div className="truncate text-sm font-semibold leading-tight">{client?.name}</div>
              <div className="text-[11px] text-muted-2">Content Program</div>
            </div>
            <details className="relative">
              <summary className="relative flex size-9 cursor-pointer list-none items-center justify-center rounded-full border border-border bg-surface/80 text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden" aria-label="Account menu">
                <UserRound className="size-4" />
                {messagesUnread > 0 && <span className="absolute right-0 top-0 size-2.5 rounded-full bg-brand ring-2 ring-background" aria-label={`${messagesUnread} new message${messagesUnread === 1 ? "" : "s"}`} />}
              </summary>
              <div className="absolute right-0 z-10 mt-2 w-60 rounded-2xl border border-border bg-surface p-1.5 shadow-lg"><AccountItems a={account} /></div>
            </details>
          </div>
        </div>

        {/* TABS — segmented pill on wider screens; the phone gets the bottom bar. */}
        <nav aria-label="Portal sections" className="mt-5 hidden gap-1 rounded-2xl border border-border bg-surface/70 p-1 backdrop-blur sm:flex">
          {MAIN_TABS.map((t) => (
            <Link key={t.key} href={href(t.key)} aria-current={tab === t.key ? "page" : undefined}
              className={cn("flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 py-2 text-[13px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tab === t.key ? "bg-brand text-white shadow" : "text-muted hover:text-foreground")}>
              <t.icon className="size-4" /> {t.label}
            </Link>
          ))}
        </nav>

        {/* NOTICES */}
        {readOnly && (() => {
          // CP-12: one wording of the paused/ended state, with the way back.
          const n = readOnlyNotice(enrollment.status);
          return (
            <div className="mt-5 flex flex-wrap items-start gap-2 rounded-2xl border border-border bg-surface/80 p-3.5 text-sm">
              <PauseCircle className="mt-0.5 size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1 basis-56">
                <div className="font-semibold">{n.title}</div>
                <div className="text-xs text-muted">{n.body}</div>
              </div>
              <a href={n.cta.href} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{n.cta.label}</a>
            </div>
          );
        })()}
        {actor.kind === "STAFF" && (
          <div className="mt-5 flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft/40 p-3.5 text-sm">
            <Eye className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="text-xs">You&rsquo;re viewing this as <span className="font-semibold">{who}</span>, on {client?.name}&rsquo;s behalf. Anything you submit here is recorded as <span className="font-semibold">you, on their behalf</span> — never as them.
              {/* UI-01: staff only. The client keeps this layout until portal_layout_v2 is on. */}
              {" "}<Link href={`${href(tab)}&layout=v2`} className="font-semibold text-brand hover:underline">Preview the new layout</Link></div>
          </div>
        )}
        {offerSignIn && (
          <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-brand/30 bg-brand-soft/40 p-3.5 text-sm">
            <KeyRound className="size-4 shrink-0 text-brand" />
            <span className="min-w-0 flex-1 text-xs">Set up your sign-in — a personal link by email, so this page is yours wherever you open it. This link keeps working too.</span>
            <Link href="/portal/login" className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">Sign in with email</Link>
          </div>
        )}
        {actor.kind === "CLIENT" && actor.membershipRole === "VIEWER" && !readOnly && (
          <div className="mt-5 flex items-start gap-2 rounded-2xl border border-border bg-surface/80 p-3.5 text-xs text-muted">
            <Eye className="mt-0.5 size-4 shrink-0" /> You have view-only access to this program. The program owner can make changes.
          </div>
        )}

        {/* ---------------- TABS ---------------- */}
        {tab === "home" && home && <HomeTab d={home} href={href} />}
        {tab === "videos" && (detail ? <VideoDetail d={detail} href={href} /> : <VideosList page={videosPage?.ok ? videosPage.data : null} failed={!!videosPage && !videosPage.ok} href={href} />)}
        {tab === "topics" && (
          <TopicsTab
            topics={topicsRes?.ok ? topicsRes.data : null} failed={!!topicsRes && !topicsRes.ok}
            interview={interviewRes?.ok ? interviewRes.data : null} interviewFailed={!!interviewRes && !interviewRes.ok}
            href={href} canAct={perms.suggest} readOnly={readOnly} filter={query.filter}
          />
        )}
        {tab === "strategy" && <StrategyTab strategy={strategyRes?.ok ? strategyRes.data : null} failed={!!strategyRes && !strategyRes.ok} priorities={priorities} monthKey={monthKey} canSuggest={perms.suggest} readOnly={readOnly} />}
        {tab === "schedule" && (
          <ScheduleTab
            planning={planningRes?.ok ? planningRes.data : null} planningFailed={!!planningRes && !planningRes.ok}
            months={scheduleRes?.ok ? scheduleRes.data : []} scheduleFailed={!!scheduleRes && !scheduleRes.ok}
            slotDays={slotDays} bookingUrl={STRATEGY_CALL_BOOKING_URL} sessions={sessions} perms={{ session: perms.session }} readOnly={readOnly}
            topicsHref={href("topics")}
          />
        )}
        {tab === "resources" && <ResourcesTab groups={resourcesRes?.ok ? resourcesRes.data : null} failed={!!resourcesRes && !resourcesRes.ok} open={query.r} contact={contact} messagesHref={canMessage ? href("messages") : null} />}
        {tab === "messages" && <MessagesTab d={messagesRes?.ok ? messagesRes.data : null} failed={!!messagesRes && !messagesRes.ok} />}

        {/* ---------------- MY BRAND PROFILE ---------------- */}
        {tab === "profile" && (
          <div className="mt-6 space-y-4">
            <h1 className="text-xl font-semibold tracking-tight">My Brand Profile</h1>
            {brand ? (
              <PortalProfile view={brand} suggested={suggested} readOnly={!perms.profile} />
            ) : brandFailed ? (
              <LoadFailed what="your brand profile" />
            ) : null}
          </div>
        )}

        {/* ---------------- SETTINGS & TEAM (CP-06) ---------------- */}
        {tab === "settings" && settings && <SettingsTab d={settings} />}

        {/* ---------------- TERMS ---------------- */}
        {tab === "terms" && (
          <div className="panel-shadow mt-6 rounded-2xl border border-border bg-surface/70 p-5 backdrop-blur">
            <div className="flex items-center gap-2 text-sm font-semibold"><ScrollText className="size-4 text-brand" /> Terms of Service</div>
            <div className="mt-3 space-y-3">
              {terms.map((block, i) => {
                if (block.startsWith("## ")) {
                  const [head, ...rest] = block.split("\n");
                  const body = rest.join("\n").trim();
                  return (
                    <div key={i}>
                      <h3 className="pt-3 text-sm font-bold text-foreground">{head.replace(/^## /, "")}</h3>
                      {body && (rest.every((l) => !l.trim() || l.trim().startsWith("- ")) ? (
                        <ul className="mt-2 space-y-1 pl-1">{rest.filter((l) => l.trim().startsWith("- ")).map((l, j) => <li key={j} className="flex gap-2 text-sm leading-relaxed text-foreground/85"><span className="text-brand">·</span><span>{l.trim().replace(/^- /, "")}</span></li>)}</ul>
                      ) : (
                        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/85">{body}</p>
                      ))}
                    </div>
                  );
                }
                const lines = block.split("\n");
                if (lines.every((l) => l.trim().startsWith("- "))) {
                  return <ul key={i} className="space-y-1 pl-1">{lines.map((l, j) => <li key={j} className="flex gap-2 text-sm leading-relaxed text-foreground/85"><span className="text-brand">·</span><span>{l.trim().replace(/^- /, "")}</span></li>)}</ul>;
                }
                return <p key={i} className="whitespace-pre-line text-sm leading-relaxed text-foreground/85">{block}</p>;
              })}
            </div>
          </div>
        )}

        {/* CP-13: the footer used to tell clients to text us, with nothing to
            text. The conversation when this viewer may use it, the office line always. */}
        {tab !== "messages" && <ContactTeam contact={contact} messagesHref={canMessage ? href("messages") : null} className="mt-8" />}
      </div>

      {/* PHONE BAR — Home · Videos · Topics · Strategy · More. */}
      <nav aria-label="Portal sections" className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur sm:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="mx-auto grid max-w-3xl grid-cols-5">
          {MAIN_TABS.filter((t) => PHONE_BAR.includes(t.key)).map((t) => (
            <Link key={t.key} href={href(t.key)} aria-current={tab === t.key ? "page" : undefined} className={cn("flex min-h-12 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tab === t.key ? "text-brand" : "text-muted")}>
              <t.icon className="size-5" /> {t.short}
            </Link>
          ))}
          <details className="group relative">
            <summary className={cn("flex min-h-12 cursor-pointer list-none flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden", ["schedule", "resources", "messages", "profile", "settings", "terms"].includes(tab) ? "text-brand" : "text-muted")}>
              <span className="relative"><MoreHorizontal className="size-5" />{messagesUnread > 0 && <span className="absolute -right-1 -top-0.5 size-2 rounded-full bg-brand" aria-hidden />}</span> More
            </summary>
            <div className="absolute bottom-full right-2 mb-2 w-60 rounded-2xl border border-border bg-surface p-1.5 shadow-lg">
              <MenuLink href={href("schedule")} icon={CalendarClock} active={tab === "schedule"}>Schedule</MenuLink>
              <MenuLink href={href("resources")} icon={BookOpen} active={tab === "resources"}>Resources</MenuLink>
              <div className="my-1 border-t border-border" />
              <div className="px-3 pt-1 text-[10px] font-semibold uppercase tracking-widest text-muted-2">Account</div>
              <AccountItems a={account} />
            </div>
          </details>
        </div>
      </nav>
    </div>
  );
}

function MenuLink({ href, icon: Icon, active = false, children }: { href: string; icon: typeof Home; active?: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2 rounded-xl px-3 py-2 text-sm hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", active ? "font-semibold text-brand" : "text-muted")}>
      <Icon className="size-4" /> {children}
    </Link>
  );
}

type AccountMenu = { who: string | null; staff: boolean; first: string; profileHref: string; settingsHref: string; termsHref: string; messagesHref: string; unread: number; tab: PortalTab; canSignOut: boolean; offerSignIn: boolean };
/** The account menu's items — shared by the top-right menu and the phone bar's More sheet. */
function AccountItems({ a }: { a: AccountMenu }) {
  return (
    <>
      {a.who && (
        <div className="px-3 py-2 text-xs text-muted-2">
          {a.staff ? <>Viewing as <span className="font-semibold text-foreground">{a.who}</span> on {a.first}&rsquo;s behalf</> : <>Signed in as <span className="font-semibold text-foreground">{a.who}</span></>}
        </div>
      )}
      <MenuLink href={a.messagesHref} icon={MessageSquare} active={a.tab === "messages"}>
        Messages{a.unread > 0 && <span className="ml-auto rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white">{a.unread}</span>}
      </MenuLink>
      <MenuLink href={a.profileHref} icon={UserRound} active={a.tab === "profile"}>My Brand Profile</MenuLink>
      <MenuLink href={a.settingsHref} icon={Settings} active={a.tab === "settings"}>Settings &amp; team</MenuLink>
      <MenuLink href={a.termsHref} icon={ScrollText} active={a.tab === "terms"}>Terms</MenuLink>
      {a.canSignOut && (
        <form action={signOutPortal}>
          <button type="submit" className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><LogOut className="size-4" /> Sign out</button>
        </form>
      )}
      {a.offerSignIn && <MenuLink href="/portal/login" icon={KeyRound}>Sign in with email</MenuLink>}
    </>
  );
}
