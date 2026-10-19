import Link from "next/link";
import { ArrowRight, Camera, CheckCircle2, Flag, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import type { FlaggedItem } from "@/lib/queries";
import { onTimeWords, ON_TIME_MIN_JOBS, type HomeSummary, type OwnerWeek } from "@/lib/opsHome";
import type { OldPerson } from "@/lib/taskAging";
import { OLD_AFTER_DAYS, PUSHES_BEFORE_FLAG } from "@/lib/taskAging";
import type { BehindState } from "@/lib/behindAlert";
import type { ShootIssue } from "@/lib/shootIssues";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { SummaryBox } from "@/components/home/Checklist";

// ---------------------------------------------------------------------------
// The pieces the Homes share (Oct 19 2026): the flagged-for-you banner (every
// Home), today's shoots in one line (the review seat's Home), and Jordan's
// sections: this week, what we're behind on, shoot issues. Every number arrives computed (lib/opsHome,
// lib/taskAging, lib/behindAlert, lib/shootIssues); these only lay it out.
// ---------------------------------------------------------------------------

const ET = "America/New_York";
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" });

/** Flags a PERSON raised for this viewer, above everything. */
export function FlaggedBanner({ flagged }: { flagged: FlaggedItem[] }) {
  if (flagged.length === 0) return null;
  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border-2 border-danger/45 bg-danger-soft/40">
      <div className="flex items-center gap-2 border-b border-danger/25 px-5 py-2.5">
        <Flag aria-hidden className="size-4 text-danger" />
        <h2 className="text-[15px] font-semibold text-danger">
          Flagged by {[...new Set(flagged.map((f) => f.flaggedBy.split(" ")[0]))].join(" & ")}: look at these first
        </h2>
        <span className="ml-auto rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-danger">{flagged.length}</span>
      </div>
      <ul className="divide-y divide-danger/15">
        {flagged.map((f) => (
          <li key={f.taskId}>
            <Link href={f.href} className="block px-5 py-3 hover:bg-danger/[0.06]">
              <p className="text-sm font-semibold leading-snug">{f.title}</p>
              {f.note && <p className="mt-0.5 whitespace-pre-line text-[13px] leading-relaxed text-foreground/80">{f.note}</p>}
              <p className="mt-1 text-[11px] text-muted">
                {f.flaggedBy} · {etDateTime(f.flaggedAtISO)}
                {f.projectTitle ? ` · ${f.projectTitle}` : ""} · open it
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Today's shoots, as one line that opens the full cards on /ops. */
export function ShootsTodayLine({ count, next, untimed, rush, href }: {
  count: number;
  next: { timeISO: string | null; street: string; photographer: string | null } | null;
  untimed: string[];
  rush: number;
  href: string;
}) {
  return (
    <Link href={href} className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm hover:bg-surface-2/60">
      <Camera aria-hidden className="size-4 shrink-0 text-muted-2" />
      <span className="min-w-0 flex-1">
        {count === 0 ? (
          <span className="text-muted">No shoots on today&rsquo;s calendar.</span>
        ) : (
          <>
            <span className="font-semibold">{count} shoot{count === 1 ? "" : "s"} today</span>
            {next ? (
              <span className="text-muted"> · next {next.timeISO ? `${fmtTime(next.timeISO)} ET` : "time to confirm"}, {next.street} · {next.photographer ?? "unassigned"}</span>
            ) : untimed.length > 0 ? (
              <span className="text-warning" data-untimed-shoots> · {untimed.length === 1 ? `${untimed[0]} has no time set` : `${untimed.length} have no time set`}</span>
            ) : (
              <span className="text-muted"> · all started</span>
            )}
          </>
        )}
      </span>
      {rush > 0 && (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-danger px-1.5 text-[10px] font-bold tabular-nums text-white" title="Shoots promised same-day photos or floor plan">
          <Zap aria-hidden className="size-2.5" /> {rush} same-day
        </span>
      )}
      <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-2" />
    </Link>
  );
}

// ---- The owner's week ------------------------------------------------------------

export function OwnerWeekCard({ week }: { week: OwnerWeek | null }) {
  if (!week) {
    return <p role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">This week&rsquo;s numbers couldn&rsquo;t load. Refresh to try again.</p>;
  }
  const t = week.thisWeek;
  const l = week.lastWeek;
  // A percentage of one or two jobs reads as a verdict it is not (Oct 19):
  // shown from ON_TIME_MIN_JOBS jobs judged, "too few to judge" before.
  const judged = (s: { judged: number; onTimePct: number | null }) => s.judged >= ON_TIME_MIN_JOBS && s.onTimePct != null;
  return (
    <section aria-labelledby="this-week-title" data-owner-week className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="this-week-title" className="text-base font-semibold">This week</h2>
        <p className="text-sm text-muted">Monday {fmtDay(week.startISO).replace(/^\w+, /, "")} to now · small text is last week by this time</p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <WeekStat label="Shoots done" value={String(t.shoots)} last={String(l.shoots)} />
        <WeekStat label="Photo jobs delivered" value={String(t.photos.delivered)} sub={onTimeWords(t.photos)} last={`${l.photos.delivered}, ${onTimeWords(l.photos)}`} bad={judged(t.photos) && t.photos.onTimePct! < 80} />
        <WeekStat label="Listing videos delivered" value={String(t.listingVideos.delivered)} sub={onTimeWords(t.listingVideos)} last={`${l.listingVideos.delivered}, ${onTimeWords(l.listingVideos)}`} bad={judged(t.listingVideos) && t.listingVideos.onTimePct! < 80} />
        <WeekStat label="Monthly videos delivered" value={String(t.monthlyVideos)} last={String(l.monthlyVideos)} />
        <WeekStat label="Client texts answered in 1 hour" value={t.replies.fastPct == null ? "–" : `${t.replies.fastPct}%`} sub={`${t.replies.fast} of ${t.replies.inbound}`} last={l.replies.fastPct == null ? "–" : `${l.replies.fastPct}%`} bad={t.replies.fastPct != null && t.replies.fastPct < 70} />
        <WeekStat label="Revisions asked for" value={String(t.revisions)} last={String(l.revisions)} />
      </div>
    </section>
  );
}

function WeekStat({ label, value, sub, last, bad }: { label: string; value: string; sub?: string; last: string; bad?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={cn("mt-0.5 text-2xl font-semibold tabular-nums", bad && "text-danger")}>{value}</div>
      {sub && <div className={cn("text-[12px]", bad ? "text-danger" : "text-muted")}>{sub}</div>}
      <div className="mt-1 text-[11px] text-muted-2">last week: {last}</div>
    </div>
  );
}

/** The owner's "What we're behind on": the team's red line, the same three
 *  numbers as Kyle's box (they are team-wide already), and the old items. */
export function BehindCard({ state, summary, people, includeTest = false }: {
  state: BehindState | null;
  summary: HomeSummary | null;
  /** everyone's old items (3+ days past their date); null = could not load */
  people: OldPerson[] | null;
  includeTest?: boolean;
}) {
  const withOld = (people ?? []).filter((p) => p.total > 0);
  const pushed = (people ?? []).reduce((n, p) => n + p.pushedOften, 0);
  return (
    <section id="behind" aria-labelledby="behind-title" data-owner-behind className="panel-shadow scroll-mt-32 space-y-3 rounded-2xl border border-border bg-surface p-4 sm:p-5 md:scroll-mt-28">
      <h2 id="behind-title" className="text-base font-semibold">What we&rsquo;re behind on</h2>
      {!state ? (
        <p role="status" className="text-sm text-muted">Whether we&rsquo;re behind couldn&rsquo;t be checked. Refresh to try again.</p>
      ) : state.level === "ok" ? (
        <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Nothing is past its promise.</p>
      ) : (
        <p data-behind={state.level} className="rounded-xl border-2 border-danger/50 bg-danger/10 px-3 py-2 text-[15px] font-semibold text-danger">
          {state.headline ?? `${state.videosLate} video${state.videosLate === 1 ? "" : "s"} and ${state.photosLate} photo job${state.photosLate === 1 ? "" : "s"} late.`}
        </p>
      )}
      {summary ? <SummaryBox summary={summary} includeTest={includeTest} title="Across the team, right now" /> : <p role="status" className="text-sm text-muted">The delivery and message numbers couldn&rsquo;t load.</p>}
      <p className="text-sm">
        <span className="font-medium">Old items ({OLD_AFTER_DAYS}+ days past their date):</span>{" "}
        <span className="text-muted">
          {people == null
            ? "couldn't load."
            : withOld.length === 0
              ? "none."
              : withOld.map((p) => `${p.name} ${p.total}${p.weekOld > 0 ? ` (${p.weekOld} over a week)` : ""}`).join(" · ")}
          {pushed > 0 ? ` · ${pushed} pushed ${PUSHES_BEFORE_FLAG}+ times` : ""}
        </span>
      </p>
      <Link href={homeRecordHref("/ops", includeTest)} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">
        Today&rsquo;s shoots, stuck jobs and exceptions <ArrowRight aria-hidden className="size-4" />
      </Link>
    </section>
  );
}

/** What keeps happening at shoots: the creatives' flags that only Jordan gets. */
export function ShootIssuesCard({ issues }: { issues: { open: ShootIssue[]; byClient: { client: string; count: number }[] } | null }) {
  if (!issues) {
    return <p role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">Shoot issues couldn&rsquo;t load. Refresh to try again.</p>;
  }
  const repeats = issues.byClient.filter((c) => c.count >= 2);
  return (
    <section aria-labelledby="shoot-issues-title" data-shoot-issues className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="shoot-issues-title" className="text-base font-semibold">Shoot issues</h2>
        <p className="text-sm text-muted">{issues.open.length} open</p>
      </div>
      {issues.open.length === 0 ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> No shoot issues open.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {issues.open.map((i) => (
            <li key={i.id} className="py-2.5">
              <Link href={i.href} className="text-sm font-semibold leading-snug [overflow-wrap:anywhere] hover:text-brand">{i.text}</Link>
              <p className="mt-0.5 text-[12px] text-muted">{[i.client, i.street, i.by, etDateTime(i.atISO)].filter(Boolean).join(" · ")}</p>
            </li>
          ))}
        </ul>
      )}
      {repeats.length > 0 && (
        <p className="mt-2 text-sm"><span className="font-medium">Keeps happening:</span> <span className="text-muted">{repeats.map((c) => `${c.client} ${c.count} times`).join(" · ")}</span></p>
      )}
    </section>
  );
}
