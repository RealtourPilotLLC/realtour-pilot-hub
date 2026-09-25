// ---------------------------------------------------------------------------
// REVISION ISSUE VOCABULARY (unified handoff §8.3) — plain data, safe in a
// client bundle, so the reviewer's controls and the server that records them
// can never spell a cause differently.
//
// "Client changes are not automatically editor errors" (§3). A cause is a
// PERSON's call — James, or whoever covers him. The hub may SUGGEST one
// (causeSuggested) and never writes `cause` on its own; everything starts
// UNCLASSIFIED and stays that way until reviewed, history included.
// ---------------------------------------------------------------------------

export const ISSUE_CAUSES = [
  "EDITOR_ERROR",
  "MISSED_INSTRUCTION",
  "CLIENT_CHANGE",
  "NEW_SCOPE",
  "BRIEF_GAP",
  "CAPTURE",
  "PROCESSING",
  "UNCLASSIFIED",
] as const;
export type IssueCause = (typeof ISSUE_CAUSES)[number];

export const CAUSE_LABEL: Record<IssueCause, string> = {
  EDITOR_ERROR: "Editor error",
  MISSED_INSTRUCTION: "Missed a supplied instruction",
  CLIENT_CHANGE: "Client preference / change",
  NEW_SCOPE: "New scope",
  BRIEF_GAP: "Missing or conflicting brief",
  CAPTURE: "Capture problem",
  PROCESSING: "Processing / platform problem",
  UNCLASSIFIED: "Not classified yet",
};

/** The two causes that count against the editor's own quality numbers. Every
 *  other cause is somebody else's, or nobody's. */
export const EDITOR_CAUSED: readonly IssueCause[] = ["EDITOR_ERROR", "MISSED_INSTRUCTION"];
export const isEditorCaused = (cause: string | null | undefined): boolean =>
  (EDITOR_CAUSED as readonly string[]).includes(cause ?? "");
export const isIssueCause = (v: unknown): v is IssueCause =>
  typeof v === "string" && (ISSUE_CAUSES as readonly string[]).includes(v);

/** The work order's own areas (revisionBrief.REVISION_AREAS) plus the two the
 *  self-check names that a client rarely does. */
export const ISSUE_CATEGORIES = [
  "Music & sound",
  "On-screen text",
  "Graphics & effects",
  "Background & set",
  "Pacing & movement",
  "Color & styling",
  "Cuts & content",
  "Overall direction",
  "Captions & names",
  "Export & upload",
  "Other",
] as const;

export const ISSUE_SEVERITIES = ["MINOR", "NORMAL", "MAJOR"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** States. OPEN/REOPENED wait on the editor, ADDRESSED waits on the reviewer,
 *  the last three are closed. */
export const ISSUE_OPEN_STATES = ["OPEN", "REOPENED"] as const;
export const ISSUE_LIVE_STATES = ["OPEN", "REOPENED", "ADDRESSED"] as const;
export const ISSUE_STATE_LABEL: Record<string, string> = {
  OPEN: "Open",
  REOPENED: "Reopened",
  ADDRESSED: "Editor says fixed",
  VERIFIED: "Verified",
  NOT_APPLICABLE: "Not needed",
  DUPLICATE: "Duplicate",
};
