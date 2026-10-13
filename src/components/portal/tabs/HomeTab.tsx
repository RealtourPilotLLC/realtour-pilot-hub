import Link from "next/link";
import { CalendarClock, Camera, CheckCircle2, ChevronDown, ChevronRight, Clapperboard, Clock, ListChecks, Sparkles, Video } from "lucide-react";
import { monthLabel } from "@/lib/contentProgram";
import { homeSessionView, readOnlyNotice, type PortalPlanning, type PortalScheduleMonth, type PortalTopicsData } from "@/lib/portal";
import type { LibraryAttention, VideoListRow } from "@/lib/contentVideos";
import type { ClientMonthProgress } from "@/lib/monthProgress";
import type { HomeAction } from "@/lib/portalHome";
import { awaitingScript } from "@/lib/portalHome";
import { SCRIPT_WORDS, TOPIC_WORDS, planStepWord } from "@/lib/portalWords";
import { Card, CardTitle, CountBadge, StatusChip, fmtDate, fmtTime, tzShort } from "@/components/portal/ui";
import type { SetupCardData } from "@/components/portal/PortalProfile";

// ---------------------------------------------------------------------------
// HOME answers three questions (spec §1, simplified Oct 13 2026): what to do
// next, where this month stands, and when the next call and filming are.
// Everything is real data or an honest "couldn't load"; an empty state names
// the next action. The old layout's HomeTab was removed with that layout
// (Oct 6 2026); HomeV2 below is the Home every client sees.
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
  /** CP-06: the account-setup checklist (derived, never stored as done). Home
   *  ranks it as a next-step action (FINISH_SETUP); the checklist itself lives
   *  on the Brand Profile page. Absent for a read-only viewer. */
  setup?: SetupCardData | null;
  /** CP-13: replies on the program conversation this viewer has not opened. */
  messages?: { unread: number; href: string } | null;
  /** Oct 8 2026: a client who plans their own content — what their brief for this month holds. */
  brief?: { files: number; notes: boolean; href: string } | null;
};

// ===========================================================================
// HOME (UI-01, Sep 24 2026; the name HomeV2 is historical — it is the only
// Home since Oct 6 2026). ONE next step, big, with one button; everything
// else that is waiting folded beneath it; then one short card about this
// month. The step comes from lib/portalHome.homeActions, which only ranks
// facts the page already loaded.
//
// C14 (Oct 13 2026, Jordan: simplify the portal). Home used to repeat itself:
// the setup checklist, two appointment cards, "Ready to download" and the
// month card's "waiting on your review" each said again what a next-step
// action already said. They are gone; each to-do appears ONCE (the next step,
// or "Also waiting on you"), and the month card says where the month stands
// and when the next call and filming are, linking to Schedule's list.
// ===========================================================================

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function HomeV2({ d, actions, href }: {
  d: HomeData;
  actions: { primary: HomeAction | null; more: HomeAction[] };
  /** Tab-key links answered with current addresses (portalNav.v2HrefFor). */
  href: (tab: string, extra?: string) => string;
}) {
  const { primary, more } = actions;
  const notice = d.readOnly ? readOnlyNotice(d.readOnlyState ?? "ENDED") : null;
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
            <Link href={primary.href} className={`mt-3 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-action px-5 text-sm font-semibold text-white shadow hover:opacity-90 sm:w-auto ${focusRing}`}>{primary.cta} <ChevronRight className="size-4" aria-hidden /></Link>
          </>
        ) : notice ? (
          // CP-12: the paused/ended state and the way back, in the same words as the banner.
          <>
            <h2 id="home-next-step" className="mt-1 text-lg font-semibold leading-snug">{notice.title}</h2>
            <p className="mt-0.5 text-sm text-muted">Everything we&rsquo;ve delivered stays here for you to watch and download.</p>
            <a href={notice.cta.href} target="_blank" rel="noopener noreferrer" className={`mt-3 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-action px-5 text-sm font-semibold text-white shadow sm:w-auto ${focusRing}`}>{notice.cta.label} <ChevronRight className="size-4" aria-hidden /></a>
          </>
        ) : (
          <>
            <h2 id="home-next-step" className="mt-1 flex items-center gap-2 text-lg font-semibold leading-snug"><CheckCircle2 className="size-5 text-success" aria-hidden /> You&rsquo;re all caught up</h2>
            <p className="mt-0.5 text-sm text-muted">Nothing is waiting on you right now. The next step shows up here the moment there is one.</p>
          </>
        )}
      </section>

      {/* 2. Everything else that is waiting — folded, never hidden. Keyed by
          kind AND address: two actions of one kind stay two rows. */}
      {more.length > 0 && (
        <details className="group rounded-2xl border border-border bg-surface/70 px-4 backdrop-blur">
          <summary className={`flex min-h-12 cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden ${focusRing}`}>
            <ListChecks className="size-4 text-brand" aria-hidden /> Also waiting on you <CountBadge n={more.length} label="more things waiting" />
            <ChevronDown className="ml-auto size-4 text-muted-2 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <ul className="space-y-1.5 pb-3">
            {more.map((a) => (
              <li key={`${a.kind}:${a.href}`}>
                <Link href={a.href} className={`flex min-h-12 items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-medium ${focusRing}`}>
                  <span className="min-w-0 flex-1">{a.title}{a.detail && <span className="block text-xs font-normal text-muted">{a.detail}</span>}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-2" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* 3. This month, in short. */}
      <MonthCardV2 d={d} href={href} />
    </div>
  );
}

/** The month's next call and filming, one line each. Schedule holds the full list. */
function ComingUp({ d, href }: { d: HomeData; href: (tab: string, extra?: string) => string }) {
  const p = d.planning;
  const tz = p?.timezone ?? "America/New_York";
  const now = new Date().getTime();
  const zoneOf = (iso: string) => tzShort(tz, new Date(iso));
  const when = (iso: string) => `${fmtDate(iso, tz)} at ${fmtTime(iso, tz)} ${zoneOf(iso)}`;
  const rows: { key: string; icon: typeof CalendarClock; text: string; meet?: string | null }[] = [];
  if (p && p.callStatus === "SCHEDULED" && p.callAtISO && Date.parse(p.callAtISO) > now - 3600_000) {
    rows.push({ key: "call", icon: CalendarClock, text: `Strategy call: ${when(p.callAtISO)}`, meet: p.meetLink ?? null });
  }
  const sv = homeSessionView(d.progress, d.schedule, { canBook: d.perms.session, readOnly: d.readOnly });
  sv.cards.forEach((c, i) => {
    if (c.state === "BOOKED" && c.startsAtISO && Date.parse(c.startsAtISO) > now) rows.push({ key: `film-${i}`, icon: Camera, text: `Filming session: ${when(c.startsAtISO)}` });
  });
  const asked = d.schedule?.requests.find((r) => r.status === "REQUESTED" || r.status === "RESCHEDULE_REQUESTED") ?? null;
  if (sv.requested && asked) rows.push({ key: "asked", icon: Clock, text: `Filming session requested${asked.slotStartISO ? ` for ${when(asked.slotStartISO)}` : ""}. We're confirming it.` });
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <ul className="space-y-1 text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-x-1.5">
            <r.icon className="size-4 shrink-0 text-brand" aria-hidden /> <span>{r.text}</span>
            {r.meet && <a href={r.meet} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline"><Video className="size-3.5" aria-hidden /> Join on Google Meet</a>}
          </li>
        ))}
      </ul>
      <Link href={href("schedule")} className={`mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-brand hover:underline ${focusRing}`}>See what&rsquo;s coming up <ChevronRight className="size-3.5" aria-hidden /></Link>
    </div>
  );
}

