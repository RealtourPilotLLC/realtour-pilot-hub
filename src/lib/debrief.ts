// Shared shoot-debrief constants — ONE definition for the sentinel strings the
// portal writes and every server surface compares against (a wording tweak in
// one copy used to silently break the comparisons — review, Sep 1).
// Client-safe: pure constants, no server imports.

export const NOTHING_TO_REMOVE_SENTINEL = "Nothing needs removal — confirmed by the photographer.";
export const FRONT_TO_BACK_SENTINEL = "Shot front to back.";
export const INTERIOR_EXTERIOR_SENTINEL = "Shot front to back — interior first, then exterior.";

// Stable QC checklist labels for the debrief lines (the reconciler merges
// ticks BY LABEL — these must never change wording once shipped, and dynamic
// text must never be embedded in them).
export const QC_LABEL_SHOT_ORDER = "Shot order noted by the photographer — see the project page";
export const QC_LABEL_REMOVALS = "Verify removals the photographer flagged were edited out — list on the project page";
export const QC_LABEL_VIDEO_BRIEF = "Check the video against the photographer's brief (style · must-show · avoid) — on the project page";
export const QC_LABEL_PAGE_SUBMITTED = "Photographer submitted the upload page";
export const DEBRIEF_QC_LABELS = new Set([
  QC_LABEL_SHOT_ORDER, QC_LABEL_REMOVALS, QC_LABEL_VIDEO_BRIEF, QC_LABEL_PAGE_SUBMITTED,
]);
