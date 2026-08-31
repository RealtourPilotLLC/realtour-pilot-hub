// Culling-at-the-source policy (Jul 2026 audit). Nobody culls at any stage:
// delivered count == final-folder count in EVERY observed job, 76% of galleries
// ship over 50 photos and 40% over even the 80 large-property allowance. Kyle
// delivers the whole final folder because he has no signal. This module is the
// single source of that signal: a photo BUDGET per home, plus the constants
// that turn "files in the raw folder" into "the photographer shot too much."
// Pure math only — NO server-only import so the client-side shoot guide can
// render the same target the sweep enforces.

// The crews shoot 5-bracket JPG sets (Jordan, Jul 2026) — AutoHDR blends each
// 5-exposure set into one final frame, so a target gallery of N finals implies
// roughly N×5 bracketed JPGs on the card.
export const BRACKET_RATIO = 5;

// Overage trip: files above target × this factor means the photographer shot
// too much even after accounting for brackets (extra compositions, machine-gun
// duplicates) — not just tight bracketing. Drives the cull task + the amber/red
// upload chip. 5.5 (not 5.0) leaves the same ~10% slack over the pure bracket
// ratio the old 3.3-on-3 had.
export const RAW_OVERAGE_FACTOR = 5.5;

// Gallery-size tiers from the Photography SOP §16 (Jordan, Sep 1 2026): a
// TYPICAL range to aim for plus a NORMAL UPPER RANGE. "The upper range is not
// a goal" — complete coverage without unnecessary repetition. 7,000+ sq ft is
// professional judgment (upper: null → enforcement falls back to 90).
export type PhotoRange = { low: number; high: number; upper: number | null };

export function photoRangeFor(sqft: number | null | undefined): PhotoRange {
  if (sqft == null) return { low: 35, high: 45, upper: 50 }; // unknown size → the common tier
  if (sqft < 1500) return { low: 25, high: 35, upper: 40 };
  if (sqft <= 2500) return { low: 35, high: 45, upper: 50 };
  if (sqft <= 3500) return { low: 45, high: 55, upper: 60 };
  if (sqft <= 5000) return { low: 55, high: 70, upper: 70 };
  if (sqft <= 7000) return { low: 70, high: 85, upper: 90 };
  return { low: 70, high: 90, upper: null }; // property dependent — judgment
}

// Shoots executed BEFORE a standard changed were briefed to the OLD rules,
// and the hourly cull sweep must keep judging them by those rules — otherwise
// a tier change retro-fires cull tasks + SMS on compliant in-flight jobs
// (review finding, Aug 31).
const SOP_TIERS_FROM = Date.parse("2026-09-01T00:00:00-04:00");

function legacyTier(sqft: number | null | undefined): number {
  return sqft != null && sqft >= 3500 ? 80 : 50;
}

// A shoot is judged by the OLD rules when it happened before the SOP landed —
// and shootDate alone is not enough (it's movable, and can be null): a job
// CREATED pre-SOP whose date was rescheduled/lost was still briefed to the
// old standard. Unknown-everything also counts as legacy (lenient: enforcement
// must never retro-tighten on a job we can't date — review finding, Sep 1).
function legacyEligible(project: { shootDate?: Date | string | null; createdAt?: Date | string | null }): boolean {
  const shotAt = project.shootDate ? new Date(project.shootDate).getTime() : null;
  if (shotAt != null) return shotAt < SOP_TIERS_FROM;
  const createdAt = project.createdAt ? new Date(project.createdAt).getTime() : null;
  return createdAt == null || createdAt < SOP_TIERS_FROM;
}

// The ENFORCEMENT number for one home (the ceiling the cull sweep and the
// over-budget chips judge against): an explicit owner override wins; otherwise
// the SOP tier's normal upper range. Legacy shoots get the MORE LENIENT of
// their briefed 50/80 and the SOP upper — the gate exists to prevent
// retro-tightening, never to grandfather a tighter rule.
export function photoTargetFor(project: {
  photoTarget?: number | null;
  squareFeet?: number | null;
  shootDate?: Date | string | null;
  createdAt?: Date | string | null;
}): number {
  if (project.photoTarget != null) return project.photoTarget;
  const sqft = project.squareFeet;
  const sopUpper = photoRangeFor(sqft).upper ?? 90;
  if (legacyEligible(project)) return Math.max(legacyTier(sqft), sopUpper);
  return sopUpper;
}

// The ONE source for every surface that talks photo counts: the enforcement
// target plus the display range plus which regime produced it — so a page can
// never preach a range the sweep doesn't enforce (review finding, Sep 1).
export type PhotoPolicy = { target: number; range: PhotoRange; mode: "sop" | "legacy" | "override" };

export function photoPolicyFor(project: {
  photoTarget?: number | null;
  squareFeet?: number | null;
  shootDate?: Date | string | null;
  createdAt?: Date | string | null;
}): PhotoPolicy {
  const range = photoRangeFor(project.squareFeet);
  const target = photoTargetFor(project);
  if (project.photoTarget != null) return { target, range, mode: "override" };
  const sopUpper = range.upper ?? 90;
  return { target, range, mode: legacyEligible(project) && target !== sopUpper ? "legacy" : "sop" };
}

// The bracketed-raw budget that maps to a final target (what the photographer
// should see on the card, and the ceiling the upload chip goes amber past).
export function rawBudgetFor(target: number): number {
  return target * BRACKET_RATIO;
}

// The hard raw ceiling: past this, they over-shot even accounting for brackets.
export function rawOverageCeiling(target: number): number {
  return Math.round(target * RAW_OVERAGE_FACTOR);
}

// Room-by-room guide shown on /shoot and /upload — the SOP §12/§14 essentials
// as one line the photographer can hold in their head on site.
export function roomBudgetText(target: number): string {
  return `Aim ~${target} finals max (~${target * BRACKET_RATIO} JPGs at ${BRACKET_RATIO} brackets each): front 2-4, rear 2-4, kitchen 3-5, living 2-3, primary bed/bath 2-3, other beds 1-2, baths 1-2 — guidelines, not quotas. Every space gets a HERO shot; one composition, ONCE; extras to Backup.`;
}
