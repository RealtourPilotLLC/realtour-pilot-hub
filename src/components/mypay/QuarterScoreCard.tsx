import Link from "next/link";
import { Trophy, Info, TrendingDown, CircleDashed, Check, ChevronRight, CalendarCheck, MessageSquareWarning } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime, etDate } from "@/lib/datetime";
import type { KpiEntry, KpiScorecard } from "@/lib/kpi";
import { CheckInForm, DeadlineForm, DisputeButton, RemoveNoteButton, ResolveControls } from "@/components/finance/KpiControls";

// ---------------------------------------------------------------------------
// THE KPI SCORECARD (Oct 22 2026, rebuilt around the compensation terms).
//
// One card, three readers:
//   · "self": the creative on My Performance. Their own card only: every
//     category, weight, target, the period, what was measured, the evidence,
//     the score, what each entry costs, and a Dispute button on each entry.
//     The bonus they are tracking (earned and possible) shows; no pay does.
//   · "owner": Jordan on Finance → Bonus. The same card, plus resolving
//     disputes, notes, the monthly check-in and agreed deadlines.
//   · "preview": a read-only copy (the owner's "view as" pay page).
// Everything here is stated, never implied: a score with an invisible
// denominator is a score nobody trusts, and a bonus nobody trusts does not
// change behaviour.
// ---------------------------------------------------------------------------

export type Viewer = "self" | "owner" | "preview";
export type PeriodSummary = { key: string; label: string; score: number | null; bonus: number; showDollars: boolean; note?: string | null };

const usd0 = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const keyDate = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const STATUS: Record<KpiEntry["status"], { label: string; tone: string }> = {
  counts: { label: "Counts", tone: "bg-danger/10 text-danger" },
  disputed: { label: "Disputed", tone: "bg-warning-soft text-warning" },
  upheld: { label: "Upheld", tone: "bg-danger/10 text-danger" },
  removed: { label: "Removed", tone: "bg-success/10 text-success" },
  advisory: { label: "Needs review, not counted", tone: "bg-warning-soft text-warning" },
  not_counted: { label: "Not counted", tone: "bg-surface-2 text-muted" },
};

function statusOf(e: KpiEntry, viewer: Viewer) {
  const s = STATUS[e.status];
  if (e.status === "counts" && e.effect === "for") return { label: "Counts for you", tone: "bg-success/10 text-success" };
  if (e.status === "counts" && e.effect === "neutral") return { label: "Counts", tone: "bg-surface-2 text-muted" };
  if (e.status === "disputed" && viewer === "self") return { label: "Disputed, waiting on Jordan", tone: s.tone };
  return s;
}

function Bar({ points, maxPoints }: { points: number; maxPoints: number }) {
  const frac = maxPoints > 0 ? points / maxPoints : 0;
  const tone = frac >= 0.85 ? "bg-success" : frac >= 0.5 ? "bg-warning" : "bg-danger";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.max(2, Math.round(frac * 100))}%` }} />
    </div>
  );
}

function entryHref(e: KpiEntry, viewer: Viewer): string | null {
  if (!e.projectId) return null;
  if (viewer === "owner") return `/projects/${e.projectId}`;
  if (e.kind === "late_photos" || e.kind === "late_video" || e.kind === "instructions") return `/upload/${e.projectId}`;
  return null;
}

/** "2026-10-21T13:00:00.000Z" → "2026-10-21T09:00" in Eastern time, for the datetime box. */
function etLocalInput(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${v("year")}-${v("month")}-${v("day")}T${v("hour")}:${v("minute")}`;
}

