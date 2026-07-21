import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etDayStartUtc } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// QUARTERLY PERFORMANCE BONUS ENGINE
//
// Design rules, learned the hard way from the pay model:
//
//  1. SELF-FUNDING. The pool is a share of surplus ABOVE a threshold. A quarter
//     that didn't clear the bar funds $0. The bonus can never create a December.
//  2. ONLY SCORE WHAT'S REAL. Every metric below reads a field that is actually
//     populated in production. Where a signal is too thin to be fair (a
//     photographer with 2 client ratings), we DROP the metric and re-weight the
//     rest rather than inventing a number. `thin` marks that on the breakdown.
//  3. NOT GAMEABLE. Capture-quality is scored on notes-per-shoot, but only when
//     the owner actually reviewed enough of the work — otherwise "no notes"
//     would reward never being looked at, which is backwards.
//  4. OWNER APPROVES ALL MONEY. This file computes; it never pays. Payment is a
//     server action that writes a PayoutAdjustment.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export type QuarterRef = { quarter: string; startKey: string; endKey: string; start: Date; end: Date; label: string };

/** Calendar quarter containing `dateKey` (ET), or `back` quarters before it. */
export function quarterFor(dateKey?: string, back = 0): QuarterRef {
  const key = dateKey ?? etDayKey(new Date());
  const [y, m] = key.split("-").map(Number);
  let qi = Math.floor((m - 1) / 3) - back; // 0-based quarter index, shifted
  let year = y;
  while (qi < 0) { qi += 4; year -= 1; }
  while (qi > 3) { qi -= 4; year += 1; }
  const startMonth = qi * 3; // 0-based
  const start = etDayStartUtc(new Date(Date.UTC(year, startMonth, 1, 12)));
  const end = new Date(etDayStartUtc(new Date(Date.UTC(year, startMonth + 3, 1, 12))).getTime() - 1);
  return {
    quarter: `${year}-Q${qi + 1}`,
    startKey: etDayKey(start),
    endKey: etDayKey(end),
    start, end,
    label: `Q${qi + 1} ${year}`,
  };
}

/** Parse "2026-Q4" back into a QuarterRef. */
export function quarterFromKey(quarter: string): QuarterRef | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter.trim());
  if (!m) return null;
  return quarterFor(`${m[1]}-${String(Number(m[2]) * 3 - 2).padStart(2, "0")}-15`);
}

// --- Scorecard -------------------------------------------------------------

export type MetricRow = {
  key: string;
  label: string;
  weight: number;      // nominal weight (points out of 100)
  value: string;       // human-readable measured value
  points: number;      // points earned AFTER re-weighting
  maxPoints: number;   // points available AFTER re-weighting
  detail: string;      // one-line plain-English explanation
  thin: boolean;       // true = not enough signal, metric dropped
};

export type Scorecard = {
  memberId: string;
  name: string;
  basis: "OWN" | "TEAM";
  shoots: number;
  score: number | null;  // 0..100, null when there isn't enough to score at all
  metrics: MetricRow[];
  tooThin: boolean;
};

// Targets. Tuned to the real baselines measured in the CEO-program audit
// (company on-time ~68%, so 90% is a genuine stretch, not a gimme).
// Calibrated against the REAL measured baseline, not aspiration. Q2 2026 actuals:
// team on-time 74%, Harrison 80%, James 67%. A target of 95% would pay nobody,
// which is theatre rather than an incentive. 90% is a genuine stretch; 60% is the
// floor below which the quarter simply wasn't good enough.
const TARGETS = {
  onTimeFloor: 0.60,
  onTimeTarget: 0.90,
  improveTarget: 0.10,   // +10 points of on-time vs your own last quarter = full credit
  notesPer10Good: 0.5,
  notesPer10Bad: 3.0,
  ratingFloor: 3.5,
  ratingTarget: 4.8,
  minShoots: 8,
  minRatings: 4,
  minReviewCoverage: 0.25,
};

// `improve` scores you against your OWN prior quarter, so someone starting low
// can still earn by getting better. Without it the bonus only ever rewards
// whoever already leads, which demotivates exactly the people it should move.
const WEIGHTS = { onTime: 40, improve: 15, capture: 25, rating: 20 };

