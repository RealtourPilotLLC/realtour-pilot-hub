import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { autohdr, autohdrConfigured, AutohdrError } from "@/lib/integrations/autohdr";
import { photoDeliverySettings } from "./settings";
import { logJobEvent, setStage } from "./jobState";
import { ruleById, RULES_REGISTRY_VERSION, type RoomType } from "./registry";
import { jobVerdict, photoVerdicts, qcStageFor } from "./qc/verdict";
import { disabledIn, houseOverrides } from "./houseRules";
import { fixClass, instructionFor, refreshVerdict, shootIdOf as shootOf } from "./fixPolicy";
import { overridesFor } from "./decisions";

// ---------------------------------------------------------------------------
// THE FREE PHOTO CHECK (Oct 14 2026).
//
// Jordan: "As long as QC is free, that's fine" and "check if AutoHDR offers
// the QC through their API". It does not: the API (and its MCP server, the
// same 20 tools) has no QC. It has `describe`: "AI eyes for an agent ...
// Read-only and free (no credits)", which answers a question about a photo
// still sitting in AutoHDR, no download needed. So the hub asks each edited
// photo one checklist question built from the QC rule registry and files what
// comes back as ordinary findings (same rule ids, severities and review
// screens as the paid QC).
//
// Tried on 2236 Gregory Dr before building (Oct 14): it named the cleaning
// bottles, the tools and paint tray, the neighbour's cars, the bins and the
// hose on 3 of 4 photos the paid QC had flagged, and missed one low-confidence
// hose. About 6-9 seconds a photo.
//
// It needs the photo's AutoHDR id: the hub-sent shoots have it from the start
// (intake.ts), and the link step maps a hand-made shoot's photos (by name, or
// "(N of M)" position). A photo it could not look at (no id, or no answer after
// three tries) is never a pass: it becomes an issue for a person.
//
// A photo it looked at counts as inspected at that version (inspectedHash),
// like the paid QC's own inspection, so the delivery checklist can pass on the
// free check alone. When the gallery changes after the check (photos added in
// a later batch, or replaced), it runs again on the new and changed photos
// only; the others keep their findings.
// ---------------------------------------------------------------------------

const CHECK_RULES = [
  "BATH_TOILET_SEAT_OPEN", "BATH_TOILET_BRUSH_PLUNGER", "BATH_TRASH_CANS", "BATH_DIRTY_WET_TOWELS", "BATH_SHOWER_SHELF_TOILETRIES", "BATH_CLEANING_SUPPLIES",
  "KIT_DIRTY_DISHES_SINK", "KIT_DISHES_ON_COUNTERS", "KIT_EXCESSIVE_COUNTERTOP_ITEMS", "KIT_OPEN_APPLIANCE_DOORS", "KIT_PAPER_TOWEL_ROLLS",
  "PREP_TRASH_CANS", "PREP_GARBAGE_BAGS_LOOSE_TRASH", "PREP_CLEANING_SUPPLIES", "PREP_VACUUM_CLEANING_EQUIPMENT", "PREP_LOOSE_CORDS_CABLES", "PREP_PERSONAL_PHOTOS",
  "PREP_PERSONAL_DOCUMENTS", "PREP_PET_ITEMS", "PREP_CONSTRUCTION_PAINTING_MATERIALS", "PREP_VISIBLE_PEOPLE_PETS", "PREP_INCONSISTENT_BLINDS",
  "BED_UNMADE", "BED_CLOTHES_LEFT_OUT", "BED_CHILDRENS_TOYS", "BED_LAUNDRY_HAMPERS",
  "LIV_TV_UNINTENDED_CONTENT", "LIV_TV_GLARE",
  "EXT_TRASH_CANS_PRIMARY", "EXT_GARDEN_HOSES", "EXT_HOSE_REELS", "EXT_PARKED_CARS_DRIVEWAY", "EXT_VEHICLES_BLOCKING_HOME", "EXT_PHOTOGRAPHER_VEHICLE",
  "EXT_CHILDRENS_OUTDOOR_TOYS", "EXT_CONSTRUCTION_MATERIALS", "EXT_OPEN_GARAGE_DOORS",
  "REFL_PHOTOGRAPHER_IN_MIRROR", "REFL_CAMERA_TRIPOD_IN_MIRROR", "REFL_PHOTOGRAPHER_IN_GLASS", "REFL_PHOTOGRAPHER_SHADOW", "REFL_TRIPOD_EQUIPMENT_SHADOW", "REFL_SENSOR_DUST",
  "PERSP_CROOKED_VERTICALS", "PERSP_LEANING_DOOR_FRAMES", "PERSP_EXTERIOR_WALLS_LEANING", "PERSP_CROOKED_HORIZON", "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED",
  "UTIL_GARAGE_TRASH_CANS", "LIV_OFFICE_TRASH_CANS", "EXT_VEHICLES_THROUGH_WINDOWS",
  "EXPO_BLOWN_WINDOWS", "EXPO_OVERLY_DARK_INTERIORS", "EXPO_HDR_HALOS", "EXPO_BURNED_OUT_BULBS",
  "COLOR_GREEN_MAGENTA_CAST", "COLOR_SATURATED_GRASS_TREES", "SKY_OVERSATURATED", "SKY_HALOS_TREES_ROOFLINES",
  "COMP_BLURRY", "COMP_MOTION_BLUR",
  // Oct 15 2026 (Jordan: "a random broom by the door, or a toilet seat is open,
  // or a door mat is crooked ... anything that a photographer could remove from
  // the frame"): the removable things the paid QC knew and this check did not.
  "PREP_SHOES_FOOTWEAR", "LIV_REMOTE_CONTROLS", "PREP_OTHER_PERSONAL_BELONGINGS", "BATH_TOWELS_UNEVEN", "KIT_DISH_SOAP_SPONGES", "KIT_GARBAGE_CANS",
  "EXT_YARD_TOOLS", "EXT_LADDERS_TEMP_EQUIPMENT", "EXT_LOOSE_GARBAGE_DEBRIS", "PREP_CROOKED_RUGS_FURNITURE_DECOR", "PREP_DOOR_MAT_CROOKED", "PREP_LEFTOVER_ITEM_VACANT",
  // ...and warped architecture (walls, doors, windows, cabinets; never furniture).
  "PERSP_EDIT_WARP",
  // Oct 22 2026 (615 Cliff Ln, "the bedroom lamp floating in the one bedroom
  // with a crib"): an object the edit left floating, cut off or doubled.
  "AIEDIT_FLOATING_OBJECT",
] as const;

