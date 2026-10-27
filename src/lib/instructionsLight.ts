// ---------------------------------------------------------------------------
// LIGHT VIDEO INSTRUCTIONS (Jordan, Oct 27 2026: "Skipping the instructions
// though hurts their KPIs. Also weak instructions hurts their KPI as well. So
// when the instructions are light and they don't really give good
// instructions, then that can hurt as well.").
//
// ONE RULE, two readers: the upload page's "These instructions are light"
// hint (before the submit) and the KPI's instructions entry (lib/kpiEvidence),
// so the page never calls words fine that the KPI then counts against them.
// Instructions are LIGHT when
//   · they hold fewer than LIGHT_WORDS of the photographer's OWN words
//     (section headings, the STYLE / COLOR PROFILE / SONG lines and
//     placeholder answers like "n/a" or "standard" do not count), or
//   · on a full brief (the premium shapes), they carry neither a vision nor
//     a style.
// Deterministic on purpose: no model reads the words, so the photographer can
// see exactly what the hint and the KPI see.
//
// Pure and client-safe.
// ---------------------------------------------------------------------------

/** Fewer of the photographer's own words than this reads as light (it was 12, "thin", until Oct 27 2026). */
export const LIGHT_WORDS = 20;

const HEADINGS = new Set([
  "VISION FOR THE EDIT", "SUMMARY", "SHOTS THAT MUST BE SHOWN", "AREAS TO AVOID", "THINGS TO AVOID",
  "REALTOR REQUESTS", "ADDITIONAL NOTES", "INTRO SCRIPT", "EDITING NOTES",
  "SCRIPT FOR THIS VIDEO", "SONG OR MUSIC",
]);
const PLACEHOLDER = /^(n\/?a|na|none|nothing|no|nope|same|same as usual|as usual|standard|normal|usual|ok|okay|good|fine|tbd|see above|-+|\.+)$/i;
const MACHINE_LINE = /^(STYLE|COLOR PROFILE|SONG (?:REQUEST|TITLE|LINK|START)):/i;

const ownLines = (text: string | null | undefined) =>
  (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((t) => t && !MACHINE_LINE.test(t) && !HEADINGS.has(t.toUpperCase()) && !PLACEHOLDER.test(t));

const countWords = (lines: string[]) =>
  lines.join(" ").split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;

/** How many of the photographer's OWN words a video brief holds (pure). */
export function ownWords(text: string | null | undefined): number {
  return countWords(ownLines(text));
}

/** The words under the "VISION FOR THE EDIT" heading (up to the next heading); free text
 *  before any heading counts too, as the upload page reads it into the vision box. */
function visionWords(text: string | null | undefined): number {
  const out: string[] = [];
  let inVision = true;
  for (const raw of (text ?? "").split("\n")) {
    const t = raw.trim();
    if (HEADINGS.has(t.toUpperCase())) { inVision = t.toUpperCase() === "VISION FOR THE EDIT"; continue; }
    if (inVision && t && !MACHINE_LINE.test(t) && !PLACEHOLDER.test(t)) out.push(t);
  }
  return countWords(out);
}

export type LightVerdict = {
  light: boolean;
  /** the photographer's own words */
  words: number;
  /** why it reads as light, in the photographer's words (null = not light) */
  why: string | null;
};

/**
 * Are these instructions light? `full`: the brief is a full one (vision and
 * style expected), where a brief with neither is light whatever its length.
 */
export function lightInstructions(text: string | null | undefined, opts: { full?: boolean } = {}): LightVerdict {
  const words = ownWords(text);
  if (words < LIGHT_WORDS) {
    return { light: true, words, why: `${words} word${words === 1 ? "" : "s"} of your own; aim for at least ${LIGHT_WORDS}: the flow, the must-show moments and anything to avoid` };
  }
  if (opts.full && visionWords(text) === 0 && !/^STYLE:\s*\S/im.test(text ?? "")) {
    return { light: true, words, why: "no vision for the edit and no style" };
  }
  return { light: false, words, why: null };
}
