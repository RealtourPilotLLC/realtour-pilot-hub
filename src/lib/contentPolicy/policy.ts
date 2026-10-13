// ---------------------------------------------------------------------------
// Content Program generation policy — spec §27, versioned.
//
// One policy object, one version string, one content hash. Every generated
// bank and script records `GENERATION_POLICY_VERSION` + `GENERATION_POLICY_HASH`
// so a stored row can be checked against the code that produced it.
//
// Sources (scratchpad/portal-references/REFERENCE_MANIFEST.md, Sep 16 2026):
//   §2.1 the Scripting GPT system prompt, verbatim, is the BASE rules text;
//   §2.2 the consolidated device list (Anatomy / Scripting Success / 10 Laws);
//   §2.4 what the policy hard-codes and where each element comes from;
//   §9   Jordan's rulings — exactly three points, "archive = voice, policy =
//        format". There is deliberately NO duration override field anywhere
//        in this object. Do not add one.
//   LENGTH (Jordan, Oct 6 2026, superseding the Sep 16 20–30 s ruling):
//        "video length varies for all clients. They should be between 30-50
//        seconds long, sometimes a minute, but I don't think that's important
//        to note anywhere." → target 30–50 s of natural spoken delivery; the
//        length check is a soft warning that never blocks and only fires when
//        an estimate is clearly under 30 s or over a minute (timing.warnBelowSec
//        / warnAboveSec); no length is written into any client's style notes.
//
// Pure data + pure functions. No DB, no AI, no I/O.
// ---------------------------------------------------------------------------

/** Bump on any change to the policy content below. Date-stamped, dot-serial. */
// 2026-10-06.1: the Video Structure Framework is one definition for every
// client (Jordan, Oct 6 2026) — "bold statement" added to the Hook, and the
// framework itself is now part of the rules text every prompt carries.
// 2026-10-06.2: length target 30–50 s (Jordan, Oct 6 2026 — supersedes the
// Sep 16 20–30 s ruling), warn only under 25 s / over 65 s, part budgets and
// the word heuristic rescaled to match; client-specific direction from a
// document's own framework parts is carried into its Client style notes.
// 2026-10-12.1: no dashes in a script (Jordan, Oct 12 2026: "Make sure no em
// dashes are ever written into the scripts") — the punctuation rule every
// prompt carries; scriptFormat.stripScriptDashes enforces it where a version
// is written and validateNewScript reports one that gets through.
// 2026-10-14.1: a clean house brief (Oct 14 2026). The April GPT text no
// longer reaches a prompt (HOUSE_SCRIPTING_RULES instead), the overrides that
// only contradicted it are gone, the devices are worded for a personal brand,
// and the script prompt decides the viewer and angle first, carries the
// audience psychology and per-section rules, and reads the client's creative
// identity (prompts.ts).
export const GENERATION_POLICY_VERSION = "2026-10-14.1";

/** The three roles, in order. Stored as roles; the label style is a rendering choice (C-A3). */
export type TalkingPointRole = "re-hook" | "build-up" | "payoff";

export const TALKING_POINT_ROLES: readonly TalkingPointRole[] = ["re-hook", "build-up", "payoff"];

export type TalkingPointRoleSpec = {
  role: TalkingPointRole;
  /** Canonical client-facing label (spec §27 "Canonical script output"). */
  label: string;
  /** Arielle §4 heading, verbatim, for the strategy template. */
  frameworkHeading: string;
  /** Arielle §4 definition, verbatim (manifest R15) — the only source that defines the roles. */
  definition: string;
  /** Labels seen in delivered work that map onto this role on import (C-A3). */
  importAliases: readonly string[];
};

export const TALKING_POINT_ROLE_SPECS: readonly TalkingPointRoleSpec[] = [
  {
    role: "re-hook",
    label: "Re-hook",
    frameworkHeading: "Talking Point 1 - Rehook",
    definition:
      "Clarify the situation and introduce the overlooked detail or consequence. Deepen the curiosity while making the topic’s relevance clear.",
    importAliases: ["RE-HOOK", "REHOOK", "RE HOOK"],
  },
  {
    role: "build-up",
    label: "Build up",
    frameworkHeading: "Talking Point 2 - Build Up",
    definition:
      "Develop the idea with a practical example, a behind-the-scenes detail, or the reasoning behind the team’s approach. Each point should lead naturally to the next.",
    importAliases: ["BUILD UP", "BUILD-UP", "BUILDUP", "SETUP", "SET UP", "SET-UP", "CONTEXT"],
  },
  {
    role: "payoff",
    label: "Payoff",
    frameworkHeading: "Talking Point 3 - Payoff",
    definition:
      "Resolve the opening question and deliver a useful takeaway. Help the viewer understand what to consider, what to do next, or why the team’s approach matters.",
    importAliases: ["PAYOFF", "PAY OFF", "PAY-OFF"],
  },
];

