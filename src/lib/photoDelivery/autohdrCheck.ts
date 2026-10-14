import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { autohdr, autohdrConfigured, AutohdrError } from "@/lib/integrations/autohdr";
import { photoDeliverySettings } from "./settings";
import { logJobEvent, setStage } from "./jobState";
import { ruleById, RULES_REGISTRY_VERSION } from "./registry";
import { jobVerdict, photoVerdicts, qcStageFor } from "./qc/verdict";
import { disabledIn, houseOverrides } from "./houseRules";
import { instructionFor } from "./fixPolicy";

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
// "(N of M)" position). A photo without one is skipped, and the run says so.
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
] as const;

const ALLOWED = new Set<string>(CHECK_RULES);
export const CHECK_PROMPT_VERSION = 1;
const PER_PHOTO_TRIES = 3;
const CONCURRENCY = 4;

/** The one question every photo is asked. Built from the registry's own labels; a switched-off check is left out. */
export function checkPrompt(off: Set<string> = new Set()): string {
  const lines = CHECK_RULES.filter((id) => !off.has(id)).map((id) => `${id}: ${ruleById(id)?.shortLabel ?? id.toLowerCase().replace(/_/g, " ")}`);
  return [
    "You are checking a real estate listing photo before it goes to the client.",
    'Answer ONLY with JSON: {"room":"<room type>","issues":[{"id":"<one id from the list>","where":"<short location in the frame>","confidence":<0 to 1>}]}.',
    "Report only problems you can actually see in this photo. An empty list is a good answer.",
    "Ids:",
    ...lines,
  ].join("\n");
}

export type CheckIssue = { ruleId: string; where: string; confidence: number };