const ALLOWED = new Set<string>(CHECK_RULES);
/** 2: light + furnished (Oct 14 2026). 3: prep + features, "look for" words, the removable-things rule, warped architecture (Oct 15 2026). 4: floating objects left by the edit (Oct 22 2026). */
export const CHECK_PROMPT_VERSION = 4;
const PER_PHOTO_TRIES = 3;
const CONCURRENCY = 4;

/**
 * What to look for, in the words the photo is checked with (Oct 15 2026: the
 * registry's short labels alone, "Cleaning supplies", never named the broom).
 * Ids not listed here are asked with their short label.
 */
export const LOOK_FOR: Partial<Record<(typeof CHECK_RULES)[number], string>> = {
  BATH_TOILET_SEAT_OPEN: "a toilet seat or lid left up",
  BATH_TOILET_BRUSH_PLUNGER: "a toilet brush or plunger in view",
  BATH_TRASH_CANS: "a bathroom trash can",
  BATH_DIRTY_WET_TOWELS: "towels crumpled, wet, on the floor or thrown over the shower or tub",
  BATH_TOWELS_UNEVEN: "hanging towels uneven or messy",
  BATH_SHOWER_SHELF_TOILETRIES: "shampoo bottles, razors or loofahs in the shower or on the tub",
  BATH_CLEANING_SUPPLIES: "cleaning bottles, sponges or a bucket in the bathroom",
  KIT_DIRTY_DISHES_SINK: "dishes in the sink",
  KIT_DISHES_ON_COUNTERS: "dishes, cups or bottles left on the counters",
  KIT_EXCESSIVE_COUNTERTOP_ITEMS: "counters crowded with small items",
  KIT_OPEN_APPLIANCE_DOORS: "a dishwasher, oven, fridge or microwave door left open",
  KIT_PAPER_TOWEL_ROLLS: "a paper towel roll on the counter",
  KIT_DISH_SOAP_SPONGES: "dish soap, sponges or brushes at the sink",
  KIT_GARBAGE_CANS: "a kitchen trash or recycling can",
  PREP_TRASH_CANS: "a trash or recycling bin",
  PREP_GARBAGE_BAGS_LOOSE_TRASH: "garbage bags, wrappers, cups or other small trash",
  PREP_CLEANING_SUPPLIES: "a broom, mop, dustpan, bucket, spray bottles or rags left out",
  PREP_VACUUM_CLEANING_EQUIPMENT: "a vacuum or steam mop left out",
  PREP_LOOSE_CORDS_CABLES: "loose cords, chargers or extension cables",
  PREP_PERSONAL_PHOTOS: "family photos showing people's faces",
  PREP_PERSONAL_DOCUMENTS: "mail, papers or documents you could read",
  PREP_PET_ITEMS: "pet bowls, beds, crates or toys",
  PREP_CONSTRUCTION_PAINTING_MATERIALS: "paint cans, tools, drop cloths or materials inside",
  PREP_VISIBLE_PEOPLE_PETS: "a person or pet in the frame",
  PREP_INCONSISTENT_BLINDS: "window blinds at different heights in one room",
  PREP_SHOES_FOOTWEAR: "shoes or boots on floors, stairs, mats or furniture",
  PREP_OTHER_PERSONAL_BELONGINGS: "personal items left out: toiletry bags, keys, purses, medicine, sports gear",
  PREP_CROOKED_RUGS_FURNITURE_DECOR: "an area rug or runner sitting visibly crooked",
  PREP_DOOR_MAT_CROOKED: "a door mat crooked, flipped up or bunched at a door, inside or on the porch",
  PREP_LEFTOVER_ITEM_VACANT: "in an EMPTY room only: any loose item left behind (a bag, box, bottle, tool, cord, paper or trash)",
  LIV_REMOTE_CONTROLS: "TV remotes on tables or sofas",
  BED_UNMADE: "a bed unmade or messy",
  BED_CLOTHES_LEFT_OUT: "clothes on beds, chairs or floors",
  BED_CHILDRENS_TOYS: "toys left out",
  BED_LAUNDRY_HAMPERS: "laundry hampers or piles of laundry",
  EXT_TRASH_CANS_PRIMARY: "trash or recycling bins outside (curb, driveway, by the garage)",
  EXT_GARDEN_HOSES: "a garden hose on the lawn, beds or walkway",
  EXT_HOSE_REELS: "a hose reel",
  EXT_CHILDRENS_OUTDOOR_TOYS: "kids' toys or bikes left in the yard",
  EXT_CONSTRUCTION_MATERIALS: "lumber, buckets, bags of mulch or building debris outside",
  EXT_YARD_TOOLS: "rakes, shovels, wheelbarrows or buckets outside",
  EXT_LADDERS_TEMP_EQUIPMENT: "a ladder or temporary equipment outside",
  EXT_LOOSE_GARBAGE_DEBRIS: "loose trash, bags or debris on the lawn, driveway or porch",
  EXT_OPEN_GARAGE_DOORS: "a garage door left open",
  PERSP_CROOKED_VERTICALS: "wall corners or edges leaning instead of straight up and down",
  PERSP_LEANING_DOOR_FRAMES: "door frames leaning",
  PERSP_EXTERIOR_WALLS_LEANING: "the house's corners or walls leaning",
  PERSP_CROOKED_HORIZON: "a tilted horizon outside",
  PERSP_AUTOHDR_ROOF_PEAKS_CROPPED: "outside: the top of the roof (peak, ridge or chimney) cut off by the top edge of the photo",
  PERSP_EDIT_WARP: "walls, door frames, windows or cabinets that look bent, curved or wedge-shaped (architecture only, never furniture)",
  AIEDIT_FLOATING_OBJECT: "a lamp, piece of furniture or decor floating with nothing under it (no table, floor or shelf), an object cut off in mid-air, or the same object twice or as a faint ghost copy",
};

