import Link from "next/link";
import { AlertTriangle, ArrowRight, Camera, CheckCircle2, Flag, ListChecks, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import type { FlaggedItem } from "@/lib/queries";
import type { JobTile, OwnerWeek, VideoAlert } from "@/lib/opsHome";
import type { OldItem, OldPerson } from "@/lib/taskAging";
import { OLD_AFTER_DAYS, PUSHES_BEFORE_FLAG, WEEK_OLD_DAYS } from "@/lib/taskAging";
import { OldItemActions } from "@/components/home/OldItemActions";

// ---------------------------------------------------------------------------
// The pieces of the two simplified Homes (Oct 19 2026). Kyle: flagged items,
// the video banner, five job tiles, today's shoots in one line, old items,
// and one line to the checklist. Jordan: this week, what we're behind on, his
// own list, money. Every number here arrives computed (lib/opsHome,
// lib/taskAging); these components only lay it out.
// ---------------------------------------------------------------------------

const ET = "America/New_York";
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" });

/** "5h" / "3d" / "–" for a tile's oldest wait. */
export function ageShort(hours: number | null | undefined): string {
  if (hours == null) return "–";
  if (hours < 24) return `${Math.max(0, Math.round(hours))}h`;
  return `${Math.floor(hours / 24)}d`;
}

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

/** Red when we are very behind on listing videos, amber for one or two late. */
export function VideoBehindBanner({ alert }: { alert: VideoAlert | null }) {
  if (!alert) return null;
  const red = alert.level === "red";
  return (
    <Link
      href={alert.href}
      data-video-alert={alert.level}
      className={cn(
        "flex min-h-14 items-start gap-3 rounded-2xl border-2 px-4 py-3",
        red ? "border-danger/60 bg-danger/10 hover:bg-danger/15" : "border-warning/50 bg-warning/10 hover:bg-warning/15",
      )}
    >
      <AlertTriangle aria-hidden className={cn("mt-0.5 size-5 shrink-0", red ? "text-danger" : "text-warning")} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[15px] font-semibold leading-snug", red ? "text-danger" : "text-warning")}>{alert.headline}</span>
        <span className="mt-0.5 block text-sm text-foreground/80">{alert.detail}</span>
      </span>
      <span className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg bg-brand-action px-3 text-sm font-semibold text-white">
        Open <ArrowRight aria-hidden className="size-4" />
      </span>
    </Link>
  );
}

const TONE_TEXT: Record<JobTile["tone"], string> = { danger: "text-danger", warning: "text-warning", ok: "text-success", muted: "text-muted" };
const TONE_BORDER: Record<JobTile["tone"], string> = { danger: "border-danger/45", warning: "border-warning/45", ok: "border-border", muted: "border-border" };

/** The five jobs: due today, behind, oldest. Big and tappable; one column on a phone. */
export function JobTiles({ tiles, title = "Your five jobs" }: { tiles: JobTile[]; title?: string }) {
  return (
    <section aria-labelledby="job-tiles-title">
      <h2 id="job-tiles-title" className="px-1 pb-2 text-base font-semibold">{title}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <div key={t.key} data-tile={t.key} className={cn("panel-shadow flex flex-col rounded-2xl border bg-surface", TONE_BORDER[t.tone])}>
            <Link href={t.href} className="flex flex-1 flex-col gap-2 rounded-2xl p-4 hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-brand">
              <span className="flex items-center justify-between gap-2">
                <span className="text-[15px] font-semibold">{t.label}</span>
                <ArrowRight aria-hidden className="size-4 text-muted-2" />
              </span>
              {t.counts ? (
                <span className="grid grid-cols-3 gap-2 text-center">
                  <TileStat value={String(t.counts.dueToday)} label="due today" tone={t.counts.dueToday > 0 ? "text-warning" : "text-foreground"} />
                  <TileStat value={String(t.counts.behind)} label="behind" tone={t.counts.behind > 0 ? "text-danger" : "text-foreground"} />
                  <TileStat value={ageShort(t.counts.oldestHours)} label="oldest" tone="text-foreground" />
                </span>
              ) : (
                <span className="rounded-xl bg-surface-2/60 px-3 py-3 text-center text-sm text-muted">Not available right now</span>
              )}
              <span className={cn("text-sm leading-snug", TONE_TEXT[t.tone])}>{t.status}</span>
            </Link>
            {t.note && (
              <Link href={t.note.href} className="border-t border-border px-4 py-2 text-[13px] text-muted hover:text-foreground">
                {t.note.text} <ArrowRight aria-hidden className="inline size-3" />
              </Link>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function TileStat({ value, label, tone }: { value: string; label: string; tone: string }) {
  return (
    <span className="rounded-xl bg-surface-2/60 px-1 py-2">
      <span className={cn("block text-2xl font-semibold tabular-nums leading-none", tone)}>{value}</span>
      <span className="mt-1 block text-[11px] text-muted">{label}</span>
    </span>
  );
}

/** Today's shoots, as one line that opens the full cards on the checklist. */
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

/** Kyle's old items: the count, the oldest few with one-tap actions, and the full list. */
export function OldItemsCard({ items, total, minDay, maxDay, unavailable = false }: {
  items: OldItem[];
  total: number;
  minDay: string;
  maxDay: string;
  unavailable?: boolean;
}) {
  return (
    <section id="old-items" aria-labelledby="old-items-title" className="panel-shadow scroll-mt-32 rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="old-items-title" className="text-base font-semibold">
          Old items to clear: <span className={cn("tabular-nums", total > 0 ? "text-danger" : "text-success")}>{unavailable ? "?" : total}</span>
        </h2>
        {total > 0 && (
          <Link href="/ops/old" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">
            See all {total} <ArrowRight aria-hidden className="size-4" />
          </Link>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Open, assigned to you, and {OLD_AFTER_DAYS}+ days past their date. For each one: Done, Not needed, or pick a new date.
      </p>
      {unavailable ? (
        <p role="status" className="mt-3 text-sm text-warning">The old items could not be read. Open the full list to try again.</p>
      ) : total === 0 ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Nothing old on your plate.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {items.map((i) => <OldItemRow key={i.id} item={i} minDay={minDay} maxDay={maxDay} />)}
        </ul>
      )}
    </section>
  );
}

export function OldItemRow({ item, minDay, maxDay, showPerson = false }: { item: OldItem; minDay: string; maxDay: string; showPerson?: boolean }) {
  return (
    <li className="py-3" data-old-item={item.id}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <Link href={item.href} className="min-w-0 flex-1 basis-56 text-sm font-semibold leading-snug hover:text-brand">{item.title}</Link>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold", item.daysPast >= WEEK_OLD_DAYS ? "bg-danger/15 text-danger" : "bg-warning/15 text-warning")}>
          {item.daysPast} day{item.daysPast === 1 ? "" : "s"} past its date
        </span>
      </div>
      <p className="mt-0.5 text-[12px] text-muted">
        {item.kind}
        {showPerson ? ` · ${item.personName}` : ""}
        {item.projectTitle ? ` · ${item.projectTitle}` : ""}
        {item.dueISO ? ` · due ${fmtDay(item.dueISO)}` : ""}
        {item.pushedToISO ? ` · moved to ${fmtDay(item.pushedToISO)}` : ""}
        {item.pushes > 0 ? (
          <span className={cn(item.pushes >= PUSHES_BEFORE_FLAG - 1 && "font-semibold text-danger")}>
            {` · pushed ${item.pushes} time${item.pushes === 1 ? "" : "s"}`}{item.pushes === PUSHES_BEFORE_FLAG - 1 ? " (one more tells Jordan)" : ""}
          </span>
        ) : null}
      </p>
      <div className="mt-2">
        <OldItemActions taskId={item.id} minDay={minDay} maxDay={maxDay} />
      </div>
    </li>
  );
}

/** One line to the screens that moved off Home. */
export function ChecklistLinks({ includeTest = false }: { includeTest?: boolean }) {
  const q = includeTest ? "?test=1" : "";
  return (
    <nav aria-label="More operations" className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-surface px-3.5 py-1 text-sm">
      <ListChecks aria-hidden className="size-4 text-muted-2" />
      <Link href={`/ops${q}`} className="inline-flex min-h-11 items-center font-medium hover:text-brand">Daily checklist</Link>
      <Link href={`/ops${q}#exceptions`} className="inline-flex min-h-11 items-center text-muted hover:text-foreground">Exceptions</Link>
      <Link href={`/ops${q}#stuck`} className="inline-flex min-h-11 items-center text-muted hover:text-foreground">Stuck jobs</Link>
    </nav>
  );
}

// ---- The owner's week ------------------------------------------------------------

const pctText = (p: number | null) => (p == null ? "no promise to judge" : `${p}% on time`);

export function OwnerWeekCard({ week }: { week: OwnerWeek | null }) {
  if (!week) {
    return <p role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">This week&rsquo;s numbers couldn&rsquo;t load. Refresh to try again.</p>;
  }
  const t = week.thisWeek;
  const l = week.lastWeek;
  return (
    <section aria-labelledby="this-week-title" data-owner-week className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="this-week-title" className="text-base font-semibold">This week</h2>
        <p className="text-sm text-muted">Monday {fmtDay(week.startISO).replace(/^\w+, /, "")} to now · small text is last week by this time</p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <WeekStat label="Shoots done" value={String(t.shoots)} last={String(l.shoots)} />
        <WeekStat label="Photo jobs delivered" value={String(t.photos.delivered)} sub={pctText(t.photos.onTimePct)} last={`${l.photos.delivered}, ${pctText(l.photos.onTimePct)}`} bad={t.photos.onTimePct != null && t.photos.onTimePct < 80} />
        <WeekStat label="Listing videos delivered" value={String(t.listingVideos.delivered)} sub={pctText(t.listingVideos.onTimePct)} last={`${l.listingVideos.delivered}, ${pctText(l.listingVideos.onTimePct)}`} bad={t.listingVideos.onTimePct != null && t.listingVideos.onTimePct < 80} />
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

/** The owner's "what we're behind on": each job's behind number, team-wide, and the old items. */
export function BehindCard({ tiles, people, oldTotal, unavailableOld = false }: { tiles: JobTile[]; people: OldPerson[]; oldTotal: number; unavailableOld?: boolean }) {
  const weekOld = people.filter((p) => p.weekOld > 0);
  const pushed = people.reduce((n, p) => n + p.pushedOften, 0);
  return (
    <section aria-labelledby="behind-title" data-owner-behind className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <h2 id="behind-title" className="text-base font-semibold">What we&rsquo;re behind on</h2>
      <ul className="mt-2 divide-y divide-border">
        {tiles.map((t) => (
          <li key={t.key}>
            <Link href={t.href} className="-mx-2 flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2/60">
              <span className={cn("w-10 shrink-0 text-right text-lg font-semibold tabular-nums", t.counts ? (t.counts.behind > 0 ? "text-danger" : "text-success") : "text-muted")}>
                {t.counts ? t.counts.behind : "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{t.label}</span>
                <span className="block text-[12px] text-muted">{t.status}</span>
              </span>
              <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-2" />
            </Link>
          </li>
        ))}
        <li>
          <Link href="/ops/old?who=all" className="-mx-2 flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2/60">
            <span className={cn("w-10 shrink-0 text-right text-lg font-semibold tabular-nums", oldTotal > 0 ? "text-danger" : "text-success")}>{unavailableOld ? "?" : oldTotal}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Old items ({OLD_AFTER_DAYS}+ days past their date)</span>
              <span className="block text-[12px] text-muted">
                {unavailableOld
                  ? "Couldn't load. Open the list to check."
                  : weekOld.length === 0
                    ? "Nothing over a week old."
                    : weekOld.map((p) => `${p.name} has ${p.weekOld} over a week old`).join(" · ")}
                {pushed > 0 ? ` · ${pushed} pushed ${PUSHES_BEFORE_FLAG}+ times` : ""}
              </span>
            </span>
            <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-2" />
          </Link>
        </li>
      </ul>
    </section>
  );
}