/**
 * THE VIDEO STRUCTURE FRAMEWORK — one definition, the same for every client
 * (Jordan, Oct 6 2026, verbatim). The three talking points are
 * TALKING_POINT_ROLE_SPECS above; these are the opening, the Hook and the
 * Close. strategyTemplate.ts builds POLICY_DEFAULT_FRAMEWORK from these, and
 * policyRulesText prints them for every prompt — nothing else defines them.
 */
export const FRAMEWORK_PREAMBLE =
  "Each reel follows a connected five-part flow, built around one clear idea. The hook creates curiosity, the talking points develop the story, and the payoff delivers on the opening promise.";
export const FRAMEWORK_HOOK = {
  heading: "Hook",
  definition:
    "Open with a specific concern, misconception, bold statement, or surprising observation that feels immediately relevant to a buyer or seller. Give viewers a reason to keep watching.",
} as const;
export const FRAMEWORK_CLOSE = {
  heading: "Close / Call to Action",
  definition:
    "Finish with a memorable takeaway or a relevant invitation to connect. Keep the close natural and concise, with the primary contact CTA in the caption when appropriate.",
} as const;

/** The framework's five parts as "Heading — definition" lines, in order. */
export function videoStructureFrameworkLines(): string[] {
  return [
    `${FRAMEWORK_HOOK.heading} — ${FRAMEWORK_HOOK.definition}`,
    ...TALKING_POINT_ROLE_SPECS.map((s) => `${s.frameworkHeading} — ${s.definition}`),
    `${FRAMEWORK_CLOSE.heading} — ${FRAMEWORK_CLOSE.definition}`,
  ];
}

/** Map a delivered label (any case, any punctuation) onto a role, or null. */
export function roleFromLabel(label: string | null | undefined): TalkingPointRole | null {
  if (!label) return null;
  const key = label.toUpperCase().replace(/[^A-Z]+/g, " ").trim();
  for (const spec of TALKING_POINT_ROLE_SPECS) {
    for (const alias of spec.importAliases) {
      if (alias.replace(/[^A-Z]+/g, " ").trim() === key) return spec.role;
    }
  }
  return null;
}

export type QualityDimension = "Trust" | "Value" | "Credibility" | "Entertainment";

/** Arielle §3 preamble — the only definitions that exist (manifest R39). Dimensions, never categories. */
export const QUALITY_DIMENSIONS: readonly { name: QualityDimension; means: string }[] = [
  { name: "Trust", means: "empathy and honesty" },
  { name: "Value", means: "a useful takeaway" },
  { name: "Credibility", means: "experience and clear reasoning" },
  { name: "Entertainment", means: "curiosity, storytelling, visual interest, or natural personality" },
];

// ---------------------------------------------------------------------------
// Rules text. Until Oct 14 2026 the April Scripting GPT system prompt below was
// pasted into every prompt as "BASE RULES" and then overridden line by line,
// so each prompt contradicted itself ("3 to 4 talking points" vs "exactly
// three", a mandatory Trust and Credibility "PILLAR RULE" vs "quality
// dimensions, not categories", topic-extraction duties inside a one-script
// prompt, a four-slot SCRIPT FORMAT). Oct 14 2026: the verbatim text is KEPT
// here as the record of where the house rules came from (and in the policy
// hash), but it never reaches a prompt. HOUSE_SCRIPTING_RULES carries its good
// parts; only the standing rulings that are rules in their own right stay in
// POLICY_OVERRIDES. Property-only listing-reel doctrine (camera and edit
// rules, feature wording) is not part of the monthly personal-brand brief;
// the psychology it shares with personal branding is (prompts.ts,
// AUDIENCE_PSYCHOLOGY_BLOCK).
// (Oct 6 2026: the verbatim text's three length sentences were edited from
// "20 to 30" to 30 to 50.)
// ---------------------------------------------------------------------------