/** Projects this member owns in the window (project link OR appointment assignment). */
function ownsShoot(memberId: string) {
  return {
    OR: [
      { photographerId: memberId },
      { appointments: { some: { assignedToId: memberId } } },
    ],
  };
}

function scale(v: number, floor: number, target: number): number {
  if (target === floor) return v >= target ? 1 : 0;
  return clamp01((v - floor) / (target - floor));
}

/**
 * Score one person (or the whole team when memberId is null) over a quarter.
 * TEAM basis is the manager lane: James is accountable for everyone's results.
 */
export async function scorecardFor(
  q: QuarterRef,
  opts: { memberId?: string | null; name: string; basis: "OWN" | "TEAM" },
): Promise<Scorecard> {
  const { memberId, name, basis } = opts;
  const scope = memberId ? ownsShoot(memberId) : {};

  // Shoots in window. shootDate is the anchor (that's when the work happened).
  const shoots = await prisma.project.findMany({
    where: {
      ...scope,
      status: { not: "CANCELLED" },
      shootDate: { gte: q.start, lte: q.end },
    },
    select: { id: true, deliveredAt: true, deliveryDue: true },
  });
  const shootIds = shoots.map((s) => s.id);
  const n = shoots.length;

  const metrics: MetricRow[] = [];

  // 1) ON-TIME DELIVERY — the densest, most trustworthy signal we have.
  const judged = shoots.filter((s) => s.deliveredAt && s.deliveryDue);
  const onTimeN = judged.filter((s) => s.deliveredAt! <= s.deliveryDue!).length;
  const onTimeRate = judged.length ? onTimeN / judged.length : null;
  metrics.push({
    key: "onTime",
    label: "Delivered on time",
    weight: WEIGHTS.onTime,
    value: onTimeRate == null ? "no data" : `${Math.round(onTimeRate * 100)}% (${onTimeN}/${judged.length})`,
    points: 0, maxPoints: 0,
    detail: `Full credit at ${Math.round(TARGETS.onTimeTarget * 100)}%, nothing below ${Math.round(TARGETS.onTimeFloor * 100)}%.`,
    thin: onTimeRate == null || judged.length < TARGETS.minShoots,
  });

  // 2) CAPTURE QUALITY — owner's fix notes per 10 shoots.
  //    Guarded: if barely any shoots were reviewed, "no notes" means "nobody
  //    looked", not "flawless". We drop the metric instead of rewarding it.
  const noteWhere = {
    parentId: null,
    lane: "PHOTOGRAPHER",
    kind: "fix",
    ...(memberId ? { photographerId: memberId } : {}),
    ...(shootIds.length ? { projectId: { in: shootIds } } : { projectId: "__none__" }),
  };
  const fixNotes = shootIds.length ? await prisma.mediaNote.count({ where: noteWhere }) : 0;
  const reviewedProjects = shootIds.length
    ? await prisma.mediaNote.findMany({
        where: { parentId: null, projectId: { in: shootIds } },
        select: { projectId: true },
        distinct: ["projectId"],
      })
    : [];
  const coverage = n ? reviewedProjects.length / n : 0;
  const notesPer10 = n ? (fixNotes / n) * 10 : 0;
  const captureThin = n < TARGETS.minShoots || coverage < TARGETS.minReviewCoverage;
  metrics.push({
    key: "capture",
    label: "Capture quality (fix notes)",
    weight: WEIGHTS.capture,
    value: captureThin ? "not enough reviewed" : `${notesPer10.toFixed(1)} per 10 shoots`,
    points: 0, maxPoints: 0,
    detail: `Full credit at ${TARGETS.notesPer10Good} or fewer per 10 shoots. Only scored when at least ${Math.round(TARGETS.minReviewCoverage * 100)}% of shoots were reviewed.`,
    thin: captureThin,
  });

  // 3) CLIENT RATING — real but thin. Dropped below minRatings rather than guessed.
  const ratings = await prisma.feedback.findMany({
    where: {
      rating: { not: null },
      createdAt: { gte: q.start, lte: q.end },
      ...(memberId ? { photographerId: memberId } : {}),
    },
    select: { rating: true },
  });
  const ratingN = ratings.length;
  const avgRating = ratingN ? ratings.reduce((s, r) => s + (r.rating ?? 0), 0) / ratingN : null;
  metrics.push({
    key: "rating",
    label: "Client rating",
    weight: WEIGHTS.rating,
    value: avgRating == null ? "no ratings yet" : `${avgRating.toFixed(2)} of 5 (${ratingN})`,
    points: 0, maxPoints: 0,
    detail: `Full credit at ${TARGETS.ratingTarget}. Needs at least ${TARGETS.minRatings} ratings to count.`,
    thin: avgRating == null || ratingN < TARGETS.minRatings,
  });

  // --- Re-weight over the metrics that actually have signal -----------------
  const live = metrics.filter((m) => !m.thin);
  const liveWeight = live.reduce((s, m) => s + m.weight, 0);
  const tooThin = n < TARGETS.minShoots || liveWeight === 0;

  if (!tooThin) {
    for (const m of metrics) {
      if (m.thin) { m.points = 0; m.maxPoints = 0; continue; }
      m.maxPoints = round2((m.weight / liveWeight) * 100);
      let frac = 0;
      if (m.key === "onTime") frac = scale(onTimeRate ?? 0, TARGETS.onTimeFloor, TARGETS.onTimeTarget);
      if (m.key === "capture") frac = 1 - scale(notesPer10, TARGETS.notesPer10Good, TARGETS.notesPer10Bad);
      if (m.key === "rating") frac = scale(avgRating ?? 0, TARGETS.ratingFloor, TARGETS.ratingTarget);
      m.points = round2(m.maxPoints * clamp01(frac));
    }
  }

  const score = tooThin ? null : round2(metrics.reduce((s, m) => s + m.points, 0));
  return { memberId: memberId ?? "TEAM", name, basis, shoots: n, score, metrics, tooThin };
}

