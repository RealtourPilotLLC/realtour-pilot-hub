import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { waitedWords, type AttentionItem, type Dashboard, type DashboardHealth, type KyleDay, type Tone } from "@/lib/opsHome";
import type { DeliverableStage, JobRow } from "@/lib/jobsBoard";

// ---------------------------------------------------------------------------
// THE DASHBOARD'S PARTS (Oct 19 2026, night). Jordan: "The home page should
// really be a dashboard to oversee everything going on, and then the other
// pages are for more in-depth adjustments and changes. … I don't want to
// overload the users of this hub with analysis paralysis."
//
//   · the health strip: four tiles (On time, Clients waiting, Special
//     requests, QC & review), each a link to the screen that holds the work,
//     each green, amber or red;
//   · Shoots in progress: the first rows of the Shoots board, late first;
//   · Needs attention now: at most five lines, each with who owns it and one
//     action;
//   · Kyle's day ("Your list" for Kyle): done today and still open.
// Every number arrives computed (lib/opsHome.buildDashboard, kyleDay); these
// components only lay it out. Words speak to the reader ("you").
// ---------------------------------------------------------------------------

/** The screens this reader may open (a per-user override can take one away:
 *  canAccess). A tile or action whose screen is closed to them is shown
 *  without the link, never as a door that bounces. Default: all open. */
export type Doors = { review: boolean; ops: boolean; communications: boolean };
const ALL_DOORS: Doors = { review: true, ops: true, communications: true };
export function opens(href: string, doors: Doors = ALL_DOORS): boolean {
  if (href.startsWith("/review")) return doors.review;
  if (href.startsWith("/ops") || href.startsWith("/jobs")) return doors.ops;
  if (href.startsWith("/communications")) return doors.communications;
  return true;
}

const TONE_BAR: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-danger" };
const TONE_TEXT: Record<Tone, string> = { ok: "text-foreground", warn: "text-warning", bad: "text-danger" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Tile({ name, label, value, sub, tone, href }: { name: string; label: string; value: string | null; sub: string | null; tone: Tone | null; href: string | null }) {
  const body = (
    <>
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", tone ? TONE_BAR[tone] : "bg-border")} />
      <span className="text-[13px] font-medium text-muted">{label}</span>
      {value == null ? (
        <span className="mt-1 text-[13px] text-muted">Couldn&rsquo;t load. Open to check.</span>
      ) : (
        <>
          <span className={cn("mt-0.5 text-2xl font-semibold leading-tight tabular-nums", tone ? TONE_TEXT[tone] : "text-foreground")}>{value}</span>
          {sub && <span className="mt-0.5 text-[12px] leading-snug text-muted">{sub}</span>}
        </>
      )}
    </>
  );
  const box = "relative flex min-h-24 flex-col overflow-hidden rounded-xl border border-border bg-surface py-3 pr-3 pl-4";
  if (!href) return <div data-health={name} data-tone={tone ?? "unknown"} className={box}>{body}</div>;
  return (
    <Link href={href} data-health={name} data-tone={tone ?? "unknown"} className={cn(box, "hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-brand")}>
      {body}
    </Link>
  );
}

/** The four numbers that say whether we are delivering on time, answering
 *  clients, handling special requests and keeping QC and reviews moving. */
export function HealthStrip({ health, includeTest = false, doors = ALL_DOORS }: { health: DashboardHealth; includeTest?: boolean; doors?: Doors }) {
  const h = health;
  const href = (to: string) => (opens(to, doors) ? homeRecordHref(to, includeTest) : null);
  const o = h.onTime, m = h.clients, r = h.requests, q = h.qc;
  // The big number is what goes out next: videos ready to send (else what
  // could be read: cuts to review, photo sets in QC).
  const qcValue = !q ? null : q.readyToSend != null ? `${q.readyToSend} ready` : q.toReview != null ? `${q.toReview} to review` : `${q.photosInQc ?? 0} in QC`;
  return (
    <section id="health" aria-label="How we're doing right now" data-health-strip className="scroll-mt-32 md:scroll-mt-28">
      <span id="behind" aria-hidden className="block scroll-mt-32 md:scroll-mt-28" />
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <Tile
          name="on-time" label="On time" href={href("/jobs?f=late")} tone={o?.tone ?? null}
          value={o ? (o.late > 0 ? `${o.late} late` : "None late") : null}
          sub={o ? [
            `${o.dueToday} due today`,
            `${o.dueTomorrow} due tomorrow`,
            o.late > 0 && o.oldestLateDays != null ? `oldest ${plural(o.oldestLateDays, "day")}` : null,
          ].filter(Boolean).join(" · ") : null}
        />
        <Tile
          name="clients" label="Clients waiting" href={href("/communications")} tone={m?.tone ?? null}
          value={m ? String(m.waiting) : null}
          sub={m ? (m.waiting === 0 ? "nobody waiting on a reply" : [
            m.oldestHours != null ? `oldest ${waitedWords(m.oldestHours)}` : null,
            m.text === 0 ? "all email" : m.email === 0 ? "all text" : `${m.email} email, ${m.text} text`,
          ].filter(Boolean).join(" · ")) : null}
        />
        <Tile
          name="requests" label="Special requests" href={href("/jobs")} tone={r?.tone ?? null}
          value={r ? `${r.open} open` : null}
          sub={r ? (r.open === 0 ? "none open" : [
            r.shoots != null && r.shoots > 0 ? `on ${plural(r.shoots, "shoot")}` : null,
            r.needOwner == null ? null : r.needOwner > 0 ? `${r.needOwner} ${r.needOwner === 1 ? "needs" : "need"} an owner` : "each with an owner",
            r.behind > 0 ? `${r.behind} past due` : null,
          ].filter(Boolean).join(" · ")) : null}
        />
        <Tile
          name="qc" label="QC & review" href={href(q?.href ?? "/review")} tone={q?.tone ?? null}
          value={qcValue}
          sub={q ? [
            q.readyToSend == null ? "videos couldn't load" : `${plural(q.readyToSend, "video")} ready to send`,
            q.toReview == null ? null : `${plural(q.toReview, "cut")} to review`,
            q.photosInQc == null ? "photos couldn't load" : `${plural(q.photosInQc, "photo set")} in QC`,
            q.late > 0 ? `${q.late} late` : null,
          ].filter(Boolean).join(" · ") : null}
        />
      </div>
    </section>
  );
}

// ---- shoots in progress ---------------------------------------------------------------

const CHIP: Record<DeliverableStage["tone"], string> = {
  done: "bg-success/15 text-success",
  active: "bg-brand-soft text-brand",
  waiting: "bg-warning/15 text-warning",
  late: "bg-danger/15 text-danger",
  none: "bg-surface-2 text-muted",
};

function StageChip({ stage }: { stage: DeliverableStage | null }) {
  if (!stage) return <span className="text-[12px] text-muted-2">Not ordered</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium", CHIP[stage.tone])}>
      {stage.tone !== "none" && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />}
      {stage.label}
    </span>
  );
}