/** The April 2026 Scripting GPT text, verbatim. A record only: never sent to a model (Oct 14 2026). */
export const SCRIPTING_GPT_INSTRUCTIONS_VERBATIM = `You are an elite short-form real estate personal branding script strategist for Realtour Pilot.

Your job is to turn strategy call transcripts, past scripts, content strategy documents, hook examples, and scripting reference materials into high-performing 30 to 50 second personal branding video scripts for real estate agents.

You do not write generic real estate content.
You write scripts that are strategic, sharp, natural on camera, and built to perform on short-form video.

PRIMARY OBJECTIVE

Given a strategy call transcript and supporting reference documents, identify the strongest filmable topics discussed in the call and turn them into polished short-form scripts.

Each script must:
- feel specific to the client
- be easy to say on camera
- start with a strong scroll-stopping hook
- include 3 to 4 strong talking points
- end with a strong close
- reflect the client’s actual brand, audience, positioning, and communication style

CORE RESPONSIBILITIES

1. Extract the strongest filmable topics from the strategy call transcript.
2. Ignore weak, repetitive, vague, or non-filmable discussion.
3. Use supporting knowledge files to understand the client’s:
   - market
   - niche
   - personality
   - communication style
   - target audience
   - content pillars
   - strategic positioning
4. Turn the best topics into 30 to 50 second scripts.
5. Structure every script clearly and consistently.
6. Make sure the scripts sound human, direct, and natural out loud.
7. Use the uploaded examples as the quality benchmark.

NON-NEGOTIABLE SCRIPT RULES

- Every script must begin with a strong hook.
- Never begin with weak intros like “Hi, I’m…”, “Hey guys”, or “Welcome back”.
- Hooks should be bold, direct, specific, emotionally charged, or curiosity-driven.
- Every script must include 3 to 4 talking points.
- Every script must end with a strong close that lands with authority.
- Scripts must be written for on-camera delivery.
- Scripts must sound conversational, not like a blog post.
- Keep scripts within 30 to 50 seconds.
- The middle must maintain engagement.

PILLAR RULE

Every script must strongly communicate Trust and Credibility.
Each script should also include Value or Entertainment, ideally both when natural.

TOPIC EXTRACTION RULES

- Extract only topics clearly discussed or strongly supported.
- Prioritize topics that build trust, authority, and relatability.
- Do not invent unsupported topics.
- Do not force weak topics.

HOOK STANDARDS

Strong hooks may include:
- contrarian statements
- strong opinions
- surprising truths
- emotional or status-driven framing

Avoid weak hooks like:
- “Here are 3 tips…”
- “A lot of people ask me…”

SCRIPT FORMAT

Video Topic Title:
Video Category:

HOOK:

TALKING POINTS:
1.
2.
3.
4.

CLOSE:

CONTENT PILLAR CHECK:
- Trust:
- Value:
- Credibility:
- Entertainment:

QUALITY CONTROL

Before finalizing each script:
- Ensure the hook is strong
- Ensure it sounds natural out loud
- Ensure it matches the client’s voice
- Ensure the close is strong

SUCCESS DEFINITION

A successful output feels like a skilled strategist turned a real conversation into high-performing, natural, filmable content.`;

/**
 * THE HOUSE SCRIPTING RULES (Oct 14 2026): the good parts of the April GPT
 * text, said once, for the monthly personal-brand program. No dash is used as
 * punctuation here: the model mirrors the punctuation of what it reads.
 */
export const HOUSE_SCRIPTING_RULES = `You write monthly personal-brand videos for Realtour Pilot's real estate agents. The subject is the agent: their expertise, their judgment, their personality and the people they serve. A viewer should come away trusting this agent, remembering them, and knowing why they would call them. This is not listing content: never sell a specific property.

Every script is:
- strategic: one clear idea that serves the client's approved strategy, the linked pillar and the audience the strategy names;
- specific to this client: their market, their opinions, their examples and their way of saying things, taken from their answers, their call lines and accepted facts. A script any other agent could read word for word is not finished;
- sharp and natural on camera: written for the ear, in short sentences, the way this client would explain it to a client across the table. It sounds conversational, never like a blog post;
- in the client's brand voice, for the client's audience.

HOOK STANDARDS: the first line earns the next one. A strong hook is specific: a misconception the client can correct, a strong opinion they will defend, a surprising truth, or a concern the viewer already has. No weak intros: never a greeting, the agent's name, "Welcome back", "Here are 3 tips" or "A lot of people ask me".

Exactly three talking points, in this order: Re-hook, Build up, Payoff. Trust, Value, Credibility and Entertainment are qualities every video builds through its content; they are not categories and not a checklist.`;

/** Jordan, Oct 6 2026: "between 30-50 seconds long, sometimes a minute". */
const TARGET_SEC = [30, 50] as const;
/** Manifest §4.3: the measured rate of natural spoken delivery. */
const WORDS_PER_SEC = 2.2;

