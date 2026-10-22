import { z } from "zod";
import { RP_CORE_V1 } from "./core.v1";
import {
  FixStrategyZ,
  LOCAL_EDITS,
  ResponsibilityZ,
  SeverityZ,
  allowedSeveritiesOf,
  bboxZ,
  joinSystem,
  reeditPromptZ,
  textAfterImages,
  unit,
  wireSchema,
  type InjectedRule,
  type PromptDef,
} from "./shared";

// ---------------------------------------------------------------------------
// P1_PHOTO_V1: per-photo inspection (prompt pack 2).
// Sonnet, one photo at qc2048 with only the rules for its room, temperature 0,
// max_tokens 4,000. System = RP_CORE_V1 + this block, then the injected
// <rules> block carrying the cache breakpoint (same room type, same prefix,
// same compiled schema). Text VERBATIM from the pack (2.2, 2.3), except
// AI_ARTIFACTS' floating objects (Oct 22 2026, 615 Cliff Ln's floating lamp;
// rule AIEDIT_FLOATING_OBJECT). The prompt's hash on each finding records it.
// ---------------------------------------------------------------------------

export const P1_BLOCK = `TASK: SINGLE-PHOTO INSPECTION (P1)
You inspect one finished photo against the rules in <rules>. The photo comes first in the message; its context follows.

CHECKS
Work through all 13 checks and list each one in checksPerformed or in checksSkipped with a short reason. Skip only when a check cannot apply or its data is missing (for example SKY_REPLACEMENT when no sky is visible).
CLUTTER_PREP: preparation and clutter (bins, boxes, cleaning supplies, cords, shoes, personal items, open doors, cabinets and drawers, crooked rugs, wrinkled textiles, painter's tape, temporary signage).
UNWANTED_OBJECTS: people, pets, vehicles, hoses, tools, equipment, distracting things seen through windows.
DUST_OBVIOUS: dust spots or smudges plainly visible at this size. Tiny sensor dust is handled by a separate crop pass; do not hunt for it.
REFLECTIONS_GLARE: camera, tripod, photographer or flash in mirrors, glass doors, windows, appliances, TV screens and glossy surfaces; lens flare; colored or white glare.
FOCUS_SHARPNESS: blur, camera shake, motion blur, heavy noise.
EXPOSURE_LIGHTING: under or over exposure, blown windows that should show a view, flash hotspots, harsh shadows, mixed bulb colors, burned-out bulbs.
PERSPECTIVE: vertical lines (door frames, wall corners, window edges) not parallel to the image sides, bowed or curved lines, stretched edges, fisheye look. Aerials and deliberate upward exterior angles are exempt from strict verticals.
CROP_COMPOSITION: roof peaks, chimneys or features cut by the frame, too much ceiling or floor, cut-off furniture, toilet emphasized, awkward angle, home not centered in a primary exterior.
COLOR_ACCURACY: color casts, implausible material colors, over or under saturation, unnatural grass or sky.
HDR_DEFECTS: halos, muddy shadows, overprocessed or flat look, bright edges, poor window masking or unnatural window pulls.
SKY_REPLACEMENT: masking errors on rooflines and trees, sky bleeding into windows, mismatched light, unnatural twilight.
AI_ARTIFACTS: smears, cloned textures, warped tile or wood grain, broken edges, altered frames or fixtures, partial removals, invented objects, floating or unsupported objects (a lamp, furniture or decor hovering with nothing under it, an object cut off in mid-air, a doubled or ghost copy).
PRIVACY: readable documents, mail, screens, license plates, prescription labels, personal photos of people.

USING HUB DATA
<cv_metrics> are measurements from code. Treat them as supporting evidence and confirm visually. A low blur score supports a focus finding; clipping matters only where detail should exist (a window view, not a bulb).
<photo_context> comes from an automated classifier and can be wrong. If the room type is clearly wrong, add a finding with ruleId OTHER_DEFECT, severity MINOR, fixStrategy HUMAN_REVIEW, and still apply the rules provided.
<ignored_findings>, when present, lists findings staff chose to ignore on an earlier version of this photo. Do not report them again unless they got worse.
If the photo is virtually staged, staged furniture is expected; report only staging errors (floating or misplaced furniture, wrong scale, furniture blocking doors, windows or vents).
A primary or hero exterior (isPrimaryCandidate true, or gallery position 1 to 3) justifies escalation for clutter, crops and vehicles, because it will be the listing's cover image.

ONE FINDING PER PROBLEM
Report each distinct problem once. Several bottles on one vanity are one finding with one box around the group; two bins in different places are two findings. Do not report the same thing under two rules.

FIELDS
groupKey: lowercase kebab-case naming the physical thing and where it is in the property, never the photo, so the same problem seen from another angle gets the same key ("garden-hose-front-lawn", "toilet-lid-open-hall-bath").
specificIssue: under 12 words. locationText: position in the frame ("lower right, beside vanity").
explanation: one or two sentences of visible evidence. Say why if you changed severity from the rule default or if you are unsure.
recommendedAction: one sentence for staff.
fixStrategy: pick from the rule's fixStrategies when one fits; HUMAN_REVIEW and NONE are always allowed; OTHER_DEFECT may use any strategy except REVERT_VERSION.
  AUTOREMOVE_MASK: small removable object or objects in one area.
  DECLUTTER: many removable items spread through the frame.
  CAMERA_REMOVAL: camera, tripod or photographer visible or reflected.
  REEDIT_PROMPT: a describable local change to a removable item or its state (close a lid, door or drawer; straighten a towel; neutralize an overall cast).
  GRASS: lawn rendering problems, only if <client_profile> allows lawn enhancement.
  STYLE_RERENDER: whole-image processing problems (halos, heavy cast, overprocessed or flat look, bad window pulls).
  EDITOR_MANUAL: needs a human editor (complex masking, recropping from the original, perspective repair).
  RESHOOT: cannot be fixed in post.
  ADMIN_ACTION: an office decision (privacy handling, client policy).
  HUMAN_REVIEW: color truth, permanent features, low confidence.
  NONE: informational only.
  REVERT_VERSION is not used in this pass.
reeditPrompt: only with REEDIT_PROMPT, otherwise null. Imperative and specific: name the object, where it is in the frame, the end state, and what must match (finish, color, lighting, perspective). One change per sentence, under 70 words. End with exactly: "Change nothing else in the photo." Never ask to remove a permanent feature, assert a material's real color, or hide a property condition.
responsibility: PHOTOGRAPHER for on-site causes (preparation, reflections, focus, composition, in-camera framing); EDITOR for processing causes (HDR, color, sky, masking, AI artifacts, crop from perspective correction); ADMIN for privacy handling, client policy and order issues; HUMAN_REVIEW when the cause is unclear.
postFixable: a reasonable edit can fix it. reshootMayBeNeeded: post is unlikely to fix it, or the needed detail may not exist in the capture.
bbox: tight box around the problem itself in the sent image, or null for global issues.

VERDICT
overallPhotoVerdict: HOLD if any CRITICAL; else NEEDS_FIX if any MAJOR; else PASS_WITH_MINOR if any MINOR; else PASS.`;

