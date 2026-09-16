import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey, etDayStartUtc, etAt } from "@/lib/datetime";
import { photoTargetFor, rawOverageCeiling } from "@/lib/culling";

// ---------------------------------------------------------------------------
// PHOTOGRAPHER KPI TRACKER + QUARTERLY BONUS  (Jordan, Sep 2026)
//
// "Feedback goes to the photographer on that shoot and is added to their KPI
//  tracker so we can track their progress for the bonus incentives. The bonuses
//  will be up to $1000 per quarter ($4k per year). This will also help us track
//  if they are ready for a role and pay increase."
//
// Score out of 100 across the SEVEN areas Jordan named, banded into fixed
// money: 90+ → $1,000 · 80-89 → $600 · 70-79 → $250 · below 70 → nothing.
//
// The rules this file lives by:
//
//  1. NEVER INVENT A NUMBER. Every area reads a field that is genuinely
//     populated in production. Where the hub cannot measure an area yet
//     (professionalism today, client ratings until the feedback form lands),
//     the area is marked `measured: false` with the reason in plain English and
//     is EXCLUDED from the score — never silently scored 100 (free money) or 0
//     (an unwinnable bonus). The remaining areas are re-weighted to 100 so the
//     score always means "out of everything we can actually see".
//
//  2. ONLY SCORE WHAT THE PHOTOGRAPHER CONTROLS. Delivery-to-client on-time is
//     deliberately NOT in here: it is dominated by the edit + QC lane, and
//     paying a photographer on it would make the bonus feel like a lottery.
//     Their reliability is measured on the part they own — raws in on time and
//     the shoot wrapped up.
//
//  3. NOT GAMEABLE, AND NOT A TAX ON BEING LOOKED AT. Capture quality is scored
//     on issues-per-shoot, but only once enough of the work has actually been
//     reviewed — otherwise "no notes" would reward never being reviewed, which
//     is backwards. Coaching notes ("next time, duck under that mirror") do NOT
//     count against the score: they are teaching, and a score that punished
//     them would quietly stop Jordan from writing them.
//
//  4. THIS FILE COMPUTES, IT NEVER PAYS. Money moves through a PayoutAdjustment
//     the owner approves, exactly like every other pay surface.
//
// Pure scoring (bands, scaling, assembly) is separated from the database reads
// so the owner-facing roster view can reuse all of it.
// ---------------------------------------------------------------------------

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Higher is better: 0 at `floor`, full credit at `target`. */
function upScale(v: number, floor: number, target: number): number {
  if (target === floor) return v >= target ? 1 : 0;
  return clamp01((v - floor) / (target - floor));
}
/** Lower is better: full credit at `good` or below, 0 at `bad` or above. */
function downScale(v: number, good: number, bad: number): number {
  return 1 - upScale(v, good, bad);
}

// --------------------------------- Bands -----------------------------------

export type BonusBand = {
  min: number;
  amount: number;
  label: string;
  /** The four-across ladder on a phone has ~80px a column — the long label wraps
   *  to three lines there and the money stops lining up. */
  short: string;
};

/** Jordan's bands, verbatim. Ordered high → low; `bandFor` takes the first hit. */
export const BONUS_BANDS: BonusBand[] = [
  { min: 90, amount: 1000, label: "90 and above", short: "90+" },
  { min: 80, amount: 600, label: "80 – 89", short: "80–89" },
  { min: 70, amount: 250, label: "70 – 79", short: "70–79" },
  { min: 0, amount: 0, label: "Below 70", short: "Under 70" },
];

export const MAX_QUARTERLY_BONUS = 1000; // $4k a year at four full quarters

/** The band a score falls in. Banding uses the score AS DISPLAYED (whole
 *  number) — a page that shows "90" and pays the 80s band is a support ticket. */
export function bandFor(score: number | null): BonusBand | null {
  if (score == null) return null;
  const shown = Math.round(score);
  return BONUS_BANDS.find((b) => shown >= b.min) ?? BONUS_BANDS[BONUS_BANDS.length - 1];
}

/** The next band up and what it takes to get there — null once they're at the top. */
export function nextBandFor(score: number | null): { band: BonusBand; pointsAway: number } | null {
  if (score == null) return null;
  const shown = Math.round(score);
  const above = [...BONUS_BANDS].reverse().find((b) => b.min > shown);
  return above ? { band: above, pointsAway: Math.max(1, above.min - shown) } : null;
}

// -------------------------------- Quarters ---------------------------------