function EntryRow({ e, card, viewer }: { e: KpiEntry; card: KpiScorecard; viewer: Viewer }) {
  const st = statusOf(e, viewer);
  const href = entryHref(e, viewer);
  const canDispute = viewer === "self" && (e.status === "counts" || e.status === "advisory") && e.effect !== "for";
  const canResolve = viewer === "owner" && e.status !== "not_counted";
  const late = e.kind === "late_photos" || e.kind === "late_video";
  return (
    <li className="space-y-1 px-4 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 text-sm font-medium">
          {href ? <Link href={href} className="hover:underline">{e.title}</Link> : e.title}
          <div className="text-[11px] font-normal text-muted-2">
            {keyDate(e.day)}{e.auto ? "" : " · Jordan's note"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", st.tone)}>{st.label}</span>
          {e.impact != null && Math.abs(e.impact) >= 0.1 && (
            <span className={cn("text-xs font-semibold tabular-nums", e.counts ? (e.impact < 0 ? "text-danger" : "text-success") : "text-muted-2")}>
              {e.counts ? "" : "would be "}{e.impact > 0 ? "+" : "−"}{Math.abs(e.impact).toFixed(1)} pts
            </span>
          )}
        </div>
      </div>
      <ul className="space-y-0.5">
        {e.detail.map((d, i) => (
          <li key={i} className="text-[11px] leading-relaxed text-muted">{d}</li>
        ))}
      </ul>
      {e.dispute && (
        <p className="rounded-lg bg-warning-soft/50 px-2.5 py-1.5 text-[11px] text-foreground">
          <span className="font-semibold">{viewer === "self" ? "Your dispute" : `${e.dispute.by}'s dispute`}</span> ({etDateTime(e.dispute.at)}): {e.dispute.note}
        </p>
      )}
      {e.resolution && (
        <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-[11px]">
          <span className="font-semibold">{e.resolution.by} {e.resolution.outcome === "removed" ? "removed it" : e.advisory ? "counted it" : "kept it"}</span> ({etDateTime(e.resolution.at)}): {e.resolution.reason}
        </p>
      )}
      {(canDispute || canResolve) && (
        <div className="flex flex-wrap items-start gap-2 pt-1">
          {canDispute && <DisputeButton periodKey={card.period.key} entryId={e.id} />}
          {canResolve && <ResolveControls memberId={card.memberId} periodKey={card.period.key} entryId={e.id} status={e.status} advisory={e.advisory} />}
          {viewer === "owner" && e.kind === "manual" && <RemoveNoteButton memberId={card.memberId} periodKey={card.period.key} entryId={e.id} />}
          {viewer === "owner" && late && e.projectId && (
            <DeadlineForm projectId={e.projectId} half={e.kind === "late_photos" ? "photos" : "video"} current={etLocalInput(e.at)} note="" />
          )}
        </div>
      )}
    </li>
  );
}

function CategoryBlock({ c, card, viewer }: { c: KpiScorecard["categories"][number]; card: KpiScorecard; viewer: Viewer }) {
  const scored = c.measured && c.maxPoints > 0;
  const lost = scored ? c.maxPoints - c.points : 0;
  const scoring = c.entries.filter((e) => e.status !== "not_counted");
  const counting = scoring.filter((e) => e.counts).length;
  return (
    <div className={cn("px-4 py-3", !c.measured && "bg-surface-2/40")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {c.measured ? <Check className="size-3.5 shrink-0 text-success" /> : <CircleDashed className="size-3.5 shrink-0 text-muted-2" />}
            <span>{c.label}</span>
            <span className="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] font-semibold text-muted-2">
              {c.weight == null ? "weight not set" : `weight ${c.weight}`}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-2">{c.covers}</p>
        </div>
        <div className="shrink-0 text-right">
          {scored ? (
            <>
              <div className="text-sm font-semibold tabular-nums">
                {c.points}
                <span className="text-[11px] font-normal text-muted-2"> / {c.maxPoints}</span>
              </div>
              {lost >= 0.1 && <div className="text-[10px] font-medium text-danger">−{lost.toFixed(1)} pts</div>}
            </>
          ) : (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-2">
              {c.measured ? `${Math.round((c.fraction ?? 0) * 100)} of 100` : "Not measured"}
            </span>
          )}
        </div>
      </div>
      {scored && <div className="mt-2"><Bar points={c.points} maxPoints={c.maxPoints} /></div>}
      <dl className="mt-2 grid gap-x-3 gap-y-1 text-[11px] sm:grid-cols-[6.5rem_1fr]">
        <dt className="font-semibold text-muted">Measured</dt>
        <dd className="text-foreground">{c.measured ? c.actual : c.why ?? c.actual}</dd>
        <dt className="font-semibold text-muted">Target</dt>
        <dd className="text-muted">{c.target}</dd>
        <dt className="font-semibold text-muted">Evidence</dt>
        <dd className="text-muted">{c.evidence}</dd>
        {c.unseen && (
          <>
            <dt className="font-semibold text-muted">Not in the hub</dt>
            <dd className="text-muted">{c.unseen}</dd>
          </>
        )}
        <dt className="font-semibold text-muted">Review</dt>
        <dd className="text-muted">
          {scoring.length === 0 ? "No entries." : `${counting} of ${scoring.length} entr${scoring.length === 1 ? "y counts" : "ies count"}`}
          {c.openDisputes > 0 && <span className="font-semibold text-warning"> · {c.openDisputes} disputed</span>}
        </dd>
      </dl>
      {c.notes.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {c.notes.map((nt) => (
            <li key={nt} className="flex gap-1.5 text-[11px] leading-relaxed text-muted-2">
              <span aria-hidden className="mt-[5px] size-1 shrink-0 rounded-full bg-border-strong" />
              <span>{nt}</span>
            </li>
          ))}
        </ul>
      )}
      {scoring.length > 0 && (
        <details className="mt-2 rounded-lg border border-border" open={viewer === "owner" ? c.openDisputes > 0 : false}>
          <summary className="flex min-h-9 cursor-pointer items-center px-3 text-xs font-semibold text-brand">
            Entries ({scoring.length})
          </summary>
          <ul className="divide-y divide-border/60 border-t border-border">
            {scoring.map((e) => <EntryRow key={e.id} e={e} card={card} viewer={viewer} />)}
          </ul>
        </details>
      )}
    </div>
  );
}

export function QuarterScoreCard({ card, viewer = "self", previous }: { card: KpiScorecard; viewer?: Viewer; previous?: PeriodSummary | null }) {
  const shown = card.score == null ? null : Math.round(card.score);
  const dark = card.categories.filter((c) => !c.measured);
  const dragging = card.categories.filter((c) => c.measured && c.maxPoints - c.points >= 1).sort((a, b) => b.maxPoints - b.points - (a.maxPoints - a.points));
  const context = card.entries.filter((e) => e.status === "not_counted");
  const checkInAreas = card.terms.categories.filter((c) => c.checkIn).map((c) => ({ key: c.areas[0], label: c.label }));
  const startedMonths = card.months.filter((m) => m.started);

  return (
    <div className="panel-shadow overflow-hidden rounded-2xl border border-border bg-surface">
      {/* Headline: the score, the band, and what the band is worth today. */}
      <div className="border-b border-border bg-brand/[0.04] px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <Trophy className="size-3.5 text-brand" /> KPI scorecard · {card.period.label}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-2">{card.terms.role}</div>
            {shown == null ? (
              <>
                <div className="mt-1 text-2xl font-bold text-muted">No score yet</div>
                <p className="mt-0.5 max-w-md text-[11px] text-muted-2">{card.thinReason}</p>
              </>
            ) : (
              <>
                <div className="mt-0.5 flex items-baseline gap-1.5">
                  <span className="text-4xl font-bold tabular-nums text-brand">{shown}</span>
                  <span className="text-sm font-medium text-muted-2">/ 100</span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-2">
                  {card.shoots} shoot{card.shoots === 1 ? "" : "s"} ·{" "}
                  {card.provisional ? `${Math.round(card.elapsed * 100)}% through the period, so this still moves` : "period closed"}
                </div>
              </>
            )}
          </div>
          <div className="text-right">
            <div className="text-[11px] text-muted">{card.provisional ? "Worth today" : "Earned"}</div>
            <div className={cn("text-2xl font-bold tabular-nums", card.bonus > 0 ? "text-success" : "text-muted-2")}>
              {shown == null ? "None yet" : usd0(card.bonus)}
            </div>
            <div className="text-[11px] text-muted-2">of {usd0(card.possible)} possible{shown != null && card.band ? ` · ${card.band.label}` : ""}</div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {[...card.terms.bands].reverse().map((b) => {
            const here = card.band?.min === b.min && shown != null;
            const nextUp = card.next?.band.min === b.min;
            return (
              <div key={b.min} className={cn("rounded-lg border px-2 py-1.5 text-center", here ? "border-brand bg-brand-action text-white" : nextUp ? "border-brand/40 bg-surface" : "border-border bg-surface")}>
                <div className={cn("text-[10px] font-medium", here ? "text-white/80" : "text-muted-2")}>{b.short}</div>
                <div className={cn("text-xs font-bold tabular-nums", !here && b.amount > 0 && "text-success", !here && b.amount === 0 && "text-muted-2")}>
                  {b.amount === 0 ? "nothing" : usd0(b.amount)}
                </div>
              </div>
            );
          })}
        </div>
        {card.next && shown != null && (
          <p className="mt-2 flex items-center gap-1 text-[11px] font-medium text-brand">
            <ChevronRight className="size-3.5" />
            {card.next.pointsAway} more point{card.next.pointsAway === 1 ? "" : "s"} takes you to {card.next.band.label}: {card.next.band.amount ? usd0(card.next.band.amount) : "nothing"}.
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted-2">
          Measurement period {keyDate(card.period.startKey)} to {keyDate(card.period.endKey)}, Eastern time. Reviewed monthly; settled
          within 30 days after it closes (by {keyDate(card.period.settleByKey)}). The bonus is not guaranteed.
          {card.terms.version ? ` Weights and bands as changed from ${card.terms.version.fromPeriodKey}${card.terms.version.note ? `: ${card.terms.version.note}` : ""}.` : ""}
        </p>
      </div>

      {/* HONESTY LINE: the denominator is never hidden. */}
      <div className="flex items-start gap-2 border-b border-border bg-warning-soft/40 px-4 py-2.5">
        <Info className="mt-px size-3.5 shrink-0 text-warning" />
        <p className="text-[11px] leading-relaxed text-muted">
          {shown == null ? (
            <>
              {card.measuredWeight} of the 100 points can be measured for this period so far, too little to put a score on.
            </>
          ) : (
            <>
              Scored on <span className="font-semibold text-foreground">{card.categories.length - dark.length} of {card.categories.length} categories</span>, the{" "}
              {card.measuredWeight} points that can be measured so far, scaled to a full 100.
            </>
          )}{" "}
          {dark.length > 0 && (
            <>
              {dark.map((a) => a.label).join(", ")} {dark.length === 1 ? "is" : "are"} left out until there is enough to judge, so{" "}
              {dark.length === 1 ? "it" : "they"} can neither help nor hurt yet.
            </>
          )}
          {card.openDisputes > 0 && <> {card.openDisputes} entr{card.openDisputes === 1 ? "y is" : "ies are"} disputed and still count until Jordan decides.</>}
        </p>
      </div>

      {shown != null && dragging.length > 0 && (
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <TrendingDown className="size-3.5 text-danger" /> What is pulling the score down
          </div>
          <ul className="mt-1.5 space-y-1">
            {dragging.map((c) => (
              <li key={c.key} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{c.label}</span>
                  <span className="text-[11px] text-muted-2"> · {c.actual}</span>
                </span>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-danger">−{(c.maxPoints - c.points).toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Every category: weight, target, what was measured, evidence, score, entries. */}
      <div className="divide-y divide-border/60">
        {card.categories.map((c) => (
          <CategoryBlock key={c.key} c={c} card={card} viewer={viewer} />
        ))}
      </div>

      {/* MONTHLY CHECK-IN: the period month by month, so the end is never a surprise. */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
          <CalendarCheck className="size-3.5 text-brand" /> Monthly check-in
        </div>
        <ul className="mt-2 space-y-2">
          {card.months.map((m) => (
            <li key={m.month.key} className={cn("rounded-lg border border-border px-3 py-2", !m.started && "opacity-50")}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{m.month.label}</span>
                {m.started ? (
                  <span className="text-[11px] text-muted">
                    Period so far: {m.scoreToDate == null ? "no score yet" : <span className="font-semibold text-foreground">{Math.round(m.scoreToDate)}</span>}
                    {m.scoreToDate != null && m.bonusToDate != null ? ` (${usd0(m.bonusToDate)})` : ""}
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-2">not started</span>
                )}
              </div>
              {m.started && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
                  <span>{m.shoots} shoot{m.shoots === 1 ? "" : "s"}</span>
                  <span>{m.uploadsDue - m.late} of {m.uploadsDue} uploads on time</span>
                  {m.videoHandoffs > 0 && <span>instructions complete {m.videoHandoffs - m.instructionsMissing} of {m.videoHandoffs}</span>}
                  <span>{m.fixes} fix{m.fixes === 1 ? "" : "es"}</span>
                  {m.overBudget > 0 && <span>{m.overBudget} over the raw budget</span>}
                  <span>{m.ratings.n ? `client ${m.ratings.avg!.toFixed(1)} of 5 (${m.ratings.n})` : "no client ratings"}</span>
                  {checkInAreas.map((a) => {
                    const v = m.checkIn?.scores[a.key];
                    return <span key={a.key}>{a.label}: {typeof v === "number" ? v : "not checked in"}</span>;
                  })}
                </div>
              )}
              {m.checkIn?.note && <p className="mt-1 text-[11px] leading-relaxed text-foreground">&ldquo;{m.checkIn.note}&rdquo; <span className="text-muted-2">{m.checkIn.by}, {etDate(m.checkIn.at)}</span></p>}
            </li>
          ))}
        </ul>
        {viewer === "owner" && card.checkInGaps.length > 0 && (
          <p className="mt-2 text-[11px] text-warning">Missing: {card.checkInGaps.join("; ")}.</p>
        )}
      </div>

      {context.length > 0 && (
        <details className="border-t border-border">
          <summary className="flex min-h-9 cursor-pointer items-center px-4 text-xs font-semibold text-muted">
            Not counted, for context ({context.length})
          </summary>
          <ul className="divide-y divide-border/60 border-t border-border">
            {context.map((e) => <EntryRow key={e.id} e={e} card={card} viewer={viewer} />)}
          </ul>
        </details>
      )}

      {viewer === "owner" && (
        <div className="space-y-3 border-t border-border bg-surface-2/30 px-4 py-3">
          <details>
            <summary className="flex min-h-9 cursor-pointer items-center text-xs font-semibold text-brand">Monthly check-in scores and note</summary>
            <div className="pt-2">
              <CheckInForm
                memberId={card.memberId}
                periodKey={card.period.key}
                months={startedMonths.map((m) => ({ key: m.month.key, label: m.month.label }))}
                areas={checkInAreas}
                saved={Object.fromEntries(card.months.filter((m) => m.checkIn).map((m) => [m.month.key, { scores: m.checkIn!.scores as Record<string, number>, note: m.checkIn!.note }]))}
              />
            </div>
          </details>
          <p className="text-[11px] text-muted">To add, edit or remove an entry by hand, use &ldquo;Entries added by hand&rdquo; at the top of this tab.</p>
          {card.log.length > 0 && (
            <details>
              <summary className="flex min-h-9 cursor-pointer items-center text-xs font-semibold text-muted">Review history ({card.log.length})</summary>
              <ul className="space-y-0.5 pt-1">
                {[...card.log].reverse().slice(0, 30).map((l, i) => (
                  <li key={i} className="text-[11px] text-muted">{etDateTime(l.at)} · {l.by}: {l.what}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {previous && (
        <div className="flex items-center gap-3 border-t border-border bg-surface-2/40 px-4 py-2.5 text-sm">
          <span className="shrink-0 text-muted">{previous.label}</span>
          {previous.note && <span className="min-w-0 text-[11px] text-muted-2">{previous.note}</span>}
          {previous.score == null ? (
            <span className="ml-auto shrink-0 text-[11px] text-muted-2">No score</span>
          ) : (
            <>
              <span className="ml-auto shrink-0 font-semibold tabular-nums">{Math.round(previous.score)}</span>
              {previous.showDollars && (
                <span className={cn("w-16 shrink-0 text-right text-xs font-semibold", previous.bonus > 0 ? "text-success" : "text-muted-2")}>
                  {previous.bonus > 0 ? usd0(previous.bonus) : "nothing"}
                </span>
              )}
            </>
          )}
        </div>
      )}

      <p className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted-2">
        {`Up to ${usd0(card.possible)} a period. The weights add to 100 when every category can be measured; while some cannot, the rest are scaled up to fill the gap. This is the one bonus figure: the number here is the number Jordan pays once the period closes and every dispute is decided. Weights and bands only ever change from a period that has not started.`}
        {viewer === "self" && " Something look wrong? Press Dispute on the entry and say why: it still counts until Jordan decides, and the answer shows here."}
      </p>
    </div>
  );
}

/** Open disputes the creative manager may decide (a creative specialist's entries). No scores, no dollars. */
export function DisputeQueue({ items }: { items: { card: KpiScorecard; entries: KpiEntry[] }[] }) {
  if (!items.length) return null;
  return (
    <div className="panel-shadow overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <MessageSquareWarning className="size-3.5 text-warning" /> Disputes waiting on you
      </div>
      {items.map(({ card, entries }) => (
        <div key={card.memberId} className="border-b border-border/60 last:border-b-0">
          <div className="px-4 pt-3 text-sm font-semibold">{card.name} · {card.period.label}</div>
          <ul className="divide-y divide-border/60">
            {entries.map((e) => (
              <li key={e.id} className="space-y-1 px-4 py-2.5">
                <div className="text-sm font-medium">{e.title}</div>
                <ul className="space-y-0.5">
                  {e.detail.map((d, i) => <li key={i} className="text-[11px] text-muted">{d}</li>)}
                </ul>
                {e.dispute && (
                  <p className="rounded-lg bg-warning-soft/50 px-2.5 py-1.5 text-[11px]">
                    <span className="font-semibold">{e.dispute.by}</span> ({etDateTime(e.dispute.at)}): {e.dispute.note}
                  </p>
                )}
                <ResolveControls memberId={card.memberId} periodKey={card.period.key} entryId={e.id} status={e.status} advisory={e.advisory} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
