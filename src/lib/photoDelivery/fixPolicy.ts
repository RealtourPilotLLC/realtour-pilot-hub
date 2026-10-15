import "server-only";

import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { autohdr, AutohdrError } from "@/lib/integrations/autohdr";
import { photoDeliverySettings } from "./settings";
import { logJobEvent, setStage } from "./jobState";
import { ruleById, SEVERITY_RANK, type Severity } from "./registry";
import { jobVerdict, qcStageFor } from "./qc/verdict";
import { houseOverrides } from "./houseRules";
import { creditThresholds } from "./credits";
import { transformPrice } from "./fixes";

// ---------------------------------------------------------------------------
// AUTOMATIC QC FIXES ON A BUDGET (Oct 14 2026).
//
// Jordan: "I would really like to automate the QC and fixes in the most cost
// effective way. I want to make sure we are not spending more than $5-$10 MAX
// on QC fixes per shoot. $5 most of the time. Also places like Nehemiah's
// shoots that are completely unprepared we shouldn't have to do any QC fixes
// other than photographer in the mirror, cars, trash cans, dust spots, or
// anything camera user error related. Perspective, distortion, etc." And:
// "run it through a second qc check against its findings, and then another QC
// check after it's fixed. All free QC checks. Automatically." And: "the after
// fix check is just to confirm it was fixed properly."
//
// The chain (all automatic, both checks free, AutoHDR's describe):
//   free check → SECOND LOOK (each finding asked about again, yes or no; a
//   "no" is set aside as not an issue) → PLAN (this file) → the fix runner
//   (one AI re-edit per photo, 1 credit) → the check after the fix (fixRunner).
//
// THE PLAN:
//   · ALWAYS fixed: camera and photographer mistakes (reflections, shadows,
//     dust spots), lens distortion, cars, trash cans.
//   · NEVER a paid re-edit: crooked verticals and a tilted horizon. Jordan,
//     Oct 14 2026: "Straightened vertical lines should be fixed via AutoHDR
//     Auto Perspective corrections, and it should be turned off if the
//     correction cuts off the top of the house." AutoHDR's Perspective
//     Correction (an account Style Setting, on by default) straightens every
//     upload; the first live run proved an AI re-edit does not. What is left
//     is free in AutoHDR's own editor: Crop & Tilt for a photo that still
//     leans, Perspective Off for one whose roof the straightening cut off. The
//     public API has neither, so those are Kyle's two clicks (AUTOHDR_FREE_FIX).
//   · CLUTTER (prep) fixed only in a home that was prepared, and only inside
//     the target. An as-is home (a client on the as-is list, or one where a
//     third or more of the photos show clutter) gets no clutter fixes at all.
//   · Never automatic: privacy (documents, personal photos, people), color
//     calls, coverage, anything an edit cannot fix (blur, a missing room).
//   · ONE re-edit per photo with every instruction for that photo in it, so a
//     photo costs one credit however many things are wrong with it.
//   · Money: photos with ALWAYS items first, the worst first, up to the
//     per-shoot maximum (fixMaxUsd, $10); clutter-only photos only while the
//     total stays inside the target (fixTargetUsd, $5). Plus a daily cap.
// ---------------------------------------------------------------------------

const CAMERA = ["REFL_PHOTOGRAPHER_IN_MIRROR", "REFL_CAMERA_TRIPOD_IN_MIRROR", "REFL_PHOTOGRAPHER_IN_GLASS", "REFL_PHOTOGRAPHER_SHADOW", "REFL_TRIPOD_EQUIPMENT_SHADOW", "REFL_SENSOR_DUST", "EXT_PHOTOGRAPHER_VEHICLE"];
const DISTORTION = ["PERSP_HORIZONTAL_DISTORTION", "PERSP_BOWED_WALLS", "BED_WIDE_ANGLE_DISTORTION"];
/** Fixed for free in AutoHDR itself, never with a paid re-edit: what to press, in Kyle's words. */
const VERTICALS_HOW = "AutoHDR straightens vertical lines on every upload (Perspective Correction). If this photo still leans, open it in AutoHDR and straighten it with Crop & Tilt. Free.";
export const AUTOHDR_FREE_FIX: Record<string, string> = {
  PERSP_CROOKED_VERTICALS: VERTICALS_HOW,
  PERSP_LEANING_DOOR_FRAMES: VERTICALS_HOW,
  PERSP_EXTERIOR_WALLS_LEANING: VERTICALS_HOW,
  PERSP_CROOKED_HORIZON: "Level it in AutoHDR with Crop & Tilt. Free.",
  PERSP_AUTOHDR_ROOF_PEAKS_CROPPED: "AutoHDR's straightening cut off the top of the house. Open this photo in AutoHDR and turn Perspective Off on THIS photo (free; the account's Perspective Correction switch only changes new uploads, never photos already edited), then press Check AutoHDR for changes here: the hub and the Aryeo folder take the new version. Compare it in the photo's Versions. If the original photo has no room above the roof either, only a reshoot fixes it.",
};
const VEHICLES = ["EXT_PARKED_CARS_DRIVEWAY", "EXT_VEHICLES_BLOCKING_HOME", "EXT_VEHICLES_THROUGH_WINDOWS"];
const TRASH = ["PREP_TRASH_CANS", "EXT_TRASH_CANS_PRIMARY", "BATH_TRASH_CANS", "UTIL_GARAGE_TRASH_CANS", "LIV_OFFICE_TRASH_CANS", "PREP_GARBAGE_BAGS_LOOSE_TRASH"];
export const ALWAYS_FIX = new Set([...CAMERA, ...DISTORTION, ...VEHICLES, ...TRASH]);
/** A person decides these, every time. */
const NEVER_AUTO = new Set(["PREP_PERSONAL_DOCUMENTS", "PREP_PERSONAL_PHOTOS", "BED_PERSONAL_PHOTOS_SENSITIVE", "PREP_VISIBLE_PEOPLE_PETS", "OTHER_DEFECT", "FIX_DAMAGE_AI_EDIT"]);
/** An AI fix that changed the house and could not be put back (fixRunner): a person restores it, never skipped in bulk. */
export const FIX_DAMAGE_RULE = "FIX_DAMAGE_AI_EDIT";
const PREP_PREFIX = /^(PREP|KIT|BATH|BED|LIV|UTIL|EXT)_/;

/** "autohdr": fixed for free in AutoHDR's own editor, never a paid re-edit (AUTOHDR_FREE_FIX). */
export type FixClass = "always" | "prep" | "never" | "autohdr";

export function fixClass(ruleId: string): FixClass {
  if (AUTOHDR_FREE_FIX[ruleId]) return "autohdr";
  if (ALWAYS_FIX.has(ruleId)) return "always";
  if (NEVER_AUTO.has(ruleId)) return "never";
  const rule = ruleById(ruleId);
  if (!rule || !PREP_PREFIX.test(ruleId) || rule.permanentFeatureRisk) return "never";
  return rule.fixStrategies.some((s) => s === "AUTOREMOVE_MASK" || s === "DECLUTTER" || s === "REEDIT_PROMPT" || s === "CAMERA_REMOVAL") ? "prep" : "never";
}

