// ---------------------------------------------------------------------------
// The strategy template (Arielle Roemer Team 2026 Content Strategy, manifest
// §3.1 with the §3.2 corrections) as a typed structure, plus:
//   parseStrategyDocument(text)  — reads S1 / S2 / S3 archive strategies by
//                                  NUMERIC PREFIX, never by Word style (C-B5),
//                                  keeping the source's own headings and order
//                                  (spec §3: never force an abbreviated template);
//   renderStrategy(doc)          — writes a strategy in the template's numbering;
//   validateStrategyStructure()  — reports present / missing template sections.
//                                  Never blocks (C-B6).
//
// ONE FRAMEWORK FOR EVERY CLIENT (Jordan, Oct 6 2026): "the video structure
// framework should be the same for each client". POLICY_DEFAULT_FRAMEWORK is
// the only Video Structure Framework the hub shows or feeds to a model. An
// imported document keeps its own section 4 in the stored version (versions
// are immutable), but every reader swaps it for the canonical one at read
// time — renderStrategy, canonicalFrameworkSectionText (the staff view) and
// withCanonicalFramework (the document a prompt is built from). The only
// thing kept from a document's own framework is genuinely client-specific
// direction — its delivery note ("Style: …", a "Visual and Delivery Style"
// block) plus the client-specific sentences written inside its own parts
// (Jordan, Oct 6 2026: "Yes"; see frameworkStyleNotesFromText) — shown apart
// as one "Client style notes" line, never as a framework part, and never with
// a video length in it.
//
// Pure. No DB, no AI.
// ---------------------------------------------------------------------------

import { type Finding, type TalkingPointRole, TALKING_POINT_ROLE_SPECS, QUALITY_DIMENSIONS, FRAMEWORK_PREAMBLE, FRAMEWORK_HOOK, FRAMEWORK_CLOSE } from "./policy";

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

export type TemplateField = { key: string; label: string; optional: boolean; note?: string };

export const STRATEGY_TEMPLATE = {
  /** `<Title>` two-line title: client name / "<year> Social Content Strategy". */
  titleSuffix: "Social Content Strategy",
  /** `<Subtitle>` on every S3 document and Bernadette's S1 (C-B3). */
  subtitle: "Built around Trust, Value, Credibility, and Entertainment",
  sections: [
    {
      id: "brand-overview",
      number: 1,
      heading: "Brand Overview",
      fields: [
        { key: "coreValues", label: "Core Values", optional: false },
        { key: "brandMessage", label: "Brand Message", optional: false },
        { key: "shortBrandStatement", label: "Short Brand Statement", optional: true, note: "PDF-Final / Mike / Kristin final (C-B3)" },
        { key: "brandVoice", label: "Brand Voice", optional: false },
      ] as TemplateField[],
      subsection: {
        id: "target-audience",
        heading: "Target Audience",
        fields: [
          { key: "primaryServiceAreas", label: "Primary service areas", optional: false },
          { key: "pricePositioning", label: "Price positioning", optional: true, note: "where supported" },
          { key: "primaryClientTypes", label: "Primary client types", optional: false },
          { key: "longTermPositioningGoal", label: "Long-term positioning goal", optional: false },
        ] as TemplateField[],
      },
    },
    { id: "content-goals", number: 2, heading: "Content Goals", body: "bullets; one time-bound goal when supplied" },
    {
      id: "content-pillars",
      number: 3,
      heading: "Content Pillars",
      preamble:
        "Every video should build Trust through empathy and honesty, provide Value through a useful takeaway, establish Credibility through experience and clear reasoning, and create Entertainment through curiosity, storytelling, visual interest, or natural personality.",
      pillarHeading: "Pillar {n}: {name}",
      pillarFields: [
        { key: "purpose", label: "Purpose", optional: false },
        { key: "focusAreas", label: "Focus Areas", optional: false },
        { key: "contentApproach", label: "Content Approach", optional: true, note: "Mike's strategy (§3.2)" },
      ] as TemplateField[],
    },
    {
      id: "video-structure-framework",
      number: 4,
      heading: "Video Structure Framework",
      parts: ["Hook", "Talking Point 1 - Rehook", "Talking Point 2 - Build Up", "Talking Point 3 - Payoff", "Close / Call to Action"],
      subsections: ["Caption CTA Examples", "Strategic Direction"],
    },
  ],
} as const;

export const STRATEGY_SECTION_IDS = ["brand-overview", "content-goals", "content-pillars", "video-structure-framework"] as const;
export type StrategySectionId = (typeof STRATEGY_SECTION_IDS)[number];

export type FrameworkPartKey = "hook" | "tp1" | "tp2" | "tp3" | "close" | "context" | "payoff" | "other";

export type FrameworkPart = {
  key: FrameworkPartKey;
  /** Heading as written in the source (or the template heading for a new doc). */
  heading: string;
  /** S1 timing annotation such as "(0–3s)", kept as source text; never a duration rule. */
  timing: string | null;
  text: string;
  role: TalkingPointRole | null;
};

/**
 * THE Video Structure Framework — the same for every client (Jordan, Oct 6
 * 2026, wording verbatim; Arielle §4 plus "bold statement" in the Hook). Every
 * strategy shows and prompts with this, whatever an imported document's own
 * section 4 says. The name is historical (it was once only the fallback).
 */
export const POLICY_DEFAULT_FRAMEWORK: { preamble: string; parts: FrameworkPart[] } = {
  preamble: FRAMEWORK_PREAMBLE,
  parts: [
    { key: "hook", heading: FRAMEWORK_HOOK.heading, timing: null, role: null, text: FRAMEWORK_HOOK.definition },
    { key: "tp1", heading: TALKING_POINT_ROLE_SPECS[0].frameworkHeading, timing: null, role: "re-hook", text: TALKING_POINT_ROLE_SPECS[0].definition },
    { key: "tp2", heading: TALKING_POINT_ROLE_SPECS[1].frameworkHeading, timing: null, role: "build-up", text: TALKING_POINT_ROLE_SPECS[1].definition },
    { key: "tp3", heading: TALKING_POINT_ROLE_SPECS[2].frameworkHeading, timing: null, role: "payoff", text: TALKING_POINT_ROLE_SPECS[2].definition },
    { key: "close", heading: FRAMEWORK_CLOSE.heading, timing: null, role: null, text: FRAMEWORK_CLOSE.definition },
  ],
};

/**
 * The Video Structure Framework of a NEW strategy (A08, Sep 25 2026). A draft
 * the hub writes carries the policy's framework as its own section 4 — the
 * Arielle / Kristin / Mike documents all have one — so the renderer prints it
 * like any client document's. The drafter used to pass `framework: null`,
 * which made every AI draft read "(framework: policy default — the client
 * document defines none)": an annotation meant for an IMPORTED document that
 * lacks one (Rick), sitting in Jordan's draft and its stored text.
 */
export function policyFrameworkSection(): NonNullable<StrategyDocument["framework"]> {
  return {
    heading: STRATEGY_TEMPLATE.sections[3].heading,
    preamble: [POLICY_DEFAULT_FRAMEWORK.preamble],
    parts: POLICY_DEFAULT_FRAMEWORK.parts.map((p) => ({ ...p })),
    style: null,
    otherFields: [],
  };
}

// ---------------------------------------------------------------------------
// The canonical framework at READ time (Oct 6 2026). Stored versions are never
// rewritten; these swap a document's own section 4 for the house framework
// wherever a strategy is shown or handed to a model.
// ---------------------------------------------------------------------------

