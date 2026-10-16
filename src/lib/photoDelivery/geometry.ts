import "server-only";

import { prisma } from "@/lib/prisma";
import { autohdr, AutohdrError } from "@/lib/integrations/autohdr";
import { photoDeliverySettings } from "./settings";
import { logJobEvent } from "./jobState";
import { describePhoto, jsonFrom, refreshVerdict } from "./fixPolicy";
import { readProgress, type Progress } from "./autohdrCheck";
import { geometryWords, lineGeometry, lumaOf, type LineGeometry } from "./qc/cv";
import { RULES_REGISTRY_VERSION } from "./registry";

// ---------------------------------------------------------------------------
// WARPED OR NOT, MEASURED (Oct 15 2026).
//
// Jordan: "the biggest thing I need is making sure images are not warped or
// cluttered." The free check is a text judgement; this adds two free checks
// once it (and its second look) finished on a job:
//
//   1. THE MEASUREMENT (warpCv): every photo's lines (qc/cv.ts lineGeometry):
//      leaning verticals and bent walls, door frames, windows and cabinets.
//      Only from bytes the hub can read for free: a kept version copy, the
//      Aryeo listing image, a Dropbox file, or an AutoHDR photo the hub
//      already bought. A photo that would cost a credit to download is not
//      measured, and says so. Then, per photo:
//        · the check and the measurement agree   → the finding counts in full;
//        · the check says so, the lines measure straight → MINOR, and says why;
//        · warped walls the check saw but nothing could measure → MINOR too
//          (leaning lines keep their weight: AutoHDR's free Crop & Tilt);
//        · only the measurement says so → an advisory finding below the
//          confidence floor (the Low confidence drawer: never blocks).
//   2. THE ORIGINAL (warpCompareOriginal): for a cut-off roof or warped walls,
//      AutoHDR's free describe is asked about the photo's ORIGINAL (its first
//      version, before AutoHDR's straightening), not the edit:
//        · the original was fine → the edit did it: EDITOR, Perspective Off
//          on that photo in AutoHDR (free);
//        · the original has it too → the framing or the lens did: PHOTOGRAPHER
//          (coaching; a cut-off roof needs a reshoot).
//      Written into the finding (responsibility, what to do).
// Both are resumable and bounded; the fix plan waits for them on a v3 check.
// ---------------------------------------------------------------------------

/** The free check's findings the measurement speaks to. */
const LEAN_RULES = ["PERSP_CROOKED_VERTICALS", "PERSP_LEANING_DOOR_FRAMES", "PERSP_EXTERIOR_WALLS_LEANING"];
const WARP_RULE = "PERSP_EDIT_WARP";
const ROOF_RULE = "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED";
/** Compared against the Original. */
const ORIGINAL_RULES = [ROOF_RULE, WARP_RULE];
/** Below the default display floor (0.5): shown in the Low confidence drawer, never blocking. */
export const ADVISORY_CONFIDENCE = 0.45;
const AGREE_CONFIDENCE = 0.85;
const DISAGREE_CONFIDENCE = 0.55;
const CONCURRENCY = 2;

/** What is kept per photo in the run's checksJson.geometry. */
export type StoredGeometry = { m?: { lines: number; tilt: number | null; bent: number; bow: number; crooked: boolean; warped: boolean; words: string }; skipped?: string };

type GPhoto = { id: string; name: string; jobId: string; sourceKind: string; sourceUrl: string | null; sourceRef: string | null; dropboxPath: string | null; contentHash: string | null; autohdrImageUuid: string | null; autohdrVersionUuid: string | null };

let decodeHook: ((bytes: Buffer) => Promise<LineGeometry>) | null = null;
/** Drills only. */
export function __setGeometryDecodeForTests(fn: typeof decodeHook) {
  decodeHook = fn;
}

