import { z } from "zod";
import {
  RoomTypeZ,
  SequenceGroupZ,
  noLongDashes,
  score100,
  textAfterImages,
  unit,
  wireSchema,
  wordCount,
  type PromptDef,
} from "./shared";

// ---------------------------------------------------------------------------
// P0_CLASSIFY_V1: room classification and description (prompt pack 1).
// Haiku, one photo at qc1024, temperature 0, max_tokens 600, cached system.
// Its output labels every photo so P1 gets room-aware rules, the gallery gets
// a suggested order, P4 can reason about coverage.
// System prompt and user template are VERBATIM from the pack (1.2, 1.3).
// ---------------------------------------------------------------------------

const SYSTEM = `You classify and describe finished real estate photos for Realtour Pilot, a premium real estate media company. Your output drives room-aware quality control, gallery ordering and order-coverage checks, so accuracy matters more than flattery.

For the photo, return:
- roomType: the single best label for what the frame mainly shows.
- roomConfidence (0.0 to 1.0) and alternateRoomType: the runner-up label, or null when roomConfidence is 0.85 or higher.
- isAerial, isTwilight, isVirtuallyStaged, isExteriorPrimaryCandidate.
- description, features, heroScore, sequenceGroup as defined below.

LABELING GUIDE
- EXTERIOR_FRONT: street-facing side; front door, porch or garage door usually visible. EXTERIOR_REAR: back of the house, deck or yard side. EXTERIOR_SIDE: side elevation.
- AERIAL: drone viewpoint clearly above the roofline. Aerials stay AERIAL at dusk (set isTwilight true).
- TWILIGHT_EXTERIOR: ground-level exterior at dusk, or with a virtual dusk sky and glowing windows. Set isTwilight true.
- PATIO_DECK, POOL_SPA, YARD: outdoor living spaces where the house itself is secondary.
- COMMUNITY_AMENITY: shared facilities that are not part of the lot (clubhouse, community pool, fitness room, playground, entrance signage). If unsure whether a pool is private, use POOL_SPA and lower confidence.
- LIVING vs FAMILY: LIVING is the main or more formal sitting room; FAMILY is a second, casual living area, often open to the kitchen. If the home appears to have one sitting area, use LIVING.
- KITCHEN when cabinets, counters or appliances dominate; DINING when the table is the subject, even if the kitchen is visible.
- PRIMARY_BEDROOM and PRIMARY_BATHROOM only with visible cues (largest bedroom, sitting area or en-suite door; double vanity with separate tub and shower). Otherwise use BEDROOM or BATHROOM and set the primary label as alternateRoomType.
- POWDER_ROOM: toilet and sink, no tub or shower visible.
- BASEMENT_UNFINISHED shows exposed joists, concrete walls or floors, or open mechanicals; otherwise BASEMENT_FINISHED when below-grade cues are visible.
- OFFICE when a desk is the focus. CLOSET, HALLWAY, STAIRCASE, ENTRY_FOYER by subject.
- DETAIL: a close-up of a fixture, finish or feature rather than a room.
- OTHER: any other space (bonus room, gym, theater, sunroom); name the space in the description.
Order context in the message is a prior, not evidence. Label what you see.

FLAGS
- isVirtuallyStaged: true only when furniture or decor shows clear rendering signs (missing contact shadows, impossible scale, uniform computer-generated textures). You cannot reliably detect AI-generated images, so when unsure answer false. The hub combines this with order data.
- isExteriorPrimaryCandidate: true for a ground-level or aerial exterior that shows the whole front of the home, roofline and chimney intact, reasonably straight lines, no major obstruction.

DESCRIPTION
- One or two neutral, factual sentences, at most 45 words, describing the space and its visible elements.
- No marketing language (stunning, gorgeous, beautiful, luxurious, dream, boasts, nestled, perfect, spacious, cozy) and no negative judgements (dated, small, cramped).
- Nothing that is not visible: no room counts, sizes, brands, ages, renovations, views or neighborhood claims.
- Do not guess materials you cannot verify. Write "stone countertops" rather than guessing quartz, granite or marble, and "wood-look flooring" when hardwood is not certain. Describe uncertain colors cautiously ("a dark island"), never as fact you cannot see.
- Never describe people beyond "a person is visible".

FEATURES
Zero to eight short lowercase noun phrases naming notable, clearly visible selling features ("vaulted ceiling", "center island with seating", "fireplace", "covered front porch", "in-ground pool"). The same material caution applies. Skip ordinary elements (walls, a door, a window).

HERO SCORE (0 to 100): suitability as the gallery's lead image.
85 to 100: front or aerial exterior showing the whole home, straight lines, good light, clean foreground, roofline intact.
65 to 84: strong exterior with a minor issue, or an outstanding main living or kitchen photo.
40 to 64: a good room photo that is not a lead image.
0 to 39: utility spaces, closets, details, or photos with obvious problems.

SEQUENCE GROUP (delivery order)
FRONT_EXTERIOR (front and front twilight), ENTRY, MAIN_LIVING (living, family, dining), KITCHEN, PRIMARY_SUITE (primary bedroom, bath, closet), BEDROOMS, BATHROOMS (including powder rooms), FLEX (office, bonus, other interior), LOWER_LEVEL (basement), UTILITY (laundry, garage, storage), OUTDOOR_LIVING (patio, deck, pool, yard), REAR_EXTERIOR (rear and side), AERIAL, COMMUNITY, DETAIL.`;

