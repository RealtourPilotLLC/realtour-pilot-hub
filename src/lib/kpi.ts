import "server-only";
import { prisma } from "@/lib/prisma";
import { etAt, etDayKey, etDayStartUtc } from "@/lib/datetime";
import { FIRST_BONUS_PERIOD, FIXED_PAY, fixedPayFor } from "@/lib/payStructure";
import { loadEvidence } from "@/lib/kpiEvidence";
import { readReview, readTermsVersions, type KpiDispute, type KpiLogLine, type KpiResolution, type KpiReview, type KpiTermsVersion } from "@/lib/kpiStore";

// ---------------------------------------------------------------------------
// THE CREATIVE TEAM'S KPI SCORECARD AND BONUS (the compensation terms,
// effective Sep 25 2026; rebuilt around them Oct 22 2026).
//
// THE ONLY BONUS ENGINE (Jordan, Oct 21 2026: "One bonus engine: the scorecard
// bands"). Finance → Bonus, the Pay button's server-side recompute
// (app/sales/bonusActions.ts), My Performance and the payout line it writes
// all read scorePeriod() below. Bonus periods that began before the terms
// (2026-Q3 and earlier) keep the rules they were measured under, frozen in
// lib/kpiLegacy.ts: the terms never change criteria retroactively.
//
// WHAT THE TERMS SAY, AND WHERE EACH PART LIVES HERE
//  · Periods: the first runs Sep 25 to Dec 31 2026, then calendar quarters.
//    Settled within 30 days after the period; reviewed monthly (the monthly
//    check-in below, so the quarter's number is never a surprise).
//  · Harrison Wells (Creative Specialist CS3 Advanced): five categories,
//    weights in the terms: Client experience 35, Reliability and communication
//    25, Quality and QC 20, Professionalism 10, Growth and ownership 10. Up to
//    $1,000 a period, paid in Jordan's bands (90+ $1,000, 80-89 $600, 70-79
//    $250, under 70 nothing). Not guaranteed.
//  · James Livingston (Creative Manager): his terms named four subjects and
//    no weights. Jordan wrote them down on Oct 22 2026: "He should be getting
//    KPIs tracked on the same things as Harrison" (the same five categories
//    and weights) and bands of the "same shape scaled up": 90+ $1,500, 80-89
//    $900, 70-79 $375, under 70 nothing. Up to $1,500 a period.
//  · Either person's weights and bands can be changed later from Finance →
//    Bonus (kpi_terms:<harrison|james>, app/sales/bonusActions saveKpiTerms),
//    but only from a period that has not started: never retroactively.
//  · Anyone else the bonus covers gets Harrison's scorecard and bands, capped
//    at $1,000, and the card says no separate terms are on file.
//  · Volume is NOT a category: the terms say growth must not come from
//    shooting more. Photo volume (the raw budget) lives in Quality and QC.
//  · An ordinary client creative revision never counts. Only a revision a
//    reviewer traced to the capture does (preventable), and every entry can
//    be disputed: the creative writes a note, Jordan (or, for Harrison, the
//    creative manager) upholds or removes it with a reason. A dispute changes
//    nothing until it is resolved; a removed entry stops counting.
//
// The rules this file still lives by (Sep 2026):
//  1. NEVER INVENT A NUMBER. An area the hub cannot see enough of yet is
//     marked unmeasured with the reason and left out; the measured categories
//     are scaled to 100 while the period runs, and the card says so. Paying a
//     period needs the owner's check-in categories filled in.
//  2. ONLY SCORE WHAT THE PERSON CONTROLS. Delivery to the client, editing and
//     turnaround are not in here.
//  3. THIS FILE COMPUTES, IT NEVER PAYS. Money moves through the owner's Pay
//     button (a PayoutAdjustment), exactly like every other pay surface.
//
// Pure scoring (areas, categories, bands, impact) is separate from the reads
// (lib/kpiEvidence) and the stored review (lib/kpiStore).
// ---------------------------------------------------------------------------

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const DAY = 86_400_000;

/** Higher is better: 0 at `floor`, full credit at `target`. */
function upScale(v: number, floor: number, target: number): number {
  if (target === floor) return v >= target ? 1 : 0;
  return clamp01((v - floor) / (target - floor));
}
/** Lower is better: full credit at `good` or below, 0 at `bad` or above. */
function downScale(v: number, good: number, bad: number): number {
  return 1 - upScale(v, good, bad);
}
const addDaysKey = (key: string, n: number) => etDayKey(new Date(Date.parse(`${key}T12:00:00Z`) + n * DAY));

// --------------------------------- Bands -----------------------------------

export type BonusBand = {
  min: number;
  amount: number;
  label: string;
  /** The four-across ladder on a phone has ~80px a column. */
  short: string;
};

/** Jordan's bands, verbatim (Harrison, and any creative specialist). High to low. */
export const BONUS_BANDS: BonusBand[] = [
  { min: 90, amount: 1000, label: "90 and above", short: "90+" },
  { min: 80, amount: 600, label: "80 to 89", short: "80–89" },
  { min: 70, amount: 250, label: "70 to 79", short: "70–79" },
  { min: 0, amount: 0, label: "Below 70", short: "Under 70" },
];

/** Harrison's (and a creative specialist's) most per period: $4,000 a year. */
export const MAX_QUARTERLY_BONUS = 1000;

/** Bands from the stored rows (James): labelled the same way, high to low, always ending at 0. */
export function bandsFromRows(rows: { min: number; amount: number }[]): BonusBand[] {
  const sorted = [...rows].sort((a, b) => b.min - a.min);
  if (!sorted.length || sorted[sorted.length - 1].min !== 0) sorted.push({ min: 0, amount: 0 });
  return sorted.map((r, i) => {
    const upper = i === 0 ? null : sorted[i - 1].min - 1;
    return {
      min: r.min,
      amount: r.amount,
      label: i === 0 ? `${r.min} and above` : r.min === 0 ? `Below ${sorted[i - 1].min}` : `${r.min} to ${upper}`,
      short: i === 0 ? `${r.min}+` : r.min === 0 ? `Under ${sorted[i - 1].min}` : `${r.min}–${upper}`,
    };
  });
}

