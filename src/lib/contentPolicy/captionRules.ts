// ---------------------------------------------------------------------------
// INSTAGRAM CAPTION RULES (Oct 23 2026). Jordan: "Caption writing should
// follow Instagram / meta's rules for writing captions that drive the most
// engagement." And, the same evening: a Sonnet-class model, a lean prompt
// (the transcript, the script, a short strategy excerpt and the rules), one
// call per approved version, no review or rewrite loop.
//
// The rules, each with its source and date, are in
// docs/instagram-caption-rules.md. This file is the prompt that carries them
// (CAPTION_SYSTEM, buildCaptionDraftPrompt) and the code that enforces the
// checkable ones on whatever the model wrote (finishCaption, checkCaption):
//   IG1 at most 5 hashtags, no generic ones   IG3 a first line that stands alone
//   IG6/IG8 one CTA, short paragraphs          IG7 no engagement bait
//   H2 no number that is in none of the sources   H3 no em or en dashes
//   H4 no invented offer                       H5 fair-housing-safe wording
//
// Pure: no database, no model, no network. postingKit.ts wires it to rows.
// ---------------------------------------------------------------------------

import type { StrategyDocument } from "./strategyTemplate";
import type { JsonSchema } from "./prompts";
import { stripScriptDashes, hasScriptDash } from "./scriptFormat";

export const CAPTION_LIMITS = {
  /** IG1: Instagram allows up to 5 hashtags on a reel or post (Dec 2025). */
  maxHashtags: 5,
  /** House: at least this many targeted hashtags when the model offers them. */
  minHashtags: 3,
  /** IG3: two lines on a phone before "more". Our measure, not an Instagram number. */
  firstLineMax: 90,
  /** The hub's long-standing clip (trade blogs cite 2,200; not re-verified from a primary source). */
  captionMax: 2200,
  /** House: the body after the hook, in words. Guidance for the model, not cut by code. */
  bodyWords: [25, 90] as const,
} as const;

/** IG1: tags Instagram singles out as generic, plus their usual cousins. Never kept. */
export const GENERIC_HASHTAGS = new Set([
  "reels", "reel", "explore", "explorepage", "explorer", "fyp", "foryou", "foryoupage", "viral", "trending",
  "instagood", "instagram", "instadaily", "reelsinstagram", "reelitfeelit", "follow", "followme", "like", "likeforlike", "l4l", "photooftheday", "love",
]);

/**
 * IG7 (Meta: posts that explicitly ask for votes, shares, comments, tags,
 * likes or reactions). The classic bait only: Instagram's own clarification
 * (Jun 2024) says open questions, calls to action and DM-keyword tools are
 * fine, so a strategy's "DM me PRICE" is never touched here.
 */