/** Read describe's answer. Pure. Unknown ids, duplicates and junk are dropped. */
export function parseCheckAnswer(text: string, off: Set<string> = new Set()): { room: string | null; issues: CheckIssue[] } | null {
  const body = text.replace(/```(?:json)?/gi, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j: { room?: unknown; issues?: unknown };
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
  return { room: typeof j.room === "string" ? j.room.slice(0, 60) : null, issues };
}

type Progress = { done: Record<string, number>; errors: Record<string, number>; skipped: string[]; rooms: Record<string, string> };
const readProgress = (json: string | null | undefined): Progress => {
  try {
    const p = JSON.parse(json ?? "{}") as Partial<Progress>;
    return { done: p.done ?? {}, errors: p.errors ?? {}, skipped: p.skipped ?? [], rooms: p.rooms ?? {} };
  } catch {
    return { done: {}, errors: {}, skipped: [], rooms: {} };
  }
};

type Photo = { id: string; name: string; sourceKind: string; sourceRef: string | null; autohdrImageUuid: string | null; contentHash: string | null };

/** Which AutoHDR shoot a photo lives in. */
function shootOf(p: Photo, jobShoot: number | null): number | null {
  if (p.sourceKind === "AUTOHDR" && p.sourceRef?.includes("/")) {
    const n = Number(p.sourceRef.split("/")[0]);
    return Number.isFinite(n) ? n : null;
  }
  return jobShoot;
}

let describeImpl: ((shootId: number, imageUuid: string, prompt: string) => Promise<string>) | null = null;
/** Drills only. */
export function __setDescribeForTests(fn: typeof describeImpl) {
  describeImpl = fn;
}
const describe = (shootId: number, imageUuid: string, prompt: string) => (describeImpl ? describeImpl(shootId, imageUuid, prompt) : autohdr.describe(shootId, imageUuid, { prompt }));

export type CheckSummary = { skipped?: string; jobs: { jobId: string; checked: number; findings: number; finished: boolean; verdict?: string }[] };

/** Jobs to check: a run under way, then landed galleries not yet checked. */
async function jobsToCheck(take: number): Promise<string[]> {
  const running = await prisma.photoQcRun.findMany({ where: { trigger: "AUTOHDR_CHECK", status: "RUNNING" }, orderBy: { startedAt: "asc" }, select: { jobId: true }, take });
  const landed = await prisma.photoJob.findMany({
    where: { stage: "EDITED", photos: { some: { status: "ACTIVE", autohdrImageUuid: { not: null } } } },
    orderBy: { stageChangedAt: "asc" },
    select: { id: true, finalsChangedAt: true, qcRuns: { where: { trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } } },
    take: take * 3,
  });
  const fresh = landed.filter((j) => !j.qcRuns[0] || (j.finalsChangedAt && j.finalsChangedAt > j.qcRuns[0].startedAt)).map((j) => j.id);
  return [...new Set([...running.map((r) => r.jobId), ...fresh])].slice(0, take);
}

/** One bounded slice: safe every 5 minutes, resumable photo by photo. */
export async function driveAutohdrChecks(opts: { budgetMs: number; maxJobs?: number }): Promise<CheckSummary> {
  const started = Date.now();
  const settings = await photoDeliverySettings();
  if (!settings.enabled || !settings.freeCheck) return { skipped: "the free photo check is switched off", jobs: [] };
  if (!(await autohdrConfigured())) return { skipped: "AutoHDR API not connected", jobs: [] };
  const out: CheckSummary = { jobs: [] };
  for (const jobId of await jobsToCheck(opts.maxJobs ?? 3)) {
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
    let run = await prisma.photoQcRun.findFirst({ where: { jobId, trigger: "AUTOHDR_CHECK", status: "RUNNING" }, orderBy: { startedAt: "desc" } });
    if (!run) {
      run = await prisma.photoQcRun.create({
        data: { jobId, trigger: "AUTOHDR_CHECK", status: "RUNNING", shadow: settings.qcShadow, rulesVersion: RULES_REGISTRY_VERSION, promptVersionsJson: JSON.stringify({ autohdrCheck: CHECK_PROMPT_VERSION }), modelsJson: JSON.stringify({ describe: "AutoHDR describe (free)" }), checksJson: JSON.stringify({ done: {}, errors: {}, skipped: [], rooms: {} }) },
      });
      await logJobEvent(jobId, "autohdr-check", "free photo check started (AutoHDR describe, no credits)", { runId: run.id });
    }
    const photos: Photo[] = await prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE" }, orderBy: { sequence: "asc" }, select: { id: true, name: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, contentHash: true } });
    const progress = readProgress(run.checksJson);
    const house = await houseOverrides();
    const off = disabledIn(house);
    const prompt = checkPrompt(off);
    const todo = photos.filter((p) => !(p.id in progress.done) && (progress.errors[p.id] ?? 0) < PER_PHOTO_TRIES && !progress.skipped.includes(p.id));
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
      for (const a of answers) {
        if (a.error === "gone") { progress.skipped.push(a.p.id); continue; }
        const parsed = a.text ? parseCheckAnswer(a.text, off) : null;
        if (!parsed) { progress.errors[a.p.id] = (progress.errors[a.p.id] ?? 0) + 1; continue; }
        progress.done[a.p.id] = parsed.issues.length;
        if (parsed.room) progress.rooms[a.p.id] = parsed.room;
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
            reeditPrompt: instructionFor(rule.id, iss.where),
          });
        }
      }
      await prisma.$transaction([
        prisma.photoQcFinding.createMany({ data: rows }),
        prisma.photoQcRun.update({ where: { id: run.id }, data: { checksJson: JSON.stringify(progress) } }),
      ]);
      await prisma.photoJob.update({ where: { id: jobId }, data: { leaseUntil: new Date(Date.now() + 4 * 60_000) } });
    }
    const remaining = photos.filter((p) => !(p.id in progress.done) && !progress.skipped.includes(p.id) && (progress.errors[p.id] ?? 0) < PER_PHOTO_TRIES);
    if (remaining.length) {
      await prisma.photoQcRun.update({ where: { id: run.id }, data: { checksJson: JSON.stringify(progress) } });
      return { jobId, checked, findings: found, finished: false };
    }
    return { jobId, checked, findings: found, ...(await finishCheck(jobId, run.id, photos, progress)) };
  } finally {
    await prisma.photoJob.updateMany({ where: { id: jobId, leaseOwner: "autohdr-check" }, data: { leaseUntil: null, leaseOwner: null } });
  }
}

async function finishCheck(jobId: string, runId: string, photos: Photo[], progress: Progress): Promise<{ finished: true; verdict: string }> {
  const settings = await photoDeliverySettings();
  // Earlier free-check findings on this job are history once this run is done.
  await prisma.photoQcFinding.updateMany({ where: { jobId, status: "OPEN", source: "AHDR", qcRunId: { not: runId } }, data: { status: "SUPERSEDED", statusReason: `re-checked in run ${runId}` } });
  const findings = await prisma.photoQcFinding.findMany({
    where: { jobId, status: { not: "SUPERSEDED" } },
    select: { id: true, ruleId: true, groupKey: true, photoId: true, photoIdsJson: true, severity: true, confidence: true, status: true, arbitration: true, privacySensitive: true, specificIssue: true, source: true },
  });
  const opts = { floor: settings.displayConfidenceFloor, overrides: await houseOverrides() };
  const verdict = jobVerdict(findings, opts);
  const per = photoVerdicts(findings, photos.map((p) => p.id), opts);
  const shadow = settings.qcShadow;
  const target = qcStageFor(verdict, shadow);
  const checked = Object.keys(progress.done).length;
  await prisma.$transaction([
    ...photos.filter((p) => p.id in progress.done).map((p) => prisma.photoAsset.update({ where: { id: p.id }, data: { verdict: per[p.id] ?? "PASS", lastQcAt: new Date() } })),
    prisma.photoQcRun.update({
      where: { id: runId },
      data: {
        status: "DONE", verdict: verdict.verdict, finishedAt: new Date(), photoCount: checked, costUsd: 0, checksJson: JSON.stringify(progress),
        summaryJson: JSON.stringify({ engine: "autohdr-describe", verdict: verdict.verdict, counts: verdict.counts, checked, skipped: progress.skipped.length, failed: Object.keys(progress.errors).filter((k) => !(k in progress.done)).length }),
      },
    }),
  ]);
  const moved = await setStage(jobId, ["EDITED"], target, "autohdr-check", {
    why: `free photo check ${shadow ? "(shadow) " : ""}verdict ${verdict.verdict}`,
    data: { runId, counts: verdict.counts, checked, skipped: progress.skipped.length },
    extra: { qcVerdict: verdict.verdict, qcShadow: shadow, lastQcRunId: runId, lastError: null },
  });
  if (!moved) {
    // Another engine moved the job first (the paid QC, a delivery): keep the
    // findings, leave the stage alone, but still point at the latest verdict.
    await prisma.photoJob.update({ where: { id: jobId }, data: { lastQcRunId: runId, qcVerdict: verdict.verdict } }).catch(() => {});
  }
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  const project = job ? await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true } }) : null;
  const street = (project?.title ?? "A shoot").split(",")[0];
  const issues = verdict.counts.critical + verdict.counts.major + verdict.counts.minor;
  const { bellOnly } = await import("./qc/run");
  await bellOnly({
    kind: "photo_free_check",
    title: `${street}: photo check done, ${issues ? `${issues} thing${issues === 1 ? "" : "s"} to look at` : "nothing found"}`.slice(0, 120),
    body: `${checked} photos checked by AutoHDR's free check${progress.skipped.length ? ` (${progress.skipped.length} could not be checked)` : ""}.`,
    href: `/ops/photo-delivery/${jobId}`,
    dedupeKey: `photo-free-check-${runId}`,
    to: "both",
  }).catch(() => 0);
  await logJobEvent(jobId, "autohdr-check", `free photo check done: ${verdict.verdict}, ${checked} photos, ${issues} issue groups (${appBase()}/ops/photo-delivery/${jobId})`);
  return { finished: true, verdict: verdict.verdict };
}
