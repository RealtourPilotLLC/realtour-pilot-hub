import "server-only";

import { prisma } from "@/lib/prisma";
import { photoDeliverySettings } from "./settings";
import { logJobEvent } from "./jobState";
import { AUTOHDR_FREE_FIX, jsonFrom, refreshVerdict } from "./fixPolicy";
import { readProgress, type Progress } from "./autohdrCheck";
import { alignFrame, editBowVerdict, geometryWords, LENS_THRESHOLDS, lensBow, lineGeometry, lumaOf, notLevel, roofHeadroom, type LensBow, type LineGeometry } from "./qc/cv";
import { RULES_REGISTRY_VERSION, ruleById } from "./registry";

// ---------------------------------------------------------------------------
// WARPED OR NOT, MEASURED (Oct 15 2026; the camera's own frame, Oct 29 2026).
//
// Jordan: "the biggest thing I need is making sure images are not warped or
// cluttered." The free check is a text judgement; this adds two free checks
// once it (and its second look) finished on a job:
//
//   1. THE MEASUREMENT (warpCv): every photo's lines (qc/cv.ts): leaning
//      verticals (lineGeometry), and since Oct 29 2026 horizontal lines that
//      should be level (lensBow / notLevel) and the edit's own lens bow.
//      Only from bytes the hub can read for free: a kept version copy, the
//      Aryeo listing image, a Dropbox file, or an AutoHDR photo the hub
//      already bought. A photo that would cost a credit to download is not
//      measured, and says so. Then, per photo:
//        · the check and the measurement agree   → the finding counts in full;
//        · the check says so, the lines measure straight (or level) → MINOR,
//          and says why;
//        · only the measurement says so → an advisory finding below the
//          confidence floor (the Low confidence drawer: never blocks);
//        · Oct 27 2026: only the measurement says so but the verticals lean
//          STRONG_LEAN_DEG or more → a full (MAJOR) finding. Jordan on 913
//          Lakeview, leaning that much from a camera tilted up: "these
//          shouldn't even have been delivered";
//        · Oct 29 2026 (Jordan: "it seems to pick up the vertical lines but not
//          the horizontal lines. Id like it to pick up horizontal lines that
//          are not level"): horizontal lines off level inside a room, measured
//          alone → a MINOR finding that shows (never blocks); with the check
//          too → MAJOR.
//      The old bent-line measure no longer raises warps on its own (Jordan,
//      Oct 29 2026: "it's saying there is warping, but there isn't"): it bent
//      on things that are curved (drone horizons, road lines, a fridge handle).
//   2. THE CAMERA'S OWN FRAME (warpCompareOriginal; cameraFrame.ts): Jordan,
//      Oct 29 2026, "Build a comparison". Replaces asking AutoHDR about its
//      "original", which always answered that it had none. For a cut-off
//      roof, warped walls, and any photo whose edit measures bowed:
//        · roof: where the edit is cut at the top, the camera frame is cut
//          too → framed that way at the shoot: PHOTOGRAPHER, MINOR (coaching;
//          every one Kyle checked by hand was this: "Theyre already cropped in
//          the originals"); the camera frame has sky above it → the edit cut
//          it: EDITOR, Perspective Off in AutoHDR (free);
//        · warp: the edit's lines bow where the camera frame's are straight →
//          the edit bent them (615 Cliff Ln: AutoHDR's lens correction for
//          that camera): full weight, EDITOR. Seen by this comparison alone,
//          inside a room and strong, a MAJOR finding of its own (615 Cliff Ln's
//          four worst; none on 538 Onward Ave or 554 Scattergood Ct; a drone
//          horizon and a painted crosswalk measure bowed, so never outside).
//          The edit bows no more than the camera frame → MINOR: something
//          curved, not a warp.
//      The camera frame is kept and shown beside the edit.
// Both are resumable and bounded; the fix plan waits for them on a v3 check.
// ---------------------------------------------------------------------------

