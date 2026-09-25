// ---------------------------------------------------------------------------
// The strategy template (Arielle Roemer Team 2026 Content Strategy, manifest
// §3.1 with the §3.2 corrections) as a typed structure, plus:
//   parseStrategyDocument(text)  — reads S1 / S2 / S3 archive strategies by
//                                  NUMERIC PREFIX, never by Word style (C-B5),
//                                  keeping the source's own headings and order
//                                  (spec §3: never force an abbreviated template);
//   renderStrategy(doc)          — writes a strategy in the template's numbering;
//   validateStrategyStructure()  — reports present / missing template sections.
//                                  Never blocks: a strategy with no framework
//                                  (Rick, S2) is flagged "framework: policy
//                                  default" (C-B6), not rejected.
//
// Pure. No DB, no AI.
// ---------------------------------------------------------------------------

import { type Finding, type TalkingPointRole, TALKING_POINT_ROLE_SPECS, QUALITY_DIMENSIONS } from "./policy";

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

/** Arielle §4 verbatim — injected when a client strategy has no framework (C-B6). */
export const POLICY_DEFAULT_FRAMEWORK: { preamble: string; parts: FrameworkPart[] } = {
  preamble:
    "Each reel follows a connected five-part flow, built around one clear idea. The hook creates curiosity, the talking points develop the story, and the payoff delivers on the opening promise.",
  parts: [
    {
      key: "hook",
      heading: "Hook",
      timing: null,
      role: null,
      text: "Open with a specific concern, misconception, or surprising observation that feels immediately relevant to a buyer or seller. Give viewers a reason to keep watching.",
    },
    { key: "tp1", heading: TALKING_POINT_ROLE_SPECS[0].frameworkHeading, timing: null, role: "re-hook", text: TALKING_POINT_ROLE_SPECS[0].definition },
    { key: "tp2", heading: TALKING_POINT_ROLE_SPECS[1].frameworkHeading, timing: null, role: "build-up", text: TALKING_POINT_ROLE_SPECS[1].definition },
    { key: "tp3", heading: TALKING_POINT_ROLE_SPECS[2].frameworkHeading, timing: null, role: "payoff", text: TALKING_POINT_ROLE_SPECS[2].definition },
    {
      key: "close",
      heading: "Close / Call to Action",
      timing: null,
      role: null,
      text: "Finish with a memorable takeaway or a relevant invitation to connect. Keep the close natural and concise, with the primary contact CTA in the caption when appropriate.",
    },
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
  { key: "style", test: /^style$/i },
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
      if (cur.field && cur.field.value && cur.fieldOwner !== "audience") cur.field = null;
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
    if (bareKey && ["targetAudience", "captionCtaExamples", "strategicDirection", "shortBrandStatement"].includes(bareKey)) {
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
  /** When the document has no framework, print the policy default and say so (default true). */
  injectPolicyFramework?: boolean;
};

export function renderStrategy(doc: StrategyDocument, opts: RenderStrategyOptions = {}): string {
  const keep = opts.preserveSourceHeadings === true;
  const inject = opts.injectPolicyFramework !== false;
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

  // 4. Video Structure Framework
  const fw = doc.framework ?? (inject ? { heading: null, preamble: [POLICY_DEFAULT_FRAMEWORK.preamble], parts: POLICY_DEFAULT_FRAMEWORK.parts, style: null, otherFields: [] } : null);
  if (fw) {
    out.push("", `4. ${s4.heading}`);
    if (!doc.framework) out.push("(framework: policy default — the client document defines none)");
    out.push(...fw.preamble);
    for (const part of fw.parts) {
      const heading = keep ? `${part.heading}${part.timing ? ` ${part.timing}` : ""}` : templateHeadingFor(part);
      out.push("", heading, part.text);
    }
    if (fw.style) out.push("", `Style: ${fw.style}`);
    for (const f of fw.otherFields) out.push(f.label ? `${f.label}: ${f.value}` : f.value);
  }

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

function templateHeadingFor(part: FrameworkPart): string {
  switch (part.key) {
    case "hook":
      return "Hook";
    case "tp1":
      return TALKING_POINT_ROLE_SPECS[0].frameworkHeading;
    case "tp2":
      return TALKING_POINT_ROLE_SPECS[1].frameworkHeading;
    case "tp3":
      return TALKING_POINT_ROLE_SPECS[2].frameworkHeading;
    case "close":
      return "Close / Call to Action";
    default:
      return `${part.heading}${part.timing ? ` ${part.timing}` : ""}`;
  }
}

// ---------------------------------------------------------------------------
// Validator — presence report. Severities are "warn" / "info" only (C-B6:
// never block an approved client document; never auto-rewrite it).
// ---------------------------------------------------------------------------

export type StrategyValidation = {
  structureVersion: StrategyStructureVersion;
  present: string[];
  missing: string[];
  frameworkSource: "document" | "policy default";
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
  const frameworkSource: StrategyValidation["frameworkSource"] = fw ? "document" : "policy default";
  if (!fw) {
    missing.push("Video Structure Framework");
    findings.push({
      code: "strategy.framework.policy-default",
      severity: "info",
      message: "framework: policy default — this strategy defines no Video Structure Framework; the policy's Hook / Re-hook / Build up / Payoff / Close flow applies. The approved document is not rewritten.",
      path: "framework",
    });
  } else {
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
        message: "framework: S1 four-part timed flow (Hook / Context / Payoff / Close) with no talking-point concept — superseded by policy format for NEW scripts (Jordan, Sep 16). Re-version onto the S3 template with a note rather than overriding silently.",
        path: "framework",
      });
    }
    if (fw.style) {
      findings.push({
        code: "strategy.framework.style-note",
        severity: "info",
        message: `The document states a delivery style (“${fw.style}”). Recorded as source text only; the policy's 20–30 s target is not overridden by it.`,
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
    frameworkSource,
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