/** What the photo shows that the room coverage check needs (coverage.ts). */
export const CHECK_FEATURES = ["shower", "tub", "shower_in_background", "tub_in_background", "toilet", "vanity", "kitchen_island", "fireplace", "pool"] as const;
const PREPS = ["staged", "tidy", "lived_in", "cluttered", "empty"];

/** The one question every photo is asked. Built from the registry and the words above; a switched-off check is left out. */
export function checkPrompt(off: Set<string> = new Set()): string {
  const lines = CHECK_RULES.filter((id) => !off.has(id)).map((id) => `${id}: ${LOOK_FOR[id] ?? ruleById(id)?.shortLabel ?? id.toLowerCase().replace(/_/g, " ")}`);
  return [
    "You are checking a real estate listing photo before it goes to the client.",
    'Answer ONLY with JSON: {"room":"<room type>","light":"day|twilight|night","furnished":"empty|sparse|furnished","prep":"staged|tidy|lived_in|cluttered|empty","features":["<from the feature list>"],"issues":[{"id":"<one id from the list>","where":"<short location in the frame>","confidence":<0 to 1>}]}.',
    'room: the space shown, for example "front exterior", "rear exterior", "kitchen", "living room", "primary bedroom", "bedroom", "primary bathroom", "bathroom", "powder room". Say primary only for the main suite.',
    "light: twilight = shot at dusk with a sunset or dusk sky and lights on. furnished: for an interior, how much furniture is in the room.",
    "prep: how ready the space looks. staged = styled like a show home; tidy = clean and put away (one or two stray things still count as tidy); lived_in = everyday things out in several places; cluttered = messy, piles, things everywhere; empty = no furniture. For an outside photo, judge the yard, driveway and porch.",
    `features: only these, when this photo shows them: ${CHECK_FEATURES.join(", ")}. shower or tub = it is a main subject of the photo; shower_in_background or tub_in_background = it only shows in the background, partly, or through a doorway.`,
    "Clutter and distractions: report only things a photographer could have moved out of the frame, never furniture, decor, appliances or anything built in. In an EMPTY room, any loose item left behind counts.",
    "Lines: report leaning or bent architecture only (walls, door frames, windows, cabinets, the house), never furniture.",
    // A check switched off house-wide is never asked about, its explanation included.
    ...(off.has("AIEDIT_FLOATING_OBJECT") ? [] : ["Editing mistakes: look at what every lamp, piece of furniture and decor item rests on. One that floats with nothing under it, ends in mid-air, or shows twice or as a ghost is AIEDIT_FLOATING_OBJECT, furniture and decor included. Never a pendant, chandelier, sconce, wall shelf or mounted TV."]),
    "Report only problems you can actually see in this photo. An empty list is a good answer.",
    "Ids:",
    ...lines,
  ].join("\n");
}

export type CheckIssue = { ruleId: string; where: string; confidence: number };

/**
 * The free check's room words ("front exterior", "primary bathroom") as the
 * hub's room type (Oct 14 2026: free-checked photos showed "Unlabeled"; the
 * paid QC's classifier no longer runs by itself). Pure.
 */
export function roomTypeFrom(text: string | null | undefined, light?: string | null): RoomType | null {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return null;
  const outside = /exterior|outside|outdoor|facade|façade|front of|house|home|porch|street/.test(t);
  if (/aerial|drone|overhead|bird/.test(t)) return "AERIAL";
  if ((light === "twilight" || light === "night") && outside) return "TWILIGHT_EXTERIOR";
  if (/pool|spa|hot tub/.test(t)) return "POOL_SPA";
  if (/patio|deck|balcony/.test(t)) return "PATIO_DECK";
  if (/(back|rear)/.test(t) && (outside || /yard/.test(t))) return "EXTERIOR_REAR";
  if (/side/.test(t) && outside) return "EXTERIOR_SIDE";
  if (/yard|garden|lawn/.test(t)) return "YARD";
  if (outside && !/room|kitchen|bath|bed/.test(t)) return "EXTERIOR_FRONT";
  if (/(primary|master)/.test(t) && /bath/.test(t)) return "PRIMARY_BATHROOM";
  if (/powder|half bath/.test(t)) return "POWDER_ROOM";
  if (/bath|shower|toilet/.test(t)) return "BATHROOM";
  if (/(primary|master)/.test(t) && /bed/.test(t)) return "PRIMARY_BEDROOM";
  if (/bed|nursery/.test(t)) return "BEDROOM";
  if (/kitchen/.test(t)) return "KITCHEN";
  if (/dining/.test(t)) return "DINING";
  if (/family|den|great room|rec room|game room/.test(t)) return "FAMILY";
  if (/living|lounge|sitting/.test(t)) return "LIVING";
  if (/office|study/.test(t)) return "OFFICE";
  if (/laundry|utility/.test(t)) return "LAUNDRY";
  if (/garage/.test(t)) return "GARAGE";
  if (/basement|cellar/.test(t)) return /unfinished/.test(t) ? "BASEMENT_UNFINISHED" : "BASEMENT_FINISHED";
  if (/entry|foyer|mudroom|vestibule/.test(t)) return "ENTRY_FOYER";
  if (/hall|corridor/.test(t)) return "HALLWAY";
  if (/stair/.test(t)) return "STAIRCASE";
  if (/closet/.test(t)) return "CLOSET";
  if (/storage|attic|shed/.test(t)) return "STORAGE";
  if (/community|amenity|clubhouse|gym|fitness/.test(t)) return "COMMUNITY_AMENITY";
  if (/detail|close-up|closeup/.test(t)) return "DETAIL";
  return "OTHER";
}

