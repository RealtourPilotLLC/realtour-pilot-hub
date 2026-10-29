// ---------------------------------------------------------------------------
// THE CREATIVE REVIEW LANE, PURE HALF (Oct 15 2026). No prisma, no
// server-only: the brief analyser, the issue ledger, the Review Room panel
// and the drill all read the same vocabulary and the same rules.
//
// Marcee McMullen, Oct 15 2026, on why her videos kept going round: "I know I
// don't like something about it, but I wouldn't know how to tell someone to
// fix it ... I feel like it's too slow or too fast or whatever". Until today
// the work order kept a feeling like that as a literal item for the editor
// ("keep vague feelings as items"), and the editor guessed. Every guess was a
// round. So every item on a work order now says WHAT KIND of ask it is:
//
//   CORRECTION         something we got wrong or missed: a misspelled name, a
//                      wrong clip, an instruction that was not followed.
//   REFINEMENT         a clear creative change the client can name: "use the
//                      standing take", "warmer music", "cut the intro".
//   DIRECTION_UNCLEAR  a feeling with no instruction in it: "it feels flat",
//                      "something is off", "too slow or too fast".
//   SCOPE              new work beyond the video: another video, a new
//                      format, a deliverable that was never ordered.
//
// A DIRECTION_UNCLEAR item never reaches the editor as a task. It is HELD and
// goes to creative review (Jordan, or James when he is the cut's reviewer),
// who turns it into concrete changes or attaches their reading of it. The
// same happens when a client comes back on the same area of the same video
// after it was already changed, and when a second round carries an "Overall
// direction" item: that is a creative problem, not an editing one.
// ---------------------------------------------------------------------------