/** This month through lib/monthProgress (CP-10) — the counts every staff screen reads. */
function MonthCardV2({ d, href }: { d: HomeData; href: (tab: string, extra?: string) => string }) {
  const month = d.topics?.months.find((m) => m.monthKey === d.monthKey) ?? d.topics?.months[0] ?? null;
  const selected = d.topics && month ? d.topics.groups.flatMap((g) => g.topics).filter((t) => !t.declined && t.selection?.monthId === month.id) : [];
  const prod = d.progress?.production ?? null;
  const filmedWork = !!d.progress && (d.progress.sessions.cards.some((s) => s.state === "FILMED") || d.progress.production.delivered > 0 || d.progress.production.approved > 0 || d.progress.production.awaitingYou > 0);
  // Filming already happened but its topics are not on the month's plan yet:
  // a topic list would read as "choose again", so the card leaves it out.
  const topicHistoryNeedsReview = filmedWork && !!month && (
    month.selected === 0 ||
    selected.length < month.selected
  );
  // C14: the Library files a client-approved video under "Approved", so it is
  // never counted as "in production or review" here.
  const approvedWaiting = prod?.approvedWaiting ?? 0;
  const inProgress = d.program ? Math.max(0, d.program.total - d.program.delivered - approvedWaiting) : 0;
  return (
    <Card>
      <CardTitle icon={Clapperboard} action={<Link href={href("plan")} className={`text-xs font-medium text-brand hover:underline ${focusRing}`}>Your Month →</Link>}>{monthLabel(d.monthKey)}</CardTitle>
      {/* A count that failed to load is unknown, not zero. */}
      {d.countsFailed || !d.program ? (
        <p className="mt-2 text-xs text-warning">We couldn&rsquo;t count this month&rsquo;s videos just now. Refresh to try again, or open your Content Library to see them.</p>
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
            {approvedWaiting > 0 && <li>{approvedWaiting} approved</li>}
            {inProgress > 0 && <li>{inProgress} in production or review</li>}
            {prod && !prod.known && <li>We&rsquo;re still adding this month&rsquo;s delivered videos to your library. This count will catch up shortly.</li>}
          </ul>
        </>
      )}
      {d.planning?.clientPlanned ? (
        // Oct 8 2026: they plan their own videos. Adding the brief is a next-step action, not repeated here.
        <p className="mt-3 text-sm text-muted">
          You plan this month&rsquo;s videos, and we film and edit them.
          {d.brief && (d.brief.files > 0 || d.brief.notes) && <> Your brief is in. <Link href={d.brief.href} className="font-medium text-brand hover:underline">See it or add more</Link>.</>}
        </p>
      ) : d.topicsFailed ? (
        <p className="mt-2 text-xs text-warning">Couldn&rsquo;t load your topics. Refresh to try again.</p>
      ) : topicHistoryNeedsReview ? null : selected.length > 0 ? (
        <div className="mt-3">
          {/* The heading counts within the allowance; the surplus is said out
              loud and each extra says so on its own chip — five rows under
              "4 of 4" read as a mistake (Sep 24). R01: the count, the chips
              and the headline all come from the one planning reader, so the
              heading and the rows can no longer disagree. */}
          <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Topics this month{month ? ` · ${month.selected} of ${month.owed}${month.overflow > 0 ? ` · +${month.overflow} extra` : ""}` : ""}</div>
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
        <p className="mt-3 text-sm text-muted">No topics chosen for {monthLabel(d.monthKey)} yet.{d.planning?.monthKey === d.monthKey && d.planning.planningMode === "CALL" ? (d.planning.callStatus === "COMPLETED" ? " We're confirming them from your call." : " We'll choose them together on your call.") : null}</p>
      ) : null}
      <ComingUp d={d} href={href} />
    </Card>
  );
}
