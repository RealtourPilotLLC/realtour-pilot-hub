// ---------------------------------------------------------------------------
// THE SCRIPT WRITER'S RULES (Oct 22 2026). Pure data and pure functions: no
// database, no model, nothing that cannot run in a drill or a client bundle.
//
// Jordan's decisions, Oct 22 2026 (they override the Oct 21 plan where they
// differ):
//   1. LENGTH. A script is no more than 110 spoken words. Over 110 it is
//      marked "A bit long: needs a fix" and the AI trims it; a long one is
//      never quietly shared. Later the same day: "Scripts should aim though
//      for 55 - 85 words without making it dry, or incomplete." So the writer
//      and the reviewer AIM for 55 to 85; 86 to 110 is allowed and flagged as
//      advice only ("Longer than the 55 to 85 aim"); under 55 is fine only when
//      nothing the brief marks must-keep is missing (the "enough substance"
//      check guards that). Substance is never cut to hit a number.
//   2. CLOSE. Depending on the message, either a call to action or a callback
//      to the hook. The old "memorable final line, contact ask only in the
//      caption" rule is retired for this writer; the caption keeps its line.
//   3. CLIENT FACTS (the retrieval side lives in sources.ts).
// Standing rules: no em dashes, never note durations in a script, no invented
// claims, background reasoning is not approved spoken content, neither our
// version nor the client's wins automatically.
// ---------------------------------------------------------------------------

import { GENERATION_POLICY, BANNED_OPENERS, SCRIPT_PART_BUDGETS, countSpokenWords } from "../contentPolicy/policy";

/**
 * Stamped on every brief, run and version the writer makes. Bump on any rule change below.
 * v2.1 (Oct 22 2026, after the offline test on Marcee's three scripts landed
 * every one at 105 to 109 words): the aim is made real. The draft targets
 * about 75 spoken words; a passing draft over 85 gets ONE trim pass toward 75
 * to 80 that may drop nothing the brief marks must-keep, and is reviewed
 * again; when the trim loses substance, the longer passing version is kept.
 */
export const WRITER_VERSION = "writer.v2.3-2026-10-22";
// v2.2 (Oct 22 2026, the listening fix, LISTENING.md): Jordan's lines and her
// older calls reach the writer (the other-client filter no longer takes them);
// older calls are read by her words, in a second retrieval; accepted facts from
// older months count; the brief chooses one angle and one proof (must-keep
// capped, never a live deal) and carries the interviewer's question; a story's
// hook opens on her moment, and a failed hook or re-hook starts the next round
// from the runner-up hook; no client's finals are quoted in any rule.
// v2.3 (Oct 22 2026, the craft fix). Jordan on the v2.2 drafts: "Really weak
// hooks and re-hooks, too long, and the close is not very memorable", the
// structure rules "thrown out the window". An independent review of the
// offline drafts (Erica Walker 5, John Collins 4) found them shorter and
// nearly free of invented claims, but no better at hooks, re-hooks or closes,
// her told story dropped, and a review gate that passed every draft:
//   1. HOOKS. Five of nine hooks were the same formula (a viewer's sentence in
//      the first person) and flat self-scores (28 to 34) let list order pick.
//      Hooks are now scored on tension too; only a hook with curiosity 4+ and
//      tension 4+ is eligible (the best of the rest is a recorded fallback);
//      they rank by curiosity + tension + specificity, the total only breaks a
//      tie, and on a tie her own moment wins when the proof is her story. The
//      hooks step sees this month's other openings, for variety.
//   2. RE-HOOKS hedged ("Maybe.") or restated the hook. The re-hook check
//      names both; code flags a hedge opener and a re-hook or build-up that
//      repeats the hook's words (hook_echo).
//   3. THE PROOF was a restated claim, and the story she told was dropped. The
//      proof is one real moment she told; her answer to an ask for an example
//      is a must-keep, and leaving her story out fails "Enough substance".
//   4. SELF-PITCH. The payoff turned into "My job is" and scripts pitched
//      twice: how she helps appears once, in the payoff or the close; the
//      payoff answers the hook in one line; must-keep is three for an
//      educational video, never the invitation.
//   5. CLOSES were a template ("[question]? Let's talk."): the close is a
//      callback to the hook, then this video's own next step; the close check
//      is must-fix; code flags a close with nothing from the hook or the
//      template (generic_close).
//   6. LENGTH piled up at the top of the range (the aim trim fired only over
//      85): the draft writes toward 68, a passing draft over 78 is trimmed
//      toward 65 to 75, and a kept longer version that says the line the
//      trim's review failed is flagged, not passed. The aim stays 55 to 85,
//      the cap 110.
//   7. JARGON slipped through as one of "her phrases": her phrases never
//      override plain words, and code knows four more terms.
//   8. THE REVIEW GATE judged compliance, not craft: it now scores the five
//      parts 1 to 5 with a psychology note each; any part under 4 is
//      must-fix, and a hook or re-hook under 4 starts again from the
//      runner-up hook. A format agreed on the call is a creative decision.
//   And THE MODEL MAP (Jordan, the same day: "$18 for scripts is insane ...
//   Make sure it's still a good model for this though"; 16 offline scripts on
//   Opus 5.5 cost $19.49): hooks stay on Opus 5.5 (high); the brief, draft,
//   review and revisions run on Sonnet 5.5 (high for writing, medium for the
//   brief and the review); retrieval on Haiku 5.5 (medium). Every step names
//   its model and effort (pipeline STEP_MODEL / STEP_EFFORT), and the long
//   stable part of each prompt is cached, so a second review or fix round
//   reads her call and the brief from the cache.

/** Words and seconds (Jordan, Oct 22 2026). Seconds are an estimate at the hub's speaking rate, never a measurement. */
export const WRITER_LENGTH = {
  /** Jordan's aim and cap: 55 to 85 words, 110 at most. */
  aim: [55, 85] as const,
  /** What the draft writes toward (v2.3: 68; it was 75 and drafts piled up at 85). */
  target: 68,
  /** Where the trim pass aims (v2.3: 65 to 75). */
  trimTo: [65, 75] as const,
  /** A passing draft over this many words gets the one aim trim (v2.3: 78; it was the aim's top, 85). */
  trimAbove: 78,
  cap: 110,
  wordsPerSec: GENERATION_POLICY.timing.wordsPerSec,
} as const;

/**
 * How many must-keep points a brief may carry (Oct 22 2026, the listening
 * fix). The brief put her whole answer on the list (the old belief, the
 * balance, three buyer expectations, the even playing field, a live deal, the
 * agent advice), the trim and the review then enforced it, and the 2022 script
 * came out as notes. Jordan's finals keep one idea and one proof. An
 * educational video keeps at most three (v2.3: the belief, the proof, how she
 * helps; what the viewer should do and the invitation belong to the close and
 * are never must-keep); a personal story keeps its beats, at most six. Code
 * holds the cap and moves an invitation out (pipeline.briefFrom).
 */
export const BRIEF_MUST_KEEP_MAX = { educational: 3, story: 6 } as const;

export const OVER_CAP_LABEL = "A bit long: needs a fix";
export const LONG_ADVISORY_LABEL = "Longer than the 55 to 85 aim";

export type LengthBand = "short" | "aim" | "long" | "over";