/** Measure a photo's lines from its bytes (about 1024 px wide). */
export async function measureBytes(bytes: Buffer): Promise<LineGeometry> {
  if (decodeHook) return decodeHook(bytes);
  const D = await import("./qc/derivatives");
  const meta = await D.readMeta(bytes);
  const r = await D.decodeRaster(bytes, meta, 1024);
  return lineGeometry(lumaOf(r.data, r.width * r.height), r.width, r.height);
}

/**
 * The photo's current bytes, ONLY when reading them is free. Never a paid
 * download: an AutoHDR photo the hub has not bought yet is skipped, with why.
 */
export async function freeBytesOf(p: GPhoto): Promise<{ bytes: Buffer } | { skipped: string }> {
  // A version copy the hub already keeps (2048 px, private store), of this exact version.
  const v = await prisma.photoVersion.findFirst({
    where: { photoId: p.id, OR: [...(p.contentHash ? [{ contentHash: p.contentHash }] : []), ...(p.autohdrVersionUuid ? [{ autohdrVersionUuid: p.autohdrVersionUuid }] : [])] },
    orderBy: { createdAt: "desc" },
    select: { derivJson: true },
  }).catch(() => null);
  if (v?.derivJson) {
    const { versionMeta } = await import("./versions");
    const preview = versionMeta(v.derivJson).preview;
    if (preview) {
      const { readDerivativeBytes } = await import("./blob");
      const b = await readDerivativeBytes(preview).catch(() => null);
      if (b?.length) return { bytes: b };
    }
  }
  const kind = (p.sourceKind || "DROPBOX").toUpperCase();
  if (kind === "AUTOHDR") {
    // Bought already (display.ts): a link on the row, or the intake says downloaded.
    let bought = !!p.sourceUrl;
    if (!bought) {
      const [shoot, uuid] = (p.sourceRef ?? "").split("/");
      const batch = Number.isFinite(Number(shoot)) && uuid ? await prisma.photoIntakeBatch.findFirst({ where: { photoshootId: Number(shoot) }, select: { photosJson: true } }) : null;
      try {
        bought = (JSON.parse(batch?.photosJson ?? "[]") as { image_uuid: string; downloaded?: boolean }[]).some((e) => e.image_uuid === uuid && e.downloaded);
      } catch {
        bought = false;
      }
    }
    if (!bought) return { skipped: "not downloaded from AutoHDR yet (downloading it would cost a credit)" };
  } else if (kind !== "ARYEO" && kind !== "DROPBOX") {
    return { skipped: `no free copy of this photo (${kind.toLowerCase()})` };
  }
  try {
    const { loadPhotoBytes } = await import("./qc/source");
    return { bytes: await loadPhotoBytes(p) };
  } catch (e) {
    return { skipped: `the photo could not be read (${((e as { publicReason?: string }).publicReason ?? (e as Error).message).slice(0, 120)})` };
  }
}

const compact = (g: LineGeometry): NonNullable<StoredGeometry["m"]> => ({ lines: g.verticalLines, tilt: g.tiltDeg, bent: g.bentLines, bow: g.maxBowPx, crooked: g.crooked, warped: g.warped, words: geometryWords(g) });

/** Agree, disagree, or cannot tell, for one finding against its photo's measurement. Pure. */
export function measuredVerdict(ruleId: string, g: StoredGeometry | undefined): "agree" | "disagree" | "unmeasured" {
  if (!g?.m) return "unmeasured";
  if (LEAN_RULES.includes(ruleId)) return g.m.lines < 8 ? "unmeasured" : g.m.crooked ? "agree" : "disagree";
  if (ruleId === WARP_RULE) return g.m.lines < 3 ? "unmeasured" : g.m.warped ? "agree" : "disagree";
  return "unmeasured";
}

type Coerced = { measured?: string; original?: { verdict: "edit" | "capture" | "skipped"; note: string }; originalTries?: number } & Record<string, unknown>;
const coercedOf = (json: string | null): Coerced => jsonFrom<Coerced>(json ?? "") ?? {};