/** The band a score falls in. Banding uses the score AS DISPLAYED (whole number). */
export function bandFor(score: number | null, bands: BonusBand[] = BONUS_BANDS): BonusBand | null {
  if (score == null) return null;
  const shown = Math.round(score);
  return bands.find((b) => shown >= b.min) ?? bands[bands.length - 1];
}

/** The next band up and what it takes to get there; null once they're at the top. */
export function nextBandFor(score: number | null, bands: BonusBand[] = BONUS_BANDS): { band: BonusBand; pointsAway: number } | null {
  if (score == null) return null;
  const shown = Math.round(score);
  const above = [...bands].reverse().find((b) => b.min > shown);
  return above ? { band: above, pointsAway: Math.max(1, above.min - shown) } : null;
}

// -------------------------------- Periods ----------------------------------

export type QuarterRef = { key: string; label: string; startKey: string; endKey: string; start: Date; end: Date };

/** Calendar quarter (ET) containing `dayKey`, or `back` quarters before it. */
export function quarterFor(dayKey?: string, back = 0): QuarterRef {
  const key = dayKey ?? etDayKey(new Date());
  const [y, m] = key.split("-").map(Number);
  let qi = Math.floor((m - 1) / 3) - back;
  let year = y;
  while (qi < 0) { qi += 4; year -= 1; }
  while (qi > 3) { qi -= 4; year += 1; }
  const start = etDayStartUtc(new Date(Date.UTC(year, qi * 3, 1, 12)));
  const end = new Date(etDayStartUtc(new Date(Date.UTC(year, qi * 3 + 3, 1, 12))).getTime() - 1);
  return { key: `${year}-Q${qi + 1}`, label: `Q${qi + 1} ${year}`, startKey: etDayKey(start), endKey: etDayKey(end), start, end };
}

export type KpiPeriod = QuarterRef & {
  /** before the terms: scored by lib/kpiLegacy's seven areas */
  legacy: boolean;
  /** the terms: settled within 30 days after the period */
  settleByKey: string;
};

/** The terms start here (Sep 25 2026). */
export const CONTRACT_START_KEY = FIRST_BONUS_PERIOD.startKey;
/** The first contract period carries its calendar quarter's key: Sep 25 to Dec 31 2026 is "2026-Q4". */
export const FIRST_CONTRACT_KEY = quarterFor(FIRST_BONUS_PERIOD.endKey).key;

function periodOfQuarter(q: QuarterRef): KpiPeriod {
  if (q.key === FIRST_CONTRACT_KEY) {
    const start = etAt(CONTRACT_START_KEY, 0);
    return { ...q, label: "Sep 25 to Dec 31 2026", startKey: CONTRACT_START_KEY, start, legacy: false, settleByKey: addDaysKey(q.endKey, 30) };
  }
  return { ...q, legacy: q.key < FIRST_CONTRACT_KEY, settleByKey: addDaysKey(q.endKey, 30) };
}

/** The bonus period holding an ET day (today by default), or `back` periods before it. */
export function periodFor(dayKey?: string, back = 0): KpiPeriod {
  const key = dayKey ?? etDayKey(new Date());
  // Sep 25 to 30 2026 belong to the first contract period, not to Q3.
  const anchor = key >= CONTRACT_START_KEY && quarterFor(key).key < FIRST_CONTRACT_KEY ? FIRST_BONUS_PERIOD.endKey : key;
  return periodOfQuarter(quarterFor(anchor, back));
}

/** "2026-Q4" back to its period (null when it isn't one). */
export function periodFromKey(key: string): KpiPeriod | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key.trim());
  if (!m) return null;
  return periodOfQuarter(quarterFor(`${m[1]}-${String(Number(m[2]) * 3 - 2).padStart(2, "0")}-15`));
}

/** Kept for older callers: the calendar quarter of a key. */
export function quarterFromKey(key: string): QuarterRef | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key.trim());
  return m ? quarterFor(`${m[1]}-${String(Number(m[2]) * 3 - 2).padStart(2, "0")}-15`) : null;
}

export type KpiMonth = { key: string; label: string; startKey: string; endKey: string };
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthShort = (k: string) => MONTH_NAMES[Number(k.slice(5, 7)) - 1].slice(0, 3);

/** The months a period is checked in by. A short first stretch (Sep 25 to 30) folds into the next month. */
export function periodMonths(p: KpiPeriod): KpiMonth[] {
  const out: KpiMonth[] = [];
  let cursor = p.startKey;
  while (cursor <= p.endKey) {
    const ym = cursor.slice(0, 7);
    const [y, m] = ym.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const endKey = last < p.endKey ? last : p.endKey;
    out.push({ key: ym, label: MONTH_NAMES[m - 1], startKey: cursor, endKey });
    cursor = addDaysKey(endKey, 1);
  }
  if (out.length > 1) {
    const days = (Date.parse(`${out[0].endKey}T12:00:00Z`) - Date.parse(`${out[0].startKey}T12:00:00Z`)) / DAY + 1;
    if (days < 15) {
      const stub = out.shift()!;
      out[0] = { ...out[0], startKey: stub.startKey, label: `${monthShort(stub.startKey)} ${Number(stub.startKey.slice(8))} to ${monthShort(out[0].endKey)} ${Number(out[0].endKey.slice(8))}` };
    }
  }
  return out;
}

// ------------------------------- Categories --------------------------------

/** Where a piece of evidence belongs. */
export type KpiArea = "client" | "reliability" | "quality" | "professionalism" | "growth" | "coaching" | "planning";
export type KpiCategoryKey = "client" | "reliability" | "quality" | "professionalism" | "growth" | "clientQuality" | "coaching" | "planning";

export type KpiCategoryDef = {
  key: KpiCategoryKey;
  label: string;
  /** out of 100; null = not set (James until Jordan saves weights) */
  weight: number | null;
  areas: KpiArea[];
  /** scored by the monthly check-in (a person's score), not by the hub's records */
  checkIn: boolean;
  /** what it covers, in the terms' words */
  covers: string;
  /** where the evidence comes from */
  evidence: string;
  /** what the hub cannot see yet (Jordan adds it as a note) */
  unseen: string | null;
};

