// Culling-at-the-source policy (Jul 2026 audit). Nobody culls at any stage:
// delivered count == final-folder count in EVERY observed job, 76% of galleries
// ship over 50 photos and 40% over even the 80 large-property allowance, while
// the median shoot lands 243 raw files (target ~150 for a 50-final gallery once
// AutoHDR blends every 3-bracket set). Kyle delivers the whole final folder
// because he has no signal. This module is the single source of that signal:
// a photo BUDGET per home, plus the constants that turn "raws in the folder"
// into "the photographer shot too much." Pure math only — NO server-only import
// so the client-side shoot guide can render the same target the sweep enforces.

// AutoHDR blends each 3-shot exposure bracket into one final frame, so a target
// gallery of N finals implies roughly N×3 bracketed raws on the card.
export const BRACKET_RATIO = 3;

// Raw overage trip: raws above target × this factor means the photographer shot
// too much even after accounting for brackets (extra compositions, machine-gun
// duplicates) — not just tight bracketing. Drives the cull task + the amber/red
// upload chip. 3.3 (not 3.0) leaves a little slack over the pure bracket ratio.
export const RAW_OVERAGE_FACTOR = 3.3;

// Homes at or above this size get the larger default budget (80 vs 50).
export const LARGE_PROPERTY_SQFT = 3500;

// The photo budget for one home: an explicit owner override wins; otherwise
// large homes (>= 3500 sq ft) default to 80 finals, everything else to 50.
// squareFeet comes from the Aryeo listing sync (may be null on older/manual
// jobs → falls back to the 50 default).
export function photoTargetFor(project: {
  photoTarget?: number | null;
  squareFeet?: number | null;
}): number {
  if (project.photoTarget != null) return project.photoTarget;
  return project.squareFeet != null && project.squareFeet >= LARGE_PROPERTY_SQFT ? 80 : 50;
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

// Room-by-room budget shown on /shoot so "aim ~50" becomes an actionable plan.
// Static (not per-home) — a mental model, not a quota per room.
export function roomBudgetText(target: number): string {
  return `Aim ~${target} finals (~${target * BRACKET_RATIO} bracketed raws): exteriors 6-8, kitchen 4-5, living/dining 4-6, each bedroom 2-3, each bath 1-2, features 4-6. Shoot each composition ONCE — don't machine-gun.`;
}
