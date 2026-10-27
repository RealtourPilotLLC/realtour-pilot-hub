// ---------------------------------------------------------------------------
// ONLY THE TECHNICAL PREFERENCES REACH THE EDITOR (Jordan, Oct 27 2026, on the
// client's "preferences that reach the editor brief": "This is not something
// that needs to reach the editor brief ... The editor needs to know technical
// stuff about the edits, or revision requests, things like that").
//
// A client's standing preferences come from four places (their portal boxes,
// the Aryeo customer note, the AI working profile, the call facts the office
// accepted) and they mix the edit ("fast cuts, no trending audio") with the
// shoot and the relationship ("wears blue", "films Tuesdays", "text, don't
// call"). The editor's brief keeps a line only when it is about the edit:
// style and pacing, music, captions and text, the logo and colors, how they
// handle revisions. The rest stays on the client's profile, where the office
// and the photographer read it.
//
// A plain keyword reading, on purpose: it is cheap, it never calls a model,
// and when a line names both (a filming day AND the music) it is kept, since
// the edit half matters to the editor. Pure and client-safe.
// ---------------------------------------------------------------------------

/** About the edit: style, pacing, music, captions, brand, revisions. */
const TECHNICAL =
  /\b(edit(?:s|ing|ed|or)?|cuts?|cutting|pac(?:e|ing|ed)|fast|slow(?:er)?|snappy|cinematic|style|vibe|tone|transitions?|b-?roll|grad(?:e|ing)|colou?r(?:s|ed)?|lut|music|songs?|audio|sound|trending|voice(?:over)?|vo|captions?|subtitles?|text|font|typography|on[- ]screen|titles?|logo|brand(?:ing|ed)?|end ?card|intro|outro|hook|length|short|seconds?|minutes?|vertical|horizontal|aspect|thumbnail|zoom|slow[- ]?mo(?:tion)?|speed ?ramp|drone|revisions?|changes?|feedback|notes?|tweaks?)\b/i;

/** About the shoot, the schedule or the relationship, never the edit. */
const NOT_TECHNICAL =
  /\b(wardrobe|outfits?|wears?|wearing|clothes|dress(?:es)?|hair|make-?up|teleprompter|prompter|filming (?:days?|location)|film(?:s|ing)? on|location|schedul(?:e|ing)|book(?:s|ing)?|appointments?|availab(?:le|ility)|parking|lockbox|gate|call(?:s|ing)? (?:me|him|her|them)|prefers? (?:a )?(?:call|text|email)|texts?|emails?|invoice|billing|pay(?:s|ment)?|price|budget|kids|family|dog|pets?)\b/i;

/** The production slots that are about the shoot, never the edit (brandProfile PROFILE_SLOTS labels). */
const SHOOT_SLOT_NAMES = /^(wardrobe|teleprompter|filming location|preferred filming days)\b/i;

export function isTechnicalPreference(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (SHOOT_SLOT_NAMES.test(t)) return false;
  if (TECHNICAL.test(t)) {
    // "Text" alone is a phone habit; "text on screen" is a caption. A line
    // whose only edit word is "text" or "notes" next to a contact word is not
    // about the edit.
    const editWords = (t.match(new RegExp(TECHNICAL.source, "gi")) ?? []).map((w) => w.toLowerCase());
    const onlyContact = editWords.every((w) => /^(text|notes?|changes?)$/.test(w)) && NOT_TECHNICAL.test(t);
    return !onlyContact;
  }
  return false;
}

/** A free-text box kept to its technical lines (sentence by sentence). Null when none is left. */
export function technicalLines(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const parts = t
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = parts.filter(isTechnicalPreference);
  if (!kept.length) return null;
  return kept.length === parts.length ? t : kept.join("\n");
}

/** A production default ("Wardrobe: navy suit") kept only when it is about the edit. */
export function isTechnicalDefault(d: { name: string; text: string }): boolean {
  if (SHOOT_SLOT_NAMES.test(d.name.trim())) return false;
  return isTechnicalPreference(`${d.name}: ${d.text}`);
}