/**
 * Standing rulings (manifest §7 C-A1…A7 + §9, and Jordan's later rulings).
 * Oct 14 2026: the lines that existed only to contradict the old base text
 * ("never 3 to 4", "the four-slot SCRIPT FORMAT above is historical", "the
 * CONTENT PILLAR CHECK block") went with it; each rule here stands on its own.
 */
export const POLICY_OVERRIDES: readonly string[] = [
  `LENGTH: spoken content targets ${TARGET_SEC[0]} to ${TARGET_SEC[1]} seconds of natural delivery; about a minute is acceptable when the idea needs it. Roughly ${Math.round(TARGET_SEC[0] * WORDS_PER_SEC)} to ${Math.round(TARGET_SEC[1] * WORDS_PER_SEC)} spoken words is a drafting heuristic, not proof of duration, and ${Math.round(TARGET_SEC[1] * WORDS_PER_SEC)} is the ceiling. There is no per-client, per-session or per-script duration override, and no length belongs in a client's style notes. Tighten rather than force rapid delivery. (Jordan, Oct 6 2026: “video length varies for all clients. They should be between 30-50 seconds long, sometimes a minute, but I don't think that's important to note anywhere.”)`,
  "CLOSE: a memorable final line. The direct contact ask (“DM me PLAN”) belongs in the optional caption CTA, not in the spoken close, unless the strategy says otherwise.",
  "QUALITY DIMENSIONS: Trust, Value, Credibility and Entertainment are built through the actual content of every video. The contentPillarCheck field is internal reviewer notes, one short line per dimension, never a number, never client-visible.",
  "ARCHIVE = VOICE, POLICY = FORMAT: historical examples establish the client’s voice and style, but the current policy controls the format. Older scripts with four talking points, and older scripts of any length, do not override the three-point requirement or the current length target. (Jordan, Sep 16 2026.)",
  "TRUTHFULNESS: never invent client stories, transaction outcomes, local statistics, credentials, personal anecdotes, offers, or guarantees. Anything the sources do not support becomes an explicit gap object in the output, never a plausible sentence in the script.",
  "SPEAKER ATTRIBUTION: only statements the client made are the client’s experience. Jordan’s suggestions, devil’s-advocate lines and hook ideas on a call are his; third parties mentioned on a call are not the client and never enter the client’s file as theirs.",
];

/** The spec's required presentation, verbatim shape (spec §27 "Canonical script output"). */
export const CANONICAL_SCRIPT_PRESENTATION = `Title
Category: the linked approved content pillar
HOOK
Talking Point 1: Re-hook
Talking Point 2: Build up
Talking Point 3: Payoff
Close / Call to action
Optional Caption CTA`;

/**
 * NO DASHES IN A SCRIPT (Jordan, Oct 12 2026): "Make sure no em dashes are
 * ever written into the scripts." Every prompt carries this (policyRulesText);
 * the script, revise and caption prompts repeat it beside their own rules. It
 * names the two characters but uses neither as punctuation, on purpose: a
 * model mirrors the punctuation of the instructions it reads.
 */
export const SCRIPT_PUNCTUATION_RULE =
  "Never write an em dash (\u2014) or an en dash (\u2013) in a script: not in the title, the hook, a talking point, the close or the caption CTA. Where a dash would go, use a comma, a period or the word \"and\". Write a number range with \"to\" (30 to 50).";

/** Hook types the policy names: the GPT's four + Arielle §4 + the spec's devices. */
export const HOOK_TYPES: readonly { name: string; source: string; note: string }[] = [
  { name: "Contrarian statement", source: "GPT", note: "Say the opposite of what the viewer assumes." },
  { name: "Strong opinion", source: "GPT", note: "A stance the agent will defend on camera." },
  { name: "Surprising truth", source: "GPT", note: "A fact or consequence the viewer did not expect." },
  { name: "Emotional or status-driven framing", source: "GPT", note: "Frame the stakes in identity, money, or pride." },
  {
    name: "Specific concern, misconception, bold statement, or surprising observation",
    source: "Video Structure Framework (Jordan, Oct 6 2026)",
    note: "Immediately relevant to a buyer or seller; give viewers a reason to keep watching.",
  },
  { name: "Comparative positioning", source: "spec §27 / Scripting Success §4", note: "Why this over that, used only when authentic." },
  {
    name: "Affluence through association",
    source: "spec §27 / Anatomy §4",
    note: "Tie the idea to a respected local reference the viewer recognises; never a false affiliation.",
  },
  {
    name: "Pattern interruption / genuine surprise",
    source: "spec §27 / Anatomy §5",
    note: "Genuine surprise or curiosity; never an invented claim, forced profanity or a false affiliation.",
  },
];

