// ---------------------------------------------------------------------------
// EDITING DIRECTION THAT SAYS SOMETHING (Oct 29 2026, Jordan and James's call:
// "Harrison's editor notes could amount to 'standard edit.'" ... "Make useful
// editing direction part of the upload submission process").
//
// The submit gate (upload/actions.ts) and the page (UploadPortal) already
// refused an EMPTY brief, but anything typed passed: the live briefs that
// reached the editors in the 45 days before read "Standard edit", "N/A",
// "None", "Cinematic", "Standard fast paced premium reel" and "Same as
// previous videos for John". This is the one answer to "does this tell the
// editor anything": at least SPECIFIC_WORDS_NEEDED words that are not a
// style label, a placeholder or filler. "Show the kitchen and pool" passes;
// "Standard edit" does not.
//
// Where it applies: only where a brief is already required (not a plain
// social reel, Jordan Sep 1: "if it's a standard social reel, it doesn't need
// additional notes"), at the moment the photographer submits the video half.
// Never on files: the upload itself is never held. Nothing already handed in
// is re-judged (lib/handoff's readiness still reads meaningfulBrief).
//
// Pure, no server imports: the page asks the same question before the server
// refuses.
// ---------------------------------------------------------------------------

/** The headings whose text is the photographer's direction for the edit. */
const DIRECTION_HEADINGS = new Set([
  "VISION FOR THE EDIT",
  "SUMMARY",
  "SHOTS THAT MUST BE SHOWN",
  "AREAS TO AVOID",
  "THINGS TO AVOID",
  "REALTOR REQUESTS",
  "ADDITIONAL NOTES",
  "EDITING NOTES",
]);
/** Headings whose text is a script or a song, not direction. */
const OTHER_HEADINGS = new Set(["INTRO SCRIPT", "SCRIPT FOR THIS VIDEO", "SONG OR MUSIC"]);
const MACHINE_LINE = /^(STYLE:|COLOR PROFILE:|SONG (?:REQUEST|TITLE|LINK|START):)/i;

/**
 * Words that say nothing about THIS edit on their own: style labels the page
 * already records, placeholders, and filler. Lower case.
 */
const EMPTY_WORDS = new Set([
  // placeholders
  "na", "n/a", "none", "nothing", "nope", "no", "tbd", "idk", "nil", "null", "x", "-", "ok", "okay",
  // "standard edit", "same as usual", "normal style"
  "standard", "normal", "usual", "regular", "typical", "default", "basic", "simple", "generic", "same", "previous", "prior", "last", "before", "always", "again", "other", "others",
  "edit", "edits", "editing", "edited", "cut", "notes", "note", "instructions", "instruction", "special", "requests", "request",
  // style labels (the STYLE line carries these already)
  "cinematic", "cinematics", "fast", "paced", "fast-paced", "pace", "pacing", "premium", "reel", "reels", "video", "videos", "social", "media", "style", "vibe", "vibes", "elegant", "timeless", "branding", "personal",
  // praise and filler
  "nice", "good", "great", "clean", "cool", "best", "please", "thanks", "thank", "you", "just", "like", "really", "very", "whatever", "anything", "fine", "etc",
  // grammar
  "a", "an", "the", "and", "or", "but", "to", "of", "for", "with", "in", "on", "at", "as", "is", "it", "its", "it's", "be", "this", "that", "these", "those", "our", "we", "us", "my", "i", "per", "all", "any", "so", "do", "does", "should", "would", "will", "can",
]);

/** How many words of real direction a required brief needs. */
export const SPECIFIC_WORDS_NEEDED = 2;

/**
 * The photographer's direction in a composed brief: the text under the
 * direction headings (or, in a brief with no headings, every line), without
 * the STYLE, COLOR PROFILE and song lines and without any script. Pure.
 */
export function directionText(composed: string | null | undefined): string {
  const out: string[] = [];
  let current: "direction" | "other" | null = null;
  for (const raw of (composed ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || MACHINE_LINE.test(line)) continue;
    if (DIRECTION_HEADINGS.has(line)) { current = "direction"; continue; }
    if (OTHER_HEADINGS.has(line)) { current = "other"; continue; }
    if (current !== "other") out.push(line);
  }
  return out.join("\n").trim();
}

/** The words that say something about this edit. Pure. */
export function specificWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'’/-]*/g) ?? [])
    .map((w) => w.replace(/[’]/g, "'").replace(/^[-/]+|[-/.]+$/g, ""))
    .filter((w) => w.length >= 2 && !EMPTY_WORDS.has(w) && !EMPTY_WORDS.has(w.replace(/'s$/, "")));
}

/** The prompts the page offers as one-tap starters, in the order the editor reads them. */
export const DIRECTION_PROMPTS = [
  { key: "feature", label: "What to feature", starter: "Feature: " },
  { key: "best", label: "Best clips or rooms", starter: "Best clips: " },
  { key: "avoid", label: "Anything to avoid", starter: "Avoid: " },
  { key: "agent", label: "Agent on camera", starter: "Agent on camera: " },
] as const;
/** A monthly content session is the client on camera, topic by topic, not a house. */
export const SESSION_DIRECTION_PROMPTS = [
  { key: "feature", label: "What to feature", starter: "Feature: " },
  { key: "best", label: "Best takes", starter: "Best takes: " },
  { key: "avoid", label: "Anything to avoid", starter: "Avoid: " },
  { key: "agent", label: "On-camera moments", starter: "On camera: " },
] as const;
const STARTERS = [...DIRECTION_PROMPTS, ...SESSION_DIRECTION_PROMPTS].map((p) => p.starter.trim().toLowerCase());

/** The box's text with one starter added on its own line (never twice). Pure. */
export function withStarter(text: string, starter: string): string {
  const has = text.split("\n").some((l) => l.trim().toLowerCase().startsWith(starter.trim().toLowerCase()));
  if (has) return text;
  const base = text.replace(/\s+$/, "");
  return base ? `${base}\n${starter}` : starter;
}

/**
 * Why this required brief does not yet tell the editor anything, in words for
 * the photographer, or null when it does. `composed` is the saved shape (or
 * the text of one box). Pure.
 */
export function editingDirectionProblem(composed: string | null | undefined, opts: { name?: string } = {}): string | null {
  // A starter tapped and left empty ("Avoid: ") is not direction either.
  const text = directionText(composed)
    .split("\n")
    .map((l) => { const s = STARTERS.find((st) => l.toLowerCase().startsWith(st)); return s ? l.slice(s.length).trim() : l; })
    .filter(Boolean)
    .join("\n");
  if (specificWords(text).length >= SPECIFIC_WORDS_NEEDED) return null;
  const said = text.replace(/\s+/g, " ").trim();
  const quoted = said && said.length <= 40 ? `“${said}” doesn't tell the editor much` : said ? "That doesn't tell the editor much yet" : "The editor needs a line or two";
  return `${quoted}${opts.name ? ` for ${opts.name}` : ""}. Add what to feature, your best clips or rooms, anything to avoid, and when the agent is on camera.`;
}