/** Jobs whose v3 free check finished and whose measured check has not. */
export async function driveGeometry(opts: { deadline: number }): Promise<{ jobs: number; measured: number; compared: number; skipped: number; finished: number }> {
  const out = { jobs: 0, measured: 0, compared: 0, skipped: 0, finished: 0 };
  const settings = await photoDeliverySettings();
  if (!settings.enabled || !settings.freeCheck || (!settings.warpCv && !settings.warpCompareOriginal)) return out;
  const runs = await prisma.photoQcRun.findMany({
    where: { trigger: "AUTOHDR_CHECK", status: "DONE", startedAt: { gte: new Date(Date.now() - 7 * 86_400_000) }, checksJson: { contains: '"geometryDone":false' } },
    orderBy: { startedAt: "asc" },
    select: { id: true, jobId: true },
    take: 10,
  });
  for (const r of runs) {
    if (opts.deadline - Date.now() < 15_000) break;
    const res = await geometryJob(r.jobId, r.id, opts.deadline).catch((e) => {
      console.warn("photo delivery: geometry failed", r.jobId, (e as Error).message);
      return null;
    });
    if (!res) continue;
    out.jobs++;
    out.measured += res.measured;
    out.compared += res.compared;
    out.skipped += res.skipped;
    if (res.done) out.finished++;
  }
  return out;
}

async function saveProgress(runId: string, progress: Progress) {
  await prisma.photoQcRun.update({ where: { id: runId }, data: { checksJson: JSON.stringify(progress) } });
}

export async function geometryJob(jobId: string, runId: string, deadline: number): Promise<{ done: boolean; measured: number; compared: number; skipped: number }> {
  const none = { done: false, measured: 0, compared: 0, skipped: 0 };
  const settings = await photoDeliverySettings();
  const [run, newest, job] = await Promise.all([
    prisma.photoQcRun.findUnique({ where: { id: runId }, select: { id: true, checksJson: true, status: true } }),
    prisma.photoQcRun.findFirst({ where: { jobId, trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" }, select: { id: true } }),
    prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, autohdrPhotoshootId: true, projectId: true } }),
  ]);
  if (!run || !job || run.status !== "DONE") return none;
  const progress = readProgress(run.checksJson);
  if (newest && newest.id !== runId) {
    // A newer check is on its way: this one is history.
    progress.geometryDone = true;
    await saveProgress(runId, progress);
    return { ...none, done: true };
  }
  // The second look settles the free check's findings first.
  if (await prisma.photoQcFinding.count({ where: { jobId, status: "OPEN", source: "AHDR", arbitration: "NOT_REQUIRED", photoId: { not: null } } })) return none;
  const photos: GPhoto[] = await prisma.photoAsset.findMany({
    where: { jobId, status: "ACTIVE" },
    orderBy: { sequence: "asc" },
    select: { id: true, name: true, jobId: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true, contentHash: true, autohdrImageUuid: true, autohdrVersionUuid: true },
  });
  const geo = (progress.geometry ??= {}) as Record<string, StoredGeometry>;
  let measured = 0, skipped = 0, compared = 0;

  // 1. The measurement, photo by photo.
  if (settings.warpCv) {
    const todo = photos.filter((p) => !geo[p.id]);
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      if (deadline - Date.now() < 10_000) {
        await saveProgress(runId, progress);
        return { done: false, measured, compared, skipped };
      }
      await Promise.all(
        todo.slice(i, i + CONCURRENCY).map(async (p) => {
          const b = await freeBytesOf(p);
          if ("skipped" in b) {
            geo[p.id] = { skipped: b.skipped };
            skipped++;
            return;
          }
          try {
            geo[p.id] = { m: compact(await measureBytes(b.bytes)) };
            measured++;
          } catch (e) {
            geo[p.id] = { skipped: `the photo could not be measured (${(e as Error).message.slice(0, 80)})` };
            skipped++;
          }
        }),
      );
      await saveProgress(runId, progress);
    }
    await reconcile(jobId, runId, photos, geo, settings.displayConfidenceFloor);
  }

  // 2. The Original, for a cut-off roof or warped walls.
  if (settings.warpCompareOriginal) {
    const r = await compareOriginals(jobId, photos, { autohdrPhotoshootId: job.autohdrPhotoshootId, projectId: job.projectId }, deadline);
    compared = r.compared;
    if (!r.done) {
      await saveProgress(runId, progress);
      return { done: false, measured, compared, skipped };
    }
  }

  progress.geometryDone = true;
  await saveProgress(runId, progress);
  const notMeasured = photos.filter((p) => geo[p.id]?.skipped).length;
  await logJobEvent(jobId, "geometry", `measured line check done: ${photos.length - notMeasured} of ${photos.length} photos measured${notMeasured ? ` (${notMeasured} not: ${[...new Set(photos.map((p) => geo[p.id]?.skipped).filter(Boolean))].slice(0, 2).join("; ")})` : ""}${compared ? `, ${compared} compared with AutoHDR's original` : ""}`);
  await refreshVerdict(jobId, "geometry").catch(() => {});
  return { done: true, measured, compared, skipped };
}

