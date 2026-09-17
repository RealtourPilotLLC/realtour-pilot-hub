import Link from "next/link";
import { BrandWordmark } from "@/components/Brand";
import {
  BookOpen, CalendarClock, Clapperboard, Compass, Eye, Home, KeyRound, Lightbulb, LogOut, MoreHorizontal, PauseCircle, ScrollText, Sparkles, UserRound,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/contentProgram";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import {
  recordPortalVisit, enrollmentHasMembership, portalScheduleMonths, companySlotDays, portalPlanning, portalTopics, portalInterview, portalStrategy,
  type PortalViewer, type PortalScheduleMonth, type PortalSlotDay, type PortalTopicsData, type PortalInterviewView, type PortalStrategyView, type PortalPlanning,
} from "@/lib/portal";
import { can } from "@/lib/portalAccess";
import { withMediaToken, mediaScopeOf, mediaToken } from "@/lib/portalMedia";
import { syncEnrollmentVideos, portalVideoList, videoForEnrollment, programCountsByMonth, libraryAttention, videoState, type VideoListPage } from "@/lib/contentVideos";
import { cutHistory, type CutVersion } from "@/lib/clientDecisions";
import { postingKitFor, type PostingKit } from "@/lib/postingKit";
import { publishedResources, type ResourceGroupView } from "@/lib/portalResources";
import { listClientAssets } from "@/lib/clientAssets";
import { PortalProfile } from "@/components/portal/PortalProfile";
import { signOutPortal } from "@/app/portal/login/actions";
import { HomeTab, type HomeData } from "@/components/portal/tabs/HomeTab";
import { VideosList, VideoDetail, type VideoDetailData } from "@/components/portal/tabs/VideosTab";
import { TopicsTab } from "@/components/portal/tabs/TopicsTab";
import { StrategyTab } from "@/components/portal/tabs/StrategyTab";
import { ScheduleTab } from "@/components/portal/tabs/ScheduleTab";
import { ResourcesTab } from "@/components/portal/tabs/ResourcesTab";
import { cn } from "@/lib/utils";

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
// ---------------------------------------------------------------------------

export type PortalTab = "home" | "videos" | "topics" | "strategy" | "schedule" | "resources" | "profile" | "terms";
const MAIN_TABS: { key: PortalTab; label: string; short: string; icon: typeof Home }[] = [
  { key: "home", label: "Home", short: "Home", icon: Home },
  { key: "videos", label: "My Videos", short: "Videos", icon: Clapperboard },
  { key: "topics", label: "Video Topics", short: "Topics", icon: Lightbulb },
  { key: "strategy", label: "My Strategy", short: "Strategy", icon: Compass },
  { key: "schedule", label: "Schedule", short: "Schedule", icon: CalendarClock },
  { key: "resources", label: "Resources", short: "Resources", icon: BookOpen },
];
const PHONE_BAR: PortalTab[] = ["home", "videos", "topics", "strategy"];
// Old links (`?tab=library`, `?tab=ideas`) keep landing somewhere sensible.
const LEGACY_TABS: Record<string, PortalTab> = { library: "videos", ideas: "topics", home: "home", videos: "videos", topics: "topics", strategy: "strategy", schedule: "schedule", resources: "resources", profile: "profile", terms: "terms" };
export const portalTabOf = (raw: string | undefined): PortalTab => LEGACY_TABS[raw ?? ""] ?? "home";

/** Everything the address bar may carry besides the tab. */
export type PortalQuery = { tab?: string; v?: string; iv?: string; year?: string; page?: string; filter?: string; r?: string };

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