export function estimateSeconds(words: number): number {
  return Math.round(words / WRITER_LENGTH.wordsPerSec);
}

/** Where a word count sits: under the aim, inside it, allowed but long, or over the 110 cap. */
export function lengthBand(words: number): LengthBand {
  if (words > WRITER_LENGTH.cap) return "over";
  if (words > WRITER_LENGTH.aim[1]) return "long";
  if (words < WRITER_LENGTH.aim[0]) return "short";
  return "aim";
}

/** The one line the script card shows about length, or null when there is nothing to say. */
export function lengthLabel(words: number): { band: LengthBand; text: string; seconds: number } | null {
  const band = lengthBand(words);
  const seconds = estimateSeconds(words);
  if (band === "over") return { band, seconds, text: `${OVER_CAP_LABEL} (${words} words, about ${seconds} seconds; the cap is ${WRITER_LENGTH.cap})` };
  if (band === "long") return { band, seconds, text: `${LONG_ADVISORY_LABEL} (${words} words, about ${seconds} seconds). Allowed; trim only if nothing is lost.` };
  return { band, seconds, text: `${words} words, about ${seconds} seconds` };
}

/** Every trim instruction starts with this, so a revision can tell a length trim from any other request. */
export const LENGTH_TRIM_MARK = "LENGTH TRIM";
export function isLengthTrimInstruction(instruction: string | null | undefined): boolean {
  return (instruction ?? "").trimStart().startsWith(LENGTH_TRIM_MARK);
}

/**
 * The trim instruction: the automatic trim passes (over the 110 cap, and the
 * one pass toward WRITER_LENGTH.trimTo for a passing draft over trimAbove) and the card's
 * one-press "Fix with AI". The brief's must-keep points are named when known;
 * none of them may be dropped to hit the number.
 */