/**
 * Openers that fail a NEW script outright (GPT rule + Anatomy §6 “Welcome” sin +
 * spec “No greetings or introductions”). Phrase forms only — the bare words
 * (“Welcome mats…”, “Hi-rise…”, “Hello Kitty…”) are judged by shape in
 * scriptFormat.ts so a legitimate hook that merely starts with one is not rejected.
 */
export const BANNED_OPENERS: readonly string[] = ["Hi, I'm", "Hi I'm", "Hi, I am", "Hello, I'm", "Hello I'm", "Hey guys", "Hey everyone", "Hi everyone", "Hello everyone", "Welcome back", "Welcome to"];

/**
 * THE PART BUDGETS (CP-08, Sep 24 2026). The word total on its own did
 * not keep drafts short: the model met it by compressing EVERYTHING it was
 * given into long lines, and two drafts were estimated at about 39 s and 51 s
 * from their word counts (an estimate, never a measurement). Budgets per part
 * plus "evidence, not copy" address the cause.
 *
 * Oct 6 2026: rescaled with the 30–50 s target (Jordan). The budgets sum to
 * the heuristic's ceiling — 16 + 3 × 26 + 16 = 110 words ≈ 50 s at 2.2 words
 * per second — so a draft that fills every part still lands inside the target.
 * Oct 14 2026: moved here from prompts.ts so the validator reads the same
 * numbers; the script schema's field descriptions read them too (they said
 * 12 / 14 / 10, which no prose rule agreed with), and the validator warns
 * over 110 spoken words and on a hook over 16.
 */
export const SCRIPT_PART_BUDGETS = { hookWords: 16, pointWords: 26, closeWords: 16 } as const;

/** Stock phrases no spoken line should lean on (Oct 14 2026): a validator warning, and named in the script prompt's section rules. */
export const STOCK_PHRASES: readonly string[] = ["nobody talks about", "no one talks about", "here's the truth", "let that sink in"];

/** Lines that claim a real client event: in an acted skit they are a warning (Oct 14 2026, the fiction rule). */
export const REAL_CLIENT_CLAIM_RE = /\b(?:my clients?|a client of mine|one of my clients|true story|this really happened|this actually happened)\b/i;

/** Weak hook shapes the GPT bans — a warning, since they are shapes rather than openers. */
export const WEAK_HOOK_PATTERNS: readonly string[] = ["Here are 3 tips", "Here are three tips", "A lot of people ask me", "People always ask me"];

/**
 * ADVISORY only (C-A8): the May 2026 plans' banned words and “one breath” test
 * were written for premium listing reels. They inform a warning, never a block,
 * and there is no 11-word hook cap for personal-branding scripts.
 */
export const ADVISORY_HOOK_RULES = {
  bannedWords: ["stunning", "gorgeous", "dream home", "wait for it", "you won't believe", "you won’t believe"] as readonly string[],
  oneBreathTest: "Remove any hook that feels longer than one breath.",
  noEngagementBait: "No engagement bait. No fake urgency. No corporate language.",
  origin: "Scripting Automation Plan §12 / Premium Reel Scripting Plan §8 (May 13 2026) — listing-reel doctrine, imported as advisory.",
} as const;

/**
 * Named devices, phrased for a personal brand (Oct 14 2026). The listing
 * training's psychology carries over (Jordan, Oct 14: "the same psychology
 * applies"); its property-only mechanics do not: "Scripting to edit", "Agent
 * on camera immediately" (camera rules) and "no highlighting obvious
 * features" (property wording) left this list, and the rest are worded for
 * an agent's own video. Each is used only when authentic.
 */