export type CheckAnswer = { room: string | null; light: string | null; furnished: string | null; prep: string | null; features: string[]; issues: CheckIssue[] };

/** Read describe's answer. Pure. Unknown ids, duplicates and junk are dropped. */
export function parseCheckAnswer(text: string, off: Set<string> = new Set()): CheckAnswer | null {
  const body = text.replace(/```(?:json)?/gi, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j: { room?: unknown; issues?: unknown; light?: unknown; furnished?: unknown; prep?: unknown; features?: unknown };
  try {
    j = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const issues: CheckIssue[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(j.issues) ? j.issues : []) {
    const r = raw as { id?: unknown; where?: unknown; confidence?: unknown };
    const id = typeof r.id === "string" ? r.id.trim().toUpperCase() : "";
    if (!ALLOWED.has(id) || off.has(id)) continue;
    const where = typeof r.where === "string" ? r.where.trim().slice(0, 200) : "";
    const key = `${id}:${where.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : 0.6;
    issues.push({ ruleId: id, where, confidence: c });
  }
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : "");
  const pick = (v: unknown, allowed: string[]) => (allowed.includes(norm(v)) ? norm(v) : null);
  const features = [...new Set((Array.isArray(j.features) ? j.features : []).map(norm).filter((f) => (CHECK_FEATURES as readonly string[]).includes(f)))];
  return { room: typeof j.room === "string" ? j.room.slice(0, 60) : null, light: pick(j.light, ["day", "twilight", "night"]), furnished: pick(j.furnished, ["empty", "sparse", "furnished"]), prep: pick(j.prep, PREPS), features, issues };
}

/**
 * kept: photos already inspected at their current version when the run began
 * (a re-check leaves them alone). prep and features: what the check saw in
 * each room (Oct 15 2026). geometry: the measured line check per photo and
 * geometryDone once it and the Original comparison finished (geometry.ts).
 */
export type Progress = {
  v?: number;
  done: Record<string, number>; errors: Record<string, number>; skipped: string[]; rooms: Record<string, string>;
  light?: Record<string, string>; furnished?: Record<string, string>; prep?: Record<string, string>; features?: Record<string, string[]>; kept?: string[];
  geometry?: Record<string, unknown>; geometryDone?: boolean;
  /** Oct 22 2026 (photo audit H5): a person's "Check again" started this run (not a changed listing). */
  asked?: boolean;
};
export const readProgress = (json: string | null | undefined): Progress => {
  try {
    const p = JSON.parse(json ?? "{}") as Partial<Progress>;
    return { v: p.v, done: p.done ?? {}, errors: p.errors ?? {}, skipped: p.skipped ?? [], rooms: p.rooms ?? {}, light: p.light ?? {}, furnished: p.furnished ?? {}, prep: p.prep ?? {}, features: p.features ?? {}, kept: p.kept ?? [], geometry: p.geometry ?? {}, geometryDone: p.geometryDone ?? false, ...(p.asked ? { asked: true } : {}) };
  } catch {
    return { done: {}, errors: {}, skipped: [], rooms: {}, kept: [] };
  }
};

type Photo = { id: string; name: string; sourceKind: string; sourceRef: string | null; autohdrImageUuid: string | null; contentHash: string | null; inspectedHash: string | null };
const inspected = (p: Pick<Photo, "contentHash" | "inspectedHash">) => !!p.contentHash && p.inspectedHash === p.contentHash;

let describeImpl: ((shootId: number, imageUuid: string, prompt: string) => Promise<string>) | null = null;
/** Drills only. */
export function __setDescribeForTests(fn: typeof describeImpl) {
  describeImpl = fn;
}
const describe = (shootId: number, imageUuid: string, prompt: string) => (describeImpl ? describeImpl(shootId, imageUuid, prompt) : autohdr.describe(shootId, imageUuid, { prompt }));

/** Give a photo the room label (and the features) the free check saw, unless the paid QC's classifier already labeled it. */
export async function labelRoom(photoId: string, room: string, light?: string | null, features?: string[] | null): Promise<void> {
  const type = roomTypeFrom(room, light);
  if (!type) return;
  const { groupOf } = await import("./qc/verdict");
  const sequenceGroup = groupOf({ id: photoId, name: "", sequence: 0, status: "ACTIVE", roomType: type, sequenceGroup: null } as Parameters<typeof groupOf>[0]);
  await prisma.photoAsset.updateMany({
    where: { id: photoId, classifiedHash: null },
    data: { roomType: type, roomConfidence: 0.7, sequenceGroup, isTwilight: type === "TWILIGHT_EXTERIOR", isAerial: type === "AERIAL", ...(features ? { featuresJson: JSON.stringify(features) } : {}) },
  });
}

export type CheckSummary = { skipped?: string; jobs: { jobId: string; checked: number; findings: number; finished: boolean; verdict?: string }[] };

/**
 * Jobs to check: a run under way, landed galleries not yet checked, then
 * (backend audit #10) checked galleries that changed since their last check
 * and have a photo not inspected at its current version, then (Oct 15 2026,
 * afterDeliveryCheck) DELIVERED jobs of the last 7 days whose listing photos
 * changed after delivery (2236 Gregory Dr's listing was replaced by a new
 * "(N of 52)" set the hub never looked at).
 */
/** The job event a person's "Check again" writes (requestFreeRecheck); the check picks the job up while it is newer than the job's last free check. */
export const FREE_RECHECK_ACTION = "free photo check requested";
/** Oct 22 2026 (photo audit H5): the stages "Check again" (and a changed gallery) re-check, a client's revision and a delivery problem included. */
export const RECHECK_STAGES = ["EDITED", "QC_REVIEW", "READY", "ON_HOLD", "FIXING", "REVISION_REQUESTED", "DELIVERY_MISMATCH"] as const;

