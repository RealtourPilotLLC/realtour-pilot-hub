import { prisma } from "@/lib/prisma";
import { etMonthKey, monthLabel, portalLastMonthKey } from "@/lib/contentProgram";
import { portalBookingLinks, type PortalCallBookingView } from "@/lib/callBooking";
import {
  recordPortalVisit, enrollmentHasMembership, portalScheduleMonths, companySlotDays, portalPlanning, portalTopics, portalInterview, portalStrategy, portalMonthProgress, readOnlyNotice, homeSessionView,
  type PortalViewer, type PortalSlotDay, type PortalTopicsData, type PortalInterviewView, type PortalStrategyView,
} from "@/lib/portal";
import { can } from "@/lib/portalAccess";
import { withMediaToken, mediaScopeOf, mediaToken } from "@/lib/portalMedia";
import { syncEnrollmentVideos, portalVideoList, videoForEnrollment, libraryAttention, videoState, deliveredMediaFor, isUpdatedVersion } from "@/lib/contentVideos";
import { cutHistory, type CutVersion } from "@/lib/clientDecisions";
import { postingKitFor, type PostingKit } from "@/lib/postingKit";
import { publishedResources, type ResourceGroupView } from "@/lib/portalResources";
import { PortalProfile } from "@/components/portal/PortalProfile";
import { SettingsTab, type SettingsData } from "@/components/portal/tabs/SettingsTab";
import { LoadFailed } from "@/components/portal/ui";
import { HomeV2, type HomeData } from "@/components/portal/tabs/HomeTab";
import { LibraryV2, VideoDetailV2, type LibraryV2Data, type VideoDetailData } from "@/components/portal/tabs/VideosTab";
import { ResourcesTab } from "@/components/portal/tabs/ResourcesTab";
import { MessagesTab, type MessagesTabData } from "@/components/portal/tabs/MessagesTab";
import { ContactTeam } from "@/components/portal/ContactTeam";
import { resolvePortalRoute, portalHref, v2HrefFor, baseQueryPairs, portalNav, firstQueryValues, type PlanView } from "@/lib/portalNav";
import { portalMonthHref, portalMonthKey, portalSessionIndex, selectedPortalMonth } from "@/lib/portalScheduling";
import { libraryRows, reviewDeadlines } from "@/lib/portalLayout";
import { homeActions, planModel, libraryView, type HomeAction } from "@/lib/portalHome";
import { isLibraryFilter, OFFICE_LINE, TEXT_KYLE_START } from "@/lib/portalWords";
import Link from "next/link";
import { PortalShell } from "@/components/portal/PortalShell";
import { PORTAL_MIGRATION_NOTICE, PORTAL_FEEDBACK_QUERY } from "@/lib/portalNotice";
import { PlanTab, type PlanTabData } from "@/components/portal/tabs/PlanTab";
import { strategyGateFor } from "@/lib/strategyGate";
import type { PortalStrategyGate } from "@/lib/yourMonth";
import { MoreTab, TermsCard } from "@/components/portal/tabs/MoreTab";
import { InstallAppCard } from "@/components/portal/InstallAppCard";
import { clientFirstName } from "@/components/portal/cutReviewCopy";

// ---------------------------------------------------------------------------
// THE CLIENT PORTAL PAGE — one component, two routes. /portal/<token> (the
// link) and /portal/me (a signed-in person) both resolve a PortalViewer and
// hand it here; the page never looks at a cookie or a token itself.
//
// Navigation (UI-01, Sep 24 2026; Oct 21 2026): Home · Your Month · Content
// Library · Messages · More (Brand Profile, Filming sessions, Resources,
// Settings & Team, Terms), in PortalShell — a bottom bar on a phone, a rail
// on a wide screen. The Schedule page's list is on Home and Your Month now.
// Every page has a real page behind it. Each page loads ONLY its own data,
// and every load is wrapped so a failure renders as "couldn't load", never
// as an empty program.
//
// Strict rules hold: released content only, never money, never internal
// notes. Nothing in this HTML carries the enrollment token — tab links are
// query-only, <video src> and download hrefs carry a six-hour media token
// bound to that one cut/video and this viewer's seat/link, and the client
// components read the address bar when they call an action.
//
// ONE LAYOUT (Jordan, Oct 6 2026: "I want to just be fully transitioned to
// the new layout"). Until then this page had two: the old six tabs ("v1"),
// which every real client saw, and the navigation above ("v2"), which
// lib/portalLayout handed to TEST clients, rollout pilots and staff who
// added ?layout=v2. The old tabs, the `portal_layout_v2` switch and the
// staff preview link are gone; `?layout=v2` in an old address is ignored,
// and every old ?tab= key lands on its page (lib/portalNav.resolvePortalRoute).
// ---------------------------------------------------------------------------

/**
 * Everything the address bar may carry besides the tab. `pv` is Your Month's
 * subview, `q`/`st` the Library's search and status filter, `about=portal`
 * the portal notice's "Tell us" (Messages opens prefilled as portal feedback). (`year`, and
 * `layout` from an old staff-preview link, may still arrive; both are ignored.)
 */
export type PortalQuery = { tab?: string; v?: string; iv?: string; year?: string; page?: string; filter?: string; r?: string; pv?: string; q?: string; st?: string; layout?: string; month?: string; session?: string; about?: string };