const INSTRUCTION: Record<string, string> = {
  REFL_PHOTOGRAPHER_IN_MIRROR: "Remove the photographer and camera reflected in the mirror",
  REFL_CAMERA_TRIPOD_IN_MIRROR: "Remove the camera and tripod reflected in the mirror",
  REFL_PHOTOGRAPHER_IN_GLASS: "Remove the photographer's reflection in the glass",
  REFL_PHOTOGRAPHER_SHADOW: "Remove the photographer's shadow",
  REFL_TRIPOD_EQUIPMENT_SHADOW: "Remove the tripod's shadow",
  REFL_SENSOR_DUST: "Remove the small dark dust spots",
  EXT_PHOTOGRAPHER_VEHICLE: "Remove the photographer's vehicle",
  EXT_PARKED_CARS_DRIVEWAY: "Remove the parked cars and fill in only the pavement, lawn or street where they were",
  EXT_VEHICLES_BLOCKING_HOME: "Remove the vehicles and fill in only the pavement, lawn or street where they were",
  EXT_VEHICLES_THROUGH_WINDOWS: "Remove the vehicle seen through the window",
  PERSP_HORIZONTAL_DISTORTION: "Correct the perspective so horizontal lines run level",
  PERSP_BOWED_WALLS: "Correct the lens distortion so the walls are straight, not bowed",
  BED_WIDE_ANGLE_DISTORTION: "Correct the wide-angle distortion so the furniture and walls look natural",
  BATH_TOILET_SEAT_OPEN: "Close the toilet seat and lid",
  BED_UNMADE: "Make the bed neatly with smooth bedding",
  PREP_INCONSISTENT_BLINDS: "Set all the window blinds to the same even height",
  KIT_OPEN_APPLIANCE_DOORS: "Close the open appliance doors",
};

// ---------------------------------------------------------------------------
// THE HOUSE STAYS THE HOUSE (Oct 14 2026, huddle finding 2). A car removal on
// one of Nehemiah's shoots gave the house steps it does not have: the car hid
// them and the AI made some up. So, for a removal outside (cars, the
// photographer's vehicle, trash cans, anything on the lot):
//   · BEFORE (free): the photo is described as it is now: the permanent parts
//     of the house in view, and whether the thing to remove HIDES part of the
//     house. If it does, an automatic fix does not run: the original stays
//     and a person decides (a fix someone chose by hand still runs, with the
//     rule below, and is checked after);
//   · the instruction says to fill in only ground, never to add or reshape
//     any part of the house;
//   · AFTER (free, fixRunner checkFix): the fixed photo is compared with that
//     description; a step, railing, door or wall that appeared, went or
//     changed shape is damage, and the previous version is put back (and
//     checked).
// ---------------------------------------------------------------------------
const STRUCTURE_RULES = new Set([...VEHICLES, "EXT_PHOTOGRAPHER_VEHICLE", "PREP_TRASH_CANS", "PREP_GARBAGE_BAGS_LOOSE_TRASH"]);
export const STRUCTURE_CLAUSE = "Do not add, remove, move or reshape any part of the house or lot (steps, stoops, porch, railings, doors, garage doors, windows, walls, walkways, fences). Where something removed was hiding part of the house, do not invent what was behind it.";

/** Does a fix of these findings remove something that could stand in front of the house? */
export function touchesStructure(ruleIds: string[]): boolean {
  return ruleIds.some((id) => STRUCTURE_RULES.has(id) || id.startsWith("EXT_"));
}

export type StructureLook = { house: string; covers: boolean; covered: string };

/** The free look before a removal: the house as it is, and whether the thing to remove hides part of it. */
export async function structureCheck(shootId: number, imageUuid: string, versionUuid: string | null, instruction: string): Promise<StructureLook | null> {
  const prompt = [
    `This real estate photo is about to be edited with this instruction: "${instruction.replace(STRUCTURE_CLAUSE, "").trim()}"`,
    "Answer ONLY with JSON:",
    '{"house": "the permanent parts of the building and lot you can see, with counts where it matters: steps, stoops, porch, railings, doors, garage doors, windows, walkways, retaining walls, fences, roofline", "covers": true or false, "covered": "which feature the things to remove are hiding, or empty"}',
    "covers = something the instruction says to remove stands in front of a distinct FEATURE of a house and hides it in whole or in part: steps or a stoop, a porch, a railing, a door, a garage door, a window, or the walkway to a door. Then removing it means guessing what that feature looks like.",
    "Hiding only plain wall, brick, siding, foundation, a fence, the sidewalk, the curb, pavement, lawn, the street or the sky is NOT covering: those can be filled in. Inside a house, nothing is covering.",
  ].join("\n");
  const j = jsonFrom<{ house?: string; covers?: boolean; covered?: string }>(await describePhoto(shootId, imageUuid, prompt, versionUuid));
  if (!j || typeof j.covers !== "boolean") return null;
  return { house: String(j.house ?? "").slice(0, 600), covers: j.covers, covered: String(j.covered ?? "").slice(0, 200) };
}

/**
 * The house's features, counted the same way on any version (free describe).
 * The check after a removal counts the version before and the version after
 * with the same question, and only a difference that a second count of both
 * confirms is a changed house: one free-text judgment alone said "the steps
 * changed" on one run and "fixed" on the next for the same photo (Oct 14).
 */
export const FEATURES = ["steps", "stoops", "porches", "railings", "doors", "garage_doors"] as const;
export type FeatureCounts = Partial<Record<(typeof FEATURES)[number], number>>;
const COUNT_PROMPT = [
  "Count these permanent features of every house you can see in this real estate photo, including neighbouring houses. Count only what is clearly visible.",
  'Answer ONLY with JSON: {"steps": number of separate flights of outdoor steps, "stoops": number, "porches": number, "railings": number of separate railings, "doors": number of exterior doors, "garage_doors": number}',
].join("\n");

export async function featureCounts(shootId: number, imageUuid: string, versionUuid: string | null): Promise<FeatureCounts | null> {
  const j = jsonFrom<Record<string, unknown>>(await describePhoto(shootId, imageUuid, COUNT_PROMPT, versionUuid));
  if (!j) return null;
  const out: FeatureCounts = {};
  for (const k of FEATURES) if (typeof j[k] === "number" && Number.isFinite(j[k] as number)) out[k] = Math.max(0, Math.round(j[k] as number));
  return Object.keys(out).length ? out : null;
}

/** The features whose count differs between two counts ("steps 2 → 3"). */
export function featureDiff(a: FeatureCounts | null | undefined, b: FeatureCounts | null | undefined): string[] {
  if (!a || !b) return [];
  return FEATURES.filter((k) => a[k] != null && b[k] != null && a[k] !== b[k]).map((k) => `${k.replace("_", " ")} ${a[k]} → ${b[k]}`);
}