/** The free check's findings the measurement speaks to. */
const LEAN_RULES = ["PERSP_CROOKED_VERTICALS", "PERSP_LEANING_DOOR_FRAMES", "PERSP_EXTERIOR_WALLS_LEANING"];
const WARP_RULE = "PERSP_EDIT_WARP";
const ROOF_RULE = "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED";
/** Oct 29 2026: horizontal lines that should be level. */
const LEVEL_RULE = "PERSP_HORIZONTAL_DISTORTION";
/** Compared against the camera's own frame. */
const CAMERA_RULES = [ROOF_RULE, WARP_RULE];
/** Below the default display floor (0.5): shown in the Low confidence drawer, never blocking. */
export const ADVISORY_CONFIDENCE = 0.45;
/** Oct 27 2026: a measured lean this strong (degrees, median over at least 8 long lines) counts in full on its own. */
export const STRONG_LEAN_DEG = 3;
const STRONG_LEAN_CONFIDENCE = 0.8;
const AGREE_CONFIDENCE = 0.85;
const DISAGREE_CONFIDENCE = 0.55;
/** Seen by a measurement alone, shown (above the default floor) but minor. */
const SHOWN_MINOR_CONFIDENCE = 0.65;
const CONCURRENCY = 2;

/**
 * What is kept per photo in the run's checksJson.geometry. m.k / m.gain: the
 * edit's lens bow; m.hl: long horizontal lines measured, m.lv: their slope
 * when they are off level (null: level). cam: the camera-frame comparison.
 */
export type StoredGeometry = {
  m?: { lines: number; tilt: number | null; bent: number; bow: number; crooked: boolean; warped: boolean; words: string; k?: number; gain?: number; hl?: number; lv?: number | null; lvn?: number };
  skipped?: string;
  cam?: StoredCamera;
};
/** The camera-frame comparison of one photo (Oct 29 2026). */
export type StoredCamera = {
  skipped?: string;
  frame?: string;
  preview?: { pathname: string; url: string } | null;
  fit?: number;
  gap?: number;
  bowed?: boolean;
  strong?: boolean;
  roof?: "capture" | "edit" | "unclear";
};

type GPhoto = { id: string; name: string; jobId: string; sourceKind: string; sourceUrl: string | null; sourceRef: string | null; dropboxPath: string | null; contentHash: string | null; autohdrImageUuid: string | null; autohdrVersionUuid: string | null; roomType?: string | null; isAerial?: boolean };

/** A photo's gray levels, about 1024 px wide (the hub's own decoder). */
async function lumaOfBytes(bytes: Buffer): Promise<{ l: Uint8Array; w: number; h: number }> {
  const D = await import("./qc/derivatives");
  const meta = await D.readMeta(bytes);
  const r = await D.decodeRaster(bytes, meta, 1024);
  return { l: lumaOf(r.data, r.width * r.height), w: r.width, h: r.height };
}

/** Measure a photo's lines from its bytes (about 1024 px wide). */
export async function measureBytes(bytes: Buffer): Promise<LineGeometry> {
  const { l, w, h } = await lumaOfBytes(bytes);
  return lineGeometry(l, w, h);
}

/** Every measurement of one photo: lines, lean, and (Oct 29 2026) lens bow and level. */
export async function measurePhoto(bytes: Buffer): Promise<{ g: LineGeometry; bow: LensBow }> {
  const { l, w, h } = await lumaOfBytes(bytes);
  return { g: lineGeometry(l, w, h), bow: lensBow(l, w, h) };
}

