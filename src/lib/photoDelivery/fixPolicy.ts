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
//     dust spots), perspective and lens distortion, cars, trash cans.
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
const PERSPECTIVE = ["PERSP_CROOKED_VERTICALS", "PERSP_LEANING_DOOR_FRAMES", "PERSP_EXTERIOR_WALLS_LEANING", "PERSP_CROOKED_HORIZON", "PERSP_HORIZONTAL_DISTORTION", "PERSP_BOWED_WALLS", "BED_WIDE_ANGLE_DISTORTION"];
const VEHICLES = ["EXT_PARKED_CARS_DRIVEWAY", "EXT_VEHICLES_BLOCKING_HOME", "EXT_VEHICLES_THROUGH_WINDOWS"];
const TRASH = ["PREP_TRASH_CANS", "EXT_TRASH_CANS_PRIMARY", "BATH_TRASH_CANS", "UTIL_GARAGE_TRASH_CANS", "LIV_OFFICE_TRASH_CANS", "PREP_GARBAGE_BAGS_LOOSE_TRASH"];
export const ALWAYS_FIX = new Set([...CAMERA, ...PERSPECTIVE, ...VEHICLES, ...TRASH]);
/** A person decides these, every time. */
const NEVER_AUTO = new Set(["PREP_PERSONAL_DOCUMENTS", "PREP_PERSONAL_PHOTOS", "BED_PERSONAL_PHOTOS_SENSITIVE", "PREP_VISIBLE_PEOPLE_PETS", "OTHER_DEFECT"]);
const PREP_PREFIX = /^(PREP|KIT|BATH|BED|LIV|UTIL|EXT)_/;

export type FixClass = "always" | "prep" | "never";

export function fixClass(ruleId: string): FixClass {
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
  EXT_PARKED_CARS_DRIVEWAY: "Remove the parked cars and fill in the driveway or street naturally",
  EXT_VEHICLES_BLOCKING_HOME: "Remove the vehicles and fill in the street, driveway and house behind them naturally",
  EXT_VEHICLES_THROUGH_WINDOWS: "Remove the vehicle seen through the window",
  PERSP_CROOKED_VERTICALS: "Straighten the vertical lines so the walls, door frames and building edges are perfectly vertical",
  PERSP_LEANING_DOOR_FRAMES: "Straighten the door frames so they are perfectly vertical",
  PERSP_EXTERIOR_WALLS_LEANING: "Straighten the building so its walls are perfectly vertical",
  PERSP_CROOKED_HORIZON: "Level the photo so the horizon and horizontal lines are straight",
  PERSP_HORIZONTAL_DISTORTION: "Correct the perspective so horizontal lines run level",
  PERSP_BOWED_WALLS: "Correct the lens distortion so the walls are straight, not bowed",
  BED_WIDE_ANGLE_DISTORTION: "Correct the wide-angle distortion so the furniture and walls look natural",
  BATH_TOILET_SEAT_OPEN: "Close the toilet seat and lid",
  BED_UNMADE: "Make the bed neatly with smooth bedding",
  PREP_INCONSISTENT_BLINDS: "Set all the window blinds to the same even height",
  KIT_OPEN_APPLIANCE_DOORS: "Close the open appliance doors",
};

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
// THE PLAN
// ---------------------------------------------------------------------------
export type PlanResult = { planned: boolean; reason: string; photos: number; credits: number; asIs: boolean; left: number };

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
  const findings = await prisma.photoQcFinding.findMany({
    where: { jobId, status: "OPEN", photoId: { in: photos.map((p) => p.id) }, arbitration: { not: "OVERTURNED" }, confidence: { gte: 0.6 }, privacySensitive: false },
    select: { id: true, photoId: true, ruleId: true, severity: true, confidence: true, locationText: true, reeditPrompt: true },
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
  for (const p of photos) {
    if (!p.autohdrImageUuid || !shootIdOf(p, job.autohdrPhotoshootId)) continue;
    const mine = findings.filter((f) => f.photoId === p.id);
    const always = mine.filter((f) => fixClass(f.ruleId) === "always");
    const prep = asIs ? [] : mine.filter((f) => fixClass(f.ruleId) === "prep");
    if (!always.length && !prep.length) continue;
    const worst = Math.max(...[...always, ...prep].map((f) => SEVERITY_RANK[(f.severity as Severity) ?? "MINOR"] ?? 0));
    cands.push({ photo: p, always, prep, worst });
  }
  // Camera, car and trash photos first, the worst first; then front of the gallery first.
  cands.sort((a, b) => Number(!!b.always.length) - Number(!!a.always.length) || b.worst - a.worst || b.always.length + b.prep.length - (a.always.length + a.prep.length) || a.photo.sequence - b.photo.sequence);
  const chosen: Cand[] = [];
  let credits = 0;
  for (const c of cands) {
    const cap = c.always.length ? max : target;
    if (credits + price > cap) continue;
    if (spentToday + credits + price > settings.autoFixDailyMaxCredits) break;
    chosen.push(c);
    credits += price;
  }
  const leftOver = cands.length - chosen.length;
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
export type FixBudget = { targetCredits: number; maxCredits: number; spent: number; pending: number; automatic: number; byHand: number; usdPerCredit: number };

export async function fixBudgetFor(jobId: string): Promise<FixBudget> {
  const settings = await photoDeliverySettings();
  const { usdPerCredit } = await creditThresholds();
  const ops = await prisma.photoFixOperation.findMany({
    where: { jobId, status: { notIn: ["CANCELLED"] }, batch: { approvedBy: { not: "auto-twilight" } } },
    select: { status: true, chargedCredits: true, estimatedCredits: true, refunded: true, strategy: true, findingIdsJson: true, batch: { select: { approvedBy: true } } },
  });
  const addOnFindings = new Set((await prisma.photoQcFinding.findMany({ where: { jobId, source: "ADDON" }, select: { id: true } })).map((f) => f.id));
  let spent = 0, pending = 0, automatic = 0, byHand = 0;
  for (const o of ops) {
    if (o.strategy === "VIRTUAL_TWILIGHT" || o.strategy === "VIRTUAL_STAGING") continue;
    let ids: string[] = [];
    try { ids = JSON.parse(o.findingIdsJson) as string[]; } catch { ids = []; }
    if (ids.length && ids.every((id) => addOnFindings.has(id))) continue;
    const charged = o.refunded ? 0 : o.chargedCredits ?? 0;
    const waiting = ["QUEUED", "SUBMITTING"].includes(o.status) && o.chargedCredits == null ? o.estimatedCredits ?? 0 : 0;
    spent += charged;
    pending += waiting;
    if (o.batch.approvedBy === "auto-fix") automatic += charged + waiting;
    else byHand += charged + waiting;
  }
  return { targetCredits: Math.floor(settings.fixTargetUsd / usdPerCredit + 1e-9), maxCredits: Math.floor(settings.fixMaxUsd / usdPerCredit + 1e-9), spent, pending, automatic, byHand, usdPerCredit };
}
