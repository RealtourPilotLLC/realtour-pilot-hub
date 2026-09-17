import Link from "next/link";
import { BrandWordmark } from "@/components/Brand";
import {
  CalendarClock, Camera, CheckCircle2, ChevronRight, Clock, Download, FileText, Home, KeyRound, LogOut, MapPin, MoreHorizontal, PauseCircle, PlayCircle,
  ScrollText, Sparkles, TriangleAlert, UserRound, Compass, Clapperboard, Eye,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { monthLabel, etMonthKey } from "@/lib/contentProgram";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import {
  portalCuts, portalLibrary, recordPortalVisit, enrollmentHasMembership, CLIENT_VISIBLE_SCRIPT,
  type PortalCut, type PortalLibraryRow, type PortalViewer, type PortalScheduleMonth, type PortalSlotDay,
} from "@/lib/portal";
import { can } from "@/lib/portalAccess";
import { withMediaToken, mediaScopeOf } from "@/lib/portalMedia";
import { listClientAssets } from "@/lib/clientAssets";
import { PortalVideoReview } from "@/components/portal/PortalVideoReview";
import { PortalSuggestBox } from "@/components/portal/PortalSuggestBox";
import { PortalScheduler } from "@/components/portal/PortalScheduler";
import { PortalProfile } from "@/components/portal/PortalProfile";
import { ScriptBody } from "@/components/portal/ScriptBody";
import { PortalRichText } from "@/components/portal/PortalRichText";
import { signOutPortal } from "@/app/portal/login/actions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE CLIENT PORTAL PAGE — one component, two routes. /portal/<token> (the
// link) and /portal/me (a signed-in person) both resolve a PortalViewer and
// hand it here; the page never looks at a cookie or a token itself.
//
// Shell (spec §1, foundation only — Sep 16): Home · My Videos · My Strategy ·
// Schedule, with the account menu (Profile, Terms, sign in/out) up top and a
// Home · Videos · Strategy · More bar on a phone. Each tab is EXISTING content
// re-homed: the review loop + library under My Videos, the strategy render
// under My Strategy, the scheduler under Schedule. Video Topics and Resources
// are deliberately absent — their pages come in wave 2, and a tab with nothing
// real behind it is a placeholder.
//
// Strict rules hold: approved content only, never money, never internal
// notes. Nothing in this HTML carries the enrollment token — tab links are
// query-only (relative to the address bar), <video src> carries a six-hour
// media token bound to that one cut, and the client components read the
// address bar when they call an action.
// ---------------------------------------------------------------------------

export type PortalTab = "home" | "videos" | "strategy" | "schedule" | "profile" | "terms";
const MAIN_TABS: { key: PortalTab; label: string; short: string; icon: typeof Home }[] = [
  { key: "home", label: "Home", short: "Home", icon: Home },
  { key: "videos", label: "My Videos", short: "Videos", icon: Clapperboard },
  { key: "strategy", label: "My Strategy", short: "Strategy", icon: Compass },
  { key: "schedule", label: "Schedule", short: "Schedule", icon: CalendarClock },
];
// Old links (`?tab=library`) keep landing somewhere sensible.
const LEGACY_TABS: Record<string, PortalTab> = { library: "videos", home: "home", videos: "videos", strategy: "strategy", schedule: "schedule", profile: "profile", terms: "terms" };
export const portalTabOf = (raw: string | undefined): PortalTab => LEGACY_TABS[raw ?? ""] ?? "home";

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" });
const fmtTime = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const streetOf = (title: string | null, addressLine: string | null) => (addressLine || (title ?? "").split(",")[0] || "").trim();

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

export async function PortalPage({ viewer, tab, path, baseQuery = "" }: {
  viewer: PortalViewer;
  tab: PortalTab;
  /** What PortalVisit records — the pathname, never the query. */
  path: string;
  /** Query that must survive tab changes (`e=<enrollmentId>` on /portal/me). */
  baseQuery?: string;
}) {
  const { enrollment, actor, access } = viewer;
  await recordPortalVisit(viewer, path);

  const client = await prisma.client.findUnique({
    where: { id: enrollment.clientId },
    select: { name: true, brandColors: true, portalVideoStyle: true, portalPreferences: true },
  });
  const readOnly = access !== "FULL";
  const perms = {
    request: can(viewer, "requestChanges"),
    suggest: can(viewer, "suggest"),
    profile: can(viewer, "editBrandProfile"),
    session: can(viewer, "requestSession"),
  };

  const monthKey = etMonthKey();
  // Failure states are HONEST: a cut load that throws says so on the page,
  // never "nothing to review".
  let cuts: PortalCut[] = [];
  let cutsFailed = false;
  let library: PortalLibraryRow[] = [];
  let libraryFailed = false;
  const [months, cutsRes, libRes] = await Promise.all([
    prisma.contentMonth.findMany({
      where: { enrollmentId: enrollment.id },
      orderBy: { monthKey: "desc" },
      take: 18,
      select: { id: true, monthKey: true, strategyCallStatus: true, strategyCallAt: true },
    }),
    portalCuts(enrollment).then((c) => ({ ok: true as const, c })).catch((e: unknown) => ({ ok: false as const, e })),
    portalLibrary(enrollment).then((l) => ({ ok: true as const, l })).catch((e: unknown) => ({ ok: false as const, e })),
  ]);
  if (cutsRes.ok) cuts = cutsRes.c; else { cutsFailed = true; console.error("[portal] cuts failed", cutsRes.e); }
  if (libRes.ok) library = libRes.l; else { libraryFailed = true; console.error("[portal] library failed", libRes.e); }
  // Hub-held cuts stream through the gated route; the src carries a media
  // token bound to that one cut AND to this viewer's seat/link, never the
  // portal token — the stream route re-checks the seat/link on every request.
  const scope = mediaScopeOf(viewer);
  for (const c of cuts) c.assetUrl = withMediaToken(c.assetUrl, scope) ?? c.assetUrl;
  for (const v of library) { v.playback = withMediaToken(v.playback, scope); v.download = withMediaToken(v.download, scope); }

  const monthIds = months.map((m) => m.id);
  const [scripts, sessionsRaw] = await Promise.all([
    prisma.contentScript.findMany({
      where: { monthId: { in: monthIds }, status: { in: CLIENT_VISIBLE_SCRIPT } },
      orderBy: { createdAt: "asc" },
      select: { id: true, monthId: true, title: true, body: true },
    }),
    prisma.project.findMany({
      where: { contentMonthId: { in: monthIds }, status: { not: "CANCELLED" } },
      orderBy: { shootDate: "desc" },
      select: { id: true, contentMonthId: true, shootDate: true, status: true, title: true, addressLine: true, clientId: true },
    }),
  ]);
  // The same ownership rule the cut/library reads apply: a job filed on the
  // wrong client's month is not this client's session.
  const sessions = sessionsRaw.filter((s) => s.clientId === enrollment.clientId);

  // Agent-profile prefill (Jordan: "it should include information we already
  // have from them — they can overwrite it"): when a Client field is blank,
  // seed the form from the AI-built profile so the client edits from what we
  // know instead of a blank box. Their save writes the canonical Client
  // fields; the AI profile itself is never overwritten. Prefill rules
  // (Jordan, Aug 28): the style/preference fields seed ONLY from what the
  // client actually SAID on their calls. Nothing fits → empty.
  const prefill = {
    brandColors: client?.brandColors ?? "",
    videoStyle: client?.portalVideoStyle ?? "",
    preferences: client?.portalPreferences ?? "",
  };
  if (tab === "profile") {
    if (!prefill.videoStyle || !prefill.preferences) {
      const { getPortalPrefill } = await import("@/lib/portalPrefill");
      const extracted = await getPortalPrefill(enrollment.id, enrollment.clientId).catch(() => ({ videoStyle: "", preferences: "" }));
      if (!prefill.videoStyle) prefill.videoStyle = extracted.videoStyle;
      if (!prefill.preferences) prefill.preferences = extracted.preferences;
    }
    if (!prefill.brandColors) {
      // Colors are factual — hexes anywhere in the client's own brand data.
      const ap = await prisma.agentProfile.findUnique({ where: { clientId: enrollment.clientId }, select: { brandJson: true } }).catch(() => null);
      const hexes = [...new Set(((ap?.brandJson ?? "").match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? []))];
      if (hexes.length) prefill.brandColors = hexes.join(", ");
    }
  }
  // Their content strategy — the ACTIVE one, read-only and money-scrubbed.
  let strategySections: { name: string; body: string }[] = [];
  let strategyFailed = false;
  const strategyRow = tab === "strategy" || tab === "home"
    ? await prisma.contentStrategy.findFirst({ where: { enrollmentId: enrollment.id, status: "ACTIVE" }, orderBy: { updatedAt: "desc" }, select: { sectionsJson: true } }).catch(() => null)
    : null;
  if (tab === "strategy" && strategyRow?.sectionsJson) {
    try {
      const { stripMoneySentences } = await import("@/lib/text");
      const obj = JSON.parse(strategyRow.sectionsJson) as Record<string, unknown>;
      // Hide the internal production mechanics (Jordan, Aug 28: the video-
      // structure framework and caption-CTA lists don't belong on the
      // client's page); everything brand-facing stays.
      const INTERNAL_SECTION = /preference|framework|business|production|caption/i;
      strategySections = Object.entries(obj)
        .filter(([k]) => !INTERNAL_SECTION.test(k))
        .filter(([, v]) => typeof v === "string" && (v as string).trim().length > 0)
        .map(([k, v]) => ({
          name: k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()),
          body: stripMoneySentences(v as string),
        }))
        .filter((sec) => sec.body.trim().length > 0);
    } catch { strategyFailed = true; }
  }
  const hasStrategy = !!strategyRow?.sectionsJson;
  // Terms + assets only when their tabs render (assets = Dropbox round-trips).
  const termsSetting = tab === "terms" ? await prisma.appSetting.findUnique({ where: { key: "portal-terms" } }).catch(() => null) : null;
  const assets = tab === "profile" ? await listClientAssets(enrollment.clientId, { links: true }).catch(() => null) : null;
  // "Set up your sign-in" — a link visit on a program that already has a
  // person with a seat. Soft: the link keeps working (transition Stage B).
  // The account-menu "Sign in with email" item is gated on the SAME test: no
  // real client holds a seat before launch, so a real client never sees a
  // door that cannot open (review, Sep 17).
  const offerSignIn = actor.kind === "TOKEN" && (await enrollmentHasMembership(enrollment.id));

  const current = months.find((m) => m.monthKey === monthKey) ?? null;
  const call = current?.strategyCallStatus ?? "NOT_SCHEDULED";
  const callAt = current?.strategyCallAt ?? null;
  const now = new Date();
  const upcoming = sessions.filter((s) => s.shootDate && s.shootDate >= now).sort((a, b) => +a.shootDate! - +b.shootDate!);
  // Sessions ALREADY FILMED this month — "no session booked yet" was a lie the
  // day after the shoot (Jordan: "Marcee did have a filming session this
  // month").
  const filmedThisMonth = sessions
    .filter((s) => s.contentMonthId === current?.id && s.shootDate && s.shootDate < now)
    .sort((a, b) => +b.shootDate! - +a.shootDate!);
  const currentVideos = library.filter((v) => v.monthId === current?.id);
  const currentScripts = scripts.filter((s) => s.monthId === current?.id);
  // The Schedule tab: this month and the open months after it, each with its
  // own gate (derived state), capacity and the requests already made — and
  // live Aryeo slots only when a picker could actually render (some month is
  // unlocked with room left, and the viewer may book). Honest on failure: a
  // slot fetch that throws just means the free-text "when works?" path.
  let scheduleMonths: PortalScheduleMonth[] = [];
  let slotDays: PortalSlotDay[] = [];
  if (tab === "schedule") {
    const { portalScheduleMonths, companySlotDays } = await import("@/lib/portal");
    scheduleMonths = await portalScheduleMonths(enrollment).catch((e: unknown) => { console.error("[portal] schedule months failed", e); return []; });
    if (perms.session && scheduleMonths.some((m) => !m.locked && m.capacity.remaining > 0)) {
      slotDays = await companySlotDays().catch(() => []);
    }
  }
  const first = (client?.name ?? "there").split(/\s+/)[0];
  const href = (t: PortalTab) => `?${baseQuery ? `${baseQuery}&` : ""}tab=${t}`;
  const terms = (termsSetting?.value?.trim() || DEFAULT_TERMS).split(/\n\s*\n/);
  const who = actor.kind === "CLIENT" ? (actor.name || actor.email) : actor.kind === "STAFF" ? (actor.staffName || "Staff") : null;

  return (
    // The Shell renders /portal bare (isBare in src/components/Shell.tsx), so
    // there is no staff chrome left to sit on top of. This full-viewport layer
    // stays as the portal's own scroll surface — and as a second line of
    // defence if that ever regresses — but it is NOT the thing hiding the hub:
    // covering chrome never hid it from view-source or a screen reader.
    <div className="portal-light fixed inset-0 z-50 overflow-y-auto bg-background text-foreground">
      {/* aurora wash — the hub's futurist ground, tuned for the portal */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 h-72"
        style={{ background: "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--brand) 14%, transparent), transparent 70%)" }} />
      <div className="relative mx-auto max-w-3xl p-4 pb-28 sm:p-6 sm:pb-24">
        {/* BRAND + NAME + ACCOUNT MENU — one clean row. */}
        <div className="flex items-center gap-3 pt-4">
          <BrandWordmark variant="onLight" className="h-5 sm:h-6" />
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <div className="min-w-0 text-right">
              <div className="truncate text-sm font-semibold leading-tight">{client?.name}</div>
              <div className="text-[11px] text-muted-2">Content Program</div>
            </div>
            <details className="relative">
              <summary className="flex size-9 cursor-pointer list-none items-center justify-center rounded-full border border-border bg-surface/80 text-muted hover:text-foreground [&::-webkit-details-marker]:hidden" aria-label="Account menu">
                <UserRound className="size-4" />
              </summary>
              <div className="absolute right-0 z-10 mt-2 w-60 rounded-2xl border border-border bg-surface p-1.5 shadow-lg">
                {who && (
                  <div className="px-3 py-2 text-xs text-muted-2">
                    {actor.kind === "STAFF" ? <>Viewing as <span className="font-semibold text-foreground">{who}</span> on {first}&rsquo;s behalf</> : <>Signed in as <span className="font-semibold text-foreground">{who}</span></>}
                  </div>
                )}
                <MenuLink href={href("profile")} icon={UserRound} active={tab === "profile"}>Agent Profile</MenuLink>
                <MenuLink href={href("terms")} icon={ScrollText} active={tab === "terms"}>Terms</MenuLink>
                {actor.kind === "CLIENT" && (
                  <form action={signOutPortal}>
                    <button type="submit" className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-foreground">
                      <LogOut className="size-4" /> Sign out
                    </button>
                  </form>
                )}
                {offerSignIn && (
                  <MenuLink href="/portal/login" icon={KeyRound}>Sign in with email</MenuLink>
                )}
              </div>
            </details>
          </div>
        </div>

        {/* TABS — segmented pill on wider screens; the phone gets the bottom bar. */}
        <nav className="mt-5 hidden gap-1 rounded-2xl border border-border bg-surface/70 p-1 backdrop-blur sm:flex">
          {MAIN_TABS.map((t) => (
            <Link key={t.key} href={href(t.key)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-semibold",
                tab === t.key ? "bg-brand text-white shadow" : "text-muted hover:text-foreground",
              )}>
              <t.icon className="size-4" /> {t.label}
            </Link>
          ))}
        </nav>

        {/* NOTICES — the honest ones, never hidden behind a tab. */}
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

        {/* ---------------- HOME ---------------- */}
        {tab === "home" && (
          <div className="mt-6 space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight">Hi {first} 👋</h1>

            {/* This month at a glance */}
            <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">{monthLabel(monthKey)}</span>
                <span className="text-sm font-bold tabular-nums">{currentVideos.length}<span className="text-muted-2">/{enrollment.videosPerMonth} videos</span></span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-gradient-to-r from-brand to-orange-400"
                  style={{ width: `${Math.min(100, (currentVideos.length / Math.max(1, enrollment.videosPerMonth)) * 100)}%` }} />
              </div>
            </div>

            {/* APPOINTMENTS — the strategy call and the session, one card. */}
            <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-semibold"><CalendarClock className="size-4 text-brand" /> Appointments</span>
                <Link href={href("schedule")} className="text-xs font-medium text-brand hover:underline">Schedule →</Link>
              </div>
              <div className="mt-3 space-y-2 text-sm">
                {call === "COMPLETED" ? (
                  <p className="flex items-center gap-2 text-success"><CheckCircle2 className="size-4 shrink-0" /> Strategy call done{callAt ? ` — ${fmtDate(callAt)}` : ""}</p>
                ) : call === "SCHEDULED" && callAt ? (
                  <p className="flex items-center gap-2"><CalendarClock className="size-4 shrink-0 text-brand" /> Strategy call — {fmtDate(callAt)} at {fmtTime(callAt)} ET</p>
                ) : call === "NOT_REQUIRED" || call === "SKIPPED" ? null : (
                  <p className="flex items-center gap-2 text-muted"><CalendarClock className="size-4 shrink-0" /> No strategy call booked yet this month</p>
                )}
                {/* THE SESSION — date, time, location, one spot. Three true
                    states: booked ahead, already filmed, or nothing yet. */}
                {upcoming[0] ? (
                  <SessionRow tone="brand" label="Your next session" s={upcoming[0]} />
                ) : filmedThisMonth[0] ? (
                  <SessionRow tone="success" label="This month's session — filmed" s={filmedThisMonth[0]} />
                ) : (
                  <p className="flex items-center gap-2 text-muted"><Camera className="size-4 shrink-0" /> No filming session booked yet</p>
                )}
              </div>
            </div>

            {/* VIDEOS AWAITING REVIEW — honest in every state. */}
            {cutsFailed ? (
              <Notice tone="warn">We couldn&rsquo;t load your videos for review just now — refresh to try again.</Notice>
            ) : cuts.length > 0 ? (
              <Link href={href("videos")} className="flex items-center gap-2 rounded-2xl border border-brand/30 bg-brand-soft/40 p-4 text-sm font-medium hover:bg-brand-soft/60">
                <PlayCircle className="size-4 text-brand" />
                {cuts.length} video{cuts.length === 1 ? "" : "s"} ready for your review
                <ChevronRight className="ml-auto size-4 text-brand" />
              </Link>
            ) : (
              <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">
                <PlayCircle className="size-4 shrink-0" /> Nothing waiting for your review right now.
              </div>
            )}

            {/* STRATEGY LINK */}
            <Link href={href("strategy")} className="flex items-center gap-2 rounded-2xl border border-border bg-surface/70 p-4 text-sm font-medium hover:bg-surface">
              <Compass className="size-4 text-brand" />
              {hasStrategy ? "Your content strategy" : "Your content strategy — not shared yet"}
              <ChevronRight className="ml-auto size-4 text-muted-2" />
            </Link>

            {/* This month's content */}
            {currentVideos.length > 0 && (
              <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">This month&rsquo;s videos</span>
                  <Link href={href("videos")} className="text-xs font-medium text-brand hover:underline">All videos →</Link>
                </div>
                <VideoGrid videos={currentVideos} />
              </div>
            )}
            {currentScripts.length > 0 && (
              <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
                <div className="flex items-center gap-2 text-sm font-semibold"><FileText className="size-4 text-brand" /> This month&rsquo;s scripts</div>
                {perms.suggest && <p className="mt-1 text-xs text-muted-2">Tap to read — and hit &ldquo;Suggest a change&rdquo; if you&rsquo;d word anything differently.</p>}
                <div className="mt-3 space-y-2">
                  {currentScripts.map((sc) => (
                    <details key={sc.id} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3" open={currentScripts.length <= 2}>
                      <summary className="cursor-pointer text-sm font-bold">{sc.title}</summary>
                      <ScriptBody body={sc.body} />
                      {perms.suggest && <PortalSuggestBox scriptId={sc.id} />}
                    </details>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------------- MY VIDEOS ---------------- */}
        {tab === "videos" && (
          <div className="mt-6 space-y-5">
            {cutsFailed && <Notice tone="warn">We couldn&rsquo;t load your videos for review just now — refresh to try again.</Notice>}
            {libraryFailed && <Notice tone="warn">We couldn&rsquo;t load your video library just now — refresh to try again.</Notice>}
            {cuts.length > 0 && (
              <div className="panel-shadow rounded-2xl border border-brand/30 bg-surface/70 p-4 backdrop-blur">
                <div className="text-sm font-semibold">For your review</div>
                {perms.request ? (
                  <p className="mt-1 text-xs text-muted-2">Pause, drop a note where you want a change, then &ldquo;Request changes&rdquo; — straight to your editor.</p>
                ) : (
                  <p className="mt-1 text-xs text-muted-2">Watch and share your thoughts with the program owner — requests come from them.</p>
                )}
                <div className="mt-3 space-y-4">
                  {cuts.map((c) => (
                    <PortalVideoReview key={c.submissionId} cut={c} monthLabel={monthLabel(c.monthKey)} readOnly={!perms.request} />
                  ))}
                </div>
              </div>
            )}
            {!cutsFailed && !libraryFailed && cuts.length === 0 && library.length === 0 && scripts.length === 0 && (
              <div className="rounded-2xl border border-border bg-surface/70 p-6 text-center text-sm text-muted">
                <Clapperboard className="mx-auto size-6 text-muted-2" />
                <p className="mt-2">No videos yet. They land here as each session is delivered.</p>
              </div>
            )}
            {months.filter((m) => library.some((v) => v.monthId === m.id) || scripts.some((s) => s.monthId === m.id) || sessions.some((s) => s.contentMonthId === m.id && s.shootDate)).map((m) => {
              const mVideos = library.filter((v) => v.monthId === m.id);
              const mScripts = scripts.filter((s) => s.monthId === m.id);
              const mSessions = sessions.filter((s) => s.contentMonthId === m.id && s.shootDate);
              const isCurrent = m.monthKey === monthKey;
              // Scripts pair with their videos; the unpaired ones are the
              // leftovers that carry to the next session.
              const paired = matchVideosToScripts(mVideos, mScripts);
              const pairedIds = new Set([...paired.values()].map((x) => x.id));
              const looseScripts = mScripts.filter((sc) => !pairedIds.has(sc.id));
              return (
                <div key={m.id} className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-base font-semibold">{monthLabel(m.monthKey)}</span>
                    {isCurrent && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">this month</span>}
                    <span className="text-xs text-muted-2">
                      {[mVideos.length > 0 ? `${mVideos.length} video${mVideos.length === 1 ? "" : "s"}` : null, mScripts.length > 0 ? `${mScripts.length} script${mScripts.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  {mSessions.map((s) => (
                    <div key={s.id} className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                      <span className="flex items-center gap-1"><CalendarClock className="size-3.5 text-brand" /> {fmtDate(s.shootDate!)}</span>
                      <span className="flex items-center gap-1"><Clock className="size-3.5 text-brand" /> {fmtTime(s.shootDate!)} ET</span>
                      {streetOf(s.title, s.addressLine) && <span className="flex items-center gap-1"><MapPin className="size-3.5 text-brand" /> {streetOf(s.title, s.addressLine)}</span>}
                      {s.status === "DELIVERED" && <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">delivered</span>}
                    </div>
                  ))}
                  {mVideos.length > 0 && <VideoGrid videos={mVideos} scriptFor={paired} />}
                  {looseScripts.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">
                        {paired.size > 0 && mVideos.length > 0 ? "Not filmed yet — carries to the next session" : "Scripts"}
                      </div>
                      {looseScripts.map((sc) => (
                        <details key={sc.id} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
                          <summary className="cursor-pointer text-sm font-bold">{sc.title}</summary>
                          <ScriptBody body={sc.body} size="xs" />
                          {isCurrent && perms.suggest && <PortalSuggestBox scriptId={sc.id} />}
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ---------------- MY STRATEGY ---------------- */}
        {tab === "strategy" && (
          <div className="mt-6 space-y-4">
            {strategyFailed ? (
              <Notice tone="warn">We couldn&rsquo;t read your strategy just now — refresh to try again.</Notice>
            ) : strategySections.length > 0 ? (
              <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
                <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-brand" /> Your content strategy</div>
                <p className="mt-1 text-xs text-muted-2">The playbook behind your monthly content — built from your brand discovery and strategy calls.</p>
                <div className="mt-3 space-y-2">
                  {strategySections.map((sec) => (
                    <details key={sec.name} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
                      <summary className="cursor-pointer text-sm font-bold">{sec.name}</summary>
                      <PortalRichText text={sec.body} />
                    </details>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-border bg-surface/70 p-6 text-center text-sm text-muted">
                <Compass className="mx-auto size-6 text-muted-2" />
                <p className="mt-2">Your strategy hasn&rsquo;t been shared here yet. It appears after your brand discovery and first strategy call.</p>
              </div>
            )}
          </div>
        )}

        {/* ---------------- SCHEDULE ---------------- */}
        {tab === "schedule" && (
          <div className="mt-6 space-y-4">
            <PortalScheduler
              months={scheduleMonths}
              bookingUrl={STRATEGY_CALL_BOOKING_URL}
              days={slotDays}
              readOnly={!perms.session}
            />
            <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
              <div className="flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-brand" /> Sessions</div>
              {sessions.filter((s) => s.shootDate).length === 0 ? (
                <p className="mt-2 text-sm text-muted">No sessions on the calendar yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {sessions.filter((s) => s.shootDate).slice(0, 12).map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      <span className="flex items-center gap-1.5"><CalendarClock className={cn("size-4", s.shootDate! >= now ? "text-brand" : "text-muted-2")} /> {fmtDate(s.shootDate!)}</span>
                      <span className="flex items-center gap-1.5 text-muted"><Clock className="size-4" /> {fmtTime(s.shootDate!)} ET</span>
                      {streetOf(s.title, s.addressLine) && <span className="flex items-center gap-1.5 text-muted"><MapPin className="size-4" /> {streetOf(s.title, s.addressLine)}</span>}
                      {s.shootDate! >= now ? <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">upcoming</span>
                        : s.status === "DELIVERED" ? <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">delivered</span>
                        : <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">filmed</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* ---------------- AGENT PROFILE ---------------- */}
        {tab === "profile" && (
          <div className="mt-6 space-y-4">
            <PortalProfile
              initial={prefill}
              assets={(assets?.files ?? []).map((f) => ({ name: f.name, url: f.url }))}
              readOnly={!perms.profile}
            />
          </div>
        )}

        {/* ---------------- TERMS ---------------- */}
        {tab === "terms" && (
          <div className="panel-shadow mt-6 rounded-2xl border border-border bg-surface/70 p-5 backdrop-blur">
            <div className="flex items-center gap-2 text-sm font-semibold"><ScrollText className="size-4 text-brand" /> Terms of Service</div>
            <div className="mt-3 space-y-3">
              {terms.map((block, i) => {
                if (block.startsWith("## ")) {
                  // The heading may share its block with body lines (review
                  // finding: the whole block rendered inside the <h3>).
                  const [head, ...rest] = block.split("\n");
                  const body = rest.join("\n").trim();
                  return (
                    <div key={i}>
                      <h3 className="pt-3 text-sm font-bold text-foreground">{head.replace(/^## /, "")}</h3>
                      {body && (rest.every((l) => !l.trim() || l.trim().startsWith("- ")) ? (
                        <ul className="mt-2 space-y-1 pl-1">
                          {rest.filter((l) => l.trim().startsWith("- ")).map((l, j) => (
                            <li key={j} className="flex gap-2 text-sm leading-relaxed text-foreground/85">
                              <span className="text-brand">·</span>
                              <span>{l.trim().replace(/^- /, "")}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/85">{body}</p>
                      ))}
                    </div>
                  );
                }
                const lines = block.split("\n");
                if (lines.every((l) => l.trim().startsWith("- "))) {
                  return (
                    <ul key={i} className="space-y-1 pl-1">
                      {lines.map((l, j) => (
                        <li key={j} className="flex gap-2 text-sm leading-relaxed text-foreground/85">
                          <span className="text-brand">·</span>
                          <span>{l.trim().replace(/^- /, "")}</span>
                        </li>
                      ))}
                    </ul>
                  );
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

      {/* PHONE BAR — Home · Videos · Strategy · More. */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur sm:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="mx-auto grid max-w-3xl grid-cols-4">
          {MAIN_TABS.filter((t) => t.key !== "schedule").map((t) => (
            <Link key={t.key} href={href(t.key)} className={cn("flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold", tab === t.key ? "text-brand" : "text-muted")}>
              <t.icon className="size-5" /> {t.short}
            </Link>
          ))}
          <details className="group relative">
            <summary className={cn("flex cursor-pointer list-none flex-col items-center gap-0.5 py-2 text-[11px] font-semibold [&::-webkit-details-marker]:hidden", ["schedule", "profile", "terms"].includes(tab) ? "text-brand" : "text-muted")}>
              <MoreHorizontal className="size-5" /> More
            </summary>
            <div className="absolute bottom-full right-2 mb-2 w-56 rounded-2xl border border-border bg-surface p-1.5 shadow-lg">
              <MenuLink href={href("schedule")} icon={CalendarClock} active={tab === "schedule"}>Schedule</MenuLink>
              <MenuLink href={href("profile")} icon={UserRound} active={tab === "profile"}>Agent Profile</MenuLink>
              <MenuLink href={href("terms")} icon={ScrollText} active={tab === "terms"}>Terms</MenuLink>
              {actor.kind === "CLIENT" && (
                <form action={signOutPortal}>
                  <button type="submit" className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-foreground">
                    <LogOut className="size-4" /> Sign out
                  </button>
                </form>
              )}
              {offerSignIn && <MenuLink href="/portal/login" icon={KeyRound}>Sign in with email</MenuLink>}
            </div>
          </details>
        </div>
      </nav>
    </div>
  );
}

function MenuLink({ href, icon: Icon, active = false, children }: { href: string; icon: typeof Home; active?: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2 rounded-xl px-3 py-2 text-sm hover:bg-surface-2 hover:text-foreground", active ? "font-semibold text-brand" : "text-muted")}>
      <Icon className="size-4" /> {children}
    </Link>
  );
}

function Notice({ tone, children }: { tone: "warn"; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-2xl border p-3.5 text-sm", tone === "warn" && "border-warning/30 bg-warning-soft/40")}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <span className="text-xs">{children}</span>
    </div>
  );
}

function SessionRow({ tone, label, s }: { tone: "brand" | "success"; label: string; s: { shootDate: Date | null; title: string | null; addressLine: string | null; status: string } }) {
  const c = tone === "brand" ? "text-brand" : "text-success";
  return (
    <div className={cn("rounded-xl border p-3", tone === "brand" ? "border-brand/25 bg-brand-soft/30" : "border-success/25 bg-success-soft/40")}>
      <div className={cn("flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest", c)}>
        {tone === "success" && <CheckCircle2 className="size-3.5" />} {label}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium">
        <span className="flex items-center gap-1.5"><CalendarClock className={cn("size-4", c)} /> {fmtDate(s.shootDate!)}</span>
        <span className="flex items-center gap-1.5"><Clock className={cn("size-4", c)} /> {fmtTime(s.shootDate!)} ET</span>
        {streetOf(s.title, s.addressLine) && (
          <span className="flex items-center gap-1.5"><MapPin className={cn("size-4", c)} /> {streetOf(s.title, s.addressLine)}</span>
        )}
        {s.status === "DELIVERED" && <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">delivered</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video ↔ script pairing. Jordan's rule (Aug 28, settled): a month's scripts
// ride WITH its videos — and when a session films 3 of 4, the unpaired script
// visibly carries to the next session. Deterministic matching: shared
// significant words; when BOTH titles carry numbers they must agree.
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set(["the", "and", "for", "with", "your", "you", "what", "how", "why", "isn", "not", "can", "video", "final", "reel"]);
function titleTokens(t: string): { words: Set<string>; nums: Set<string> } {
  const lower = t.toLowerCase().replace(/[’']/g, "");
  const nums = new Set([...lower.matchAll(/(?:#|no\.?\s*)?(\d+)/g)].map((m) => m[1]));
  const words = new Set(lower.replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
  return { words, nums };
}
function pairScore(videoTitle: string, scriptTitle: string): number {
  const a = titleTokens(videoTitle);
  const b = titleTokens(scriptTitle);
  if (a.nums.size && b.nums.size && ![...a.nums].some((n) => b.nums.has(n))) return 0;
  if (a.words.size === 0 || b.words.size === 0) return 0;
  return [...a.words].filter((w) => b.words.has(w)).length / Math.min(a.words.size, b.words.size);
}
function matchVideosToScripts(
  videos: { id: string; title: string | null }[],
  scripts: { id: string; title: string; body: string }[],
): Map<string, { id: string; title: string; body: string }> {
  const candidates: { v: string; s: (typeof scripts)[number]; score: number }[] = [];
  for (const v of videos) {
    if (!v.title) continue;
    for (const sc of scripts) {
      const score = pairScore(v.title, sc.title);
      if (score >= 0.5) candidates.push({ v: v.id, s: sc, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const out = new Map<string, (typeof scripts)[number]>();
  const used = new Set<string>();
  for (const c of candidates) {
    if (out.has(c.v) || used.has(c.s.id)) continue;
    out.set(c.v, c.s);
    used.add(c.s.id);
  }
  return out;
}

function VideoGrid({ videos, scriptFor }: {
  videos: { id: string; title: string | null; thumb: string | null; playback: string | null; download: string | null }[];
  scriptFor?: Map<string, { id: string; title: string; body: string }>;
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-3">
      {videos.map((v, i) => (
        <div key={v.id} className="lift overflow-hidden rounded-xl border border-border bg-surface">
          {v.playback ? (
            <video src={v.playback} poster={v.thumb ?? undefined} controls playsInline preload="none" className="aspect-[9/16] max-h-64 w-full bg-black object-contain" />
          ) : v.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.thumb} alt={v.title ?? "Video"} className="max-h-64 w-full object-cover" />
          ) : null}
          <div className="flex items-start gap-2 px-2.5 py-2">
            {/* Full title, wrapping — the agent reads the whole thing (Jordan). */}
            <span className="min-w-0 flex-1 text-sm font-semibold leading-snug">{v.title ?? `Video ${i + 1}`}</span>
            {v.download && (
              <a href={v.download} target="_blank" rel="noopener noreferrer" title="Download"
                className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] font-semibold text-brand hover:bg-brand-soft">
                <Download className="size-3.5" />
              </a>
            )}
          </div>
          {scriptFor?.get(v.id) && (
            <details className="border-t border-border bg-surface-2/40 px-2.5 py-1.5">
              <summary className="cursor-pointer text-[11px] font-semibold text-brand">
                <FileText className="mr-1 inline size-3" /> The script for this video
              </summary>
              <ScriptBody body={scriptFor.get(v.id)!.body} size="xs" />
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
