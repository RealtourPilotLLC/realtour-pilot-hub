import { Trophy, Info, TrendingDown, CircleDashed, Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { BONUS_BANDS, MAX_QUARTERLY_BONUS, type KpiArea, type QuarterScorecard } from "@/lib/kpi";

// ---------------------------------------------------------------------------
// The photographer's own KPI tracker on /my-pay: where they stand this quarter,
// which band that puts them in, what it is worth today, and what is pulling it
// down. Their OWN numbers only — this component is rendered from the same
// memberId the rest of My Pay resolves, and knows nothing about anyone else.
//
// Everything here is stated, never implied: the weights, the targets, which
// areas the hub genuinely cannot see yet and are therefore left OUT of the
// maths. A score with an invisible denominator is a score nobody trusts, and a
// bonus nobody trusts does not change behaviour.
// ---------------------------------------------------------------------------

// Prose wants "nothing"; the money slot wants a dollar figure that lines up
// with every other number on the page.
const money = (n: number) => (n === 0 ? "nothing" : `$${n.toLocaleString("en-US")}`);
const usd0 = (n: number) => `$${n.toLocaleString("en-US")}`;

function Bar({ points, maxPoints }: { points: number; maxPoints: number }) {
  const frac = maxPoints > 0 ? points / maxPoints : 0;
  const tone = frac >= 0.85 ? "bg-success" : frac >= 0.5 ? "bg-warning" : "bg-danger";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.max(2, Math.round(frac * 100))}%` }} />
    </div>
  );
}

function AreaRow({ area }: { area: KpiArea }) {
  // maxPoints is 0 on a card too thin to score — the area is measured, but its
  // share of a total that was never published means nothing.
  const scored = area.measured && area.maxPoints > 0;
  const lost = scored ? area.maxPoints - area.points : 0;
  return (
    <div className={cn("px-4 py-3", !area.measured && "bg-surface-2/40")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {area.measured ? <Check className="size-3.5 shrink-0 text-success" /> : <CircleDashed className="size-3.5 shrink-0 text-muted-2" />}
            <span className="truncate">{area.label}</span>
            <span className="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] font-semibold text-muted-2">{area.weight} pts</span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-2">{area.blurb}</p>
        </div>
        <div className="shrink-0 text-right">
          {scored ? (
            <>
              <div className="text-sm font-semibold tabular-nums">
                {area.points}
                <span className="text-[11px] font-normal text-muted-2"> / {area.maxPoints}</span>
              </div>
              {lost >= 1 && <div className="text-[10px] font-medium text-danger">−{lost.toFixed(1)}</div>}
            </>
          ) : (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-2">
              {area.measured ? "Measured" : "Not measured"}
            </span>
          )}
        </div>
      </div>

      {area.measured && (
        <div className="mt-2 space-y-1">
          {scored && <Bar points={area.points} maxPoints={area.maxPoints} />}
          <div className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
            <span className="font-medium">{area.value}</span>
            <span className="text-muted-2">{area.target}</span>
          </div>
        </div>
      )}
      {!area.measured && area.why && <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{area.why}</p>}
      {area.notes.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {area.notes.map((nt) => (
            <li key={nt} className="flex gap-1.5 text-[11px] leading-relaxed text-muted-2">
              <span aria-hidden className="mt-[3px] size-1 shrink-0 rounded-full bg-border-strong" />
              <span>{nt}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QuarterScoreCard({ card, previous }: { card: QuarterScorecard; previous?: QuarterScorecard | null }) {
  const shown = card.score == null ? null : Math.round(card.score);
  const dark = card.areas.filter((a) => !a.measured);

  return (
    <div className="panel-shadow overflow-hidden rounded-2xl border border-border bg-surface">
      {/* Headline — the score, the band, and what the band is worth today. */}
      <div className="border-b border-border bg-brand/[0.04] px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <Trophy className="size-3.5 text-brand" /> Bonus scorecard · {card.quarter.label}
            </div>
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
                  {card.provisional ? `${Math.round(card.elapsed * 100)}% through the quarter — this still moves` : "quarter closed"}
                </div>
              </>
            )}
          </div>
          <div className="text-right">
            <div className="text-[11px] text-muted">{card.provisional ? "Worth today" : "Earned"}</div>
            <div className={cn("text-2xl font-bold tabular-nums", card.bonus > 0 ? "text-success" : "text-muted-2")}>
              {shown == null ? "—" : usd0(card.bonus)}
            </div>
            {shown != null && card.band && <div className="text-[11px] text-muted-2">{card.band.label}</div>}
          </div>
        </div>

        {/* The ladder, so the next rung is always visible. */}
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {[...BONUS_BANDS].reverse().map((b) => {
            const here = card.band?.min === b.min;
            const nextUp = card.next?.band.min === b.min;
            return (
              <div
                key={b.min}
                className={cn(
                  "rounded-lg border px-2 py-1.5 text-center",
                  here ? "border-brand bg-brand text-white" : nextUp ? "border-brand/40 bg-surface" : "border-border bg-surface",
                )}
              >
                <div className={cn("text-[10px] font-medium", here ? "text-white/80" : "text-muted-2")}>{b.short}</div>
                <div className={cn("text-xs font-bold tabular-nums", !here && b.amount > 0 && "text-success", !here && b.amount === 0 && "text-muted-2")}>
                  {b.amount === 0 ? "—" : `$${b.amount.toLocaleString("en-US")}`}
                </div>
              </div>
            );
          })}
        </div>
        {card.next && shown != null && (
          <p className="mt-2 flex items-center gap-1 text-[11px] font-medium text-brand">
            <ChevronRight className="size-3.5" />
            {card.next.pointsAway} more point{card.next.pointsAway === 1 ? "" : "s"} takes you to {card.next.band.label} — {money(card.next.band.amount)}.
          </p>
        )}
      </div>

      {/* HONESTY LINE. The denominator is never hidden: a score built from four
          of seven areas has to say so, on the page, above the detail. */}
      <div className="flex items-start gap-2 border-b border-border bg-warning-soft/40 px-4 py-2.5">
        <Info className="mt-px size-3.5 shrink-0 text-warning" />
        <p className="text-[11px] leading-relaxed text-muted">
          {shown == null ? (
            <>
              Only <span className="font-semibold text-foreground">{card.measuredAreas} of {card.totalAreas} areas</span> can be
              measured this quarter — {card.measuredWeight} of the 100 points. Too little to put a score on, so there isn&apos;t one.
            </>
          ) : (
            <>
              Scored on <span className="font-semibold text-foreground">{card.measuredAreas} of {card.totalAreas} areas</span> — the{" "}
              {card.measuredWeight} points the hub can actually measure right now, stretched to a full 100.
            </>
          )}{" "}
          {dark.length > 0 && (
            <>
              {dark.map((a) => a.label).join(", ")} {dark.length === 1 ? "is" : "are"} left out rather than guessed at, so{" "}
              {dark.length === 1 ? "it" : "they"} can neither help nor hurt you.
            </>
          )}
        </p>
      </div>

      {/* What's pulling it down — the first thing they came to find out. */}
      {shown != null && card.dragging.length > 0 && (
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <TrendingDown className="size-3.5 text-danger" /> What&apos;s pulling your score down
          </div>
          <ul className="mt-1.5 space-y-1">
            {card.dragging.map((a) => (
              <li key={a.key} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{a.label}</span>
                  <span className="text-[11px] text-muted-2"> · {a.value}</span>
                </span>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-danger">
                  −{(a.maxPoints - a.points).toFixed(1)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Every area, with its weight and its target stated. */}
      <div className="divide-y divide-border/60">
        {card.areas.map((a) => (
          <AreaRow key={a.key} area={a} />
        ))}
      </div>

      {/* Last quarter, when there is one — the progress half of "track their
          progress". A closed quarter's number no longer moves. */}
      {previous && previous.shoots > 0 && (
        <div className="flex items-center gap-3 border-t border-border bg-surface-2/40 px-4 py-2.5 text-sm">
          <span className="shrink-0 text-muted">{previous.quarter.label}</span>
          <span className="min-w-0 text-[11px] text-muted-2">
            {previous.shoots} shoot{previous.shoots === 1 ? "" : "s"} · {previous.measuredAreas} of {previous.totalAreas} areas measured
          </span>
          {previous.score == null ? (
            <span className="ml-auto shrink-0 text-[11px] text-muted-2">Not enough measured to score</span>
          ) : (
            <>
              <span className="ml-auto shrink-0 font-semibold tabular-nums">{Math.round(previous.score)}</span>
              <span className={cn("w-16 shrink-0 text-right text-xs font-semibold", previous.bonus > 0 ? "text-success" : "text-muted-2")}>
                {money(previous.bonus)}
              </span>
            </>
          )}
        </div>
      )}

      <p className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted-2">
        Up to {money(MAX_QUARTERLY_BONUS)} a quarter. The weights above add to 100 when every area can be measured; while some
        can&apos;t, the rest are scaled up to fill the gap — so the score always means &ldquo;out of everything we can see&rdquo;.
        This page works the number out; Jordan approves and pays it, and it shows up as an adjustment on your pay period. Anything
        here look wrong? Flag it below and it goes straight to him.
      </p>
    </div>
  );
}
