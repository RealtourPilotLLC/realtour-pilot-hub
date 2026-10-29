// ---------------------------------------------------------------------------
// FIXED IN AUTOHDR (Oct 28 2026, Kyle on the feedback board: "For 'Not there'
// option in photo editing, can you add an option to mark it as fixed with
// autohdr?"). Kyle fixes some issues himself in AutoHDR's own editor (a car
// in the driveway, a crooked line) and had only "Not there" to clear them, so
// they read as the check getting it wrong.
//
// A person's one tap records the issue as FIXED, the same status the hub's
// own paid AutoHDR fix ends in (fixRunner), with who and when (decidedBy,
// decidedAt) and this reason. Every count that reads outcomes treats it as
// fixed: the review stage, the delivery checklist, what the hub learned from
// people's calls (fixPolicy.learnedRules: the check was right) and the
// photographer's scorecards. Unlike a paid fix (undone by restoring an
// earlier version of the photo) it is a person's call, so Undo reopens it.
// The hub then reads AutoHDR again (versions.syncHeads, free), so the photo
// and the Aryeo folder use the fixed version. Never paid QC.
// Pure and client-safe: the decision write and the job page read it.
// ---------------------------------------------------------------------------

/** The status reason a "Fixed in AutoHDR" tap writes (and the prefix Undo looks for). */
export const FIXED_IN_AUTOHDR = "Fixed in AutoHDR";

/** Was this issue marked fixed in AutoHDR by a person (not by the hub's own fix)? */
export function isFixedInAutohdr(f: { status: string; statusReason?: string | null }): boolean {
  return f.status === "FIXED" && (f.statusReason ?? "").startsWith(FIXED_IN_AUTOHDR);
}