const CLIENT_DEF = {
  covers: "Clients feel taken care of, listened to and guided: confident, not rushed, with enough creative direction.",
  evidence: "Client ratings and comments on your shoots: the feedback form, and texts and emails the hub files as feedback. A complaint about the shoot counts as a 2 of 5 and a compliment as a 5 when the client gave no rating. Anything about editing, turnaround or delivery is left out.",
  unseen: "Repeat requests for you and concerns raised in person: Jordan adds these as notes.",
};
const RELIABILITY_DEF = {
  covers: "Uploads and notes on time, complete instructions and a proper handoff, showing up, owning the schedule, telling the office about delays early, responsiveness and follow-through.",
  evidence: "The upload page's submit time for each half against the deadline in the terms (photos and photo notes by midnight on the shoot day, video and video notes by 9:00 AM the next morning), what Dropbox showed, and the handoff engine's check of the video instructions.",
  unseen: "Meeting attendance, arriving on time and responsiveness: Jordan adds these as notes.",
};
const QUALITY_DEF = {
  covers: "Technical quality, complete coverage, following the client's and the property's instructions, correct deliverables, sensible photo volume, no avoidable misses or reshoots.",
  evidence: "Fix notes and photo flags from review, revisions a reviewer traced to the capture, client texts and emails saying a photo or shot is missing (missed coverage; a request for an extra or different shot is not a miss, and an unclear one waits for Jordan), and the raw photo count against the budget for the home's size. Coaching notes and ordinary client revisions never count.",
  unseen: "Drone completion, framing and color consistency across a set: Jordan adds these as notes.",
};

/** Harrison's five categories and weights, from the terms. They add to 100. */
export const HARRISON_CATEGORIES: KpiCategoryDef[] = [
  { key: "client", label: "Client experience", weight: 35, areas: ["client"], checkIn: false, ...CLIENT_DEF },
  { key: "reliability", label: "Reliability and communication", weight: 25, areas: ["reliability"], checkIn: false, ...RELIABILITY_DEF },
  { key: "quality", label: "Quality and QC", weight: 20, areas: ["quality"], checkIn: false, ...QUALITY_DEF },
  {
    key: "professionalism", label: "Professionalism", weight: 10, areas: ["professionalism"], checkIn: true,
    covers: "Appearance, conduct with clients, energy, respectful communication, care for the client's property, keeping personal issues away from clients, representing the company.",
    evidence: "A monthly check-in score from Jordan (0 to 100) with a note; the category is the average of the months checked in.",
    unseen: null,
  },
  {
    key: "growth", label: "Growth and ownership", weight: 10, areas: ["growth"], checkIn: true,
    covers: "Applying feedback, improving weak spots, training, owning mistakes, Premium Video capability, creative direction, attention to detail, problem solving, helping the team, readiness for CS4.",
    evidence: "A monthly check-in score from Jordan (0 to 100) with a note; the category is the average of the months checked in.",
    unseen: null,
  },
];

/**
 * James's payout bands (Jordan, Oct 22 2026: "same shape scaled up"): 90 and
 * above $1,500, 80 to 89 $900, 70 to 79 $375, under 70 nothing. His terms
 * named four subjects and no weights; Jordan's answer the same day: "He should
 * be getting KPIs tracked on the same things as Harrison", so James is scored
 * on Harrison's five categories and weights (HARRISON_CATEGORIES).
 */
export const JAMES_BANDS: BonusBand[] = bandsFromRows([
  { min: 90, amount: 1500 },
  { min: 80, amount: 900 },
  { min: 70, amount: 375 },
]);

export type KpiPersonKey = "harrison" | "james" | "specialist";

export type KpiTerms = {
  personKey: KpiPersonKey;
  role: string;
  /** the most the bonus can pay in one period */
  cap: number;
  categories: KpiCategoryDef[];
  bands: BonusBand[];
  /** a change Jordan saved for this period onward (null = the terms as agreed) */
  version: Pick<KpiTermsVersion, "fromPeriodKey" | "savedAt" | "savedBy" | "note"> | null;
};

/** The person keys whose weights and bands Jordan can change, prospectively. */
export const KPI_TERMS_PEOPLE: readonly ("harrison" | "james")[] = ["harrison", "james"];

/** The terms as agreed, before any change Jordan saves for a later period. */
function baseTerms(personKey: KpiPersonKey): Omit<KpiTerms, "version"> {
  if (personKey === "james") return { personKey, role: "Creative Manager", cap: FIXED_PAY.james.bonusMax, categories: HARRISON_CATEGORIES, bands: JAMES_BANDS };
  if (personKey === "harrison") return { personKey, role: "Creative Specialist CS3 Advanced", cap: FIXED_PAY.harrison.bonusMax, categories: HARRISON_CATEGORIES, bands: BONUS_BANDS };
  return {
    personKey,
    role: "Creative specialist (no separate terms on file: Harrison's scorecard and bands apply)",
    cap: MAX_QUARTERLY_BONUS,
    categories: HARRISON_CATEGORIES,
    bands: BONUS_BANDS,
  };
}

/** The stored version that applies to a period: the newest one starting on or before it. */
export function termsVersionFor(versions: KpiTermsVersion[], period: KpiPeriod): KpiTermsVersion | null {
  const live = versions
    .map((v) => ({ v, p: periodFromKey(v.fromPeriodKey) }))
    .filter((x): x is { v: KpiTermsVersion; p: KpiPeriod } => !!x.p && x.p.startKey <= period.startKey)
    .sort((a, b) => a.p.startKey.localeCompare(b.p.startKey) || a.v.savedAt.localeCompare(b.v.savedAt));
  return live.length ? live[live.length - 1].v : null;
}