/** Measurement against the free check's lean and warp findings, and advisory findings where only the measurement saw it. */
async function reconcile(jobId: string, runId: string, photos: GPhoto[], geo: Record<string, StoredGeometry>, floor: number): Promise<void> {
  const ids = photos.map((p) => p.id);
  const findings = await prisma.photoQcFinding.findMany({
    where: { jobId, photoId: { in: ids }, ruleId: { in: [...LEAN_RULES, WARP_RULE] }, status: { not: "SUPERSEDED" } },
    select: { id: true, photoId: true, ruleId: true, status: true, source: true, severity: true, confidence: true, explanation: true, coercedJson: true, contentHash: true },
  });
  for (const f of findings) {
    if (f.status !== "OPEN" || f.source !== "AHDR") continue;
    const c = coercedOf(f.coercedJson);
    if (c.measured) continue;
    const g = geo[f.photoId!];
    const v = measuredVerdict(f.ruleId, g);
    const words = g?.m?.words ?? "";
    if (v === "agree") {
      await prisma.photoQcFinding.update({ where: { id: f.id }, data: { confidence: Math.max(f.confidence, AGREE_CONFIDENCE), explanation: `${f.explanation} Measured too: ${words}.`.slice(0, 1000), coercedJson: JSON.stringify({ ...c, measured: "agree" }) } });
    } else if (v === "disagree") {
      await prisma.photoQcFinding.update({ where: { id: f.id }, data: { severity: "MINOR", confidence: Math.min(f.confidence, DISAGREE_CONFIDENCE), explanation: `${f.explanation} The measured lines look straight (${words}), so this counts as minor: look before deciding.`.slice(0, 1000), coercedJson: JSON.stringify({ ...c, measured: "disagree" }) } });
    } else if (f.ruleId === WARP_RULE) {
      // Warped architecture on the check's word alone: minor (Oct 15: full
      // weight only when the measurement agrees). Still shown, and still
      // compared with AutoHDR's original.
      await prisma.photoQcFinding.update({ where: { id: f.id }, data: { severity: "MINOR", confidence: Math.min(f.confidence, 0.6), explanation: `${f.explanation} Not measured (${g?.skipped ?? "too few straight lines in the photo to measure"}), so it counts as minor: look before deciding.`.slice(0, 1000), coercedJson: JSON.stringify({ ...c, measured: "none" }) } });
    } else {
      // Leaning lines keep the check's own weight when they cannot be measured (as before Oct 15).
      await prisma.photoQcFinding.update({ where: { id: f.id }, data: { explanation: `${f.explanation} Not measured: ${g?.skipped ?? "too few straight lines in the photo to measure"}.`.slice(0, 1000), coercedJson: JSON.stringify({ ...c, measured: "none" }) } });
    }
  }
  // Only the measurement saw it: advisory (below the floor, never blocking).
  const advisory = Math.min(ADVISORY_CONFIDENCE, Math.max(0, floor - 0.05));
  for (const p of photos) {
    const m = geo[p.id]?.m;
    if (!m) continue;
    const mine = findings.filter((f) => f.photoId === p.id);
    const add = async (ruleId: string, issue: string) => {
      if (mine.some((f) => (ruleId === WARP_RULE ? f.ruleId === WARP_RULE : LEAN_RULES.includes(f.ruleId)) && (f.source !== "CV" || f.contentHash === p.contentHash))) return;
      await prisma.photoQcFinding.create({
        data: {
          qcRunId: runId, jobId, photoId: p.id, ruleId, groupKey: ruleId === WARP_RULE ? "ARCHITECTURE_WARP" : "VERTICALS", pass: "P1_PHOTO", source: "CV", arbitration: "CONFIRMED",
          specificIssue: issue, explanation: `Only the measured line check saw this (${m.words}); the free photo check did not. Advisory: look at the photo before doing anything.`,
          severity: "MINOR", confidence: advisory, responsibility: "HUMAN_REVIEW", fixStrategy: "HUMAN_REVIEW", contentHash: p.contentHash, model: "line-geometry", rulesVersion: RULES_REGISTRY_VERSION,
          coercedJson: JSON.stringify({ measured: "only" }),
        },
      });
    };
    if (m.warped) await add(WARP_RULE, `Measured: ${m.bent} line${m.bent === 1 ? "" : "s"} look bent`);
    if (m.crooked) await add("PERSP_CROOKED_VERTICALS", `Measured: verticals lean ${m.tilt?.toFixed(1) ?? "?"}°`);
  }
}