export async function PortalPage({ viewer, tab, path, baseQuery = "", query = {} }: {
  viewer: PortalViewer;
  tab: PortalTab;
  /** What PortalVisit records — the pathname, never the query. */
  path: string;
  /** Query that must survive tab changes (`e=<enrollmentId>` on /portal/me). */
  baseQuery?: string;
  query?: PortalQuery;
}) {
  const { enrollment, actor, access } = viewer;
  await recordPortalVisit(viewer, path);

  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true, brandColors: true, portalVideoStyle: true, portalPreferences: true } });
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
  const first = (client?.name ?? "there").split(/\s+/)[0];
  const href = (t: string, extra?: string) => `?${baseQuery ? `${baseQuery}&` : ""}tab=${t}${extra ? `&${extra}` : ""}`;
  const who = actor.kind === "CLIENT" ? (actor.name || actor.email) : actor.kind === "STAFF" ? (actor.staffName || "Staff") : null;
  // "Set up your sign-in" — a link visit on a program that already has a person with a seat (transition Stage B).
  const offerSignIn = actor.kind === "TOKEN" && (await enrollmentHasMembership(enrollment.id));

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

  if (tab === "home" || tab === "videos") {
    // The library's logical videos are built from the cuts and delivery rows
    // (idempotent, additive) before they are read.
    await attempt("video sync", () => syncEnrollmentVideos(enrollment));
  }
  if (tab === "home") {
    const [planning, schedule, videos, topics, released, month, counts, attention] = await Promise.all([
      attempt("planning", () => portalPlanning(enrollment)),
      attempt("schedule", () => portalScheduleMonths(enrollment)),
      attempt("videos", () => portalVideoList(enrollment, { page: 1, perPage: 24 })),
      attempt("topics", () => portalTopics(enrollment)),
      attempt("strategy", () => prisma.contentStrategyVersion.count({ where: { enrollmentId: enrollment.id, releasedAt: { not: null } } })),
      prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, monthKey }, select: { videosOwed: true } }),
      attempt("counts", () => programCountsByMonth(enrollment.id, [monthKey])),
      // Library-wide, not page one: "N waiting on you" is a library fact.
      attempt("attention", () => libraryAttention(enrollment)),
    ]);
    home = {
      first, monthKey, videosOwed: month?.videosOwed ?? enrollment.videosPerMonth,
      program: counts.ok ? counts.data.get(monthKey) ?? { delivered: 0, total: 0 } : null, countsFailed: !counts.ok,
      planning: planning.ok ? planning.data : null, planningFailed: !planning.ok,
      schedule: schedule.ok ? schedule.data.find((m) => m.monthKey === monthKey) ?? schedule.data[0] ?? null : null, scheduleFailed: !schedule.ok,
      bookingUrl: STRATEGY_CALL_BOOKING_URL,
      videos: videos.ok ? { rows: videos.data.rows, total: videos.data.total } : null, videosFailed: !videos.ok,
      attention: attention.ok ? attention.data : null,
      topics: topics.ok ? topics.data : null, topicsFailed: !topics.ok,
      strategyReleased: released.ok ? released.data > 0 : null,
      perms: { session: perms.session, suggest: perms.suggest, request: perms.request, approve: perms.approve }, readOnly,
    };
  }
  if (tab === "videos") {
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
        const pillar = video.pillarId ? await prisma.contentPillar.findUnique({ where: { id: video.pillarId }, select: { name: true } }).catch(() => null) : null;
        const kitData: PostingKit | null = kit.ok ? kit.data : null;
        // The state comes from the video row itself, through the one derivation
        // the list uses — never from whichever page happened to be fetched.
        const current = versions.find((x) => x.isCurrent);
        const state = await videoState(enrollment.id, video).catch(() =>
          current?.clientState === "YOU_APPROVED" ? "APPROVED" : current?.clientState === "AWAITING_YOUR_DECISION" ? "FOR_REVIEW" : current?.clientState === "YOU_REQUESTED_CHANGES" ? "CHANGES_IN_PROGRESS" : video.status === "DELIVERED" ? "DELIVERED" : "IN_PRODUCTION",
        );
        detail = {
          video: { id: video.id, title: video.title ?? "Video", monthKey: video.monthKey, kind: video.kind, state, filmedAtISO: video.filmedAt?.toISOString() ?? null, deliveredAtISO: video.deliveredAt?.toISOString() ?? null, pillarName: pillar?.name ?? null, format: video.format },
          versions, versionsFailed: !hist.ok,
          kit: kitData, kitFailed: !kit.ok,
          // A delivered (Aryeo/Mux) file plays directly — it is a CDN URL, not a hub cut, so no token applies.
          delivered: deliveredSrc?.playback && !/^\/api\/review\/cut\//.test(deliveredSrc.playback) ? { playback: deliveredSrc.playback, thumb: deliveredSrc.thumb } : null,
          // The download door: a media token over the VIDEO id, scoped to this viewer.
          downloadHref: kitData?.final ? `/api/portal/download/${video.id}?m=${encodeURIComponent(mediaToken(video.id, scope))}` : null,
          perms: { comment: perms.comment, request: perms.request, approve: perms.approve, suggest: perms.suggest }, readOnly,
        };
      }
    }
    if (!detail) {
      const year = query.year && /^\d{4}$/.test(query.year) ? Number(query.year) : null;
      const page = query.page && /^\d{1,4}$/.test(query.page) ? Number(query.page) : 1;
      videosPage = await attempt("videos", () => portalVideoList(enrollment, { year, page }));
    }
  }
  if (tab === "topics") {
    const ivId = query.iv && ID_RE.test(query.iv) ? query.iv : null;
    if (ivId) interviewRes = await attempt("interview", () => portalInterview(enrollment, ivId));
    if (!ivId || (interviewRes?.ok && !interviewRes.data)) topicsRes = await attempt("topics", () => portalTopics(enrollment));
  }
  if (tab === "strategy") {
    const [s, m] = await Promise.all([
      attempt("strategy", () => portalStrategy(enrollment)),
      prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, monthKey }, select: { prioritiesJson: true } }).catch(() => null),
    ]);
    strategyRes = s;
    if (m?.prioritiesJson) { const { monthPriorities } = await import("@/lib/contentStrategy"); priorities = monthPriorities(m.prioritiesJson); }
  }
  if (tab === "schedule") {
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
    // Live Aryeo slots only when a picker could actually render.
    if (s.ok && perms.session && !readOnly && s.data.some((m) => !m.locked && m.capacity.remaining > 0)) slotDays = await companySlotDays().catch(() => []);
  }
  if (tab === "resources") resourcesRes = await attempt("resources", () => publishedResources());

  // Agent-profile prefill (Jordan: seed from what we already know; the client overwrites).
  const prefill = { brandColors: client?.brandColors ?? "", videoStyle: client?.portalVideoStyle ?? "", preferences: client?.portalPreferences ?? "" };
  if (tab === "profile") {
    if (!prefill.videoStyle || !prefill.preferences) {
      const { getPortalPrefill } = await import("@/lib/portalPrefill");
      const extracted = await getPortalPrefill(enrollment.id, enrollment.clientId).catch(() => ({ videoStyle: "", preferences: "" }));
      if (!prefill.videoStyle) prefill.videoStyle = extracted.videoStyle;
      if (!prefill.preferences) prefill.preferences = extracted.preferences;
    }
    if (!prefill.brandColors) {
      const ap = await prisma.agentProfile.findUnique({ where: { clientId: enrollment.clientId }, select: { brandJson: true } }).catch(() => null);
      const hexes = [...new Set(((ap?.brandJson ?? "").match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? []))];
      if (hexes.length) prefill.brandColors = hexes.join(", ");
    }
  }
  const termsSetting = tab === "terms" ? await prisma.appSetting.findUnique({ where: { key: "portal-terms" } }).catch(() => null) : null;
  const assets = tab === "profile" ? await listClientAssets(enrollment.clientId, { links: true }).catch(() => null) : null;
  const terms = (termsSetting?.value?.trim() || DEFAULT_TERMS).split(/\n\s*\n/);

  const account = { who, staff: actor.kind === "STAFF", first, profileHref: href("profile"), termsHref: href("terms"), tab, canSignOut: actor.kind === "CLIENT", offerSignIn };

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
              <summary className="flex size-9 cursor-pointer list-none items-center justify-center rounded-full border border-border bg-surface/80 text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden" aria-label="Account menu">
                <UserRound className="size-4" />
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
        {readOnly && (
          <div className="mt-5 flex items-start gap-2 rounded-2xl border border-border bg-surface/80 p-3.5 text-sm">
            <PauseCircle className="mt-0.5 size-4 shrink-0 text-muted" />
            <div>
              <div className="font-semibold">{enrollment.status === "PAUSED" ? "Your program is paused" : "Your program has ended"}</div>
              <div className="text-xs text-muted">Everything we&rsquo;ve delivered stays here for you to watch and download. New requests, notes and bookings are off until it {enrollment.status === "PAUSED" ? "resumes" : "restarts"} — text us any time.</div>
            </div>
          </div>
        )}
        {actor.kind === "STAFF" && (
          <div className="mt-5 flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft/40 p-3.5 text-sm">
            <Eye className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="text-xs">You&rsquo;re viewing this as <span className="font-semibold">{who}</span>, on {client?.name}&rsquo;s behalf. Anything you submit here is recorded as <span className="font-semibold">you, on their behalf</span> — never as them.</div>
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
          />
        )}
        {tab === "resources" && <ResourcesTab groups={resourcesRes?.ok ? resourcesRes.data : null} failed={!!resourcesRes && !resourcesRes.ok} open={query.r} />}

        {/* ---------------- MY BRAND PROFILE ---------------- */}
        {tab === "profile" && (
          <div className="mt-6 space-y-4">
            <h1 className="text-xl font-semibold tracking-tight">My Brand Profile</h1>
            <PortalProfile initial={prefill} assets={(assets?.files ?? []).map((f) => ({ name: f.name, url: f.url }))} readOnly={!perms.profile} />
          </div>
        )}

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

        <p className="mt-8 flex items-center justify-center gap-1.5 text-center text-xs text-muted-2">
          <Sparkles className="size-3.5" /> Questions or topic ideas? Text us any time.
        </p>
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
            <summary className={cn("flex min-h-12 cursor-pointer list-none flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden", ["schedule", "resources", "profile", "terms"].includes(tab) ? "text-brand" : "text-muted")}>
              <MoreHorizontal className="size-5" /> More
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

type AccountMenu = { who: string | null; staff: boolean; first: string; profileHref: string; termsHref: string; tab: PortalTab; canSignOut: boolean; offerSignIn: boolean };
/** The account menu's items — shared by the top-right menu and the phone bar's More sheet. */
function AccountItems({ a }: { a: AccountMenu }) {
  return (
    <>
      {a.who && (
        <div className="px-3 py-2 text-xs text-muted-2">
          {a.staff ? <>Viewing as <span className="font-semibold text-foreground">{a.who}</span> on {a.first}&rsquo;s behalf</> : <>Signed in as <span className="font-semibold text-foreground">{a.who}</span></>}
        </div>
      )}
      <MenuLink href={a.profileHref} icon={UserRound} active={a.tab === "profile"}>My Brand Profile</MenuLink>
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