/** Did a removal change the house? Counted before and after, and a difference is counted again on both before it counts. */
export async function houseChanged(shootId: number, imageUuid: string, before: { version: string; counts?: FeatureCounts | null }, afterVersion: string): Promise<{ changed: boolean; what: string[]; counts: { before: FeatureCounts | null; after: FeatureCounts | null } }> {
  const b1 = before.counts ?? (await featureCounts(shootId, imageUuid, before.version).catch(() => null));
  const a1 = await featureCounts(shootId, imageUuid, afterVersion).catch(() => null);
  const first = featureDiff(b1, a1);
  if (!first.length) return { changed: false, what: [], counts: { before: b1, after: a1 } };
  const [b2, a2] = await Promise.all([featureCounts(shootId, imageUuid, before.version).catch(() => null), featureCounts(shootId, imageUuid, afterVersion).catch(() => null)]);
  const keys = new Set(FEATURES.filter((k) => b1?.[k] != null && a1?.[k] != null && b1[k] !== a1[k]));
  const confirmed = [...keys].filter((k) => b2?.[k] != null && a2?.[k] != null && b2[k] !== a2[k] && Math.sign(a2[k]! - b2[k]!) === Math.sign(a1![k]! - b1![k]!));
  return { changed: confirmed.length > 0, what: confirmed.map((k) => `${k.replace("_", " ")} ${b1![k]} → ${a1![k]}`), counts: { before: b1, after: a1 } };
}

/** The re-edit instruction for one finding: what to do, where (when known). */
export function instructionFor(ruleId: string, where?: string | null): string {
  const rule = ruleById(ruleId);
  const base = INSTRUCTION[ruleId] ?? `Remove the ${(rule?.shortLabel ?? ruleId.toLowerCase().replace(/_/g, " ")).replace(/\s*\/\s*/g, " and ").toLowerCase()}`;
  const at = where?.trim() ? ` (${where.trim().replace(/[.]+$/, "")})` : "";
  return `${base}${at}.`.slice(0, 300);
}

// ---------------------------------------------------------------------------
// THE SECOND LOOK (free): each open free-check finding on a photo is asked
// about again, as a numbered yes/no list, before anything is fixed.
// ---------------------------------------------------------------------------
let describeImpl: ((shootId: number, imageUuid: string, prompt: string, versionUuid?: string | null) => Promise<string>) | null = null;
/** Drills only. */
export function __setFixDescribeForTests(fn: typeof describeImpl) {
  describeImpl = fn;
}
export const describePhoto = (shootId: number, imageUuid: string, prompt: string, versionUuid?: string | null) =>
  describeImpl ? describeImpl(shootId, imageUuid, prompt, versionUuid) : autohdr.describe(shootId, imageUuid, { prompt, ...(versionUuid ? { image_version_uuid: versionUuid } : {}) });