/** A room, not the outside (the free check's room words): level lines are measured alone only here. Pure. */
export function isInterior(p: { roomType?: string | null; isAerial?: boolean }): boolean {
  return !!p.roomType && !p.isAerial && !/EXTERIOR|AERIAL|POOL|PATIO|DECK|YARD|COMMUNITY|DETAIL|OTHER/.test(p.roomType);
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

const compact = (g: LineGeometry, b: LensBow): NonNullable<StoredGeometry["m"]> => {
  const lv = notLevel(b.level);
  return { lines: g.verticalLines, tilt: g.tiltDeg, bent: g.bentLines, bow: g.maxBowPx, crooked: g.crooked, warped: g.warped, words: geometryWords(g), k: b.k, gain: b.gain, hl: b.level.length, lv: lv?.deg ?? null, lvn: lv?.lines ?? 0 };
};

/** The level measurement in plain words. Pure. */
export function levelWords(m: NonNullable<StoredGeometry["m"]>): string {
  return m.lv != null ? `${m.lvn} long horizontal line${m.lvn === 1 ? "" : "s"} slope ${m.lv.toFixed(1)}° the same way` : `${m.hl ?? 0} long horizontal line${m.hl === 1 ? "" : "s"} measured, level`;
}

/** The edit's lines bow enough on their own to be worth comparing with the camera's frame. Pure. */
export const bowsAlone = (m: StoredGeometry["m"]): boolean => !!m && (m.k ?? 0) >= LENS_THRESHOLDS.editMinK && (m.gain ?? 0) >= LENS_THRESHOLDS.editMinGain;

/** Agree, disagree, or cannot tell, for one finding against its photo's measurement (warps: the camera frame, cameraVerdict). Pure. */
export function measuredVerdict(ruleId: string, g: StoredGeometry | undefined): "agree" | "disagree" | "unmeasured" {
  if (!g?.m) return "unmeasured";
  if (LEAN_RULES.includes(ruleId)) return g.m.lines < 8 ? "unmeasured" : g.m.crooked ? "agree" : "disagree";
  if (ruleId === LEVEL_RULE) return g.m.hl == null || g.m.hl < 2 ? "unmeasured" : g.m.lv != null ? "agree" : "disagree";
  return "unmeasured";
}

type Coerced = { measured?: string; camera?: StoredCamera & { verdict?: string; note?: string } } & Record<string, unknown>;
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
    select: { id: true, name: true, jobId: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true, contentHash: true, autohdrImageUuid: true, autohdrVersionUuid: true, roomType: true, isAerial: true },
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
            const r = await measurePhoto(b.bytes);
            geo[p.id] = { m: compact(r.g, r.bow) };
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

  // 2. The camera's own frame, for a cut-off roof, warped walls, and any edit that measures bowed.
  if (settings.warpCompareOriginal) {
    const r = await compareCameraFrames({ jobId, runId, projectId: job.projectId, photos, geo, deadline, floor: settings.displayConfidenceFloor, save: () => saveProgress(runId, progress) });
    compared = r.compared;
    if (!r.done) {
      await saveProgress(runId, progress);
      return { done: false, measured, compared, skipped };
    }
  }

  progress.geometryDone = true;
  await saveProgress(runId, progress);
  const notMeasured = photos.filter((p) => geo[p.id]?.skipped).length;
  await logJobEvent(jobId, "geometry", `measured line check done: ${photos.length - notMeasured} of ${photos.length} photos measured${notMeasured ? ` (${notMeasured} not: ${[...new Set(photos.map((p) => geo[p.id]?.skipped).filter(Boolean))].slice(0, 2).join("; ")})` : ""}${compared ? `, ${compared} compared with the camera's own frame` : ""}`);
  await refreshVerdict(jobId, "geometry").catch(() => {});
  return { done: true, measured, compared, skipped };
}

/** Measurement against the free check's lean and level findings, and findings where only the measurement saw it (warps: compareCameraFrames). */
async function reconcile(jobId: string, runId: string, photos: GPhoto[], geo: Record<string, StoredGeometry>, floor: number): Promise<void> {
  const ids = photos.map((p) => p.id);
  const findings = await prisma.photoQcFinding.findMany({
    where: { jobId, photoId: { in: ids }, ruleId: { in: [...LEAN_RULES, LEVEL_RULE] }, status: { not: "SUPERSEDED" } },
    select: { id: true, photoId: true, ruleId: true, status: true, source: true, severity: true, confidence: true, explanation: true, coercedJson: true, contentHash: true },
  });
  for (const f of findings) {
    if (f.status !== "OPEN" || f.source !== "AHDR") continue;
    const c = coercedOf(f.coercedJson);
    if (c.measured) continue;
    const g = geo[f.photoId!];
    const v = measuredVerdict(f.ruleId, g);
    const level = f.ruleId === LEVEL_RULE;
    const words = g?.m ? (level ? levelWords(g.m) : g.m.words) : "";
    if (v === "agree") {
      // Oct 29 2026: a back wall measured off level is the registry's MAJOR ("the back wall is visibly not level").
      await prisma.photoQcFinding.update({ where: { id: f.id }, data: { ...(level && f.severity === "MINOR" ? { severity: "MAJOR" } : {}), confidence: Math.max(f.confidence, AGREE_CONFIDENCE), explanation: `${f.explanation} Measured too: ${words}.`.slice(0, 1000), coercedJson: JSON.stringify({ ...c, measured: "agree" }) } });
    } else if (v === "disagree") {
      await prisma.photoQcFinding.update({ where: { id: f.id }, data: { severity: "MINOR", confidence: Math.min(f.confidence, DISAGREE_CONFIDENCE), explanation: `${f.explanation} The measured lines look ${level ? "level" : "straight"} (${words}), so this counts as minor: look before deciding.`.slice(0, 1000), coercedJson: JSON.stringify({ ...c, measured: "disagree" }) } });
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
    const add = async (ruleId: string, issue: string, strong = false) => {
      const level = ruleId === LEVEL_RULE;
      if (mine.some((f) => (level ? f.ruleId === LEVEL_RULE : LEAN_RULES.includes(f.ruleId)) && (f.source !== "CV" || f.contentHash === p.contentHash))) return;
      await prisma.photoQcFinding.create({
        data: {
          qcRunId: runId, jobId, photoId: p.id, ruleId, groupKey: level ? "HORIZONTAL_PERSPECTIVE" : "VERTICALS", pass: "P1_PHOTO", source: "CV", arbitration: "CONFIRMED",
          specificIssue: issue,
          explanation: level
            ? `The measured line check saw horizontal lines that should be level sloping (${levelWords(m)}); the free photo check did not name it. Level it in AutoHDR (Crop & Tilt, free) if it shows.`
            : strong
              ? `The measured line check saw a strong lean (${m.words}); the free photo check did not name it. Straighten it in AutoHDR (Crop & Tilt, free) or pick another photo before it goes out.`
              : `Only the measured line check saw this (${m.words}); the free photo check did not. Advisory: look at the photo before doing anything.`,
          // Oct 29 2026: an off-level room is shown (above the floor) but minor; a lean on the measurement alone stays advisory unless strong.
          severity: strong ? "MAJOR" : "MINOR", confidence: strong ? Math.max(STRONG_LEAN_CONFIDENCE, floor) : level ? Math.max(SHOWN_MINOR_CONFIDENCE, floor) : advisory,
          responsibility: level ? "EDITOR" : "HUMAN_REVIEW", fixStrategy: "HUMAN_REVIEW", recommendedAction: level ? AUTOHDR_FREE_FIX[LEVEL_RULE] ?? null : null, contentHash: p.contentHash, model: "line-geometry", rulesVersion: RULES_REGISTRY_VERSION,
          coercedJson: JSON.stringify({ measured: strong ? "only-strong" : "only" }),
        },
      });
    };
    if (m.crooked) await add("PERSP_CROOKED_VERTICALS", `Measured: verticals lean ${m.tilt?.toFixed(1) ?? "?"}°`, (m.tilt ?? 0) >= STRONG_LEAN_DEG);
    // Inside a room only: outside, a sloping street, roof or deck reads as off level.
    if (m.lv != null && isInterior(p)) await add(LEVEL_RULE, `Measured: horizontal lines slope ${m.lv.toFixed(1)}°`);
  }
}

// ---- the camera's own frame (Oct 29 2026) ------------------------------------------------------

/** What the camera frame says about one finding. Pure. */
export function cameraVerdict(ruleId: string, cam: StoredCamera | undefined): { verdict: "edit" | "capture" | "same" | "unclear"; responsibility?: "EDITOR" | "PHOTOGRAPHER"; action?: string; note: string } | null {
  if (!cam) return null;
  const frame = cam.frame ? `the camera's own frame (${cam.frame})` : "the camera's own frame";
  if (cam.skipped) return { verdict: "unclear", note: `Not compared with ${frame}: ${cam.skipped}.${cam.preview ? " It is shown beside the edit: look at the two." : ""}` };
  if (ruleId === ROOF_RULE) {
    if (cam.roof === "capture")
      return { verdict: "capture", responsibility: "PHOTOGRAPHER", note: `Compared with ${frame}: it is cut off at the top too, so it was framed that way at the shoot.`, action: "No edit brings the roof back: the camera's frame is cut off too. Coaching for the photographer: step back or shoot wider so the whole roof has sky above it." };
    if (cam.roof === "edit")
      return { verdict: "edit", responsibility: "EDITOR", note: `Compared with ${frame}: it has sky above the roof, so the edit's straightening or crop cut it off.`, action: AUTOHDR_FREE_FIX[ROOF_RULE] };
    return { verdict: "unclear", note: `Compared with ${frame}: it could not tell whether the roof was cut at the shoot or in the edit. Look at the two side by side.` };
  }
  if (cam.bowed)
    return { verdict: "edit", responsibility: "EDITOR", note: `Measured against ${frame}: the edit's walls and frames bow where the camera's are straight, so the editing bent them.`, action: AUTOHDR_FREE_FIX[WARP_RULE] };
  return { verdict: "same", note: `Measured against ${frame}: the edit's lines bow no more than the camera's own, so the editing did not bend them (something curved, or the normal wide-angle look).` };
}

/** Compare one photo's edit with its camera frame; the frame is kept when it matches. */
async function compareOne(p: GPhoto, jobId: string, projectId: string): Promise<StoredCamera> {
  const { cameraFrameOf, keepCameraFrame } = await import("./cameraFrame");
  const cf = await cameraFrameOf(p, projectId);
  if ("skipped" in cf) return { skipped: cf.skipped };
  const b = await freeBytesOf(p);
  // The edit not readable for free: nothing measured, but the camera frame is kept so the two can be looked at side by side.
  if ("skipped" in b) return { frame: cf.frame.name, preview: await keepCameraFrame(jobId, p.id, cf.frame), skipped: `the edit ${b.skipped}` };
  const edit = await lumaOfBytes(b.bytes);
  const cam = cf.frame.luma;
  const fit = alignFrame(edit, cam);
  if (fit.score < LENS_THRESHOLDS.alignMin) return { frame: cf.frame.name, fit: fit.score, skipped: `its camera frame ${cf.frame.name} does not line up with the edit (it may be another shot)` };
  const eb = lensBow(edit.l, edit.w, edit.h);
  const bow = editBowVerdict(eb, lensBow(cam.l, cam.w, cam.h));
  const roof = roofHeadroom(edit, cam, fit);
  const preview = await keepCameraFrame(jobId, p.id, cf.frame);
  return { frame: cf.frame.name, preview, fit: fit.score, gap: bow.gap, bowed: bow.bowed, strong: bow.strong, roof: roof.verdict };
}

/**
 * The camera's own frame for each open roof or warp finding and each photo
 * whose edit measures bowed, then what it says written into the findings, and
 * a warp finding where only this comparison saw it. Returns done when nothing
 * is left to compare.
 */
async function compareCameraFrames(o: { jobId: string; runId: string; projectId: string; photos: GPhoto[]; geo: Record<string, StoredGeometry>; deadline: number; floor: number; save: () => Promise<void> }): Promise<{ done: boolean; compared: number }> {
  const { jobId, runId, photos, geo } = o;
  const byId = new Map(photos.map((p) => [p.id, p]));
  const findings = await prisma.photoQcFinding.findMany({
    where: { jobId, photoId: { in: [...byId.keys()] }, ruleId: { in: CAMERA_RULES }, status: { not: "SUPERSEDED" } },
    select: { id: true, photoId: true, ruleId: true, status: true, source: true, severity: true, confidence: true, explanation: true, coercedJson: true, contentHash: true },
  });
  const asks = findings.filter((f) => f.status === "OPEN" && f.source !== "CV" && !coercedOf(f.coercedJson).camera);
  const todo = photos.filter((p) => !geo[p.id]?.cam && (asks.some((f) => f.photoId === p.id) || (isInterior(p) && bowsAlone(geo[p.id]?.m))));
  let compared = 0;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    if (o.deadline - Date.now() < 15_000) return { done: false, compared };
    await Promise.all(
      todo.slice(i, i + CONCURRENCY).map(async (p) => {
        const cam = await compareOne(p, jobId, o.projectId).catch((e) => ({ skipped: `the comparison failed (${((e as Error).message ?? "").slice(0, 100)})` }) as StoredCamera);
        geo[p.id] = { ...geo[p.id], cam };
        if (!cam.skipped) compared++;
      }),
    );
    await o.save();
  }
  // What the camera frame says, written into the check's findings.
  for (const f of asks) {
    const cam = geo[f.photoId!]?.cam;
    const v = cameraVerdict(f.ruleId, cam);
    if (!v || !cam) continue;
    const c = coercedOf(f.coercedJson);
    const camera = { ...cam, verdict: v.verdict, note: v.note };
    const warp = f.ruleId === WARP_RULE;
    // A warp counts in full only when the camera frame shows the edit bent it (Oct 15: on the check's word alone, minor).
    const severity = warp ? (v.verdict === "edit" ? (f.severity === "MINOR" ? "MAJOR" : f.severity) : "MINOR") : v.verdict === "capture" ? "MINOR" : f.severity;
    const confidence = warp ? (v.verdict === "edit" ? Math.max(f.confidence, AGREE_CONFIDENCE) : Math.min(f.confidence, v.verdict === "same" ? DISAGREE_CONFIDENCE : 0.6)) : f.confidence;
    const tail = warp && v.verdict !== "edit" ? " It counts as minor: look before deciding." : "";
    await prisma.photoQcFinding.update({
      where: { id: f.id },
      data: {
        severity, confidence,
        ...(v.responsibility ? { responsibility: v.responsibility } : {}),
        ...(v.action ? { recommendedAction: v.action } : {}),
        explanation: `${f.explanation} ${v.note}${tail}`.slice(0, 1000),
        coercedJson: JSON.stringify({ ...c, camera }),
      },
    });
  }
  // Bowed by the edit inside a room, strongly, and the free check did not name it: a finding of its own.
  const rule = ruleById(WARP_RULE);
  for (const p of photos) {
    const cam = geo[p.id]?.cam;
    if (!cam?.strong || !isInterior(p)) continue;
    if (findings.some((f) => f.photoId === p.id && f.ruleId === WARP_RULE && (f.source !== "CV" || f.contentHash === p.contentHash))) continue;
    const v = cameraVerdict(WARP_RULE, cam)!;
    await prisma.photoQcFinding.create({
      data: {
        qcRunId: runId, jobId, photoId: p.id, ruleId: WARP_RULE, groupKey: rule?.groupKey ?? "ARCHITECTURE_WARP", pass: "P1_PHOTO", source: "CV", arbitration: "CONFIRMED",
        specificIssue: "Walls and frames bow in the edit, straight in the camera's frame",
        explanation: `${v.note} The free photo check did not name it.`,
        severity: "MAJOR", confidence: Math.max(STRONG_LEAN_CONFIDENCE, o.floor),
        responsibility: "EDITOR", fixStrategy: "HUMAN_REVIEW", recommendedAction: v.action ?? null, contentHash: p.contentHash, model: "camera-frame", rulesVersion: RULES_REGISTRY_VERSION,
        coercedJson: JSON.stringify({ measured: "camera", camera: { ...cam, verdict: v.verdict, note: v.note } }),
      },
    });
  }
  if (compared) await logJobEvent(jobId, "geometry", `${compared} photo${compared === 1 ? "" : "s"} compared with the camera's own frame (free, from the Dropbox raw folder)`);
  return { done: true, compared };
}
