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
export const WRITER_VERSION = "writer.v2.1-2026-10-22";

/** Words and seconds (Jordan, Oct 22 2026). Seconds are an estimate at the hub's speaking rate, never a measurement. */
export const WRITER_LENGTH = {
  aim: [55, 85] as const,
  /** What the draft writes toward. */
  target: 75,
  /** Where the trim pass aims. */
  trimTo: [75, 80] as const,
  cap: 110,
  wordsPerSec: GENERATION_POLICY.timing.wordsPerSec,
} as const;

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
 * one pass toward 75 to 80 for a passing draft over 85) and the card's
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
export const CLOSE_RULE = `CLOSE (Jordan, Oct 22 2026): the close completes the message and, by default, ends on a natural, warm invitation tied to it, in the client's voice. Jordan's finals for one agent all end this way (examples of the SHAPE only, from another agent's videos: never reuse their words or their content): "Whether it's your first home or your next chapter, you don't need all the answers before calling me. That's what I'm here for." / "There are still great opportunities. And your home is different. That's why it deserves a strategy built for today's market. Let's talk." / "I'm here to help you see your home through their eyes. Before you change everything, let's talk about what actually matters."
- "cta" (the default): the invitation, tied to what the video just said, often after a line that returns to the hook's idea. Never a hard sell, never "DM me" slang the client would not say.
- "callback": only when the video is purely a story with no service angle; it returns to the hook's idea and resolves it, and may still carry a soft invitation.
- A slogan or a rhyming aphorism is not a close. The brief decides which one (closeType) and says why. The caption CTA still carries the contact line.`;

// ---------------------------------------------------------------------------
// HER MATERIAL, OUR WORDING (Jordan on the retro test, Oct 22 2026: the seniors
// draft was her transcript lines stitched together, "My finals were much
// better"). What she said is the material; how it is said on camera is the
// craft Realtour Pilot brings.
// ---------------------------------------------------------------------------
export const WORDING_RULE = `HER MATERIAL, OUR WORDING: her facts, stories, chronology, motivations, opinions and meaning are the material; the WORDING is ours: tight, natural, spoken and polished, the way she would say it on her best take. Use her exact phrasing only where it is strong and natural on camera: short, vivid, her own vocabulary (the kind of phrase one agent had in "fiercely protect" or "every bit as scary"; use THIS client's phrases, never those). Never paste her spoken sentences from a call: transcript speech rambles, restarts and fills ("um", "you know", "I guess", "it's just that"). A faithful paraphrase of something she said is supported; adding something she did not say is not.`;

/**
 * Jordan's lessons from Marcee's three scripts (JORDAN-BRIEF.md, cases 1 to 3,
 * "Lessons for future scripts"), as house craft for EVERY client.
 */
export const HOUSE_CRAFT_RULES = `HOUSE CRAFT (Jordan's lessons, for every client; the examples in it come from another agent's videos and show the shape only: never put their story, facts or words in this client's script)
PERSONAL BRAND STORIES (her background, a career change, why she does this work):
- An understandable narrative progression, in the order it happened: where she was and what she loved; her ACTUAL reason for the change, in her terms (for example wanting the freedom or the final say to build her own business: that reason is the heart of the story, never "biography" to cut); what she expected; what actually happened (the turn); the insight that connects her past to the viewer's need; how she helps the viewer now.
- Correct chronology. Never invent a motivation to create drama.
- Keep the emotionally meaningful words she uses about her purpose.
- One compelling story, not a complete biography: job duties, side facts and a second turn go.
- The insight is the point: why her experience matters to THIS viewer (for example, that a first-time buyer and a senior leaving a home of sixty years need the same things: someone to explain their options and fiercely protect their interests). A fun fact about her ("they are my favorite clients") is not the message.
- Give the viewer a reason to trust or remember her.
EDUCATIONAL VIDEOS:
- Understand the underlying topic, not the title's wording; do not change an established topic because other angles came up.
- Hook on a relatable belief or misconception, in the words a homeowner or buyer would actually say ("But my house is different.").
- Explain why the belief no longer holds, or why it is not the whole story.
- Show her actual process and what she does differently; keep the specific details of her process.
- Use a meaningful contrast (a cosmetic refresh versus a costly property issue); never an invented analogy or a forced example.
- Balanced: explain the challenge without creating fear. Never add a market claim because it sounds plausible; background reasoning is not spoken content.
EVERY SCRIPT: the payoff explains why it matters and what she does differently or how she helps; the close is a natural next step tied to the premise.`;