const USER = `[image: qc2048 of {{photoId}}]

Image: photo {{photoId}} ({{filename}}), sent at {{sentWidth}}x{{sentHeight}} px. All boxes use this size.

<property>
Address: {{address}}
Type: {{propertyType}} | {{beds}} bd | {{baths}} ba | {{sqft}} sqft
</property>

<photo_context>
Room type: {{roomType}} (confidence {{roomConfidence}}; alternate {{alternateRoomType}})
Description: {{p0Description}}
Aerial: {{isAerial}} | Twilight: {{isTwilight}} | Virtually staged: {{isVirtuallyStaged}}
Primary or hero candidate: {{isPrimaryCandidate}} | Gallery position: {{galleryPosition}} of {{galleryCount}}
</photo_context>

<cv_metrics>
Blur (Laplacian variance): {{blurScore}} (gallery median {{blurMedian}}; soft below {{blurSoftThreshold}})
Highlight clipping: {{highlightClipPct}}% | Shadow clipping: {{shadowClipPct}}%
Mean Lab: L {{labL}}, a {{labA}}, b {{labB}} (room-cluster median b {{clusterMedianB}})
Flags: {{cvFlags}}
</cv_metrics>

<client_profile>
{{clientQcProfileNotes}}
</client_profile>

<ingest_settings>
Requested at AutoHDR ingest: fireplace fire {{fireplaceRequested}} | TV screen replacement {{tvReplacementMode}} | lawn greening {{grassRequested}} | declutter {{declutterAtIngest}}
</ingest_settings>

<order_notes>
{{specialInstructions}}
</order_notes>

<ignored_findings>
{{ignoredFindings}}
</ignored_findings>

Inspect the photo.`;