export function trimInstruction(words: number, mustKeep: readonly string[] = []): string {
  const over = words > WRITER_LENGTH.cap;
  const [lo, hi] = WRITER_LENGTH.trimTo;
  return [
    `${LENGTH_TRIM_MARK}: this version is ${words} spoken words, about ${estimateSeconds(words)} seconds.${over ? ` That is over the ${WRITER_LENGTH.cap}-word cap.` : ""}`,
    `Trim it toward ${lo} to ${hi} spoken words (the aim is ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]}${over ? `; it must end at ${WRITER_LENGTH.cap} words or fewer` : ""}).`,
    mustKeep.length
      ? `These must-keep points from the brief survive, in substance: ${mustKeep.map((m) => `"${m.replace(/\s+/g, " ").trim()}"`).join("; ")}.`
      : "Every must-keep point in the topic brief survives, in substance (with no brief: her own process, her facts and the payoff).",
    "Cut optional material first: a second example that makes the same point, repeated setup, hedges, and any sentence that restates the one before it.",
    "Never drop a must-keep point, her process or the payoff to hit the number: if the range cannot be reached without losing one, stop at the shortest version that keeps them all. Never make it dry or incomplete.",
    "Keep the hook unless it is the long part, exactly three talking points in the order Re-hook, Build up, Payoff, and the close.",
    "No em dash or en dash anywhere; never write a duration or a timing note into the script.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Rules text the writer, the reviser and the reviewer all read.
// ---------------------------------------------------------------------------

// v2.1 (Jordan on the retro test, Oct 22 2026: every one of his finals ends on
// a warm spoken invitation): the invitation is the DEFAULT; a callback alone
// only for a story with no service angle, and a callback may carry the invite.
// Oct 22 2026 (the listening fix): Jordan's three finals for Marcee were quoted
// here, in the hooks and in the brief as "another agent's" examples. For
// Marcee they were the answer key and a ban on her own framings at once, so
// every rule below describes the SHAPE in plain words and quotes no client.
// v2.3 (the craft fix): 8 of 9 offline closes said "let's" and 4 were a
// question followed by "Let's talk.", so the close is now two beats with a
// callback to the hook first and THIS video's own next step second.
export const CLOSE_RULE = `CLOSE (Jordan, Oct 22 2026): the close is at most two beats, in the client's voice.
1. A line that calls back a concrete word or image from the hook, so the end answers the beginning and the viewer remembers it.
2. Then, when there is a service angle, a warm invitation that names THIS video's specific next step (what to bring, what to ask her, what she will look at with them), said the way she would say it.
"Let's talk" as the whole invitation fails, and so does an invitation that opens "Thinking about X?". Never a hard sell, never "DM me" slang the client would not say, never a pitch.
- "cta" (the default): the callback line, then that invitation.
- "callback": only when the video is purely a story with no service angle; the callback line resolves the hook, and may still carry a soft invitation.
- A slogan or a rhyming aphorism is not a close. The brief decides which one (closeType) and says why. The caption CTA still carries the contact line.`;

// ---------------------------------------------------------------------------
// HER MATERIAL, OUR WORDING (Jordan on the retro test, Oct 22 2026: the seniors
// draft was her transcript lines stitched together, "My finals were much
// better"). What she said is the material; how it is said on camera is the
// craft Realtour Pilot brings.
// ---------------------------------------------------------------------------
export const WORDING_RULE = `HER MATERIAL, OUR WORDING: her facts, stories, chronology, motivations, opinions and meaning are the material; the WORDING is ours: tight, natural, spoken and polished, the way she would say it on her best take. Use her exact phrasing only where it is strong and natural on camera: short, vivid, her own vocabulary (a few words of hers that carry feeling or a picture, found in THIS client's sources). Never paste her spoken sentences from a call: transcript speech rambles, restarts and fills ("um", "you know", "I guess", "it's just that"). A faithful paraphrase of something she said is supported; adding something she did not say is not.`;

/**
 * Jordan's lessons from Marcee's three scripts (JORDAN-BRIEF.md, cases 1 to 3,
 * "Lessons for future scripts"), as house craft for EVERY client. Oct 22 2026
 * (the listening fix): the lessons stay; the lines from her finals that
 * illustrated them are gone (see CLOSE_RULE).
 */
export const HOUSE_CRAFT_RULES = `HOUSE CRAFT (Jordan's lessons, for every client)
PERSONAL BRAND STORIES (her background, a career change, why she does this work):
- An understandable narrative progression, in the order it happened: where she was and what she loved; her ACTUAL reason for the change, in her terms (what she said, whatever it was: that reason is the heart of the story, never "biography" to cut); what she expected; what actually happened (the turn); the insight that connects her past to the viewer's need; how she helps the viewer now.
- Correct chronology. Never invent a motivation to create drama.
- Keep the emotionally meaningful words she uses about her purpose.
- One compelling story, not a complete biography: job duties, side facts and a second turn go.
- The insight is the point: why her experience matters to THIS viewer, and what she gives them. A fun fact about her (who her favorite clients are, a hobby, an award) is not the message.
- Give the viewer a reason to trust or remember her.
EDUCATIONAL VIDEOS:
- Understand the underlying topic, not the title's wording; do not change an established topic because other angles came up.
- Hook on a relatable belief or misconception, in the words a homeowner or buyer would actually say (their own sentence, not a description of them).
- A belief line must carry its own tension: a cost, a reversal or an unanswered question. A bare wish or belief with nothing at stake is not a hook.
- Explain why the belief no longer holds, or why it is not the whole story.
- Prove it with one real moment she told: what happened, one number or detail, how it ended. When the interviewer asked for an example (have you ever, a real example, what was the outcome), her answer is the proof and a must-keep. A restated opinion is never the proof. A story that seems to contradict the message is framed, not dropped.
- Show her actual process and what she does differently; keep the specific details of her process.
- Use a meaningful contrast from her own material (two things she set side by side); never an invented analogy or a forced example.
- Balanced: explain the challenge without creating fear. Never add a market claim because it sounds plausible; background reasoning is not spoken content.
EVERY SCRIPT: the payoff answers the hook's question and explains why it matters; how she helps appears once, in the payoff or the close, never both; the close is a natural next step tied to the premise.
A format agreed on the call (word association, two voices, a trend alert) is a creative decision the script follows, not production talk.`;

export const HOMEOWNER_LANGUAGE_RULE = `PLAIN WORDS FOR HOMEOWNERS AND BUYERS: speak the way a homeowner or a buyer talks, never in industry terms. "Buyer avatar", "comps", "CMA", "absorption rate", "list-to-sale ratio", "DOM", "impervious coverage", "setbacks", "actives", "pendings" and similar are the client's working vocabulary, not words to say to a viewer: say what they mean ("who is most likely to buy your house", "what similar homes sold for", "how much of the lot you can build on"). A phrase of hers is still jargon if a homeowner would not say it; her phrases never override this rule. In an educational video, prefer a line the viewer might say themselves (their own sentence) over addressing them by category ("Sellers, ..."). Never open by naming the audience ("Sellers," / "Buyers,").`;

export const TOPIC_LABEL_RULE = `THE TOPIC TITLE IS A LABEL, NOT COPY: the title organises the plan; it is not a line to say and its wording is not the angle (a title that names a year, a series or a slogan does not put that word in the script). Understand what the topic is about and say that, in the client's words.`;

export const ASSUMPTION_RULE = `OUR ASSUMPTIONS ARE NOT HER CLAIMS: the topic's description, intended message, audience need and business goal were written by us or by an AI. They are our assumption about the video's purpose, never a source for a fact, a claim, a statistic or a story. Every factual line traces to something the client said (a call passage, her written answers, a client fact) or to her approved strategy.`;

export const BACKGROUND_RULE = `BACKGROUND IS NOT SPOKEN CONTENT: reasoning, context and strategy notes (ours or the client's) explain why a video exists; they are not approved lines for the client to say. A point the client did not present as part of her message (for example a market cause such as interest rates) stays out of the script unless she said it as part of this message.`;

export const NO_DURATION_RULE = "Never write a duration, a timestamp or a timing note into the script (no \"(10 seconds)\", no \"[0:15]\", no \"30s\").";

export const NO_DASH_RULE = GENERATION_POLICY.punctuation.rule;

export const LENGTH_RULE = `LENGTH (Jordan, Oct 22 2026: "aim for 55 to 85 words without making it dry or incomplete"): write about ${WRITER_LENGTH.target} spoken words (about ${estimateSeconds(WRITER_LENGTH.target)} seconds), inside the ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]} range. The brief's must-keep points are the ONLY things that must survive; optional material, a second example, extra setup and anything that restates a point go first. Count your words before you answer. ${WRITER_LENGTH.cap} spoken words is the hard cap; ${WRITER_LENGTH.aim[1] + 1} to ${WRITER_LENGTH.cap} is a miss, allowed only when the must-keep points cannot fit in fewer. Under ${WRITER_LENGTH.aim[0]} is fine only when nothing the brief marks must-keep is missing. Never make it dry or incomplete to hit the number: each sentence creates interest, builds understanding, delivers value, earns trust or moves the story.`;

export const NEITHER_WINS_RULE = "NEITHER VERSION WINS AUTOMATICALLY: when there is an earlier version, a client's rewrite or a reviewer's instruction, keep the strongest information and language from each while staying on the topic's one message. A client's longer rewrite is mined for its facts and phrases, not accepted for its length; our draft is not defended for being ours.";

// ---------------------------------------------------------------------------
// The independent review: Jordan's 12 checks (the plan's quality table), and
// since v2.3 a 13th, the craft block, scored part by part.
// ---------------------------------------------------------------------------

/** The five parts of every script (HOOK, RE-HOOK, BUILD-UP, PAYOFF, CLOSE). */
export const SCRIPT_PART_KEYS = ["hook", "rehook", "buildup", "payoff", "close"] as const;
export type ScriptPartKey = (typeof SCRIPT_PART_KEYS)[number];

export type CheckLevel = "must-fix" | "flag";
export const REVIEW_CHECKS = [
  { key: "on_topic", n: 1, label: "On topic", level: "must-fix", passes: "It delivers the brief's one message; no new topic smuggled in." },
  { key: "her_meaning", n: 2, label: "Her meaning", level: "must-fix", passes: "Nothing she said is bent; the chronology matches her account." },
  { key: "hook", n: 3, label: "Hook", level: "must-fix", passes: "A relatable belief, contrast, question or real moment that carries its own tension (a cost, a reversal or an unanswered question). A bare wish or belief with nothing at stake fails. No \"Today I want to talk about\", no greeting, no naming the audience." },
  { key: "rehook", n: 4, label: "Re-hook", level: "must-fix", passes: "Adds a fact, turn or stake that is not in the hook. Fails if it opens with a hedge (Maybe, Not exactly), restates the hook's subject in other words, or only explains why the hook is true." },
  { key: "story", n: 5, label: "Story holds together", level: "must-fix", passes: "Each beat follows from the last. A personal story progresses in order: what she loved, her real reason for the change, what she expected, the turn, the insight, how she helps now." },
  { key: "substance", n: 6, label: "Enough substance", level: "must-fix", passes: "Every must-keep point of the brief is there in meaning, with the insight; how she helps appears once, in the payoff or the close, never both. Fails when it leaves out the story she told about this topic (her answer when asked for an example, or the brief's proof when it is her story). Not dry, not incomplete." },
  { key: "payoff", n: 7, label: "Payoff", level: "must-fix", passes: "Answers the hook's question in one line the viewer could repeat. A \"My job\" or credential line that does not answer the hook fails. How she helps appears once, in the payoff or the close, never both." },
  { key: "close", n: 8, label: "Close", level: "must-fix", passes: "At most two beats: a line that calls back a concrete word or image from the hook, then, with a service angle, a warm invitation naming this video's specific next step in her voice (a callback alone only for a story with no service angle). \"Let's talk\" as the whole invitation, a \"Thinking about X?\" opener, a slogan or an aphorism fails." },
  { key: "her_voice", n: 9, label: "Sounds like her", level: "flag", passes: "Her voice at its best on camera: her vocabulary and her strongest short phrases in tight, natural, polished spoken sentences. No transcript sentences pasted in, none of her avoid-words, no industry terms spoken to homeowners (a phrase of hers included)." },
  { key: "claims", n: 10, label: "Every claim supported", level: "must-fix", passes: "Each factual line traces to something she said (anywhere in the call) or approved; a faithful paraphrase counts. Topic descriptions and our assumptions do not count." },
  { key: "length", n: 11, label: "Length", level: "must-fix", passes: `At most ${WRITER_LENGTH.cap} spoken words (the cap); ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]} is the aim. Seconds shown.` },
  { key: "nothing_extra", n: 12, label: "Nothing extra", level: "flag", passes: "Every sentence creates interest, builds understanding, delivers value, earns trust or moves the story." },
  { key: "craft", n: 13, label: "Craft", level: "must-fix", passes: "The craft block: hook, re-hook, build-up, payoff and close each score 4 or more out of 5, each with a one-line psychology note. Any part under 4 fails." },
] as const;
export type ReviewCheckKey = (typeof REVIEW_CHECKS)[number]["key"];
export const REVIEW_CHECK_KEYS = REVIEW_CHECKS.map((c) => c.key) as ReviewCheckKey[];
/** The checks the reviewer answers pass or fail (craft is its own block, scored part by part; length is code's). */
export const MODEL_CHECK_KEYS = REVIEW_CHECK_KEYS.filter((k) => k !== "craft");

/** `parts` (v2.3): the script parts a failure is about, so a kept longer version can be checked for the same line. */
export type ReviewCheckResult = { key: ReviewCheckKey; n: number; label: string; level: CheckLevel; pass: boolean; reason: string; parts?: ScriptPartKey[] };
/** `check` and `part` (v2.3): a finding may name the check it counts against (else HARD_TO_CHECK) and the part it is about. */
export type HardFinding = { key: "greeting" | "dash" | "duration" | "market_claim" | "jargon" | "hook_length" | "audience_vocative" | "pasted" | "hook_echo" | "generic_close"; level: CheckLevel; detail: string; check?: ReviewCheckKey; part?: ScriptPartKey };

// ---------------------------------------------------------------------------
// Hard numbers, by code (never by the model).
// ---------------------------------------------------------------------------

export type ScriptParts = { hook: string; points: { role: string | null; text: string }[]; close: string };

export const spokenTextOf = (p: ScriptParts) => [p.hook, ...p.points.map((x) => x.text), p.close].filter(Boolean).join("\n");

const DASH_RE = /[‒–—―]|(?<!-)--(?!-)/;
const DURATION_RES = [
  /[([]\s*~?\d+(?:\.\d+)?\s*(?:s|secs?|seconds?|mins?|minutes?)\s*[)\]]/i, // (10 seconds) [30s]
  /[([]\s*\d{1,2}:\d{2}\s*[)\]]/, // [0:15]
  /\b(?:runtime|duration|timing|est(?:imated)?\.?\s*(?:time|length))\s*[:=]/i, // Runtime: 35 s
  /(?:^|\s)~\s?\d+\s?s\b/i, // ~30s
];
const GREETING_RE = /^\s*(?:hi|hey|hello|welcome|good (?:morning|afternoon|evening))\b|^\s*(?:my name is|i'?m [A-Z][a-z]+ (?:with|from|here)|today,? i (?:want|wanted) to (?:talk|share)|in this video)/i;
const AUDIENCE_VOCATIVE_RE = /^\s*(?:sellers|buyers|homeowners|home ?sellers|home ?buyers|first[- ]time (?:home ?)?buyers|realtors|agents)\s*[,!:]/i;
const JARGON_RES: { re: RegExp; say: string }[] = [
  { re: /\b(?:buyer\s+)?avatars?\b/i, say: "\"buyer avatar\" (say who is most likely to buy)" },
  { re: /\bCMAs?\b/, say: "\"CMA\"" },
  { re: /\bcomps\b/i, say: "\"comps\" (say what similar homes sold for)" },
  { re: /\babsorption rate\b/i, say: "\"absorption rate\"" },
  { re: /\blist[- ]to[- ]sales?(?: price)? ratio\b/i, say: "\"list-to-sale ratio\"" },
  { re: /\bDOM\b/, say: "\"DOM\"" },
  // v2.3: these slipped through as "her phrases" in the offline drafts.
  { re: /\bimpervious (?:coverage|surface)\b/i, say: "\"impervious coverage\" (say how much of the lot can be built on or paved)" },
  { re: /\bsetbacks?\b/i, say: "\"setback\" (say how close to the property line you can build)" },
  { re: /\bactives\b/i, say: "\"actives\" (say the homes for sale right now)" },
  { re: /\bpendings\b/i, say: "\"pendings\" (say the homes under contract)" },
];

// ---------------------------------------------------------------------------
// v2.3 (the craft fix): the hook's words coming back. Content words are the
// words that carry meaning: no stop words, no generic verbs (want, need, get,
// talk ...), and not "home" or "house", which every video says. A light stem
// so "buyers" meets "buyer". Pure.
// ---------------------------------------------------------------------------
const ECHO_STOPWORDS = new Set(
  ("a an the and or but so of to in on for with at by from as is are was were be been being it its it's this that these those there here what when where why how who which whom " +
    "you your you're you've you'll yours we we're we've we'll our us i i'm i've i'll i'd me my he she they they're them their his her do does did don't doesn't didn't not no yes " +
    "can can't will won't would should could just really very more most if then than about into out up down over all any some one get gets got have has had make makes made " +
    "like know think want wants wanted need needs go goes going gone let let's talk see look come say tell feel thing things way now still even also too well right maybe okay sure " +
    "much many every each other another again only ever never always something someone anyone everyone everything nothing might may must shall " +
    "before after because while until since through home homes house houses real estate").split(" "),
);
const stemWord = (w: string) => {
  let s = w.replace(/'s$/, "").replace(/'/g, "");
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(?:ss|sh|ch|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
};
/** The content words of a line, stemmed (pure). */
export function contentWordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[‘’]/g, "'").split(/[^a-z0-9']+/)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 3 || ECHO_STOPWORDS.has(w)) continue;
    const s = stemWord(w);
    if (s.length < 3 || ECHO_STOPWORDS.has(s)) continue;
    out.add(s);
  }
  return out;
}
/** How many content words a re-hook or build-up may share with the hook before it reads as the hook again. */
export const HOOK_ECHO_WORDS = 3;
/** A re-hook that opens on a hedge ("Maybe.", "Not exactly.") backs away from the hook instead of raising it. */
export const HEDGE_OPENER_RE = /^\s*["“']?(?:(?:maybe|perhaps|possibly|probably|not exactly|not necessarily|not quite|not always|sort of|kind of|it depends)\b|well,)/i;
/** The template close: one question, then "Let's talk." and nothing else (tested on the whole close and on its last beats). */
export const GENERIC_CLOSE_RE = /^[^.?!]*\?\s*let's (talk|chat|connect)\.?$/i;
/** An invitation that opens "Thinking about X?" (CLOSE_RULE). */
const THINKING_ABOUT_RE = /(?:^|[.!?]\s+)["“]?thinking (?:about|of)\b[^.?!]*\?/i;

/** The words a part shares with the hook (pure). */
export function sharedWithHook(hook: string, text: string): string[] {
  const h = contentWordsOf(hook);
  return [...contentWordsOf(text)].filter((w) => h.has(w));
}

/**
 * hook_echo and generic_close (v2.3), by code. A re-hook that opens on a hedge
 * or repeats HOOK_ECHO_WORDS of the hook's content words fails the re-hook
 * (must-fix); a build-up that repeats them is a flag (Nothing extra). A close
 * that brings back no content word of the hook, or ends on the template "[a
 * question]? Let's talk.", or opens its invitation "Thinking about X?" fails
 * the close (must-fix). Pure.
 */
export function craftFindings(parts: ScriptParts): HardFinding[] {
  const out: HardFinding[] = [];
  const hook = parts.hook ?? "";
  const rehook = partTextOf(parts, "rehook");
  const buildup = partTextOf(parts, "buildup");
  if (rehook && HEDGE_OPENER_RE.test(rehook)) {
    const first = rehook.trim().split(/[.?!,]/)[0].trim().slice(0, 40);
    out.push({ key: "hook_echo", level: "must-fix", check: "rehook", part: "rehook", detail: `The re-hook opens on a hedge ("${first}"): it backs away from the hook. Open on a fact, a turn or a stake the hook does not have.` });
  }
  if (hook && rehook) {
    const shared = sharedWithHook(hook, rehook);
    if (shared.length >= HOOK_ECHO_WORDS) out.push({ key: "hook_echo", level: "must-fix", check: "rehook", part: "rehook", detail: `The re-hook repeats the hook's words (${shared.slice(0, 6).join(", ")}): it restates the hook instead of adding a fact, a turn or a stake.` });
  }
  if (hook && buildup) {
    const shared = sharedWithHook(hook, buildup);
    if (shared.length >= HOOK_ECHO_WORDS) out.push({ key: "hook_echo", level: "flag", check: "nothing_extra", part: "buildup", detail: `The build-up repeats the hook's words (${shared.slice(0, 6).join(", ")}): it should set up the payoff, not say the hook again.` });
  }
  const close = (parts.close ?? "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  if (close) {
    const why: string[] = [];
    if (hook && !sharedWithHook(hook, close).length) why.push("nothing from the hook comes back in it (call back a concrete word or image from the hook)");
    const beats = close.split(/(?<=[.?!])\s+/).filter(Boolean);
    let template = false;
    for (let k = 1; k <= beats.length && !template; k++) template = GENERIC_CLOSE_RE.test(beats.slice(-k).join(" ").trim());
    if (template) why.push("it ends on a question and \"Let's talk.\" (name this video's own next step instead)");
    if (THINKING_ABOUT_RE.test(close)) why.push("its invitation opens \"Thinking about ...?\"");
    if (why.length) out.push({ key: "generic_close", level: "must-fix", check: "close", part: "close", detail: `The close is generic: ${why.join("; ")}.` });
  }
  return out;
}

/** A part's text: the hook, a talking point by its role (or its place), or the close. Pure. */
export function partTextOf(p: ScriptParts, k: ScriptPartKey): string {
  if (k === "hook") return p.hook ?? "";
  if (k === "close") return p.close ?? "";
  const i = k === "rehook" ? 0 : k === "buildup" ? 1 : 2;
  const roleOf = (r: string | null) => (r ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const byRole = (p.points ?? []).find((x) => roleOf(x.role) === k);
  return (byRole ?? (p.points ?? [])[i])?.text ?? "";
}
/** Market statements that need a source: rates, prices, inventory, timing of the market. */
const MARKET_TERMS: { re: RegExp; key: string }[] = [
  { re: /\b(?:interest|mortgage)\s+rates?\b|\brates\s+(?:are|have|went|go)\b/i, key: "rates" },
  { re: /\binventory\b/i, key: "inventory" },
  { re: /\bmedian\b/i, key: "median" },
  { re: /\bdays on (?:the )?market\b/i, key: "days on market" },
  { re: /\b(?:home )?prices?\s+(?:are|have been|have|went|keep)\s+(?:up|down|rising|falling|dropping|climbing|soaring)\b/i, key: "prices moving" },
  { re: /\bhome values?\s+(?:are|have)\b/i, key: "home values" },
  { re: /\b(?:buyer'?s|seller'?s)\s+market\b/i, key: "buyer's or seller's market" },
  { re: /\bthe market is\s+(?:hot|cold|slow|slowing|shifting|cooling|heating)\b/i, key: "the market is ..." },
  { re: /\bappraisal gaps?\b/i, key: "appraisal gap" },
];

/**
 * The figures in a text: "$20,000" and "20k" both read "20000"; a percentage
 * keeps its number. A plain small number (10 or under, no $ or %) is how
 * people talk ("two weekends", "3 things") and is left out. Pure.
 */
export function numberTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(\$)?\s?(\d[\d,]*(?:\.\d+)?)\s?(k\b|%|percent)?/gi)) {
    let n = m[2].replace(/,/g, "");
    if (/^k$/i.test(m[3] ?? "")) n = String(Math.round(parseFloat(n) * 1000));
    if (!m[1] && !m[3] && parseFloat(n) <= 10) continue;
    out.push(n);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");

/**
 * The hard numbers (Oct 22 2026): word count and seconds, hook length, no
 * greeting opener, no audience vocative, no dashes, no durations noted, no
 * market claim or number the sources do not contain, no industry jargon.
 * `sourceText` is everything the client said or approved that the writer read
 * (passages, answers, facts, her strategy), never our assumptions.
 */
export function hardNumbers(parts: ScriptParts, sourceText: string, /** What she SAID (calls and passages), for the pasted-sentence check; default sourceText. */ spokenSourceText?: string): { words: number; seconds: number; band: LengthBand; hookWords: number; findings: HardFinding[] } {
  const spoken = spokenTextOf(parts);
  const words = countSpokenWords(spoken);
  const hookWords = countSpokenWords(parts.hook);
  const findings: HardFinding[] = [];
  if (GREETING_RE.test(parts.hook) || BANNED_OPENERS.some((b) => parts.hook.trim().toLowerCase().startsWith(b.toLowerCase()))) findings.push({ key: "greeting", level: "must-fix", detail: "The hook opens with a greeting or an introduction." });
  if (AUDIENCE_VOCATIVE_RE.test(parts.hook)) findings.push({ key: "audience_vocative", level: "must-fix", detail: "The hook opens by naming the audience (\"Sellers, ...\"); open on a line the viewer would recognise instead." });
  if (hookWords > SCRIPT_PART_BUDGETS.hookWords) findings.push({ key: "hook_length", level: "flag", detail: `The hook is ${hookWords} words; one breath is ${SCRIPT_PART_BUDGETS.hookWords} at most.` });
  if (DASH_RE.test(spoken)) findings.push({ key: "dash", level: "must-fix", detail: "A dash is used as punctuation." });
  if (DURATION_RES.some((re) => re.test(spoken))) findings.push({ key: "duration", level: "must-fix", detail: "A duration or timing note is written into the script." });
  const src = norm(sourceText);
  const srcNumbers = new Set(numberTokens(sourceText));
  const unsupportedNumbers = [...new Set(numberTokens(spoken))].filter((n) => !srcNumbers.has(n));
  if (unsupportedNumbers.length) findings.push({ key: "market_claim", level: "must-fix", detail: `Numbers the sources do not contain: ${unsupportedNumbers.slice(0, 5).join(", ")}.` });
  const unsupportedTerms = MARKET_TERMS.filter((t) => t.re.test(spoken) && !t.re.test(src)).map((t) => t.key);
  if (unsupportedTerms.length) findings.push({ key: "market_claim", level: "must-fix", detail: `Market statements she did not make: ${unsupportedTerms.join(", ")}.` });
  const jargon = JARGON_RES.filter((j) => j.re.test(spoken)).map((j) => j.say);
  // Must-fix (Oct 22 2026): the independent review found "impervious coverage" passing as a flag because
  // it was one of "her phrases"; Jordan wants plain homeowner words, so an industry term fails the draft.
  if (jargon.length) findings.push({ key: "jargon", level: "must-fix", detail: `Industry terms spoken to homeowners: ${jargon.join(", ")}.` });
  // A long run is a transcript sentence stitched in (must-fix); a medium one may be a strong line of hers, so it is a flag to look at.
  const spokenSrc = spokenSourceText ?? sourceText;
  const pastedLong = pastedRuns(spoken, spokenSrc, PASTED_MUST_FIX_WORDS);
  const pastedMid = pastedRuns(spoken, spokenSrc).filter((s) => !pastedLong.includes(s));
  if (pastedLong.length) findings.push({ key: "pasted", level: "must-fix", detail: `Pasted from the call word for word: ${pastedLong.slice(0, 2).map((p) => `"${p}"`).join("; ")}. Keep her meaning and her best short phrases; write the sentence for camera.` });
  if (pastedMid.length) findings.push({ key: "pasted", level: "flag", detail: `Close to her words from the call: ${pastedMid.slice(0, 2).map((p) => `"${p}"`).join("; ")}. Keep it only if it is strong and natural on camera.` });
  // v2.3: the re-hook and build-up that say the hook again, a hedge opener, the template close.
  findings.push(...craftFindings(parts));
  return { words, seconds: estimateSeconds(words), band: lengthBand(words), hookWords, findings };
}

/** How many words in a row a script may share with the call before it reads as pasted, not written (Oct 22 2026, v2.1). */
export const PASTED_RUN_WORDS = 11;
/** At this many, it is a transcript sentence stitched in: must-fix. */
export const PASTED_MUST_FIX_WORDS = 14;
const wordsOf = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").split(/[^a-z0-9']+/).filter(Boolean);

/**
 * Stretches of the script that repeat the sources word for word for
 * PASTED_RUN_WORDS words or more: her transcript stitched in instead of
 * written. A short vivid phrase of hers ("fiercely protect") is far under it.
 */
export function pastedRuns(spoken: string, sourceText: string, min = PASTED_RUN_WORDS): string[] {
  const src = wordsOf(sourceText);
  if (src.length < min) return [];
  const grams = new Set<string>();
  for (let i = 0; i + min <= src.length; i++) grams.add(src.slice(i, i + min).join(" "));
  const out: string[] = [];
  for (const sentence of spoken.split(/(?<=[.!?])\s+|\n+/)) {
    const w = wordsOf(sentence);
    for (let i = 0; i + min <= w.length; i++) {
      if (grams.has(w.slice(i, i + min).join(" "))) { out.push(sentence.trim().slice(0, 160)); break; }
    }
  }
  return out;
}

/** Which check a hard finding counts against (a finding's own `check` wins: a build-up echo is Nothing extra, not Re-hook). */
export const HARD_TO_CHECK: Record<HardFinding["key"], ReviewCheckKey> = {
  greeting: "hook", audience_vocative: "hook", hook_length: "hook", dash: "nothing_extra", duration: "nothing_extra", market_claim: "claims", jargon: "her_voice", pasted: "her_voice",
  hook_echo: "rehook", generic_close: "close",
};
const checkOfFinding = (h: HardFinding): ReviewCheckKey => h.check ?? HARD_TO_CHECK[h.key];

/** The script parts each check is about (v2.3): what a kept longer version is compared on. */
export const CHECK_PARTS: Partial<Record<ReviewCheckKey, ScriptPartKey[]>> = { hook: ["hook"], rehook: ["rehook"], payoff: ["payoff"], close: ["close"] };

// ---------------------------------------------------------------------------
// v2.3: THE CRAFT BLOCK. The reviewer scores the five parts 1 to 5 with a
// one-line psychology note each. Any part under CRAFT_PASS is must-fix (check
// 13); a hook or re-hook under it also fails check 3 or 4, so the next round
// starts again from the runner-up hook (HOOK_SWITCH_CHECKS).
// ---------------------------------------------------------------------------
export const CRAFT_PASS = 4;
export const CRAFT_PARTS: readonly { key: ScriptPartKey; label: string; asks: string }[] = [
  { key: "hook", label: "Hook", asks: "what lever it pulls (belief, contrast, question, her moment) and the tension it carries" },
  { key: "rehook", label: "Re-hook", asks: "how it escalates: the new fact, turn or stake it adds" },
  { key: "buildup", label: "Build-up", asks: "what it sets up for the payoff (her one real moment, her process)" },
  { key: "payoff", label: "Payoff", asks: "whether it delivers the hook's promise in one line the viewer could repeat" },
  { key: "close", label: "Close", asks: "whether it is memorable and tied to the hook" },
];
/** A score of 0 means the reviewer did not score the part (a fail, never a pass). */
export type CraftScores = Record<ScriptPartKey, { score: number; note: string }>;

/** The reviewer's craft block, cleaned: a missing or unreadable part scores 0 (not scored). Null when there is no block at all. Pure. */
export function readCraft(raw: unknown): CraftScores | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, { score?: unknown; note?: unknown } | null | undefined>;
  return Object.fromEntries(SCRIPT_PART_KEYS.map((k) => {
    const v = r[k];
    const n = typeof v?.score === "number" && Number.isFinite(v.score) ? Math.max(1, Math.min(5, Math.round(v.score))) : 0;
    return [k, { score: n, note: typeof v?.note === "string" ? v.note.replace(/\s+/g, " ").trim().slice(0, 160) : "" }];
  })) as CraftScores;
}

/** The parts under CRAFT_PASS, in script order. Pure. */
export function craftUnder(craft: CraftScores | null | undefined): ScriptPartKey[] {
  return craft ? SCRIPT_PART_KEYS.filter((k) => (craft[k]?.score ?? 0) < CRAFT_PASS) : [];
}

const craftLine = (craft: CraftScores, k: ScriptPartKey) => {
  const p = CRAFT_PARTS.find((x) => x.key === k)!;
  const c = craft[k];
  return `${p.label} ${c.score ? `${c.score} of 5` : "not scored"}${c.note ? `: ${c.note.replace(/[.\s]+$/, "")}` : ""}.`;
};

/** The length check (11), by code: over the cap fails (must-fix); 86 to 110 is advice (flag); the rest passes. */
export function lengthCheck(words: number): ReviewCheckResult {
  const spec = REVIEW_CHECKS.find((c) => c.key === "length")!;
  const band = lengthBand(words);
  const seconds = estimateSeconds(words);
  if (band === "over") return { key: "length", n: spec.n, label: spec.label, level: "must-fix", pass: false, reason: `${OVER_CAP_LABEL}: ${words} words, about ${seconds} seconds; the cap is ${WRITER_LENGTH.cap}.` };
  if (band === "long") return { key: "length", n: spec.n, label: spec.label, level: "flag", pass: false, reason: `${LONG_ADVISORY_LABEL}: ${words} words, about ${seconds} seconds. Allowed; advice only.` };
  return { key: "length", n: spec.n, label: spec.label, level: "must-fix", pass: true, reason: `${words} words, about ${seconds} seconds.` };
}

/**
 * The model's 12 answers merged with what code knows: the length check is
 * always code's; a must-fix hard finding fails the check it belongs to; a
 * missing answer is a fail ("not scored"), never a pass. v2.3: check 13
 * (craft) is the craft block, any part under CRAFT_PASS failing it at
 * must-fix (no block at all is "not scored", a fail); a hook or re-hook under
 * CRAFT_PASS also fails check 3 or 4. A failed check names the parts it is
 * about (`parts`).
 */
export function mergeReview(model: { key?: string; pass?: boolean; reason?: string }[], hard: HardFinding[], words: number, craft?: CraftScores | null): ReviewCheckResult[] {
  const under = craftUnder(craft);
  return REVIEW_CHECKS.map((spec): ReviewCheckResult => {
    if (spec.key === "length") return lengthCheck(words);
    if (spec.key === "craft") {
      if (!craft) return { key: spec.key, n: spec.n, label: spec.label, level: spec.level, pass: false, reason: "Not scored by the reviewer (no craft block)." };
      const pass = under.length === 0;
      const reason = pass ? SCRIPT_PART_KEYS.map((k) => craftLine(craft, k)).join(" ") : under.map((k) => craftLine(craft, k)).join(" ");
      return { key: spec.key, n: spec.n, label: spec.label, level: spec.level, pass, reason: reason.slice(0, 700), ...(pass ? {} : { parts: under }) };
    }
    const got = model.find((m) => m?.key === spec.key);
    let pass = typeof got?.pass === "boolean" ? got.pass : false;
    let reason = typeof got?.reason === "string" && got.reason.trim() ? got.reason.replace(/\s+/g, " ").trim().slice(0, 400) : got ? (pass ? "Passes." : "Did not pass.") : "Not scored by the reviewer.";
    let level: CheckLevel = spec.level;
    const parts = new Set<ScriptPartKey>(CHECK_PARTS[spec.key] ?? []);
    for (const h of hard.filter((x) => checkOfFinding(x) === spec.key)) {
      // A must-fix hard finding fails the check at must-fix level whatever the
      // reviewer said; a flag-level one fails a passing check as a flag.
      const modelSaid = pass ? "" : reason;
      if (h.part) parts.add(h.part);
      if (h.level === "must-fix") { pass = false; level = "must-fix"; reason = `${h.detail} ${modelSaid}`.trim(); }
      else if (pass) { pass = false; reason = h.detail; }
    }
    // v2.3: a hook or re-hook the craft block scored under 4 fails its own check too (the runner-up hook path).
    if (craft && (spec.key === "hook" || spec.key === "rehook") && under.includes(spec.key)) {
      const modelSaid = pass ? "" : reason;
      pass = false; level = "must-fix";
      reason = `Craft: ${craftLine(craft, spec.key)} ${modelSaid}`.trim();
    }
    return { key: spec.key, n: spec.n, label: spec.label, level, pass, reason: reason.slice(0, 500), ...(!pass && parts.size ? { parts: [...parts] } : {}) };
  });
}

// ---------------------------------------------------------------------------
// v2.3: THE KEPT LONGER VERSION MAY NOT SAY THE LINE THE TRIM FAILED ON. When
// the aim trim breaks a must-fix check, the longer passing version it came
// from stands; but when the trim failed on a line the longer version says too
// (the same close, the same hook), that line was never fine: the kept version
// is flagged for a person instead of passed.
// ---------------------------------------------------------------------------
const lineKey = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The trim's failed lines that the kept version says too: each must-fix
 * failure (not length, not Enough substance, the reason a trim is undone)
 * whose part reads the same in the kept version, or whose reason quotes a
 * line (three words or more) both versions say. Pure.
 */
export function keptLongerConflicts(trim: { parts: ScriptParts; checks: readonly ReviewCheckResult[] }, kept: ScriptParts): { key: ReviewCheckKey; n: number; label: string; line: string }[] {
  const keptAll = lineKey(spokenTextOf(kept));
  const trimAll = lineKey(spokenTextOf(trim.parts));
  const out: { key: ReviewCheckKey; n: number; label: string; line: string }[] = [];
  const add = (c: ReviewCheckResult, line: string) => { if (!out.some((o) => o.key === c.key && lineKey(o.line) === lineKey(line))) out.push({ key: c.key, n: c.n, label: c.label, line: line.replace(/\s+/g, " ").trim().slice(0, 200) }); };
  for (const c of trim.checks) {
    if (c.pass || c.level !== "must-fix" || c.key === "length" || c.key === "substance") continue;
    for (const part of c.parts ?? CHECK_PARTS[c.key] ?? []) {
      const t = partTextOf(trim.parts, part);
      const k = lineKey(t);
      if (k.split(" ").length >= 2 && (k === lineKey(partTextOf(kept, part)) || keptAll.includes(k))) add(c, t);
    }
    for (const m of c.reason.matchAll(/["“]([^"”]{6,240})["”]/g)) {
      const q = lineKey(m[1]);
      if (q.split(" ").length >= 3 && trimAll.includes(q) && keptAll.includes(q)) add(c, m[1]);
    }
  }
  return out;
}

export function mustFixFailures(checks: ReviewCheckResult[]): ReviewCheckResult[] {
  return checks.filter((c) => !c.pass && c.level === "must-fix");
}

/** "Creative review: 11 of 12 pass". */
export function reviewHeadline(checks: ReviewCheckResult[]): string {
  return `Creative review: ${checks.filter((c) => c.pass).length} of ${checks.length} pass`;
}

// ---------------------------------------------------------------------------
// Five hooks, scored; the best one wins (by code).
// ---------------------------------------------------------------------------

export const HOOK_CRITERIA = ["relevance", "curiosity", "tension", "specificity", "naturalDelivery", "accuracy", "herVoice", "payoffConnection"] as const;
export type HookCriterion = (typeof HOOK_CRITERIA)[number];
/**
 * What the hook does for the video's job (Oct 22 2026, the listening fix):
 * "her_moment" opens on her own tension or turn; "viewer_line" is a line the
 * viewer would say or a question they are asking; "other" anything else.
 */
export const HOOK_FITS = ["her_moment", "viewer_line", "other"] as const;
export type HookFit = (typeof HOOK_FITS)[number];
/**
 * `weak` (v2.3): why a usable hook is below HOOK_BAR (curiosity or tension
 * under 4); it is chosen only when no hook reaches the bar. A hook stored
 * before v2.3 has no tension score and reads as weak.
 */
export type HookCandidate = { text: string; rehook: string; lever: string; scores: Record<HookCriterion, number>; total: number; note: string; disqualified: string | null; fit?: HookFit; weak?: string | null };
/** The brief's reading of the video: a personal story (her background, why she does this work) or an educational one. */
export type VideoType = "story" | "educational";
/** How hooks are ordered: the video type, and whether the brief's proof is a story she told (v2.3). */
export type HookOrderOpts = { videoType?: VideoType | null; proofIsStory?: boolean };

const clampScore = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(5, Math.round(v))) : 1);

/** v2.3: a hook is eligible only with curiosity AND tension at these or more. */
export const HOOK_BAR = { curiosity: 4, tension: 4 } as const;
const scoreOf = (h: Pick<HookCandidate, "scores">, k: HookCriterion) => Number((h.scores as Record<string, unknown> | null | undefined)?.[k]) || 0;
/** What a hook is ranked by (v2.3): curiosity + tension + specificity. The total only breaks a tie. */
export const hookRank = (h: Pick<HookCandidate, "scores">) => scoreOf(h, "curiosity") + scoreOf(h, "tension") + scoreOf(h, "specificity");
/** Why a hook is below HOOK_BAR, or null when it reaches it. Pure. */
export function hookWeakness(h: Pick<HookCandidate, "scores">): string | null {
  const low = (["curiosity", "tension"] as const).filter((k) => scoreOf(h, k) < HOOK_BAR[k]);
  return low.length ? `${low.join(" and ")} under ${HOOK_BAR.curiosity}` : null;
}

/**
 * The order hooks are chosen in (v2.3): usable hooks only (never a
 * disqualified one); every hook that reaches HOOK_BAR before any that does
 * not; within each, for a personal story a hook that opens on HER moment
 * first (Oct 22 2026, the listening fix: the seniors pick was "Buying my
 * first home shouldn't feel this scary, right?", a viewer's line winning 31
 * to 29 over her own turn); then curiosity + tension + specificity; on a tie,
 * her moment when the brief's proof is a story she told; then the total; then
 * the earlier one. Self-scores cluster (28 to 34 in the offline test), so the
 * total no longer decides on its own. Pure.
 */
export function hookOrder(hooks: HookCandidate[], opts: HookOrderOpts = {}): number[] {
  const storyFit = (h: HookCandidate) => (opts.videoType === "story" && h.fit === "her_moment" ? 1 : 0);
  const herProof = (h: HookCandidate) => (opts.proofIsStory && h.fit === "her_moment" ? 1 : 0);
  const totalOf = (h: HookCandidate) => (typeof h.total === "number" ? h.total : HOOK_CRITERIA.reduce((n, k) => n + scoreOf(h, k), 0));
  const cmp = (a: { h: HookCandidate; i: number }, b: { h: HookCandidate; i: number }) =>
    storyFit(b.h) - storyFit(a.h) || hookRank(b.h) - hookRank(a.h) || herProof(b.h) - herProof(a.h) || totalOf(b.h) - totalOf(a.h) || a.i - b.i;
  const usable = hooks.map((h, i) => ({ h, i })).filter(({ h }) => !h.disqualified && !!h.text);
  const strong = usable.filter(({ h }) => !hookWeakness(h)).sort(cmp);
  const weak = usable.filter(({ h }) => !!hookWeakness(h)).sort(cmp);
  return [...strong, ...weak].map(({ i }) => i);
}

/**
 * Clean the model's hooks and pick the winner (hookOrder): accurate (4+), no
 * greeting, no audience vocative, no dash; curiosity and tension 4 or more;
 * then the rank. `fallback` says so when no hook reached the bar and the best
 * of the rest was used, or when every hook was set aside.
 */
export function pickHook(raw: { text?: unknown; rehook?: unknown; lever?: unknown; scores?: Record<string, unknown> | null; note?: unknown; fit?: unknown }[], opts: HookOrderOpts = {}): { hooks: HookCandidate[]; chosen: number; fallback: string | null } {
  const hooks: HookCandidate[] = (Array.isArray(raw) ? raw : []).slice(0, 5).map((h) => {
    const scores = Object.fromEntries(HOOK_CRITERIA.map((k) => [k, clampScore(h?.scores?.[k])])) as Record<HookCriterion, number>;
    const text = String(h?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const why = !text ? "empty" : scores.accuracy < 4 ? "accuracy under 4" : GREETING_RE.test(text) ? "opens with a greeting" : AUDIENCE_VOCATIVE_RE.test(text) ? "opens by naming the audience" : DASH_RE.test(text) ? "uses a dash" : null;
    const fit = (HOOK_FITS as readonly string[]).includes(String(h?.fit)) ? (h.fit as HookFit) : undefined;
    return { text, rehook: String(h?.rehook ?? "").replace(/\s+/g, " ").trim().slice(0, 400), lever: String(h?.lever ?? "").trim().slice(0, 80), scores, total: HOOK_CRITERIA.reduce((n, k) => n + scores[k], 0), note: String(h?.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300), disqualified: why, weak: why ? null : hookWeakness({ scores }), ...(fit ? { fit } : {}) };
  });
  let chosen = hookOrder(hooks, opts)[0] ?? -1;
  let fallback: string | null = null;
  if (chosen >= 0 && hooks[chosen].weak) {
    fallback = `No hook reached curiosity ${HOOK_BAR.curiosity} and tension ${HOOK_BAR.tension}; the strongest of the rest was used (${hooks[chosen].weak}).`;
  } else if (chosen < 0) {
    // Every hook was disqualified: the most accurate non-empty one, so the draft can still be written and the review says what is wrong.
    for (let i = 0; i < hooks.length; i++) if (hooks[i].text && (chosen < 0 || hooks[i].scores.accuracy * 100 + hooks[i].total > hooks[chosen].scores.accuracy * 100 + hooks[chosen].total)) chosen = i;
    if (chosen >= 0) fallback = `Every hook was set aside; the most accurate one was used so the review can say what is wrong (${hooks[chosen].disqualified}).`;
  }
  return { hooks, chosen, fallback };
}

const hookKey = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9']+/g, " ").trim();

/**
 * The next hook to try when the review fails the hook or the re-hook (Oct 22
 * 2026, the listening fix): the best usable hook, in the order pickHook
 * chose by, that has not been used yet. A failed re-hook used to be patched
 * around the locked hook for two rounds (the seniors draft broke its story to
 * keep "It should."); now the next round starts again from the runner-up.
 * Null when every usable hook has been tried. Pure.
 */
export function runnerUpHook(hooks: HookCandidate[], used: readonly string[], opts?: HookOrderOpts | VideoType | null): HookCandidate | null {
  const tried = new Set(used.map(hookKey).filter(Boolean));
  const o: HookOrderOpts = typeof opts === "string" || opts == null ? { videoType: opts ?? null } : opts;
  for (const i of hookOrder(hooks, o)) if (!tried.has(hookKey(hooks[i].text))) return hooks[i];
  return null;
}

/** The hook of a script body: the candidate whose words it contains (the first one found), or null. */
export function hookInUse(body: string, hooks: HookCandidate[]): string | null {
  const b = hookKey(body);
  return hooks.find((h) => h.text && b.includes(hookKey(h.text)))?.text ?? null;
}

/** Review checks whose must-fix failure sends the next round back to a new hook. */
export const HOOK_SWITCH_CHECKS: readonly ReviewCheckKey[] = ["hook", "rehook"];

/** Did the review fail the hook or the re-hook at must-fix level? From the checks, or from a fix instruction writerFixInstruction wrote. Pure. */
export function hookFailed(from: { checks?: ReviewCheckResult[] | null; instruction?: string | null }): boolean {
  if (from.checks?.length) return from.checks.some((c) => !c.pass && c.level === "must-fix" && HOOK_SWITCH_CHECKS.includes(c.key));
  const text = from.instruction ?? "";
  const must = /MUST FIX:\n([\s\S]*?)(?:\n[A-Z][A-Z' ]+[:A-Z]|$)/.exec(text)?.[1] ?? "";
  const labels = REVIEW_CHECKS.filter((c) => HOOK_SWITCH_CHECKS.includes(c.key)).map((c) => `${c.n}. ${c.label}:`);
  return must.split("\n").some((l) => labels.some((x) => l.startsWith(`- ${x}`)));
}