export function jsonFrom<T>(text: string): T | null {
  const body = text.replace(/```(?:json)?/gi, "");
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(body.slice(a, b + 1)) as T;
  } catch {
    return null;
  }
}

export function secondLookPrompt(items: { label: string; where: string | null }[]): string {
  return [
    "Look closely at this real estate photo. For each numbered item below, say whether it is really visible in this photo.",
    'Answer ONLY with JSON: {"items":[{"n":1,"present":true}]}, one entry per number, present true or false.',
    ...items.map((it, i) => `${i + 1}. ${it.label}${it.where ? `: ${it.where}` : ""}`),
  ].join("\n");
}

type Photo = { id: string; sourceKind: string; sourceRef: string | null; autohdrImageUuid: string | null; sequence: number; status: string };

export function shootIdOf(photo: Pick<Photo, "sourceKind" | "sourceRef">, jobShoot: number | null): number | null {
  if (photo.sourceKind === "AUTOHDR" && photo.sourceRef?.includes("/")) {
    const n = Number(photo.sourceRef.split("/")[0]);
    return Number.isFinite(n) ? n : null;
  }
  return jobShoot;
}

/** Second-look the job's open free-check findings. Resumable; returns true when none are left to ask about. */
export async function secondLookJob(jobId: string, deadline: number): Promise<{ done: boolean; confirmed: number; overturned: number }> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { autohdrPhotoshootId: true } });
  const pending = await prisma.photoQcFinding.findMany({ where: { jobId, status: "OPEN", source: "AHDR", arbitration: "NOT_REQUIRED", photoId: { not: null } }, select: { id: true, photoId: true, ruleId: true, locationText: true, coercedJson: true } });
  if (!pending.length) return { done: true, confirmed: 0, overturned: 0 };
  const photos = await prisma.photoAsset.findMany({ where: { id: { in: [...new Set(pending.map((f) => f.photoId!))] } }, select: { id: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, sequence: true, status: true } });
  const byPhoto = new Map<string, typeof pending>();
  for (const f of pending) byPhoto.set(f.photoId!, [...(byPhoto.get(f.photoId!) ?? []), f]);
  let confirmed = 0, overturned = 0;
  const work = [...byPhoto.entries()];
  for (let i = 0; i < work.length; i += 4) {
    if (deadline - Date.now() < 15_000) break;
    await Promise.all(
      work.slice(i, i + 4).map(async ([photoId, list]) => {
        const p = photos.find((x) => x.id === photoId);
        const shoot = p ? shootIdOf(p, job?.autohdrPhotoshootId ?? null) : null;
        if (!p || !shoot || !p.autohdrImageUuid || p.status !== "ACTIVE") {
          // Cannot be asked again (not in AutoHDR, left out): kept as found.
          await prisma.photoQcFinding.updateMany({ where: { id: { in: list.map((f) => f.id) } }, data: { arbitration: "CONFIRMED" } });
          return;
        }
        const items = list.map((f) => ({ label: ruleById(f.ruleId)?.shortLabel ?? f.ruleId, where: f.locationText }));
        let answer: { items?: { n?: number; present?: boolean }[] } | null = null;
        try {
          answer = jsonFrom(await describePhoto(shoot, p.autohdrImageUuid, secondLookPrompt(items)));
        } catch (e) {
          if (e instanceof AutohdrError && (e.status === 404 || e.expired)) answer = null;
        }
        for (let k = 0; k < list.length; k++) {
          const f = list[k];
          const hit = answer?.items?.find((x) => x?.n === k + 1);
          if (!hit || typeof hit.present !== "boolean") {
            const tries = (jsonFrom<{ secondLookTries?: number }>(f.coercedJson ?? "") ?? {}).secondLookTries ?? 0;
            // Two answers we could not read: kept as found (never dropped on a guess).
            await prisma.photoQcFinding.update({ where: { id: f.id }, data: tries >= 1 ? { arbitration: "CONFIRMED" } : { coercedJson: JSON.stringify({ secondLookTries: tries + 1 }) } });
            continue;
          }
          if (hit.present) {
            confirmed++;
            await prisma.photoQcFinding.update({ where: { id: f.id }, data: { arbitration: "CONFIRMED" } });
          } else {
            overturned++;
            await prisma.photoQcFinding.update({ where: { id: f.id }, data: { arbitration: "OVERTURNED", status: "FALSE_POSITIVE", statusReason: "The free second look did not see it.", decidedBy: "free second look", decidedAt: new Date() } });
          }
        }
      }),
    );
  }
  const left = await prisma.photoQcFinding.count({ where: { jobId, status: "OPEN", source: "AHDR", arbitration: "NOT_REQUIRED", photoId: { not: null } } });
  if (confirmed || overturned) await logJobEvent(jobId, "second-look", `free second look: ${confirmed} confirmed, ${overturned} set aside as not seen`);
  if (!left) await refreshVerdict(jobId, "second-look");
  return { done: left === 0, confirmed, overturned };
}

/** Recompute the verdict and stage after findings changed (second look, fixes). */
export async function refreshVerdict(jobId: string, actor: string): Promise<void> {
  const settings = await photoDeliverySettings();
  const findings = await prisma.photoQcFinding.findMany({ where: { jobId, status: { not: "SUPERSEDED" } }, select: { id: true, ruleId: true, groupKey: true, photoId: true, photoIdsJson: true, severity: true, confidence: true, status: true, arbitration: true, privacySensitive: true, specificIssue: true, source: true } });
  const v = jobVerdict(findings, { floor: settings.displayConfidenceFloor, overrides: await houseOverrides() });
  const target = qcStageFor(v, settings.qcShadow);
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, qcVerdict: true } });
  if (!job) return;
  if (["QC_REVIEW", "READY"].includes(job.stage) && job.stage !== target) await setStage(jobId, ["QC_REVIEW", "READY"], target, actor, { why: `verdict now ${v.verdict}`, extra: { qcVerdict: v.verdict } });
  else if (job.qcVerdict !== v.verdict) await prisma.photoJob.update({ where: { id: jobId }, data: { qcVerdict: v.verdict } });
}

// ---------------------------------------------------------------------------
// WHAT THE HUB LEARNED FROM PEOPLE'S CALLS (Oct 14 2026, huddle finding 9).
// Two different answers, kept apart:
//   · "Not there" (FALSE_POSITIVE): the check saw something that is not in
//     the photo. Three or more in 60 days, half or more of the calls on that
//     check: it is fixed automatically only when the check is at least 80%
//     sure.
//   · "Not worth fixing" (IGNORED): it is there, but nobody wants it fixed.
//     Three or more in 60 days and 60% or more of the calls on that check:
//     no automatic fix for it (a person can still press Fix). Only for
//     clutter: camera mistakes, cars and trash cans are always wanted
//     (Jordan, Oct 14), whatever happened on one listing.
// Calls made in bulk for one listing (Skip all, an as-is home) and the hub's
// own calls (the free second look, the automatic plan) never count.
// ---------------------------------------------------------------------------
export type RuleLearning = { ruleId: string; notThere: number; notWorth: number; wanted: number; skip: boolean; strict: boolean };
const SYSTEM_DECIDER = /^(auto-|free second look|fix-runner|hub\b|system)/i;
export const LEARN_DAYS = 60;
export const STRICT_CONFIDENCE = 0.8;

export async function learnedRules(now = new Date()): Promise<Map<string, RuleLearning>> {
  const rows = await prisma.photoQcFinding.findMany({
    where: { decidedAt: { gte: new Date(now.getTime() - LEARN_DAYS * 86_400_000) }, status: { in: ["IGNORED", "FALSE_POSITIVE", "APPROVED_FIX", "FIXING", "FIXED"] }, source: { not: "ADDON" } },
    select: { ruleId: true, status: true, decidedBy: true, statusReason: true },
  });
  const out = new Map<string, RuleLearning>();
  for (const r of rows) {
    if (!r.decidedBy || SYSTEM_DECIDER.test(r.decidedBy)) continue;
    if (/^Skipped all findings/i.test(r.statusReason ?? "")) continue;
    const l = out.get(r.ruleId) ?? { ruleId: r.ruleId, notThere: 0, notWorth: 0, wanted: 0, skip: false, strict: false };
    if (r.status === "FALSE_POSITIVE") l.notThere++;
    else if (r.status === "IGNORED") l.notWorth++;
    else l.wanted++;
    out.set(r.ruleId, l);
  }
  for (const l of out.values()) {
    const calls = l.notThere + l.notWorth + l.wanted;
    l.strict = l.notThere >= 3 && l.notThere / calls >= 0.5;
    l.skip = fixClass(l.ruleId) === "prep" && l.notWorth >= 3 && l.notWorth / (l.notWorth + l.wanted) >= 0.6;
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE PLAN
// ---------------------------------------------------------------------------
export type PlanResult = { planned: boolean; reason: string; photos: number; credits: number; asIs: boolean; left: number };

/**
 * The automatic fix policy, as the settings page shows it (Oct 14 2026,
 * huddle finding 8: "make it explicit and testable"). Each line is what the
 * plan above actually does; the drill checks the plan against it.
 */
export function fixPolicySummary(s: { fixTargetUsd: number; fixMaxUsd: number; asIsClientIds: string[] }): { title: string; lines: string[] }[] {
  const label = (ids: string[]) => ids.map((id) => ruleById(id)?.shortLabel ?? id).join(", ");
  return [
    { title: "Always fixed (every home, prepared or not)", lines: [`Camera and photographer mistakes: ${label(CAMERA)}.`, `Cars: ${label(VEHICLES)}.`, `Trash cans: ${label(TRASH)}.`, `Lens distortion: ${label(DISTORTION)}.`, `Up to the shoot maximum ($${s.fixMaxUsd}).`] },
    { title: "Clutter (prepared homes only)", lines: [`Fixed only while the shoot stays inside the target ($${s.fixTargetUsd}).`, "Never on an as-is home: a client on the as-is list, or a shoot where a third or more of the photos show clutter.", 'Not on its own any more once people have marked that kind of clutter "not worth fixing" 3 or more times in 60 days (60% or more of the calls).'] },
    { title: "Free in AutoHDR, never a paid fix", lines: Object.entries(AUTOHDR_FREE_FIX).map(([id, how]) => `${ruleById(id)?.shortLabel ?? id}: ${how}`) },
    { title: "Never automatic (a person decides)", lines: ["Privacy: documents, personal photos, people and pets.", "Anything that could change a permanent part of the house.", "Color calls, coverage, and anything an edit cannot fix (blur, a missing room).", "A car or bin that hides part of the house (steps, a porch, a door): removing it means guessing what is behind it, so the original stays.", "A photo an earlier AI fix changed: restore the version before the fix. Skip all never touches it."] },
    { title: "Checks on every automatic fix (free)", lines: ["Before: a second look confirms each finding; for a removal outside, the house is described and checked for anything hidden.", "After: was it fixed, is anything broken, did the house change (steps, railings, doors), and is it noticeably softer. If so, the version before the fix is put back and AutoHDR is checked to have taken it.", `A finding the check was under 60% sure of is not fixed on its own (80% for a kind people often marked "not there").`] },
  ];
}

/** Why a class of finding is or is not fixed automatically, in Kyle's words (no dollar amounts: Kyle never sees them). */
const ALWAYS_WHY = (ruleId: string) =>
  CAMERA.includes(ruleId) ? "a camera or photographer mistake" : VEHICLES.includes(ruleId) ? "a car" : TRASH.includes(ruleId) ? "a trash can" : DISTORTION.includes(ruleId) ? "lens distortion" : "always fixed";

function neverWhy(ruleId: string, privacy: boolean): string {
  if (privacy) return "Never automatic: privacy. A person chooses blur, remove, or leave the photo out.";
  if (ruleId === FIX_DAMAGE_RULE) return "Never automatic: an AI fix changed this photo. Restore the version before the fix.";
  if (NEVER_AUTO.has(ruleId)) return "Never automatic: a person decides this one every time.";
  const rule = ruleById(ruleId);
  if (rule?.permanentFeatureRisk) return "Never automatic: fixing it could change a permanent part of the house.";
  if (!PREP_PREFIX.test(ruleId)) return "Never automatic: an AI edit cannot fix this (it needs an editor, a reshoot or a person's call).";
  return "Never automatic: there is no AI edit for this.";
}

const etDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Has this job already been planned for its latest check? (one plan per gallery version) */
async function alreadyPlanned(jobId: string, since: Date): Promise<boolean> {
  return !!(await prisma.photoFixBatch.findFirst({ where: { jobId, approvedBy: "auto-fix", approvedAt: { gte: since } }, select: { id: true } })) ||
    !!(await prisma.photoJobEvent.findFirst({ where: { jobId, actor: "auto-fix", at: { gte: since } }, select: { id: true } }));
}

export async function planAutoFix(jobId: string): Promise<PlanResult> {
  const settings = await photoDeliverySettings();
  const none = (reason: string, extra: Partial<PlanResult> = {}): PlanResult => ({ planned: false, reason, photos: 0, credits: 0, asIs: false, left: 0, ...extra });
  if (!settings.autoFix) return none("automatic fixes are switched off");
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, stage: true, projectId: true, autohdrPhotoshootId: true, lastQcRunId: true } });
  if (!job || !["QC_REVIEW", "READY"].includes(job.stage)) return none("not waiting on QC review");
  const run = job.lastQcRunId ? await prisma.photoQcRun.findUnique({ where: { id: job.lastQcRunId }, select: { status: true, startedAt: true } }) : null;
  if (!run || run.status !== "DONE") return none("no finished check yet");
  if (await alreadyPlanned(jobId, run.startedAt)) return none("already planned for this check");
  if (await prisma.photoQcFinding.count({ where: { jobId, status: "OPEN", source: "AHDR", arbitration: "NOT_REQUIRED", photoId: { not: null } } })) return none("the second look is still running");

  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true, clientId: true } });
  const street = (project?.title ?? "A shoot").split(",")[0];
  const photos: Photo[] = await prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE" }, select: { id: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, sequence: true, status: true } });
  const everyOpen = await prisma.photoQcFinding.findMany({
    where: { jobId, status: "OPEN", photoId: { in: photos.map((p) => p.id) }, arbitration: { not: "OVERTURNED" }, source: { not: "ADDON" } },
    select: { id: true, photoId: true, ruleId: true, severity: true, confidence: true, locationText: true, reeditPrompt: true, privacySensitive: true },
  });
  // Huddle finding 9: what people's calls taught the hub.
  const learned = await learnedRules();
  const notes = new Map<string, string>();
  const findings = everyOpen.filter((f) => {
    const l = learned.get(f.ruleId);
    const floor = l?.strict ? STRICT_CONFIDENCE : 0.6;
    if (f.privacySensitive) {
      notes.set(f.id, neverWhy(f.ruleId, true));
      return false;
    }
    if (f.confidence < floor) {
      notes.set(f.id, l?.strict
        ? `Not fixed automatically: people said "not there" ${l.notThere} times lately for this check, so it waits until the check is ${Math.round(STRICT_CONFIDENCE * 100)}% sure (this one: ${Math.round(f.confidence * 100)}%).`
        : `Not fixed automatically: the check was only ${Math.round(f.confidence * 100)}% sure. Look at it, then Fix or set it aside.`);
      return false;
    }
    return true;
  });
  // As-is: on Jordan's list, or a third or more of the photos show clutter.
  const prepPhotos = new Set(findings.filter((f) => fixClass(f.ruleId) === "prep").map((f) => f.photoId));
  const listed = !!project?.clientId && settings.asIsClientIds.includes(project.clientId);
  const share = photos.length ? prepPhotos.size / photos.length : 0;
  const asIs = listed || share >= 0.34;

  const price = await transformPrice("reedit");
  if (price == null) return none("AutoHDR's price for a re-edit could not be read");
  const { usdPerCredit } = await creditThresholds();
  // What the shoot already used (fixes by hand count too) comes off both.
  const used = await fixBudgetFor(jobId);
  const target = Math.max(0, Math.floor(settings.fixTargetUsd / usdPerCredit + 1e-9) - used.spent - used.pending);
  const max = Math.max(0, Math.floor(settings.fixMaxUsd / usdPerCredit + 1e-9) - used.spent - used.pending);
  // The daily guard: every automatic batch planned today (ET).
  const today = etDay(new Date());
  const recent = await prisma.photoFixBatch.findMany({ where: { approvedBy: "auto-fix", approvedAt: { gte: new Date(Date.now() - 36 * 3_600_000) } }, select: { estimatedCredits: true, approvedAt: true } });
  const spentToday = recent.filter((b) => b.approvedAt && etDay(b.approvedAt) === today).reduce((s, b) => s + (b.estimatedCredits ?? 0), 0);

  type Cand = { photo: Photo; always: typeof findings; prep: typeof findings; worst: number };
  const cands: Cand[] = [];
  const asIsWhy = listed ? "the client is on the as-is list" : `${prepPhotos.size} of ${photos.length} photos show clutter`;
  for (const f of findings) {
    const c = fixClass(f.ruleId);
    if (c === "never") notes.set(f.id, neverWhy(f.ruleId, false));
    else if (c === "autohdr") notes.set(f.id, `Free in AutoHDR, never a paid fix: ${AUTOHDR_FREE_FIX[f.ruleId]}`);
    else if (c === "prep" && asIs) notes.set(f.id, `Skipped: as-is home (${asIsWhy}). Clutter is not fixed on an as-is home; camera mistakes, cars and trash cans still are.`);
    else if (c === "prep" && learned.get(f.ruleId)?.skip) {
      const l = learned.get(f.ruleId)!;
      notes.set(f.id, `Skipped: people marked this "not worth fixing" ${l.notWorth} times in the last ${LEARN_DAYS} days (fixed ${l.wanted}). Press Fix if this one matters.`);
    }
  }
  for (const p of photos) {
    const mine = findings.filter((f) => f.photoId === p.id);
    if (!p.autohdrImageUuid || !shootIdOf(p, job.autohdrPhotoshootId)) {
      for (const f of mine) if (!notes.has(f.id)) notes.set(f.id, "Not fixed automatically: this photo is not matched to its AutoHDR shoot, so AutoHDR cannot edit it from the hub.");
      continue;
    }
    const always = mine.filter((f) => fixClass(f.ruleId) === "always");
    const prep = asIs ? [] : mine.filter((f) => fixClass(f.ruleId) === "prep" && !learned.get(f.ruleId)?.skip);
    if (!always.length && !prep.length) continue;
    const worst = Math.max(...[...always, ...prep].map((f) => SEVERITY_RANK[(f.severity as Severity) ?? "MINOR"] ?? 0));
    cands.push({ photo: p, always, prep, worst });
  }
  // Camera, car and trash photos first, the worst first; then front of the gallery first.
  cands.sort((a, b) => Number(!!b.always.length) - Number(!!a.always.length) || b.worst - a.worst || b.always.length + b.prep.length - (a.always.length + a.prep.length) || a.photo.sequence - b.photo.sequence);
  const chosen: Cand[] = [];
  let credits = 0;
  let dailyHit = false;
  for (const c of cands) {
    const cap = c.always.length ? max : target;
    const items = [...c.always, ...c.prep];
    if (dailyHit || spentToday + credits + price > settings.autoFixDailyMaxCredits) {
      dailyHit = true;
      for (const f of items) notes.set(f.id, "Left for a person: today's limit on automatic fixes (all shoots) was reached. Press Fix to run it now.");
      continue;
    }
    if (credits + price > cap) {
      for (const f of items) notes.set(f.id, c.always.length
        ? "Left for a person: the shoot reached its automatic fix maximum. Press Fix to run it anyway."
        : "Left for a person: clutter is fixed automatically only while the shoot stays inside its usual fix budget, and it would go over. Press Fix if it matters.");
      continue;
    }
    chosen.push(c);
    credits += price;
    const n = items.length;
    for (const f of c.always) notes.set(f.id, `Fixing automatically: ${ALWAYS_WHY(f.ruleId)}, always fixed.${n > 1 ? ` One AI re-edit with the photo's ${n - 1} other fix${n === 2 ? "" : "es"}.` : ""} Checked after the fix; put back if it changes the house.`);
    for (const f of c.prep) notes.set(f.id, `Fixing automatically: clutter in a prepared home, inside the usual fix budget.${n > 1 ? ` One AI re-edit with the photo's ${n - 1} other fix${n === 2 ? "" : "es"}.` : ""} Checked after the fix.`);
  }
  const leftOver = cands.length - chosen.length;
  // Every open finding says why it was or was not fixed automatically (huddle finding 5).
  await savePlanNotes(notes);
  const usd = (n: number) => `$${(n * usdPerCredit).toFixed(2)}`;
  const clutterNote = asIs ? ` As-is home (${listed ? "client on the as-is list" : `${prepPhotos.size} of ${photos.length} photos show clutter`}): clutter is not fixed.` : "";
  if (!chosen.length) {
    await logJobEvent(jobId, "auto-fix", `automatic fixes: nothing to fix within the rules.${clutterNote}`, { runStartedAt: run.startedAt.toISOString(), asIs, candidates: cands.length });
    return none("nothing to fix within the rules", { asIs });
  }

  const batch = await prisma.$transaction(async (tx) => {
    const b = await tx.photoFixBatch.create({
      data: { jobId, mode: "AUTO", estimatedCredits: credits, estimatedUsdCents: Math.round(credits * usdPerCredit * 100), approvedBy: "auto-fix", status: "PENDING" },
    });
    let n = 0;
    for (const c of chosen) {
      const items = [...c.always, ...c.prep];
      // Every finding carries its instruction (the runner merges them into one re-edit).
      for (const f of items) if (!f.reeditPrompt) await tx.photoQcFinding.update({ where: { id: f.id }, data: { reeditPrompt: instructionFor(f.ruleId, f.locationText) } });
      await tx.photoFixOperation.create({
        data: { batchId: b.id, jobId, photoId: c.photo.id, findingIdsJson: JSON.stringify(items.map((f) => f.id)), seq: 0, strategy: "REEDIT_PROMPT", transformName: "reedit", estimatedCredits: price, status: "QUEUED" },
      });
      await tx.photoQcFinding.updateMany({ where: { id: { in: items.map((f) => f.id) } }, data: { status: "APPROVED_FIX", decidedBy: "auto-fix", decidedAt: new Date() } });
      n++;
    }
    return { id: b.id, n };
  });
  await setStage(jobId, ["QC_REVIEW", "READY"], "FIXING", "auto-fix", { why: `automatic fixes: ${batch.n} photo${batch.n === 1 ? "" : "s"}, ${credits} credits (${usd(credits)})` });
  await logJobEvent(jobId, "auto-fix", `automatic fixes planned: ${batch.n} photo${batch.n === 1 ? "" : "s"}, ${credits} credit${credits === 1 ? "" : "s"} (${usd(credits)}; target ${usd(target)}, max ${usd(max)}).${leftOver ? ` ${leftOver} more photo${leftOver === 1 ? "" : "s"} left for a person (over budget).` : ""}${clutterNote}`, { batchId: batch.id, runStartedAt: run.startedAt.toISOString(), asIs, credits, photos: batch.n, leftOver });
  void appBase;
  void street;
  return { planned: true, reason: "planned", photos: batch.n, credits, asIs, left: leftOver };
}

async function savePlanNotes(notes: Map<string, string>): Promise<void> {
  const byNote = new Map<string, string[]>();
  for (const [id, note] of notes) byNote.set(note, [...(byNote.get(note) ?? []), id]);
  for (const [note, ids] of byNote) await prisma.photoQcFinding.updateMany({ where: { id: { in: ids } }, data: { planNote: note.slice(0, 500) } });
}

/** Jobs whose free checks are done: second look, then plan. One bounded slice. */
export async function driveAutoFixPlanning(opts: { budgetMs: number }): Promise<{ looked: number; planned: { jobId: string; photos: number; credits: number; asIs: boolean }[]; skipped?: string }> {
  const started = Date.now();
  const deadline = started + opts.budgetMs;
  const settings = await photoDeliverySettings();
  if (!settings.enabled || !settings.freeCheck) return { looked: 0, planned: [], skipped: "the free photo check is switched off" };
  // The second look runs whenever the free check does; planning only with autoFix on.
  const looking = await prisma.photoQcFinding.findMany({ where: { status: "OPEN", source: "AHDR", arbitration: "NOT_REQUIRED", photoId: { not: null } }, distinct: ["jobId"], select: { jobId: true }, take: 5 });
  let looked = 0;
  for (const j of looking) {
    if (deadline - Date.now() < 20_000) break;
    await secondLookJob(j.jobId, deadline);
    looked++;
  }
  const planned: { jobId: string; photos: number; credits: number; asIs: boolean }[] = [];
  // Ordered add-ons: suggested (and real twilights re-rendered) once the second look is done.
  const checked = await prisma.photoJob.findMany({ where: { stage: { in: ["QC_REVIEW", "READY"] }, stageChangedAt: { gte: new Date(Date.now() - 7 * 86_400_000) }, qcRuns: { some: { trigger: "AUTOHDR_CHECK", status: "DONE" } }, findings: { none: { source: "AHDR", status: "OPEN", arbitration: "NOT_REQUIRED" } } }, select: { id: true }, take: 10 });
  for (const j of checked) {
    if (deadline - Date.now() < 10_000) break;
    await suggestAddOns(j.id).catch((e) => console.warn("add-on suggestions failed", j.id, (e as Error).message));
  }
  if (settings.autoFix) {
    const jobs = await prisma.photoJob.findMany({ where: { stage: { in: ["QC_REVIEW", "READY"] }, lastQcRunId: { not: null }, stageChangedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, select: { id: true }, take: 10 });
    for (const j of jobs) {
      if (deadline - Date.now() < 10_000) break;
      const r = await planAutoFix(j.id).catch((e) => ({ planned: false, reason: (e as Error).message, photos: 0, credits: 0, asIs: false, left: 0 }));
      if (r.planned) planned.push({ jobId: j.id, photos: r.photos, credits: r.credits, asIs: r.asIs });
    }
  }
  return { looked, planned };
}

// ---------------------------------------------------------------------------
// ORDERED ADD-ONS AT QC (Oct 14 2026). Jordan: "if someone orders virtual
// twilight, that gets suggested at QC, and same with virtual staging or virtual
// declutter." And: "real twilights should be edited with the twilight photo
// model." From the order (job.expectedJson) and what the free check saw on
// each photo (room, light, furnishing):
//   · virtual twilight → the front exterior(s), suggested (one click, 5 credits)
//   · virtual staging  → the emptiest rooms, suggested with the room type
//   · virtual declutter → the most cluttered rooms, suggested (1 credit)
//   · a REAL twilight  → every dusk photo edited with the day look is
//     re-rendered with the twilight model, automatically (the order pays for
//     it; it is not part of the $5-$10 fix budget)
// Suggestions are findings with source ADDON: shown with the issues, never a
// defect in a verdict, never in the automatic fix plan.
// ---------------------------------------------------------------------------
const STAGE_ROOM: [RegExp, string][] = [[/bed/i, "bedroom"], [/dining/i, "dining_room"], [/kitchen/i, "kitchen"], [/living|family|great|den|lounge|sitting/i, "living_room"], [/office|study/i, "office"]];
const FRONT = /exterior|front|facade|façade|outside|street/i;
const NOT_FRONT = /back|rear|yard|patio|deck|pool|garden/i;

type CheckMaps = { rooms: Record<string, string>; light: Record<string, string>; furnished: Record<string, string> };
type Expected = { twilightReal?: number; twilightVirtual?: number; virtualStagingCount?: number; virtualDeclutterCount?: number };

export async function suggestAddOns(jobId: string): Promise<{ suggested: number; twilightRerenders: number; skipped?: string }> {
  const settings = await photoDeliverySettings();
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, stage: true, expectedJson: true, autohdrPhotoshootId: true } });
  if (!job) return { suggested: 0, twilightRerenders: 0, skipped: "no job" };
  const run = await prisma.photoQcRun.findFirst({ where: { jobId, trigger: "AUTOHDR_CHECK", status: "DONE" }, orderBy: { startedAt: "desc" }, select: { id: true, checksJson: true } });
  if (!run) return { suggested: 0, twilightRerenders: 0, skipped: "no finished free check" };
  if (await prisma.photoQcFinding.count({ where: { jobId, qcRunId: run.id, source: "ADDON" } })) return { suggested: 0, twilightRerenders: 0, skipped: "already suggested for this check" };
  let expected: Expected = {};
  try { expected = JSON.parse(job.expectedJson ?? "{}") as Expected; } catch { expected = {}; }
  const want = { twilight: expected.twilightVirtual ?? 0, staging: expected.virtualStagingCount ?? 0, declutter: expected.virtualDeclutterCount ?? 0, real: expected.twilightReal ?? 0 };
  if (!want.twilight && !want.staging && !want.declutter && !want.real) return { suggested: 0, twilightRerenders: 0, skipped: "no add-ons ordered" };
  let maps: CheckMaps = { rooms: {}, light: {}, furnished: {} };
  try { const p = JSON.parse(run.checksJson ?? "{}") as Partial<CheckMaps>; maps = { rooms: p.rooms ?? {}, light: p.light ?? {}, furnished: p.furnished ?? {} }; } catch { /* nothing seen */ }
  const photos = await prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE" }, orderBy: { sequence: "asc" }, select: { id: true, name: true, sequence: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, contentHash: true } });
  const room = (id: string) => maps.rooms[id] ?? "";
  type Pick = { photoId: string; ruleId: string; text: string; params?: Record<string, unknown> };
  const picks: Pick[] = [];
  if (want.twilight) {
    const day = (id: string) => (maps.light[id] ?? "day") === "day";
    const fronts = photos.filter((p) => FRONT.test(room(p.id)) && !NOT_FRONT.test(room(p.id)) && day(p.id));
    const exteriors = fronts.length ? fronts : photos.filter((p) => /exterior|outside/i.test(room(p.id)) && day(p.id));
    for (const p of exteriors.slice(0, want.twilight)) picks.push({ photoId: p.id, ruleId: "ADDON_VIRTUAL_TWILIGHT", text: `Ordered: virtual twilight. Suggested here: the ${room(p.id) || "exterior"}.` });
  }
  if (want.staging) {
    const stageable = photos
      .map((p) => ({ p, type: STAGE_ROOM.find(([re]) => re.test(room(p.id)))?.[1] ?? null, f: maps.furnished[p.id] }))
      .filter((x) => x.type && (x.f === "empty" || x.f === "sparse"))
      .sort((a, b) => Number(b.f === "empty") - Number(a.f === "empty") || a.p.sequence - b.p.sequence);
    for (const x of stageable.slice(0, want.staging)) picks.push({ photoId: x.p.id, ruleId: "ADDON_VIRTUAL_STAGING", text: `Ordered: virtual staging. Suggested here: ${x.f === "empty" ? "an empty" : "a sparsely furnished"} ${room(x.p.id) || "room"}.`, params: { room_type: x.type } });
  }
  if (want.declutter) {
    const prep = await prisma.photoQcFinding.findMany({ where: { jobId, status: { in: ["OPEN", "IGNORED"] }, photoId: { in: photos.map((p) => p.id) } }, select: { photoId: true, ruleId: true } });
    const count = new Map<string, number>();
    for (const f of prep) if (fixClass(f.ruleId) === "prep") count.set(f.photoId!, (count.get(f.photoId!) ?? 0) + 1);
    const messy = photos.filter((p) => (count.get(p.id) ?? 0) > 0).sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || a.sequence - b.sequence);
    for (const p of messy.slice(0, want.declutter)) picks.push({ photoId: p.id, ruleId: "ADDON_VIRTUAL_DECLUTTER", text: `Ordered: virtual declutter. Suggested here: ${count.get(p.id)} clutter item${count.get(p.id) === 1 ? "" : "s"} in the ${room(p.id) || "room"}.` });
  }
  const dusk = want.real ? photos.filter((p) => maps.light[p.id] === "twilight" || maps.light[p.id] === "night") : [];
  for (const p of dusk) picks.push({ photoId: p.id, ruleId: "ADDON_REAL_TWILIGHT_LOOK", text: "Real twilight photo edited with the day look: re-render it with the twilight model.", params: { model_id: settings.realTwilightModelId } });
  if (!picks.length) {
    await logJobEvent(jobId, "add-ons", `ordered add-ons: no photo fits yet (twilight ${want.twilight}, staging ${want.staging}, declutter ${want.declutter}, real twilight ${want.real})`);
    return { suggested: 0, twilightRerenders: 0 };
  }
  const created = [];
  for (const k of picks) {
    const rule = ruleById(k.ruleId)!;
    const p = photos.find((x) => x.id === k.photoId)!;
    created.push(await prisma.photoQcFinding.create({
      data: { qcRunId: run.id, jobId, photoId: k.photoId, ruleId: k.ruleId, groupKey: rule.groupKey, pass: "P1_PHOTO", source: "ADDON", specificIssue: k.text, explanation: "Ordered by the client; suggested by the free photo check.", severity: "MINOR", confidence: 0.9, responsibility: "ADMIN", fixStrategy: rule.fixStrategies[0], arbitration: "CONFIRMED", contentHash: p.contentHash, coercedJson: k.params ? JSON.stringify({ params: k.params }) : null, rulesVersion: "addons-2026-10-14" },
    }));
  }
  // Real twilights: re-rendered with the twilight model now (the order pays; not the fix budget).
  let rerenders = 0;
  const realOnes = created.filter((f) => f.ruleId === "ADDON_REAL_TWILIGHT_LOOK");
  if (realOnes.length && settings.autoFix) {
    const { modelCatalog } = await import("./catalog");
    const price = (await modelCatalog().catch(() => null))?.find((m) => m.id === settings.realTwilightModelId)?.style_credit_cost ?? null;
    const shootable = realOnes.filter((f) => { const p = photos.find((x) => x.id === f.photoId); return !!p?.autohdrImageUuid && !!shootIdOf(p, job.autohdrPhotoshootId); });
    if (price != null && shootable.length) {
      await prisma.$transaction(async (tx) => {
        const b = await tx.photoFixBatch.create({ data: { jobId, mode: "AUTO", estimatedCredits: price * shootable.length, estimatedUsdCents: 0, approvedBy: "auto-twilight", status: "PENDING" } });
        for (const f of shootable) {
          await tx.photoFixOperation.create({ data: { batchId: b.id, jobId, photoId: f.photoId!, findingIdsJson: JSON.stringify([f.id]), seq: 0, strategy: "STYLE_RERENDER", transformName: "style", paramsJson: JSON.stringify({ model_id: settings.realTwilightModelId }), estimatedCredits: price, status: "QUEUED" } });
          await tx.photoQcFinding.update({ where: { id: f.id }, data: { status: "APPROVED_FIX", decidedBy: "auto-twilight", decidedAt: new Date() } });
        }
      });
      rerenders = shootable.length;
      if (["QC_REVIEW", "READY"].includes(job.stage)) await setStage(jobId, ["QC_REVIEW", "READY"], "FIXING", "auto-twilight", { why: `real twilight: ${rerenders} dusk photo${rerenders === 1 ? "" : "s"} re-rendered with the twilight model` });
    }
  }
  const suggested = created.length - realOnes.length;
  await logJobEvent(jobId, "add-ons", `ordered add-ons: ${suggested} suggestion${suggested === 1 ? "" : "s"} for a person${rerenders ? `, ${rerenders} real twilight photo${rerenders === 1 ? "" : "s"} re-rendered with the twilight model automatically` : ""}`, { suggested, rerenders, want });
  return { suggested, twilightRerenders: rerenders };
}

// ---------------------------------------------------------------------------
// THE SHOOT'S FIX BUDGET (Oct 14 2026). Jordan: "allow kyle to submit fixes -
// but let him know the budget and whats been spent already." One count for the
// automatic plan, the runner's last check before a paid call, and the Fix Cart:
// every QC fix on the shoot (automatic and by hand), charged or waiting to run.
// Ordered add-ons (virtual twilight, staging, declutter, the real-twilight
// look) are the client's order, not the fix budget.
// ---------------------------------------------------------------------------
// What counts (Oct 14 2026, huddle finding 7, "confirm whether manual fixes,
// retries and reprocessing count toward the cap"):
//   · COUNTS: every paid fix, automatic or by hand; a second (or third) paid
//     edit of the same photo; a fix put back after the check (AutoHDR still
//     charged it); a fix waiting to run (held against the budget).
//   · NEVER COUNTS: a fix AutoHDR refunded (it failed, or changed nothing);
//     ordered add-ons; anything free: the checks, re-downloads, restoring a
//     version, AutoHDR's own editor (Perspective Off, Crop & Tilt).
export type FixBudget = {
  targetCredits: number; maxCredits: number; spent: number; pending: number; automatic: number; byHand: number; usdPerCredit: number;
  /** Paid, then put back after the check (still charged). */
  reverted: number;
  /** Paid edits of a photo that already had one (counted). */
  repeats: number;
  /** Refunded by AutoHDR (failed or changed nothing): not counted. */
  refunded: number;
};

export async function fixBudgetFor(jobId: string): Promise<FixBudget> {
  const settings = await photoDeliverySettings();
  const { usdPerCredit } = await creditThresholds();
  const ops = await prisma.photoFixOperation.findMany({
    where: { jobId, status: { notIn: ["CANCELLED"] }, batch: { approvedBy: { not: "auto-twilight" } } },
    orderBy: { createdAt: "asc" },
    select: { photoId: true, status: true, chargedCredits: true, estimatedCredits: true, refunded: true, strategy: true, findingIdsJson: true, batch: { select: { approvedBy: true } } },
  });
  const addOnFindings = new Set((await prisma.photoQcFinding.findMany({ where: { jobId, source: "ADDON" }, select: { id: true } })).map((f) => f.id));
  let spent = 0, pending = 0, automatic = 0, byHand = 0, reverted = 0, repeats = 0, refunded = 0;
  const paidPhotos = new Set<string>();
  for (const o of ops) {
    if (o.strategy === "VIRTUAL_TWILIGHT" || o.strategy === "VIRTUAL_STAGING") continue;
    let ids: string[] = [];
    try { ids = JSON.parse(o.findingIdsJson) as string[]; } catch { ids = []; }
    if (ids.length && ids.every((id) => addOnFindings.has(id))) continue;
    if (o.refunded) {
      refunded += o.chargedCredits ?? 0;
      continue;
    }
    const charged = o.chargedCredits ?? 0;
    const waiting = ["QUEUED", "SUBMITTING"].includes(o.status) && o.chargedCredits == null ? o.estimatedCredits ?? 0 : 0;
    spent += charged;
    pending += waiting;
    if (o.status === "REVERTED") reverted += charged;
    if (charged + waiting > 0) {
      if (paidPhotos.has(o.photoId)) repeats += charged + waiting;
      paidPhotos.add(o.photoId);
    }
    if (o.batch.approvedBy === "auto-fix") automatic += charged + waiting;
    else byHand += charged + waiting;
  }
  return { targetCredits: Math.floor(settings.fixTargetUsd / usdPerCredit + 1e-9), maxCredits: Math.floor(settings.fixMaxUsd / usdPerCredit + 1e-9), spent, pending, automatic, byHand, usdPerCredit, reverted, repeats, refunded };
}
