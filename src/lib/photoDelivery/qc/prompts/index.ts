import { RP_CORE } from "./core.v1";
import { P0_CLASSIFY_V1, p0JsonSchema } from "./p0-classify.v1";
import { P1_PHOTO_V1, p1JsonSchema } from "./p1-photo.v1";
import { P1_ARBITER_V1, arbiterJsonSchema } from "./p1-arbiter.v1";
import { P1B_DUST_V1, p1bJsonSchema } from "./p1b-dust.v1";
import { P2_GALLERY_V1, p2JsonSchema } from "./p2-gallery.v1";
import { P4_ORDER_V1, p4JsonSchema } from "./p4-order.v1";
import { DELIVERY_SUMMARY_V1, summaryJsonSchema } from "./delivery-summary.v1";
import { promptHash, type PromptDef } from "./shared";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// THE ACTIVE PROMPT SET (prompt pack 13). Selected in code; a new version is
// added beside the old one and switched here, never edited in place. Each run
// stores { id: { version, const, hash } } so a finding can always be traced to
// the exact text, template and schema that produced it.
// ---------------------------------------------------------------------------

export const ACTIVE_PROMPTS = {
  P0_CLASSIFY: P0_CLASSIFY_V1,
  P1_PHOTO: P1_PHOTO_V1,
  P1_ARBITER: P1_ARBITER_V1,
  P1B_DUST: P1B_DUST_V1,
  P2_GALLERY: P2_GALLERY_V1,
  P4_ORDER: P4_ORDER_V1,
  DELIVERY_SUMMARY: DELIVERY_SUMMARY_V1,
} as const satisfies Record<string, PromptDef>;

/** A fixed context for hashing schemas that take injected rule ids. */
const SAMPLE_IDS = ["SAMPLE_RULE", "OTHER_DEFECT"];
const SCHEMA_SAMPLES: Record<keyof typeof ACTIVE_PROMPTS, () => unknown> = {
  P0_CLASSIFY: p0JsonSchema,
  P1_PHOTO: () => p1JsonSchema(SAMPLE_IDS),
  P1_ARBITER: arbiterJsonSchema,
  P1B_DUST: p1bJsonSchema,
  P2_GALLERY: () => p2JsonSchema(SAMPLE_IDS),
  P4_ORDER: p4JsonSchema,
  DELIVERY_SUMMARY: summaryJsonSchema,
};

export type PromptVersionRecord = { version: number; const: string; hash: string };

let cached: Record<string, PromptVersionRecord> | null = null;

/** What a run records in promptVersionsJson. */
export function promptVersions(): Record<string, PromptVersionRecord> {
  if (cached) return cached;
  const out: Record<string, PromptVersionRecord> = {
    RP_CORE: { version: RP_CORE.version, const: RP_CORE.constName, hash: createHash("sha256").update(RP_CORE.text).digest("hex").slice(0, 16) },
  };
  for (const [key, def] of Object.entries(ACTIVE_PROMPTS) as [keyof typeof ACTIVE_PROMPTS, PromptDef][]) {
    out[def.id] = { version: def.version, const: def.constName, hash: promptHash(def, SCHEMA_SAMPLES[key]()) };
  }
  cached = out;
  return out;
}

export * from "./shared";
export * from "./render";
export { RP_CORE_V1 } from "./core.v1";
export * from "./p0-classify.v1";
export * from "./p1-photo.v1";
export * from "./p1-arbiter.v1";
export * from "./p1b-dust.v1";
export * from "./p2-gallery.v1";
export * from "./p4-order.v1";
export * from "./delivery-summary.v1";