export const ITEM_KINDS = ["CORRECTION", "REFINEMENT", "DIRECTION_UNCLEAR", "SCOPE"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const isItemKind = (v: unknown): v is ItemKind => typeof v === "string" && (ITEM_KINDS as readonly string[]).includes(v);

export const ITEM_KIND_LABEL: Record<ItemKind, string> = {
  CORRECTION: "Correction",
  REFINEMENT: "Creative change",
  DIRECTION_UNCLEAR: "Direction unclear",
  SCOPE: "New scope",
};

/** The areas a repeat in counts as a creative problem. On-screen text and
 *  "Other" are left out: a name spelled wrong twice is an editing miss, and
 *  the issue ledger already counts that one. */
export const CREATIVE_AREAS: readonly string[] = [
  "Music & sound",
  "Graphics & effects",
  "Background & set",
  "Pacing & movement",
  "Color & styling",
  "Cuts & content",
  "Overall direction",
];

/**
 * A FEELING WITH NO INSTRUCTION IN IT. Used where no model reads the words (a
 * portal note pinned to a cut, a short text) and as a floor under the model:
 * a sentence that says the client cannot say what is wrong is unclear
 * direction whatever the model called it. Deliberately narrow: "the music is
 * too loud" is a clear change and must not match.
 */
const CANT_SAY = /\b(?:(?:i\s+)?(?:don'?t|do not|wouldn'?t|would not|can'?t|cannot|couldn'?t)\s+(?:really\s+)?(?:know|say|tell|explain|put my finger on|describe|articulate|pinpoint)(?:\s+(?:how|what|why|exactly|it|on it))?)|(?:not sure (?:what|why|how)(?:'?s| is)? (?:wrong|off|missing|it is|the problem))|(?:something(?:'?s| is| about it| just)? (?:off|missing|not right|wrong with it|isn'?t right))|(?:just (?:not|isn'?t) (?:it|right|there|feeling it))|(?:doesn'?t (?:feel|look) right)/i;
const FEELING = /\b(?:feels?|felt|seems?|looks?|comes? across)\s+(?:a (?:bit|little)\s+|kind of\s+|kinda\s+|too\s+|so\s+|very\s+|really\s+)?(?:flat|off|boring|blah|meh|weird|strange|odd|lifeless|dull|stale|generic|cheesy|cringe|wrong|amateur|not polished|unpolished|not me|not like me)\b/i;
const EITHER_OR = /\btoo (?:slow|fast|long|short|busy|plain)\s+or\s+too\s+(?:slow|fast|long|short|busy|plain)\b|\bor (?:whatever|something)\b/i;
const DONT_LIKE_VAGUE = /\b(?:i\s+)?(?:don'?t|do not)\s+(?:really\s+)?(?:like|love)\s+(?:something|it|this|that|them|the (?:video|vibe|feel))\b(?![^.!?]*\b(?:music|song|font|color|colour|logo|clip|shot|intro|ending|text|caption|background)\b)/i;

/** Pure: does this sentence say the client can't name what is wrong? */
export function soundsUnclear(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  return CANT_SAY.test(t) || FEELING.test(t) || EITHER_OR.test(t) || DONT_LIKE_VAGUE.test(t);
}

/**
 * The kind of an item, when nothing better is known. A model's answer wins
 * when it gave one, EXCEPT that words which say "I can't say what is wrong"
 * are always DIRECTION_UNCLEAR (the editor must never get a feeling as a task).
 */
export function kindOf(item: { kind?: unknown; ask?: string | null; quote?: string | null; detail?: string | null }): ItemKind {
  const words = [item.quote, item.ask, item.detail].filter(Boolean).join(" ");
  if (soundsUnclear(words)) return "DIRECTION_UNCLEAR";
  return isItemKind(item.kind) ? item.kind : "CORRECTION";
}

/**
 * Every item is new work (Oct 29 2026, 4008 Oakland Rd): a new order, a
 * reshoot, a video the job never had. Nothing on the delivered work changes,
 * so it is the office's to book or quote, not a revision. Pure.
 */
export function allNewWork(items: readonly { kind?: unknown; ask?: string | null; quote?: string | null; detail?: string | null }[]): boolean {
  return items.length > 0 && items.every((it) => kindOf(it) === "SCOPE");
}

/** Only a SUGGESTION for the issue ledger: a person confirms the cause. */
export function causeSuggestionFor(kind: string | null | undefined): "EDITOR_ERROR" | "CLIENT_CHANGE" | "NEW_SCOPE" | null {
  switch (kind) {
    case "CORRECTION": return "EDITOR_ERROR";
    case "REFINEMENT":
    case "DIRECTION_UNCLEAR": return "CLIENT_CHANGE";
    case "SCOPE": return "NEW_SCOPE";
    default: return null;
  }
}

/** What the creative review on one work order is holding, kept inside
 *  RevisionBrief.itemsJson under `creativeReview` (no schema change). */
export type CreativeReviewReason = "UNCLEAR" | "QUESTIONS" | "REPEAT_AREA" | "ROUND_TWO_DIRECTION";
export const REASON_WORDS: Record<CreativeReviewReason, string> = {
  UNCLEAR: "the client can't say exactly what to change",
  QUESTIONS: "there are open questions nobody has answered",
  REPEAT_AREA: "the client came back on the same part of the same video after it was already changed",
  ROUND_TWO_DIRECTION: "a second round is asking for a different overall direction",
};

export type CreativeReviewState = {
  state: "OPEN" | "RESOLVED";
  taskId: string | null;
  reviewerKey: string;
  reviewerName: string;
  reasons: CreativeReviewReason[];
  heldItemIds: string[];
  questions: string[];
  /** true when nothing concrete was left for the editor, so their revision card waits */
  taskHeld: boolean;
  openedAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  mode?: "CHANGES" | "AS_IS" | "NOT_NEEDED" | null;
  note?: string | null;
  /** the held items as the client said them, kept after they were resolved */
  archived?: { id: string; area: string; ask: string; quote: string | null; detail: string | null }[];
};

/** Read the creative review block out of a brief's itemsJson. Pure. */
export function creativeReviewOf(itemsJson: string | null | undefined): CreativeReviewState | null {
  if (!itemsJson) return null;
  try {
    const cr = (JSON.parse(itemsJson) as { creativeReview?: CreativeReviewState }).creativeReview;
    return cr && (cr.state === "OPEN" || cr.state === "RESOLVED") ? cr : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// THE EDITOR'S CALL (Jordan, Oct 29 2026, on 265 Mill Rd: "I would rather
// this just goes straight to the editor I shouldn't have to choose the music
// or dictate the flow"). Tim asked for "a logical flow" and "more upbeat"
// music; the analyser asked Jordan which room order and which track, and the
// open questions sent it to creative review. A choice the client left open
// that is the editor's craft (the track, the room order, the pacing, the
// transitions, the look) is the editor's to make: it goes on the work order
// as theirs, never to the reviewer. Only a question nobody in the edit can
// answer (a name or spelling, a fact about the house, footage or a reference
// that has to be found, something the client must say, new work) still waits
// on the reviewer.
// ---------------------------------------------------------------------------

const EDITORS_CRAFT = /\b(?:music|song|track|soundtrack|audio|beat|tempo|upbeat|genre|order|sequence|flow|walk-?through|pacing|pace|speed|faster|slower|transitions?|effects?|style|look|colou?r|grad(?:e|ing)|font|b-?roll|shots?|clips?|takes?|intro|outro|ending|opening|length|duration|trim)\b/i;
const NEEDS_AN_ANSWER = /\b(?:spell(?:ing|ed)?|phone|e-?mail|website|price|pricing|logo|licen[cs]e|brokerage|new order|never ordered|not (?:part of|ordered)|upload(?:ed)?|footage|raw files?|pull|which (?:video|property|house|listing)|square (?:foot|feet|footage)|sq\.? ?ft|who is|(?:agent|client|seller|their|his|her)'?s? name|confirm with (?:the )?(?:client|seller|agent)|ask (?:the )?(?:client|seller|agent)|reference (?:video|reel)|example)\b/i;

/** Is this open question a creative choice the editor makes (not one only the reviewer or the client can answer)? Pure. */
export function editorsCall(question: string | null | undefined): boolean {
  const t = (question ?? "").replace(/\s+/g, " ").trim();
  return !!t && EDITORS_CRAFT.test(t) && !NEEDS_AN_ANSWER.test(t);
}

/** The question as the editor reads it: the sentences asking the reviewer dropped, "Your call." added. Pure. */
export function editorCallWords(question: string): string {
  const t = question.replace(/\s+/g, " ").trim();
  const kept = t.split(/(?<=[.?!])\s+/).filter((s) => !/\b(?:Jordan|James|creative review|reviewer)\b/i.test(s));
  const base = (kept.length ? kept.join(" ") : t).replace(/[.?!\s]+$/, "");
  return `${base}. Your call.`;
}

/** Split a work order's open questions: the editor's calls (in their words) and the ones that still need an answer. Pure. */
export function splitEditorCalls(questions: readonly string[]): { editorCalls: string[]; needAnswer: string[] } {
  const editorCalls: string[] = [];
  const needAnswer: string[] = [];
  for (const q of questions) (editorsCall(q) ? editorCalls.push(editorCallWords(q)) : needAnswer.push(q));
  return { editorCalls, needAnswer };
}

/** The words the editor sees in place of a held item. */
export function heldPlaceholder(reviewerName: string): string {
  return `With ${reviewerName.split(/\s+/)[0]} for creative review. You'll get it here as concrete changes.`;
}

/** Turn the reviewer's typed changes into clean lines (one change per line, bullets stripped). Pure. */
export function changeLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length >= 3)
    .slice(0, 20);
}