/** Apply a saved version (weights and bands) on top of the agreed terms (pure). */
export function applyTermsVersion(base: Omit<KpiTerms, "version">, v: KpiTermsVersion | null): KpiTerms {
  if (!v) return { ...base, version: null };
  return {
    ...base,
    categories: base.categories.map((c) => ({ ...c, weight: Number(v.weights[c.key] ?? c.weight ?? 0) })),
    bands: bandsFromRows(v.bands.map((b) => ({ min: b.min, amount: Math.min(b.amount, base.cap) }))),
    version: { fromPeriodKey: v.fromPeriodKey, savedAt: v.savedAt, savedBy: v.savedBy, note: v.note },
  };
}

/** Whose terms a roster row is on, for a period: the agreed terms, or a change Jordan saved from an earlier period onward. */
export async function termsFor(member: { name: string | null; active: boolean | null }, period: KpiPeriod): Promise<KpiTerms> {
  const fp = fixedPayFor(member);
  const personKey: KpiPersonKey = fp?.key ?? "specialist";
  const base = baseTerms(personKey);
  if (personKey === "specialist") return { ...base, version: null };
  return applyTermsVersion(base, termsVersionFor(await readTermsVersions(personKey), period));
}

/** The agreed terms for a person key (no saved change), for forms and checks. */
export function agreedTerms(personKey: KpiPersonKey): Omit<KpiTerms, "version"> {
  return baseTerms(personKey);
}

// --------------------------------- Entries ---------------------------------

export type KpiEntryKind =
  | "late_photos" | "late_video" | "instructions" | "brief_gap"
  | "qc_fix" | "qc_flag" | "capture_revision" | "over_budget" | "missed_coverage"
  | "client_rating" | "complaint" | "compliment"
  | "client_revision" | "ops_feedback" | "extra_request"
  | "manual";

/** One piece of evidence, as the hub (or Jordan) recorded it. */
export type KpiEntryBase = {
  /** stable: the same record always gives the same id ("late-video:<projectId>") */
  id: string;
  kind: KpiEntryKind;
  area: KpiArea;
  /** ET day it belongs to: decides the period and the month */
  day: string;
  /** ISO, when it happened */
  at: string;
  title: string;
  /** the evidence, one plain sentence a line */
  detail: string[];
  projectId: string | null;
  effect: "against" | "for" | "neutral";
  /** worked out by the hub (false = an owner's entry) */
  auto: boolean;
  /** shown, but counts only once the owner says it does */
  advisory: boolean;
  /** client entries: the 1 to 5 value that goes into the average */
  value?: number;
  /** manual entries: signed points on the category's 100 */
  points?: number;
  /** manual entries: the owner's note as typed */
  note?: string;
  by?: string;
};

export type KpiEntryStatus = "counts" | "disputed" | "upheld" | "removed" | "advisory" | "not_counted";

export type KpiEntry = KpiEntryBase & {
  counts: boolean;
  status: KpiEntryStatus;
  dispute: KpiDispute | null;
  resolution: KpiResolution | null;
  /** the category on this person's card */
  category: KpiCategoryKey | null;
  /** points of the total score this entry moves (negative costs); null when there is no score */
  impact: number | null;
};

/** What the hub knows about one shoot, for the rates. */
export type ShootFact = {
  projectId: string;
  street: string;
  day: string;
  /** their upload page (late uploads and instructions apply to them) */
  owner: boolean;
  /** halves whose deadline has passed or that were handed in */
  halvesJudged: number;
  /** a video half that owes instructions was handed in */
  videoHandoff: boolean;
  /** has a raw photo count */
  cullCounted: boolean;
  noSqft: boolean;
  /** someone reviewed it (any review note) */
  reviewed: boolean;
};

const NEVER_SCORES: KpiEntryKind[] = ["client_revision", "ops_feedback", "extra_request"];

/** The review state on top of the hub's entries (pure). */
export function applyReview(base: KpiEntryBase[], review: Pick<KpiReview, "reviews">): KpiEntry[] {
  return base.map((e) => {
    const r = review.reviews[e.id] ?? {};
    const dispute = r.dispute ?? null;
    const resolution = r.resolution ?? null;
    const scorable = !NEVER_SCORES.includes(e.kind) && !(e.kind === "manual" && !e.points);
    let counts = true;
    let status: KpiEntryStatus = "counts";
    if (!scorable) { counts = false; status = "not_counted"; }
    else if (resolution?.outcome === "removed") { counts = false; status = "removed"; }
    else if (resolution?.outcome === "upheld") { counts = true; status = "upheld"; }
    else if (e.advisory) { counts = false; status = "advisory"; }
    else if (dispute) { counts = true; status = "disputed"; }
    return { ...e, counts, status, dispute, resolution, category: null, impact: null };
  });
}

/** The owner's manual entries as entries. */
export function manualEntries(review: Pick<KpiReview, "manual">): KpiEntryBase[] {
  return review.manual.map((m) => ({
    id: `manual:${m.id}`,
    kind: "manual" as const,
    area: m.area as KpiArea,
    day: m.day,
    at: m.at,
    title: m.title,
    detail: [
      m.note,
      m.projectLabel ? `Job: ${m.projectLabel}.` : "",
      m.points ? `${m.points > 0 ? "Adds" : "Takes off"} ${Math.abs(m.points)} point${Math.abs(m.points) === 1 ? "" : "s"} of this category's 100.` : "A note: it does not score.",
      `Added by ${m.by}${m.editedAt ? `, last edited ${m.editedBy ?? ""}`.trimEnd() : ""}.`,
    ].filter(Boolean),
    projectId: m.projectId,
    effect: m.points > 0 ? ("for" as const) : m.points < 0 ? ("against" as const) : ("neutral" as const),
    auto: false,
    advisory: false,
    points: m.points,
    note: m.note,
    by: m.by,
  }));
}

// ------------------------------ Pure scoring -------------------------------