const USER = `[image: qc1024 of {{photoId}}]

Photo id: {{photoId}} | file: {{filename}} | sent size: {{sentWidth}}x{{sentHeight}} px
Property: {{propertyType}} in {{city}}, {{state}} | listing: {{beds}} bd, {{baths}} ba, {{sqft}} sqft
Order context: twilight ordered {{twilightOrdered}}; virtual staging ordered {{stagingOrdered}}; drone ordered {{droneOrdered}}

Classify and describe this photo.`;

export const P0_CLASSIFY_V1: PromptDef = {
  id: "P0_CLASSIFY",
  version: 1,
  constName: "P0_CLASSIFY_V1",
  core: null,
  slot: "P0",
  maxTokens: 600,
  temperature: 0,
  cache: true,
  shape: { thinking: "off" },
  timeoutMs: 60_000,
  startMinMs: 20_000,
  system: SYSTEM,
  userTemplate: USER,
  changelog: "v1 (2026-10-13): prompt pack 1.2 to 1.4.",
};

/** The text sent after the image. */
export const P0_TEXT = textAfterImages(USER);

/** 1.4, verbatim. */
export function p0JsonSchema() {
  return wireSchema({
    type: "object",
    additionalProperties: false,
    required: ["roomType", "roomConfidence", "alternateRoomType", "isAerial", "isTwilight", "isVirtuallyStaged", "isExteriorPrimaryCandidate", "description", "features", "heroScore", "sequenceGroup"],
    properties: {
      roomType: { $ref: "#/$defs/RoomType" },
      roomConfidence: { type: "number", description: "0.0 to 1.0: probability that roomType is correct." },
      alternateRoomType: { anyOf: [{ $ref: "#/$defs/RoomType" }, { type: "null" }], description: "Runner-up label; null when roomConfidence is 0.85 or higher." },
      isAerial: { type: "boolean" },
      isTwilight: { type: "boolean" },
      isVirtuallyStaged: { type: "boolean", description: "True only with clear rendering signs. A hint; order data is authoritative." },
      isExteriorPrimaryCandidate: { type: "boolean", description: "Exterior that could lead the gallery." },
      description: { type: "string", description: "1 or 2 neutral factual sentences, at most 45 words." },
      features: { type: "array", items: { type: "string" }, description: "0 to 8 short lowercase noun phrases of clearly visible selling features." },
      heroScore: { type: "integer", description: "0 to 100: suitability as the gallery lead image." },
      sequenceGroup: { type: "string", enum: ["FRONT_EXTERIOR", "ENTRY", "MAIN_LIVING", "KITCHEN", "PRIMARY_SUITE", "BEDROOMS", "BATHROOMS", "FLEX", "LOWER_LEVEL", "UTILITY", "OUTDOOR_LIVING", "REAR_EXTERIOR", "AERIAL", "COMMUNITY", "DETAIL"] },
    },
    $defs: {
      RoomType: { type: "string", enum: ["EXTERIOR_FRONT", "EXTERIOR_REAR", "EXTERIOR_SIDE", "AERIAL", "TWILIGHT_EXTERIOR", "PATIO_DECK", "POOL_SPA", "YARD", "COMMUNITY_AMENITY", "ENTRY_FOYER", "LIVING", "FAMILY", "DINING", "KITCHEN", "OFFICE", "BEDROOM", "PRIMARY_BEDROOM", "BATHROOM", "PRIMARY_BATHROOM", "POWDER_ROOM", "LAUNDRY", "GARAGE", "BASEMENT_FINISHED", "BASEMENT_UNFINISHED", "STORAGE", "HALLWAY", "STAIRCASE", "CLOSET", "DETAIL", "OTHER"] },
    },
  });
}

export const MARKETING = /\b(stunning|gorgeous|beautiful|breathtaking|luxurious|dream|boasts|nestled|perfect|amazing|spacious|cozy)\b/gi;

/** 1.4's zod, applied AFTER the deterministic repairs (normalize.ts). */
export const P0OutputStrict = z.object({
  roomType: RoomTypeZ,
  roomConfidence: unit,
  alternateRoomType: RoomTypeZ.nullable(),
  isAerial: z.boolean(),
  isTwilight: z.boolean(),
  isVirtuallyStaged: z.boolean(),
  isExteriorPrimaryCandidate: z.boolean(),
  description: z.string().min(10)
    .refine((s) => wordCount(s) <= 45, "description over 45 words")
    .refine((s) => !new RegExp(MARKETING.source, "i").test(s), "marketing language")
    .refine(noLongDashes, "long dash"),
  features: z.array(z.string().min(2).max(48)).max(8),
  heroScore: score100,
  sequenceGroup: SequenceGroupZ,
}).superRefine((o, ctx) => {
  if (o.roomConfidence >= 0.85 && o.alternateRoomType) ctx.addIssue({ code: "custom", message: "alternate must be null" });
  if (o.roomType === "AERIAL" && !o.isAerial) ctx.addIssue({ code: "custom", message: "AERIAL implies isAerial" });
  if (o.roomType === "TWILIGHT_EXTERIOR" && !o.isTwilight) ctx.addIssue({ code: "custom", message: "twilight flag" });
});
export type P0Output = z.infer<typeof P0OutputStrict>;

/** Structure only (types and enums): what repair can work from. */
export const P0OutputLoose = z.object({
  roomType: RoomTypeZ,
  roomConfidence: z.number(),
  alternateRoomType: RoomTypeZ.nullable(),
  isAerial: z.boolean(),
  isTwilight: z.boolean(),
  isVirtuallyStaged: z.boolean(),
  isExteriorPrimaryCandidate: z.boolean(),
  description: z.string(),
  features: z.array(z.string()),
  heroScore: z.number(),
  sequenceGroup: SequenceGroupZ,
});
