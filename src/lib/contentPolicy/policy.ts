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
//   §9   Jordan's rulings — exactly three points, 20–30 s target, "archive =
//        voice, policy = format". There is deliberately NO duration override
//        field anywhere in this object. Do not add one.
//
// Pure data + pure functions. No DB, no AI, no I/O.
// ---------------------------------------------------------------------------

/** Bump on any change to the policy content below. Date-stamped, dot-serial. */
export const GENERATION_POLICY_VERSION = "2026-09-16.2";

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
// Rules text — the GPT system prompt is the BASE, verbatim (manifest §2.1).
// Where §27 / Jordan's rulings override it (exactly three points; caption CTA;
// dimensions not pillars) the override is stated in POLICY_OVERRIDES below and
// wins. The verbatim text is kept whole so the archive's origin stays legible.
// ---------------------------------------------------------------------------

export const SCRIPTING_GPT_INSTRUCTIONS_VERBATIM = `You are an elite short-form real estate personal branding script strategist for Realtour Pilot.

Your job is to turn strategy call transcripts, past scripts, content strategy documents, hook examples, and scripting reference materials into high-performing 20 to 30 second personal branding video scripts for real estate agents.

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
4. Turn the best topics into 20 to 30 second scripts.
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
- Keep scripts within 20 to 30 seconds.
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
 * Where the current policy overrides the verbatim GPT text. These are the
 * rulings (manifest §7 C-A1…A7 + §9). Each line is authoritative over the base.
 */
export const POLICY_OVERRIDES: readonly string[] = [
  "TALKING POINTS: exactly three, never “3 to 4”. Roles in order: Talking Point 1 = Re-hook, Talking Point 2 = Build up, Talking Point 3 = Payoff. The four-slot SCRIPT FORMAT above is historical; the canonical output format is the one in CANONICAL SCRIPT PRESENTATION below.",
  "LENGTH: spoken content targets 20–30 seconds of natural delivery. Roughly 45–65 spoken words is a drafting heuristic, not proof of duration. There is no per-client, per-session or per-script duration override. Tighten rather than force rapid delivery.",
  "CLOSE: the close is a memorable takeaway or a natural invitation that lands with authority. A direct contact CTA (“DM me PLAN”) belongs in the optional caption CTA, not in the spoken close, when that better fits the strategy.",
  "TRUST / VALUE / CREDIBILITY / ENTERTAINMENT are quality dimensions built through the actual content of every video. They are not topic categories and not a scoring rubric. The CONTENT PILLAR CHECK block is internal reviewer metadata only — one line per dimension, never a number, never client-visible.",
  "ARCHIVE = VOICE, POLICY = FORMAT: historical examples establish the client’s voice and style, but the current policy controls the format. Older scripts with four talking points, and any script longer than 30 seconds, do not override the three-point, 20–30-second requirement. (Jordan, Sep 16 2026: “historical examples establish your voice and style, but your current instructions control the format. Older scripts with four talking points should not override your requirement for three points and 20–30 seconds.”)",
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

/** Hook types the policy names: the GPT's four + Arielle §4 + the spec's devices. */
export const HOOK_TYPES: readonly { name: string; source: string; note: string }[] = [
  { name: "Contrarian statement", source: "GPT", note: "Say the opposite of what the viewer assumes." },
  { name: "Strong opinion", source: "GPT", note: "A stance the agent will defend on camera." },
  { name: "Surprising truth", source: "GPT", note: "A fact or consequence the viewer did not expect." },
  { name: "Emotional or status-driven framing", source: "GPT", note: "Frame the stakes in identity, money, or pride." },
  {
    name: "Specific concern, misconception, or surprising observation",
    source: "Arielle §4",
    note: "Immediately relevant to a buyer or seller; give viewers a reason to keep watching.",
  },
  { name: "Comparative positioning", source: "spec §27 / Scripting Success §4", note: "Why this over that — used only when authentic." },
  {
    name: "Affluence through association",
    source: "spec §27 / Anatomy §4",
    note: "Tie the idea to a culturally or locally significant reference; never a false affiliation.",
  },
  {
    name: "Pattern interruption / genuine surprise (“WTF effect”)",
    source: "spec §27 / Anatomy §5",
    note: "Genuine surprise or curiosity — not invented claims, forced profanity, or false affiliations.",
  },
];

/**
 * Openers that fail a NEW script outright (GPT rule + Anatomy §6 “Welcome” sin +
 * spec “No greetings or introductions”). Phrase forms only — the bare words
 * (“Welcome mats…”, “Hi-rise…”, “Hello Kitty…”) are judged by shape in
 * scriptFormat.ts so a legitimate hook that merely starts with one is not rejected.
 */
export const BANNED_OPENERS: readonly string[] = ["Hi, I'm", "Hi I'm", "Hi, I am", "Hello, I'm", "Hello I'm", "Hey guys", "Hey everyone", "Hi everyone", "Hello everyone", "Welcome back", "Welcome to"];

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

/** Named devices the spec invokes, each tagged with its listing-video origin and the “only when authentic” caveat. */
export const CREATIVE_DEVICES: readonly { name: string; source: string; rule: string }[] = [
  { name: "Re-hook", source: "Anatomy §3, §9", rule: "Re-engage the audience midway with another compelling statement; keep viewers engaged throughout." },
  { name: "Middle context", source: "Anatomy §1 / Scripting Success §7", rule: "Provide relevant details while maintaining engagement; connect the beginning and end seamlessly." },
  { name: "Storytelling", source: "Scripting Success §5", rule: "The most impactful videos tell a story." },
  { name: "Bold statement", source: "Scripting Success §3", rule: "The bolder the statement, the more memorable the video — used only when the agent means it." },
  { name: "Affluence through association", source: "Anatomy §4", rule: "Tie the idea to culturally or locally significant references to add perceived value; never a false affiliation." },
  { name: "WTF effect", source: "Anatomy §5 (narrowed by spec §27)", rule: "Genuine surprise or curiosity, not invented claims, forced profanity, or false affiliations." },
  { name: "Scripting sins", source: "Anatomy §6", rule: "No “Welcome”, no introducing the agent by name, no highlighting obvious features, no clichés." },
  { name: "Pattern utilization", source: "Anatomy §7", rule: "Recognize successful scripting patterns, adapt them, then develop a unique style." },
  { name: "Viral cheat codes", source: "Anatomy §9", rule: "Replicate successful frameworks while adding the client’s own touch." },
  { name: "Scripting to edit", source: "Anatomy §8", rule: "Anticipate the edit: smooth transitions, impactful visuals." },
  { name: "Comparative hook prompt", source: "Scripting Success §4 / Anatomy §11", rule: "Ask why someone should choose this over that; use the defensive answer as the narrative." },
  { name: "Agent on camera immediately", source: "Scripting Success §2", rule: "The agent’s face and voice from the first moment; no establishing shots first." },
  { name: "Spoken rhythm", source: "Plans §12/§7", rule: "Write for spoken rhythm, not reading: short sentences, fragments, pauses, breathing room." },
  { name: "Show your face / authentic story / polarization", source: "10 Laws #1, #2, #4, #9", rule: "Be visible, be bold about beliefs and experiences, accept that strong opinions polarize." },
];

/** Not adopted for personal-branding scripts; recorded so nobody re-imports them (C-A4, C-A11, PREM §21). */
export const EXCLUDED_DOCTRINE: readonly string[] = [
  "Scripting Success §10 / Anatomy §1: a spoken transactional CTA (“Send me a message for a private tour”) — listing-video doctrine; the contact ask lives in the caption.",
  "Scripting Automation Plan / Premium Reel Plan: 11-word hook cap and the eight reel archetypes — stay in the premium-reel prompt library.",
  "Scripting Success §6 voiceover ban vs Premium plan voiceover allowance — out of scope; personal-branding scripts are agent-led.",
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
    /** Seconds of natural spoken delivery, inclusive. */
    targetSec: readonly [number, number];
    /** Drafting heuristic only — never proof of duration. */
    heuristicWords: readonly [number, number];
    /** Manifest §4.3: the rate implied by 45–65 words ≈ 20–30 s. */
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
};

export const GENERATION_POLICY: GenerationPolicy = {
  version: GENERATION_POLICY_VERSION,
  talkingPoints: { count: 3, roles: TALKING_POINT_ROLES, specs: TALKING_POINT_ROLE_SPECS },
  timing: {
    targetSec: [20, 30],
    heuristicWords: [45, 65],
    wordsPerSec: 2.2,
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
};

// ---------------------------------------------------------------------------
// Assembled rules text for prompts (one string, deterministic).
// ---------------------------------------------------------------------------

export function policyRulesText(policy: GenerationPolicy = GENERATION_POLICY): string {
  const roles = policy.talkingPoints.specs
    .map((s, i) => `Talking Point ${i + 1}: ${s.label} — ${s.definition}`)
    .join("\n");
  const dims = policy.qualityDimensions.map((d) => `- ${d.name} means ${d.means}.`).join("\n");
  const hookTypes = policy.hooks.types.map((h) => `- ${h.name} (${h.source}): ${h.note}`).join("\n");
  const devices = policy.devices.map((d) => `- ${d.name} [${d.source}]: ${d.rule}`).join("\n");
  return [
    `GENERATION POLICY ${policy.version}`,
    "",
    "=== BASE RULES (Realtour Pilot Content Scripting GPT – System Instructions, verbatim) ===",
    SCRIPTING_GPT_INSTRUCTIONS_VERBATIM,
    "",
    "=== CURRENT POLICY OVERRIDES (these win over the base text above) ===",
    ...policy.overrides.map((o) => `- ${o}`),
    "",
    "=== TALKING POINT ROLES (Arielle §4, verbatim) ===",
    roles,
    "",
    "=== TIMING ===",
    `Target ${policy.timing.targetSec[0]}–${policy.timing.targetSec[1]} seconds of natural spoken delivery. Drafting heuristic ${policy.timing.heuristicWords[0]}–${policy.timing.heuristicWords[1]} spoken words at about ${policy.timing.wordsPerSec} words per second. Count only: ${policy.timing.spokenParts.join("; ")}. Exclude: ${policy.timing.excludedParts.join("; ")}. Word count is a heuristic, not proof of duration; validate with a natural read. No duration overrides exist.`,
    "",
    "=== QUALITY DIMENSIONS (never categories, never a score) ===",
    dims,
    "",
    "=== HOOK TYPES ===",
    hookTypes,
    `Never open with a greeting or an introduction — e.g. ${policy.hooks.bannedOpeners.map((b) => `“${b}…”`).join(", ")} — and never introduce the agent by name (“I'm <name>…”, “My name is…”).`,
    `Weak shapes to avoid: ${policy.hooks.weakPatterns.map((b) => `“${b}…”`).join(", ")}.`,
    `Advisory (listing-reel origin, warn only): avoid ${policy.hooks.advisory.bannedWords.join(", ")}; ${policy.hooks.advisory.oneBreathTest} ${policy.hooks.advisory.noEngagementBait}`,
    "",
    "=== NAMED DEVICES (use only when authentic and suitable) ===",
    devices,
    "",
    "=== BENCHMARK ===",
    policy.benchmarkWording,
    "",
    "=== CANONICAL SCRIPT PRESENTATION ===",
    policy.canonicalPresentation,
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