/**
 * "Check again" (Oct 22 2026, photo audit H5): while the paid QC is off, the
 * button asked for a paid run that never came. It now asks for the FREE photo
 * check: the photos only the free check looked at are marked not inspected,
 * the job's AutoHDR photos are matched again when some are not (a free read),
 * and the check picks the job up on its next pass (jobsToCheck: a request
 * newer than the job's last free check), whatever its stage in RECHECK_STAGES.
 * Nothing is charged. Pure toward AutoHDR except the free read.
 */
export async function requestFreeRecheck(jobId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, autohdrPhotoshootId: true } });
  if (!job) return { ok: false, message: "Photo job not found." };
  if (job.stage === "EDITING" || job.stage === "EDIT_FAILED") return { ok: false, message: "The edited gallery has not landed yet, so there is nothing to check." };
  if (job.stage === "DELIVERED") return { ok: false, message: "This job is delivered. A client's request reopens it, and the check runs then." };
  if (job.stage === "QC_RUNNING" || (await prisma.photoQcRun.count({ where: { jobId, trigger: "AUTOHDR_CHECK", status: "RUNNING" } }))) return { ok: true, message: "The photo check is already running on this job." };
  if (!(RECHECK_STAGES as readonly string[]).includes(job.stage)) return { ok: false, message: "This job is not at a stage the photo check runs on. Reload the page." };
  // Photos the paid QC never inspected itself are looked at again (the free check's own marks).
  const freeOnly = (await prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE", inspectedHash: { not: null } }, select: { id: true, inspectedHash: true, classifiedHash: true } })).filter((p) => p.classifiedHash !== p.inspectedHash);
  if (freeOnly.length) await prisma.photoAsset.updateMany({ where: { id: { in: freeOnly.map((p) => p.id) } }, data: { inspectedHash: null } });
  // Photos not matched to AutoHDR yet (a listing replaced in a revision): matched again first (a free read).
  if (job.autohdrPhotoshootId && (await prisma.photoAsset.count({ where: { jobId, status: "ACTIVE", autohdrImageUuid: null } }))) {
    const { linkAutohdrShoot } = await import("./autohdrLink");
    await linkAutohdrShoot(jobId).catch((e) => console.warn("photo delivery: relink before the re-check failed", jobId, (e as Error).message));
  }
  await logJobEvent(jobId, by.slice(0, 120) || "staff", FREE_RECHECK_ACTION);
  return { ok: true, message: "The free photo check runs again on the next pass (within about 5 minutes). Nothing is charged." };
}

async function jobsToCheck(take: number, afterDelivery: boolean): Promise<string[]> {
  const linked = { some: { status: "ACTIVE", autohdrImageUuid: { not: null } } };
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  // A person's "Check again" (requestFreeRecheck), newer than the job's last free check.
  const asked = await prisma.photoJobEvent.findMany({ where: { action: FREE_RECHECK_ACTION, at: { gte: weekAgo } }, orderBy: { at: "asc" }, select: { jobId: true, at: true }, take: 50 });
  const askedJobs = asked.length
    ? await prisma.photoJob.findMany({
        where: { id: { in: [...new Set(asked.map((a) => a.jobId))] }, stage: { in: [...RECHECK_STAGES] } },
        select: { id: true, qcRuns: { where: { trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } } },
      })
    : [];
  const lastAsk = new Map<string, Date>();
  for (const a of asked) lastAsk.set(a.jobId, a.at);
  const requested = askedJobs.filter((j) => !j.qcRuns[0] || j.qcRuns[0].startedAt < lastAsk.get(j.id)!).map((j) => j.id);
  const [running, landed, changed, delivered] = await Promise.all([
    prisma.photoQcRun.findMany({ where: { trigger: "AUTOHDR_CHECK", status: "RUNNING" }, orderBy: { startedAt: "asc" }, select: { jobId: true }, take }),
    prisma.photoJob.findMany({
      where: { stage: "EDITED", photos: linked },
      orderBy: { stageChangedAt: "asc" },
      select: { id: true, finalsChangedAt: true, qcRuns: { where: { trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } } },
      take: take * 3,
    }),
    // Oct 22 2026 (photo audit H5): a revision or a delivery problem whose gallery changed is checked again too.
    prisma.photoJob.findMany({
      where: { stage: { in: ["QC_REVIEW", "READY", "REVISION_REQUESTED", "DELIVERY_MISMATCH"] }, finalsChangedAt: { gte: new Date(Date.now() - 7 * 86_400_000) }, qcRuns: { some: { trigger: "AUTOHDR_CHECK", status: "DONE" } }, photos: linked },
      orderBy: { finalsChangedAt: "desc" },
      select: {
        id: true, finalsChangedAt: true,
        qcRuns: { where: { trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } },
        photos: { where: { status: "ACTIVE", autohdrImageUuid: { not: null } }, select: { contentHash: true, inspectedHash: true } },
      },
      take: 20,
    }),
    afterDelivery
      ? prisma.photoJob.findMany({
          where: { stage: "DELIVERED", stageChangedAt: { gte: weekAgo }, finalsChangedAt: { gte: weekAgo }, photos: linked },
          orderBy: { finalsChangedAt: "desc" },
          select: {
            id: true, finalsChangedAt: true, stageChangedAt: true,
            qcRuns: { where: { trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } },
            photos: { where: { status: "ACTIVE", autohdrImageUuid: { not: null } }, select: { contentHash: true, inspectedHash: true } },
          },
          take: 10,
        })
      : Promise.resolve([]),
  ]);
  const since = (j: { finalsChangedAt: Date | null; qcRuns: { startedAt: Date }[] }) => !j.qcRuns[0] || (!!j.finalsChangedAt && j.finalsChangedAt > j.qcRuns[0].startedAt);
  // After delivery: only a gallery that changed AFTER the job was delivered.
  const afterIt = delivered.filter((j) => !!j.finalsChangedAt && j.finalsChangedAt > j.stageChangedAt && since(j) && j.photos.some((p) => !inspected(p)));
  const fresh = [...landed.filter(since), ...changed.filter((j) => since(j) && j.photos.some((p) => !inspected(p))), ...afterIt].map((j) => j.id);
  return [...new Set([...running.map((r) => r.jobId), ...requested, ...fresh])].slice(0, take);
}