const ROOF_PROMPT = [
  "Look at this real estate photo.",
  'Answer ONLY with JSON: {"whole": true or false}.',
  "whole = the entire roof of the main house, its peak or ridge and any chimney, is inside the photo with some sky above its highest point.",
].join("\n");
const WARP_PROMPT = [
  "Look at this real estate photo.",
  'Answer ONLY with JSON: {"bent": true or false}.',
  "bent = walls, wall corners, door frames, windows or cabinets look bent, curved or wedge-shaped. Architecture only: ignore furniture and the normal look of a wide room.",
].join("\n");

/** Pure: what the Original's answer means for a finding. null = the answer could not be read. */
export function originalVerdict(ruleId: string, answer: { whole?: unknown; bent?: unknown } | null): { verdict: "edit" | "capture"; responsibility: "EDITOR" | "PHOTOGRAPHER"; action: string; note: string } | null {
  if (ruleId === ROOF_RULE) {
    if (typeof answer?.whole !== "boolean") return null;
    return answer.whole
      ? { verdict: "edit", responsibility: "EDITOR", note: "AutoHDR's original shows the whole roof: the straightening in editing cut it off.", action: "Open the photo in AutoHDR and turn Perspective Off on this photo (free), then press Check AutoHDR for changes here." }
      : { verdict: "capture", responsibility: "PHOTOGRAPHER", note: "AutoHDR's original is cut off too: the photo was framed that way at the shoot.", action: "No edit brings the roof back. It needs a reshoot from farther back or wider; it goes in the photographer's coaching." };
  }
  if (typeof answer?.bent !== "boolean") return null;
  return answer.bent
    ? { verdict: "capture", responsibility: "PHOTOGRAPHER", note: "AutoHDR's original is bent too: the lens or the camera angle did it, not the editing.", action: "No edit straightens it. Coaching for the photographer: shoot at 20 to 22 mm and keep the camera level." }
    : { verdict: "edit", responsibility: "EDITOR", note: "AutoHDR's original looks straight: the straightening in editing bent it.", action: "Open the photo in AutoHDR and turn Perspective Off on this photo (free), then press Check AutoHDR for changes here." };
}

