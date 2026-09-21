import "server-only";
import { etDayKey, etAt, endOfBusinessDaysET } from "@/lib/datetime";
import type { TurnaroundRules } from "@/lib/settings";

// ---------------------------------------------------------------------------
// WHEN IS IT DUE — Jordan's turnaround promises, in one place.
//
// Verbatim from him:
//   "We always need to deliver the next day unless it was a premium reel.
//    Premium Reels are due in 3-4 days. Monthly Social Content like Video
//    Starter, Video Accelerator, and Video Pro are always due within 7-10
//    BUSINESS days. Standard Videos within 48hrs. Photos, floor plans, Zillow
//    Showcase 3D Tour, virtual staging, all due the next day."
//
// The important consequence: a DUE DATE BELONGS TO A DELIVERABLE, NOT A JOB.
// A shoot with photos and a premium reel owes the photos tomorrow and the reel
// in four days. Rolling that up to one project date would either make the whole
// job look late the day after the shoot, or hide the photos being overdue behind
// the reel's longer clock. So every ordered item is dated on its own, and the
// job shows the EARLIEST thing still outstanding.
//
// The clock starts at the shoot, because that's when we take possession of the
// work. Monthly social content often has no shoot of its own, so it falls back
// to the order date.
//
// PREMIUM REELS ARE QUOTED IN BUSINESS DAYS (Jordan, Sep 18 2026: "Use three
// business days as the internal target and four business days as the normal
// client deadline… Four business days is not simply 96 elapsed hours"). The
// old reading — 72 elapsed hours off the shoot — dated a Friday 9am shoot at
// Monday 9am, i.e. a deadline that falls before anyone has worked a full day
// on it, and one nobody in the office would have quoted out loud.
// ---------------------------------------------------------------------------

/** The client deadline on a premium reel, in business days from the anchor. */
export const PREMIUM_BUSINESS_DAYS = 4;
/** The internal target. Always on or before the client deadline. */
export const PREMIUM_TARGET_BUSINESS_DAYS = 3;
/** The office's premium hour box when Settings has not been touched (it is
 *  `premiumVideoHours`, default 72). It is a FLOOR under the business-day
 *  promise — see premiumDueFrom. */
export const PREMIUM_FLOOR_HOURS = 72;
/** 5pm ET — the close of a promise day, the same hour etEndOfDay uses. */
export const BUSINESS_DAY_END_HOUR = 17;

/**
 * The turnaround settings this file reads, plus the three keys it WANTS.
 *
 * `premiumBusinessDays`, `premiumTargetBusinessDays` and `businessDayEndHour`
 * are not on TurnaroundRules yet (settings.ts is another group's file, and its
 * sanitiser drops keys it does not know). They are read defensively off
 * whatever object arrives, so the day counts below are live the moment the
 * keys land in Settings and are the constants above until then — no second
 * deploy, and no silent disagreement between the screen and the arithmetic in
 * the meantime.
 */
export type PromiseRules = TurnaroundRules &
  Partial<{
    /** client deadline for a premium reel, in business days */
    premiumBusinessDays: number;
    /** internal target for a premium reel, in business days */
    premiumTargetBusinessDays: number;
    /** the hour a promise day closes, ET */
    businessDayEndHour: number;
  }>;

