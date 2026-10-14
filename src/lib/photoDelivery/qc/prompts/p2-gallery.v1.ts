import { z } from "zod";
import { RP_CORE_V1 } from "./core.v1";
import {
  FixStrategyZ,
  ResponsibilityZ,
  SeverityZ,
  VERIFY_PHRASE,
  allowedSeveritiesOf,
  imageLabelTemplate,
  joinSystem,
  textAfterImages,
  unit,
  wireSchema,
  type InjectedRule,
  type PromptDef,
} from "./shared";

// ---------------------------------------------------------------------------
// P2_GALLERY_V1: gallery consistency (prompt pack 4). Opus, after every P1:
//   CLUSTER  one call per room cluster with 2+ photos at qc1024 (thumb768
//            above 20 photos, which also satisfies the 2,000 px rule)
//   OVERVIEW every photo as thumb768, batches of 40 sharing 4 anchors
// System = RP_CORE_V1 + this block + the P2 <rules> block (cache breakpoint).
// Text VERBATIM from the pack (4.2, 4.3). max_tokens 4,000 (cluster) or 6,000
// (overview); Opus 5.5 always thinks, so effort "low" keeps the cost near the
// pack's estimate (0.10).
// ---------------------------------------------------------------------------

export const P2_BLOCK = `TASK: GALLERY CONSISTENCY (P2)
You compare several finished photos of one property side by side. Single-photo defects were already checked in another pass; report only problems that appear when photos are compared. Photos are labeled "Image N: <photoId>". Always refer to photos by photoId.

MODE CLUSTER (all images show one space, for example every KITCHEN angle):
- Material color of the same surfaces across angles: cabinets, island, walls, floors, countertops, stone, fireplace, siding and trim. Judge hue (navy vs black, gray vs beige, white vs cream), not brightness differences caused by light direction.
- White balance and exposure between angles of the same space.
- Unresolved fixes: a problem fixed in one angle but still present in another (a cabinet closed in one and open in another; a hose removed in one and visible in another).
- Architecture consistency: a window, door, fixture or feature present in one view but missing or different in another view that should show it.

MODE OVERVIEW (thumbnails of the whole gallery):
- White balance and exposure across similar rooms and between adjacent rooms.
- Editing style mix: a different HDR look, contrast, saturation or sky style among related photos.
- Unedited or RAW-looking files: flat, dark or uncorrected, blown windows, crooked verticals, unlike the rest.
- Possible wrong-property photos: architecture, finishes, exterior or layout that do not fit the rest of the gallery.
- Inconsistent virtual staging: some angles of a room staged and others empty, or different furniture in the same room.
- Sharpness or resolution outliers (use the dimensions in <cv_stats>).

BOTH MODES
Review every pair in <duplicate_candidates> and record a duplicateReview. A duplicate offers no useful distinction. A different angle, focal length, lighting (day vs twilight), staging state or orientation (a vertical crop for social media) is a useful distinction.
Do not report dust; another pass handles it.

REFERENCE PHOTO
For every drift or mismatch finding, name as referencePhotoId the photo most likely to show the true appearance: the one where known-neutral surfaces (white ceilings, trim, outlets) look neutral and that agrees with most other angles. Never choose a reference because it looks more attractive. If you cannot tell which rendering is correct, set referenceCertain false, give your best guess or null, and include the exact words "flag for verification against originals" in recommendedAction.

HUB DATA
<cv_stats> are code measurements per photo. Use them as evidence; your visual judgement decides. A large b* difference supports a warm or cool cast; a low L* outlier supports an exposure mismatch. <edit_context> lists the AutoHDR history per photo; a photo re-rendered with a different style is a likely source of style mix.

FIELDS
affectedPhotoIds: every photo that needs action, never the reference.
groupKey: lowercase kebab-case for the underlying problem ("island-color-kitchen", "white-balance-bedrooms").
fixStrategy: STYLE_RERENDER or REEDIT_PROMPT for cast or exposure mismatches; EDITOR_MANUAL to color-match across angles; HUMAN_REVIEW when the true color is unknown; ADMIN_ACTION for a possible wrong-property photo; REVERT_VERSION when <edit_context> shows an earlier version matched the gallery.
responsibility: EDITOR for processing differences; PHOTOGRAPHER for capture differences (missing angle, inconsistent framing); ADMIN for wrong-property photos and file mix-ups.
Severity follows the rule defaults: materially wrong or inconsistent material color within one room and wrong-property photos are CRITICAL; cast, exposure and style mismatches, unedited files and unresolved fixes are MAJOR; small style differences are MINOR.`;