export const P1_PHOTO_V1: PromptDef = {
  id: "P1_PHOTO",
  version: 1,
  constName: "P1_PHOTO_V1",
  core: "RP_CORE_V1",
  slot: "P1",
  maxTokens: 4000,
  temperature: 0,
  cache: true,
  shape: { thinking: "off" },
  timeoutMs: 120_000,
  startMinMs: 60_000,
  system: joinSystem(RP_CORE_V1, P1_BLOCK),
  userTemplate: USER,
  changelog: "v1 (2026-10-13): prompt pack 2.2 to 2.4.",
};

/** The text sent after the image. */
export const P1_TEXT = textAfterImages(USER);

export const P1_CHECKS = [
  "CLUTTER_PREP", "UNWANTED_OBJECTS", "DUST_OBVIOUS", "REFLECTIONS_GLARE", "FOCUS_SHARPNESS", "EXPOSURE_LIGHTING",
  "PERSPECTIVE", "CROP_COMPOSITION", "COLOR_ACCURACY", "HDR_DEFECTS", "SKY_REPLACEMENT", "AI_ARTIFACTS", "PRIVACY",
] as const;
export const P1Check = z.enum(P1_CHECKS);

/** 2.4, verbatim; `__INJECTED_RULE_IDS__` becomes the sorted injected ids plus OTHER_DEFECT. */
export function p1JsonSchema(ruleIds: string[]) {
  return wireSchema({
    type: "object",
    additionalProperties: false,
    required: ["findings", "checksPerformed", "checksSkipped", "overallPhotoVerdict"],
    properties: {
      findings: { type: "array", items: { $ref: "#/$defs/Finding" } },
      checksPerformed: { type: "array", items: { $ref: "#/$defs/CheckId" } },
      checksSkipped: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["check", "reason"],
          properties: {
            check: { $ref: "#/$defs/CheckId" },
            reason: { type: "string" },
          },
        },
      },
      overallPhotoVerdict: { type: "string", enum: ["PASS", "PASS_WITH_MINOR", "NEEDS_FIX", "HOLD"] },
    },
    $defs: {
      CheckId: { type: "string", enum: [...P1_CHECKS] },
      Finding: {
        type: "object",
        additionalProperties: false,
        required: ["ruleId", "groupKey", "specificIssue", "locationText", "bbox", "explanation", "severity", "confidence", "isPermanentFeature", "privacySensitive", "responsibility", "fixStrategy", "reeditPrompt", "recommendedAction", "postFixable", "reshootMayBeNeeded"],
        properties: {
          ruleId: { type: "string", enum: ruleIds, description: "Injected rule id or OTHER_DEFECT." },
          groupKey: { type: "string", description: "lowercase kebab-case: the physical thing plus its place in the property." },
          specificIssue: { type: "string", description: "Under 12 words." },
          locationText: { type: "string" },
          bbox: { anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }], description: "[x1, y1, x2, y2] absolute pixels in the image as sent, origin top-left; null for global issues." },
          explanation: { type: "string" },
          severity: { type: "string", enum: ["CRITICAL", "MAJOR", "MINOR"] },
          confidence: { type: "number", description: "0.0 to 1.0: estimated probability the finding is real." },
          isPermanentFeature: { type: "boolean" },
          privacySensitive: { type: "boolean" },
          responsibility: { type: "string", enum: ["PHOTOGRAPHER", "EDITOR", "ADMIN", "HUMAN_REVIEW"] },
          fixStrategy: { type: "string", enum: ["AUTOREMOVE_MASK", "DECLUTTER", "REEDIT_PROMPT", "CAMERA_REMOVAL", "GRASS", "STYLE_RERENDER", "REVERT_VERSION", "EDITOR_MANUAL", "RESHOOT", "ADMIN_ACTION", "HUMAN_REVIEW", "NONE"] },
          reeditPrompt: { anyOf: [{ type: "string" }, { type: "null" }], description: "Only with REEDIT_PROMPT. Must end with: Change nothing else in the photo." },
          recommendedAction: { type: "string" },
          postFixable: { type: "boolean" },
          reshootMayBeNeeded: { type: "boolean" },
        },
      },
    },
  });
}