function ruleNum(rules: PromiseRules | null | undefined, key: string, fallback: number, max: number): number {
  const v = (rules as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max ? v : fallback;
}

export const premiumBusinessDays = (rules?: PromiseRules | null): number =>
  ruleNum(rules, "premiumBusinessDays", PREMIUM_BUSINESS_DAYS, 30);
/** Never past the client deadline: an internal target the office could miss
 *  while still being on time is not a target, it is a second deadline. */
export const premiumTargetBusinessDays = (rules?: PromiseRules | null): number =>
  Math.min(ruleNum(rules, "premiumTargetBusinessDays", PREMIUM_TARGET_BUSINESS_DAYS, 30), premiumBusinessDays(rules));
export const businessDayEndHour = (rules?: PromiseRules | null): number =>
  ruleNum(rules, "businessDayEndHour", BUSINESS_DAY_END_HOUR, 23);

/**
 * THE premium promise. One implementation — tasks.ts imports this rather than
 * keeping its own premium hours, because Kyle's board and the QC card dating
 * the same reel differently is the bug this file's Sep 17 header describes.
 *
 * `premiumVideoHours` IS STILL A LIVE CONTROL — it is a FLOOR (review, Sep 18).
 * When the premium promise became four business days this function stopped
 * reading the settings object at all, and "Premium reel / video — 720 hours
 * max" stayed on the Settings screen Kyle uses: typing 240 into it moved
 * nothing, on any surface, with no hint that it had been retired. A dead box on
 * a live screen is worse than a missing one, so the box means what it says —
 * the premium promise is never EARLIER than the office's hour quote:
 *
 *   premium due = the later of (four business days, end of day)
 *                          and (anchor + premiumVideoHours, end of THAT
 *                               business day — a promise never closes on a
 *                               Saturday, which is the whole reason the reel
 *                               stopped being elapsed hours on Sep 18)
 *
 * Only later, never earlier: Jordan dictated four business days as "the normal
 * client deadline", and an hour box is not the place to quietly quote shorter
 * than that. At the shipped 72 the floor never wins — proved across 730
 * consecutive hourly anchors in scripts/_fix/B/p5-premium-floor.ts, 0 of 17,520
 * differ — so nothing moves until somebody deliberately raises it.
 */
export function premiumDueFrom(anchor: Date, rules?: PromiseRules | null): Date {
  const hour = businessDayEndHour(rules);
  const byDays = endOfBusinessDaysET(anchor, premiumBusinessDays(rules), hour);
  const floorHours = ruleNum(rules, "premiumVideoHours", PREMIUM_FLOOR_HOURS, 720);
  const byHours = endOfThatBusinessDayET(new Date(anchor.getTime() + floorHours * 3_600_000), hour);
  return byHours > byDays ? byHours : byDays;
}

/** The end of the business day `at` falls on — or of the NEXT one when it lands
 *  on a weekend. Used to give the hour floor above the same shape as every
 *  other day-quoted promise instead of a deadline inside the weekend. */
function endOfThatBusinessDayET(at: Date, hour: number): Date {
  const dow = new Date(`${etDayKey(at)}T12:00:00Z`).getUTCDay();
  return endOfBusinessDaysET(at, dow === 0 || dow === 6 ? 1 : 0, hour);
}

/** The internal aim on a premium reel — three business days, end of day. */
export function premiumTargetFrom(anchor: Date, rules?: PromiseRules | null): Date {
  return endOfBusinessDaysET(anchor, premiumTargetBusinessDays(rules), businessDayEndHour(rules));
}

/**
 * The promise a job was SOLD under wins over anything we would compute today.
 *
 * Project.promisedDueAt is frozen once, from the rules in force at the time
 * (scripts/pin-promises.ts). Without this preference, changing a default
 * rewrites history: moving the premium reel alone re-dates every premium job
 * ever delivered, which re-scores the owner's on-time dial and the
 * photographer bonus that reads it.
 */
export function promisedOr(promised: Date | null | undefined, computed: Date | null): Date | null {
  return promised ?? computed;
}

/**
 * The pin, unless it belongs to a visit that no longer exists.
 *
 * A promise is frozen against the shoot it was quoted from. When a job is
 * REBOOKED the clock legitimately restarts, and the old pin is a deadline that
 * falls before the new shoot has even happened — 80 W Lancaster Ave Floor 2
 * was pinned at Sep 7 2:30pm and is now booked for the end of the month, and
 * honouring that pin would have parked it on Kyle's late list for a job nobody
 * has shot yet. A deadline that precedes its own shoot is not a promise
 * anybody made; the current rules answer for it instead.
 *
 * THE SECOND ARGUMENT IS THE JOB'S OWN SHOOT DATE AND NOTHING ELSE (review,
 * Sep 18). It first took a "clock start", and deliveryBoard handed it the
 * board's clockStart — which falls back to `now` for a monthly job with no
 * shoot. Every pin is older than now, so EVERY such pin was thrown away on
 * every render: 80 W Lancaster, pinned Mon Sep 7 2:30pm, printed Thu Oct 1 5pm
 * today and Fri Oct 2 5pm tomorrow, the promise walking forward a day per day —
 * exactly the drift the freeze exists to stop. Only a REBOOK may void a pin, so
 * only a real rescheduled visit is allowed to answer this question. A job with
 * no shoot date has moved nothing and keeps its promise.
 */
export function livePromise(promised: Date | null | undefined, shootDate: Date | null | undefined): Date | null {
  if (!promised) return null;
  if (shootDate && promised <= shootDate) return null;
  return promised;
}

/**
 * livePromise read straight off the project row — the form every reader should
 * use. It takes the two columns itself, so no caller can substitute a synthetic
 * clock for the shoot date the way the board did (see above). A row whose
 * select does not load `shootDate` gets the raw pin, exactly as before.
 */
export function pinnedPromise(p: {
  promisedDueAt?: Date | null;
  shootDate?: Date | null;
}): Date | null {
  return livePromise(p.promisedDueAt, p.shootDate);
}

/**
 * A computed date, never LATER than the promise the job was sold under.
 *
 * For a live job the pin is the whole-job client deadline; a per-item promise
 * recomputed under today's rules can now land after it (the premium move adds
 * days). Handing an in-flight job that extra time would be giving away a date
 * the client never agreed to, so the pin caps it. Items promised EARLIER than
 * the pin (the photos, due tomorrow) are untouched — that is still the thing
 * Kyle is chasing.
 */
export function cappedByPromise(computed: Date | null, promised: Date | null | undefined): Date | null {
  if (!computed || !promised) return computed;
  return computed > promised ? promised : computed;
}

export type TierKey = "same_day" | "next_day" | "video_48h" | "premium_reel" | "monthly_social";

export type Tier = {
  key: TierKey;
  label: string;
  /** What we aim for. */
  targetDays: number;
  /** The promise. Late means past THIS. */
  dueDays: number;
  /** Monthly social is quoted in business days; everything else is calendar. */
  businessDays: boolean;
};

export const TIERS: Record<TierKey, Tier> = {
  // Sold as a rush add-on ("Same Day Photo Delivery"). Not in the rules Jordan
  // dictated, but it's on real orders, and defaulting it to next day would give
  // away the extra day the client paid for.
  same_day: { key: "same_day", label: "Same day", targetDays: 0, dueDays: 0, businessDays: false },
  next_day: { key: "next_day", label: "Next day", targetDays: 1, dueDays: 1, businessDays: false },
  video_48h: { key: "video_48h", label: "48 hours", targetDays: 2, dueDays: 2, businessDays: false },
  // "3-4 days" — we aim at 3 and are late after 4, and Jordan said on Sep 18
  // that both numbers are BUSINESS days. The label says so out loud, because
  // "3–4 days" on Kyle's board next to a date four business days out is the
  // kind of quiet mismatch that makes a board stop being believed.
  premium_reel: { key: "premium_reel", label: "3–4 business days", targetDays: PREMIUM_TARGET_BUSINESS_DAYS, dueDays: PREMIUM_BUSINESS_DAYS, businessDays: true },
  // "7-10 business days" — aim at 7, late after 10.
  monthly_social: { key: "monthly_social", label: "7–10 business days", targetDays: 7, dueDays: 10, businessDays: true },
};

// Order matters: the first pattern that matches wins, so the specific named
// packages are tested before the generic word "video" can swallow them.
const RULES: { re: RegExp; tier: TierKey }[] = [
  // Rush add-ons win outright — the words "same day" are the promise.
  { re: /\bsame[-\s]?day\b/i, tier: "same_day" },

  // Monthly social retainers. Named packages first — "Video Pro" contains
  // "video", and must not be read as a standard 48-hour video.
  { re: /\bvideo\s*(starter|accelerator|pro)\b/i, tier: "monthly_social" },
  { re: /\b(monthly|social)\s+(content|package|plan)\b/i, tier: "monthly_social" },
  { re: /\bmonthly\b.*\breel/i, tier: "monthly_social" },

  // Premium reels. `isPremiumTitle` above has already caught the wider family
  // of premium names; these two stay because they also match a product whose
  // premium word and video word sit in either order with other words between.
  { re: /\bpremium\b.*\breel\b/i, tier: "premium_reel" },
  { re: /\breel\b.*\bpremium\b/i, tier: "premium_reel" },

  // These sit ABOVE the generic video rule on purpose. "Drone Photo and Video"
  // and "Video Staging" both contain the word video, but they're add-ons that
  // ship alongside the stills, not standard videos — and the whole default is
  // "next day unless it's a premium reel", so the shorter clock is the safer
  // reading of an ambiguous name.
  { re: /\bstag(ing|e)\b/i, tier: "next_day" },
  { re: /\b(drone|aerial|twilight|headshot|lot lines?)\b/i, tier: "next_day" },
  { re: /\b(floor\s*plan|floorplan|cubicasa)\b/i, tier: "next_day" },
  { re: /\b(zillow|showcase|3d tour|matterport)\b/i, tier: "next_day" },

  // Everything shot and cut as a standard video.
  { re: /\b(video|reel|walkthrough|tour video|listing video|agent intro)\b/i, tier: "video_48h" },

  // Next-day stills.
  { re: /\b(photo|photos|photography|image|hdr)\b/i, tier: "next_day" },
];

// THE SAME PREMIUM WORDS THE REST OF THE HUB USES (Sep 18). tasks.ts
// isPremiumLabel and projectStatus.ts PREMIUM_VIDEO_RE have read
// premium|influencer|cinematic|luxury|signature|elite|flagship since Sep 16,
// and this file still read only the word "premium" — so an "Influencer Reel"
// was a premium job everywhere except Kyle's board, which dated it at 48
// hours. Both halves are required here: tasks.ts only ever applies these words
// to a row already typed VIDEO/SOCIAL_REEL, while this function is handed a
// bare product name, where "Luxury Photo Package" must stay a next-day gallery.
const PREMIUM_WORDS_RE = /\b(premium|influencer|cinematic|luxury|signature|elite|flagship)\b/i;
const VIDEO_WORDS_RE = /\b(reel|video|film|walkthrough)\b/i;
const isPremiumTitle = (t: string) =>
  PREMIUM_WORDS_RE.test(t) && VIDEO_WORDS_RE.test(t) && !/\bstandard\b/i.test(t);

/** Which promise covers this product name. Unknown products get the default. */
export function tierFor(productTitle: string): Tier {
  const t = (productTitle || "").trim();
  for (const r of RULES) {
    // The premium family is tested exactly where the two premium patterns sit
    // in the table — after the rush add-on and the named monthly plans, before
    // the generic video rule — so widening the words cannot reorder anything.
    if (r.tier === "premium_reel" && isPremiumTitle(t)) return TIERS.premium_reel;
    if (r.re.test(t)) return TIERS[r.tier];
  }
  // "We always need to deliver the next day unless it was a premium reel."
  return TIERS.next_day;
}

/**
 * The due instant for one ordered item.
 *
 * ONE PROMISE, TWO SHAPES (audit WF-04, Sep 17). This file and tasks.ts used to
 * date the same job differently, and only tasks.ts read the office's editable
 * turnaround settings — so Kyle's delivery board could say Friday 5pm while the
 * project card, the edit task and the QC card said Thursday 10am, and changing
 * a number in Settings moved three of those four. What the two engines were
 * really disagreeing about is how a promise is QUOTED:
 *
 *   · Quoted in HOURS ("Standard Videos within 48hrs", premium reels) — an
 *     hour count from the anchor, to the minute. These now take their numbers
 *     from the same TurnaroundRules that tasks.ts uses, so the two agree
 *     exactly and an office change reaches every surface at once.
 *   · Quoted in DAYS ("next day", "7–10 business days", and since Sep 18 the
 *     premium reel) — end of the due day. 5pm Eastern, because a next-day
 *     promise means that day, not the same minute of the following morning.
 *
 * The premium reel MOVED between those two shapes on Sep 18. It was 72 elapsed
 * hours; Jordan quotes it as four business days, and the two are not the same
 * date — 96 hours from a Friday 9am shoot is Tuesday 9am, while four business
 * days is the end of the following Thursday. Weekends are not delivery days.
 *
 * THE MONTHLY WINDOW DID NOT MOVE ON JORDAN'S DIRECTIVE — it moved on this
 * file's own rule, and the reviewer was right to ask (Sep 18). What changed on
 * Sep 18 was tasks.ts: its monthly walk carried the anchor's clock time onto
 * the landing day, so a shoot that started at 8:50pm was promised at 8:50pm.
 * THIS file has closed the monthly window at 5pm ET since it was written — so
 * the two engines disagreed about the same batch by hours, which is precisely
 * the WF-04 bug above, and tasks.ts was the surface that moved to meet the
 * board rather than a new promise being invented. "7–10 business days" is
 * quoted in DAYS; the minute of day is arithmetic residue, not something a
 * client was ever told. Measured across all 72 monthly-content jobs in
 * production (scripts/_fix/B/p3-monthly-5pm.ts): NOT ONE due DAY changes. 66
 * move later within the same ET day (worst 9h), 6 earlier (worst 3h50m), and
 * of the 11 live monthly jobs exactly 2 tighten — 80 W Lancaster by 36 minutes
 * and a TEST row by 3h50m, both still Thursday and Wednesday respectively.
 *
 * `rules` is the office's settings; leaving it out keeps the dictated defaults.
 */
export function dueAtFor(tier: Tier, startedAt: Date, rules?: PromiseRules | null): Date {
  // Hour-quoted tiers: the exact instant tasks.ts deliveryDueFrom computes.
  if (tier.key === "video_48h") {
    return new Date(startedAt.getTime() + (rules?.standardVideoHours ?? tier.dueDays * 24) * 3_600_000);
  }
  // Day-quoted tiers: end of the due day, weekends skipped where the promise
  // was quoted in business days. endOfBusinessDaysET does ET DAY-KEY
  // arithmetic — a millisecond loop drifts an hour across a clock change, and
  // this file used to run one.
  if (tier.key === "premium_reel") return premiumDueFrom(startedAt, rules);
  const hour = businessDayEndHour(rules);
  const days = tier.key === "monthly_social" ? rules?.monthlyBusinessDays ?? tier.dueDays : tier.dueDays;
  if (tier.businessDays) return endOfBusinessDaysET(startedAt, days, hour);
  return etAt(etDayKey(new Date(startedAt.getTime() + days * 86_400_000)), hour);
}

/** What we AIM for — always on or before dueAtFor for the same tier. */
export function targetAtFor(tier: Tier, startedAt: Date, rules?: PromiseRules | null): Date {
  if (tier.key === "premium_reel") return premiumTargetFrom(startedAt, rules);
  const hour = businessDayEndHour(rules);
  if (tier.businessDays) return endOfBusinessDaysET(startedAt, tier.targetDays, hour);
  return etAt(etDayKey(new Date(startedAt.getTime() + tier.targetDays * 86_400_000)), hour);
}

// ===========================================================================
// THE PRODUCTION ANCHOR — where a monthly content session's clock starts
// (spec §8/§9, finding F27, Sep 21 2026).
//
// Jordan's rule, verbatim from §8: "Internal production — target business day
// 7, overdue after business day 10, ANCHORED TO THAT APPOINTMENT'S END." The
// 7/10 window itself has been right since this file was written (TIERS
// .monthly_social above); what was wrong is the thing it counts FROM.
//
// Every date path in the hub counts from a START: deliveryBoard.clockStart
// takes Project.shootDate (and falls back to `now` for a monthly job with no
// shoot), and tasks.videoAnchorFor takes the last appointment's startAt. On a
// four-hour Accelerator session that is the moment the photographer arrives —
// the crew has not shot a frame of the thing being promised. Anchoring at the
// END is also the only reading that survives §9's other sentence: "Delivery
// timing starts at the appointment end even if the photographer uploads late.
// Late raw footage should consume the same deadline and alert the team; it
// must not restart the clock." Nothing in here reads an upload, a Dropbox
// landing or a task completion, and nothing may be added that does — a late
// upload eats the window, it does not move it.
//
// AND THE ANCHOR IS PER APPOINTMENT, NOT PER JOB. A Pro month is two
// four-hour sessions (§3) that may hang off one order, and §9 says each has
// "a separate end time and day-7/day-10 target". So the unit here is a LEG.
//
// WHAT THE LIVE DATA DOES WITH "the appointment's end" (Phase 0 recon, 33
// content orders across 12 customers, all booked by hand):
//   · durations drift from the purchased package — Sarina Spinelli bought a
//     4-hour Accelerator and her appointment is 120 minutes; others sit at 180
//     and 210. So a package duration is a FALLBACK, never a correction: we do
//     not lengthen a real booked appointment to match what was sold.
//   · one appointment is UNSCHEDULED with null start_at/end_at.
//   · one order has no appointment at all.
// "The appointment's end" is therefore not always available, and the reply to
// that is an explicit, named, visible fallback — never a silent slide back to
// the shoot date, which is the very defect F27 names.
//
// ---------------------------------------------------------------------------
// AND THEN JORDAN NARROWED IT (Sep 21 2026, batch 2). Batch 1 answered a
// missing end by ESTIMATING one — booked start plus the package's minutes, or
// the booked start on its own — and labelling the result "(estimated)". His
// correction:
//
//   "Don't invent production dates. Show 'Not scheduled' for genuinely
//    unbooked work. If filming happened but its appointment or end time is
//    missing, show 'Production date needs verification' and assign Kyle the
//    correction. Unknown deadlines must not appear as on time."
//
// An estimate is a date, and a date gets counted, coloured and sorted. Start
// plus the PACKAGE's 240 minutes is a deadline read off a sales record for a
// session nobody has evidence was four hours long — Sarina's 120-minute
// Accelerator is the standing proof that the sold length and the filmed length
// are different facts. So those rungs are gone. What is left is three states,
// and only one of them carries a date:
//
//   known               · the appointment's real end (or Aryeo's own recorded
//                         minutes for that same appointment, which is the end
//                         written another way, not a guess) → day 7 / day 10.
//   needs_verification  · there IS work here, and its end is missing. No date,
//                         never on time, and Kyle is asked to correct it.
//   not_scheduled       · genuinely unbooked. No date, and nothing to correct.
//
// MEASURED BEFORE IT SHIPPED, on every monthly-content project in production
// (scripts/_drill/honest-dates.ts): 63 of 63 bookable legs carry a real
// `endAt`, so not one live session loses a date it has today. The three jobs
// with no bookable leg are all TEST fixtures — two unbooked cut jobs, which
// now read "Not scheduled", and one filmed-and-delivered job with no
// appointment row, which now reads "Production date needs verification"
// instead of silently borrowing the shoot date.
// ===========================================================================

/** One booked leg — the Appointment columns this file needs, and no more. */
export type SessionLeg = {
  id?: string | null;
  startAt: Date | null;
  endAt?: Date | null;
  /** Aryeo's own minutes for the leg, when the sync carried one. */
  durationMin?: number | null;
  /** Aryeo status: SCHEDULED | CANCELED | UNSCHEDULED. */
  status?: string | null;
};

/** Which rung answered. The first two carry a date; the rest do not. */
export type ProductionAnchorSource =
  /** the appointment's real end instant — the rule */
  | "appointment_end"
  /** no end_at, but Aryeo recorded THIS appointment's own length. Still the
   *  appointment's end, written another way — not a guess from a sales record. */
  | "appointment_start_plus_duration"
  /** there is work here and its end is missing. NO DATE. Kyle corrects it. */
  | "needs_verification"
  /** genuinely unbooked. NO DATE, and nothing for anyone to correct. */
  | "none"
  // ---- RETIRED Sep 21 2026 (Jordan: "don't invent production dates") -------
  // Never emitted any more. Kept in the union so a stored or logged value from
  // before batch 2 still type-checks, and so the next reader can see what the
  // ladder used to do rather than wondering why it has four rungs.
  //   appointment_start_plus_package · start + the minutes the PACKAGE was sold
  //     as. A deadline off a sales record. Now needs_verification.
  //   appointment_start · a leg with a start and nothing else, treated as a
  //     zero-length session. Now needs_verification.
  //   shoot_date · no appointment at all, so Project.shootDate stood in. This
  //     is the exact substitution F27 was raised about. Now needs_verification.
  | "appointment_start_plus_package"
  | "appointment_start"
  | "shoot_date";

/** The three states a production date can be in (Jordan, Sep 21 2026). Only
 *  `known` may be dated, sorted or counted as on time. */
export type ProductionAnchorStatus = "known" | "needs_verification" | "not_scheduled";

export type ProductionAnchor = {
  /** null unless `status` is "known". There is no such thing as a soft date. */
  at: Date | null;
  source: ProductionAnchorSource;
  status: ProductionAnchorStatus;
  /** RETIRED Sep 21 2026: always false. The hub no longer estimates a
   *  production date, so nothing can be an estimate. Kept because callers
   *  outside this batch still read it and `false` is the honest answer for
   *  every anchor this function now returns. */
  estimated: boolean;
  /** What a card prints INSTEAD of a date when there is none — Jordan's own
   *  words, verbatim. Null when the anchor is known. */
  unknownLabel: string | null;
  /** one line for the card, so the gap is visible rather than implied. */
  note: string | null;
  /** the leg this anchor came from, when it came from one. */
  legId: string | null;
  /** minutes actually booked, when known — for the drift flag below. */
  bookedMinutes: number | null;
};

/** Jordan's two sentences, in his words, used everywhere a date is missing. */
export const NOT_SCHEDULED_LABEL = "Not scheduled";
export const NEEDS_VERIFICATION_LABEL = "Production date needs verification";

const notScheduled = (note: string, legId: string | null = null): ProductionAnchor => ({
  at: null, source: "none", status: "not_scheduled", estimated: false,
  unknownLabel: NOT_SCHEDULED_LABEL, note, legId, bookedMinutes: null,
});

const needsVerification = (note: string, legId: string | null = null): ProductionAnchor => ({
  at: null, source: "needs_verification", status: "needs_verification", estimated: false,
  unknownLabel: NEEDS_VERIFICATION_LABEL, note, legId, bookedMinutes: null,
});

/** True when this anchor may be dated, sorted or counted as on time. */
export const anchorIsKnown = (a: ProductionAnchor): boolean => a.status === "known" && a.at !== null;

const MINUTE = 60_000;
const legIsBookable = (a: SessionLeg): boolean => {
  const s = (a.status || "").toUpperCase();
  // Same exclusions as tasks.videoAnchorFor (Sep 16): a cancelled leg is not a
  // visit, and UNSCHEDULED means the office postponed it and it has no slot —
  // a stale time on that row is not a shoot.
  return !s.startsWith("CANCEL") && s !== "UNSCHEDULED" && a.startAt !== null;
};

/**
 * The end of one booked leg.
 *
 * Two rungs carry a date and both are the appointment's OWN evidence: the
 * recorded `end_at`, or the recorded `duration` added to the recorded start.
 * Everything else is an answer without a date.
 *
 * `expectedSessionMinutes` — the minutes the PACKAGE was sold as (Starter 120,
 * Accelerator 240, Pro 240 per session) — is deliberately NO LONGER USED to
 * produce a date. It stays in the signature because sessionClocksFor and the
 * board both pass it and both still want the drift flag ("booked for 120, sold
 * as 240"), which needs the number. Reinstating it as a fallback end would
 * re-create precisely the invention Jordan named on Sep 21: Sarina Spinelli
 * bought a 4-hour Accelerator and her appointment is 120 minutes, so a day-10
 * computed off 240 would be a deadline for a session that never existed.
 */
export function legEnd(a: SessionLeg, expectedSessionMinutes?: number | null): ProductionAnchor {
  void expectedSessionMinutes; // see above — read for drift, never for a date
  if (!legIsBookable(a)) {
    const s = (a.status || "").toUpperCase();
    // A CANCELLED or UNSCHEDULED leg is not work in flight; there is nothing
    // for Kyle to correct, so this is "Not scheduled", not an exception.
    return notScheduled(
      s === "UNSCHEDULED"
        ? "This session was taken off the calendar, so production has no clock."
        : s.startsWith("CANCEL")
          ? "This session was cancelled, so production has no clock."
          : "This session is not on the calendar yet, so production has no clock.",
      a.id ?? null,
    );
  }
  const start = a.startAt!;
  const booked = typeof a.durationMin === "number" && a.durationMin > 0 ? a.durationMin : null;
  if (a.endAt) {
    return {
      at: a.endAt,
      source: "appointment_end",
      status: "known",
      estimated: false,
      unknownLabel: null,
      note: null,
      legId: a.id ?? null,
      bookedMinutes: booked ?? Math.max(0, Math.round((a.endAt.getTime() - start.getTime()) / MINUTE)),
    };
  }
  if (booked) {
    // Not an estimate: Aryeo holds a length for THIS appointment. The end is
    // start + that length, and saying so is reporting the booking, not guessing
    // at it. Zero live legs take this rung today (all 63 carry an end_at) — it
    // exists because Aryeo has left end_at null on legs in the past.
    return {
      at: new Date(start.getTime() + booked * MINUTE),
      source: "appointment_start_plus_duration",
      status: "known",
      estimated: false,
      unknownLabel: null,
      note: `Aryeo carried no end time for this session, so the end is its booked start plus its own recorded ${booked} minutes.`,
      legId: a.id ?? null,
      bookedMinutes: booked,
    };
  }
  // A booked session with neither an end nor a length. There IS work here and
  // we cannot say when it finished, which is exactly Jordan's second case.
  return needsVerification(
    "This session is on the calendar with no end time and no duration, so there is no day-7 or day-10 to hold it to. Kyle: open the appointment in Aryeo and set its end.",
    a.id ?? null,
  );
}

/** One bookable leg of a job, with its own end and its own place in the run. */
export type ProductionSession = {
  /** 1-based, by start time, over THIS job's bookable legs — "session 1 of 2".
   *  A display ordinal, never an identity (§9.8); the clock rides on legId. */
  index: number;
  of: number;
  legId: string | null;
  startAt: Date | null;
  anchor: ProductionAnchor;
};

/**
 * EVERY SESSION ON THE JOB, each with its own end (§9: "Each Pro session has a
 * separate end time and day-7/day-10 target").
 *
 * This is the primitive. A caller rendering a video, a cut or a session reads
 * its own leg from here (or asks productionAnchorFor for it by id); only a
 * caller asking about the WHOLE job rolls these up, and the roll-up below is
 * deliberately a minimum rather than a pick.
 *
 * Empty when the job has no bookable leg at all — the caller then falls back
 * to the shoot-date rung, which productionAnchorFor does and labels.
 */
export function productionSessionsFor(
  p: { appointments?: SessionLeg[] | null },
  opts: { expectedSessionMinutes?: number | null } = {},
): ProductionSession[] {
  const legs = (p.appointments ?? [])
    .filter(legIsBookable)
    .sort((x, y) => x.startAt!.getTime() - y.startAt!.getTime());
  return legs.map((a, i) => ({
    index: i + 1,
    of: legs.length,
    legId: a.id ?? null,
    startAt: a.startAt,
    anchor: legEnd(a, opts.expectedSessionMinutes),
  }));
}

/**
 * THE JOB-LEVEL anchor: the EARLIEST obligation the job is still carrying.
 *
 * WHY EARLIEST, AND WHY THIS CHANGED (review of the F27 batch, Sep 21 2026).
 * The first cut of this function mirrored tasks.videoAnchorFor — the latest leg
 * that has actually happened wins — so that the two engines could not disagree
 * about WHICH visit. On a one-visit job, which is 68 of the 69 live content
 * jobs, that is the same leg either way. On a TWO-visit job it erased the first
 * session's deadline outright: Joe Sutow, 1023 Sycamore Mills Rd, is filmed
 * Fri Jul 24 (ends 2:30pm) and again Mon Jul 27 (ends 4:00pm), and sessionClocksFor
 * correctly reported session 1 overdue after 2026-08-07 and session 2 after
 * 2026-08-10 while this function answered 2026-08-10 alone — session one's
 * videos read as on time for three extra days, which is exactly the merge §9
 * forbids.
 *
 * So the two engines now answer two different questions on purpose, and the
 * divergence is the fix rather than a regression:
 *   · videoAnchorFor asks WHEN WAS THIS REEL FILMED — a reel shot on the second
 *     visit is not late against the first, so the latest visit is right there.
 *   · this asks IS THIS JOB LATE, and a job is late as soon as its earliest
 *     unmet session is. A minimum can only ever pull a date earlier, so no
 *     roll-up here can hide lateness the way the old pick did.
 * Anything rendering per-video or per-session must pass `legId` (or read
 * productionSessionsFor) and gets its own leg, untouched by this roll-up —
 * contentProgram.sessionClocksFor always names a leg, which is why the per
 * session numbers were right while the job-level answer was wrong.
 *
 * A booked-but-unshot job still shows a date: the minimum is taken over ALL
 * bookable legs, past and upcoming alike, so the clock is never lost the way an
 * anchor-on-past-only rule would lose it.
 */
export function productionAnchorFor(
  p: { shootDate?: Date | null; appointments?: SessionLeg[] | null },
  // `now` is no longer read — the old rule split the legs into past and
  // upcoming and this one does not care which side a leg falls on. It stays in
  // the type because every caller passes it (productionClockFor threads its
  // whole opts object through) and because a clock the caller can pin is how
  // the drills replay a job at a chosen instant.
  opts: { now?: number; expectedSessionMinutes?: number | null; legId?: string | null } = {},
): ProductionAnchor {
  const legs = (p.appointments ?? []).filter(legIsBookable);
  // Pro: each session is asked for by id, and answers for itself alone (§9).
  // A named leg that is cancelled or unscheduled answers NOTHING — it must
  // never quietly fall through to the other session's end, which would hand
  // session two's deadline to a session-one card and read as on time.
  if (opts.legId) {
    const one = legs.find((a) => a.id === opts.legId);
    if (one) return legEnd(one, opts.expectedSessionMinutes);
    const dropped = (p.appointments ?? []).find((a) => a.id === opts.legId);
    if (dropped) return legEnd(dropped, opts.expectedSessionMinutes);
    return notScheduled("That session is no longer on the calendar.", opts.legId);
  }
  const all = productionSessionsFor(p, opts);
  const dated = all.filter((s) => anchorIsKnown(s.anchor));
  if (dated.length > 0) {
    const earliest = dated.reduce((a, b) => (a.anchor.at!.getTime() <= b.anchor.at!.getTime() ? a : b));
    // A DATED SESSION NEXT TO AN UNDATED ONE STILL OWES THE UNDATED ONE (Sep 21
    // 2026, batch 2). Taking the earliest KNOWN end and stopping would let a
    // Pro month whose session 2 has no end read as fully clocked — the same
    // merge F27 was raised about, one level up. So the job says so.
    const blind = all.length - dated.length;
    const parts: string[] = [];
    if (earliest.anchor.note) parts.push(earliest.anchor.note);
    if (earliest.of > 1) {
      // More than one visit: say which one this date belongs to. A job-level
      // number that does not name its session is how the merge happened in the
      // first place, and a card printing one date for a two-session job has to
      // admit that the other session has its own.
      parts.push(`This job has ${earliest.of} sessions, each with its own day-7/day-10. This date is session ${earliest.index}'s, the earliest still owed.`);
    }
    if (blind > 0) parts.push(`${blind} of its sessions ${blind === 1 ? "has" : "have"} no end time yet, so ${blind === 1 ? "that one has" : "those have"} no date at all.`);
    return { ...earliest.anchor, note: parts.length ? parts.join(" ") : null };
  }
  // No session carries a date. If any leg is a booked session missing its end,
  // that is the exception Kyle corrects — it outranks "not scheduled", because
  // work that exists and cannot be dated is not the same as work nobody booked.
  const blindLeg = all.find((s) => s.anchor.status === "needs_verification");
  if (blindLeg) return blindLeg.anchor;
  // RETIRED Sep 21 2026: the shoot-date rung. Jordan: "Don't invent production
  // dates." A job with a shoot date and no appointment row is filming that
  // happened (or is meant to happen) with its appointment missing — Jordan's
  // second case exactly, so it gets no date and Kyle gets the correction. One
  // live row takes this path today, the TEST Cara listing job, which used to
  // borrow its Sep 11 shoot date and read as comfortably on time.
  if (p.shootDate) {
    const when = p.shootDate.getTime() <= (opts.now ?? Date.now()) ? "was filmed on" : "is due to film on";
    return needsVerification(
      `This job ${when} ${p.shootDate.toISOString().slice(0, 10)} but has no appointment in Aryeo, so there is no session end to count from. Kyle: find or create the appointment so the day-7 and day-10 dates are real.`,
    );
  }
  return notScheduled("Nothing is booked, so production has no clock yet.");
}

/**
 * THE PRODUCTION WINDOW off an anchor: business day 7 is the target, business
 * day 10 is overdue (§8). Business days and the office's 5pm close, through
 * the same endOfBusinessDaysET every other day-quoted promise here uses, and
 * through TIERS.monthly_social so there is still exactly ONE 7/10 table.
 *
 * `monthlyBusinessDays` in Settings keeps moving the overdue point, as it
 * always has. The target is clamped to it: an internal aim the office could
 * miss while still being on time is not a target, it is a second deadline.
 */
export function productionWindowFrom(anchor: Date, rules?: PromiseRules | null): { productionTargetAt: Date; productionDueAt: Date } {
  const productionDueAt = dueAtFor(TIERS.monthly_social, anchor, rules);
  const aim = targetAtFor(TIERS.monthly_social, anchor, rules);
  return { productionTargetAt: aim > productionDueAt ? productionDueAt : aim, productionDueAt };
}

/**
 * THE PRODUCTION CLOCK, and nothing else.
 *
 * §10's deadline-reporting rule: "Show the day-7/day-10 production target
 * SEPARATELY from client review and revision clocks… Do not silently merge
 * these measures or blame client review time on the editor." That is why the
 * fields are named productionTargetAt/productionDueAt rather than target/due —
 * a screen that wants to print one number for a whole job has to make that
 * choice visibly, at the call site, instead of picking up an ambiguous `dueAt`
 * from here. The client's four-business-day review window per released version
 * is a different clock with a different anchor (the release) and does not live
 * in this type.
 */
export type ProductionClock = {
  anchor: ProductionAnchor;
  /** computed from the anchor under today's rules. */
  productionTargetAt: Date | null;
  productionDueAt: Date | null;
  /** what the office is actually held to, after the overrides below. */
  effectiveDueAt: Date | null;
  effectiveSource: "office_override" | "as_promised" | "computed" | "none";
  /** THE ON-TIME GUARD (Jordan, Sep 21 2026: "unknown deadlines must not
   *  appear as on time"). False whenever the session's end is unknown, EVEN
   *  IF `effectiveDueAt` carries a date — because on such a job that date can
   *  only have come from an office override or a frozen promise, which is a
   *  deliberate human decision and not evidence of when filming ended. A
   *  caller colouring, sorting or counting a job must test this, not just
   *  `effectiveDueAt !== null`. */
  dateKnown: boolean;
  /** What the card prints where the date would go, when there is none.
   *  "Not scheduled" or "Production date needs verification". */
  unknownLabel: string | null;
  /** Kyle has something to fix here. Drives the exception list on the board. */
  needsProductionDateCheck: boolean;
};

/**
 * The production clock for ONE SESSION when `opts.legId` names one, and for the
 * whole job when it does not — and "the whole job" means its EARLIEST unmet
 * session, never a merged date (see productionAnchorFor, F27 review Sep 21
 * 2026). Anything rendering a video, a cut or a session names its leg.
 *
 * …WITH the promise ladder that already
 * governs every other date in the hub applied on top:
 *
 *   1. Project.dueOverrideAt — the office set this date by hand (Jordan, Sep
 *      13: "I want to be able to override anything"). It outranks everything.
 *   2. Project.promisedDueAt — the deadline the job was SOLD under, frozen at
 *      the rules in force then. A recomputed date is never allowed past it
 *      (cappedByPromise), and only a rebooked visit may void it (livePromise).
 *   3. the computed day-10.
 *
 * THE LADDER IS THE WHOLE SAFETY ARGUMENT FOR MOVING THE ANCHOR (Sep 21
 * 2026). Re-anchoring is the rule that decides when work is late, so a silent
 * shift of a promise already made would be a serious regression — every pinned
 * job and every hand-set override therefore keeps exactly the date it has
 * today, and only an unpinned, un-overridden job feels the new anchor at all.
 * Measured on production in scripts/_drill/f27-anchor.ts before this shipped.
 */
export function productionClockFor(
  p: {
    shootDate?: Date | null;
    appointments?: SessionLeg[] | null;
    dueOverrideAt?: Date | null;
    promisedDueAt?: Date | null;
  },
  opts: { now?: number; expectedSessionMinutes?: number | null; legId?: string | null; rules?: PromiseRules | null } = {},
): ProductionClock {
  const anchor = productionAnchorFor(p, opts);
  const known = anchorIsKnown(anchor);
  const win = known ? productionWindowFrom(anchor.at!, opts.rules) : null;
  const productionTargetAt = win?.productionTargetAt ?? null;
  const productionDueAt = win?.productionDueAt ?? null;
  // The three fields every caller needs to render an undated job honestly.
  // Carried on BOTH returns below, because the office-override branch is
  // exactly the one where a date exists and the anchor is still unknown.
  const honesty = {
    dateKnown: known,
    unknownLabel: anchor.unknownLabel,
    needsProductionDateCheck: anchor.status === "needs_verification",
  };
  if (p.dueOverrideAt) {
    return { anchor, productionTargetAt, productionDueAt, effectiveDueAt: p.dueOverrideAt, effectiveSource: "office_override", ...honesty };
  }
  // cappedByPromise(null, pin) returns null, which is the behaviour this rule
  // needs and not an accident: an unknown anchor produces no day-10, so the
  // frozen promise has nothing to cap and the job ends with no computed date
  // rather than quietly inheriting the pin as if the clock had started.
  const pin = livePromise(p.promisedDueAt, p.shootDate ?? null);
  const capped = cappedByPromise(productionDueAt, pin);
  const movedByPin = !!capped && !!productionDueAt && capped.getTime() !== productionDueAt.getTime();
  return {
    anchor,
    productionTargetAt,
    productionDueAt,
    effectiveDueAt: capped,
    effectiveSource: capped === null ? "none" : movedByPin ? "as_promised" : "computed",
    ...honesty,
  };
}