const USER = `Image 1: {{photoId}} | position {{galleryPosition}} | {{roomType}} | sent {{sentW}}x{{sentH}}
[image]
Image 2: ...
[image]
...

<cluster mode="{{mode}}" label="{{clusterLabel}}" photos="{{photoCount}}" />

<property>
{{address}} | {{propertyType}} | {{beds}} bd | {{baths}} ba
</property>

<cv_stats>
photoId | full size | L* | a* | b* | dE vs cluster median | blur | highlight clip %
{{cvStatsRows}}
</cv_stats>

<duplicate_candidates>
{{duplicateCandidates}}
</duplicate_candidates>

<edit_context>
{{editContextRows}}
</edit_context>

<client_profile>
{{clientQcProfileNotes}}
</client_profile>

Compare these photos.`;

export const P2_GALLERY_V1: PromptDef = {
  id: "P2_GALLERY",
  version: 1,
  constName: "P2_GALLERY_V1",
  core: "RP_CORE_V1",
  slot: "P2",
  maxTokens: 4000,
  temperature: 0,
  cache: true,
  shape: { thinking: "adaptive", effort: "low" },
  timeoutMs: 180_000,
  startMinMs: 90_000,
  system: joinSystem(RP_CORE_V1, P2_BLOCK),
  userTemplate: USER,
  changelog: "v1 (2026-10-13): prompt pack 4.2 to 4.4.",
};

export const P2_OVERVIEW_MAX_TOKENS = 6000;
/** The label line rendered before each image ("Image {{n}}: ph_03 | ..."). */
export const P2_LABEL = imageLabelTemplate(USER);
/** The text sent after the images. */
export const P2_TEXT = textAfterImages(USER);

export const GALLERY_CHECKS = [
  "MATERIAL_COLOR", "WHITE_BALANCE", "EXPOSURE", "SKY_STYLE", "EDITING_STYLE", "DUPLICATES", "WRONG_PROPERTY",
  "UNEDITED_FILES", "VIRTUAL_STAGING", "ARCHITECTURE_CONSISTENCY", "UNRESOLVED_FIXES", "SHARPNESS_RESOLUTION",
] as const;
export const ISSUE_TYPES = [
  "CABINET_COLOR_DRIFT", "ISLAND_COLOR_DRIFT", "WALL_COLOR_DRIFT", "FLOOR_COLOR_DRIFT", "COUNTERTOP_OR_STONE_COLOR_DRIFT",
  "EXTERIOR_COLOR_DRIFT", "WHITE_BALANCE_MISMATCH", "EXPOSURE_MISMATCH", "SKY_STYLE_MISMATCH", "EDITING_STYLE_MIX",
  "POSSIBLE_WRONG_PROPERTY", "UNEDITED_FILE_MIXED_IN", "INCONSISTENT_VIRTUAL_STAGING", "ARCHITECTURE_MISMATCH",
  "UNRESOLVED_FIX_IN_SOME_ANGLES", "SHARPNESS_OR_RESOLUTION_OUTLIER", "OTHER",
] as const;

/** 4.4, verbatim; `__INJECTED_RULE_IDS__` becomes the sorted P2 ids plus OTHER_DEFECT. */
export function p2JsonSchema(ruleIds: string[]) {
  return wireSchema({
    type: "object",
    additionalProperties: false,
    required: ["findings", "duplicateReviews", "checksPerformed", "checksSkipped"],
    properties: {
      findings: { type: "array", items: { $ref: "#/$defs/GalleryFinding" } },
      duplicateReviews: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["photoIds", "reason", "isDuplicate", "keepPhotoId"],
          properties: {
            photoIds: { type: "array", items: { type: "string" }, description: "The candidate pair, exactly 2 ids." },
            reason: { type: "string" },
            isDuplicate: { type: "boolean" },
            keepPhotoId: { anyOf: [{ type: "string" }, { type: "null" }], description: "Better photo of a duplicate pair; null if not a duplicate." },
          },
        },
      },
      checksPerformed: { type: "array", items: { $ref: "#/$defs/GalleryCheck" } },
      checksSkipped: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["check", "reason"],
          properties: {
            check: { $ref: "#/$defs/GalleryCheck" },
            reason: { type: "string" },
          },
        },
      },
    },
    $defs: {
      GalleryCheck: { type: "string", enum: [...GALLERY_CHECKS] },
      GalleryFinding: {
        type: "object",
        additionalProperties: false,
        required: ["ruleId", "issueType", "groupKey", "affectedPhotoIds", "referencePhotoId", "referenceCertain", "explanation", "severity", "confidence", "fixStrategy", "responsibility", "recommendedAction"],
        properties: {
          ruleId: { type: "string", enum: ruleIds },
          issueType: { type: "string", enum: [...ISSUE_TYPES] },
          groupKey: { type: "string" },
          // The pack's `minItems: 1` is enforced by zod: structured outputs do
          // not accept array-length constraints (wireSchema strips it).
          affectedPhotoIds: { type: "array", items: { type: "string" }, minItems: 1 },
          referencePhotoId: { anyOf: [{ type: "string" }, { type: "null" }] },
          referenceCertain: { type: "boolean" },
          explanation: { type: "string" },
          severity: { type: "string", enum: ["CRITICAL", "MAJOR", "MINOR"] },
          confidence: { type: "number", description: "0.0 to 1.0" },
          fixStrategy: { type: "string", enum: ["AUTOREMOVE_MASK", "DECLUTTER", "REEDIT_PROMPT", "CAMERA_REMOVAL", "GRASS", "STYLE_RERENDER", "REVERT_VERSION", "EDITOR_MANUAL", "RESHOOT", "ADMIN_ACTION", "HUMAN_REVIEW", "NONE"] },
          responsibility: { type: "string", enum: ["PHOTOGRAPHER", "EDITOR", "ADMIN", "HUMAN_REVIEW"] },
          recommendedAction: { type: "string" },
        },
      },
    },
  });
}