function RequestsChip({ r }: { r: JobRow["requests"] }) {
  if (r.open === 0) return <span className="text-[12px] text-muted-2">none</span>;
  const what = r.photo > 0 && r.video === 0 ? `${r.photo} photo` : r.video > 0 && r.photo === 0 ? `${r.video} video` : `${r.open} open`;
  return (
    <span className={cn("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium", r.needsOwner > 0 ? "bg-warning/15 text-warning" : "bg-brand-soft text-brand")}>
      {what}{r.needsOwner > 0 ? " · no owner" : ""}
    </span>
  );
}

function JobLine({ r, includeTest }: { r: JobRow; includeTest: boolean }) {
  return (
    <tr data-job={r.projectId} className={cn("border-b border-border last:border-0", r.monthly && "opacity-80")}>
      <td className="px-3 py-2 align-top">
        <Link href={homeRecordHref(`/projects/${r.projectId}`, includeTest)} className="block min-w-36 font-semibold leading-snug [overflow-wrap:anywhere] hover:text-brand">
          {r.street}
          {r.client && <span className="block text-[12px] font-normal text-muted">{r.client}</span>}
        </Link>
      </td>
      <td className={cn("whitespace-nowrap px-3 py-2 align-top tabular-nums", r.late ? "font-semibold text-danger" : r.dueToday ? "font-medium" : "text-muted")}>{r.dueWords}</td>
      <td className="px-3 py-2 align-top"><StageChip stage={r.photos} /></td>
      <td className="px-3 py-2 align-top"><StageChip stage={r.video} /></td>
      <td className="px-3 py-2 align-top"><RequestsChip r={r.requests} /></td>
    </tr>
  );
}