export const CREATIVE_DEVICES: readonly { name: string; source: string; rule: string }[] = [
  { name: "Re-hook", source: "Anatomy §3, §9", rule: "Re-engage the viewer midway with something new: a complication, a consequence or a sharper question." },
  { name: "Middle context", source: "Anatomy §1 / Scripting Success §7", rule: "Give the reasoning or the example that connects the opening to the ending." },
  { name: "Storytelling", source: "Scripting Success §5", rule: "The most impactful videos tell a story: a short, true one from the sources." },
  { name: "Bold statement", source: "Scripting Success §3", rule: "The bolder the statement, the more memorable the video, used only when the agent means it." },
  { name: "Affluence through association", source: "Anatomy §4", rule: "Tie the idea to a respected local reference the viewer recognises; never a false affiliation." },
  { name: "Genuine surprise", source: "Anatomy §5 (narrowed by spec §27)", rule: "A pattern interruption or real surprise; never an invented claim, forced profanity or a false affiliation." },
  { name: "Scripting sins", source: "Anatomy §6", rule: "No “Welcome”, no introducing the agent by name, no clichés." },
  { name: "Pattern utilization", source: "Anatomy §7 / §9", rule: "Adapt what works, then make it this client's own; never a template with the nouns swapped." },
  { name: "Comparative hook prompt", source: "Scripting Success §4 / Anatomy §11", rule: "Ask why someone should choose this over that (this approach, this agent, this decision); use the client's honest answer as the narrative." },
  { name: "Spoken rhythm", source: "Plans §12/§7", rule: "Write for spoken rhythm, not reading: short sentences, fragments, pauses, breathing room." },
  { name: "Show your face / authentic story / polarization", source: "10 Laws #1, #2, #4, #9", rule: "Be visible, be bold about beliefs and experiences, accept that strong opinions polarize." },
];

/** Not adopted for personal-branding scripts; recorded so nobody re-imports them (C-A4, C-A11, PREM §21). */
export const EXCLUDED_DOCTRINE: readonly string[] = [
  "Scripting Success §10 / Anatomy §1: a spoken transactional CTA (“Send me a message for a private tour”) — listing-video doctrine; the contact ask lives in the caption.",
  "Scripting Automation Plan / Premium Reel Plan: 11-word hook cap and the eight reel archetypes — stay in the premium-reel prompt library.",
  "Scripting Success §6 voiceover ban vs Premium plan voiceover allowance — out of scope; personal-branding scripts are agent-led.",
  "Oct 14 2026: listing-reel camera and edit rules (“Scripting to edit”, “Agent on camera immediately”), property feature wording and the listing advisory words (ADVISORY_HOOK_RULES) are not printed in the monthly personal-brand prompts; the advisory words remain an info-only validator note.",
];

// ---------------------------------------------------------------------------
// The policy object.
// ---------------------------------------------------------------------------

export type GenerationPolicy = {
  version: string;
  talkingPoints: {
    count: 3;
    roles: readonly TalkingPointRole[];
    specs: readonly TalkingPointRoleSpec[];
  };
  timing: {
    /** Seconds of natural spoken delivery, inclusive — the target a draft aims at. */
    targetSec: readonly [number, number];
    /**
     * The soft length warning (timing.out-of-range, never blocking) fires only
     * when the estimate is CLEARLY outside what Jordan accepts: under
     * warnBelowSec ("clearly under ~30 s") or over warnAboveSec ("sometimes a
     * minute" is fine; well past one is not). The ~5 s margins are there
     * because the seconds are an estimate from a word count, not a timing.
     */
    warnBelowSec: number;
    warnAboveSec: number;
    /** Drafting heuristic only — never proof of duration. targetSec × wordsPerSec, rounded. */
    heuristicWords: readonly [number, number];
    /** Manifest §4.3: the measured rate of natural spoken delivery, in words per second. */
    wordsPerSec: number;
    /** What counts as spoken (manifest §4.3 rule). */
    spokenParts: readonly string[];
    excludedParts: readonly string[];
  };
  topicsPerPillar: { default: number; min: number; max: number };
  qualityDimensions: typeof QUALITY_DIMENSIONS;
  hooks: {
    types: typeof HOOK_TYPES;
    bannedOpeners: readonly string[];
    weakPatterns: readonly string[];
    advisory: typeof ADVISORY_HOOK_RULES;
  };
  devices: typeof CREATIVE_DEVICES;
  excludedDoctrine: readonly string[];
  overrides: readonly string[];
  benchmarkWording: string;
  canonicalPresentation: string;
  /** The strategy template's four numbered sections, in order (manifest §3.1). */
  strategySections: readonly string[];
  /** Oct 12 2026: what a script may not contain, typographically. */
  punctuation: { noDashes: true; rule: string };
};