// --- Funding ---------------------------------------------------------------

export type PoolMath = {
  revenue: number;
  cost: number;
  surplus: number;
  threshold: number;
  above: number;
  poolPercent: number;
  poolRaw: number;
  poolCap: number | null;
  pool: number;
  funded: boolean;
  why: string;
};

/**
 * The gate. Pool = poolPercent x (surplus - threshold), floored at 0 and capped.
 * A losing or threshold-missing quarter funds exactly $0, by construction.
 */
export function poolMath(input: {
  revenue: number; cost: number; threshold: number; poolPercent: number; poolCap?: number | null;
}): PoolMath {
  const surplus = round2(input.revenue - input.cost);
  const above = round2(Math.max(0, surplus - input.threshold));
  const poolRaw = round2(above * input.poolPercent);
  const cap = input.poolCap ?? null;
  const pool = round2(cap != null ? Math.min(poolRaw, cap) : poolRaw);
  const funded = pool > 0;
  const why = surplus <= 0
    ? "The quarter did not make a profit, so there is no pool."
    : above <= 0
      ? `Profit of $${surplus.toLocaleString()} did not clear the $${input.threshold.toLocaleString()} threshold, so there is no pool.`
      : cap != null && poolRaw > cap
        ? `Funded at the cap. ${Math.round(input.poolPercent * 100)}% of the $${above.toLocaleString()} above threshold would be $${poolRaw.toLocaleString()}.`
        : `${Math.round(input.poolPercent * 100)}% of the $${above.toLocaleString()} earned above the threshold.`;
  return { revenue: round2(input.revenue), cost: round2(input.cost), surplus, threshold: input.threshold, above, poolPercent: input.poolPercent, poolRaw, poolCap: cap, pool, funded, why };
}

/** Split a pool across scorecards, weighted by score. Unscoreable people get $0. */
export function splitPool(pool: number, cards: Scorecard[]): Record<string, number> {
  const scored = cards.filter((c) => c.score != null && c.score > 0);
  const total = scored.reduce((s, c) => s + (c.score ?? 0), 0);
  const out: Record<string, number> = {};
  for (const c of cards) out[c.memberId] = 0;
  if (!total || pool <= 0) return out;
  for (const c of scored) out[c.memberId] = round2(pool * ((c.score ?? 0) / total));
  return out;
}