/** Ask about each open roof or warp finding's Original. Returns done when none is left to ask. */
async function compareOriginals(jobId: string, photos: GPhoto[], jobRef: { autohdrPhotoshootId: number | null; projectId: string }, deadline: number): Promise<{ done: boolean; compared: number }> {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const findings = (await prisma.photoQcFinding.findMany({
    where: { jobId, status: "OPEN", ruleId: { in: ORIGINAL_RULES }, photoId: { in: [...byId.keys()] } },
    select: { id: true, photoId: true, ruleId: true, explanation: true, coercedJson: true, confidence: true },
  })).filter((f) => !coercedOf(f.coercedJson).original);
  if (!findings.length) return { done: true, compared: 0 };
  const { autohdrRefOf } = await import("./versions");
  const originals = new Map<string, string | { skipped: string }>();
  let compared = 0;
  for (let i = 0; i < findings.length; i += CONCURRENCY) {
    if (deadline - Date.now() < 12_000) return { done: false, compared };
    await Promise.all(
      findings.slice(i, i + CONCURRENCY).map(async (f) => {
        const p = byId.get(f.photoId!)!;
        const c = coercedOf(f.coercedJson);
        const skip = async (why: string) => prisma.photoQcFinding.update({ where: { id: f.id }, data: { coercedJson: JSON.stringify({ ...c, original: { verdict: "skipped", note: why } }) } });
        const ref = await autohdrRefOf({ id: p.id, jobId, sourceRef: p.sourceRef, autohdrImageUuid: p.autohdrImageUuid, sourceKind: p.sourceKind }, { job: jobRef }).catch(() => null);
        if (!ref) return void (await skip("not linked to its AutoHDR photo"));
        let original = originals.get(p.id);
        if (original === undefined) {
          try {
            const steps = await autohdr.history(ref.shootId, ref.imageUuid);
            const first = steps.find((s) => !s.parent_image_version_uuid);
            const head = steps.find((s) => s.is_head)?.image_version_uuid ?? p.autohdrVersionUuid;
            original = !first ? { skipped: "AutoHDR has no original for this photo" } : first.image_version_uuid === head ? { skipped: "the photo is still AutoHDR's original" } : first.image_version_uuid;
          } catch (e) {
            original = { skipped: e instanceof AutohdrError && (e.status === 404 || e.expired) ? "AutoHDR no longer has this photo (shoots close after 7 days)" : `AutoHDR's history could not be read (${(e as Error).message.slice(0, 80)})` };
          }
          originals.set(p.id, original);
        }
        if (typeof original !== "string") return void (await skip(original.skipped));
        let answer: { whole?: unknown; bent?: unknown } | null = null;
        try {
          answer = jsonFrom(await describePhoto(ref.shootId, ref.imageUuid, f.ruleId === ROOF_RULE ? ROOF_PROMPT : WARP_PROMPT, original));
        } catch {
          answer = null;
        }
        const v = originalVerdict(f.ruleId, answer);
        if (!v) {
          // Asked again next pass; two answers that cannot be read and it is left as it is.
          const tries = (c.originalTries ?? 0) + 1;
          if (tries >= 2) return void (await skip("AutoHDR's answer about the original could not be read"));
          await prisma.photoQcFinding.update({ where: { id: f.id }, data: { coercedJson: JSON.stringify({ ...c, originalTries: tries }) } });
          return;
        }
        compared++;
        await prisma.photoQcFinding.update({
          where: { id: f.id },
          data: {
            responsibility: v.responsibility,
            recommendedAction: v.action,
            explanation: `${f.explanation} ${v.note}`.slice(0, 1000),
            coercedJson: JSON.stringify({ ...c, original: { verdict: v.verdict, note: v.note }, originalVersion: original }),
          },
        });
      }),
    );
  }
  const left = (await prisma.photoQcFinding.findMany({ where: { jobId, status: "OPEN", ruleId: { in: ORIGINAL_RULES }, photoId: { in: [...byId.keys()] } }, select: { coercedJson: true } })).filter((f) => !coercedOf(f.coercedJson).original);
  if (compared) await logJobEvent(jobId, "geometry", `${compared} cut-off roof or warp finding${compared === 1 ? "" : "s"} compared with AutoHDR's original (free)`);
  return { done: left.length === 0, compared };
}