// Client-facing program terms. The AppSetting `portal-terms` overrides this
// default wholesale (blank lines split paragraphs; "## " starts a heading) —
// so the owner can rewrite the language without a deploy.
//
// Oct 20 2026 (audit E17/E12): the default asked for "48 hours' notice" while
// the portal itself changes and cancels a session up to 24 hours out (inside
// 24 hours is a phone call: sessionBooking.within24hElapsed, Jordan's rule),
// and it typed out Kyle's number. It now says the rule the portal enforces and
// names the owner-editable office line.
//
// Oct 21 2026 (Jordan: "Billing questions can go to Kyle. It should say Text
// Kyle."): the billing line names Kyle and the office number (OFFICE_LINE),
// not Jordan with no number. Oct 27 2026 (Jordan: "I want them to be able to
// text kyle. Kyle can delegate to me if needed."): the number is a tappable
// sms: link (TermsCard's phones); the 24-hour rule is unchanged.
const defaultTerms = (contact: { name: string; display: string }) => `## The program
Your Content Program includes the monthly videos, filming sessions, scripting, editing and delivery described in your package. Each month we plan your videos with you, film them at your session, and deliver the finished videos here in your portal.

## Scheduling
Each month is planned either on a strategy call or here in the portal, where you pick your topics and answer a few short questions. Filming can be booked as soon as your answers are sent or your call is booked. Sessions start at least three business days after your answers are sent or your call ends, so your scripts are ready. Need to move or cancel a session? Do it right here in the portal, up to 24 hours before it starts. Inside 24 hours, call or text ${contact.name} at ${contact.display}.

## Revisions
Every video comes with revision rounds to get it right. Ask right here in the portal: pause the video, tell us what to change, and it goes straight to your editor.

## Your content
Finished videos are yours to post, share and run ads with. Raw footage stays with us. We may feature finished work in our own portfolio unless you ask us not to.

## Cancellation
Month-to-month plans can cancel with notice before the next billing date. Annual commitments run their term as agreed. Questions about billing? ${TEXT_KYLE_START}. This portal never handles payment details.`;

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
  // Where this address lands, and which block of data it loads.
  const route = resolvePortalRoute({ tab: query.tab, pv: query.pv });
  const dataTab = route.dataTab;
  const readOnly = access !== "FULL";
  const perms = {
    request: can(viewer, "requestChanges"),
    approve: can(viewer, "approveEdits"),
    comment: can(viewer, "comment"),
    suggest: can(viewer, "suggest"),
    profile: can(viewer, "editBrandProfile"),
    session: can(viewer, "requestSession"),
  };
  // The same first three open months exposed by portalTopics/ScheduleMonths.
  // A query never selects another enrollment's month or reopens history.
  const contextMonths = portalMonthKey(query.month) ? await prisma.contentMonth.findMany({
    where: { enrollmentId: enrollment.id, historical: false, monthKey: { gte: etMonthKey(), lte: portalLastMonthKey() } },
    orderBy: { monthKey: "asc" }, take: 3, select: { id: true, monthKey: true },
  }) : [];
  // Oct 12 2026: the scheduler may name an over month whose session is booked
  // late beside one of these (lateSession.ts). The scheduler opens on it; the
  // page's PLANNING month is its host, so Your Month stays about this month.
  let lateContext: { id: string; monthKey: string; hostId: string } | null = null;
  if (portalMonthKey(query.month) && contextMonths.length && !selectedPortalMonth(contextMonths, query.month)) {
    const bagRow = await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { overridesJson: true } }).catch(() => null);
    const rec = (await import("@/lib/lateSession")).lateSessionOf(bagRow?.overridesJson, portalMonthKey(query.month));
    if (rec && contextMonths.some((m) => m.id === rec.hostMonthId)) lateContext = { id: rec.lateMonthId, monthKey: rec.lateMonthKey, hostId: rec.hostMonthId };
  }
  const pickedMonth = selectedPortalMonth([...contextMonths, ...(lateContext ? [lateContext] : [])], query.month);
  const selectedMonth = lateContext && pickedMonth?.id === lateContext.id ? contextMonths.find((m) => m.id === lateContext!.hostId) ?? null : pickedMonth;
  /** The month the scheduler opens on: a late month's own id, else the selected month's. */
  const scheduleMonthId = pickedMonth?.id ?? null;
  // The MONTH's sessions (Oct 7 2026): a catch-up month offers its extra session too.
  const selectedSession = pickedMonth
    ? portalSessionIndex(query.session, await import("@/lib/programMonths").then((m) => m.sessionsRequiredForMonth(pickedMonth.id)).catch(() => enrollment.sessionsPerMonth))
    : null;
  const monthKey = selectedMonth?.monthKey ?? etMonthKey();
  const scope = mediaScopeOf(viewer);
  // Greet the PERSON when we know one. A collaborator or viewer signed into
  // Cara's program was opened with "Hi Cara" — the account's name, not theirs
  // (review, Sep 17). The link seat has no person, so it keeps the account's.
  const first = ((actor.kind === "CLIENT" ? actor.name : null) || client?.name || "there").split(/\s+/)[0];
  // The query every link keeps: `e=` on /portal/me, the selected month and
  // session. `tabHref` answers the old tab-key signature with current
  // addresses (portalNav.v2HrefFor) for the components written against it.
  const contextBase = [baseQuery, pickedMonth ? `month=${pickedMonth.monthKey}` : "", selectedSession ? `session=${selectedSession}` : ""].filter(Boolean).join("&");
  const tabHref = v2HrefFor(contextBase);
  // W03: "Book the call" goes to the booking inside Your Month —
  // lib/callBooking.portalBookingLinks. Loaded once, only by the page that
  // shows it (Your Month; Home never read it, audit E6); with no mapping the
  // link is the office conversation.
  const noCallLinks: { bookingUrl: string | null; view: PortalCallBookingView | null } = { bookingUrl: null, view: null };
  const callLinksP = route.dest === "plan"
    ? portalBookingLinks(viewer, { planHref: portalHref(contextBase, "plan"), monthId: selectedMonth?.id })
      .catch((e) => { console.error("[portal] call booking links failed", e); return noCallLinks; })
    : Promise.resolve(noCallLinks);
  const loadCallLinks = () => callLinksP;
  const callBookingUrl = async () => (await callLinksP).bookingUrl ?? tabHref("messages");
  const who = actor.kind === "CLIENT" ? (actor.name || actor.email) : actor.kind === "STAFF" ? (actor.staffName || "Staff") : null;
  // "Set up your sign-in" — a link visit on a program that already has a person
  // with a seat (transition Stage B). Offered ONLY while the magic-link email
  // can actually go out: with `portal_login_email` off, this banner sends the
  // client to a form that takes their address and sends nothing, on every tab
  // of every portal including paused and ended ones (review blocker, Sep 17).
  // And only for a client the rollout reaches (R04, Sep 28 2026): for a client
  // outside it requestLoginLink sends nothing either, so the global switch
  // alone would invite them to a form that never answers.
  const { portalLoginEmailEnabledFor } = await import("@/lib/portalAccess");
  const emailSignInLive = await portalLoginEmailEnabledFor(enrollment.clientId).catch(() => false);
  // Oct 20 2026 (audit E2): the same test decides every "Sign in" on the page.
  // The video page and Home's next step used to offer the sign-in form on the
  // switch alone, so a link-only client (no seat at all) was sent to a form
  // that never answers; with no seat they are told how to get one instead.
  const linkHasSeat = actor.kind === "TOKEN" ? await enrollmentHasMembership(enrollment.id).catch(() => false) : false;
  const offerSignIn = emailSignInLive && linkHasSeat;
  // Oct 21 2026 (lib/strategyGate): until the client's content strategy is in
  // the portal, Home and Your Month show the brand discovery call and what
  // comes next, and nothing asks them to book a strategy call or filming.
  // A read that fails reads as open: the server actions check again.
  const strategyGate: PortalStrategyGate | null = route.dest === "home" || route.dest === "plan"
    ? await strategyGateFor(enrollment.id).then(async (g): Promise<PortalStrategyGate | null> => {
      if (!g || g.open) return null;
      const discoveryUrl = g.discovery === "needed"
        ? (await prisma.programCalendlyEventMapping.findFirst({ where: { purpose: "BRAND_DISCOVERY", enabled: true, publicUrl: { not: null } }, select: { publicUrl: true } }).catch(() => null))?.publicUrl ?? null
        : null;
      return { open: false, reason: g.reason, discovery: g.discovery, discoveryAtISO: g.discoveryAt?.toISOString() ?? null, meetLink: g.discoveryMeetLink, discoveryUrl };
    }).catch(() => null)
    : null;

  // ---- per-tab data --------------------------------------------------------
  let home: HomeData | null = null;
  let detail: VideoDetailData | null = null;
  let videoStatusFailed = false;
  let topicsRes: { ok: true; data: PortalTopicsData } | { ok: false } | null = null;
  let interviewRes: { ok: true; data: PortalInterviewView | null } | { ok: false } | null = null;
  let strategyRes: { ok: true; data: PortalStrategyView | null } | { ok: false } | null = null;
  let priorities: string[] = [];
  let resourcesRes: { ok: true; data: ResourceGroupView[] } | { ok: false } | null = null;

  if (dataTab === "home" || dataTab === "videos") {
    // The library's logical videos are built from the cuts and delivery rows
    // (idempotent, additive) before they are read.
    await attempt("video sync", () => syncEnrollmentVideos(enrollment));
  }
  if (dataTab === "home") {
    // Oct 21 2026: Home's next step stays about THIS month, even when the
    // address still carries next month from Your Month's switch.
    const homeMonth = selectedMonth && selectedMonth.monthKey <= etMonthKey() ? selectedMonth : null;
    const homeKey = homeMonth?.monthKey ?? etMonthKey();
    const [planning, schedule, videos, topics, month, progress, attention] = await Promise.all([
      attempt("planning", () => portalPlanning(enrollment, homeMonth?.id)),
      attempt("schedule", () => portalScheduleMonths(enrollment)),
      attempt("videos", () => portalVideoList(enrollment, { page: 1, perPage: 24 })),
      attempt("topics", () => portalTopics(enrollment, { staff: actor.kind === "STAFF" })),
      // Audit E4: a hiccup here used to fail the whole page.
      attempt("month", () => prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, monthKey: homeKey }, select: { videosOwed: true } })),
      // The month through lib/monthProgress (CP-10): sessions and the meter
      // read the same facts Jordan's roster and the client file do.
      attempt("progress", () => portalMonthProgress(enrollment, homeKey)),
      // Library-wide, not page one: "N waiting on you" is a library fact.
      attempt("attention", () => libraryAttention(enrollment)),
    ]);
    home = {
      first, monthKey: homeKey, videosOwed: (month.ok ? month.data?.videosOwed : null) ?? enrollment.videosPerMonth,
      program: progress.ok ? { delivered: progress.data.production.delivered, total: progress.data.production.total } : null, countsFailed: !progress.ok,
      progress: progress.ok ? progress.data : null,
      planning: planning.ok ? planning.data : null,
      schedule: schedule.ok ? schedule.data.find((m) => m.monthKey === homeKey) ?? schedule.data[0] ?? null : null,
      // Oct 21 2026: Home's "Coming up" lists every open month (the Schedule page's list).
      scheduleMonths: schedule.ok ? schedule.data : null,
      videos: videos.ok ? { rows: videos.data.rows, total: videos.data.total } : null,
      attention: attention.ok ? attention.data : null,
      topics: topics.ok ? topics.data : null, topicsFailed: !topics.ok,
      // Audit E4: a read behind the next step failed, so "all caught up" would be a guess.
      checksFailed: !planning.ok || !schedule.ok || !videos.ok || !topics.ok || !progress.ok || !attention.ok,
      perms: { session: perms.session, suggest: perms.suggest, request: perms.request, approve: perms.approve }, readOnly,
      readOnlyState: readOnly ? (enrollment.status === "PAUSED" ? "PAUSED" : "ENDED") : null,
      strategyGate,
    };
    // Oct 8 2026: a client who plans their own content — is this month's brief in?
    if (home.planning?.clientPlanned) {
      const b = await import("@/lib/monthBrief").then((m) => m.monthBrief(home!.planning!.monthId)).catch(() => null);
      home.brief = b ? { files: b.files.length, notes: !!b.notes?.text.trim(), href: `${portalHref(contextBase, "plan")}#step-brief` } : null;
    }
    // CP-06: the account-setup checklist — derived from what is on file, only
    // for someone who can act on it, and never on a paused/ended program.
    if (!readOnly && perms.profile) {
      // Audit E6: Home ranks the step from its counts; the live Dropbox folder
      // listing (which only rewords the logo/headshot items) is the Brand
      // Profile page's, not every Home load's.
      const setup = await attempt("setup", async () => (await import("@/lib/portalSetup")).setupChecklist(viewer, { folder: false }));
      if (setup.ok) home.setup = { ...setup.data, items: setup.data.items.map((i) => ({ ...i, href: `${tabHref(i.tab)}#${i.anchor}` })) };
    }
  }
  if (dataTab === "videos") {
    const vId = query.v && ID_RE.test(query.v) ? query.v : null;
    if (vId) {
      const video = await videoForEnrollment(enrollment, vId).catch(() => null);
      if (video) {
        const [hist, kit, deliveredSrc, state] = await Promise.all([
          attempt("cut history", () => (video.currentSubmissionId ? cutHistory(viewer, video.currentSubmissionId) : Promise.resolve([] as CutVersion[]))),
          attempt("posting kit", () => postingKitFor(viewer, video)),
          // Oct 21 2026: the poster is the shown version's (contentVideos.posterFor),
          // never an older delivered file's frame over a newer cut.
          deliveredMediaFor(video.id, video.currentSubmissionId).catch(() => null),
          attempt("video status", () => videoState(enrollment.id, video)),
        ]);
        // 9.6b: a version still in its 1080p pass (or held for a listen) has
        // nothing to play for the client — never the editor's export in its
        // place. Its player is withheld and the page says it is being finished;
        // the stream route refuses it too.
        const finishing = hist.ok
          ? await import("@/lib/cutEntitlement")
            .then((m) => m.clientCutFiles(hist.data.filter((x) => x.assetUrl).map((x) => x.submissionId)))
            .then((files) => new Set([...files].filter(([, f]) => f.kind === "finishing").map(([id]) => id)))
            .catch(() => new Set<string>())
          : new Set<string>();
        const versions = hist.ok ? hist.data.map((v) => ({ ...v, assetUrl: v.assetUrl && !finishing.has(v.submissionId) ? withMediaToken(v.assetUrl, scope) : null })) : [];
        // CP-02: the review deadline and rounds used ride on the CURRENT version
        // into CutReview — from the window the server enforces; null (nothing
        // shown) while revision_policy is off.
        const reviewing = versions.find((x) => x.isCurrent);
        if (reviewing) reviewing.review = await import("@/lib/reviewWindows").then((m) => m.reviewPanelFor(viewer, reviewing.submissionId)).catch(() => null);
        const pillar = video.pillarId ? await prisma.contentPillar.findUnique({ where: { id: video.pillarId }, select: { name: true } }).catch(() => null) : null;
        const kitData: PostingKit | null = kit.ok ? kit.data : null;
        // A failed canonical status read is unavailable, not permission to
        // reconstruct a release from an older cached status or cut history.
        if (state.ok) detail = {
          video: {
            id: video.id, title: video.title ?? "Video", monthKey: video.monthKey, kind: video.kind, state: state.data, filmedAtISO: video.filmedAt?.toISOString() ?? null, deliveredAtISO: video.deliveredAt?.toISOString() ?? null, pillarName: pillar?.name ?? null, format: video.format,
            // CP-12: older backfill is "Previous content", never labelled with a month we can't vouch for.
            section: await import("@/lib/contentVideos").then((m) => m.videoLibrarySection(video)).catch(() => "RECENT" as const),
            updated: isUpdatedVersion(video, state.data),
          },
          staff: actor.kind === "STAFF",
          // Oct 22 2026: "Approve for Mike". Only a STAFF visit is ever handed the name.
          clientFirst: actor.kind === "STAFF" ? clientFirstName(client?.name) : null,
          versions, versionsFailed: !hist.ok,
          finishing: versions.some((x) => x.isCurrent && finishing.has(x.submissionId)),
          kit: kitData, kitFailed: !kit.ok,
          // A delivered (Aryeo/Mux) file plays directly — it is a CDN URL, not a hub cut, so no token applies.
          delivered: deliveredSrc?.playback && !/^\/api\/review\/cut\//.test(deliveredSrc.playback) ? { playback: deliveredSrc.playback, thumb: deliveredSrc.thumb } : null,
          poster: deliveredSrc?.thumb ?? null,
          // The download door: a media token over the VIDEO id, scoped to this viewer.
          downloadHref: kitData?.access.download ? `/api/portal/download/${video.id}?m=${encodeURIComponent(mediaToken(video.id, scope))}` : null,
          perms: { comment: perms.comment, request: perms.request, approve: perms.approve, suggest: perms.suggest }, readOnly,
          // Only the emailed-link seat can never approve; point it at the door
          // that leads to one that can — when that door actually opens.
          signInHref: offerSignIn ? "/portal/login" : null,
          linkHasSeat,
          // A1 (Oct 13 2026): the link watches; deciding (approve or request
          // changes) is for a signed-in seat, and the page says so plainly.
          linkVisitor: actor.kind === "TOKEN",
        };
        else videoStatusFailed = true;
      }
    }
  }
  if (dataTab === "topics") {
    const ivId = query.iv && ID_RE.test(query.iv) ? query.iv : null;
    if (ivId) interviewRes = await attempt("interview", () => portalInterview(enrollment, ivId));
    if (!ivId || (interviewRes?.ok && !interviewRes.data)) topicsRes = await attempt("topics", () => portalTopics(enrollment, { staff: actor.kind === "STAFF" }));
  }
  if (dataTab === "strategy") {
    const [s, m] = await Promise.all([
      attempt("strategy", () => portalStrategy(enrollment)),
      prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, monthKey }, select: { prioritiesJson: true } }).catch(() => null),
    ]);
    strategyRes = s;
    if (m?.prioritiesJson) { const { monthPriorities } = await import("@/lib/contentStrategy"); priorities = monthPriorities(m.prioritiesJson); }
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
  // Oct 22 2026: replies about a script live under the script, not in Messages.
  // Their unread count rides on Your Month (for a seat that can answer them);
  // opening the Scripts view, where they are, marks them read.
  const onScripts = route.dest === "plan" && route.planView === "scripts";
  const scriptRepliesUnread = onScripts ? 0 : await pm.unreadScriptReplies(enrollment.id, readerKey).catch(() => 0);
  if (onScripts) await pm.markThreadRead(enrollment.id, pm.scriptsReaderKey(readerKey)).catch(() => {});
  let messagesRes: { ok: true; data: MessagesTabData } | { ok: false } | null = null;
  if (dataTab === "messages") {
    messagesRes = await attempt("messages", async () => {
      const t = await pm.threadFor(enrollment.id, readerKey, { audience: "client" });
      await pm.markThreadRead(enrollment.id, readerKey).catch(() => {});
      const { refusalMessage, actorLabel } = await import("@/lib/portalAccess");
      return {
        messages: t.messages, unreadBefore: t.unread,
        ownerFirst: t.owner.label && t.owner.label !== "unassigned" ? t.owner.label.split(/\s+/)[0] : contact.name,
        canMessage, refusal: canMessage ? null : refusalMessage(viewer, "message"), contact, hint: pm.VIDEO_CHANGES_HINT,
        // The same words a message from this viewer is stamped with (programMessages), so its own read "You".
        youLabel: actor.kind === "STAFF" ? null : actorLabel(viewer).slice(0, 120),
        // Oct 6 2026: from the portal notice's "Tell us" — the box starts "Portal feedback: ".
        ...(query.about === "portal" && PORTAL_MIGRATION_NOTICE.on ? { prefill: PORTAL_MIGRATION_NOTICE.prefill } : {}),
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
    const view = await attempt("brand profile", async () => (await import("@/lib/brandProfile")).portalBrandProfileView(enrollment.clientId, { scope }));
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
      // The shared link is offered the sign-in form only when it can answer (audit E2).
      signInEmailOn: actor.kind === "TOKEN" ? offerSignIn : emailSignInLive,
      linkHasSeat: actor.kind === "TOKEN" ? linkHasSeat : undefined,
      profileHref: tabHref("profile"),
      // The page named as the nav names it; the office line from the
      // owner-editable contact.
      profileLabel: "Brand Profile", contactLine: `call or text ${contact.name} at ${contact.display}`,
    };
  }
  const termsSetting = dataTab === "terms" ? await prisma.appSetting.findUnique({ where: { key: "portal-terms" } }).catch(() => null) : null;
  const terms = (termsSetting?.value?.trim() || defaultTerms(contact)).split(/\n\s*\n/);

  // ---- what the navigation counts, from the readers the pages use ----
  // Loaded on every page so a badge never appears on one tab and vanishes on
  // the next; each is wrapped, and an unreadable count is no badge, not zero.
  //
  // Oct 20 2026 (audit E18/E5): a badge counts what THIS viewer can act on. A
  // view-only seat, or a paused or ended program, can't decide on a script or
  // a video, so its badges never cleared; it gets none, and the whole topic
  // bank behind the plan badge is not read for it off the plan page.
  const badgePlan = perms.suggest;
  const badgeLibrary = perms.request || perms.approve;
  const needTopics = route.dest === "plan" || badgePlan;
  const [attn, topicsAll, guides, setupMore] = await Promise.all([
    !badgeLibrary ? Promise.resolve(null) : home?.attention ? Promise.resolve({ ok: true as const, data: home.attention }) : attempt("attention", () => libraryAttention(enrollment)),
    topicsRes?.ok ? Promise.resolve(topicsRes) : home?.topics ? Promise.resolve({ ok: true as const, data: home.topics }) : needTopics ? attempt("topics", () => portalTopics(enrollment, { staff: actor.kind === "STAFF" })) : Promise.resolve(null),
    resourcesRes ?? attempt("resources", () => publishedResources()),
    dataTab === "more" && !readOnly && perms.profile
      ? attempt("setup", async () => (await import("@/lib/portalSetup")).setupChecklist(viewer, { folder: false }))
      : Promise.resolve(null),
  ]);
  const plan = topicsAll?.ok ? planModel(topicsAll.data, monthKey) : null;
  const published = guides.ok ? guides.data.reduce((n, g) => n + g.resources.length, 0) : 0;
  const nav = portalNav({ publishedResources: published, badges: { plan: badgePlan ? (plan?.scripts.length ?? 0) + scriptRepliesUnread : 0, library: attn?.ok ? attn.data.needReview : 0, messages: messagesUnread } });
  const navHref = (i: { dest: Parameters<typeof portalHref>[1]; anchor?: string | null }) => `${portalHref(contextBase, i.dest)}${i.anchor ? `#${i.anchor}` : ""}`;
  const linked = { primary: nav.primary.map((i) => ({ ...i, href: navHref(i) })), more: nav.more.map((i) => ({ ...i, href: navHref(i) })) };

  // ---- Home: the one next step ----
  let actions: { primary: HomeAction | null; more: HomeAction[] } = { primary: null, more: [] };
  // Oct 15 2026: a bulk plan's sessions (null for every monthly client), read once for Home and Your Month.
  const bulkView = route.dest === "home" || route.dest === "plan"
    ? await import("@/lib/portalBulk").then((m) => m.portalBulkView(enrollment.id)).catch(() => null)
    : null;
  // Every script in one PDF (Oct 19 2026): the viewer's own media token over the enrollment.
  if (bulkView) bulkView.pdfHref = `/api/portal/scripts/all/${enrollment.id}?m=${encodeURIComponent(mediaToken(enrollment.id, scope))}`;
  const bulkFocus = bulkView?.sessions.find((x) => x.no === bulkView.focusSessionNo) ?? null;
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
    const hp = home.topics ? planModel(home.topics, home.monthKey) : plan;
    // Oct 21 2026: next month, open early, while something is still to plan or book there.
    const nowKey = etMonthKey();
    const nextTopics = home.topics?.months.find((m) => m.monthKey > nowKey) ?? null;
    const nextSched = home.scheduleMonths?.find((m) => m.monthKey > nowKey && !m.late) ?? null;
    const aheadKey = nextTopics?.monthKey ?? nextSched?.monthKey ?? null;
    const selfPlanned = !!home.planning?.clientPlanned;
    const aheadOpen = !!aheadKey && ((!selfPlanned && !!nextTopics && nextTopics.selected < nextTopics.owed) || (!!nextSched && nextSched.sessionsMissing > 0 && nextSched.capacity.remaining > 0));
    const filmedWork = !!home.progress && (home.progress.sessions.cards.some((s) => s.state === "FILMED") || home.progress.production.delivered > 0 || home.progress.production.approved > 0 || home.progress.production.awaitingYou > 0);
    const visibleSelected = home.topics && hp?.month
      ? home.topics.groups.flatMap((g) => g.topics).filter((t) => !t.declined && t.selection?.monthId === hp.month?.id).length
      : 0;
    const topicHistoryNeedsReview = filmedWork && !!hp?.month && (
      hp.month.selected === 0 || visibleSelected < hp.month.selected
    );
    actions = homeActions({
      status: enrollment.status, readOnly, perms,
      review: { count: reviewCount, single: reviewCount === 1 && waiting.length === 1 ? { id: waiting[0].id, title: waiting[0].title } : null, soonestDeadlineLabel: soonest?.label ?? null },
      scripts: (hp?.scripts ?? []).map((t) => ({ topicId: t.id, title: t.title })),
      unread: messagesUnread,
      planning: home.planning ? { planningMode: home.planning.planningMode, callStatus: home.planning.callStatus, noCallEligible: home.planning.noCallEligible } : null,
      clientPlanned: home.planning?.clientPlanned ? { briefIn: !!home.brief && (home.brief.files > 0 || home.brief.notes), monthLabel: monthLabel(home.planning.monthKey) } : null,
      bulk: bulkView ? {
        focusSessionNo: bulkFocus?.no ?? null,
        scripts: bulkFocus?.items.filter((x) => x.state === "to_film" || x.state === "marked_done").length ?? 0,
        dateLabel: bulkFocus?.dateISO ? new Date(bulkFocus.dateISO).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" }) : null,
      } : null,
      month: hp?.month ? { monthKey: hp.month.monthKey, label: monthLabel(hp.month.monthKey), owed: hp.month.owed, selected: hp.month.selected } : null,
      filmingStarted: filmedWork, topicHistoryNeedsReview,
      toAnswer: (hp?.toAnswer ?? []).map((t) => ({ title: t.title, missing: t.plan?.missing ?? 0 })),
      session: {
        offerBooking: sv.offerBooking, required: sv.required, missing: sv.missing,
        // A21/A20: the next session's "Schedule later" and its gate's earliest start.
        deferred: !!home.schedule?.deferredAtISO,
        earliestLabel: home.schedule?.earliestISO ? new Date(home.schedule.earliestISO).toLocaleDateString("en-US", { timeZone: home.planning?.timezone ?? "America/New_York", weekday: "long", month: "long", day: "numeric" }) : null,
      },
      addressNeeded: home.schedule?.sessions.filter((x) => x.addressNeeded).length ?? 0,
      // Oct 12 2026: an over month's session to book now too, once its scripts are ready.
      lateSession: home.planning?.late ? { label: home.planning.late.label, open: home.planning.late.state === "TO_BOOK" && home.planning.late.scriptsReady, combined: home.planning.late.combine.combined } : null,
      setup: home.setup ? { complete: home.setup.complete, remaining: Math.max(0, home.setup.total - home.setup.done) } : null,
      ready: { count: readyCount, withFile: home.attention ? home.attention.readyWithFile > 0 : readyPage.length > 0, single: readyCount === 1 && readyPage.length === 1 ? { id: readyPage[0].id, title: readyPage[0].title } : null },
      // A1 (Oct 13 2026): the shared link watches; a signed-in seat decides.
      linkVisitor: actor.kind === "TOKEN" ? { signInHref: offerSignIn ? "/portal/login" : null, hasSeat: linkHasSeat } : null,
      ahead: aheadOpen && aheadKey ? { label: monthLabel(aheadKey).split(" ")[0], href: portalMonthHref(portalHref(contextBase, "plan"), aheadKey), clientPlanned: selfPlanned } : null,
      strategyPending: !!strategyGate,
    }, contextBase);
  }

  // ---- Content Library: search + filters over the whole library ----
  let library: LibraryV2Data | null = null;
  let libraryFailed = videoStatusFailed;
  if (route.dest === "library" && !detail && !videoStatusFailed) {
    const all = await attempt("library", () => libraryRows(enrollment));
    if (all.ok) {
      const view = libraryView(all.data.rows, { q: query.q, st: isLibraryFilter(query.st) ? query.st : "all", page: query.page && /^\d{1,4}$/.test(query.page) ? Number(query.page) : 1 });
      const deadlines = await reviewDeadlines(viewer, view.review).catch(() => new Map<string, { iso: string; label: string }>());
      library = { view, deadlines: Object.fromEntries([...deadlines].map(([id, d]) => [id, d.label])), hidden: baseQueryPairs(contextBase), incomplete: !all.data.complete };
    } else libraryFailed = true;
  }

  const planHrefs: Record<PlanView, string> = {
    month: portalHref(contextBase, "plan"), scripts: portalHref(contextBase, "plan", "pv=scripts"), bank: portalHref(contextBase, "plan", "pv=bank"), strategy: portalHref(contextBase, "plan", "pv=strategy"),
  };

  // ---- Your Month: the guided plan needs the month's planning, its
  // scheduling card and (to book) the live slots — the same loads the
  // Schedule page made, each wrapped so a failure reads "couldn't load".
  let yourMonth: PlanTabData["yourMonth"] = null;
  if (route.dest === "plan" && route.planView === "month" && !interviewRes) {
    const [p, sm] = await Promise.all([
      attempt("planning", () => portalPlanning(enrollment, selectedMonth?.id)),
      attempt("schedule months", () => portalScheduleMonths(enrollment)),
    ]);
    // Oct 12 2026: an over month's session booked this month too — its card and its released scripts.
    const lateP = p.ok ? p.data?.late ?? null : null;
    // Oct 13 2026: when one session films both months, it IS this month's filming (this month has no tab of its own).
    const thisMonth = p.ok && p.data && sm.ok
      ? sm.data.find((m) => m.monthId === p.data!.monthId) ?? (lateP?.combine.combined ? sm.data.find((m) => m.monthId === lateP.monthId) ?? null : null)
      : null;
    const lateScripts = lateP ? await import("@/lib/monthLateSession").then((m) => m.portalLateScripts(enrollment, lateP.monthId)).catch(() => []) : [];
    let days: PortalSlotDay[] = [];
    if (thisMonth && perms.session && !readOnly && !thisMonth.locked && (thisMonth.capacity.remaining > 0 || thisMonth.requests.some((r) => r.canChange))) {
      const pkg = (await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { package: true } }).catch(() => null))?.package ?? null;
      days = await companySlotDays({ package: pkg }).catch(() => []);
    }
    // Oct 8 2026: the client plans their own content — their brief, with links scoped to this visit.
    const brief = p.ok && p.data?.clientPlanned
      ? await import("@/lib/monthBrief").then(async (m) => m.briefView(await m.monthBrief(p.data!.monthId), scope)).catch(() => null)
      : null;
    yourMonth = {
      brief,
      planning: p.ok ? p.data : null, planningFailed: !p.ok,
      schedule: thisMonth, scheduleFailed: !sm.ok,
      slotDays: days, bookingUrl: await callBookingUrl(), callBooking: strategyGate ? null : (await loadCallLinks()).view,
      strategyGate,
      can: { suggest: perms.suggest, session: perms.session, staff: actor.kind === "STAFF", approve: perms.approve },
      // Oct 21 2026: the other open months, for "Also coming up" below the steps.
      months: sm.ok ? sm.data : null,
      selectedSessionIndex: selectedSession,
      late: lateP ? { schedule: sm.ok ? sm.data.find((m) => m.monthId === lateP.monthId) ?? null : null, scripts: lateScripts } : null,
      selectedScheduleMonthId: scheduleMonthId,
    };
  }
  // Oct 6 2026: the portal notice's "Tell us" and the footer's "Report a
  // problem" — the existing conversation, opened prefilled as portal feedback.
  const feedbackHref = `${portalHref(contextBase, "messages", PORTAL_FEEDBACK_QUERY)}#program-message`;
  const setupLeft = setupMore?.ok && !setupMore.data.complete ? Math.max(0, setupMore.data.total - setupMore.data.done) : null;
  return (
    <PortalShell
      clientName={client?.name ?? null}
      dest={route.dest}
      nav={linked}
      notices={{
        readOnly: readOnly ? readOnlyNotice(enrollment.status) : null,
        staff: actor.kind === "STAFF" ? { who: who ?? "Staff", clientName: client?.name ?? "" } : null,
        offerSignIn,
        // Oct 27 2026: the shared link of a program someone can sign in to only looks; it says so, with Sign in.
        linkViewOnly: actor.kind === "TOKEN" && !!actor.viewOnly && !readOnly,
        viewOnlySeat: actor.kind === "CLIENT" && actor.membershipRole === "VIEWER" && !readOnly,
        // Oct 6 2026: "we're still moving things over" — every viewer, every page, until retired in lib/portalNotice.ts.
        migrating: PORTAL_MIGRATION_NOTICE.on ? { tellUsHref: feedbackHref } : null,
      }}
      // CP-13: the conversation when this viewer may use it, the office line always.
      footer={route.dest !== "messages" ? (
        <>
          <ContactTeam contact={contact} messagesHref={canMessage ? tabHref("messages") : null} className="mt-8" />
          {/* Oct 6 2026: still reachable after the notice's "Got it". */}
          {PORTAL_MIGRATION_NOTICE.on && <p className="mt-3 text-center text-xs"><Link href={feedbackHref} data-report-problem className="inline-flex min-h-11 items-center font-medium text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{PORTAL_MIGRATION_NOTICE.report}</Link></p>}
        </>
      ) : null}
    >
      {query.month && !selectedMonth && route.dest === "plan" && <p role="status" className="mt-4 rounded-xl border border-border bg-surface-2 p-3 text-sm text-muted">That planning month is not available here. Your open months are shown below.</p>}
      {route.dest === "home" && home && <HomeV2 d={home} actions={actions} href={tabHref} />}
      {/* Oct 22 2026: "Add to your home screen", for the client's own visit only (never staff on their behalf). */}
      {route.dest === "home" && home && actor.kind !== "STAFF" && <InstallAppCard signedIn={actor.kind === "CLIENT"} />}
      {route.dest === "plan" && route.planView && (
        <PlanTab d={{
          view: route.planView,
          topics: topicsAll?.ok ? topicsAll.data : null, topicsFailed: !!topicsAll && !topicsAll.ok,
          interview: interviewRes?.ok ? interviewRes.data : null, interviewFailed: !!interviewRes && !interviewRes.ok,
          strategy: strategyRes?.ok ? strategyRes.data : null, strategyFailed: !!strategyRes && !strategyRes.ok, priorities,
          monthKey, canAct: perms.suggest, readOnly, filter: query.filter, hrefs: planHrefs, yourMonth, strategyGate,
          bulk: bulkView,
          canApprove: perms.approve,
          // Oct 20 2026: each month whose scripts are all approved, as one PDF (the link is minted on the tap).
          scriptPdfs: route.planView === "scripts" && !bulkView
            ? (await import("@/lib/scriptPdfLinks").then((m) => m.monthsReadyForPdf(enrollment.id)).catch(() => [])).map((m) => ({ ...m, label: monthLabel(m.monthKey) }))
            : [],
          // Oct 22 2026: a version that answered their change request comes back marked, with the message sent with it.
          scriptUpdates: route.planView === "scripts" && !bulkView && topicsAll?.ok
            ? await import("@/lib/scriptRequests").then((m) => m.portalScriptUpdates(enrollment.id, topicsAll.data.groups.flatMap((g) => g.topics).map((t) => t.script?.id).filter((x): x is string => !!x))).catch(() => ({}))
            : {},
          clientPlanned: yourMonth?.planning?.clientPlanned ?? (await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { clientSuppliesTopics: true } }).catch(() => null))?.clientSuppliesTopics ?? false,
        }} />
      )}
      {route.dest === "library" && (detail ? <VideoDetailV2 d={detail} href={tabHref} /> : <LibraryV2 d={library} failed={libraryFailed} href={tabHref} />)}
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
      {route.dest === "resources" && <ResourcesTab groups={resourcesRes?.ok ? resourcesRes.data : null} failed={!!resourcesRes && !resourcesRes.ok} open={query.r} contact={contact} messagesHref={canMessage ? tabHref("messages") : null} />}
      {route.dest === "team" && settings && <SettingsTab d={settings} />}
      {route.dest === "terms" && <TermsCard blocks={terms} phones={[contact, OFFICE_LINE]} />}
    </PortalShell>
  );
}
