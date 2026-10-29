import "server-only";

import { prisma } from "@/lib/prisma";
import { DropboxError, dropboxDownload, dropboxThumbnail } from "@/lib/integrations/dropbox";
import { LENS_THRESHOLDS, sameScene } from "./qc/cv";

// ---------------------------------------------------------------------------
// THE CAMERA'S OWN FRAME (Oct 29 2026).
//
// Jordan, Oct 29 2026, on the cut-off roof check: "Build a comparison"; on
// warping: "it's saying there is warping, but there isn't". Kyle had been
// checking by hand ("Checked raws, they're the same", "Theyre already cropped
// in the originals"). The photographer's own frames sit in the job's Dropbox
// 01-RAW-Photos folder (the intake list, PhotoIntakeBatch.filesJson), and
// AutoHDR's upload names one of them for each photo (photosJson `name`): the
// darkest frame of its bracket set (Sony 5-shot: the 4th of 0 - + -- ++;
// A7 V 3-shot: the 1st of - 0 +). So, per photo:
//   1. the named frame, then its neighbours, read as Dropbox previews (1024
//      px, about 100 KB each; free, read-only). A drone frame over 20 MB has
//      no preview: the file itself is read (up to 40 MB);
//   2. a neighbour belongs to this shot when its edges match the named frame
//      (cv.sameScene: a tripod, so the same framing at another exposure);
//   3. of those, the one exposed nearest the middle (mean luma near 115) is
//      the camera frame: what the camera saw, before any editing.
// Kept (putDerivative, private) so the finding shows it beside the edit.
// ---------------------------------------------------------------------------

/** A frame exposed this close to the middle ends the search. */
const GOOD_MEAN = 115;
const GOOD_ENOUGH = 30;
/** A drone file without a Dropbox preview is read whole up to this size. */
const MAX_FULL_BYTES = 40 * 1024 * 1024;

export type CameraFrame = { name: string; path: string; jpeg: Buffer; luma: { l: Uint8Array; w: number; h: number }; mean: number };
type IntakeFile = { name: string; path: string; size?: number };

let frameHook: ((path: string) => Promise<Buffer>) | null = null;
/** Drills only: answer a Dropbox read in-process. */
export function __setCameraFrameReadForTests(fn: typeof frameHook) {
  frameHook = fn;
}

const base = (name: string) => name.replace(/\.[a-z0-9]+$/i, "").toLowerCase();

/** The named frame first, then the neighbours a bracket set can put the middle exposure in. Pure. */
export function candidateIndexes(at: number, count: number): number[] {
  return [at, at + 1, at - 3, at - 1, at - 2, at + 2].filter((i) => i >= 0 && i < count);
}

/** A frame as a 1024 px JPEG: the Dropbox preview, or the file itself when it has none (a drone frame over 20 MB). */
async function frameJpeg(f: IntakeFile): Promise<Buffer> {
  if (frameHook) return frameHook(f.path);
  try {
    return await dropboxThumbnail(f.path);
  } catch (e) {
    if (!(e instanceof DropboxError) || e.status !== 409 || (f.size ?? 0) > MAX_FULL_BYTES) throw e;
  }
  const sharp = (await import("sharp")).default;
  return sharp(await dropboxDownload(f.path), { failOn: "none" }).rotate().resize({ width: 1024, height: 1024, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
}

/** Gray levels of a JPEG at this width. */
export async function lumaOfJpeg(jpeg: Buffer, width: number): Promise<{ l: Uint8Array; w: number; h: number }> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(jpeg, { failOn: "none" }).resize({ width }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { l: new Uint8Array(data.buffer, data.byteOffset, info.width * info.height), w: info.width, h: info.height };
}

/** The intake files of the bracket set AutoHDR named for this photo, or why there are none. */
async function bracketOf(photo: { autohdrImageUuid: string | null }, projectId: string): Promise<{ files: IntakeFile[]; at: number } | { skipped: string }> {
  if (!photo.autohdrImageUuid) return { skipped: "not linked to its AutoHDR upload, so its camera frame is not known" };
  const batches = await prisma.photoIntakeBatch.findMany({ where: { projectId, photosJson: { not: null } }, select: { filesJson: true, photosJson: true } });
  for (const b of batches) {
    let named: string | undefined;
    let files: IntakeFile[] = [];
    try {
      named = (JSON.parse(b.photosJson ?? "[]") as { image_uuid?: string; name?: string }[]).find((x) => x.image_uuid === photo.autohdrImageUuid)?.name;
      if (!named) continue;
      files = (JSON.parse(b.filesJson || "[]") as IntakeFile[]).filter((f) => f?.path && f?.name).sort((a, c) => a.name.localeCompare(c.name));
    } catch {
      continue;
    }
    const at = files.findIndex((f) => base(f.name) === base(named!));
    return at < 0 ? { skipped: `its camera file ${named} is not in the intake list` } : { files, at };
  }
  return { skipped: "its upload to AutoHDR is not in the hub's intake records" };
}

/**
 * The camera's own frame of a photo: the best exposed frame of its bracket
 * set. Read-only (Dropbox previews); nothing is stored here.
 */
export async function cameraFrameOf(photo: { autohdrImageUuid: string | null }, projectId: string): Promise<{ frame: CameraFrame } | { skipped: string }> {
  const set = await bracketOf(photo, projectId);
  if ("skipped" in set) return set;
  let named: { l: Uint8Array; w: number; h: number } | null = null;
  let best: CameraFrame | null = null;
  for (const i of candidateIndexes(set.at, set.files.length)) {
    const f = set.files[i];
    let jpeg: Buffer;
    try {
      jpeg = await frameJpeg(f);
    } catch (e) {
      if (i === set.at) return { skipped: `its camera frame ${f.name} could not be read (${((e as Error).message ?? "").slice(0, 100)})` };
      continue;
    }
    const small = await lumaOfJpeg(jpeg, 256).catch(() => null);
    if (!small) continue;
    if (!named) named = small;
    else if (sameScene(named, small) < LENS_THRESHOLDS.sameScene) continue;
    let sum = 0;
    for (let k = 0; k < small.l.length; k++) sum += small.l[k];
    const mean = Math.round(sum / small.l.length);
    if (!best || Math.abs(mean - GOOD_MEAN) < Math.abs(best.mean - GOOD_MEAN)) best = { name: f.name, path: f.path, jpeg, luma: small, mean };
    if (Math.abs(mean - GOOD_MEAN) <= GOOD_ENOUGH) break;
  }
  if (!best) return { skipped: "its camera frame could not be read" };
  return { frame: { ...best, luma: await lumaOfJpeg(best.jpeg, 1024) } };
}

/** Keep the frame (private store) so the finding can show it; the stored pathname, or null. */
export async function keepCameraFrame(jobId: string, photoId: string, frame: CameraFrame): Promise<{ pathname: string; url: string } | null> {
  const { putDerivative } = await import("./blob");
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return putDerivative(`camera-frames/${safe(jobId)}/${safe(photoId)}/${safe(base(frame.name))}.jpg`, frame.jpeg).catch(() => null);
}