const T = {
  uploadsFloor: 0.6, uploadsTarget: 0.95, minUploads: 6,
  instrFloor: 0.6, instrTarget: 0.95, minVideoHandoffs: 3,
  issuesPer10Good: 0.5, issuesPer10Bad: 3.0, minReviewCoverage: 0.25,
  cullFloor: 0.5, cullTarget: 0.95,
  ratingFloor: 3.5, ratingTarget: 4.8, minRatings: 4,
  minShoots: 5,
  // A score built from too little of the card is two numbers wearing a
  // score's clothes: below this many of the 100 points, the headline is withheld.
  minMeasuredWeight: 40,
};
export const KPI_TARGETS = T;

type Window = { startKey: string; endKey: string };
const inWin = (day: string, w: Window) => day >= w.startKey && day <= w.endKey;

export type CheckInRow = { monthKey: string; label: string; startKey: string; endKey: string; scores: Partial<Record<KpiArea, number>>; note: string; by: string; at: string };

export type AreaResult = {
  area: KpiArea;
  fraction: number | null;
  actual: string;
  target: string;
  why: string | null;
  notes: string[];
};

type Ctx = { shoots: ShootFact[]; checkIns: CheckInRow[]; coachingNotes: number };

/** Every evidence area over one window (pure). */
export function scoreAreas(ctx: Ctx, entries: KpiEntry[], w: Window): Record<KpiArea, AreaResult> {
  const sw = ctx.shoots.filter((s) => inWin(s.day, w));
  const n = sw.length;
  const ew = entries.filter((e) => inWin(e.day, w));
  const counted = (kinds: KpiEntryKind[]) => ew.filter((e) => e.counts && kinds.includes(e.kind));
  const manualAdj = (area: KpiArea) => counted(["manual"]).filter((e) => e.area === area).reduce((s, e) => s + (e.points ?? 0), 0);
  const withManual = (area: KpiArea, f: number | null, notes: string[]): number | null => {
    const adj = manualAdj(area);
    if (adj && f != null) notes.push(`Jordan's notes move this ${adj > 0 ? "up" : "down"} ${Math.abs(adj)} point${Math.abs(adj) === 1 ? "" : "s"} of 100.`);
    if (adj && f == null) notes.push("Jordan's notes here count once the category can be scored.");
    return f == null ? null : clamp01(f + adj / 100);
  };
  const out = {} as Record<KpiArea, AreaResult>;

  // RELIABILITY AND COMMUNICATION
  {
    const own = sw.filter((s) => s.owner);
    const due = own.reduce((s, x) => s + x.halvesJudged, 0);
    const late = Math.min(due, counted(["late_photos", "late_video"]).length);
    const vids = own.filter((s) => s.videoHandoff).length;
    const miss = Math.min(vids, new Set(counted(["instructions", "brief_gap"]).map((e) => e.projectId)).size);
    const parts: { f: number; w: number }[] = [];
    if (due >= T.minUploads) parts.push({ f: upScale((due - late) / due, T.uploadsFloor, T.uploadsTarget), w: 0.7 });
    if (vids >= T.minVideoHandoffs) parts.push({ f: upScale((vids - miss) / vids, T.instrFloor, T.instrTarget), w: 0.3 });
    const wsum = parts.reduce((s, p) => s + p.w, 0);
    const notes: string[] = [];
    if (due > 0 && due < T.minUploads) notes.push(`${due} upload${due === 1 ? "" : "s"} due so far; uploads start counting at ${T.minUploads}.`);
    if (vids > 0 && vids < T.minVideoHandoffs) notes.push(`${vids} video handoff${vids === 1 ? "" : "s"} so far; instructions start counting at ${T.minVideoHandoffs}.`);
    out.reliability = {
      area: "reliability",
      fraction: withManual("reliability", wsum ? parts.reduce((s, p) => s + p.f * p.w, 0) / wsum : null, notes),
      actual: [
        due ? `${due - late} of ${due} uploads on time (${late} late)` : "No uploads due yet",
        vids ? `instructions complete on ${vids - miss} of ${vids} video handoffs` : null,
      ].filter(Boolean).join(" · "),
      target: `Full credit at ${pct(T.uploadsTarget)} of uploads on time and ${pct(T.instrTarget)} of video handoffs with complete instructions. Uploads are 70% of this category, instructions 30%.`,
      why: wsum ? null : "Not enough uploads due or video handoffs yet to score.",
      notes,
    };
  }

  // QUALITY AND QC
  {
    const issues = counted(["qc_fix", "qc_flag", "capture_revision", "missed_coverage"]).length;
    const reviewed = sw.filter((s) => s.reviewed).length;
    const coverage = n ? reviewed / n : 0;
    const cull = sw.filter((s) => s.cullCounted).length;
    const over = Math.min(cull, new Set(counted(["over_budget"]).map((e) => e.projectId)).size);
    const parts: { f: number; w: number }[] = [];
    const issuesOk = n >= T.minShoots && coverage >= T.minReviewCoverage;
    if (issuesOk) parts.push({ f: downScale((issues / n) * 10, T.issuesPer10Good, T.issuesPer10Bad), w: 0.6 });
    if (cull >= T.minShoots) parts.push({ f: upScale((cull - over) / cull, T.cullFloor, T.cullTarget), w: 0.4 });
    const wsum = parts.reduce((s, p) => s + p.w, 0);
    const notes: string[] = [];
    if (ctx.coachingNotes > 0) notes.push(`${ctx.coachingNotes} coaching note${ctx.coachingNotes === 1 ? "" : "s"} this period: those are for next time and never count.`);
    const clientAsks = ew.filter((e) => e.kind === "client_revision").length;
    if (clientAsks) notes.push(`${clientAsks} shoot${clientAsks === 1 ? "" : "s"} came back for ordinary client changes: never counted.`);
    if (n >= T.minShoots && !issuesOk) notes.push(`Only ${reviewed} of ${n} shoots were reviewed, too few to judge fixes: "no notes" would mean nobody looked.`);
    const noSqft = sw.filter((s) => s.noSqft).length;
    if (noSqft) notes.push(`${noSqft} home${noSqft === 1 ? " has" : "s have"} no square footage on file, so the standard tier sets the budget; tell Jordan if one was a big house.`);
    out.quality = {
      area: "quality",
      fraction: withManual("quality", wsum ? parts.reduce((s, p) => s + p.f * p.w, 0) / wsum : null, notes),
      actual: [
        n ? `${issues} fix${issues === 1 ? "" : "es"} on ${n} shoot${n === 1 ? "" : "s"} (${((n ? issues / n : 0) * 10).toFixed(1)} per 10)` : "No shoots yet",
        cull ? `${cull - over} of ${cull} inside the raw budget` : null,
      ].filter(Boolean).join(" · "),
      target: `Full credit at ${T.issuesPer10Good} or fewer fixes per 10 shoots (60% of this category, judged once ${pct(T.minReviewCoverage)} of shoots are reviewed) and ${pct(T.cullTarget)} of shoots inside the raw budget (40%).`,
      why: wsum ? null : n < T.minShoots ? `${n} shoot${n === 1 ? "" : "s"} so far; quality is judged from ${T.minShoots}.` : "Not enough reviewed or counted shoots yet.",
      notes,
    };
  }

  // CLIENT EXPERIENCE
  {
    const vals = counted(["client_rating", "complaint", "compliment"]).map((e) => e.value ?? 0);
    const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    const ok = avg != null && vals.length >= T.minRatings;
    const notes: string[] = [];
    const ops = ew.filter((e) => e.kind === "ops_feedback").length;
    if (ops) notes.push(`${ops} response${ops === 1 ? " was" : "s were"} about editing, turnaround or delivery and ${ops === 1 ? "is" : "are"} not counted: that work is not yours.`);
    out.client = {
      area: "client",
      fraction: withManual("client", ok ? upScale(avg!, T.ratingFloor, T.ratingTarget) : null, notes),
      actual: avg == null ? "No client ratings yet" : `${avg.toFixed(2)} of 5 across ${vals.length} rating${vals.length === 1 ? "" : "s"} and comments`,
      target: `Full credit at an average of ${T.ratingTarget} of 5. Counts from ${T.minRatings} ratings, so one review cannot swing it.`,
      why: ok ? null : vals.length === 0 ? "No client has rated or commented on one of your shoots in this period yet." : `${vals.length} so far; ${T.minRatings} are needed before it counts.`,
      notes,
    };
  }

  // CHECK-IN AREAS
  for (const area of ["professionalism", "growth", "coaching", "planning"] as const) {
    const months = ctx.checkIns.filter((c) => c.startKey <= w.endKey && c.endKey >= w.startKey && typeof c.scores[area] === "number");
    const scores = months.map((c) => Math.max(0, Math.min(100, c.scores[area]!)));
    const avg = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
    const notes: string[] = [];
    out[area] = {
      area,
      fraction: withManual(area, avg == null ? null : avg / 100, notes),
      actual: avg == null ? "No check-in yet" : `${Math.round(avg)} of 100 (${months.map((c) => `${c.label} ${Math.round(c.scores[area]!)}`).join(", ")})`,
      target: "Jordan's monthly check-in score out of 100, with a note. The category is the average of the months checked in.",
      why: avg == null ? "Jordan has not entered a check-in score for this yet." : null,
      notes,
    };
  }
  return out;
}

