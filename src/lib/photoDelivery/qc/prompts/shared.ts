import { createHash } from "node:crypto";
import { z } from "zod";
import { FIX_STRATEGIES, RESPONSIBILITIES, ROOM_TYPES, SEVERITIES, PASSES, type QcRule, type Severity } from "../../registry";
import type { QcModelSlot } from "../../settings";

// ---------------------------------------------------------------------------
// THE SHARED PROMPT VOCABULARY (prompt pack 0.8 and 13).
//
// The zod enums are built from the registry's own constant lists, so the
// prompts, the registry and the database rows can never disagree on a value.
// Every prompt constant is an immutable, versioned object (13): any change to
// its text, template or schema means a NEW version, never an edit, and each
// run records the hash of what it sent (promptVersionsJson) so findings can be
// re-scored against the exact prompt that produced them.
// ---------------------------------------------------------------------------

export const SeverityZ = z.enum(SEVERITIES);
export const PassZ = z.enum(PASSES);
export const ResponsibilityZ = z.enum(RESPONSIBILITIES);
export const FixStrategyZ = z.enum(FIX_STRATEGIES);
export const RoomTypeZ = z.enum(ROOM_TYPES);

export const SEQUENCE_GROUPS = [
  "FRONT_EXTERIOR", "ENTRY", "MAIN_LIVING", "KITCHEN", "PRIMARY_SUITE", "BEDROOMS", "BATHROOMS", "FLEX",
  "LOWER_LEVEL", "UTILITY", "OUTDOOR_LIVING", "REAR_EXTERIOR", "AERIAL", "COMMUNITY", "DETAIL",
] as const;
export type SequenceGroup = (typeof SEQUENCE_GROUPS)[number];
export const SequenceGroupZ = z.enum(SEQUENCE_GROUPS);

export const REEDIT_SUFFIX = "Change nothing else in the photo.";
export const unit = z.number().min(0).max(1); // confidence: a range the JSON schema cannot express
export const score100 = z.number().int().min(0).max(100);
export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
export const noLongDashes = (s: string) => !/[\u2013\u2014]/.test(s);

export const bboxZ = (w: number, h: number) =>
  z.array(z.number().int()).length(4).refine(
    ([x1, y1, x2, y2]) => 0 <= x1 && x1 < x2 && x2 <= w && 0 <= y1 && y1 < y2 && y2 <= h,
    { message: `bbox must satisfy 0 <= x1 < x2 <= ${w} and 0 <= y1 < y2 <= ${h}` },
  );

export const reeditPromptZ = z.string().trim().min(20).max(600)
  .refine((s) => s.endsWith(REEDIT_SUFFIX), { message: "reeditPrompt must end with the suffix" })
  .refine((s) => wordCount(s) <= 90, { message: "reeditPrompt too long" });

/** The rule as a prompt sees it (0.8). Built from the registry row. */
export type InjectedRule = {
  id: string;
  shortLabel: string;
  checklistText: string;
  defaultSeverity: Severity;
  escalateTo?: Severity;
  deescalateTo?: Severity;
  visionHint: string;
  fixStrategies: (typeof FIX_STRATEGIES)[number][];
  permanentFeatureRisk?: boolean;
  groupKey: string;
};

export function injectedRule(r: QcRule): InjectedRule {
  return {
    id: r.id,
    shortLabel: r.shortLabel,
    checklistText: r.checklistText,
    defaultSeverity: r.defaultSeverity,
    escalateTo: r.escalateTo?.severity,
    deescalateTo: r.deescalateTo?.severity,
    visionHint: r.visionHint ?? "",
    fixStrategies: r.fixStrategies,
    permanentFeatureRisk: r.permanentFeatureRisk,
    groupKey: r.groupKey,
  };
}

export const allowedSeveritiesOf = (r: InjectedRule) =>
  new Set<Severity>([r.defaultSeverity, r.escalateTo, r.deescalateTo].filter((s): s is Severity => !!s));

// ---- the prompt definition ---------------------------------------------------------

/** How much the model may think. "off" maps per model family (claude.ts): the
 *  QC passes are perception and classification, and the pack's cost budget
 *  (0.10) assumes no extended thinking. */
export type RequestShape = { thinking: "off" | "adaptive"; effort?: "low" | "medium" | "high" };

export type PromptDef = {
  /** Stable id without the version ("P1_PHOTO"). */
  id: string;
  version: number;
  /** The constant's exported name ("P1_PHOTO_V1"). */
  constName: string;
  core: "RP_CORE_V1" | null;
  slot: QcModelSlot;
  maxTokens: number;
  /** 0 for every QC pass; claude.ts drops it for a model that refuses it. */
  temperature: number;
  /** Set only on prompts that repeat within 5 minutes (0.3). */
  cache: boolean;
  shape: RequestShape;
  /** Hard ceiling for one HTTP call. */
  timeoutMs: number;
  /** A call is only STARTED when at least this much of the tick's budget is
   *  left, so an in-flight call rarely outlives the cron's budget. */
  startMinMs: number;
  /** Core block + pass block, concatenated at module load. */
  system: string;
  /** The template VERBATIM from the pack, image markers included. */
  userTemplate: string;
  changelog: string;
};