export type QuarterRef = {
  key: string; // "2026-Q3"
  label: string; // "Q3 2026"
  startKey: string;
  endKey: string;
  start: Date;
  end: Date;
};

/** Calendar quarter (ET) containing `dayKey`, or `back` quarters before it. */
export function quarterFor(dayKey?: string, back = 0): QuarterRef {
  const key = dayKey ?? etDayKey(new Date());
  const [y, m] = key.split("-").map(Number);
  let qi = Math.floor((m - 1) / 3) - back;
  let year = y;
  while (qi < 0) { qi += 4; year -= 1; }
  while (qi > 3) { qi -= 4; year += 1; }
  // Noon UTC on the 1st is morning ET of the same date, so etDayStartUtc lands
  // on the right ET midnight either side of a DST flip.
  const start = etDayStartUtc(new Date(Date.UTC(year, qi * 3, 1, 12)));
  const end = new Date(etDayStartUtc(new Date(Date.UTC(year, qi * 3 + 3, 1, 12))).getTime() - 1);
  return { key: `${year}-Q${qi + 1}`, label: `Q${qi + 1} ${year}`, startKey: etDayKey(start), endKey: etDayKey(end), start, end };
}

/** Parse "2026-Q3" back into a QuarterRef (null when it isn't one). */
export function quarterFromKey(key: string): QuarterRef | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key.trim());
  if (!m) return null;
  return quarterFor(`${m[1]}-${String(Number(m[2]) * 3 - 2).padStart(2, "0")}-15`);
}

/** The ET day after `key` — noon-UTC anchored so it survives DST. */
function nextEtDayKey(key: string): string {
  return etDayKey(new Date(Date.parse(`${key}T12:00:00Z`) + 86_400_000));
}

// --------------------------------- Areas -----------------------------------

export type AreaKey =
  | "professionalism"
  | "quality"
  | "culling"
  | "clientFeedback"
  | "reliability"
  | "revisions"
  | "volume";

export type KpiArea = {
  key: AreaKey;
  label: string;
  /** One line: what this area is, in the photographer's language. */
  blurb: string;
  /** Nominal weight out of 100, before re-weighting. STATED on the page. */
  weight: number;
  measured: boolean;
  /** Why it isn't measured — shown instead of a number. */
  why: string | null;
  /** The measured value, human-readable ("81% inside budget (38 of 47)"). */
  value: string;
  /** How full credit is earned — the target, stated plainly. */
  target: string;
  fraction: number | null; // 0..1 of this area earned
  points: number; // after re-weighting
  maxPoints: number; // after re-weighting
  /** Context that is NOT scored — coaching notes, caveats, what's excluded. */
  notes: string[];
};

// The weights, out of 100. Client-facing craft and the client's own verdict
// carry the most; volume carries the least on purpose — Jordan books the work,
// so a photographer must never be able to buy a bonus with quantity.
export const AREA_WEIGHTS: Record<AreaKey, number> = {
  professionalism: 10,
  quality: 20,
  culling: 15,
  clientFeedback: 20,
  reliability: 20,
  revisions: 10,
  volume: 5,
};

// Calibration. Where a target already exists elsewhere in the hub it is
// imported rather than restated (the culling ceiling comes from culling.ts, the
// one source the hourly cull sweep and the upload chips already enforce).
const TARGETS = {
  // Capture quality: issues per 10 shoots.
  issuesPer10Good: 0.5,
  issuesPer10Bad: 3.0,
  minReviewCoverage: 0.25, // below this, "no notes" means "nobody looked"
  // Culling: share of counted shoots inside the raw budget.
  cullFloor: 0.5,
  cullTarget: 0.95,
  // Client ratings.
  ratingFloor: 3.5,
  ratingTarget: 4.8,
  minRatings: 4,
  // Reliability: raws in by noon ET the day after the shoot.
  rawsFloor: 0.6,
  rawsTarget: 0.95,
  wrapFloor: 0.6,
  wrapTarget: 0.95,
  minDatableShoots: 6,
  // …and they must be most of the quarter. Scoring "on time" off 6 of 40 shoots
  // would be a headline built from a sixth of the evidence.
  minDatableCoverage: 0.4,
  minWrapShoots: 3,
  // Revisions: share of shoots that came back. Wider than it looks because it
  // counts EDIT revisions too (see the area comment) — a photographer must not
  // be zeroed for the edit lane's work.
  revisionGood: 0.1,
  revisionBad: 0.3,
  // Volume: like-for-like against their own prior quarter.
  growthFloor: -0.2,
  growthTarget: 0.1,
  minPriorShoots: 5,
  // Nothing scores at all below this many shoots in the quarter.
  minShoots: 5,
  // …nor below this much of the scorecard being visible. A "67 out of 100"
  // assembled from revision rate and shoot count alone is not a score, it is
  // two numbers wearing a score's clothes — and it would be read as the real
  // thing, argued with, and eventually paid on. Below the floor the areas are
  // still shown (they are the useful part); the headline number is withheld.
  minMeasuredWeight: 40,
};

