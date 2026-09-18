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
 * `premiumVideoHours` (72) stays in Settings but no longer dates a premium
 * reel: the promise is a DAY now, not an hour count. Measured Sep 18 against
 * every anchor in the database, four business days at 5pm ET is never earlier
 * than the 72 hours it replaces, so no client's existing deadline moves in.
 */
export function premiumDueFrom(anchor: Date, rules?: PromiseRules | null): Date {
  return endOfBusinessDaysET(anchor, premiumBusinessDays(rules), businessDayEndHour(rules));
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
 */
export function livePromise(promised: Date | null | undefined, clockStart: Date | null | undefined): Date | null {
  if (!promised) return null;
  if (clockStart && promised <= clockStart) return null;
  return promised;
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