/** The first rows of the Shoots board (late first), each opening its job page. */
export function ShootsInProgress({ jobs, includeTest = false, doors = ALL_DOORS }: { jobs: Dashboard["jobs"]; includeTest?: boolean; doors?: Doors }) {
  const listing = jobs.rows.filter((r) => !r.monthly);
  const monthly = jobs.rows.filter((r) => r.monthly);
  const all = opens("/jobs", doors) ? homeRecordHref("/jobs", includeTest) : null;
  return (
    <section aria-labelledby="in-progress-title" data-shoots-in-progress className="panel-shadow min-w-0 overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 id="in-progress-title" className="text-[15px] font-semibold">Shoots in progress</h2>
        {!jobs.unavailable && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums">{jobs.total}</span>}
        {all && (
          <Link href={all} className="ml-auto inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">
            All shoots <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        )}
      </div>
      {jobs.unavailable ? (
        <p role="status" className="px-4 py-3 text-sm text-muted">The shoots couldn&rsquo;t load. Refresh, or open Shoots to check.</p>
      ) : jobs.rows.length === 0 ? (
        <p className="flex items-center gap-1.5 px-4 py-3 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> No shoots in progress.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-wide text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Shoot</th>
                <th scope="col" className="px-3 py-2 font-medium">Due</th>
                <th scope="col" className="px-3 py-2 font-medium">Photos</th>
                <th scope="col" className="px-3 py-2 font-medium">Video</th>
                <th scope="col" className="px-3 py-2 font-medium">Requests</th>
              </tr>
            </thead>
            <tbody>
              {listing.map((r) => <JobLine key={r.projectId} r={r} includeTest={includeTest} />)}
              {monthly.length > 0 && (
                <tr className="border-b border-border bg-surface-2/60">
                  <td colSpan={5} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Monthly content</td>
                </tr>
              )}
              {monthly.map((r) => <JobLine key={r.projectId} r={r} includeTest={includeTest} />)}
            </tbody>
          </table>
        </div>
      )}
      {all && !jobs.unavailable && jobs.total > jobs.rows.length && (
        <Link href={all} className="flex min-h-11 items-center justify-center gap-1 border-t border-border px-4 text-sm font-medium text-muted hover:bg-surface-2/60 hover:text-foreground">
          {jobs.total - jobs.rows.length} more on the Shoots page <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      )}
    </section>
  );
}

// ---- needs attention now ----------------------------------------------------------------

function AttentionRow({ item, includeTest, doors }: { item: AttentionItem; includeTest: boolean; doors: Doors }) {
  return (
    <li data-attention={item.key} className="flex items-start gap-3 py-2.5">
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", item.tone === "bad" ? "bg-danger" : "bg-warning")} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug [overflow-wrap:anywhere]"><strong className="font-semibold">{item.lead}</strong> {item.text}</p>
        <p className="mt-0.5 text-[12px] text-muted" data-owner>{item.owner}</p>
      </div>
      {opens(item.action.href, doors) && (
        <Link
          href={homeRecordHref(item.action.href, includeTest)}
          className={cn(
            "inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-[13px] font-semibold",
            item.tone === "bad" ? "bg-brand-action text-white hover:opacity-90" : "border border-border-strong hover:bg-surface-2",
          )}
        >
          {item.action.label}
        </Link>
      )}
    </li>
  );
}

/** At most five things, the most urgent first, each with who owns it and one action. */
export function NeedsAttention({ attention, includeTest = false, doors = ALL_DOORS }: { attention: Dashboard["attention"]; includeTest?: boolean; doors?: Doors }) {
  const { items, more, unavailable } = attention;
  return (
    <section id="needs-attention" aria-labelledby="needs-attention-title" data-needs-attention className="panel-shadow scroll-mt-32 rounded-2xl border border-border bg-surface px-4 pt-3 pb-1 md:scroll-mt-28">
      {/* Old links into the review desk and /ops's stuck jobs and exceptions land here. */}
      {["needs-you", "stuck", "exceptions"].map((id) => <span key={id} id={id} aria-hidden className="block scroll-mt-32 md:scroll-mt-28" />)}
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="needs-attention-title" className="text-[15px] font-semibold">Needs attention now</h2>
        {items.length > 0 && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums">{items.length}</span>}
      </div>
      {items.length === 0 ? (
        <p className="flex items-center gap-1.5 py-3 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Nothing needs you right now.</p>
      ) : (
        <ul className="divide-y divide-border">{items.map((i) => <AttentionRow key={i.key} item={i} includeTest={includeTest} doors={doors} />)}</ul>
      )}
      {more > 0 && <p className="border-t border-border py-2 text-[12px] text-muted">{more} more after these. Clear these first.</p>}
      {unavailable.length > 0 && (
        <p role="status" className="border-t border-border py-2 text-[12px] text-warning">Couldn&rsquo;t check {unavailable.join(", ")} just now. Refresh to try again.</p>
      )}
    </section>
  );
}

// ---- Kyle's day / your list ------------------------------------------------------------------

/** Done today and still open on Kyle's checklist; for Kyle himself, "Your list". */
export function KylesDayCard({ day, includeTest = false, doors = ALL_DOORS }: { day: KyleDay | null; includeTest?: boolean; doors?: Doors }) {
  if (!day) {
    return <p role="status" id="kyles-day" className="scroll-mt-32 rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">The daily checklist couldn&rsquo;t load. Refresh to try again.</p>;
  }
  const total = day.done + day.open;
  const pct = total === 0 ? 100 : Math.round((day.done / total) * 100);
  const title = day.you ? "Your list" : `${day.name}’s day`;
  return (
    <section id="kyles-day" aria-labelledby="kyles-day-title" data-kyles-day className="panel-shadow scroll-mt-32 rounded-2xl border border-border bg-surface md:scroll-mt-28">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <h2 id="kyles-day-title" className="text-[15px] font-semibold">{title}</h2>
        {opens(day.href, doors) && (
          <Link href={homeRecordHref(day.href, includeTest)} className="ml-auto inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand hover:underline">
            {day.you ? "Open your list" : `Open ${day.name}’s list`} <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
        <span className="tabular-nums"><strong className="font-semibold text-success">{day.done}</strong> done today</span>
        <span aria-hidden className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-2">
          <span className="block h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
        </span>
        <span className="tabular-nums"><strong className={cn("font-semibold", day.open > 0 ? "text-foreground" : "text-success")}>{day.open}</strong> still open</span>
      </div>
    </section>
  );
}
