import Link from "next/link";
import { CalendarClock, Camera, CheckCircle2, ChevronDown, ChevronRight, Clapperboard, Clock, Compass, Download, Lightbulb, ListChecks, MapPin, MessageSquare, PenLine, PlayCircle, Sparkles, Video } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import { homeSessionView, readOnlyNotice, type PortalPlanning, type PortalScheduleMonth, type PortalTopicsData } from "@/lib/portal";
import type { LibraryAttention, VideoListRow } from "@/lib/contentVideos";
import type { ClientMonthProgress } from "@/lib/monthProgress";
import type { HomeAction } from "@/lib/portalHome";
import { awaitingScript } from "@/lib/portalHome";
import { SCRIPT_WORDS, TOPIC_WORDS, VIDEO_WORDS, planStepWord } from "@/lib/portalWords";
import { Card, CardTitle, CountBadge, LoadFailed, RowLink, StatusChip, fmtDate, fmtShort, fmtTime, tzShort } from "@/components/portal/ui";
import { cn } from "@/lib/utils";
import { SetupCard, type SetupCardData } from "@/components/portal/PortalProfile";

// ---------------------------------------------------------------------------
// HOME answers four questions (spec §1): what to do next, when the two
// appointments are, what we're creating this month, which videos need review
// or are ready. Everything is real data or an honest "couldn't load"; an empty
// state names the next action.
// ---------------------------------------------------------------------------

export type HomeData = {
  first: string;
  monthKey: string;
  videosOwed: number;
  program: { delivered: number; total: number } | null;
  /** The month's counts did not load. A failed count is NEVER shown as zero. */
  countsFailed: boolean;
  /** This month through lib/monthProgress — the reader every staff screen uses (CP-10). */
  progress: ClientMonthProgress | null;
  planning: PortalPlanning | null;
  planningFailed: boolean;
  schedule: PortalScheduleMonth | null;
  scheduleFailed: boolean;
  bookingUrl: string;
  videos: { rows: VideoListRow[]; total: number } | null;
  videosFailed: boolean;
  /** Library-wide counts for the badges — a page total would understate them. */
  attention: LibraryAttention | null;
  topics: PortalTopicsData | null;
  topicsFailed: boolean;
  strategyReleased: boolean | null;
  perms: { session: boolean; suggest: boolean; request: boolean; approve: boolean };
  readOnly: boolean;
  /** WHICH read-only state, so this tab and the banner above it never say
   *  different things about the same account (review blocker, Sep 17). */
  readOnlyState: "PAUSED" | "ENDED" | null;
  /** CP-06: the account-setup checklist (derived, never stored as done), each
   *  item with its link already built. Absent for a read-only viewer. */
  setup?: SetupCardData | null;
  /** CP-13: replies on the program conversation this viewer has not opened. */
  messages?: { unread: number; href: string } | null;
};