export const P1_VERDICTS = ["PASS", "PASS_WITH_MINOR", "NEEDS_FIX", "HOLD"] as const;

/** Structure only (types and enums): what the deterministic repairs work from.
 *  ruleId is a plain string here; repair maps an unknown id to OTHER_DEFECT. */
export const P1FindingLoose = z.object({
  ruleId: z.string(),
  groupKey: z.string(),
  specificIssue: z.string(),
  locationText: z.string().nullable(),
  bbox: z.array(z.number()).nullable(),
  explanation: z.string(),
  severity: SeverityZ,
  confidence: z.number(),
  isPermanentFeature: z.boolean(),
  privacySensitive: z.boolean(),
  responsibility: ResponsibilityZ,
  fixStrategy: FixStrategyZ,
  reeditPrompt: z.string().nullable(),
  recommendedAction: z.string(),
  postFixable: z.boolean(),
  reshootMayBeNeeded: z.boolean(),
});
export const P1OutputLoose = z.object({
  findings: z.array(P1FindingLoose),
  checksPerformed: z.array(z.string()),
  checksSkipped: z.array(z.object({ check: z.string(), reason: z.string() })),
  overallPhotoVerdict: z.enum(P1_VERDICTS),
});
export type P1OutputLooseT = z.infer<typeof P1OutputLoose>;

/** 2.4's zod (makeP1Schema), applied AFTER the repairs: anything it still
 *  rejects goes back to the model once, then is treated as a refusal (0.7). */
export const makeP1Schema = (c: { w: number; h: number; rules: Map<string, InjectedRule> }) => {
  const Finding = z.object({
    ruleId: z.string(),
    groupKey: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60),
    specificIssue: z.string().min(3).max(100),
    locationText: z.string().max(120),
    bbox: bboxZ(c.w, c.h).nullable(),
    explanation: z.string().max(600),
    severity: SeverityZ,
    confidence: unit,
    isPermanentFeature: z.boolean(),
    privacySensitive: z.boolean(),
    responsibility: ResponsibilityZ,
    fixStrategy: FixStrategyZ,
    reeditPrompt: reeditPromptZ.nullable(),
    recommendedAction: z.string().max(300),
    postFixable: z.boolean(),
    reshootMayBeNeeded: z.boolean(),
  }).superRefine((f, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const rule = c.rules.get(f.ruleId);
    if (!rule && f.ruleId !== "OTHER_DEFECT") issue(`unknown ruleId ${f.ruleId}`);
    if (rule) {
      const sev = allowedSeveritiesOf(rule);
      if (f.privacySensitive) sev.add("CRITICAL");
      if (!sev.has(f.severity)) issue("severity outside rule range");
      if (![...rule.fixStrategies, "HUMAN_REVIEW", "NONE"].includes(f.fixStrategy)) issue("strategy not allowed");
    }
    if (f.fixStrategy === "REVERT_VERSION") issue("REVERT_VERSION not allowed in P1");
    if (f.privacySensitive && f.severity !== "CRITICAL") issue("privacy must be CRITICAL");
    if ((f.fixStrategy === "REEDIT_PROMPT") !== (f.reeditPrompt !== null)) issue("reeditPrompt iff REEDIT_PROMPT");
    if (f.isPermanentFeature && LOCAL_EDITS.has(f.fixStrategy)) issue("permanent feature routed to removal");
  });

  return z.object({
    findings: z.array(Finding).max(25),
    checksPerformed: z.array(P1Check),
    checksSkipped: z.array(z.object({ check: P1Check, reason: z.string().min(3).max(200) })),
    overallPhotoVerdict: z.enum(P1_VERDICTS),
  }).superRefine((o, ctx) => {
    const seen = new Set([...o.checksPerformed, ...o.checksSkipped.map((s) => s.check)]);
    if (seen.size !== P1Check.options.length) ctx.addIssue({ code: "custom", message: "checks ledger incomplete" });
    const s = new Set(o.findings.map((f) => f.severity));
    const expected = s.has("CRITICAL") ? "HOLD" : s.has("MAJOR") ? "NEEDS_FIX" : s.size ? "PASS_WITH_MINOR" : "PASS";
    if (o.overallPhotoVerdict !== expected) ctx.addIssue({ code: "custom", message: "verdict mismatch" });
  });
};
export type P1Output = z.infer<ReturnType<typeof makeP1Schema>>;
export type P1Finding = P1Output["findings"][number];