// The wrap-up (debrief) only became compulsory with the rebuilt upload portal.
// Scoring a shoot that predates the rule would be scoring people for not
// following an instruction nobody had given them yet.
const WRAP_UP_REQUIRED_FROM = Date.parse("2026-09-02T00:00:00-04:00");

// --------------------------------- Result ----------------------------------

export type QuarterScorecard = {
  memberId: string;
  name: string;
  quarter: QuarterRef;
  /** Shoots they owned in the quarter, up to today. */
  shoots: number;
  /** null when there is not enough of the quarter to score honestly. */
  score: number | null;
  band: BonusBand | null;
  bonus: number; // dollars this score is worth today
  next: { band: BonusBand; pointsAway: number } | null;
  areas: KpiArea[];
  measuredAreas: number;
  totalAreas: number;
  /** Nominal weight covered by the measured areas — "62 of 100 points of the
   *  scorecard can be seen today". */
  measuredWeight: number;
  /** The quarter hasn't closed — the number still moves. */
  provisional: boolean;
  /** Fraction of the quarter elapsed (0..1), for the "X% through" line. */
  elapsed: number;
  /** Why there's no score at all, when there isn't one. */
  thinReason: string | null;
  /** Measured areas losing the most points, worst first. */
  dragging: KpiArea[];
};

/** Turn scored areas into a scorecard: re-weight over what's measured, band it. */
export function assembleScorecard(
  base: Omit<QuarterScorecard, "score" | "band" | "bonus" | "next" | "measuredAreas" | "measuredWeight" | "dragging" | "totalAreas"> & { areas: KpiArea[] },
): QuarterScorecard {
  const isLive = (a: KpiArea) => a.measured && a.fraction != null;
  const liveWeight = base.areas.filter(isLive).reduce((s, a) => s + a.weight, 0);

  // Rebuilt, never mutated — the caller's array is an input, and a scoring
  // library that edits its inputs is one that can't be called twice.
  // A scorecard too thin to publish a score is also too thin to publish
  // per-area points: "66.7 out of 66.7" against a total that doesn't exist
  // invites exactly the wrong conclusion. The measured VALUES still show.
  const scoreable = liveWeight > 0 && !base.thinReason;
  const areas: KpiArea[] = base.areas.map((a) => {
    if (!isLive(a) || !scoreable) return { ...a, points: 0, maxPoints: 0 };
    const maxPoints = round1((a.weight / liveWeight) * 100);
    return { ...a, maxPoints, points: round1(maxPoints * clamp01(a.fraction ?? 0)) };
  });
  const live = areas.filter(isLive);

  const score = scoreable ? round1(areas.reduce((s, a) => s + a.points, 0)) : null;
  const band = bandFor(score);
  return {
    ...base,
    areas,
    score,
    band,
    bonus: band?.amount ?? 0,
    next: nextBandFor(score),
    measuredAreas: live.length,
    totalAreas: areas.length,
    measuredWeight: liveWeight,
    dragging: live
      .filter((a) => a.maxPoints - a.points >= 1)
      .sort((a, b) => b.maxPoints - b.points - (a.maxPoints - a.points)),
  };
}

// ------------------------------- The reads ---------------------------------

/** A shoot belongs to a photographer if they're the project's photographer OR
 *  the appointment assignee — the same OR every other shoot surface uses. Some
 *  jobs are only ever assigned through the appointment. */
function ownsShoot(memberId: string) {
  return { OR: [{ photographerId: memberId }, { appointments: { some: { assignedToId: memberId } } }] };
}

/**
 * Score one photographer over one quarter. Reads only; nothing here writes.
 */