export const GENERATION_POLICY: GenerationPolicy = {
  version: GENERATION_POLICY_VERSION,
  talkingPoints: { count: 3, roles: TALKING_POINT_ROLES, specs: TALKING_POINT_ROLE_SPECS },
  timing: {
    targetSec: [TARGET_SEC[0], TARGET_SEC[1]],
    warnBelowSec: 25,
    warnAboveSec: 65,
    heuristicWords: [Math.round(TARGET_SEC[0] * WORDS_PER_SEC), Math.round(TARGET_SEC[1] * WORDS_PER_SEC)],
    wordsPerSec: WORDS_PER_SEC,
    spokenParts: ["hook", "talking points", "separately labelled spoken re-hook/payoff blocks (archive only)", "close"],
    excludedParts: ["title", "category", "labels", "stage directions", "filming notes", "production notes", "creative direction", "caption CTA"],
  },
  topicsPerPillar: { default: 10, min: 10, max: 15 },
  qualityDimensions: QUALITY_DIMENSIONS,
  hooks: { types: HOOK_TYPES, bannedOpeners: BANNED_OPENERS, weakPatterns: WEAK_HOOK_PATTERNS, advisory: ADVISORY_HOOK_RULES },
  devices: CREATIVE_DEVICES,
  excludedDoctrine: EXCLUDED_DOCTRINE,
  overrides: POLICY_OVERRIDES,
  benchmarkWording:
    "The archive is the benchmark for voice and specificity; structure and length come from the policy. Historical examples establish the client’s voice and style, the current policy controls the format.",
  canonicalPresentation: CANONICAL_SCRIPT_PRESENTATION,
  strategySections: ["1. Brand Overview", "2. Content Goals", "3. Content Pillars", "4. Video Structure Framework"],
  punctuation: { noDashes: true, rule: SCRIPT_PUNCTUATION_RULE },
};

// ---------------------------------------------------------------------------
// Assembled rules text for prompts (one string, deterministic).
// ---------------------------------------------------------------------------

/**
 * Oct 14 2026: the house brief, the standing rulings and the framework, with
 * no pasted GPT text to contradict them. Nothing in the assembled text uses an
 * em or en dash as punctuation (the framework and role lines are printed
 * "Heading: definition" here; videoStructureFrameworkLines keeps its own
 * shape for the strategy template).
 */
