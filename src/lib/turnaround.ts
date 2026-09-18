import "server-only";
import { etDayKey, etAt } from "@/lib/datetime";
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
// ---------------------------------------------------------------------------

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
  // "3-4 days" — we aim at 3 and are late after 4.
  premium_reel: { key: "premium_reel", label: "3–4 days", targetDays: 3, dueDays: 4, businessDays: false },
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

  // Premium reels.
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

/** Which promise covers this product name. Unknown products get the default. */
export function tierFor(productTitle: string): Tier {
  const t = (productTitle || "").trim();
  for (const r of RULES) if (r.re.test(t)) return TIERS[r.tier];
  // "We always need to deliver the next day unless it was a premium reel."
  return TIERS.next_day;
}

/** Weekends don't count for the monthly-social clock. Holidays are not modelled. */
function addBusinessDays(from: Date, days: number): Date {
  let d = from;
  let left = days;
  while (left > 0) {
    d = new Date(d.getTime() + 86_400_000);
    const dow = new Date(`${etDayKey(d)}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
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
 *   · Quoted in DAYS ("next day", "7–10 business days") — end of the due day.
 *     5pm Eastern, because a next-day promise means that day, not the same
 *     minute of the following morning.
 *
 * `rules` is the office's settings; leaving it out keeps the dictated defaults.
 */
export function dueAtFor(tier: Tier, startedAt: Date, rules?: TurnaroundRules | null): Date {
  // Hour-quoted tiers: the exact instant tasks.ts deliveryDueFrom computes.
  if (tier.key === "video_48h") {
    return new Date(startedAt.getTime() + (rules?.standardVideoHours ?? tier.dueDays * 24) * 3_600_000);
  }
  if (tier.key === "premium_reel") {
    return new Date(startedAt.getTime() + (rules?.premiumVideoHours ?? tier.dueDays * 24) * 3_600_000);
  }
  // Day-quoted tiers: end of the due day.
  const days = tier.key === "monthly_social" ? rules?.monthlyBusinessDays ?? tier.dueDays : tier.dueDays;
  const end = tier.businessDays ? addBusinessDays(startedAt, days) : new Date(startedAt.getTime() + days * 86_400_000);
  return etAt(etDayKey(end), 17);
}

export function targetAtFor(tier: Tier, startedAt: Date): Date {
  const end = tier.businessDays
    ? addBusinessDays(startedAt, tier.targetDays)
    : new Date(startedAt.getTime() + tier.targetDays * 86_400_000);
  return etAt(etDayKey(end), 17);
}