export type KpiCategoryScore = KpiCategoryDef & {
  measured: boolean;
  fraction: number | null;
  /** of the total's 100, after scaling over what is measured */
  points: number;
  maxPoints: number;
  actual: string;
  target: string;
  why: string | null;
  notes: string[];
};

type Assembled = { categories: KpiCategoryScore[]; score: number | null; measuredWeight: number; thinReason: string | null };

/** Categories and the total for one window (pure). */
export function assemble(terms: Pick<KpiTerms, "categories">, ctx: Ctx, entries: KpiEntry[], w: Window): Assembled {
  const areas = scoreAreas(ctx, entries, w);
  const n = ctx.shoots.filter((s) => inWin(s.day, w)).length;
  const cats = terms.categories.map((c) => {
    const rs = c.areas.map((a) => areas[a]);
    const live = rs.filter((r) => r.fraction != null);
    const fraction = live.length ? live.reduce((s, r) => s + r.fraction!, 0) / live.length : null;
    return {
      ...c,
      measured: fraction != null,
      fraction,
      points: 0,
      maxPoints: 0,
      actual: rs.map((r) => r.actual).join(" · "),
      target: rs.map((r) => r.target).join(" "),
      why: fraction == null ? rs.map((r) => r.why).filter(Boolean).join(" ") || null : null,
      notes: rs.flatMap((r) => r.notes),
    };
  });
  const measuredWeight = cats.filter((c) => c.measured).reduce((s, c) => s + (c.weight ?? 0), 0);
  const thinReason = n < T.minShoots
    ? `${n} shoot${n === 1 ? "" : "s"} so far this period: scoring starts at ${T.minShoots}.`
    : measuredWeight === 0
      ? "Nothing on the scorecard can be measured for this period yet."
      : measuredWeight < T.minMeasuredWeight
        ? `Only ${measuredWeight} of the 100 points can be measured yet, too little to put a number on. The categories below still show where you stand.`
        : null;
  const scoreable = !thinReason && measuredWeight > 0;
  for (const c of cats) {
    if (!scoreable || !c.measured || !c.weight) continue;
    c.maxPoints = round1((c.weight / measuredWeight) * 100);
    c.points = round1(c.maxPoints * clamp01(c.fraction ?? 0));
  }
  const score = scoreable ? round1(cats.reduce((s, c) => s + c.points, 0)) : null;
  return { categories: cats, score, measuredWeight, thinReason };
}

// -------------------------------- Scorecard --------------------------------

export type KpiMonthView = {
  month: KpiMonth;
  /** the month on its own */
  shoots: number;
  uploadsDue: number;
  late: number;
  videoHandoffs: number;
  instructionsMissing: number;
  fixes: number;
  ratings: { n: number; avg: number | null };
  overBudget: number;
  checkIn: CheckInRow | null;
  /** the period so far, at the end of this month: what it would pay if the period ended then */
  scoreToDate: number | null;
  bonusToDate: number | null;
  started: boolean;
};