/** The one label a document's own delivery notes are shown under. */
export const CLIENT_STYLE_NOTES_LABEL = "Client style notes";

/** "Caption CTA Examples" / "Strategic Direction" (or "Strategic Note") — the client-specific tail of section 4, kept verbatim. */
const FRAMEWORK_TAIL_RE = /^(?:caption cta examples?|strategic (?:direction|note)s?)\b\s*:?/i;
/** Where a document's own delivery note starts: "Style: …" (Mike), a "Visual and Delivery Style" heading (Janice), or our own label. */
const STYLE_START_RE = /^(?:client style notes|(?:visual|delivery)(?:\s+(?:and|&)\s+(?:visual|delivery))?\s+style|style)\s*(?::\s*(.*))?$/i;

/** True for a stored / parsed section that holds the Video Structure Framework ("4. Video Structure Framework", "4 Video Structure Framework", a legacy key). */
export function isFrameworkSection(s: { id?: string | null; heading: string }): boolean {
  if (s.id === "video-structure-framework") return true;
  const h = s.heading.trim().replace(/^\d{1,2}[.)]?\s+/, "").replace(/:$/, "").trim();
  return /^(video )?(structure )?framework$|^video structure$/i.test(h);
}

/** The canonical framework as section text: preamble, then each part's heading and definition. */
export function canonicalFrameworkText(): string {
  const out: string[] = [POLICY_DEFAULT_FRAMEWORK.preamble];
  for (const p of POLICY_DEFAULT_FRAMEWORK.parts) out.push("", p.heading, p.text);
  return out.join("\n");
}

const tidyNote = (s: string) => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// CLIENT-SPECIFIC DIRECTION INSIDE A DOCUMENT'S OWN FRAMEWORK (Jordan, Oct 6
// 2026: "Yes" — keep it). Imported documents wrote some client direction INTO
// their framework parts ("No gimmicks, no dancing, and no forced trends." in a
// Hook; "Show <client> making a decision…" in a preamble; "Deliver the value in
// <client>'s voice: …" in an S1 Payoff). The parts themselves are replaced by
// the house framework, so that direction is carried into the Client style
// notes line instead — at READ time; no stored version is rewritten.
//
// The rule is deterministic (no AI). Each sentence of the document's own
// preamble and parts is scored:
//   1. The client's own name (any capitalised word the section uses in the
//      possessive — "Erica's approach") is read as "the team", so a part that
//      only swaps the team for the client's name stays generic.
//   2. KEEP if it carries a client-specific signal:
//        a do / don't         — no, never, avoid, don't, do not, without;
//        a voice descriptor   — "voice: smart, witty…" / "voice (fun, …)";
//        a proper noun        — a place or name other than the client's own
//                               ("Main Line", "Lehigh Valley", "Chesterbrook");
//        what to show         — "show / film / feature / capture <client>".
//   3. Otherwise KEEP only if at least half of its content words are NOT in
//      the framework vocabulary — the house definitions plus
//      GENERIC_FRAMEWORK_WORDS, the words the generic template wording found
//      in the imported documents is written in (S1 "Strong, direct, and
//      attention-grabbing… Keep it practical, structured…", the S3 variants).
//      A sentence that merely restates what a hook / talking point / close is
//      is made of those words and is dropped.
//   4. Timings never travel: "(0–3s)" sits in a heading (not read), and any
//      duration phrase ("Usually 30–60 seconds", "under a minute") is removed
//      from every kept sentence AND from the document's own style note —
//      length is not a per-client note ("video length varies for all
//      clients… I don't think that's important to note anywhere", Oct 6 2026).
// A sentence that is ONLY a duration is dropped.
// ---------------------------------------------------------------------------

/**
 * The words generic framework definitions are written in, beyond the house
 * definitions themselves (which are always included). Stems (see stemWord).
 * Collected from the generic template wording of the imported strategy
 * documents (Oct 6 2026 probe of every active enrollment's latest version) —
 * structural vocabulary only, no client wording.
 */
const GENERIC_FRAMEWORK_WORDS =
  "add answer attention beginn better build callback captur catch client complication confident decision different direct easier easy end experienc explain explanation four frustration fuller grabb guidanc homeowner insight instant intend languag leav lesson local make new post problem process punchlin put quick rather real recognizabl refram relatabl reminder repeat rest serv set show simpl solv spoken stak start stay step strategy strong stronger structur subject thoughtful truth turn unexpect up use valu video visibl visual voic want worth wrap";

const STOP_WORDS = new Set(
  ("a an the and or of to in on for with that this these those it its is are be been being as at by from what why how who whom when where which there their them they your you we our us i me my he she his her him each every one another more most should can could will would may might must into while than so but if then also just only very any some such about because through whether not no never team s").split(" "),
);

function stemWord(raw: string): string {
  let w = raw.toLowerCase().replace(/['’]s$/, "").replace(/['’]/g, "");
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ly")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

function contentStems(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z'’]*/g) ?? [])
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()))
    .map(stemWord)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

let frameworkVocabCache: Set<string> | null = null;
function frameworkVocabulary(): Set<string> {
  if (frameworkVocabCache) return frameworkVocabCache;
  const house = [FRAMEWORK_PREAMBLE, FRAMEWORK_HOOK.definition, FRAMEWORK_CLOSE.definition, ...TALKING_POINT_ROLE_SPECS.map((s) => s.definition)].join(" ");
  frameworkVocabCache = new Set([...contentStems(house), ...GENERIC_FRAMEWORK_WORDS.split(/\s+/).filter(Boolean)]);
  return frameworkVocabCache;
}

