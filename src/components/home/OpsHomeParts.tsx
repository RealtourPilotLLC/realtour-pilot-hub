import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { onTimeWords, ON_TIME_MIN_JOBS, type OwnerWeek } from "@/lib/opsHome";
import type { ShootIssue } from "@/lib/shootIssues";

// ---------------------------------------------------------------------------
// The dashboard's shared pieces (Oct 19 2026), the owner's: this week, shoot
// issues. Every number arrives computed (lib/opsHome, lib/shootIssues); these
// only lay it out. (The flagged-for-you banner left with Oct 19's "flags show
// on the shoot itself" and was removed Oct 20, audit A19.)
// ---------------------------------------------------------------------------

const ET = "America/New_York";
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" });

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
