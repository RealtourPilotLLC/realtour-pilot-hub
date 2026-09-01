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

// Prefix of the machine-written "couldn't complete" FLAG activity — shared so
// the portal can filter its own echo out of the photographer's problem list
// while the Admin timeline keeps the full row.
export const NOT_COMPLETED_FLAG_PREFIX = "Not completed — ";

// Activity type FLAG is a shared bucket: the field crew's own problem flags land
// there, but so do machine-written client revision asks (whose body carries the
// WHOLE email or call transcript) and scheduling events. Any surface showing
// "what the photographer flagged" must filter those out — otherwise a client's
// 1,300-character email renders as an on-site flag (live on 3 jobs, Sep 1).
export const REVISION_FLAG_PREFIX = "Revision requested (";
export const APPT_CANCELLED_FLAG_PREFIX = "Appointment cancelled";
const MACHINE_FLAG_PREFIXES = [
  NOT_COMPLETED_FLAG_PREFIX, // the wrap-up's own echo — shown as its own amber row
  REVISION_FLAG_PREFIX,
  APPT_CANCELLED_FLAG_PREFIX,
];

/** True when this FLAG row is a human field flag (upload portal / on-site / debrief). */
export function isFieldFlag(body: string | null | undefined): boolean {
  const b = body?.trim();
  return !!b && !MACHINE_FLAG_PREFIXES.some((p) => b.startsWith(p));
}
