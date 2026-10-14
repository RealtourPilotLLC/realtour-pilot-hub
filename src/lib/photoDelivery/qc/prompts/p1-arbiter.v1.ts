import { z } from "zod";
import { RP_CORE_V1 } from "./core.v1";
import { P1_BLOCK, P1_TEXT } from "./p1-photo.v1";
import { SeverityZ, bboxZ, joinSystem, unit, wireSchema, type PromptDef } from "./shared";

// ---------------------------------------------------------------------------
// P1_ARBITER_V1: the independent second look at every CRITICAL P1 finding
// (prompt pack 2.6). Opus, same system as P1 (RP_CORE_V1 + P1 block + the same
// <rules>, a separate cache entry because the model differs), the same image
// and template as P1 with the <candidate_finding> block appended before the
// last line. Block VERBATIM from the pack.
//
// Opus 5.5 cannot switch extended thinking off; effort "medium" (its default)
// keeps the careful look the arbiter exists for, and max_tokens leaves room
// for that thinking on top of the ~300-token answer.
// ---------------------------------------------------------------------------

const ARBITER_BLOCK = `<candidate_finding>
{{findingJson}}
</candidate_finding>
A first-pass inspector reported the finding above as CRITICAL. Check it independently against the image. Confirm it only if the evidence is visible and the CRITICAL criteria are met. If it is real but less severe, set confirmed false and give the severity you would assign.`;

export const P1_ARBITER_V1: PromptDef = {
  id: "P1_ARBITER",
  version: 1,
  constName: "P1_ARBITER_V1",
  core: "RP_CORE_V1",
  slot: "ARBITER",
  maxTokens: 4000,
  temperature: 0,
  cache: true,
  shape: { thinking: "adaptive", effort: "medium" },
  timeoutMs: 150_000,
  startMinMs: 75_000,
  system: joinSystem(RP_CORE_V1, P1_BLOCK),
  userTemplate: ARBITER_BLOCK,
  changelog: "v1 (2026-10-13): prompt pack 2.6.",
};

/** P1's text with the candidate block appended before its last line (2.6). */
export const ARBITER_TEXT = (() => {
  const lines = P1_TEXT.replace(/\s+$/, "").split("\n");
  const last = lines.pop() ?? "";
  return [...lines, ARBITER_BLOCK, "", last].join("\n");
})();

/** 2.6, verbatim. */
export function arbiterJsonSchema() {
  return wireSchema({
    type: "object",
    additionalProperties: false,
    required: ["evidence", "confirmed", "severity", "confidence", "bbox"],
    properties: {
      evidence: { type: "string", description: "What is visible that supports or contradicts the finding." },
      confirmed: { type: "boolean" },
      severity: { type: "string", enum: ["CRITICAL", "MAJOR", "MINOR"] },
      confidence: { type: "number", description: "0.0 to 1.0" },
      bbox: { anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }], description: "[x1, y1, x2, y2] in the image as sent." },
    },
  });
}

export const ArbiterLoose = z.object({
  evidence: z.string(),
  confirmed: z.boolean(),
  severity: SeverityZ,
  confidence: z.number(),
  bbox: z.array(z.number()).nullable(),
});

/** 2.6's zod (makeArbiterSchema), applied after the repairs. */
export const makeArbiterSchema = (w: number, h: number) => z.object({
  evidence: z.string().max(600), confirmed: z.boolean(), severity: SeverityZ, confidence: unit,
  bbox: bboxZ(w, h).nullable(),
}).refine((o) => !o.confirmed || o.severity === "CRITICAL", "confirmed implies CRITICAL");
export type ArbiterOutput = z.infer<ReturnType<typeof makeArbiterSchema>>;