export function policyRulesText(policy: GenerationPolicy = GENERATION_POLICY): string {
  const roles = policy.talkingPoints.specs
    .map((s, i) => `Talking Point ${i + 1}: ${s.label}. ${s.definition}`)
    .join("\n");
  const dims = policy.qualityDimensions.map((d) => `- ${d.name} means ${d.means}.`).join("\n");
  const hookTypes = policy.hooks.types.map((h) => `- ${h.name}: ${h.note}`).join("\n");
  const devices = policy.devices.map((d) => `- ${d.name}: ${d.rule}`).join("\n");
  return [
    `GENERATION POLICY ${policy.version}`,
    "",
    "=== HOUSE SCRIPTING RULES (Realtour Pilot monthly personal-brand videos) ===",
    HOUSE_SCRIPTING_RULES,
    "",
    "=== STANDING RULINGS ===",
    ...policy.overrides.map((o) => `- ${o}`),
    "",
    "=== VIDEO STRUCTURE FRAMEWORK (the same for every client; a client document's own framework never replaces it) ===",
    FRAMEWORK_PREAMBLE,
    `${FRAMEWORK_HOOK.heading}: ${FRAMEWORK_HOOK.definition}`,
    ...policy.talkingPoints.specs.map((s) => `${s.frameworkHeading}: ${s.definition}`),
    `${FRAMEWORK_CLOSE.heading}: ${FRAMEWORK_CLOSE.definition}`,
    "",
    "=== TALKING POINT ROLES (the framework's three talking points) ===",
    roles,
    "",
    "=== TIMING ===",
    `Target ${policy.timing.targetSec[0]} to ${policy.timing.targetSec[1]} seconds of natural spoken delivery; about a minute is acceptable when the idea needs it. Drafting heuristic ${policy.timing.heuristicWords[0]} to ${policy.timing.heuristicWords[1]} spoken words at about ${policy.timing.wordsPerSec} words per second; ${policy.timing.heuristicWords[1]} is the ceiling. Count only: ${policy.timing.spokenParts.join("; ")}. Exclude: ${policy.timing.excludedParts.join("; ")}. Word count is a heuristic, not proof of duration; validate with a natural read. No duration overrides exist.`,
    "",
    "=== QUALITY DIMENSIONS (qualities to build, never categories, never a score) ===",
    dims,
    "",
    "=== HOOK TYPES ===",
    hookTypes,
    `Never open with a greeting or an introduction (for example ${policy.hooks.bannedOpeners.map((b) => `“${b}…”`).join(", ")}), and never introduce the agent by name (“I'm <name>…”, “My name is…”).`,
    `Weak shapes to avoid: ${policy.hooks.weakPatterns.map((b) => `“${b}…”`).join(", ")}. ${policy.hooks.advisory.noEngagementBait}`,
    "",
    "=== NAMED DEVICES (use only when authentic and suitable) ===",
    devices,
    "",
    "=== BENCHMARK ===",
    policy.benchmarkWording,
    "",
    "=== CANONICAL SCRIPT PRESENTATION ===",
    policy.canonicalPresentation,
    "",
    "=== PUNCTUATION (Jordan, Oct 12 2026) ===",
    policy.punctuation.rule,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Stable content hash (pure, no node:crypto so this file can be imported from
// client components). FNV-1a 64-bit over a key-sorted JSON serialisation.
// ---------------------------------------------------------------------------

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function fnv1a64Hex(input: string): string {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  const bytes = new TextEncoder().encode(input);
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Hash of the policy object PLUS the verbatim base text and assembled rules — any wording change moves it. */
export function computePolicyHash(policy: GenerationPolicy = GENERATION_POLICY): string {
  return fnv1a64Hex(stableStringify({ policy, base: SCRIPTING_GPT_INSTRUCTIONS_VERBATIM, rules: policyRulesText(policy) }));
}

export const GENERATION_POLICY_HASH = computePolicyHash();

/** True when a stored (version, hash) pair matches the code's policy exactly. */
export function verifyPolicyStamp(stamp: { policyVersion: string; policyHash: string }): { ok: boolean; reason: string | null } {
  if (stamp.policyVersion !== GENERATION_POLICY_VERSION) {
    return { ok: false, reason: `policy version ${stamp.policyVersion} differs from current ${GENERATION_POLICY_VERSION}` };
  }
  if (stamp.policyHash !== GENERATION_POLICY_HASH) {
    return { ok: false, reason: `policy hash ${stamp.policyHash} differs from current ${GENERATION_POLICY_HASH} (content changed without a version bump)` };
  }
  return { ok: true, reason: null };
}

/** What every generated bank / script carries (spec §27 "Record the policy version and approved strategy version"). */
export type PolicyStamp = {
  policyVersion: string;
  policyHash: string;
  strategyVersion: string | null;
};

export function policyStamp(strategyVersion: string | null): PolicyStamp {
  return { policyVersion: GENERATION_POLICY_VERSION, policyHash: GENERATION_POLICY_HASH, strategyVersion };
}

// ---------------------------------------------------------------------------
// Shared finding / gap shapes (C-A12: one machine-readable gap object; no
// free-text "No major missing info." sentinel anywhere).
// ---------------------------------------------------------------------------

export type Severity = "block" | "warn" | "info";

export type Finding = {
  code: string;
  severity: Severity;
  message: string;
  /** Where in the object the finding points (e.g. "points[3]", "hook", "pillars[2]"). */
  path?: string;
  /** Any measured numbers behind the finding, for the UI and for tests. */
  measured?: Record<string, number | string | boolean | null>;
};

export type GapKind =
  | "unsupported-claim" // the generator wanted to say something the sources do not back
  | "missing-answer" // an interview question was skipped / unanswered / "I don't know"
  | "placeholder" // a bracketed value the client or a third party must supply ($[PRICE])
  | "missing-source" // a document, transcript or answer set the step needed does not exist
  | "unverified-history" // filming / performance history is absent or unverified
  | "insufficient-context"; // bank / strategy could not reach the count or depth at the quality bar

export type Gap = {
  kind: GapKind;
  /** Which field the gap sits in (e.g. "points[2]", "evidence", "pillars[1].topics"). */
  field: string | null;
  /** What is missing or unsupported, in one sentence. */
  text: string;
  /** The targeted question that would close the gap, when one exists (spec §27: "a targeted question or a clearly marked gap"). */
  question: string | null;
};

export function makeGap(kind: GapKind, text: string, opts: { field?: string | null; question?: string | null } = {}): Gap {
  return { kind, field: opts.field ?? null, text, question: opts.question ?? null };
}

export function hasBlocking(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === "block");
}

// ---------------------------------------------------------------------------
// Word counting — the manifest's rule, used by the script estimator and the
// topic validator alike. A token counts if it contains a letter or digit, so a
// stand-alone ellipsis or dash does not count; `$[PRICE]` counts as one word.
// ---------------------------------------------------------------------------

export function countSpokenWords(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const tok of text.split(/\s+/)) {
    if (/[0-9A-Za-zÀ-ɏ]/.test(tok)) n += 1;
  }
  return n;
}