export const HOMEOWNER_LANGUAGE_RULE = `PLAIN WORDS FOR HOMEOWNERS AND BUYERS: speak the way a homeowner or a buyer talks, never in industry terms. "Buyer avatar", "comps", "CMA", "absorption rate", "list-to-sale ratio", "DOM" and similar are the client's working vocabulary, not words to say to a viewer: say what they mean ("who is most likely to buy your house", "what similar homes sold for"). Prefer a line the viewer might say themselves ("But my house is different.") over addressing them by category ("Sellers, ..."). Never open by naming the audience ("Sellers," / "Buyers,").`;

export const TOPIC_LABEL_RULE = `THE TOPIC TITLE IS A LABEL, NOT COPY: the title organises the plan; it is not a line to say and its wording is not the angle (a title that names a year, a series or a slogan does not put that word in the script). Understand what the topic is about and say that, in the client's words.`;

export const ASSUMPTION_RULE = `OUR ASSUMPTIONS ARE NOT HER CLAIMS: the topic's description, intended message, audience need and business goal were written by us or by an AI. They are our assumption about the video's purpose, never a source for a fact, a claim, a statistic or a story. Every factual line traces to something the client said (a call passage, her written answers, a client fact) or to her approved strategy.`;

export const BACKGROUND_RULE = `BACKGROUND IS NOT SPOKEN CONTENT: reasoning, context and strategy notes (ours or the client's) explain why a video exists; they are not approved lines for the client to say. A point the client did not present as part of her message (for example a market cause such as interest rates) stays out of the script unless she said it as part of this message.`;

export const NO_DURATION_RULE = "Never write a duration, a timestamp or a timing note into the script (no \"(10 seconds)\", no \"[0:15]\", no \"30s\").";

export const NO_DASH_RULE = GENERATION_POLICY.punctuation.rule;

export const LENGTH_RULE = `LENGTH (Jordan, Oct 22 2026: "aim for 55 to 85 words without making it dry or incomplete"): write about ${WRITER_LENGTH.target} spoken words (about ${estimateSeconds(WRITER_LENGTH.target)} seconds), inside the ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]} range. The brief's must-keep points are the ONLY things that must survive; optional material, a second example, extra setup and anything that restates a point go first. Count your words before you answer. ${WRITER_LENGTH.cap} spoken words is the hard cap; ${WRITER_LENGTH.aim[1] + 1} to ${WRITER_LENGTH.cap} is a miss, allowed only when the must-keep points cannot fit in fewer. Under ${WRITER_LENGTH.aim[0]} is fine only when nothing the brief marks must-keep is missing. Never make it dry or incomplete to hit the number: each sentence creates interest, builds understanding, delivers value, earns trust or moves the story.`;

export const NEITHER_WINS_RULE = "NEITHER VERSION WINS AUTOMATICALLY: when there is an earlier version, a client's rewrite or a reviewer's instruction, keep the strongest information and language from each while staying on the topic's one message. A client's longer rewrite is mined for its facts and phrases, not accepted for its length; our draft is not defended for being ours.";

// ---------------------------------------------------------------------------
// The independent review: Jordan's 12 checks (the plan's quality table).
// ---------------------------------------------------------------------------