export const P2Loose = z.object({
  findings: z.array(z.object({
    ruleId: z.string(),
    issueType: z.string(),
    groupKey: z.string(),
    affectedPhotoIds: z.array(z.string()),
    referencePhotoId: z.string().nullable(),
    referenceCertain: z.boolean(),
    explanation: z.string(),
    severity: SeverityZ,
    confidence: z.number(),
    fixStrategy: FixStrategyZ,
    responsibility: ResponsibilityZ,
    recommendedAction: z.string(),
  })),
  duplicateReviews: z.array(z.object({
    photoIds: z.array(z.string()),
    reason: z.string(),
    isDuplicate: z.boolean(),
    keepPhotoId: z.string().nullable(),
  })),
  checksPerformed: z.array(z.string()),
  checksSkipped: z.array(z.object({ check: z.string(), reason: z.string() })),
});
export type P2LooseT = z.infer<typeof P2Loose>;

/** 4.4's zod (makeP2Schema), applied after the repairs. */
export const makeP2Schema = (c: { photoIds: Set<string>; dupPairs: Set<string>; rules: Map<string, InjectedRule> }) =>
  z.object({
    findings: z.array(z.object({
      ruleId: z.string(), issueType: z.string(), groupKey: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
      affectedPhotoIds: z.array(z.string()).min(1), referencePhotoId: z.string().nullable(),
      referenceCertain: z.boolean(), explanation: z.string().max(800), severity: SeverityZ, confidence: unit,
      fixStrategy: FixStrategyZ, responsibility: ResponsibilityZ, recommendedAction: z.string().max(400),
    }).superRefine((f, ctx) => {
      const issue = (message: string) => ctx.addIssue({ code: "custom", message });
      if (!f.affectedPhotoIds.every((id) => c.photoIds.has(id))) issue("unknown photo id");
      if (f.referencePhotoId && !c.photoIds.has(f.referencePhotoId)) issue("unknown reference id");
      if (f.referencePhotoId && f.affectedPhotoIds.includes(f.referencePhotoId)) issue("reference listed as affected");
      if (!f.referenceCertain && !f.recommendedAction.toLowerCase().includes(VERIFY_PHRASE)) issue("missing verify phrase");
      const rule = c.rules.get(f.ruleId);
      if (rule && !allowedSeveritiesOf(rule).has(f.severity)) issue("severity outside rule range");
    })),
    duplicateReviews: z.array(z.object({
      photoIds: z.array(z.string()).length(2), reason: z.string().max(300),
      isDuplicate: z.boolean(), keepPhotoId: z.string().nullable(),
    }).superRefine((d, ctx) => {
      if (!c.dupPairs.has([...d.photoIds].sort().join("|"))) ctx.addIssue({ code: "custom", message: "pair was not a candidate" });
      if (d.isDuplicate !== (d.keepPhotoId !== null)) ctx.addIssue({ code: "custom", message: "keepPhotoId iff duplicate" });
      if (d.keepPhotoId && !d.photoIds.includes(d.keepPhotoId)) ctx.addIssue({ code: "custom", message: "keep id not in pair" });
    })),
    checksPerformed: z.array(z.string()),
    checksSkipped: z.array(z.object({ check: z.string(), reason: z.string() })),
  });
export type P2Output = z.infer<ReturnType<typeof makeP2Schema>>;
export type P2Finding = P2Output["findings"][number];