export type KpiScorecard = {
  memberId: string;
  name: string;
  period: KpiPeriod;
  terms: KpiTerms;
  shoots: number;
  score: number | null;
  band: BonusBand | null;
  /** dollars this score is worth today, capped */
  bonus: number;
  /** the most it can pay this period */
  possible: number;
  next: { band: BonusBand; pointsAway: number } | null;
  categories: (KpiCategoryScore & { entries: KpiEntry[]; openDisputes: number })[];
  /** the shoots in the period so far, newest first (the job picker for a hand-added entry) */
  shootList: { projectId: string; street: string; day: string }[];
  /** every entry, newest first (the not-counted context ones included) */
  entries: KpiEntry[];
  months: KpiMonthView[];
  provisional: boolean;
  elapsed: number;
  thinReason: string | null;
  measuredWeight: number;
  openDisputes: number;
  /** "Professionalism: no check-in for November" */
  checkInGaps: string[];
  log: KpiLogLine[];
};

/** Turn the evidence, the review and the terms into the card (pure). */
export function buildScorecard(input: {
  memberId: string;
  name: string;
  period: KpiPeriod;
  terms: KpiTerms;
  now: Date;
  shoots: ShootFact[];
  coachingNotes: number;
  entries: KpiEntryBase[];
  review: KpiReview;
}): KpiScorecard {
  const { period, terms, now } = input;
  const windowEnd = now < period.end ? now : period.end;
  const windowEndKey = etDayKey(windowEnd);
  const provisional = now < period.end;
  const elapsed = clamp01((windowEnd.getTime() - period.start.getTime()) / (period.end.getTime() - period.start.getTime()));
  const months = periodMonths(period);
  const checkIns: CheckInRow[] = months
    .map((m) => {
      const c = input.review.checkIns[m.key];
      return c ? { monthKey: m.key, label: m.label, startKey: m.startKey, endKey: m.endKey, scores: c.scores as Partial<Record<KpiArea, number>>, note: c.note, by: c.by, at: c.at } : null;
    })
    .filter((x): x is CheckInRow => !!x);
  const ctx: Ctx = { shoots: input.shoots, checkIns, coachingNotes: input.coachingNotes };
  const entries = applyReview([...input.entries, ...manualEntries(input.review)], input.review);
  const catOf = new Map<KpiArea, KpiCategoryKey>();
  for (const c of terms.categories) for (const a of c.areas) catOf.set(a, c.key);
  for (const e of entries) e.category = catOf.get(e.area) ?? null;

  const win = { startKey: period.startKey, endKey: windowEndKey < period.endKey ? windowEndKey : period.endKey };
  const main = assemble(terms, ctx, entries, win);

  // What each entry moves: the score with it flipped, minus the score as it is.
  if (main.score != null) {
    for (const e of entries) {
      if (e.status === "not_counted" || e.status === "removed") continue;
      const flipped = entries.map((x) => (x === e ? { ...x, counts: !x.counts } : x));
      const s = assemble(terms, ctx, flipped, win).score;
      if (s == null) continue;
      // Counting: what it costs (or adds). Advisory: what it would cost if counted.
      e.impact = e.counts ? round1(main.score - s) : round1(s - main.score);
    }
  }

  const band = bandFor(main.score, terms.bands);
  const bonus = band ? Math.min(band.amount, terms.cap) : 0;

  const monthViews: KpiMonthView[] = months.map((m) => {
    const started = m.startKey <= windowEndKey;
    const mw = { startKey: m.startKey, endKey: m.endKey < win.endKey ? m.endKey : win.endKey };
    const sw = input.shoots.filter((s) => inWin(s.day, mw));
    const ew = entries.filter((e) => inWin(e.day, mw) && e.counts);
    const own = sw.filter((s) => s.owner);
    const vals = ew.filter((e) => ["client_rating", "complaint", "compliment"].includes(e.kind)).map((e) => e.value ?? 0);
    const toDate = started ? assemble(terms, ctx, entries, { startKey: period.startKey, endKey: mw.endKey }).score : null;
    const b = toDate != null ? bandFor(toDate, terms.bands) : null;
    return {
      month: m,
      shoots: sw.length,
      uploadsDue: own.reduce((s, x) => s + x.halvesJudged, 0),
      late: ew.filter((e) => e.kind === "late_photos" || e.kind === "late_video").length,
      videoHandoffs: own.filter((s) => s.videoHandoff).length,
      instructionsMissing: new Set(ew.filter((e) => e.kind === "instructions" || e.kind === "brief_gap").map((e) => e.projectId)).size,
      fixes: ew.filter((e) => ["qc_fix", "qc_flag", "capture_revision", "missed_coverage"].includes(e.kind)).length,
      ratings: { n: vals.length, avg: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null },
      overBudget: ew.filter((e) => e.kind === "over_budget").length,
      checkIn: checkIns.find((c) => c.monthKey === m.key) ?? null,
      scoreToDate: toDate,
      bonusToDate: b ? Math.min(b.amount, terms.cap) : null,
      started,
    };
  });

  const checkInGaps: string[] = [];
  for (const c of terms.categories.filter((x) => x.checkIn)) {
    for (const mv of monthViews.filter((x) => x.started && x.month.endKey < windowEndKey)) {
      const a = c.areas[0];
      if (typeof mv.checkIn?.scores[a] !== "number") checkInGaps.push(`${c.label}: no check-in for ${mv.month.label}`);
    }
  }

  const sorted = [...entries].sort((a, b) => b.day.localeCompare(a.day) || b.at.localeCompare(a.at));
  const categories = main.categories.map((c) => {
    const ce = sorted.filter((e) => e.category === c.key);
    return { ...c, entries: ce, openDisputes: ce.filter((e) => e.status === "disputed").length };
  });
  return {
    memberId: input.memberId,
    name: input.name,
    period,
    terms,
    shoots: input.shoots.filter((s) => inWin(s.day, win)).length,
    shootList: input.shoots
      .filter((s) => inWin(s.day, win))
      .sort((a, b) => b.day.localeCompare(a.day))
      .map((s) => ({ projectId: s.projectId, street: s.street, day: s.day })),
    score: main.score,
    band,
    bonus,
    possible: terms.cap,
    next: nextBandFor(main.score, terms.bands),
    categories,
    entries: sorted,
    months: monthViews,
    provisional,
    elapsed,
    thinReason: main.thinReason,
    measuredWeight: main.measuredWeight,
    openDisputes: entries.filter((e) => e.status === "disputed").length,
    checkInGaps,
    log: input.review.log,
  };
}