export function HomeTab({ d, href }: { d: HomeData; href: (tab: string, extra?: string) => string }) {
  const p = d.planning;
  // Rows are the PREVIEW (page one); the counts beside them are the library's.
  const needReviewRows = d.videos?.rows.filter((v) => v.needsDecision) ?? [];
  const readyRows = d.videos?.rows.filter((v) => v.state === "APPROVED" || v.state === "DELIVERED") ?? [];
  const readyToUse = readyRows.slice(0, 4);
  const needReviewCount = d.attention?.needReview ?? needReviewRows.length;
  const readyCount = d.attention?.readyToUse ?? readyRows.length;
  const readyWithFile = d.attention ? d.attention.readyWithFile > 0 : readyRows.some((v) => v.hasFinalFile);
  const currentMonth = d.topics?.months.find((m) => m.monthKey === d.monthKey) ?? d.topics?.months[0] ?? null;
  const selectedTopics = d.topics ? d.topics.groups.flatMap((g) => g.topics).filter((t) => t.selection && currentMonth && t.selection.monthId === currentMonth.id) : [];
  // R01: the planning reader's owed answers — the month's allowance only, and
  // never a topic the call covered or a script already in review.
  const interviewsToFinish = selectedTopics.filter((t) => t.plan?.step === "NEEDS_ANSWERS" || t.plan?.step === "NEEDS_MORE");
  // Sessions from the month-progress reader: one card per DISTINCT session,
  // "Filmed" only when somebody confirmed it, and "Book your filming session"
  // whenever a session the package owes is still missing (CP-10) — a Pro month
  // with one of two booked used to hide it.
  const sv = homeSessionView(d.progress, d.schedule, { canBook: d.perms.session, readOnly: d.readOnly });

  // The action list — derived, in the order a client should do them.
  const actions: { href: string; icon: typeof ListChecks; text: string; tone?: "brand" }[] = [];
  // A reply from the office comes first, and reaches a paused account too: it
  // is something to read, not something to start.
  if (d.messages && d.messages.unread > 0) actions.push({ href: d.messages.href, icon: MessageSquare, text: `${d.messages.unread === 1 ? "A new reply" : `${d.messages.unread} new replies`} from the team`, tone: "brand" });
  if (!d.readOnly) {
    if (p && p.planningMode !== "WRITTEN" && p.callStatus === "NOT_SCHEDULED") actions.push({ href: href("schedule"), icon: CalendarClock, text: "Book your strategy call — we plan the month on it", tone: "brand" });
    if (needReviewCount) actions.push({ href: href("videos"), icon: PlayCircle, text: `Review ${needReviewCount} video${needReviewCount === 1 ? "" : "s"} waiting on you`, tone: "brand" });
    if (currentMonth && currentMonth.selected < currentMonth.owed && d.perms.suggest) actions.push({ href: href("topics"), icon: Lightbulb, text: `Choose ${currentMonth.owed - currentMonth.selected} more topic${currentMonth.owed - currentMonth.selected === 1 ? "" : "s"} for ${monthLabel(currentMonth.monthKey)}` });
    if (interviewsToFinish.length && d.perms.suggest) actions.push({ href: href("topics"), icon: PenLine, text: `Answer the questions for ${interviewsToFinish.length === 1 ? `“${interviewsToFinish[0].title}”` : `${interviewsToFinish.length} topics`}` });
    if (sv.offerBooking) actions.push({ href: href("schedule"), icon: Camera, text: sv.required > 1 && sv.missing < sv.required ? `Book your next filming session (${sv.required - sv.missing} of ${sv.required} booked)` : "Book your filming session" });
    if (readyCount && readyWithFile) actions.push({ href: href("videos"), icon: Download, text: `Download and post ${readyCount === 1 && readyRows.length === 1 ? `“${readyRows[0].title}”` : `${readyCount} finished video${readyCount === 1 ? "" : "s"}`}` });
  }

  return (
    <div className="mt-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Hi {d.first} 👋</h1>

      {/* 0. Account setup, until it is complete (CP-06) — skippable, and a
          skipped item is still counted as not done. */}
      {d.setup && !d.readOnly && !d.setup.complete && <SetupCard d={d.setup} />}

      {/* 1. What do I need to do next? */}
      <Card>
        <CardTitle icon={ListChecks}>Next up</CardTitle>
        {actions.length === 0 ? (
          <>
            <p className="mt-2 flex items-center gap-2 text-sm text-muted"><CheckCircle2 className="size-4 text-success" /> Nothing waiting on you right now{d.readOnly ? (d.readOnlyState === "PAUSED" ? " — your program is paused." : " — your program has ended.") : "."}</p>
            {/* CP-12: the way back, beside the state it answers — the same link as the banner. */}
            {d.readOnly && (() => {
              const n = readOnlyNotice(d.readOnlyState ?? "ENDED");
              return <a href={n.cta.href} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{n.cta.label} <ChevronRight className="size-3.5" /></a>;
            })()}
          </>
        ) : (
          <ol className="mt-2 space-y-1.5">
            {actions.slice(0, 5).map((a, i) => (
              <li key={i}>
                <Link href={a.href} className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", a.tone === "brand" ? "border-brand/30 bg-brand-soft/40" : "border-border bg-surface")}>
                  <a.icon className="size-4 shrink-0 text-brand" /> <span className="min-w-0 flex-1">{a.text}</span> <ChevronRight className="size-4 shrink-0 text-muted-2" />
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* 2. When are my appointments? — two cards */}
      <AppointmentCards d={d} href={href} />

      {/* 3. What are we creating this month? */}
      <Card>
        <CardTitle icon={Clapperboard} action={<Link href={href("videos")} className="text-xs font-medium text-brand hover:underline">My Videos →</Link>}>{monthLabel(d.monthKey)}</CardTitle>
        {d.videosFailed ? (
          <p className="mt-2 text-xs text-warning">Couldn&rsquo;t load this month&rsquo;s videos — refresh to try again.</p>
        ) : (
          <>
            {/* A count that failed to load is unknown, not zero: printing "0
                delivered" would tell the client we shipped nothing this month. */}
            <div className="mt-2 flex items-baseline justify-between text-sm">
              <span className="text-muted">Videos this month</span>
              {d.countsFailed || !d.program ? (
                <span className="text-muted-2">{d.videosOwed} in your package</span>
              ) : (
                <span className="font-bold tabular-nums">{d.program.delivered}<span className="text-muted-2"> delivered · {d.videosOwed} in your package</span></span>
              )}
            </div>
            {d.countsFailed || !d.program ? (
              <p className="mt-1 text-xs text-warning">We couldn&rsquo;t count this month&rsquo;s videos just now — refresh to try again, or open My Videos to see them.</p>
            ) : (
              <>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-gradient-to-r from-brand to-orange-400" style={{ width: `${Math.min(100, (d.program.delivered / Math.max(1, d.videosOwed)) * 100)}%` }} />
                </div>
                {d.program.total > d.program.delivered && <p className="mt-1 text-xs text-muted">{d.program.total - d.program.delivered} in production or review.</p>}
                {/* Released videos waiting on THEIR approval: say so, and where. It is
                    not the library catching up — no sync closes it; their approval does. */}
                {d.progress && d.progress.production.awaitingYou > 0 && (
                  <p className="mt-1 text-xs text-muted">{d.progress.production.awaitingYou === 1 ? "1 video is" : `${d.progress.production.awaitingYou} videos are`} waiting on your approval. <Link href={href("videos")} className="font-medium text-brand hover:underline">Review in My Videos</Link></p>
                )}
                {/* The library is behind what was delivered: say the count will catch up, never present it as final. */}
                {d.progress && !d.progress.production.known && <p className="mt-1 text-xs text-muted">We&rsquo;re still adding this month&rsquo;s delivered videos to your library — this count will catch up shortly.</p>}
              </>
            )}
          </>
        )}
        {d.topicsFailed ? (
          <p className="mt-2 text-xs text-warning">Couldn&rsquo;t load your topics — refresh to try again.</p>
        ) : selectedTopics.length > 0 ? (
          <div className="mt-3">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Selected topics</div>
            <ul className="mt-1 space-y-1">
              {selectedTopics.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm"><Lightbulb className="size-3.5 shrink-0 text-brand" /> <span className="min-w-0 flex-1">{t.title}</span> <span className="text-[11px] text-muted-2">{t.plan ? planStepWord(t.plan.step, t.plan.missing).label : t.state === "FILMED" ? "filmed" : "selected"}</span></li>
              ))}
            </ul>
            <Link href={href("topics")} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">Video Topics <ChevronRight className="size-3" /></Link>
          </div>
        ) : d.topics ? (
          <p className="mt-3 text-sm text-muted">No topics selected for {monthLabel(d.monthKey)} yet{d.perms.suggest && !d.readOnly ? <> — <Link href={href("topics")} className="font-medium text-brand hover:underline">pick from your bank</Link>.</> : "."}</p>
        ) : null}
      </Card>

      {/* 4. Which videos need review or are ready? */}
      {d.videosFailed ? (
        <LoadFailed what="your videos" />
      ) : needReviewCount > 0 ? (
        <RowLink href={href("videos")} icon={PlayCircle} tone="brand">{needReviewCount} video{needReviewCount === 1 ? "" : "s"} ready for your review</RowLink>
      ) : (
        <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted"><PlayCircle className="size-4 shrink-0" /> Nothing waiting for your review right now.</div>
      )}
      {readyToUse.length > 0 && (
        <Card>
          <CardTitle icon={Download} action={<Link href={href("videos")} className="text-xs font-medium text-brand hover:underline">All videos →</Link>}>Ready to use{readyCount > readyToUse.length ? ` (${readyToUse.length} of ${readyCount})` : ""}</CardTitle>
          <ul className="mt-2 space-y-1">
            {readyToUse.map((v) => (
              <li key={v.id}><Link href={href("videos", `v=${v.id}`)} className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><CheckCircle2 className="size-3.5 shrink-0 text-success" /> <span className="min-w-0 flex-1 truncate">{v.title}</span> <ChevronRight className="size-3.5 text-muted-2" /></Link></li>
            ))}
          </ul>
        </Card>
      )}

      {/* Strategy link */}
      <RowLink href={href("strategy")} icon={Compass}>{d.strategyReleased ? "Your approved strategy" : "Your strategy — not shared yet"}</RowLink>
    </div>
  );
}

/**
 * The two appointment cards — strategy call and content session(s). Lifted
 * out of HomeTab unchanged (UI-01) so the v2 Home shows the same cards from
 * the same derivations; `href` answers in whichever layout is rendering.
 *
 * Two v2-only options (Sep 24). `quiet`: v2 Home has ONE dominant action, and
 * these cards put up to two more filled orange buttons ("Book the call",
 * "Book the session") beside it — quiet draws them as links. `plan`: v2 has
 * no page called "Video Topics", so the written-planning line names the plan
 * and links to the month view, where the questions are actually asked.
 * v1 passes neither and renders exactly as before.
 */
export function AppointmentCards({ d, href, quiet = false, plan = null }: {
  d: HomeData; href: (tab: string, extra?: string) => string;
  quiet?: boolean;
  /** v2: where the month's questions are answered, and what to call it. */
  plan?: { href: string; label: string } | null;
}) {
  const bookCls = quiet
    ? "mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
    : "mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand";
  const p = d.planning;
  const tz = p?.timezone ?? "America/New_York";
  const tzName = tzShort(tz);
  const sessionRequests = d.schedule?.requests.filter((r) => ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"].includes(r.status)) ?? [];
  const sv = homeSessionView(d.progress, d.schedule, { canBook: d.perms.session, readOnly: d.readOnly });
  const pendingAsks = sessionRequests.filter((r) => r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED");
  const locationFor = (startISO: string | null) =>
    sessionRequests.find((r) => r.locationText && r.slotStartISO && startISO && r.slotStartISO === startISO)?.locationText
      ?? (sv.cards.length === 1 ? sessionRequests.find((r) => r.locationText)?.locationText : null) ?? null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Card>
        <CardTitle icon={CalendarClock}>Strategy call</CardTitle>
        {d.planningFailed ? (
          <p className="mt-2 text-xs text-warning">Couldn&rsquo;t load this month&rsquo;s planning state — refresh to try again.</p>
        ) : !p ? (
          <p className="mt-2 text-sm text-muted">Your next program month isn&rsquo;t open yet.</p>
        ) : p.planningMode === "WRITTEN" ? (
          <div className="mt-2 text-sm">
            <div className="flex items-center gap-1.5 font-medium"><PenLine className="size-4 text-brand" /> Planning in writing</div>
            <p className="mt-0.5 text-xs text-muted">{p.answersSubmitted ? "Your answers are in — we're preparing the month." : plan ? "No call this month — answer the questions in Your Month." : "No call this month — answer the questions under Video Topics."}</p>
            <Link href={plan?.href ?? href("topics")} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">{plan?.label ?? "Video Topics"} <ChevronRight className="size-3" /></Link>
          </div>
        ) : p.callStatus === "COMPLETED" ? (
          <div className="mt-2 text-sm">
            <div className="flex items-center gap-1.5 font-medium text-success"><CheckCircle2 className="size-4" /> Held{p.callAtISO ? ` — ${fmtShort(p.callAtISO, tz)}` : ""}</div>
            <p className="mt-0.5 text-xs text-muted">{monthLabel(p.monthKey)} is planned.</p>
          </div>
        ) : p.callStatus === "SCHEDULED" && p.callAtISO ? (
          <div className="mt-2 text-sm">
            <div className="rounded-md bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">Booked</div>
            <div className="mt-1 font-medium">{fmtDate(p.callAtISO, tz)}</div>
            <div className="flex items-center gap-1.5 text-muted"><Clock className="size-3.5" /> {fmtTime(p.callAtISO, tz)}{p.callEndISO ? `–${fmtTime(p.callEndISO, tz)}` : ""} {tzName}</div>
            {p.meetLink ? <a href={p.meetLink} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"><Video className="size-3.5" /> Join on Google Meet</a> : <span className="mt-1 block text-xs text-muted-2">Video call — the link is in your calendar invite.</span>}
            {!d.readOnly && <Link href={href("schedule")} className="mt-1 block text-xs text-muted hover:underline">Need to move it? →</Link>}
          </div>
        ) : p.callStatus === "NOT_REQUIRED" ? (
          <p className="mt-2 text-sm text-muted">Your program doesn&rsquo;t include a strategy call.</p>
        ) : p.callStatus === "SKIPPED" ? (
          // SKIPPED = no call on THIS month, not "no calls on this program".
          // A card headed "Strategy call" that offers no way to get one is a
          // dead end; the same state on the Schedule tab keeps the link.
          <div className="mt-2 text-sm">
            <p className="text-muted">No call this month.</p>
            {!d.readOnly && <a href={d.bookingUrl} target={/^https?:/.test(d.bookingUrl) ? "_blank" : undefined} rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">Book one anyway <ChevronRight className="size-3" /></a>}
          </div>
        ) : (
          <div className="mt-2 text-sm">
            <div className="text-muted">Not booked yet</div>
            {!d.readOnly && <a href={d.bookingUrl} target={/^https?:/.test(d.bookingUrl) ? "_blank" : undefined} rel="noopener noreferrer" className={bookCls}>Book the call <ChevronRight className="size-3.5" /></a>}
            {/* v2: the route is chosen in Your Month (§6.4); v1 keeps its Schedule link. */}
            {p.noCallEligible && !d.readOnly && <Link href={plan ? `${plan.href}#step-route` : href("schedule")} className="mt-1 block text-xs text-muted hover:underline">{plan ? "or choose your topics here →" : "or plan without a call →"}</Link>}
          </div>
        )}
      </Card>
      {d.scheduleFailed || (!d.progress && d.countsFailed) ? (
        <Card>
          <CardTitle icon={Camera}>Content session</CardTitle>
          <p className="mt-2 text-xs text-warning">Couldn&rsquo;t load your session state — refresh to try again.</p>
        </Card>
      ) : !d.schedule && sv.cards.length === 0 ? (
        <Card>
          <CardTitle icon={Camera}>Content session</CardTitle>
          <p className="mt-2 text-sm text-muted">Your next program month isn&rsquo;t open yet.</p>
        </Card>
      ) : (
        <>
          {sv.cards.map((c, i) => {
            const loc = c.state === "BOOKED" ? locationFor(c.startsAtISO) : null;
            return (
              <Card key={i}>
                <CardTitle icon={Camera}>{sv.required > 1 ? `Content session ${i + 1} of ${sv.required}` : "Content session"}</CardTitle>
                <div className="mt-2 text-sm">
                  <div className={cn("inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold", c.state === "BOOKED" || c.state === "FILMED" ? "bg-success-soft text-success" : "bg-brand-soft text-brand")}>{c.label}</div>
                  {c.startsAtISO && <div className="mt-1 font-medium">{fmtDate(c.startsAtISO, tz)}</div>}
                  {c.startsAtISO && <div className="flex items-center gap-1.5 text-muted"><Clock className="size-3.5" /> {fmtTime(c.startsAtISO, tz)} {tzName}</div>}
                  {c.note && <p className="mt-0.5 text-xs text-muted">{c.note}</p>}
                  {loc && <div className="flex items-center gap-1.5 text-muted"><MapPin className="size-3.5" /> {loc}</div>}
                  {c.state === "BOOKED" && !d.readOnly && d.perms.session && <Link href={href("schedule")} className="mt-1 block text-xs text-muted hover:underline">Reschedule or cancel →</Link>}
                </div>
              </Card>
            );
          })}
          {sv.missing > 0 && (
            <Card>
              <CardTitle icon={Camera}>{sv.required > 1 ? (sv.missing === 1 ? `Content session ${sv.required} of ${sv.required}` : `Content sessions — ${sv.missing} of ${sv.required} to book`) : "Content session"}</CardTitle>
              {pendingAsks.length ? (
                <div className="mt-2 text-sm">
                  <div className="inline-block rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">{pendingAsks[0].label}</div>
                  {pendingAsks[0].slotStartISO && <div className="mt-1 font-medium">{fmtDate(pendingAsks[0].slotStartISO, tz)} · {fmtTime(pendingAsks[0].slotStartISO, tz)} {tzName}</div>}
                  {pendingAsks[0].locationText && <div className="flex items-center gap-1.5 text-muted"><MapPin className="size-3.5" /> {pendingAsks[0].locationText}</div>}
                  {!d.readOnly && d.perms.session && <Link href={href("schedule")} className="mt-1 block text-xs text-muted hover:underline">Change or cancel →</Link>}
                </div>
              ) : !d.schedule ? (
                <p className="mt-2 text-sm text-muted">Your next program month isn&rsquo;t open yet.</p>
              ) : (
                <div className="mt-2 text-sm">
                  <div className="text-muted">{d.schedule.locked ? d.schedule.reason : "Not booked yet"}</div>
                  {sv.offerBooking && <Link href={href("schedule")} className={bookCls}>Book the session <ChevronRight className="size-3.5" /></Link>}
                  {d.schedule.locked && <Link href={href("schedule")} className="mt-1 block text-xs text-muted hover:underline">See scheduling →</Link>}
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ===========================================================================
// HOME — the v2 layout (UI-01, Sep 24 2026). ONE next step, big, with one
// button; everything else that is waiting folded beneath it; the setup
// checklist until it is done; this month; the appointments; what is ready to
// download. The step comes from lib/portalHome.homeActions, which only ranks
// facts the page already loaded. v1's HomeTab above is unchanged.
// ===========================================================================

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function HomeV2({ d, actions, href }: {
  d: HomeData;
  actions: { primary: HomeAction | null; more: HomeAction[] };
  /** v1-signature links answered with v2 addresses (portalNav.v2HrefFor). */
  href: (tab: string, extra?: string) => string;
}) {
  const { primary, more } = actions;
  const notice = d.readOnly ? readOnlyNotice(d.readOnlyState ?? "ENDED") : null;
  const readyRows = d.videos?.rows.filter((v) => (v.state === "APPROVED" || v.state === "DELIVERED") && v.downloadable) ?? [];
  return (
    <div className="mt-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Hi {d.first}</h1>

      {/* 1. The one next step. */}
      <section data-primary-action aria-labelledby="home-next-step" className="panel-shadow rounded-2xl border border-brand/30 bg-brand-soft/30 p-4 backdrop-blur">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-brand"><Sparkles className="size-3.5" aria-hidden /> Your next step</div>
        {primary ? (
          <>
            <h2 id="home-next-step" className="mt-1 break-words text-lg font-semibold leading-snug">{primary.title}</h2>
            {primary.detail && <p className="mt-0.5 text-sm text-muted">{primary.detail}</p>}
            <Link href={primary.href} className={`mt-3 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand px-5 text-sm font-semibold text-white shadow hover:opacity-90 sm:w-auto ${focusRing}`}>{primary.cta} <ChevronRight className="size-4" aria-hidden /></Link>
          </>
        ) : notice ? (
          // CP-12: the paused/ended state and the way back, in the same words as the banner.
          <>
            <h2 id="home-next-step" className="mt-1 text-lg font-semibold leading-snug">{notice.title}</h2>
            <p className="mt-0.5 text-sm text-muted">Everything we&rsquo;ve delivered stays here for you to watch and download.</p>
            <a href={notice.cta.href} target="_blank" rel="noopener noreferrer" className={`mt-3 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand px-5 text-sm font-semibold text-white shadow sm:w-auto ${focusRing}`}>{notice.cta.label} <ChevronRight className="size-4" aria-hidden /></a>
          </>
        ) : (
          <>
            <h2 id="home-next-step" className="mt-1 flex items-center gap-2 text-lg font-semibold leading-snug"><CheckCircle2 className="size-5 text-success" aria-hidden /> You&rsquo;re all caught up</h2>
            <p className="mt-0.5 text-sm text-muted">Nothing is waiting on you right now. The next step shows up here the moment there is one.</p>
          </>
        )}
      </section>

      {/* 2. Everything else that is waiting — folded, never hidden. */}
      {more.length > 0 && (
        <details className="group rounded-2xl border border-border bg-surface/70 px-4 backdrop-blur">
          <summary className={`flex min-h-12 cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden ${focusRing}`}>
            <ListChecks className="size-4 text-brand" aria-hidden /> Also waiting on you <CountBadge n={more.length} label="more things waiting" />
            <ChevronDown className="ml-auto size-4 text-muted-2 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <ul className="space-y-1.5 pb-3">
            {more.map((a) => (
              <li key={a.kind}>
                <Link href={a.href} className={`flex min-h-12 items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-medium ${focusRing}`}>
                  <span className="min-w-0 flex-1">{a.title}{a.detail && <span className="block text-xs font-normal text-muted">{a.detail}</span>}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-2" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* 3. Account setup, until it is complete (CP-06). */}
      {d.setup && !d.readOnly && !d.setup.complete && <SetupCard d={d.setup} />}

      {/* 4. This month. */}
      <MonthCardV2 d={d} href={href} />

      {/* 5. Appointments — the same cards and derivations as v1. */}
      <section aria-label="Appointments">
        <AppointmentCards d={d} href={href} quiet plan={{ href: href("plan"), label: "Open Your Month" }} />
      </section>

      {/* 6. Ready to download. */}
      {readyRows.length > 0 && (
        <Card>
          <CardTitle icon={Download} action={<Link href={href("videos", "st=approved")} className={`text-xs font-medium text-brand hover:underline ${focusRing}`}>All approved →</Link>}>Ready to download</CardTitle>
          <ul className="mt-2 space-y-1">
            {readyRows.slice(0, 4).map((v) => (
              <li key={v.id}>
                <Link href={href("videos", `v=${v.id}`)} className={`flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm hover:bg-surface ${focusRing}`}>
                  <span className="min-w-0 flex-1 truncate">{v.title}</span> <StatusChip word={VIDEO_WORDS[v.state]} /> <ChevronRight className="size-3.5 shrink-0 text-muted-2" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** This month through lib/monthProgress (CP-10) — the counts every staff screen reads. */
function MonthCardV2({ d, href }: { d: HomeData; href: (tab: string, extra?: string) => string }) {
  const month = d.topics?.months.find((m) => m.monthKey === d.monthKey) ?? d.topics?.months[0] ?? null;
  const selected = d.topics && month ? d.topics.groups.flatMap((g) => g.topics).filter((t) => !t.declined && t.selection?.monthId === month.id) : [];
  const prod = d.progress?.production ?? null;
  return (
    <Card>
      <CardTitle icon={Clapperboard} action={<Link href={href("plan")} className={`text-xs font-medium text-brand hover:underline ${focusRing}`}>Your Month →</Link>}>{monthLabel(d.monthKey)}</CardTitle>
      {/* A count that failed to load is unknown, not zero. */}
      {d.countsFailed || !d.program ? (
        <p className="mt-2 text-xs text-warning">We couldn&rsquo;t count this month&rsquo;s videos just now — refresh to try again, or open your Content Library to see them.</p>
      ) : (
        <>
          <div className="mt-2 flex items-baseline justify-between gap-2 text-sm">
            <span className="text-muted">Videos this month</span>
            <span className="font-bold tabular-nums">{d.program.delivered}<span className="font-normal text-muted-2"> of {d.videosOwed} delivered</span></span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Videos delivered this month" aria-valuemin={0} aria-valuemax={Math.max(1, d.videosOwed)} aria-valuenow={Math.min(d.program.delivered, Math.max(1, d.videosOwed))}>
            <div className="h-full rounded-full bg-gradient-to-r from-brand to-orange-400" style={{ width: `${Math.min(100, (d.program.delivered / Math.max(1, d.videosOwed)) * 100)}%` }} />
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-muted">
            {prod && prod.awaitingYou > 0 && <li><Link href={href("videos", "st=review")} className="font-medium text-brand hover:underline">{prod.awaitingYou === 1 ? "1 video is" : `${prod.awaitingYou} videos are`} waiting on your review</Link></li>}
            {d.program.total > d.program.delivered && <li>{d.program.total - d.program.delivered} in production or review</li>}
            {prod && !prod.known && <li>We&rsquo;re still adding this month&rsquo;s delivered videos to your library — this count will catch up shortly.</li>}
          </ul>
        </>
      )}
      {d.topicsFailed ? (
        <p className="mt-2 text-xs text-warning">Couldn&rsquo;t load your topics — refresh to try again.</p>
      ) : selected.length > 0 ? (
        <div className="mt-3">
          {/* The heading counts within the allowance; the surplus is said out
              loud and each extra says so on its own chip — five rows under
              "4 of 4" read as a mistake (Sep 24). R01: the count, the chips
              and the headline all come from the one planning reader, so the
              heading and the rows can no longer disagree. */}
          <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Topics this month{month ? ` · ${month.selected} of ${month.owed}${month.overflow > 0 ? ` · +${month.overflow} extra` : ""}` : ""}</div>
          {month?.planning && <p className="mt-0.5 text-xs text-muted">{month.planning.headline.text}{month.planning.progress ? ` · ${month.planning.progress}` : ""}</p>}
          <ul className="mt-1 space-y-1.5">
            {selected.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="min-w-0 flex-1 basis-40 break-words">{t.title}</span>
                {t.plan ? <StatusChip word={planStepWord(t.plan.step, t.plan.missing)} /> : awaitingScript(t) ? <StatusChip word={SCRIPT_WORDS.AWAITING} /> : <StatusChip word={TOPIC_WORDS[t.state]} />}
              </li>
            ))}
          </ul>
        </div>
      ) : d.topics ? (
        <p className="mt-3 text-sm text-muted">No topics chosen for {monthLabel(d.monthKey)} yet{d.perms.suggest && !d.readOnly ? <> — <Link href={href("topics")} className="font-medium text-brand hover:underline">pick from your topic bank</Link>.</> : "."}</p>
      ) : null}
    </Card>
  );
}