/** One bounded slice: safe every 5 minutes, resumable photo by photo. */
export async function driveAutohdrChecks(opts: { budgetMs: number; maxJobs?: number }): Promise<CheckSummary> {
  const started = Date.now();
  const settings = await photoDeliverySettings();
  if (!settings.enabled || !settings.freeCheck) return { skipped: "the free photo check is switched off", jobs: [] };
  if (!(await autohdrConfigured())) return { skipped: "AutoHDR API not connected", jobs: [] };
  const out: CheckSummary = { jobs: [] };
  for (const jobId of await jobsToCheck(opts.maxJobs ?? 3, settings.afterDeliveryCheck)) {
    if (opts.budgetMs - (Date.now() - started) < 20_000) break;
    out.jobs.push(await checkJob(jobId, started + opts.budgetMs));
  }
  return out;
}

async function checkJob(jobId: string, deadline: number): Promise<CheckSummary["jobs"][number]> {
  const lease = await prisma.photoJob.updateMany({ where: { id: jobId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseUntil: new Date(Date.now() + 4 * 60_000), leaseOwner: "autohdr-check" } });
  if (lease.count !== 1) return { jobId, checked: 0, findings: 0, finished: false };
  try {
    const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, stage: true, projectId: true, autohdrPhotoshootId: true, finalsChangedAt: true } });
    if (!job) return { jobId, checked: 0, findings: 0, finished: false };
    const settings = await photoDeliverySettings();
    const photos: Photo[] = await prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE" }, orderBy: { sequence: "asc" }, select: { id: true, name: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, contentHash: true, inspectedHash: true } });
    let run = await prisma.photoQcRun.findFirst({ where: { jobId, trigger: "AUTOHDR_CHECK", status: "RUNNING" }, orderBy: { startedAt: "desc" } });
    if (!run) {
      // Photos already inspected at their current version are left as they
      // are, with what the last check saw in them (rooms, light: the add-ons read it).
      const lastRow = await prisma.photoQcRun.findFirst({ where: { jobId, trigger: "AUTOHDR_CHECK", status: "DONE" }, orderBy: { startedAt: "desc" }, select: { checksJson: true, startedAt: true } });
      const last = readProgress(lastRow?.checksJson);
      const unchanged = photos.filter(inspected).map((p) => p.id);
      const carry = <T,>(m: Record<string, T> | undefined) => Object.fromEntries(unchanged.filter((id) => m?.[id] !== undefined).map((id) => [id, m![id]]));
      // A person's "Check again" since the last check (requestFreeRecheck): said so on the run, never read as a changed listing.
      const asked = (await prisma.photoJobEvent.count({ where: { jobId, action: FREE_RECHECK_ACTION, ...(lastRow ? { at: { gt: lastRow.startedAt } } : {}) } })) > 0;
      const start: Progress = { v: CHECK_PROMPT_VERSION, done: {}, errors: {}, skipped: [], kept: unchanged, rooms: carry(last.rooms), light: carry(last.light), furnished: carry(last.furnished), prep: carry(last.prep), features: carry(last.features), geometry: carry(last.geometry), geometryDone: false, ...(asked ? { asked: true } : {}) };
      run = await prisma.photoQcRun.create({
        data: { jobId, trigger: "AUTOHDR_CHECK", status: "RUNNING", shadow: settings.qcShadow, rulesVersion: RULES_REGISTRY_VERSION, promptVersionsJson: JSON.stringify({ autohdrCheck: CHECK_PROMPT_VERSION }), modelsJson: JSON.stringify({ describe: "AutoHDR describe (free)" }), checksJson: JSON.stringify(start) },
      });
      const fresh = photos.length - unchanged.length;
      await logJobEvent(jobId, "autohdr-check", `free photo check started (AutoHDR describe, no credits)${unchanged.length ? `: ${fresh} new or changed photo${fresh === 1 ? "" : "s"}` : ""}`, { runId: run.id });
    }
    const progress = readProgress(run.checksJson);
    const kept = new Set(progress.kept);
    const house = await houseOverrides();
    const off = disabledIn(house);
    const prompt = checkPrompt(off);
    const todo = photos.filter((p) => !(p.id in progress.done) && !kept.has(p.id) && (progress.errors[p.id] ?? 0) < PER_PHOTO_TRIES && !progress.skipped.includes(p.id));
    for (const p of todo) if (!p.autohdrImageUuid || !shootOf(p, job.autohdrPhotoshootId)) progress.skipped.push(p.id);
    const work = todo.filter((p) => !progress.skipped.includes(p.id));
    let checked = 0, found = 0;
    for (let i = 0; i < work.length; i += CONCURRENCY) {
      if (deadline - Date.now() < 15_000) break;
      const chunk = work.slice(i, i + CONCURRENCY);
      const answers = await Promise.all(
        chunk.map(async (p) => {
          try {
            return { p, text: await describe(shootOf(p, job.autohdrPhotoshootId)!, p.autohdrImageUuid!, prompt), error: null as string | null };
          } catch (e) {
            const gone = e instanceof AutohdrError && (e.status === 404 || e.expired);
            return { p, text: null, error: gone ? "gone" : (e as Error).message.slice(0, 160) };
          }
        }),
      );
      const rows: Prisma.PhotoQcFindingCreateManyInput[] = [];
      const looked: Photo[] = [];
      for (const a of answers) {
        if (a.error === "gone") { progress.skipped.push(a.p.id); continue; }
        const parsed = a.text ? parseCheckAnswer(a.text, off) : null;
        if (!parsed) { progress.errors[a.p.id] = (progress.errors[a.p.id] ?? 0) + 1; continue; }
        progress.done[a.p.id] = parsed.issues.length;
        looked.push(a.p);
        if (parsed.room) {
          progress.rooms[a.p.id] = parsed.room;
          await labelRoom(a.p.id, parsed.room, parsed.light, parsed.features);
        }
        if (parsed.light) (progress.light ??= {})[a.p.id] = parsed.light;
        if (parsed.furnished) (progress.furnished ??= {})[a.p.id] = parsed.furnished;
        // Oct 15 2026: how ready the room looks (prep.ts) and what it shows (coverage.ts).
        if (parsed.prep) (progress.prep ??= {})[a.p.id] = parsed.prep;
        else delete progress.prep?.[a.p.id];
        (progress.features ??= {})[a.p.id] = parsed.features;
        checked++;
        for (const iss of parsed.issues) {
          const rule = ruleById(iss.ruleId);
          if (!rule) continue;
          found++;
          rows.push({
            qcRunId: run.id, jobId, photoId: a.p.id, ruleId: rule.id, groupKey: rule.groupKey || rule.id, pass: "P1_PHOTO", source: "AHDR",
            specificIssue: `${rule.shortLabel}${iss.where ? `: ${iss.where}` : ""}`.slice(0, 300),
            explanation: `AutoHDR's free photo check saw this${iss.where ? ` (${iss.where})` : ""}.`,
            locationText: iss.where || null, severity: rule.defaultSeverity, confidence: iss.confidence, responsibility: rule.responsibility,
            fixStrategy: rule.fixStrategies[0] ?? "HUMAN_REVIEW", contentHash: a.p.contentHash, model: "autohdr-describe", rulesVersion: RULES_REGISTRY_VERSION,
            promptId: "autohdr-check", promptVersion: CHECK_PROMPT_VERSION, rawJson: (a.text ?? "").slice(0, 4000),
            // Oct 14 2026: the written re-edit instruction, so it can be fixed with one AI re-edit.
            // Verticals and a cropped roof are fixed free in AutoHDR instead: no paid instruction.
            reeditPrompt: fixClass(rule.id) === "autohdr" ? null : instructionFor(rule.id, iss.where),
          });
        }
      }
      await prisma.$transaction([
        prisma.photoQcFinding.createMany({ data: rows }),
        // Inspected at the version it looked at (backend audit #11); a photo replaced meanwhile is not.
        ...looked.map((p) => prisma.photoAsset.updateMany({ where: { id: p.id, contentHash: p.contentHash }, data: { inspectedHash: p.contentHash, prep: progress.prep?.[p.id] ?? null } })),
        prisma.photoQcRun.update({ where: { id: run.id }, data: { checksJson: JSON.stringify(progress) } }),
      ]);
      await prisma.photoJob.update({ where: { id: jobId }, data: { leaseUntil: new Date(Date.now() + 4 * 60_000) } });
    }
    const remaining = photos.filter((p) => !(p.id in progress.done) && !kept.has(p.id) && !progress.skipped.includes(p.id) && (progress.errors[p.id] ?? 0) < PER_PHOTO_TRIES);
    if (remaining.length) {
      await prisma.photoQcRun.update({ where: { id: run.id }, data: { checksJson: JSON.stringify(progress) } });
      return { jobId, checked, findings: found, finished: false };
    }
    return { jobId, checked, findings: found, ...(await finishCheck(jobId, run.id, photos, progress)) };
  } finally {
    await prisma.photoJob.updateMany({ where: { id: jobId, leaseOwner: "autohdr-check" }, data: { leaseUntil: null, leaseOwner: null } });
  }
}

