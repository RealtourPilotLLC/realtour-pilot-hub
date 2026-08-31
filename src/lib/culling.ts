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

// Size tiers (Jordan, Aug 31 2026 — "this is the standard moving forward"):
// ≤ 2,500 sq ft → 50 finals · 2,500–5,000 → 65 · above 5,000 → 85.
export const MID_PROPERTY_SQFT = 2500;
export const LARGE_PROPERTY_SQFT = 5000;

// "Moving forward" means exactly that: shoots executed BEFORE the standard
// changed were briefed to the OLD tiers (50, or 80 at ≥3,500 sq ft), and the
// hourly cull sweep must keep judging them by the rules they were given —
// otherwise the tier change retro-fires cull tasks + SMS on compliant
// in-flight jobs (review finding, Aug 31).
const NEW_TIERS_FROM = Date.parse("2026-09-01T00:00:00-04:00");

// The photo budget for one home: an explicit owner override wins; otherwise
// the size tier decides (by the standard in force on the shoot date).
// squareFeet comes from the Aryeo listing sync (null → the 50 default).
export function photoTargetFor(project: {
  photoTarget?: number | null;
  squareFeet?: number | null;
  shootDate?: Date | string | null;
}): number {
  if (project.photoTarget != null) return project.photoTarget;
  const sqft = project.squareFeet;
  if (sqft == null) return 50;
  const shotAt = project.shootDate ? new Date(project.shootDate).getTime() : null;
  if (shotAt != null && shotAt < NEW_TIERS_FROM) {
    return sqft >= 3500 ? 80 : 50; // the standard that shoot was briefed to
  }
  if (sqft > LARGE_PROPERTY_SQFT) return 85;
  if (sqft > MID_PROPERTY_SQFT) return 65;
  return 50;
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

// Room-by-room budget shown on /shoot and /upload so "aim ~50" becomes an
// actionable plan. Jordan's per-room standard (Aug 31 2026).
export function roomBudgetText(target: number): string {
  return `Aim ~${target} finals (~${target * BRACKET_RATIO} JPGs at ${BRACKET_RATIO} brackets each): front max 4, back max 5, each bedroom 2, each bath 1-2 (if one frame shows everything, keep the better angle). No same angle at different distances — shoot each composition ONCE. Extras go to the Backup folder.`;
}