export type CheckLevel = "must-fix" | "flag";
export const REVIEW_CHECKS = [
  { key: "on_topic", n: 1, label: "On topic", level: "must-fix", passes: "It delivers the brief's one message; no new topic smuggled in." },
  { key: "her_meaning", n: 2, label: "Her meaning", level: "must-fix", passes: "Nothing she said is bent; the chronology matches her account." },
  { key: "hook", n: 3, label: "Hook", level: "must-fix", passes: "A relatable belief, contrast, question or real moment. No \"Today I want to talk about\", no greeting, no naming the audience." },
  { key: "rehook", n: 4, label: "Re-hook", level: "must-fix", passes: "Adds something new: tension, a turn, a surprise. Never restates the hook." },
  { key: "story", n: 5, label: "Story holds together", level: "must-fix", passes: "Each beat follows from the last. A personal story progresses in order: what she loved, her real reason for the change, what she expected, the turn, the insight, how she helps now." },
  { key: "substance", n: 6, label: "Enough substance", level: "must-fix", passes: "Every must-keep point of the brief is there in meaning, with the insight and how she helps. Not dry, not incomplete." },
  { key: "payoff", n: 7, label: "Payoff", level: "must-fix", passes: "Answers what the hook promised, with why it matters and what she does differently or how she helps." },
  { key: "close", n: 8, label: "Close", level: "flag", passes: "Natural and tied to the premise: by default a warm invitation tied to the message (a callback alone only for a story with no service angle). Not a slogan." },
  { key: "her_voice", n: 9, label: "Sounds like her", level: "flag", passes: "Her voice at its best on camera: her vocabulary and her strongest short phrases in tight, natural, polished spoken sentences. No transcript sentences pasted in, none of her avoid-words, no industry terms spoken to homeowners." },
  { key: "claims", n: 10, label: "Every claim supported", level: "must-fix", passes: "Each factual line traces to something she said (anywhere in the call) or approved; a faithful paraphrase counts. Topic descriptions and our assumptions do not count." },
  { key: "length", n: 11, label: "Length", level: "must-fix", passes: `At most ${WRITER_LENGTH.cap} spoken words (the cap); ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]} is the aim. Seconds shown.` },
  { key: "nothing_extra", n: 12, label: "Nothing extra", level: "flag", passes: "Every sentence creates interest, builds understanding, delivers value, earns trust or moves the story." },
] as const;
export type ReviewCheckKey = (typeof REVIEW_CHECKS)[number]["key"];
export const REVIEW_CHECK_KEYS = REVIEW_CHECKS.map((c) => c.key) as ReviewCheckKey[];

export type ReviewCheckResult = { key: ReviewCheckKey; n: number; label: string; level: CheckLevel; pass: boolean; reason: string };
export type HardFinding = { key: "greeting" | "dash" | "duration" | "market_claim" | "jargon" | "hook_length" | "audience_vocative" | "pasted"; level: CheckLevel; detail: string };

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
];
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
  if (jargon.length) findings.push({ key: "jargon", level: "flag", detail: `Industry terms spoken to homeowners: ${jargon.join(", ")}.` });
  // A long run is a transcript sentence stitched in (must-fix); a medium one may be a strong line of hers, so it is a flag to look at.
  const spokenSrc = spokenSourceText ?? sourceText;
  const pastedLong = pastedRuns(spoken, spokenSrc, PASTED_MUST_FIX_WORDS);
  const pastedMid = pastedRuns(spoken, spokenSrc).filter((s) => !pastedLong.includes(s));
  if (pastedLong.length) findings.push({ key: "pasted", level: "must-fix", detail: `Pasted from the call word for word: ${pastedLong.slice(0, 2).map((p) => `"${p}"`).join("; ")}. Keep her meaning and her best short phrases; write the sentence for camera.` });
  if (pastedMid.length) findings.push({ key: "pasted", level: "flag", detail: `Close to her words from the call: ${pastedMid.slice(0, 2).map((p) => `"${p}"`).join("; ")}. Keep it only if it is strong and natural on camera.` });
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

