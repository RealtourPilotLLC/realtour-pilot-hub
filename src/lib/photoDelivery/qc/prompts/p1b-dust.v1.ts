import { z } from "zod";
import { bboxZ, imageLabelTemplate, textAfterImages, unit, wireSchema, type PromptDef } from "./shared";

// ---------------------------------------------------------------------------
// P1B_DUST_V1: dust and small-defect crop confirmation (prompt pack 3).
// Sonnet, up to 20 crops of 512x512 cut at FULL resolution around the CV dust
// candidates, at most 60 crops per gallery prioritized by recurrence count,
// then contrast. max_tokens 2,500, temperature 0, cached system. Text VERBATIM
// from the pack (3.2, 3.3); each crop gets its own label line before it.
// ---------------------------------------------------------------------------

const SYSTEM = `You confirm possible sensor or lens dust in finished real estate photos for Realtour Pilot, a premium real estate media company. Code has already found small dark, low-contrast blobs on flat areas (walls, ceilings, skies, cabinet faces). You see full-resolution crops with the candidate near the center of each crop. Decide what each candidate is.

VERDICTS
isDust: a soft-edged, roughly round or blotchy darkening with no depth, no cast shadow and no texture of its own, sitting on top of the scene. Dust is most visible on bright flat areas and often appears at the same image coordinates in several photos.
isRealObject: something physically in the scene: nail hole, screw, hook, outlet, vent, switch, thermostat, sprinkler head, smoke detector, stain, scuff, crack, insect, bird, distant object in the sky, leaf. Set isPropertyCondition true for marks or damage on the property (stain, scuff, crack, hole, peeling paint, water mark). Those are never removed automatically.
isTextureOrPattern: part of the surface itself (wood knot, stone veining, textured ceiling, wallpaper, grout, stucco), image noise, or compression artifacts.
uncertain: you cannot tell at this size. Prefer uncertain over a guess.

EVIDENCE
For dust: soft gradient edges; similar size and shape across a recurrence group; in different photos the spot sits over different scene content (it follows the sensor, not the room); a darkening rather than a defined object.
Against dust: crisp edges; a shape foreshortened with the surface's perspective; a cast shadow; repetition that matches the surface pattern; the same physical object in photos taken from the same spot.
Crops that share a recurrenceGroupId were found at nearly the same image coordinates in different photos. Use that, but judge each crop on its own pixels: one group can contain both dust and a real object.

OUTPUT
Exactly one result per crop, in the order given, with its cropId.
note: one sentence of visual evidence.
confidence: 0.0 to 1.0, your estimate that the verdict is right.
refinedBbox: a tight [x1, y1, x2, y2] box around the spot in that crop's own pixel coordinates (origin at the crop's top-left corner), or null for isTextureOrPattern or when nothing is localized.
isPropertyCondition: true only for isRealObject marks or damage; otherwise false.`;

const USER = `Image 1: crop {{cropId}} | photo {{photoId}} | {{cropW}}x{{cropH}} px at full resolution | origin ({{cropX0}}, {{cropY0}}) in {{fullW}}x{{fullH}} | candidate center ({{candX}}, {{candY}}) in crop | recurrence group {{recurrenceGroupId}} (seen in {{recurrenceCount}} photos) | surface: mean L* {{surfaceL}}, local std {{surfaceStd}} | spot contrast {{deltaL}} L*
[image: crop]
Image 2: ...
[image: crop]
...

All crops are cut at full resolution; none are resized. Classify every crop. Crop ids in order: {{cropIdList}}.`;

export const P1B_DUST_V1: PromptDef = {
  id: "P1B_DUST",
  version: 1,
  constName: "P1B_DUST_V1",
  core: null,
  slot: "P1B",
  maxTokens: 2500,
  temperature: 0,
  cache: true,
  shape: { thinking: "off" },
  timeoutMs: 120_000,
  startMinMs: 60_000,
  system: SYSTEM,
  userTemplate: USER,
  changelog: "v1 (2026-10-13): prompt pack 3.2 to 3.4.",
};

/** The label line rendered before each crop ("Image {{n}}: crop ..."). */
export const P1B_LABEL = imageLabelTemplate(USER);
/** The text sent after the crops. */
export const P1B_TEXT = textAfterImages(USER);

export const MAX_CROPS_PER_CALL = 20;
export const MAX_CROPS_PER_GALLERY = 60;

/** 3.4, verbatim. */
export function p1bJsonSchema() {
  return wireSchema({
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["cropId", "note", "verdict", "confidence", "refinedBbox", "isPropertyCondition"],
          properties: {
            cropId: { type: "string" },
            note: { type: "string", description: "One sentence of visual evidence." },
            verdict: { type: "string", enum: ["isDust", "isRealObject", "isTextureOrPattern", "uncertain"] },
            confidence: { type: "number", description: "0.0 to 1.0" },
            refinedBbox: { anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }], description: "[x1, y1, x2, y2] in this crop's own pixels." },
            isPropertyCondition: { type: "boolean" },
          },
        },
      },
    },
  });
}

export const DustVerdict = z.enum(["isDust", "isRealObject", "isTextureOrPattern", "uncertain"]);

export const P1bLoose = z.object({
  results: z.array(z.object({
    cropId: z.string(),
    note: z.string(),
    verdict: DustVerdict,
    confidence: z.number(),
    refinedBbox: z.array(z.number()).nullable(),
    isPropertyCondition: z.boolean(),
  })),
});

/** 3.4's zod (makeP1bSchema), applied after the repairs. */
export const makeP1bSchema = (crops: { cropId: string; w: number; h: number }[]) => {
  const dims = new Map(crops.map((k) => [k.cropId, k]));
  return z.object({
    results: z.array(z.object({
      cropId: z.string(),
      note: z.string().max(300),
      verdict: DustVerdict,
      confidence: unit,
      refinedBbox: z.array(z.number().int()).length(4).nullable(),
      isPropertyCondition: z.boolean(),
    })),
  }).superRefine((o, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (o.results.map((r) => r.cropId).join() !== crops.map((k) => k.cropId).join()) issue("crop order or coverage");
    for (const r of o.results) {
      const d = dims.get(r.cropId);
      if (!d) { issue(`unknown cropId ${r.cropId}`); continue; }
      if (r.refinedBbox && !bboxZ(d.w, d.h).safeParse(r.refinedBbox).success) issue(`bbox out of crop ${r.cropId}`);
      if (r.isPropertyCondition && r.verdict !== "isRealObject") issue("isPropertyCondition requires isRealObject");
    }
  });
};
export type P1bOutput = z.infer<ReturnType<typeof makeP1bSchema>>;
export type P1bResult = P1bOutput["results"][number];