export async function scoreQuarter(opts: {
  memberId: string;
  name?: string;
  quarter?: QuarterRef;
  now?: Date;
}): Promise<QuarterScorecard> {
  const now = opts.now ?? new Date();
  const q = opts.quarter ?? quarterFor(etDayKey(now));
  const scope = ownsShoot(opts.memberId);
  // Work that has HAPPENED — a shoot already on next week's calendar is not
  // part of this quarter's performance yet.
  const windowEnd = now < q.end ? now : q.end;
  const provisional = now < q.end;
  const elapsedMs = windowEnd.getTime() - q.start.getTime();
  const elapsed = clamp01(elapsedMs / (q.end.getTime() - q.start.getTime()));
  const elapsedDays = Math.max(1, Math.round(elapsedMs / 86_400_000));

  // Like-for-like comparison window in the PRIOR quarter: the same number of
  // elapsed days. Comparing 9 weeks of this quarter against 13 of the last one
  // would tell every photographer they are collapsing, every quarter.
  const prevQ = quarterFor(q.startKey, 1);
  const prevWindowEnd = new Date(Math.min(prevQ.start.getTime() + (windowEnd.getTime() - q.start.getTime()), prevQ.end.getTime()));

  const [member, shoots, prevShoots] = await Promise.all([
    prisma.teamMember.findUnique({ where: { id: opts.memberId }, select: { name: true } }),
    prisma.project.findMany({
      where: { ...scope, status: { not: "CANCELLED" }, shootDate: { gte: q.start, lte: windowEnd } },
      select: {
        id: true, shootDate: true, createdAt: true, uploadedAt: true,
        debriefSubmittedAt: true, cullingConfirmedAt: true,
        rawPhotoCount: true, photoTarget: true, squareFeet: true,
        revisionRequestedAt: true,
      },
    }),
    prisma.project.count({
      where: { ...scope, status: { not: "CANCELLED" }, shootDate: { gte: prevQ.start, lte: prevWindowEnd } },
    }),
  ]);

  const name = opts.name ?? member?.name ?? "You";
  const shootIds = shoots.map((s) => s.id);
  const n = shoots.length;
  const onIds = shootIds.length ? { projectId: { in: shootIds } } : { projectId: "__none__" };

  const [noteRoll, flagCount, reviewedRows, ratingRows, revisionBriefProjects, reopenedQc] = await Promise.all([
    // Capture feedback on THESE shoots — fix vs coaching, counted exactly.
    prisma.mediaNote.groupBy({ by: ["kind"], where: { lane: "PHOTOGRAPHER", parentId: null, ...onIds }, _count: true }),
    // Per-photo flags raised in the lightbox: a frame that had to be corrected.
    prisma.imageFlag.count({ where: onIds }),
    // Review COVERAGE: shoots a human actually looked at, in any lane. Without
    // this, a photographer nobody reviewed would score a perfect 100.
    shootIds.length
      ? prisma.mediaNote.findMany({ where: { parentId: null, ...onIds }, select: { projectId: true }, distinct: ["projectId"] })
      : Promise.resolve([] as { projectId: string }[]),
    // Client ratings. photographerRating is the client-form question about
    // THIS PERSON ("experience with the assigned photographer"); the overall
    // `rating` is the fallback for a response that skipped it or came in from a
    // text/email rather than the form.
    //
    // Attribution is deliberately two-sided: a row counts when it is stamped to
    // them OR sits on a job they shot (rows raised from comms carry no
    // photographerId — see the gap note in src/app/quality/data.ts), AND is not
    // stamped to somebody else. Without that second clause a reassigned job
    // would put another photographer's rating in this person's bonus.
    //
    // A row an owner dismissed as "not feedback" on /quality (Sep 16) is out of
    // the bonus maths entirely; the attribution below reads the human-corrected
    // values, as it always has.
    prisma.feedback.findMany({
      where: {
        createdAt: { gte: q.start, lte: windowEnd },
        dismissedAt: null,
        AND: [
          { OR: [{ photographerRating: { not: null } }, { rating: { not: null } }] },
          { OR: [{ photographerId: opts.memberId }, shootIds.length ? onIds : { projectId: "__none__" }] },
          { OR: [{ photographerId: opts.memberId }, { photographerId: null }] },
        ],
      },
      select: { id: true, rating: true, photographerRating: true, attribution: true, attributionWhy: true },
    }),
    shootIds.length
      ? prisma.revisionBrief.findMany({ where: onIds, select: { projectId: true }, distinct: ["projectId"] })
      : Promise.resolve([] as { projectId: string }[]),
    shootIds.length
      ? prisma.qcRecord.findMany({ where: { ...onIds, reopenedByRevisionAt: { not: null } }, select: { projectId: true }, distinct: ["projectId"] })
      : Promise.resolve([] as { projectId: string }[]),
  ]);

  const areas: KpiArea[] = [];
  const add = (a: Omit<KpiArea, "points" | "maxPoints">) => { areas.push({ ...a, points: 0, maxPoints: 0 }); };

  // --- 1) PROFESSIONALISM ---------------------------------------------------
  // Nothing in the hub records how a shoot was handled on site: no arrival
  // time against the appointment, no presentation check, no client note about
  // conduct that is separable from the photos. Rather than score everyone 100
  // (free money) or 0 (an unwinnable bonus), the area is shown as unmeasured
  // and left out of the maths. It lights up the day a shoot carries a
  // professionalism mark — a client-form question, or Kyle marking it off.
  add({
    key: "professionalism",
    label: "Professionalism",
    blurb: "On time, presented well, handled the client and the property right.",
    weight: AREA_WEIGHTS.professionalism,
    measured: false,
    why: "The hub doesn't record this yet — nothing tracks arrival, presentation or conduct on site. It's left out of your score rather than guessed at.",
    value: "Not measured yet",
    target: "Full credit once shoots carry a professionalism mark.",
    fraction: null,
    notes: ["Left out, not scored zero — the areas that can be measured are scaled up to cover its share."],
  });

  // --- 2) QUALITY & QC ------------------------------------------------------
  // ISSUES, not opinions: fix notes (something had to be corrected) and image
  // flags (a frame sent back). Coaching notes are excluded on purpose — they
  // are teaching, and charging for them would quietly stop the coaching.
  //
  // NOT USED HERE: QcRecord.missCount. It counts unticked checklist items on
  // Kyle's post-edit QC (94% of records in production have misses, and most of
  // the checklist — virtual staging, floor plans, VIP sweeps — isn't the
  // photographer's work at all). Scoring a photographer on it would be scoring
  // them on somebody else's tickboxes.
  const fixNotes = noteRoll.find((r) => r.kind === "fix")?._count ?? 0;
  const coachingNotes = noteRoll.find((r) => r.kind === "coaching")?._count ?? 0;
  const issues = fixNotes + flagCount;
  const coverage = n ? reviewedRows.length / n : 0;
  const issuesPer10 = n ? (issues / n) * 10 : 0;
  const qualityThin = n < TARGETS.minShoots || coverage < TARGETS.minReviewCoverage;
  add({
    key: "quality",
    label: "Quality & QC",
    blurb: "Frames that came back needing a fix, per shoot.",
    weight: AREA_WEIGHTS.quality,
    measured: !qualityThin,
    why: qualityThin
      ? n < TARGETS.minShoots
        ? "Not enough shoots this quarter to judge yet."
        : `Only ${reviewedRows.length} of your ${n} shoots have been reviewed — too few to score. "No notes" here would mean nobody looked, not that the work was clean.`
      : null,
    value: qualityThin ? "Not enough reviewed yet" : `${issuesPer10.toFixed(1)} fixes per 10 shoots (${issues} across ${n})`,
    target: `Full credit at ${TARGETS.issuesPer10Good} or fewer per 10 shoots. Scored once at least ${pct(TARGETS.minReviewCoverage)} of your shoots have been reviewed.`,
    fraction: qualityThin ? null : downScale(issuesPer10, TARGETS.issuesPer10Good, TARGETS.issuesPer10Bad),
    notes: [
      ...(coachingNotes > 0
        ? [`${coachingNotes} coaching note${coachingNotes === 1 ? "" : "s"} this quarter — those are for next time and never count against you.`]
        : []),
      "Kyle's QC checklist isn't in this number: most of it (staging, floor plans, VIP sweeps) isn't your work.",
    ],
  });

  // --- 3) CULLING -----------------------------------------------------------
  // The raw drop against the budget the cull sweep already enforces
  // (photoTargetFor × the bracket allowance, straight out of culling.ts — one
  // ceiling, never a second opinion). A count of ZERO means the counter found
  // no raw folder (video-only jobs, or the folder wasn't matched), NOT a
  // perfectly culled shoot: those are excluded, not scored as wins.
  const counted = shoots.filter((s) => s.rawPhotoCount != null && s.rawPhotoCount > 0);
  const withinBudget = counted.filter((s) => (s.rawPhotoCount ?? 0) <= rawOverageCeiling(photoTargetFor(s)));
  const cullRate = counted.length ? withinBudget.length / counted.length : 0;
  const cullThin = counted.length < TARGETS.minShoots;
  const confirmed = shoots.filter((s) => s.cullingConfirmedAt).length;
  const uncounted = n - counted.length;
  // Aryeo doesn't send square footage on these orders, so photoTargetFor falls
  // back to the standard tier for every home. Said out loud on the card rather
  // than left to be discovered: a 5,000 sq ft house judged on the 50-photo tier
  // reads as over-shot when it wasn't. The per-job photoTarget override is the
  // fix, and it already wins here (photoTargetFor honours it).
  const noSqft = counted.filter((s) => s.squareFeet == null && s.photoTarget == null).length;
  add({
    key: "culling",
    label: "Culling",
    blurb: "Shooting to the budget — every space covered once, extras to Backup.",
    weight: AREA_WEIGHTS.culling,
    measured: !cullThin,
    why: cullThin ? `Only ${counted.length} of your shoots have a counted raw folder this quarter — not enough to score.` : null,
    value: cullThin ? "Not enough counted shoots" : `${pct(cullRate)} inside budget (${withinBudget.length} of ${counted.length})`,
    target: `Full credit at ${pct(TARGETS.cullTarget)} inside the raw budget for the home's size.`,
    fraction: cullThin ? null : upScale(cullRate, TARGETS.cullFloor, TARGETS.cullTarget),
    notes: [
      ...(confirmed > 0 ? [`You confirmed the cull on the wrap-up for ${confirmed} shoot${confirmed === 1 ? "" : "s"}.`] : []),
      ...(noSqft > 0
        ? [`${noSqft} of these homes have no square footage on file, so they're judged on the standard tier — a genuinely big house can look over budget. Tell Jordan and he'll set the target on the job.`]
        : []),
      ...(uncounted > 0 ? [`${uncounted} shoot${uncounted === 1 ? "" : "s"} had no raw count (video-only, or the folder wasn't matched) and are left out.`] : []),
    ],
  });

  // --- 4) CLIENT FEEDBACK SCORES -------------------------------------------
  const ratingRowsById = [...new Map(ratingRows.map((r) => [r.id, r])).values()];
  // WHAT THE PHOTOGRAPHER IS ACCOUNTABLE FOR (Jordan, Sep 7 2026): "reels
  // turned around quicker and less spelling errors ... should not affect the
  // photographer. This is an editing and operations issue." A response
  // classified OPERATIONS is dropped from this area entirely — its overall
  // rating is a verdict on turnaround or editing, and grading a shooter on it
  // is how a good one ends up with a bad score. ONSITE and MIXED count, and so
  // does an unclassified row that carries an explicit photographerRating (the
  // client rated the PERSON, whatever else they wrote).
  const opsOnly = ratingRowsById.filter((r) => r.attribution === "OPERATIONS");
  const countable = ratingRowsById.filter(
    (r) => r.attribution !== "OPERATIONS" || r.photographerRating != null,
  );
  const ratings = countable
    // On a MIXED row only the photographer's OWN rating counts — the overall
    // number carries the operations half too.
    .map((r) => (r.attribution === "MIXED" ? r.photographerRating : r.photographerRating ?? r.rating))
    .filter((x): x is number => x != null);
  const ownRatings = countable.filter((r) => r.photographerRating != null).length;
  const ratingN = ratings.length;
  const avgRating = ratingN ? ratings.reduce((s, r) => s + r, 0) / ratingN : null;
  const ratingThin = avgRating == null || ratingN < TARGETS.minRatings;
  add({
    key: "clientFeedback",
    label: "Client feedback scores",
    blurb: "What the agents you shot for rated their experience with you.",
    weight: AREA_WEIGHTS.clientFeedback,
    measured: !ratingThin,
    why: ratingThin
      ? ratingN === 0
        ? "No client has rated one of your shoots this quarter yet. It counts as soon as the ratings start coming in."
        : `Only ${ratingN} rating${ratingN === 1 ? "" : "s"} so far — ${TARGETS.minRatings} are needed before it counts, so one review can't swing your bonus.`
      : null,
    value: ratingThin ? (ratingN === 0 ? "No ratings yet" : `${ratingN} rating${ratingN === 1 ? "" : "s"} — need ${TARGETS.minRatings}`) : `${avgRating!.toFixed(2)} out of 5 (${ratingN} ratings)`,
    target: `Full credit at ${TARGETS.ratingTarget} of 5. Needs at least ${TARGETS.minRatings} ratings to count.`,
    fraction: ratingThin ? null : upScale(avgRating!, TARGETS.ratingFloor, TARGETS.ratingTarget),
    notes: [
      ...(ratingN > 0 && ownRatings < ratingN
        ? [`${ratingN - ownRatings} of these came in without the photographer question answered, so the client's overall score for the job is used instead.`]
        : []),
      // Say what was left OUT and why — a score that quietly drops a bad review
      // is as hard to trust as one that wrongly counts it.
      ...(opsOnly.length > 0
        ? [`${opsOnly.length} response${opsOnly.length === 1 ? " was" : "s were"} about editing, turnaround or delivery rather than the shoot, so ${opsOnly.length === 1 ? "it is" : "they are"} not counted here — that work is not yours.`]
        : []),
    ],
  });

  // --- 5) RELIABILITY -------------------------------------------------------
  // The part of "on time" a photographer actually owns: raws in by noon ET the
  // morning after the shoot (the policy is same night; noon absorbs the lag in
  // the Dropbox sweep that stamps uploadedAt), and the wrap-up submitted.
  //
  // Delivery-to-client on-time is NOT scored here. It is mostly the edit and QC
  // lane, and paying a photographer on somebody else's turnaround would make
  // the whole bonus feel arbitrary.
  const datable = shoots.filter(
    (s) => s.shootDate && s.uploadedAt && s.uploadedAt.getTime() >= s.shootDate.getTime(),
  );
  const onTimeRaws = datable.filter((s) => s.uploadedAt!.getTime() <= etAt(nextEtDayKey(etDayKey(s.shootDate!)), 12).getTime());
  const rawsRate = datable.length ? onTimeRaws.length / datable.length : 0;
  const rawsOk = datable.length >= TARGETS.minDatableShoots && (n ? datable.length / n : 0) >= TARGETS.minDatableCoverage;

  const wrapDue = shoots.filter((s) => s.shootDate && s.shootDate.getTime() >= WRAP_UP_REQUIRED_FROM);
  const wrapDone = wrapDue.filter((s) => s.debriefSubmittedAt).length;
  const wrapRate = wrapDue.length ? wrapDone / wrapDue.length : 0;
  const wrapOk = wrapDue.length >= TARGETS.minWrapShoots;

  const relParts: { frac: number; weight: number }[] = [];
  if (rawsOk) relParts.push({ frac: upScale(rawsRate, TARGETS.rawsFloor, TARGETS.rawsTarget), weight: 0.7 });
  if (wrapOk) relParts.push({ frac: upScale(wrapRate, TARGETS.wrapFloor, TARGETS.wrapTarget), weight: 0.3 });
  const relWeight = relParts.reduce((s, p) => s + p.weight, 0);
  const relFraction = relWeight ? relParts.reduce((s, p) => s + p.frac * p.weight, 0) / relWeight : null;
  add({
    key: "reliability",
    label: "Reliability",
    blurb: "Raws in the night of the shoot, and the shoot wrapped up.",
    weight: AREA_WEIGHTS.reliability,
    measured: relFraction != null,
    why: relFraction == null
      ? `Only ${datable.length} of your ${n} shoots have both a shoot time and an upload time — too few to call this either way.`
      : null,
    // Only the parts that are actually SCORED are reported. Quoting an upload
    // rate that was ruled out for thin coverage would put a number on the card
    // that no points came from.
    value: relFraction == null
      ? "Not enough datable shoots"
      : [
          rawsOk ? `${pct(rawsRate)} of raws in on time (${onTimeRaws.length} of ${datable.length})` : null,
          wrapOk ? `${wrapDone} of ${wrapDue.length} wrapped up` : null,
        ].filter(Boolean).join(" · "),
    target: rawsOk && wrapOk
      ? `Full credit at ${pct(TARGETS.rawsTarget)} of shoots uploaded by noon the next day (70% of this area) and wrapped up (30%).`
      : rawsOk
        ? `Full credit at ${pct(TARGETS.rawsTarget)} of shoots uploaded by noon the next day.`
        : `Full credit at ${pct(TARGETS.wrapTarget)} of shoots wrapped up on the upload page.`,
    fraction: relFraction,
    notes: [
      ...(datable.length < n
        ? [`${n - datable.length} shoot${n - datable.length === 1 ? "" : "s"} have no upload time on record and are left out — a missing timestamp is never counted as late.`]
        : []),
      ...(!wrapOk && wrapDue.length > 0
        ? [`${wrapDue.length} shoot${wrapDue.length === 1 ? "" : "s"} since the wrap-up became part of the job — it starts counting at ${TARGETS.minWrapShoots}.`]
        : []),
      "Delivery to the client isn't in here — that's the edit and QC lane, not yours.",
    ],
  });

  // --- 6) REVISION RATE -----------------------------------------------------
  // Every shoot that came back for changes, by any route: the client asked
  // (revisionRequestedAt), an itemised ask was raised (RevisionBrief), or QC
  // was reopened. Counted per SHOOT, not per ask, so one talkative job can't
  // wipe out a quarter.
  //
  // Stated plainly on the page: this includes EDIT revisions, which aren't the
  // photographer's work. That's why full credit runs to 10% and the weight is
  // small — it's a shared number, and it's treated like one.
  const revised = new Set<string>();
  for (const s of shoots) if (s.revisionRequestedAt) revised.add(s.id);
  for (const r of revisionBriefProjects) revised.add(r.projectId);
  for (const r of reopenedQc) revised.add(r.projectId);
  const revisionRate = n ? revised.size / n : 0;
  const revisionThin = n < TARGETS.minShoots;
  add({
    key: "revisions",
    label: "Revision rate",
    blurb: "Shoots that came back for changes after delivery.",
    weight: AREA_WEIGHTS.revisions,
    measured: !revisionThin,
    why: revisionThin ? "Not enough shoots this quarter to judge yet." : null,
    value: revisionThin ? "Not enough shoots" : `${pct(revisionRate)} came back (${revised.size} of ${n})`,
    target: `Full credit at ${pct(TARGETS.revisionGood)} or fewer.`,
    fraction: revisionThin ? null : downScale(revisionRate, TARGETS.revisionGood, TARGETS.revisionBad),
    notes: ["Counts every revision on the job, including edit-side ones — that's why the bar sits at 10% and the weight is small."],
  });

  // --- 7) VOLUME & GROWTH ---------------------------------------------------
  // Against THEIR OWN prior quarter over the same elapsed days. Scored on
  // direction rather than a quota: Jordan books the work, so a photographer
  // can't be held to a number of shoots they don't control — but a growing
  // share of the calendar is a real signal about readiness for more.
  const growth = prevShoots >= TARGETS.minPriorShoots ? n / prevShoots - 1 : null;
  const volumeThin = growth == null;
  add({
    key: "volume",
    label: "Volume & growth",
    blurb: "How your shoot count is moving against your own last quarter.",
    weight: AREA_WEIGHTS.volume,
    measured: !volumeThin,
    why: volumeThin ? `Not enough shoots in ${prevQ.label} (${prevShoots}) to compare against.` : null,
    value: volumeThin
      ? `${n} shoot${n === 1 ? "" : "s"} — no comparable quarter`
      : `${n} shoots vs ${prevShoots} in the same stretch of ${prevQ.label} (${growth! >= 0 ? "+" : ""}${Math.round(growth! * 100)}%)`,
    target: `Full credit at +${Math.round(TARGETS.growthTarget * 100)}% or better on the same stretch of last quarter.`,
    fraction: volumeThin ? null : upScale(growth!, TARGETS.growthFloor, TARGETS.growthTarget),
    notes: provisional
      ? [`Like for like — the first ${elapsedDays} days of each quarter, never a part quarter against a whole one.`]
      : [],
  });

  const visibleWeight = areas.filter((a) => a.measured && a.fraction != null).reduce((s, a) => s + a.weight, 0);
  const thinReason = n < TARGETS.minShoots
    ? `${n} shoot${n === 1 ? "" : "s"} so far this quarter — scoring starts at ${TARGETS.minShoots}.`
    : visibleWeight === 0
      ? "Nothing on the scorecard could be measured for this quarter."
      : visibleWeight < TARGETS.minMeasuredWeight
        ? `Only ${visibleWeight} of the 100 points on your scorecard could be measured — too little to put a number on. The areas below still show where you stand.`
        : null;

  return assembleScorecard({
    memberId: opts.memberId,
    name,
    quarter: q,
    shoots: n,
    areas,
    provisional,
    elapsed,
    thinReason,
  });
}

/**
 * Every active shooting photographer's scorecard for a quarter — the owner
 * roster view reuses this rather than reimplementing any of the maths.
 * Sequential on purpose: this runs behind an owner page, not a hot path, and
 * a parallel fan-out over the shared Neon pool starves the request that needs it.
 */
export async function scoreQuarterRoster(quarter?: QuarterRef, now?: Date): Promise<QuarterScorecard[]> {
  const members = await prisma.teamMember.findMany({
    where: { active: true, role: "PHOTOGRAPHER", payPercent: { not: null } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const out: QuarterScorecard[] = [];
  for (const m of members) out.push(await scoreQuarter({ memberId: m.id, name: m.name, quarter, now }));
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name));
}