/** Which of the 12 checks a hard finding counts against. */
export const HARD_TO_CHECK: Record<HardFinding["key"], ReviewCheckKey> = {
  greeting: "hook", audience_vocative: "hook", hook_length: "hook", dash: "nothing_extra", duration: "nothing_extra", market_claim: "claims", jargon: "her_voice", pasted: "her_voice",
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
 * missing answer is a fail ("not scored"), never a pass.
 */
export function mergeReview(model: { key?: string; pass?: boolean; reason?: string }[], hard: HardFinding[], words: number): ReviewCheckResult[] {
  return REVIEW_CHECKS.map((spec): ReviewCheckResult => {
    if (spec.key === "length") return lengthCheck(words);
    const got = model.find((m) => m?.key === spec.key);
    let pass = typeof got?.pass === "boolean" ? got.pass : false;
    let reason = typeof got?.reason === "string" && got.reason.trim() ? got.reason.replace(/\s+/g, " ").trim().slice(0, 400) : got ? (pass ? "Passes." : "Did not pass.") : "Not scored by the reviewer.";
    let level: CheckLevel = spec.level;
    for (const h of hard.filter((x) => HARD_TO_CHECK[x.key] === spec.key)) {
      // A must-fix hard finding fails the check at must-fix level whatever the
      // reviewer said; a flag-level one fails a passing check as a flag.
      const modelSaid = pass ? "" : reason;
      if (h.level === "must-fix") { pass = false; level = "must-fix"; reason = `${h.detail} ${modelSaid}`.trim(); }
      else if (pass) { pass = false; reason = h.detail; }
    }
    return { key: spec.key, n: spec.n, label: spec.label, level, pass, reason: reason.slice(0, 500) };
  });
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

export const HOOK_CRITERIA = ["relevance", "curiosity", "specificity", "naturalDelivery", "accuracy", "herVoice", "payoffConnection"] as const;
export type HookCriterion = (typeof HOOK_CRITERIA)[number];
export type HookCandidate = { text: string; rehook: string; lever: string; scores: Record<HookCriterion, number>; total: number; note: string; disqualified: string | null };

const clampScore = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(5, Math.round(v))) : 1);

/** Clean the model's hooks and pick the winner: accurate (4+), no greeting, no audience vocative, no dash; then the highest total; ties go to the earlier one. */
export function pickHook(raw: { text?: unknown; rehook?: unknown; lever?: unknown; scores?: Record<string, unknown> | null; note?: unknown }[]): { hooks: HookCandidate[]; chosen: number } {
  const hooks: HookCandidate[] = (Array.isArray(raw) ? raw : []).slice(0, 5).map((h) => {
    const scores = Object.fromEntries(HOOK_CRITERIA.map((k) => [k, clampScore(h?.scores?.[k])])) as Record<HookCriterion, number>;
    const text = String(h?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const why = !text ? "empty" : scores.accuracy < 4 ? "accuracy under 4" : GREETING_RE.test(text) ? "opens with a greeting" : AUDIENCE_VOCATIVE_RE.test(text) ? "opens by naming the audience" : DASH_RE.test(text) ? "uses a dash" : null;
    return { text, rehook: String(h?.rehook ?? "").replace(/\s+/g, " ").trim().slice(0, 400), lever: String(h?.lever ?? "").trim().slice(0, 80), scores, total: HOOK_CRITERIA.reduce((n, k) => n + scores[k], 0), note: String(h?.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300), disqualified: why };
  });
  let chosen = -1;
  for (let i = 0; i < hooks.length; i++) {
    if (hooks[i].disqualified) continue;
    if (chosen < 0 || hooks[i].total > hooks[chosen].total) chosen = i;
  }
  if (chosen < 0) {
    // Every hook was disqualified: the most accurate non-empty one, so the draft can still be written and the review says what is wrong.
    for (let i = 0; i < hooks.length; i++) if (hooks[i].text && (chosen < 0 || hooks[i].scores.accuracy * 100 + hooks[i].total > hooks[chosen].scores.accuracy * 100 + hooks[chosen].total)) chosen = i;
  }
  return { hooks, chosen };
}