/**
 * Score one person over one contract period. Reads only; nothing here writes.
 * A pre-contract period is lib/kpiLegacy's (scoreLegacyQuarter).
 */
export async function scorePeriod(opts: { memberId: string; name?: string; period?: KpiPeriod; now?: Date }): Promise<KpiScorecard> {
  const now = opts.now ?? new Date();
  const period = opts.period ?? periodFor(etDayKey(now));
  if (period.legacy) throw new Error(`${period.label} predates the terms: it is scored by the old scorecard.`);
  const windowEnd = now < period.end ? now : period.end;
  const [member, review] = await Promise.all([
    prisma.teamMember.findUnique({ where: { id: opts.memberId }, select: { name: true, active: true } }),
    readReview(opts.memberId, period.key),
  ]);
  const terms = await termsFor(member ?? { name: opts.name ?? null, active: false }, period);
  const ev = await loadEvidence(opts.memberId, { startKey: period.startKey, endKey: period.endKey, start: period.start, windowEnd }, now);
  return buildScorecard({
    memberId: opts.memberId,
    name: opts.name ?? member?.name ?? "You",
    period,
    terms,
    now,
    shoots: ev.shoots,
    coachingNotes: ev.coachingNotes,
    entries: ev.entries,
    review,
  });
}

/** Can the owner pay this card now? The same checks the Pay button's server action makes. */
export function payReadiness(card: KpiScorecard, now: Date = new Date()): { ok: boolean; why: string | null } {
  if (card.period.end.getTime() >= now.getTime()) return { ok: false, why: `${card.period.label} is still running. Pay it once it closes.` };
  if (card.openDisputes > 0) return { ok: false, why: `${card.openDisputes} open dispute${card.openDisputes === 1 ? "" : "s"}: resolve ${card.openDisputes === 1 ? "it" : "them"} first.` };
  const missing = card.categories.filter((c) => c.checkIn && !c.measured).map((c) => c.label);
  if (missing.length) return { ok: false, why: `Enter a check-in score for ${missing.join(" and ")} first.` };
  if (card.score == null) return { ok: false, why: card.thinReason ?? "No score for this period." };
  if (card.bonus <= 0) return { ok: false, why: `Nothing to pay for ${card.period.label}.` };
  return { ok: true, why: null };
}

// ------------------------------ Roster + legacy -----------------------------

/**
 * WHO THE BONUS COVERS. Active shooting creatives on the roster (role
 * PHOTOGRAPHER, or a MANAGER flagged as the creative manager), never the
 * owner. The owner is recognised by the roster row his OWNER login is linked
 * to, and by name for a login never linked. Unchanged since Oct 21 2026.
 */
export async function bonusRoster(): Promise<{ id: string; name: string }[]> {
  const [members, ownerLogins] = await Promise.all([
    prisma.teamMember.findMany({
      where: { active: true, OR: [{ role: "PHOTOGRAPHER" }, { role: "MANAGER", creativeManager: true }] },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.appUser.findMany({ where: { role: "OWNER", teamMemberId: { not: null } }, select: { teamMemberId: true } }),
  ]);
  const owner = new Set(ownerLogins.map((u) => u.teamMemberId));
  return members.filter((m) => !owner.has(m.id) && !/^jordan\b/i.test(m.name.trim()));
}

/**
 * Every bonus-eligible creative's card for a contract period, best first.
 * Sequential on purpose: an owner page, not a hot path, and a parallel
 * fan-out over the shared Neon pool starves the request that needs it.
 */
export async function scorePeriodRoster(period?: KpiPeriod, now?: Date): Promise<KpiScorecard[]> {
  const members = await bonusRoster();
  const out: KpiScorecard[] = [];
  for (const m of members) out.push(await scorePeriod({ memberId: m.id, name: m.name, period, now }));
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name));
}

/** A pre-contract quarter, by the rules it was measured under (lib/kpiLegacy). */
export async function scoreLegacyQuarter(memberId: string, period: KpiPeriod, name?: string, now?: Date) {
  const legacy = await import("@/lib/kpiLegacy");
  return legacy.scoreQuarter({ memberId, name, quarter: legacy.quarterFromKey(period.key) ?? undefined, now });
}
export async function scoreLegacyRoster(period: KpiPeriod, now?: Date) {
  const legacy = await import("@/lib/kpiLegacy");
  return legacy.scoreQuarterRoster(legacy.quarterFromKey(period.key) ?? undefined, now);
}

/** Open disputes on other people's cards that this reviewer may resolve (the creative manager's list). */
export async function openDisputesFor(reviewerMemberId: string | null, period: KpiPeriod = periodFor()): Promise<{ card: KpiScorecard; entries: KpiEntry[] }[]> {
  if (period.legacy) return [];
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: "kpi_review:", endsWith: `:${period.key}` } }, select: { key: true, value: true } });
  const roster = await bonusRoster();
  const out: { card: KpiScorecard; entries: KpiEntry[] }[] = [];
  for (const r of rows) {
    const memberId = r.key.split(":")[1];
    if (!memberId || memberId === reviewerMemberId) continue;
    if (!/"dispute"/.test(r.value)) continue;
    const m = roster.find((x) => x.id === memberId);
    if (!m) continue;
    const card = await scorePeriod({ memberId, name: m.name, period });
    // The creative manager reviews the creative specialists' entries, never
    // another manager's (the terms name the manager for Harrison's).
    if (card.terms.personKey === "james") continue;
    const open = card.entries.filter((e) => e.status === "disputed");
    if (open.length) out.push({ card, entries: open });
  }
  return out;
}