/** Capitalised words that are part of the framework's own vocabulary, never a client signal. */
const STRUCTURAL_CAPS = new Set(["Hook", "Talking", "Point", "Rehook", "Re-hook", "Build", "Up", "Payoff", "Close", "Call", "Action", "Context", "CTA", "CTAs", "DM", "DMs", "I", "Video", "Structure", "Framework"]);
const DONT_RE = /\b(?:no|never|avoid|don['’]t|do not|without)\b/i;
const VOICE_DESCRIPTOR_RE = /\bvoice\s*(?::|\()/i;

/** Duration phrases — "30–60 seconds", "(0–3s)", "a 45-second video", "Usually … seconds, with", "under a minute". */
const DURATION_RE =
  /\b(?:(?:usually|typically|generally|ideally|often|about|around|roughly|approximately|under|over|up to|at least|at most|no (?:more|longer) than|between|aim(?:ing)? for|keep(?:ing)? (?:it|them|each video|videos|reels?)(?: to| at| under| around| between)?)\s+)*(?:(?:\d+(?:\.\d+)?\s*(?:[–—-]|to|and)\s*)?\d+(?:\.\d+)?\s*-?\s*(?:s|secs?|seconds?|mins?|minutes?)\b|(?:a|one|half a)[\s-]minute\b)(?:\s+long)?/gi;

/** A sentence with every duration phrase removed, tidied; null when nothing but a duration was said. */
export function stripDurationPhrases(sentence: string): string | null {
  const MARK = "\u0000";
  let s = sentence.replace(DURATION_RE, MARK);
  if (!s.includes(MARK)) return tidyNote(sentence) || null;
  s = s.replace(/\(\s*\u0000\s*\)/g, "");
  // Leading: "Usually 30–60 seconds, with a mix of …" → "A mix of …".
  s = s.replace(/^\s*\u0000[\s,;:–—-]*(?:with|and)?\s*/i, "");
  s = s.replace(/[\s,;:]*\u0000[\s,;:]*(?=[.!?]?\s*$)/g, "");
  s = s.replace(/\s*,?\s*\u0000\s*,?\s*/g, " ");
  s = tidyNote(s).replace(/\s+([,.;:!?])/g, "$1").replace(/^[,;:\s]+/, "").replace(/[,;:\s]+$/, "");
  if (contentStems(s).length < 2) return null;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?]["”’)]?$/.test(s)) s = `${s}.`;
  return s;
}

/** Sentences of a paragraph (PDF line wraps already joined). */
function splitSentences(text: string): string[] {
  return tidyNote(text)
    .split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Capitalised words that take an apostrophe-s without being anyone's name ("Let's", "Today's"). */
const NOT_NAMES = new Set(["let", "here", "today", "tomorrow", "everyone", "someone", "nobody", "year", "week", "month", "season", "market", "home", "buyer", "seller"]);

/** The client's own name(s): capitalised words the section uses in the possessive ("Erica's approach"). */
function clientNamesIn(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]+)['’]s\b/g)) {
    const w = m[1];
    if (STRUCTURAL_CAPS.has(w) || STOP_WORDS.has(w.toLowerCase()) || NOT_NAMES.has(w.toLowerCase())) continue;
    names.add(w);
  }
  return [...names];
}

export type FrameworkSentenceVerdict = { sentence: string; kept: string | null; reason: string };

/** Classify one sentence of a document's own framework (exported for drills and the probe). */
export function classifyFrameworkSentence(sentence: string, clientNames: readonly string[]): FrameworkSentenceVerdict {
  const nameRe = clientNames.length ? new RegExp(`\\b(?:${clientNames.join("|")})(?:['’]s)?\\b`, "g") : null;
  const generic = nameRe ? sentence.replace(nameRe, "the team") : sentence;
  const kept = () => stripDurationPhrases(sentence);
  if (DONT_RE.test(generic)) return { sentence, kept: kept(), reason: "do/don't" };
  if (VOICE_DESCRIPTOR_RE.test(generic)) return { sentence, kept: kept(), reason: "voice descriptor" };
  if (clientNames.length && new RegExp(`\\b(?:show|film|feature|capture)\\s+(?:${clientNames.join("|")})\\b`, "i").test(sentence)) return { sentence, kept: kept(), reason: "what to show" };
  const words = generic.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  const proper = words.slice(1).filter((w) => /^[A-Z]/.test(w) && !STRUCTURAL_CAPS.has(w.replace(/['’]s$/, "")));
  if (proper.length) return { sentence, kept: kept(), reason: `proper noun (${proper.join(", ")})` };
  const stems = contentStems(generic);
  if (!stems.length) return { sentence, kept: null, reason: "no content" };
  const vocab = frameworkVocabulary();
  const novel = stems.filter((w) => !vocab.has(w));
  const share = novel.length / stems.length;
  if (share >= 0.5) return { sentence, kept: kept(), reason: `novel ${novel.length}/${stems.length} (${novel.join(" ")})` };
  return { sentence, kept: null, reason: `generic ${stems.length - novel.length}/${stems.length}` };
}

/** Client-specific direction from a document's own framework preamble + part paragraphs, in order, timings removed. */
function frameworkDirection(paragraphs: readonly string[], allText: string): string[] {
  const names = clientNamesIn(allText);
  const out: string[] = [];
  for (const p of paragraphs) {
    for (const s of splitSentences(p)) {
      const v = classifyFrameworkSentence(s, names);
      if (v.kept) out.push(v.kept);
    }
  }
  return out;
}

/** A style note with its duration phrases removed (sentence by sentence; null if nothing else was said). */
function styleWithoutDurations(note: string): string | null {
  const kept = splitSentences(note).map(stripDurationPhrases).filter((s): s is string => !!s);
  return kept.length ? kept.join(" ") : null;
}

/**
 * Every sentence of a framework section's own preamble and parts with its
 * verdict — for the probe and the drills. The style note is not classified
 * (it is client direction by definition), only stripped of durations.
 */
export function explainFrameworkDirection(text: string): FrameworkSentenceVerdict[] {
  const { paragraphs } = splitFrameworkText(text);
  const names = clientNamesIn(text);
  return paragraphs.flatMap((p) => splitSentences(p).map((s) => classifyFrameworkSentence(s, names)));
}

/** A framework section's text split into body paragraphs (preamble, each part — headings and timings excluded) and the style note. */
function splitFrameworkText(text: string): { paragraphs: string[]; style: string[] } {
  const paragraphs: string[] = [];
  const style: string[] = [];
  let cur: string[] = [];
  let mode: "body" | "style" = "body";
  const flush = () => {
    if (cur.length) paragraphs.push(cur.join(" "));
    cur = [];
  };
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const t = raw.trim();
    if (FRAMEWORK_TAIL_RE.test(t)) break;
    const m = STYLE_START_RE.exec(t);
    if (m) {
      flush();
      mode = "style";
      if (m[1]?.trim()) style.push(m[1].trim());
      continue;
    }
    const fp = FRAMEWORK_PART_RE.exec(t);
    if (fp) {
      flush();
      mode = "body";
      if (fp[4]?.trim()) cur.push(fp[4].trim());
      continue;
    }
    if (mode === "style") {
      if (t) style.push(t);
      continue;
    }
    if (!t) { flush(); continue; }
    cur.push(t);
  }
  flush();
  return { paragraphs, style };
}

/**
 * The client-specific notes inside a framework section's TEXT, or null: the
 * client direction carried in its own preamble and parts (the rule above),
 * then its "Style: …" line or "… Style" block up to the next framework part or
 * the Caption CTA / Strategic Direction tail — all with durations removed.
 * The parts themselves, their timings ("Hook (0–3s)") and generic wording are
 * not notes — they are replaced by the house framework.
 */
export function frameworkStyleNotesFromText(text: string): string | null {
  const { paragraphs, style } = splitFrameworkText(text);
  const notes = [...frameworkDirection(paragraphs, text)];
  const s = style.length ? styleWithoutDurations(style.join(" ")) : null;
  if (s) notes.push(s);
  const joined = tidyNote(notes.join(" "));
  return joined || null;
}

/** The same notes from a PARSED framework (preamble + parts, then its Style field and any other labelled field). */
export function frameworkStyleNotesFromDocument(fw: StrategyDocument["framework"]): string | null {
  if (!fw) return null;
  const paragraphs = [fw.preamble.join(" "), ...fw.parts.map((p) => p.text)].filter((p) => p.trim());
  const allText = [...paragraphs, fw.style ?? "", ...fw.otherFields.map((f) => f.value)].join(" ");
  const parts: string[] = [...frameworkDirection(paragraphs, allText)];
  const styleBits: string[] = [];
  if (fw.style?.trim()) styleBits.push(fw.style.trim());
  for (const f of fw.otherFields) {
    const v = f.value.trim();
    if (!v) continue;
    styleBits.push(!f.label || STYLE_START_RE.test(`${f.label}:`) ? v : `${f.label}: ${v}`);
  }
  const s = styleBits.length ? styleWithoutDurations(styleBits.join(" ")) : null;
  if (s) parts.push(s);
  const joined = tidyNote(parts.join(" "));
  return joined || null;
}

/**
 * A framework section's text with the house framework in place of the
 * document's own: canonical preamble + five parts, then the document's
 * delivery note (if any) as one "Client style notes:" line, then its Caption
 * CTA Examples / Strategic Direction verbatim. Idempotent — the output read
 * again gives itself, so saving an edit of this text stores the same thing.
 */
export function canonicalFrameworkSectionText(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const tailAt = lines.findIndex((l) => FRAMEWORK_TAIL_RE.test(l.trim()));
  const tail = tailAt >= 0 ? lines.slice(tailAt).join("\n").trim() : "";
  const notes = frameworkStyleNotesFromText(text);
  const out = [canonicalFrameworkText()];
  if (notes) out.push("", `${CLIENT_STYLE_NOTES_LABEL}: ${notes}`);
  if (tail) out.push("", tail);
  return out.join("\n");
}

/**
 * Stored sections with the house framework in place (the staff Strategy view,
 * the revision prompt). A strategy whose document has no framework section
 * (Rick, S2) gets one, after Content Pillars, marked `canonical: true` so the
 * view can show it without offering to edit a section that is not stored.
 */
export function withCanonicalFrameworkSections<T extends { id: string; heading: string; text: string }>(sections: T[]): (T & { canonical?: boolean })[] {
  if (!sections.length) return sections;
  let found = false;
  const out: (T & { canonical?: boolean })[] = sections.map((s) => {
    if (!isFrameworkSection(s)) return s;
    found = true;
    return { ...s, text: canonicalFrameworkSectionText(s.text) };
  });
  if (found) return out;
  // Only a strategy document gets one — a single "Document" block (no numbered sections) is left alone.
  if (!sections.some((s) => /content pillars?$/i.test(s.heading.trim()) || s.id === "content-pillars")) return out;
  const after = out.findIndex((s) => /content pillars?$/i.test(s.heading.trim()) || s.id === "content-pillars");
  const numbered = /^\d/.test(out[after]?.heading.trim() ?? "");
  const synthetic = { ...out[after], id: "video-structure-framework", heading: `${numbered ? "4. " : ""}${STRATEGY_TEMPLATE.sections[3].heading}`, text: canonicalFrameworkText(), canonical: true } as T & { canonical?: boolean };
  out.splice(after + 1, 0, synthetic);
  return out;
}

/**
 * A parsed strategy with the house framework in place of its own. Its style
 * note comes from the framework section's verbatim TEXT when the caller has it
 * (an older parse could glue a "Style:" note's later lines onto the Close), or
 * else from the parsed framework.
 */
export function withCanonicalFramework<D extends StrategyDocument>(doc: D, frameworkSectionText?: string | null): D {
  const style = frameworkSectionText != null ? frameworkStyleNotesFromText(frameworkSectionText) : frameworkStyleNotesFromDocument(doc.framework);
  return { ...doc, framework: { ...policyFrameworkSection(), heading: doc.framework?.heading ?? STRATEGY_TEMPLATE.sections[3].heading, style } };
}

// ---------------------------------------------------------------------------
// Document shapes
// ---------------------------------------------------------------------------

export type ParsedField = { label: string; key: string | null; value: string; line: number };

export type StrategyPillar = {
  number: number | null;
  name: string;
  /** Heading as written ("Pillar 1: Seller Strategy & Listing Positioning", "Pillar 1 Seller Strategy and…"). */
  heading: string;
  purpose: string | null;
  focusAreas: string | null;
  contentApproach: string | null;
  otherFields: ParsedField[];
};

export type StrategyStructureVersion = "S1" | "S2" | "S3" | "unknown";

/** The canonical shape a NEW strategy is generated into and rendered from. */
export type StrategyDocument = {
  clientName: string | null;
  year: number | null;
  subtitle: string | null;
  brandOverview: {
    coreValues: string | null;
    brandMessage: string | null;
    shortBrandStatement: string | null;
    brandVoice: string | null;
    otherFields: ParsedField[];
    paragraphs: string[];
  };
  targetAudience: {
    present: boolean;
    heading: string | null;
    primaryServiceAreas: string | null;
    pricePositioning: string | null;
    primaryClientTypes: string | null;
    longTermPositioningGoal: string | null;
    otherFields: ParsedField[];
    paragraphs: string[];
  };
  contentGoals: { heading: string | null; items: string[]; numbered: boolean };
  contentPillars: { heading: string | null; preamble: string[]; pillars: StrategyPillar[] };
  framework: { heading: string | null; preamble: string[]; parts: FrameworkPart[]; style: string | null; otherFields: ParsedField[] } | null;
  captionCtaExamples: { heading: string; items: string[] } | null;
  strategicDirection: { heading: string; paragraphs: string[] } | null;
  otherSections: { heading: string; number: number | null; lines: string[] }[];
};

export type ParsedSection = { id: string; number: number | null; heading: string; order: number; line: number };

export type ParsedStrategy = StrategyDocument & {
  title: string;
  titleLines: string[];
  structureVersion: StrategyStructureVersion;
  /** Every top-level section in the source's own order and wording. */
  sections: ParsedSection[];
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Label alias tables
// ---------------------------------------------------------------------------

const SECTION_ALIASES: { id: StrategySectionId; test: RegExp }[] = [
  { id: "brand-overview", test: /^brand overview$/i },
  { id: "content-goals", test: /^content goals?$/i },
  { id: "content-pillars", test: /^content pillars?$/i },
  { id: "video-structure-framework", test: /^(video )?(structure )?framework$|^video structure$/i },
];

type FieldKey =
  | "coreValues"
  | "brandMessage"
  | "shortBrandStatement"
  | "brandVoice"
  | "targetAudience"
  | "primaryServiceAreas"
  | "pricePositioning"
  | "primaryClientTypes"
  | "longTermPositioningGoal"
  | "purpose"
  | "focusAreas"
  | "contentApproach"
  | "style"
  | "captionCtaExamples"
  | "strategicDirection";

const FIELD_ALIASES: { key: FieldKey; test: RegExp }[] = [
  { key: "coreValues", test: /^core values$/i },
  { key: "brandMessage", test: /^brand message$/i },
  { key: "shortBrandStatement", test: /^short brand statement$/i },
  { key: "brandVoice", test: /^brand voice$/i },
  { key: "targetAudience", test: /^target audience$/i },
  { key: "primaryServiceAreas", test: /^(primary )?(service|market) (areas?|focus)$/i },
  { key: "pricePositioning", test: /^(price positioning|ideal price point|price point)$/i },
  { key: "primaryClientTypes", test: /^(primary )?client types?$/i },
  { key: "longTermPositioningGoal", test: /^long[- ]term positioning goal$|^positioning goal$/i },
  { key: "purpose", test: /^purpose$/i },
  { key: "focusAreas", test: /^focus areas?$/i },
  { key: "contentApproach", test: /^content approach$/i },
  // "Style" (Mike), "Visual and Delivery Style" (Janice), and our own "Client style notes" label.
  { key: "style", test: /^(?:client style notes|(?:visual|delivery)(?:\s+(?:and|&)\s+(?:visual|delivery))?\s+style|style)$/i },
  { key: "captionCtaExamples", test: /^caption cta examples?$/i },
  { key: "strategicDirection", test: /^strategic (direction|note)s?$/i },
];

const TARGET_AUDIENCE_KEYS = new Set<FieldKey>(["primaryServiceAreas", "pricePositioning", "primaryClientTypes", "longTermPositioningGoal"]);

function fieldKeyFor(label: string): FieldKey | null {
  const clean = label.trim().replace(/\s+/g, " ");
  for (const a of FIELD_ALIASES) if (a.test.test(clean)) return a.key;
  return null;
}

// ---------------------------------------------------------------------------
// Line normalisation
// ---------------------------------------------------------------------------

/** Strip the extraction markers our raw dumps carry (`<Heading 1>`, `[num:70 lvl:0]`, `[B]`) and PDF page rules. */
export function normalizeStrategyLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^<([^>]{1,40})>((?:\[[^\]]{0,40}\])*)\s?/.exec(raw);
    let line = marker ? raw.slice(marker[0].length) : raw;
    line = line.replace(/\s+$/g, "");
    if (/^=+\s*PAGE \d+\s*=+$/i.test(line.trim())) continue;
    if (line.trim() !== "" && !/[0-9A-Za-zÀ-ɏ]/.test(line)) continue; // decorative "■ ■ ■"
    if (/^[A-Z |&]+$/.test(line.trim()) && line.includes("|")) continue; // PDF running header "REALTOUR PILOT | CONTENT STRATEGY"
    // A docx list paragraph (List Bullet / List Number / Body List, or any numbered
    // paragraph property) arrives without its glyph — restore a bullet so items split.
    const isList = !!marker && (/^(list|body list)/i.test(marker[1]) || /\[num:/.test(marker[2])) && line.trim() !== "" && !BULLET_RE.test(line);
    out.push(isList ? `• ${line.trim()}` : line);
  }
  return out;
}

const BULLET_RE = /^\s*(?:[•●▪◦\-–—*]|\d{1,2}[.)])\s+(.*)$/;
// The separator is optional ONLY for a known section name (Kristin: "1 Brand
// Overview"); an ordinary body line beginning with an integer ("2 things every
// seller should know") is never a section.
const NUMBERED_RE = /^\s*(\d{1,2})([.)])?\s+(.+)$/;
const PILLAR_RE = /^pillar\s*(\d{1,2})\s*[:.\-–—]?\s+(.+?)\s*:?$/i;
const LABEL_RE = /^([A-Z][A-Za-z'’\- ]{2,40}?)\s*:\s*(.*)$/;
const FRAMEWORK_PART_RE =
  /^(?:(\d{1,2})[.)]\s*)?(?:[•●\-–]\s*)?(Hook|Context|Payoff|Re-?hook|Build ?up|Talking Point\s*\d+[^:(]*?|Close\s*(?:\/|or)\s*Call to Action|Close|Call to Action)\s*(\([^)]*\))?\s*(?::\s*(.*))?$/i;

function isTitleCase(label: string): boolean {
  return label.split(/\s+/).every((w) => /^[A-Z]/.test(w) || /^(and|or|of|the|to|for|a|an|&)$/i.test(w));
}

function frameworkKey(label: string): { key: FrameworkPartKey; role: TalkingPointRole | null } {
  const l = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (l === "hook") return { key: "hook", role: null };
  if (l.startsWith("close") || l === "call to action") return { key: "close", role: null };
  if (l === "context") return { key: "context", role: null };
  if (l === "payoff") return { key: "payoff", role: null };
  const tp = /^talking point\s*(\d+)/.exec(l);
  if (tp) {
    const n = Number(tp[1]);
    const key: FrameworkPartKey = n === 1 ? "tp1" : n === 2 ? "tp2" : n === 3 ? "tp3" : "other";
    const role: TalkingPointRole | null = n === 1 ? "re-hook" : n === 2 ? "build-up" : n === 3 ? "payoff" : null;
    return { key, role };
  }
  return { key: "other", role: null };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Cursor = {
  section: StrategySectionId | "other" | null;
  sub: "target-audience" | "pillar" | "framework-part" | "caption" | "strategic" | null;
  pillar: StrategyPillar | null;
  part: FrameworkPart | null;
  field: ParsedField | null;
  fieldOwner: "brand" | "audience" | "pillar" | "framework" | null;
  lastSectionNumber: number;
};

export function parseStrategyDocument(text: string): ParsedStrategy {
  const lines = normalizeStrategyLines(text);
  const warnings: string[] = [];

  const doc: ParsedStrategy = {
    title: "",
    titleLines: [],
    clientName: null,
    year: null,
    subtitle: null,
    structureVersion: "unknown",
    sections: [],
    brandOverview: { coreValues: null, brandMessage: null, shortBrandStatement: null, brandVoice: null, otherFields: [], paragraphs: [] },
    targetAudience: {
      present: false,
      heading: null,
      primaryServiceAreas: null,
      pricePositioning: null,
      primaryClientTypes: null,
      longTermPositioningGoal: null,
      otherFields: [],
      paragraphs: [],
    },
    contentGoals: { heading: null, items: [], numbered: false },
    contentPillars: { heading: null, preamble: [], pillars: [] },
    framework: null,
    captionCtaExamples: null,
    strategicDirection: null,
    otherSections: [],
    warnings,
  };

  const cur: Cursor = { section: null, sub: null, pillar: null, part: null, field: null, fieldOwner: null, lastSectionNumber: 0 };
  // `null as …` keeps the declared type: TS would otherwise narrow a `let` initialised
  // to null and never see the assignments made inside the closures below.
  let otherSection = null as { heading: string; number: number | null; lines: string[] } | null;

  const appendValue = (existing: string | null, addition: string, bullet: boolean): string => {
    const add = addition.trim();
    if (!add) return existing ?? "";
    if (!existing) return add;
    return bullet || existing.endsWith("\n") ? `${existing}\n${add}` : `${existing} ${add}`;
  };

  const assignField = (key: FieldKey | null, label: string, value: string, line: number) => {
    const field: ParsedField = { label, key, value: value.trim(), line };
    cur.field = field;
    const inPillar = cur.sub === "pillar" && cur.pillar;
    const inFramework = cur.section === "video-structure-framework" && doc.framework;
    if (key && TARGET_AUDIENCE_KEYS.has(key)) {
      doc.targetAudience.present = true;
      cur.fieldOwner = "audience";
      (doc.targetAudience as unknown as Record<string, unknown>)[key] = field.value;
      return;
    }
    if (inPillar) {
      cur.fieldOwner = "pillar";
      if (key === "purpose") cur.pillar!.purpose = field.value;
      else if (key === "focusAreas") cur.pillar!.focusAreas = field.value;
      else if (key === "contentApproach") cur.pillar!.contentApproach = field.value;
      else cur.pillar!.otherFields.push(field);
      return;
    }
    if (inFramework) {
      cur.fieldOwner = "framework";
      // A labelled line ends the open part: "Style: …" and the lines after it
      // are the style note, not more of the Close's definition.
      cur.part = null;
      cur.sub = null;
      if (key === "style") doc.framework!.style = field.value;
      else doc.framework!.otherFields.push(field);
      return;
    }
    if (cur.sub === "target-audience") {
      cur.fieldOwner = "audience";
      doc.targetAudience.otherFields.push(field);
      return;
    }
    cur.fieldOwner = "brand";
    if (key === "coreValues") doc.brandOverview.coreValues = field.value;
    else if (key === "brandMessage") doc.brandOverview.brandMessage = field.value;
    else if (key === "shortBrandStatement") doc.brandOverview.shortBrandStatement = field.value;
    else if (key === "brandVoice") doc.brandOverview.brandVoice = field.value;
    else doc.brandOverview.otherFields.push(field);
  };

  const growField = (addition: string, bullet: boolean) => {
    const f = cur.field;
    if (!f) return false;
    f.value = appendValue(f.value, addition, bullet);
    const k = f.key;
    switch (cur.fieldOwner) {
      case "audience":
        if (k && TARGET_AUDIENCE_KEYS.has(k as FieldKey)) (doc.targetAudience as unknown as Record<string, unknown>)[k] = f.value;
        break;
      case "pillar":
        if (!cur.pillar) break;
        if (k === "purpose") cur.pillar.purpose = f.value;
        else if (k === "focusAreas") cur.pillar.focusAreas = f.value;
        else if (k === "contentApproach") cur.pillar.contentApproach = f.value;
        break;
      case "framework":
        if (k === "style" && doc.framework) doc.framework.style = f.value;
        break;
      case "brand":
        if (k === "coreValues") doc.brandOverview.coreValues = f.value;
        else if (k === "brandMessage") doc.brandOverview.brandMessage = f.value;
        else if (k === "shortBrandStatement") doc.brandOverview.shortBrandStatement = f.value;
        else if (k === "brandVoice") doc.brandOverview.brandVoice = f.value;
        break;
    }
    return true;
  };

  const startSection = (id: StrategySectionId | "other", number: number | null, heading: string, line: number) => {
    cur.section = id;
    cur.sub = null;
    cur.pillar = null;
    cur.part = null;
    cur.field = null;
    cur.fieldOwner = null;
    if (number != null) cur.lastSectionNumber = number;
    doc.sections.push({ id, number, heading, order: doc.sections.length + 1, line });
    otherSection = null;
    if (id === "content-goals") doc.contentGoals.heading = heading;
    else if (id === "content-pillars") doc.contentPillars.heading = heading;
    else if (id === "video-structure-framework") doc.framework = { heading, preamble: [], parts: [], style: null, otherFields: [] };
    else if (id === "other") {
      otherSection = { heading, number, lines: [] };
      doc.otherSections.push(otherSection);
    }
  };

  // Label lines whose inline value is itself a labelled line (Bernadette:
  // "Target Audience: Primary service area: Lehigh Valley…") recurse once.
  const handleLabelLine = (label: string, value: string, line: number): boolean => {
    const key = fieldKeyFor(label);
    if (!key && !isTitleCase(label)) return false;
    if (key === "targetAudience") {
      cur.sub = "target-audience";
      doc.targetAudience.present = true;
      doc.targetAudience.heading = label;
      cur.field = null;
      const inner = LABEL_RE.exec(value);
      if (inner && fieldKeyFor(inner[1])) return handleLabelLine(inner[1], inner[2], line);
      if (value.trim()) doc.targetAudience.paragraphs.push(value.trim());
      return true;
    }
    if (key === "captionCtaExamples") {
      cur.sub = "caption";
      cur.field = null;
      doc.captionCtaExamples = { heading: label, items: [] };
      if (value.trim()) doc.captionCtaExamples.items.push(value.trim());
      return true;
    }
    if (key === "strategicDirection") {
      cur.sub = "strategic";
      cur.field = null;
      doc.strategicDirection = { heading: label, paragraphs: [] };
      if (value.trim()) doc.strategicDirection.paragraphs.push(value.trim());
      return true;
    }
    if (key && TARGET_AUDIENCE_KEYS.has(key) && cur.sub !== "pillar") {
      if (cur.sub !== "target-audience") {
        cur.sub = "target-audience";
        doc.targetAudience.present = true;
        doc.targetAudience.heading = doc.targetAudience.heading ?? null;
      }
    }
    assignField(key, label, value, line);
    return true;
  };

  let firstSectionSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      // A blank line ends a running field value so the next paragraph is not glued
      // on — unless the label is still empty (Matthew: "Core Values:" / blank / value).
      // A framework style note (Janice's "Visual and Delivery Style" block) runs over paragraphs.
      if (cur.field && cur.field.value && cur.fieldOwner !== "audience" && !(cur.fieldOwner === "framework" && cur.field.key === "style")) cur.field = null;
      continue;
    }

    // --- top-level sections by numeric prefix ------------------------------
    const num = NUMBERED_RE.exec(t);
    if (num) {
      const n = Number(num[1]);
      const rest = num[3].trim().replace(/:$/, "");
      const known = SECTION_ALIASES.find((a) => a.test.test(rest));
      const hasSeparator = !!num[2];
      const looksLikeHeading = hasSeparator && rest.length <= 60 && !/[:.]/.test(rest) && !FRAMEWORK_PART_RE.test(t);
      if (known) {
        firstSectionSeen = true;
        startSection(known.id, n, t, i);
        continue;
      }
      if (looksLikeHeading && n === cur.lastSectionNumber + 1 && cur.section !== "video-structure-framework" && cur.section !== "content-goals") {
        firstSectionSeen = true;
        startSection("other", n, t, i);
        continue;
      }
    }

    // --- before the first section: title / subtitle -------------------------
    if (!firstSectionSeen) {
      if (/built around trust/i.test(t)) doc.subtitle = t;
      else if (isPreambleSectionHeading(t)) {
        // an unnumbered "Brand Overview" heading (defensive)
        const known = SECTION_ALIASES.find((a) => a.test.test(t.replace(/:$/, "")));
        if (known) {
          firstSectionSeen = true;
          startSection(known.id, null, t, i);
          continue;
        }
      } else doc.titleLines.push(t);
      continue;
    }

    // --- subsection headings that can appear inside any section -------------
    const pillar = PILLAR_RE.exec(t);
    if (pillar && (cur.section === "content-pillars" || cur.section === "other" || cur.section === null)) {
      cur.sub = "pillar";
      cur.field = null;
      cur.pillar = { number: Number(pillar[1]), name: pillar[2].trim(), heading: t, purpose: null, focusAreas: null, contentApproach: null, otherFields: [] };
      doc.contentPillars.pillars.push(cur.pillar);
      continue;
    }

    // Framework parts (S3 headings; S1 numbered timed items; Mike's bold bullets).
    if (cur.section === "video-structure-framework" && doc.framework) {
      const fp = FRAMEWORK_PART_RE.exec(t);
      if (fp) {
        const label = fp[2].trim();
        const { key, role } = frameworkKey(label);
        const part: FrameworkPart = { key, heading: label, timing: fp[3] ?? null, text: (fp[4] ?? "").trim(), role };
        doc.framework.parts.push(part);
        cur.part = part;
        cur.sub = "framework-part";
        cur.field = null;
        continue;
      }
    }

    // Labelled lines ("Core Values: …", "Purpose:", "Caption CTA Examples:", bare "Target Audience").
    const lab = LABEL_RE.exec(t);
    if (lab && handleLabelLine(lab[1], lab[2], i)) continue;
    const bareKey = fieldKeyFor(t);
    if (bareKey && (["targetAudience", "captionCtaExamples", "strategicDirection", "shortBrandStatement"].includes(bareKey) || (bareKey === "style" && cur.section === "video-structure-framework"))) {
      handleLabelLine(t, "", i);
      continue;
    }

    // --- body lines by section ----------------------------------------------
    const bullet = BULLET_RE.exec(t);
    const bulletText = bullet ? bullet[1].trim() : null;

    if (cur.sub === "caption" && doc.captionCtaExamples) {
      if (bulletText != null) doc.captionCtaExamples.items.push(bulletText);
      else if (doc.captionCtaExamples.items.length) {
        const last = doc.captionCtaExamples.items.length - 1;
        doc.captionCtaExamples.items[last] = `${doc.captionCtaExamples.items[last]} ${t}`;
      } else doc.captionCtaExamples.items.push(t);
      continue;
    }
    if (cur.sub === "strategic" && doc.strategicDirection) {
      doc.strategicDirection.paragraphs.push(t);
      continue;
    }

    switch (cur.section) {
      case "brand-overview": {
        if (cur.field && growField(t, bulletText != null)) break;
        if (cur.sub === "target-audience") doc.targetAudience.paragraphs.push(t);
        else doc.brandOverview.paragraphs.push(t);
        break;
      }
      case "content-goals": {
        if (bulletText != null) {
          doc.contentGoals.items.push(bulletText);
          if (/^\d/.test(t)) doc.contentGoals.numbered = true;
        } else if (doc.contentGoals.items.length) {
          const last = doc.contentGoals.items.length - 1;
          doc.contentGoals.items[last] = `${doc.contentGoals.items[last]} ${t}`;
        } else doc.contentGoals.items.push(t);
        break;
      }
      case "content-pillars": {
        if (cur.sub === "pillar" && cur.pillar) {
          if (cur.field && growField(t, bulletText != null)) break;
          cur.pillar.otherFields.push({ label: "", key: null, value: t, line: i });
          break;
        }
        doc.contentPillars.preamble.push(t);
        break;
      }
      case "video-structure-framework": {
        if (!doc.framework) break;
        if (cur.part) {
          cur.part.text = appendValue(cur.part.text, bulletText ?? t, bulletText != null);
          break;
        }
        if (cur.field && growField(t, bulletText != null)) break;
        doc.framework.preamble.push(t);
        break;
      }
      case "other": {
        if (cur.sub === "pillar" && cur.pillar) {
          if (cur.field && growField(t, bulletText != null)) break;
          cur.pillar.otherFields.push({ label: "", key: null, value: t, line: i });
          break;
        }
        if (cur.field && growField(t, bulletText != null)) break;
        otherSection?.lines.push(t);
        break;
      }
      default: {
        warnings.push(`line ${i + 1} outside any section: “${t.slice(0, 60)}”`);
      }
    }
  }

  // --- title / client / year --------------------------------------------------
  doc.title = doc.titleLines.join(" ").replace(/\s+/g, " ").trim();
  const yearMatch = /\b(20\d{2})\b/.exec(doc.title);
  doc.year = yearMatch ? Number(yearMatch[1]) : null;
  const name = doc.title
    .replace(/\s*[–\-—]\s*20\d{2}.*$/i, "")
    .replace(/\s*20\d{2}\s+(social\s+)?content\s+strategy.*$/i, "")
    .trim();
  doc.clientName = name || null;

  // --- structure version (manifest §3.3) --------------------------------------
  doc.structureVersion = detectStructureVersion(doc);

  if (!doc.sections.length) warnings.push("no numbered sections found — not a strategy document in any known structure");
  return doc;
}

function isPreambleSectionHeading(t: string): boolean {
  return SECTION_ALIASES.some((a) => a.test.test(t.replace(/:$/, "")));
}

export function detectStructureVersion(doc: StrategyDocument): StrategyStructureVersion {
  if (!doc.framework) return doc.contentPillars.pillars.length ? "S2" : "unknown";
  const parts = doc.framework.parts;
  const tpCount = parts.filter((p) => p.key === "tp1" || p.key === "tp2" || p.key === "tp3" || /^talking point/i.test(p.heading)).length;
  if (tpCount >= 2) return "S3";
  const timedOrContext = parts.some((p) => p.key === "context" || p.timing != null);
  if (timedOrContext) return "S1";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Renderer — the template's numbering. Source headings are preserved when
// `preserveSourceHeadings` is set (spec §3), otherwise the template wording.
// ---------------------------------------------------------------------------

export type RenderStrategyOptions = {
  /** Keep the document's own section / pillar / framework headings (an import); default = template wording (a new doc). */
  preserveSourceHeadings?: boolean;
  /**
   * Ignored since Oct 6 2026: section 4 is ALWAYS the house framework, the
   * same for every client, whatever the document's own says (Jordan).
   * @deprecated
   */
  injectPolicyFramework?: boolean;
};

export function renderStrategy(doc: StrategyDocument, opts: RenderStrategyOptions = {}): string {
  const keep = opts.preserveSourceHeadings === true;
  const out: string[] = [];
  const [s1, s2, s3, s4] = STRATEGY_TEMPLATE.sections;

  if (doc.clientName) out.push(doc.clientName);
  // Deterministic: a document without a year renders a placeholder, never the clock.
  out.push(`${doc.year ?? "<year>"} ${STRATEGY_TEMPLATE.titleSuffix}`);
  out.push(doc.subtitle ?? STRATEGY_TEMPLATE.subtitle, "");

  // 1. Brand Overview
  out.push(`1. ${s1.heading}`);
  const bo = doc.brandOverview;
  if (bo.coreValues) out.push(`Core Values: ${bo.coreValues}`);
  if (bo.brandMessage) out.push(`Brand Message: ${bo.brandMessage}`);
  if (bo.shortBrandStatement) out.push(`Short Brand Statement: ${bo.shortBrandStatement}`);
  if (bo.brandVoice) out.push(`Brand Voice: ${bo.brandVoice}`);
  for (const f of bo.otherFields) out.push(f.label ? `${f.label}: ${f.value}` : f.value);
  for (const p of bo.paragraphs) out.push(p);
  const ta = doc.targetAudience;
  if (ta.present) {
    out.push("", keep && ta.heading ? ta.heading.replace(/:$/, "") : s1.subsection.heading);
    if (ta.primaryServiceAreas) out.push(`Primary service areas: ${ta.primaryServiceAreas}`);
    if (ta.pricePositioning) out.push(`Price positioning: ${ta.pricePositioning}`);
    if (ta.primaryClientTypes) out.push(`Primary client types: ${ta.primaryClientTypes}`);
    if (ta.longTermPositioningGoal) out.push(`Long-term positioning goal: ${ta.longTermPositioningGoal}`);
    for (const f of ta.otherFields) out.push(f.label ? `${f.label}: ${f.value}` : f.value);
    for (const p of ta.paragraphs) out.push(p);
  }

  // 2. Content Goals
  out.push("", `2. ${s2.heading}`);
  for (const g of doc.contentGoals.items) out.push(`• ${g}`);

  // 3. Content Pillars
  out.push("", `3. ${s3.heading}`);
  if (doc.contentPillars.preamble.length) out.push(...doc.contentPillars.preamble);
  else out.push(s3.preamble);
  doc.contentPillars.pillars.forEach((p, idx) => {
    const heading = keep ? p.heading : s3.pillarHeading.replace("{n}", String(p.number ?? idx + 1)).replace("{name}", p.name);
    out.push("", heading);
    if (p.purpose) out.push(`Purpose: ${p.purpose}`);
    if (p.focusAreas) out.push(`Focus Areas: ${p.focusAreas}`);
    if (p.contentApproach) out.push(`Content Approach: ${p.contentApproach}`);
    for (const f of p.otherFields) out.push(f.label ? `${f.label}: ${f.value}` : f.value);
  });

  // 4. Video Structure Framework — the house framework for EVERY client
  // (Jordan, Oct 6 2026). A document's own parts, timings and preamble are not
  // printed; only its delivery note survives, on one separate line.
  out.push("", `4. ${s4.heading}`, POLICY_DEFAULT_FRAMEWORK.preamble);
  for (const part of POLICY_DEFAULT_FRAMEWORK.parts) out.push("", part.heading, part.text);
  const styleNotes = frameworkStyleNotesFromDocument(doc.framework);
  if (styleNotes) out.push("", `${CLIENT_STYLE_NOTES_LABEL}: ${styleNotes}`);

  if (doc.captionCtaExamples?.items.length) {
    out.push("", keep ? doc.captionCtaExamples.heading.replace(/:$/, "") : s4.subsections[0]);
    for (const c of doc.captionCtaExamples.items) out.push(`• ${c}`);
  }
  if (doc.strategicDirection?.paragraphs.length) {
    out.push("", keep ? doc.strategicDirection.heading.replace(/:$/, "") : s4.subsections[1]);
    out.push(...doc.strategicDirection.paragraphs);
  }
  for (const other of doc.otherSections) {
    out.push("", other.heading, ...other.lines);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------------------------------------------------------------------------
// Validator — presence report. Severities are "warn" / "info" only (C-B6:
// never block an approved client document; never auto-rewrite it).
// ---------------------------------------------------------------------------

export type StrategyValidation = {
  structureVersion: StrategyStructureVersion;
  present: string[];
  missing: string[];
  /**
   * The framework this strategy is shown and prompted with: always the house
   * framework, the same for every client (Oct 6 2026). A document's own
   * section 4 is never authoritative.
   */
  frameworkSource: "house";
  /** What the DOCUMENT itself carries (a presence fact for the import report and the reference manifest). */
  documentFramework: "own wording" | "none";
  pillarCount: number;
  findings: Finding[];
};

export function validateStrategyStructure(doc: StrategyDocument & { structureVersion?: StrategyStructureVersion }): StrategyValidation {
  const findings: Finding[] = [];
  const present: string[] = [];
  const missing: string[] = [];
  const check = (ok: boolean, name: string, severity: "warn" | "info" = "warn", path?: string) => {
    if (ok) present.push(name);
    else {
      missing.push(name);
      findings.push({ code: `strategy.missing.${slug(name)}`, severity, message: `Template item “${name}” is absent from this strategy.`, path });
    }
  };

  const bo = doc.brandOverview;
  check(!!bo.coreValues, "Core Values", "warn", "brandOverview.coreValues");
  check(!!bo.brandMessage, "Brand Message", "warn", "brandOverview.brandMessage");
  check(!!bo.shortBrandStatement, "Short Brand Statement", "info", "brandOverview.shortBrandStatement");
  check(!!bo.brandVoice, "Brand Voice", "warn", "brandOverview.brandVoice");
  check(!!doc.subtitle, "Subtitle (Built around Trust, Value, Credibility, and Entertainment)", "info", "subtitle");
  const ta = doc.targetAudience;
  check(ta.present, "Target Audience", "warn", "targetAudience");
  check(!!ta.primaryServiceAreas, "Primary service areas", "warn", "targetAudience.primaryServiceAreas");
  check(!!ta.pricePositioning, "Price positioning", "info", "targetAudience.pricePositioning");
  check(!!ta.primaryClientTypes, "Primary client types", "warn", "targetAudience.primaryClientTypes");
  check(!!ta.longTermPositioningGoal, "Long-term positioning goal", "warn", "targetAudience.longTermPositioningGoal");
  check(doc.contentGoals.items.length > 0, "Content Goals", "warn", "contentGoals");
  check(doc.contentPillars.pillars.length > 0, "Content Pillars", "warn", "contentPillars");
  const preambleJoined = doc.contentPillars.preamble.join(" "); // PDF text wraps a paragraph over several lines
  const preambleHasDims = QUALITY_DIMENSIONS.every((d) => new RegExp(d.name.replace(/ment$|ility$|ue$/, ""), "i").test(preambleJoined)); // "entertain", "credib", "val" — Mike's wording
  check(preambleHasDims, "Pillar preamble naming Trust / Value / Credibility / Entertainment", "info", "contentPillars.preamble");
  doc.contentPillars.pillars.forEach((p, i) => {
    if (!p.purpose) findings.push({ code: "strategy.pillar.purpose", severity: "warn", message: `Pillar “${p.name}” has no Purpose.`, path: `contentPillars.pillars[${i}]` });
    if (!p.focusAreas) findings.push({ code: "strategy.pillar.focusAreas", severity: "warn", message: `Pillar “${p.name}” has no Focus Areas.`, path: `contentPillars.pillars[${i}]` });
  });

  const fw = doc.framework;
  const documentFramework: StrategyValidation["documentFramework"] = fw ? "own wording" : "none";
  if (!fw) {
    missing.push("Video Structure Framework");
    findings.push({
      code: "strategy.framework.house",
      severity: "info",
      message: "This document defines no Video Structure Framework; the house framework (Hook / Rehook / Build Up / Payoff / Close) applies, as it does for every client. The stored document is not rewritten.",
      path: "framework",
    });
  } else {
    findings.push({
      code: "strategy.framework.replaced",
      severity: "info",
      message: "The document's own Video Structure Framework is not used: every client's strategy is shown and prompted with the house framework (Jordan, Oct 6 2026). The stored document is not rewritten.",
      path: "framework",
    });
    present.push("Video Structure Framework");
    const keys = new Set(fw.parts.map((p) => p.key));
    for (const [key, name] of [
      ["hook", "Hook"],
      ["tp1", "Talking Point 1 - Rehook"],
      ["tp2", "Talking Point 2 - Build Up"],
      ["tp3", "Talking Point 3 - Payoff"],
      ["close", "Close / Call to Action"],
    ] as const) {
      check(keys.has(key), name, "info", `framework.${key}`);
    }
    const version = doc.structureVersion ?? detectStructureVersion(doc);
    if (version === "S1") {
      findings.push({
        code: "strategy.framework.s1-four-part",
        severity: "info",
        message: "The document's framework is the S1 four-part timed flow (Hook / Context / Payoff / Close) with no talking points — the house five-part framework replaces it wherever the strategy is shown or used.",
        path: "framework",
      });
    }
    const notes = frameworkStyleNotesFromDocument(fw);
    if (notes) {
      findings.push({
        code: "strategy.framework.style-note",
        severity: "info",
        message: `The document carries client-specific direction (“${notes}”). Kept as a separate "${CLIENT_STYLE_NOTES_LABEL}" line, not as part of the framework; any length it states is left out (length is the policy's, the same for every client).`,
        path: "framework.style",
      });
    }
  }
  check(!!doc.captionCtaExamples?.items.length, "Caption CTA Examples", "info", "captionCtaExamples");
  check(!!doc.strategicDirection?.paragraphs.length, "Strategic Direction", "info", "strategicDirection");

  return {
    structureVersion: doc.structureVersion ?? detectStructureVersion(doc),
    present,
    missing,
    frameworkSource: "house",
    documentFramework,
    pillarCount: doc.contentPillars.pillars.length,
    findings,
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The pillar names of a strategy, in document order — the client's own names, never a universal set. */
export function pillarNames(doc: StrategyDocument): string[] {
  return doc.contentPillars.pillars.map((p) => p.name);
}