const AFTER_DELIVERY = ["DELIVERED", "DELIVERING", "DELIVERY_MISMATCH"];

async function finishCheck(jobId: string, runId: string, photos: Photo[], progress: Progress): Promise<{ finished: true; verdict: string }> {
  const settings = await photoDeliverySettings();
  const kept = new Set(progress.kept);
  const stage = (await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } }))?.stage ?? "";
  // Oct 15 2026: a delivered job whose listing changed. Its stage never moves;
  // a photo AutoHDR no longer has (a shoot older than 7 days) is said once in
  // the alert, not filed as an issue on every photo.
  const afterDelivery = AFTER_DELIVERY.includes(stage);
  // Backend audit #8: a photo the check could not look at is not a pass. It
  // becomes a major issue for a person, so the job waits in Needs decision.
  const unchecked = photos.filter((p) => !(p.id in progress.done) && !kept.has(p.id));
  await prisma.$transaction([
    // Earlier free-check findings on the photos looked at (or gone since) are history; a photo kept as it was keeps its own.
    prisma.photoQcFinding.updateMany({ where: { jobId, status: "OPEN", source: "AHDR", qcRunId: { not: runId }, photoId: { notIn: [...kept] } }, data: { status: "SUPERSEDED", statusReason: `re-checked in run ${runId}` } }),
    prisma.photoQcFinding.createMany({
      data: (afterDelivery ? [] : unchecked).map((p) => ({
        qcRunId: runId, jobId, photoId: p.id, ruleId: "OTHER_DEFECT", groupKey: "free-check-not-checked", pass: "P1_PHOTO", source: "AHDR", arbitration: "CONFIRMED",
        specificIssue: "The free check could not look at this photo",
        explanation: progress.skipped.includes(p.id) ? "AutoHDR does not have this photo, so its free check could not look at it. Look at the photo yourself before it goes out." : "AutoHDR did not answer about this photo after 3 tries. Look at the photo yourself before it goes out.",
        severity: "MAJOR", confidence: 1, responsibility: "ADMIN", fixStrategy: "HUMAN_REVIEW", contentHash: p.contentHash, model: "autohdr-describe", rulesVersion: RULES_REGISTRY_VERSION, promptId: "autohdr-check", promptVersion: CHECK_PROMPT_VERSION,
      })),
    }),
  ]);
  // Oct 15 2026: prepared home or not, then clutter set aside where the home
  // (or the room) was not prepared, before anything is counted.
  const prep = await (await import("./prep")).refreshPrepMode(jobId).catch((e) => {
    console.warn("photo delivery: prep mode failed", jobId, (e as Error).message);
    return null;
  });
  const findings = await prisma.photoQcFinding.findMany({
    where: { jobId, status: { not: "SUPERSEDED" } },
    select: { id: true, ruleId: true, groupKey: true, photoId: true, photoIdsJson: true, severity: true, confidence: true, status: true, arbitration: true, privacySensitive: true, specificIssue: true, source: true },
  });
  const opts = { floor: settings.displayConfidenceFloor, overrides: await overridesFor(jobId) };
  const verdict = jobVerdict(findings, opts);
  const per = photoVerdicts(findings, photos.map((p) => p.id), opts);
  const shadow = settings.qcShadow;
  const target = qcStageFor(verdict, shadow);
  const checked = Object.keys(progress.done).length;
  await prisma.$transaction([
    ...photos.filter((p) => p.id in progress.done || kept.has(p.id)).map((p) => prisma.photoAsset.update({ where: { id: p.id }, data: { verdict: per[p.id] ?? "PASS", ...(p.id in progress.done ? { lastQcAt: new Date() } : {}) } })),
    prisma.photoQcRun.update({
      where: { id: runId },
      data: {
        status: "DONE", verdict: verdict.verdict, finishedAt: new Date(), photoCount: checked, costUsd: 0, checksJson: JSON.stringify(progress),
        summaryJson: JSON.stringify({ engine: "autohdr-describe", verdict: verdict.verdict, counts: verdict.counts, checked, kept: kept.size, unchecked: unchecked.length, skipped: progress.skipped.length, failed: unchecked.filter((p) => !progress.skipped.includes(p.id)).length, prepMode: prep?.mode ?? null, afterDelivery }),
      },
    }),
  ]);
  // A HOLD (outside shadow mode) is a CRITICAL hold: a paid QC may still be
  // asked for it, and releasing it never lands back in EDITED.
  const moved = await setStage(jobId, ["EDITED"], target, "autohdr-check", {
    why: `free photo check ${shadow ? "(shadow) " : ""}verdict ${verdict.verdict}`,
    data: { runId, counts: verdict.counts, checked, unchecked: unchecked.length },
    holdReason: "CRITICAL",
    extra: { qcVerdict: verdict.verdict, qcShadow: shadow, lastQcRunId: runId, lastError: null },
  });
  if (!moved) {
    // A re-check of a job in review (backend audit #10), or another engine
    // moved it first: point at the latest run and let the one review rule
    // place it (decisions.reviewStage).
    await prisma.photoJob.update({ where: { id: jobId }, data: { lastQcRunId: runId, qcVerdict: verdict.verdict } }).catch(() => {});
    await refreshVerdict(jobId, "autohdr-check").catch(() => {});
  }
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  const project = job ? await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true } }) : null;
  const street = (project?.title ?? "A shoot").split(",")[0];
  const issues = verdict.counts.critical + verdict.counts.major + verdict.counts.minor;
  if (afterDelivery && !progress.asked && (checked || unchecked.length)) {
    // Oct 15 2026: the listing changed after delivery. Kyle and Jordan hear
    // about it like the other photo alerts; the job stays delivered.
    const fresh = await prisma.photoQcFinding.count({ where: { qcRunId: runId, status: "OPEN", confidence: { gte: settings.displayConfidenceFloor } } });
    const { alertOwnerAndKyle } = await import("./notifyOps");
    const what = `${checked} new or changed listing photo${checked === 1 ? "" : "s"} checked: ${fresh ? `${fresh} thing${fresh === 1 ? "" : "s"} to look at` : "nothing found"}${unchecked.length ? `; ${unchecked.length} could not be checked (AutoHDR no longer has ${unchecked.length === 1 ? "it" : "them"}), look at ${unchecked.length === 1 ? "it" : "them"} yourself` : ""}`;
    await alertOwnerAndKyle({
      kind: "photo_after_delivery",
      title: `${street}: listing photos changed after delivery`,
      body: what,
      href: `/ops/photo-delivery/${jobId}`,
      dedupeKey: `photo-after-delivery-${runId}`,
      text: `${street}: the Aryeo listing photos changed after delivery. ${what}. ${appBase()}/ops/photo-delivery/${jobId}`,
      to: "both",
    }).catch(() => null);
  } else if (checked || unchecked.length) {
    // A re-check that had nothing new to look at says nothing.
    const { bellOnly } = await import("./qc/run");
    await bellOnly({
      kind: "photo_free_check",
      title: `${street}: photo check done, ${issues ? `${issues} thing${issues === 1 ? "" : "s"} to look at` : "nothing found"}`.slice(0, 120),
      body: `${checked} photo${checked === 1 ? "" : "s"} checked by AutoHDR's free check${unchecked.length ? ` (${unchecked.length} could not be checked)` : ""}.`,
      href: `/ops/photo-delivery/${jobId}`,
      dedupeKey: `photo-free-check-${runId}`,
      to: "both",
    }).catch(() => 0);
  }
  await logJobEvent(jobId, "autohdr-check", `free photo check done: ${verdict.verdict}, ${checked} photos checked${unchecked.length ? `, ${unchecked.length} could not be checked` : ""}${kept.size ? `, ${kept.size} unchanged` : ""}, ${issues} issue groups (${appBase()}/ops/photo-delivery/${jobId})`);
  return { finished: true, verdict: verdict.verdict };
}