const ENGAGEMENT_BAIT = [
  /\btag\s+(?:a|your|some|one)\s+(?:friend|buddy|person)/i,
  /\btag\s+someone\b/i,
  /\b(?:hit\s+)?like\s+if\b/i,
  /\blike\s+this\s+(?:post|video|reel)\b/i,
  /\bdouble[\s-]?tap\b/i,
  /\bcomment\s+["“']?(?:yes|no)\b/i,
  /\bcomment\s+(?:below\s+)?if\s+you\b/i,
  /\bcomment\s+(?:a|an|your|the)\s+\S*\s*emoji\b/i,
  /\bdrop\s+(?:a|an|the)\s+\S*\s*emoji\b/i,
  /\bshare\s+(?:this\s+)?with\s+(?:\d+|three|five|ten)\s+(?:friends|people)\b/i,
  /\bsmash\s+(?:that|the)\s+(?:like|follow)\b/i,
];

/** H4 (carried over from the grounding guard, Sep 25 2026): an offer the strategy never made. */
export const INVENTED_OFFER = /\b(free|download|guide|checklist|e-?book|template|webinar|workbook|cheat ?sheet|giveaway|discount|coupon)\b/i;

/** H5: who a place is "for", by a protected class. Conservative: these phrases, never the plain words alone. */
const STEERING = [
  /\b(?:perfect|ideal|great|made|built|meant|best|suited|suitable)\s+for\s+(?:a\s+|the\s+|young\s+|growing\s+|new\s+|big\s+|small\s+|any\s+)?(?:famil(?:y|ies)|kids|children|couples?|singles?|bachelors?|retirees?|seniors?|elderly|empty[\s-]?nesters?|young\s+professionals?|newlyweds?|christians?|jews|jewish\s+\w+|muslims?|catholics?|immigrants?)\b/i,
  /\b(?:family|kid|child|children|adult|senior)[\s-]friendly\b/i,
  /\b(?:christian|jewish|muslim|catholic|hispanic|latino|asian|black|white|ethnic|exclusive|integrated|segregated)\s+(?:neighbou?rhood|community|area|street|block|town|enclave)\b/i,
  /\b(?:no|not for)\s+(?:kids|children|families|couples|singles)\b/i,
];

export type CaptionFinding =
  | "first_line_too_long" | "too_many_hashtags" | "generic_hashtag" | "dash" | "engagement_bait" | "steering" | "no_cta" | "too_long";

/** The checkable rules, read off a finished caption. Empty = it passes. */
export function checkCaption(caption: string): CaptionFinding[] {
  const out: CaptionFinding[] = [];
  const first = caption.split("\n")[0] ?? "";
  if (first.length > CAPTION_LIMITS.firstLineMax) out.push("first_line_too_long");
  const tags = hashtagsIn(caption);
  if (tags.length > CAPTION_LIMITS.maxHashtags) out.push("too_many_hashtags");
  if (tags.some((t) => GENERIC_HASHTAGS.has(t.slice(1).toLowerCase()))) out.push("generic_hashtag");
  if (hasScriptDash(caption)) out.push("dash");
  if (ENGAGEMENT_BAIT.some((r) => r.test(caption))) out.push("engagement_bait");
  if (STEERING.some((r) => r.test(caption))) out.push("steering");
  if (caption.length > CAPTION_LIMITS.captionMax) out.push("too_long");
  return out;
}

export function hashtagsIn(text: string): string[] {
  return [...text.matchAll(/(^|[^\w&#])#([A-Za-z0-9_]{2,60})/g)].map((m) => `#${m[2]}`);
}

// ---------------------------------------------------------------------------
// THE PROMPT
// ---------------------------------------------------------------------------

export const CAPTION_SYSTEM = [
  "You write one Instagram caption for a short real estate video (a Reel, usually under a minute) that a Realtour Pilot client filmed. You write it AS HER: first person, the way she talks on camera.",
  "",
  "SOURCES, the only facts you may use:",
  "1. TRANSCRIPT OF THE FINAL CUT: what she actually says in the finished video. The primary source.",
  "2. APPROVED SCRIPT: what the video was planned to say. Supporting only; where it differs from the transcript, the transcript wins.",
  "3. STRATEGY NOTES: her voice, her goals, the video's pillar, the area she serves and her CTA examples.",
  "Never add a fact, number, price, statistic, date, place, story, credential, offer or quote that is not in these sources. Never put words in quotation marks unless she says them in the transcript.",
  "",
  "INSTAGRAM'S RULES (from Instagram and Meta's own guidance):",
  `- First line: it is all most people see before "more", so it is a complete hook on its own: a question, the most surprising point in the video, or a teaser. At most ${CAPTION_LIMITS.firstLineMax} characters. Never open with her name, a greeting or "In this video".`,
  "- Search: use the plain words people would type into Instagram search for this topic (the subject, and the town or area she serves when the notes name it), naturally inside the sentences.",
  "- Value: back up the video's one point so the caption is worth saving or sending to someone it would help, using only the sources. Short lines, a blank line between parts.",
  `- Hashtags: ${CAPTION_LIMITS.minHashtags} to ${CAPTION_LIMITS.maxHashtags}, specific to the topic and her area. Instagram allows at most ${CAPTION_LIMITS.maxHashtags}. Never generic tags such as #reels, #explore, #fyp, #viral or #instagood.`,
  "- One call to action, at the end, tied to her strategy's goal and in the style of her CTA examples: an open question, or one clear next step (DM, call, text, the link in her bio when her notes use it).",
  "- Never engagement bait: no \"comment YES\", no \"drop an emoji\", no \"tag a friend\", no \"like if\", no \"share this with 3 friends\", no \"double tap\". Instagram does not recommend posts that ask for engagement that way. For a keyword ask, prefer \"DM me WORD\" to \"comment WORD\" unless her CTA examples use comments.",
  `- Length: after the hook, 2 to 4 short lines, ${CAPTION_LIMITS.bodyWords[0]} to ${CAPTION_LIMITS.bodyWords[1]} words in all.`,
  "",
  "HOUSE RULES:",
  "- First person, her voice as the notes describe it. Never about her in the third person.",
  "- No em dashes and no en dashes anywhere. Use a comma or a period.",
  "- Fair housing: never say who a home, street, town or school area is right, ideal or \"perfect\" for, and never mention or hint at race, color, religion, sex, disability, familial status (families, kids, couples, singles, empty nesters), national origin or age. Describe the place or the topic, never the people who should live there.",
  "- No hype words (stunning, amazing, dream home) unless she says them in the transcript. No emojis unless the notes say her voice uses them, and then at most two.",
  "",
  "OUTPUT: one JSON object matching the schema. hook = the first line only. body = the lines after it, without the call to action and without hashtags. cta = the one call to action. hashtags = the hashtags, each starting with #. shortCaption = one or two lines for a story or a repost. coverTitle = two to six words for the video's cover, from the video's own idea. gaps = anything you needed that the sources did not give (an empty list when none).",
].join("\n");

const str = (description: string): JsonSchema => ({ type: "string", description });
export const CAPTION_DRAFT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hook", "body", "cta", "hashtags", "shortCaption", "coverTitle", "gaps"],
  properties: {
    hook: str(`The first line only, at most ${CAPTION_LIMITS.firstLineMax} characters.`),
    body: str("The lines after the hook. No call to action, no hashtags."),
    cta: str("The one call to action."),
    hashtags: { type: "array", items: { type: "string" }, description: `${CAPTION_LIMITS.minHashtags} to ${CAPTION_LIMITS.maxHashtags} specific hashtags, each starting with #.` },
    shortCaption: str("One or two lines."),
    coverTitle: str("Two to six words, or an empty string."),
    gaps: { type: "array", items: { type: "string" } },
  },
};

export type CaptionDraftInput = {
  clientName: string;
  videoTitle: string;
  /** The final cut's transcript, or null when there is none. */
  transcript: string | null;
  /** Why there is no transcript, in a few words (shown to the model only as context). */
  transcriptGap?: string | null;
  /** The approved script, rendered as plain lines, or null. */
  script: string | null;
  strategy: StrategyDocument | null;
  /** The pillar named on the script, when known. */
  pillarName?: string | null;
};

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const plain = (s: string | null | undefined) => (s ? stripScriptDashes(s.replace(/\s+/g, " ").trim()) : "");

/** The strategy's few lines a caption needs (voice, message, goals, the pillar, the area, CTA examples). Never the whole document. */
export function strategyExcerpt(doc: StrategyDocument | null, pillarName: string | null | undefined): { lines: string[]; ctaExamples: string[] } {
  if (!doc) return { lines: ["- No approved strategy is on file."], ctaExamples: [] };
  const lines: string[] = [];
  const voice = plain(doc.brandOverview.brandVoice);
  if (voice) lines.push(`- Her voice: ${clipText(voice, 300)}`);
  const message = plain(doc.brandOverview.shortBrandStatement || doc.brandOverview.brandMessage);
  if (message) lines.push(`- Brand message: ${clipText(message, 300)}`);
  const goals = doc.contentGoals.items.map(plain).filter(Boolean).slice(0, 3);
  if (goals.length) lines.push(`- Content goals: ${goals.map((g) => clipText(g, 160)).join("; ")}`);
  const pillars = doc.contentPillars.pillars;
  const want = (pillarName ?? "").trim().toLowerCase();
  const pillar = want ? pillars.find((p) => p.name.trim().toLowerCase() === want) ?? pillars.find((p) => want.includes(p.name.trim().toLowerCase()) || p.name.trim().toLowerCase().includes(want)) : null;
  if (pillar) lines.push(`- This video's pillar: ${plain(pillar.name)}${pillar.purpose ? `. ${clipText(plain(pillar.purpose), 240)}` : ""}`);
  else if (pillarName) lines.push(`- This video's pillar: ${plain(pillarName)}`);
  const area = plain(doc.targetAudience.primaryServiceAreas);
  if (area) lines.push(`- The area she serves: ${clipText(area, 200)}`);
  const ctaExamples = (doc.captionCtaExamples?.items ?? []).map(plain).filter(Boolean).slice(0, 5);
  return { lines, ctaExamples };
}

/** The user message: lean on purpose (Jordan, Oct 23 2026: aim for 3 to 6k input tokens; usually far less). */
export function buildCaptionDraftPrompt(input: CaptionDraftInput): { system: string; prompt: string; schema: JsonSchema; sourcesText: string } {
  const ex = strategyExcerpt(input.strategy, input.pillarName);
  const transcript = input.transcript ? clipText(input.transcript.trim(), 6000) : null;
  const script = input.script ? clipText(input.script.trim(), 3000) : null;
  const ctaBlock = ex.ctaExamples.length
    ? ["CAPTION CTA EXAMPLES FROM THE APPROVED STRATEGY (match their style and keywords; never invent an offer, a lead magnet or a resource they do not name):", ...ex.ctaExamples.map((c) => `- ${c}`)]
    : ["CTA RULE: The strategy names NO offers, so plain asks only (a question, DM me, call or text me). No free guides, checklists, downloads or discounts."];
  const prompt = [
    `CLIENT: ${plain(input.clientName)}`,
    `VIDEO: ${plain(input.videoTitle) || "Untitled video"}`,
    "",
    "STRATEGY NOTES:",
    ...ex.lines,
    "",
    ...ctaBlock,
    "",
    transcript
      ? `TRANSCRIPT OF THE FINAL CUT (primary factual source; the caption must not claim anything the video no longer says):\n${transcript}`
      : `NO TRANSCRIPT OF THE FINAL CUT EXISTS${input.transcriptGap ? ` (${plain(input.transcriptGap)})` : ""}. Draft from the script only, and keep every claim to what the script says.`,
    "",
    script ? `APPROVED SCRIPT (supporting context):\n${script}` : "APPROVED SCRIPT: none on file.",
  ].join("\n");
  const sourcesText = [transcript ?? "", script ?? "", ...ex.lines, ...ex.ctaExamples, input.videoTitle].join("\n");
  return { system: CAPTION_SYSTEM, prompt, schema: CAPTION_DRAFT_SCHEMA, sourcesText };
}

// ---------------------------------------------------------------------------
// THE CODE CHECKS — whatever the model wrote
// ---------------------------------------------------------------------------

/** What a model (or an older stub) may send back. Legacy fields are read too, so a reply in the old shape is never lost. */
export type CaptionModelOut = {
  hook?: string | null; body?: string | null; cta?: string | null; hashtags?: string[] | null; shortCaption?: string | null; coverTitle?: string | null; gaps?: (string | { text?: string })[] | null;
  caption?: string | null; captionBody?: string | null; shorterCaption?: string | null; shorterAlternative?: string | null;
  captionCta?: string | null; ctaOptions?: string[] | null; coverTitles?: string[] | null;
};

export type FinishedCaption = {
  /** The whole caption, ready to paste: hook, body, CTA, hashtags. */
  caption: string;
  hook: string;
  shortCaption: string | null;
  cta: string | null;
  hashtags: string[];
  coverTitle: string | null;
  /** What the code changed, in plain words (stored with the draft for staff). */
  fixes: string[];
  gaps: string[];
  /** checkCaption on the result: empty when every checkable rule holds. */
  findings: CaptionFinding[];
};

const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100" };
function numbersIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,.]*/g)) {
    const n = m[0].replace(/[,.]+$/, "").replace(/,/g, "");
    if (n) out.add(n);
  }
  for (const m of text.toLowerCase().matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred)\b/g)) out.add(NUMBER_WORDS[m[1]]);
  return [...out];
}
/** Numbers in the text (digits only) that none of the sources contain, in digits or in words. */
function unsupportedNumbers(text: string, sourceNumbers: Set<string>): string[] {
  return [...text.matchAll(/\d[\d,.]*/g)].map((m) => m[0].replace(/[,.]+$/, "").replace(/,/g, "")).filter((n) => n && !sourceNumbers.has(n));
}