/** Core + pass block, the way every prompt that embeds the core joins them. */
export function joinSystem(core: string | null, block: string): string {
  return core ? `${core}\n\n${block}` : block;
}

const IMAGE_MARKER = /^\[image(?::[^\]]*)?\]$/;

/**
 * The text that follows the images. The pack's templates show where images go
 * with marker lines ("[image: qc2048 of {{photoId}}]"); the request sends the
 * image blocks FIRST and this text after them (0.3), so the markers, the
 * illustrative "Image 2: ..." lines and the "..." continuation are dropped and
 * leading blank lines trimmed. Deterministic, so the verbatim template stays
 * the single source of truth.
 */
export function textAfterImages(template: string): string {
  const lines = template.split("\n");
  const out: string[] = [];
  let firstLabelSeen = false;
  for (const line of lines) {
    if (IMAGE_MARKER.test(line.trim())) continue;
    if (/^Image \d+: /.test(line)) {
      // Multi-image passes: the first "Image 1:" line is the per-image label
      // template (see imageLabelTemplate), the rest are illustrative.
      firstLabelSeen = true;
      continue;
    }
    if (firstLabelSeen && line.trim() === "...") continue;
    out.push(line);
  }
  while (out.length && out[0].trim() === "") out.shift();
  return out.join("\n");
}

/** The per-image label line of a multi-image template, with "Image 1:" turned
 *  into "Image {{n}}:" so it renders for every image. */
export function imageLabelTemplate(template: string): string {
  const first = template.split("\n").find((l) => /^Image 1: /.test(l));
  if (!first) throw new Error("template has no per-image label line");
  return first.replace(/^Image 1: /, "Image {{n}}: ");
}

export function promptHash(def: PromptDef, schemaSample: unknown): string {
  return createHash("sha256")
    .update(def.system)
    .update("\u0000")
    .update(def.userTemplate)
    .update("\u0000")
    .update(JSON.stringify(schemaSample))
    .digest("hex")
    .slice(0, 16);
}

// ---- wire schemas ----------------------------------------------------------------------

const UNSUPPORTED_KEYWORDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties", "format",
]);

/**
 * The schema as sent in output_config.format (or as a tool input_schema).
 * Structured outputs require `additionalProperties: false` on every object and
 * reject numeric, string-length and most array constraints; the pack's
 * hand-written schemas already follow that except P2's `minItems`, which zod
 * enforces client-side instead. Applied to every schema so a later version
 * cannot reintroduce an unsupported keyword by accident.
 */
export function wireSchema<T>(schema: T): T {
  // `properties` and `$defs` map NAMES to schemas: a property called "format"
  // is data, not a keyword, so those maps are walked without filtering keys.
  const walkMap = (m: unknown): unknown => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return m;
    return Object.fromEntries(Object.entries(m as Record<string, unknown>).map(([name, s]) => [name, walk(s)]));
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYWORDS.has(k)) continue;
      out[k] = k === "enum" || k === "required" ? v : k === "properties" || k === "$defs" ? walkMap(v) : walk(v);
    }
    if (out.type === "object" && out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
    return out;
  };
  return walk(schema) as T;
}

/** Sorted injected rule ids plus OTHER_DEFECT: the schema's ruleId enum (0.3:
 *  the same sorted list as the rules block, so the cache prefix and the
 *  compiled schema are shared by every photo of one room type). */
export function ruleIdEnum(rules: { id: string }[]): string[] {
  const ids = [...new Set(rules.map((r) => r.id))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...ids.filter((id) => id !== "OTHER_DEFECT"), "OTHER_DEFECT"];
}

/** A parsed, repaired and re-validated pass output, or why it failed. */
export type Validation<T> = { ok: true; value: T; coerced: string[] } | { ok: false; error: string };

/** A short, model-readable summary of a zod failure (used in the one retry). */
export function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 6)
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 600);
}

export const LOCAL_EDITS = new Set(["AUTOREMOVE_MASK", "DECLUTTER", "REEDIT_PROMPT", "CAMERA_REMOVAL"]);
export const VERIFY_PHRASE = "flag for verification against originals";

/** Lowercase kebab-case groupKey, or null when nothing usable is left. */
export function kebab(s: string | null | undefined, max = 60): string | null {
  const k = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return k || null;
}
