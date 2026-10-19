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

/** A stored suggestion or imported label is not a person's classification. */
export function hasConfirmedIssueCause(issue: { cause: string; causeConfirmedAt?: Date | null; causeConfirmedBy?: string | null }): boolean {
  return isIssueCause(issue.cause) && issue.cause !== "UNCLASSIFIED" &&
    !!issue.causeConfirmedAt && !!issue.causeConfirmedBy?.trim();
}

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

export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];
export const isIssueCategory = (v: unknown): v is IssueCategory =>
  typeof v === "string" && (ISSUE_CATEGORIES as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// A SUGGESTED CATEGORY, FROM THE NOTE'S OWN WORDS (Oct 16 2026).
//
// 62 of 80 issues read "Other": a Review Room note carries no area, so every
// "Thing -> Things" and every "add Mike's animated logo" landed in one bucket
// and nobody could count a repeat. This reads the words and SUGGESTS one of the
// categories above, the way causeSuggested suggests a cause: never written to
// `category` (a person's pick, or the work order's own area, is that), stored
// beside it (revisionIssues.suggestIssueCategory). Null = the words do not say.
//
// Each family counts once however often its words appear ("cut this, cut
// that" is one signal), so a long note is not outvoted by its own repetition.
// A tie goes to the earlier category in this list: text and sound are the
// most specific complaints a note makes.
// ---------------------------------------------------------------------------
const CATEGORY_SIGNALS: { category: IssueCategory; weight: number; re: RegExp }[] = [
  // ON-SCREEN TEXT: a word swap ("Thing -> Things"), a typo, a caption.
  { category: "On-screen text", weight: 3, re: /(?:-+>|—+>|–+>|→|=>)/ },
  { category: "On-screen text", weight: 2, re: /\b(?:typos?|spell(?:ed|ing|s)?|misspel\w*|caption\w*|subtitle\w*|wording|grammar|punctuation|capitali[sz]\w*|the words?|text|title card|pops? up|on[- ]screen)\b/i },
  { category: "On-screen text", weight: 2, re: /\b(?:should be|instead of|not)\s+["“'‘]/i },
  // A quoted word being removed, added or changed ("Remove "of"", "change "is" to "was"").
  { category: "On-screen text", weight: 2, re: /\b(?:remove|delete|add|change|replace|missing|forgot)\b[^.\n]{0,20}["“][^"”\n]{1,25}["”]/i },
  { category: "On-screen text", weight: 1, re: /["“][^"”\n]{1,40}["”]/ },
  // MUSIC & SOUND.
  { category: "Music & sound", weight: 3, re: /\b(?:music|songs?|track|soundtrack|tune)\b/i },
  { category: "Music & sound", weight: 3, re: /\b(?:audio|sound|volume|loud(?:er|ness)?|quiet(?:er)?|voice(?:-?over)?|mic|mute[ds]?|muffled|echo)\b/i },
  { category: "Music & sound", weight: 2, re: /\b(?:out of sync|off timing|lip ?sync|behind the video|lyrics|beat|censor\w*|bleep\w*)\b/i },
  // GRAPHICS & EFFECTS (the brand on screen: logo, end card, font, colour).
  { category: "Graphics & effects", weight: 3, re: /\b(?:logos?|end ?cards?|endcards?|fonts?|branding|brand|animation|animated|graphics?|overlays?|lower thirds?|watermark|stickers?|icons?|mirror(?:ed|ing)?|effects?)\b/i },
  { category: "Graphics & effects", weight: 1, re: /\bcolou?rs?\b/i },
  // COLOR & STYLING (the grade, not a brand colour).
  { category: "Color & styling", weight: 3, re: /\b(?:colou?r ?grad\w*|grading|exposure|brightness|brighter|darker|too dark|too bright|saturat\w*|white balance|contrast|warmer|cooler|washed out|lut)\b/i },
  // BACKGROUND & SET.
  { category: "Background & set", weight: 2, re: /\b(?:background|backdrop|glitter|props?)\b/i },
  // CUTS & CONTENT: trim, cut, remove, shorten, order, add a shot.
  { category: "Cuts & content", weight: 2, re: /\b(?:trim\w*|cut|cuts|remove[ds]?|delete[ds]?|shorten\w*|shorter|drop(?:ped)?|re-?order\w*|swap\w*|switch\w* (?:those|them|these|it|the two)? ?around|replace[ds]?|throw in|insert\w*)\b/i },
  { category: "Cuts & content", weight: 2, re: /\b(?:start(?:s|ing)? (?:of|on|with)|opening|first frame|this frame|rewind|missing (?:the |a )?(?:\w+ ){0,2}(?:clips?|shots?|scenes?|part|room|section)|(?:should|needs? to) be a (?:clip|shot|scene))\b/i },
  { category: "Cuts & content", weight: 2, re: /\badd(?:ed)? (?:in )?(?:a |the |an )?(?:clip|shot|scene|photo|picture|snapshot|image|rendering|b-?roll|drone)\b/i },
  { category: "Cuts & content", weight: 1, re: /\b(?:clips?|scenes?|shots?|footage|b-?roll|takes?)\b/i },
  // PACING & MOVEMENT.
  { category: "Pacing & movement", weight: 2, re: /\b(?:pace|paced|pacing|faster|slower|speed(?: it)? up|too long|drawn out|linger\w*|timing|stabili[sz]\w*|shaky|shake|punch(?:ed)? in|zoom\w*|crop\w*|reframe\w*|transitions?|movement)\b/i },
  // EXPORT & UPLOAD.
  { category: "Export & upload", weight: 2, re: /\b(?:export\w*|resolution|blurry|pixelat\w*|1080p?|4k|aspect ratio|vertical|horizontal|download\w*|upload\w*|compress\w*)\b/i },
  { category: "Export & upload", weight: 1, re: /\b(?:social media|youtube|facebook|instagram|tiktok)\b/i },
  // OVERALL DIRECTION: a feeling about the whole thing.
  { category: "Overall direction", weight: 1, re: /\b(?:feels?|vibe|mood|tone|too heavy|dramatic|polished|energy|overall|whole thing)\b/i },
];
const CATEGORY_ORDER: IssueCategory[] = ["On-screen text", "Music & sound", "Graphics & effects", "Color & styling", "Background & set", "Cuts & content", "Pacing & movement", "Export & upload", "Overall direction"];

/** The category the words point at, or null when they point at nothing
 *  (score under 2: "Everything else is perfect!", "So with a"). Pure. */
export function suggestIssueCategory(text: string | null | undefined): IssueCategory | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const score = new Map<IssueCategory, number>();
  for (const s of CATEGORY_SIGNALS) if (s.re.test(t)) score.set(s.category, (score.get(s.category) ?? 0) + s.weight);
  let best: IssueCategory | null = null;
  let top = 1;
  for (const c of CATEGORY_ORDER) {
    const n = score.get(c) ?? 0;
    if (n > top) { best = c; top = n; }
  }
  return best;
}

/** What a report should count an issue under: the category a person (or the
 *  work order) gave it, else the hub's suggestion, else "Other". */
export function effectiveIssueCategory(category: string | null | undefined, suggested: string | null | undefined): string {
  if (category && category !== "Other") return category;
  return isIssueCategory(suggested) && suggested !== "Other" ? suggested : "Other";
}

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