// A stop followed straight by a letter or digit ("1.2", "site.com") does not end a sentence.
const sentencesOf = (line: string) => line.match(/(?:[^.!?]|[.!?](?=\w))+(?:[.!?]+["”’')\]]*|$)\s*/g) ?? [line];

/** Drop the sentences a rule refuses; returns the kept text and how many went. */
function dropSentences(text: string, refuse: (sentence: string) => boolean): { text: string; dropped: number } {
  let dropped = 0;
  const lines = text.split("\n").map((line): string | null => {
    if (!line.trim()) return line; // a paragraph break stays
    const kept = sentencesOf(line).filter((s) => {
      if (s.trim() && refuse(s)) { dropped++; return false; }
      return true;
    });
    const out = kept.join("").trim();
    return out ? out : null; // a line whose every sentence went, goes
  });
  return { text: lines.filter((l): l is string => l !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim(), dropped };
}

function cleanTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, "").replace(/[^A-Za-z0-9_]/g, "");
  if (t.length < 2 || t.length > 60 || /^\d+$/.test(t)) return null;
  return `#${t}`;
}

export type FinishOptions = {
  /** Everything the sources say (transcript, script, strategy excerpt, title): a number in the caption must appear here. */
  sourcesText: string;
  /** The strategy's Caption CTA Examples (empty = it names no offer). */
  ctaExamples: string[];
};

/** A plain ask that invents nothing, for when the model's CTA breaks a rule and the strategy offers no example. */
export const PLAIN_CTA = "Questions about this? Send me a message.";

/** Enforce the checkable rules on a model's answer and assemble the caption. Pure; never throws. */
export function finishCaption(raw: CaptionModelOut, opts: FinishOptions): FinishedCaption {
  const fixes: string[] = [];
  const gaps = (raw.gaps ?? []).map((g) => (typeof g === "string" ? g : g?.text ?? "")).map((g) => g.trim()).filter(Boolean);
  const sourceNumbers = new Set(numbersIn(opts.sourcesText));
  const s = (v: unknown) => (typeof v === "string" ? v.replace(/\r/g, "").trim() : "");

  // The parts, from the new shape or an older one.
  let hook = s(raw.hook);
  let body = s(raw.body);
  if (!hook && !body) {
    const whole = s(raw.caption) || s(raw.captionBody);
    const lines = whole.split("\n");
    hook = (lines.shift() ?? "").trim();
    body = lines.join("\n").trim();
  }
  // The CTA and, from an older reply shape, its alternatives: the first that keeps the rules wins (below).
  const ctaCandidates = [s(raw.cta), s(raw.captionCta), ...(raw.ctaOptions ?? []).map(s)].filter(Boolean);
  let cta = ctaCandidates[0] ?? "";
  let shortCaption = s(raw.shortCaption) || s(raw.shorterCaption) || s(raw.shorterAlternative);
  let coverTitle = s(raw.coverTitle) || s((raw.coverTitles ?? [])[0]);

  // H3: no em or en dashes, anywhere.
  const undash = (t: string, title = false) => (hasScriptDash(t) ? (fixes.push("dash rewritten"), stripScriptDashes(t, { title })) : t);
  hook = undash(hook); body = undash(body); cta = undash(cta); shortCaption = undash(shortCaption); coverTitle = undash(coverTitle, true);

  // IG1: hashtags live in one list at the end; inline ones are moved there.
  const inline = [...hashtagsIn(hook), ...hashtagsIn(body), ...hashtagsIn(cta)];
  const stripTags = (t: string) => t.replace(/(^|[^\w&#])#([A-Za-z0-9_]{2,60})/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1").trim();
  if (inline.length) { hook = stripTags(hook); body = stripTags(body); cta = stripTags(cta); }
  const seen = new Set<string>();
  const hashtags: string[] = [];
  let generic = 0;
  for (const t of [...(raw.hashtags ?? []), ...inline]) {
    const c = typeof t === "string" ? cleanTag(t) : null;
    if (!c) continue;
    const k = c.slice(1).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (GENERIC_HASHTAGS.has(k)) { generic++; continue; }
    hashtags.push(c);
  }
  if (generic) fixes.push(`${generic} generic hashtag${generic === 1 ? "" : "s"} dropped`);
  if (hashtags.length > CAPTION_LIMITS.maxHashtags) { fixes.push(`hashtags cut to ${CAPTION_LIMITS.maxHashtags}`); hashtags.length = CAPTION_LIMITS.maxHashtags; }

  // H5: fair housing. H2: no number the sources do not hold. Whole sentences go.
  const steering = (x: string) => STEERING.some((r) => r.test(x));
  const unsupported = (x: string) => unsupportedNumbers(x, sourceNumbers).length > 0;
  for (const [name, refuse, why] of [
    ["steering", steering, "a sentence about who a place suits was removed (fair housing)"],
    ["numbers", unsupported, "a sentence with a number that is not in the video or the script was removed"],
  ] as const) {
    const h = dropSentences(hook, refuse), b = dropSentences(body, refuse), sc = dropSentences(shortCaption, refuse);
    const n = h.dropped + b.dropped + sc.dropped;
    if (n) {
      hook = h.text; body = b.text; shortCaption = sc.text;
      fixes.push(why);
      gaps.push(name === "steering" ? "Check the wording: a line about who the home or area suits was taken out." : "A number the sources do not give was taken out. Add it back only if it is true.");
    }
  }

  // IG7 + H4: the one CTA. Bait or an invented offer → her strategy's own example, else a plain ask.
  const baitOrOffer = (x: string) => ENGAGEMENT_BAIT.some((r) => r.test(x)) || (!opts.ctaExamples.length && INVENTED_OFFER.test(x)) || steering(x) || unsupported(x);
  const fallbackCta = opts.ctaExamples.find((x) => !ENGAGEMENT_BAIT.some((r) => r.test(x))) ?? PLAIN_CTA;
  if (!cta) { cta = fallbackCta; fixes.push("no call to action was written, her strategy's own was used"); }
  else if (baitOrOffer(cta)) {
    const next = ctaCandidates.slice(1).map((x) => stripScriptDashes(x)).find((x) => !baitOrOffer(x));
    cta = next ?? fallbackCta;
    fixes.push("the call to action broke a rule and was replaced");
  }
  // A bait line left in the body goes too (only the CTA asks).
  const bb = dropSentences(body, (x) => ENGAGEMENT_BAIT.some((r) => r.test(x)));
  if (bb.dropped) { body = bb.text; fixes.push("an engagement-bait line was removed"); }

  // IG3: the first line stands alone and fits in two lines on a phone.
  if (!hook && body) { const lines = body.split("\n"); hook = (lines.shift() ?? "").trim(); body = lines.join("\n").trim(); }
  hook = hook.replace(/\s*\n\s*/g, " ").trim();
  if (hook.length > CAPTION_LIMITS.firstLineMax) {
    // At a sentence end if one fits, else at a clause (", " "; " ": ") made a
    // sentence of its own, else at a word with an ellipsis; the rest opens the body.
    const max = CAPTION_LIMITS.firstLineMax;
    const head = hook.slice(0, max);
    const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
    const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "));
    let first: string;
    let rest: string;
    if (sentence >= 20) { first = hook.slice(0, sentence + 1); rest = hook.slice(sentence + 2); }
    else if (clause >= 20 && clause < max - 1) {
      first = `${hook.slice(0, clause)}.`;
      rest = hook.slice(clause + 2).trim();
      rest = rest.charAt(0).toUpperCase() + rest.slice(1);
    } else {
      const sp = head.lastIndexOf(" ", max - 2);
      const at = sp > 20 ? sp : max - 1;
      first = `${hook.slice(0, at).trim()}…`;
      rest = `…${hook.slice(at).trim()}`;
    }
    hook = first.trim();
    body = [rest.trim(), body].filter(Boolean).join("\n");
    fixes.push("the first line was shortened (the rest moved below it)");
  }

  // IG8: hook, blank line, body, blank line, CTA, blank line, hashtags.
  const assemble = () => [hook, body, cta, hashtags.join(" ")].filter((p) => p && p.trim()).join("\n\n");
  let caption = assemble();
  if (caption.length > CAPTION_LIMITS.captionMax) {
    const room = Math.max(0, body.length - (caption.length - CAPTION_LIMITS.captionMax) - 1);
    body = `${body.slice(0, room).replace(/\s+\S*$/, "")}…`;
    caption = assemble();
    fixes.push("shortened to Instagram's caption length");
  }
  return {
    caption, hook, shortCaption: shortCaption || null, cta: cta || null, hashtags, coverTitle: coverTitle || null,
    fixes: [...new Set(fixes)], gaps: [...new Set(gaps)], findings: checkCaption(caption),
  };
}
