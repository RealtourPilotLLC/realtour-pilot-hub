import Link from "next/link";
import { CalendarClock, Camera, CheckCircle2, ChevronRight, Clapperboard, Clock, Compass, Download, Lightbulb, ListChecks, MapPin, MessageSquare, PenLine, PlayCircle, Video } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import { homeSessionView, readOnlyNotice, type PortalPlanning, type PortalScheduleMonth, type PortalTopicsData } from "@/lib/portal";
import type { LibraryAttention, VideoListRow } from "@/lib/contentVideos";
import type { ClientMonthProgress } from "@/lib/monthProgress";
import { Card, CardTitle, LoadFailed, RowLink, fmtDate, fmtShort, fmtTime, tzShort } from "@/components/portal/ui";
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
  const tz = p?.timezone ?? "America/New_York";
  const tzName = tzShort(tz);
  // Rows are the PREVIEW (page one); the counts beside them are the library's.
  const needReviewRows = d.videos?.rows.filter((v) => v.needsDecision) ?? [];
  const readyRows = d.videos?.rows.filter((v) => v.state === "APPROVED" || v.state === "DELIVERED") ?? [];
  const readyToUse = readyRows.slice(0, 4);
  const needReviewCount = d.attention?.needReview ?? needReviewRows.length;
  const readyCount = d.attention?.readyToUse ?? readyRows.length;
  const readyWithFile = d.attention ? d.attention.readyWithFile > 0 : readyRows.some((v) => v.hasFinalFile);
  const currentMonth = d.topics?.months.find((m) => m.monthKey === d.monthKey) ?? d.topics?.months[0] ?? null;
  const selectedTopics = d.topics ? d.topics.groups.flatMap((g) => g.topics).filter((t) => t.selection && currentMonth && t.selection.monthId === currentMonth.id) : [];
  const interviewsToFinish = selectedTopics.filter((t) => t.state !== "FILMED" && (!t.interview || t.interview.status !== "SUBMITTED"));
  const sessionRequests = d.schedule?.requests.filter((r) => ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"].includes(r.status)) ?? [];
  // Sessions from the month-progress reader: one card per DISTINCT session,
  // "Filmed" only when somebody confirmed it, and "Book your filming session"
  // whenever a session the package owes is still missing (CP-10) — a Pro month
  // with one of two booked used to hide it.
  const sv = homeSessionView(d.progress, d.schedule, { canBook: d.perms.session, readOnly: d.readOnly });
  const pendingAsks = sessionRequests.filter((r) => r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED");
  const locationFor = (startISO: string | null) =>
    sessionRequests.find((r) => r.locationText && r.slotStartISO && startISO && r.slotStartISO === startISO)?.locationText
      ?? (sv.cards.length === 1 ? sessionRequests.find((r) => r.locationText)?.locationText : null) ?? null;

  // The action list — derived, in the order a client should do them.
  const actions: { href: string; icon: typeof ListChecks; text: string; tone?: "brand" }[] = [];
  // A reply from the office comes first, and reaches a paused account too: it
  // is something to read, not something to start.
  if (d.messages && d.messages.unread > 0) actions.push({ href: d.messages.href, icon: MessageSquare, text: `${d.messages.unread === 1 ? "A new reply" : `${d.messages.unread} new replies`} from the team`, tone: "brand" });
  if (!d.readOnly) {
    if (p && p.planningMode !== "WRITTEN" && p.callStatus === "NOT_SCHEDULED") actions.push({ href: href("schedule"), icon: CalendarClock, text: "Book your strategy call — we plan the month on it", tone: "brand" });
    if (needReviewCount) actions.push({ href: href("videos"), icon: PlayCircle, text: `Review ${needReviewCount} video${needReviewCount === 1 ? "" : "s"} waiting on you`, tone: "brand" });
    if (currentMonth && currentMonth.selected < currentMonth.owed && d.perms.suggest) actions.push({ href: href("topics"), icon: Lightbulb, text: `Pick ${currentMonth.owed - currentMonth.selected} more topic${currentMonth.owed - currentMonth.selected === 1 ? "" : "s"} for ${monthLabel(currentMonth.monthKey)}` });
    if (p?.planningMode === "WRITTEN" && interviewsToFinish.length && d.perms.suggest) actions.push({ href: href("topics"), icon: PenLine, text: `Answer the questions for ${interviewsToFinish.length === 1 ? `“${interviewsToFinish[0].title}”` : `${interviewsToFinish.length} topics`}` });
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
              <p className="mt-0.5 text-xs text-muted">{p.answersSubmitted ? "Your answers are in — we're preparing the month." : "No call this month — answer the questions under Video Topics."}</p>
              <Link href={href("topics")} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">Video Topics <ChevronRight className="size-3" /></Link>
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
              {!d.readOnly && <a href={d.bookingUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">Book one anyway <ChevronRight className="size-3" /></a>}
            </div>
          ) : (
            <div className="mt-2 text-sm">
              <div className="text-muted">Not booked yet</div>
              {!d.readOnly && <a href={d.bookingUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Book the call <ChevronRight className="size-3.5" /></a>}
              {p.noCallEligible && !d.readOnly && <Link href={href("schedule")} className="mt-1 block text-xs text-muted hover:underline">or plan without a call →</Link>}
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
                    {sv.offerBooking && <Link href={href("schedule")} className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Book the session <ChevronRight className="size-3.5" /></Link>}
                    {d.schedule.locked && <Link href={href("schedule")} className="mt-1 block text-xs text-muted hover:underline">See scheduling →</Link>}
                  </div>
                )}
              </Card>
            )}
          </>
        )}
      </div>

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
                <li key={t.id} className="flex items-center gap-2 text-sm"><Lightbulb className="size-3.5 shrink-0 text-brand" /> <span className="min-w-0 flex-1">{t.title}</span> <span className="text-[11px] text-muted-2">{t.state === "FILMED" ? "filmed" : t.interview?.status === "SUBMITTED_WITH_GAPS" ? "sent — we'll follow up" : t.state === "PREPARING" ? "preparing" : t.interview?.status === "SUBMITTED" ? "answers in" : "selected"}</span></li>
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
