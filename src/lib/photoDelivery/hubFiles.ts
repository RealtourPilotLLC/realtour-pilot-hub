import "server-only";

import { prisma } from "@/lib/prisma";
import { logJobEvent } from "./jobState";
import type { StoredRef } from "./blob";
import type { DerivMap } from "./qc/derivatives";
import { HUB_EDIT, currentHubEdit, editBaseOf, editUploadPrefix, hubEditBytes, hubHashOf, hubMeta, isHubEditHash, type HubEditInfo, type HubEditKind, type HubEditMeta } from "./photoEdit";
import { cleanDrawing, drawingProblem, lotLinesVersionLabel, renderLotLines, LOT_LINES_LABEL, type LotDrawing } from "./lotLines";
import { cleanParams, type StraightenParams } from "./straighten";

// ---------------------------------------------------------------------------
// FILES THE HUB MAKES OR KYLE BRINGS (Oct 22 2026).
//
// Jordan: "Let's add a lot lines adder tool to the photos section so we can
// add lot lines." Then: "we should be able to download photos, and then
// replace them with an upload, or add photos to the gallery manually."
//
// Every one of these is a HUB VERSION of the photo, through the same model
// the Straighten editor uses (photoEdit.ts), so every reader already takes
// it: the image route, the QC's file reads, 06-Ready-for-Aryeo, the Aryeo
// push, Update on Aryeo, Restore and the versions strip.
//   · a PhotoVersion row, source HUB_EDIT, its contentHash "hub-<sha256>",
//     the full file and every page size kept in the PRIVATE store, and in its
//     derivJson what made it (hub.kind) and what it was made from (hub.base:
//     the photo's own file, so Restore can always go back to it);
//   · the photo's contentHash becomes that hash (a compare-and-swap on the
//     version the tool was opened on, so nothing is overwritten unseen).
// The three ways in:
//   LOT LINES  (saveLotLines) the drawing (lotLines.ts) painted into the
//              full-size picture on the server; label "Lot lines by Kyle";
//              the drawing kept in derivJson.lotLines (image-relative
//              points, style, label) so the tool reopens on it. Drawn on the
//              picture as it is (straightened, an upload), never on an
//              earlier set of lot lines: re-editing draws on the one under.
//   AN UPLOAD  (replaceWithUpload) Kyle's own file (fixed in Lightroom or
//              Photoshop) in the photo's place; label "Replaced by upload by
//              Kyle"; Straighten and lot lines start from it from then on
//              (hub.from), Restore still goes back to the file it replaced.
//   BY HAND    (addPhotosByHand) a new photo in the gallery (sourceKind
//              UPLOAD): ACTIVE, at the end of the delivery order, its file
//              the hub's own; it goes out with Approve and deliver like any
//              other (06-Ready-for-Aryeo reads hub files, the push sends it).
// And DOWNLOAD (downloadPhoto): the current file or the photo's own original,
// from what the hub already has. Never a first, paid AutoHDR download: an
// AutoHDR photo the hub never bought is refused (qc/source.ts, display.ts).
// None of this costs AutoHDR credits, and nothing is sent anywhere: Update
// on Aryeo stays a person's press.
// ---------------------------------------------------------------------------

/** The version an Update on Aryeo, the gallery, the delivery hold read: see lotLines.ts. */
export { LOT_LINES_LABEL };
/** A photo Kyle added to the gallery by hand. */
export const BY_HAND_SOURCE = "UPLOAD";
export const UPLOAD_LABEL = "Replaced by upload";
export const ADDED_LABEL = "Added by hand";

const MAX_FILE_BYTES = 60 * 1024 * 1024;
/** What Kyle may upload (a TIFF from Lightroom can be large; the JPEG it becomes must fit MAX_FILE_BYTES). */
export const MAX_UPLOAD_BYTES = 120 * 1024 * 1024;
export const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/tiff"] as const;
export const UPLOAD_EXT = /\.(jpe?g|png|heic|heif|tiff?)$/i;
const MIN_LONG_EDGE = 600;
const MAX_ADD = 40;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40) || "x";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Where Kyle's uploads land (the photo-upload route hands out a token for this path only): one photo's, or "new" for added ones. */
export const uploadPathPrefix = (jobId: string, target: string) => `photo-uploads/${safe(jobId)}/${safe(target)}/`;

type PhotoRow = {
  id: string; jobId: string; name: string; status: string; sourceKind: string; sourceUrl: string | null; sourceRef: string | null; dropboxPath: string | null;
  contentHash: string | null; autohdrImageUuid: string | null; autohdrVersionUuid: string | null; width: number | null; height: number | null;
  inspectedHash: string | null; classifiedHash: string | null;
};
const PHOTO_SELECT = {
  id: true, jobId: true, name: true, status: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true, contentHash: true, autohdrImageUuid: true,
  autohdrVersionUuid: true, width: true, height: true, inspectedHash: true, classifiedHash: true,
} as const;

export type FileResult = { ok: true; message: string; versionId: string; hash: string } | { ok: false; message: string };

const NO_STORE = "The hub's private photo storage is not set up, so the photo can't be kept. Ask Jordan.";

/** Shared checks before a tool changes a photo: on this job, still in the gallery, not delivered on the listing, not changed meanwhile, no AI fix running. */
async function photoFor(jobId: string, photoId: string, baseHash: string | null): Promise<{ photo: PhotoRow } | { error: string }> {
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: PHOTO_SELECT });
  if (!photo || photo.jobId !== jobId) return { error: "That photo is not on this job. Reload the page." };
  if (photo.status === "GONE") return { error: "That photo is no longer in the gallery." };
  if (photo.status === "ON_LISTING") return { error: "This photo is already delivered on the Aryeo listing, so the hub never changes it." };
  if ((photo.contentHash ?? null) !== (baseHash ?? null)) return { error: "The photo changed while it was open (a fix, a restore or someone else's edit). Close it, reopen it and try again." };
  const busy = await prisma.photoFixOperation.count({ where: { photoId: photo.id, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
  if (busy) return { error: "An AI fix is running on this photo. Try again after it finishes." };
  return { photo };
}

/** Every size the page shows, kept under the new hash (the image route reads them at once). */
async function keepSizes(jobId: string, photoId: string, hash: string, bytes: Buffer): Promise<{ sizes: DerivMap; preview?: StoredRef; width: number; height: number; sharpness: number | null }> {
  const D = await import("./qc/derivatives");
  const { putDerivative, derivativePathname } = await import("./blob");
  const meta = await D.readMeta(bytes);
  const raster = await D.decodeRaster(bytes, meta);
  const sizes: DerivMap = {};
  for (const s of D.UI_SIZES) {
    const r = await D.renderFromRaster(raster, s);
    const ref = await putDerivative(derivativePathname(jobId, photoId, hash, s), r.data);
    sizes[s] = { w: r.w, h: r.h, bytes: r.data.length, ...(ref ? { pathname: ref.pathname, url: ref.url } : {}) };
  }
  const { sharpnessOf } = await import("./versions");
  const sharp = await sharpnessOf(bytes);
  return { sizes, preview: sizes.qc2048?.pathname ? { pathname: sizes.qc2048.pathname, url: sizes.qc2048.url ?? "" } : undefined, width: meta.width, height: meta.height, sharpness: sharp?.sharpness ?? null };
}

/**
 * Make a JPEG the photo's current version (a hub version, photoEdit.ts's
 * model): the file kept, every size kept, a HUB_EDIT row that says what made
 * it, the photo's hash moved with a compare-and-swap, the findings carried
 * (and the "inspected" mark: a person changed it on purpose, as a restore or
 * a straighten does, so delivery is not held for a check of it).
 */
async function adoptHubFile(o: {
  photo: PhotoRow; bytes: Buffer; file?: StoredRef | null; kind: HubEditKind; label: string; by: string; params: StraightenParams; fixed: string[];
  base: HubEditInfo["base"]; from: string | null | "self"; extra?: Record<string, unknown>; event: (name: string) => string; eventData?: Record<string, unknown>;
}): Promise<FileResult> {
  const { photo, bytes, by } = o;
  const { putDerivative, derivativeStore } = await import("./blob");
  if (!derivativeStore()) return { ok: false, message: NO_STORE };
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, message: "The photo is larger than 60 MB as a JPEG." };
  const D = await import("./qc/derivatives");
  let format: string | null = null;
  try {
    format = (await D.readMeta(bytes)).format;
  } catch {
    format = null;
  }
  if (format !== "jpeg") return { ok: false, message: "The new file must be a JPEG." };
  const hash = hubHashOf(bytes);
  if (hash === photo.contentHash) return { ok: true, message: "That file is already the current version.", versionId: "", hash };
  let file = o.file ?? null;
  if (!file) {
    const put = await putDerivative(`${editUploadPrefix(photo.jobId, photo.id)}${safe(hash)}.jpg`, bytes);
    if (!put) return { ok: false, message: NO_STORE };
    file = { pathname: put.pathname, url: put.url };
  }
  const kept = await keepSizes(photo.jobId, photo.id, hash, bytes);
  const info: HubEditInfo = { hash, kind: o.kind, from: o.from === "self" ? hash : o.from, params: o.params, base: o.base, measured: null, fixed: o.fixed, by };
  const derivJson: HubEditMeta & Record<string, unknown> = { file, ...(kept.preview ? { preview: kept.preview } : {}), sizes: kept.sizes, ...(kept.sharpness != null ? { sharpness: kept.sharpness } : {}), capturedAt: new Date().toISOString(), hub: info, ...(o.extra ?? {}) };
  const old = photo.contentHash;
  const version = await prisma.$transaction(async (tx) => {
    const moved = await tx.photoAsset.updateMany({
      where: { id: photo.id, contentHash: old },
      data: {
        contentHash: hash, autohdrVersionUuid: null, width: kept.width, height: kept.height, bytes: bytes.length, format: "jpeg", derivJson: JSON.stringify(kept.sizes), derivHash: hash,
        ...(old && photo.inspectedHash === old ? { inspectedHash: hash } : {}),
        ...(old && photo.classifiedHash === old ? { classifiedHash: hash } : {}),
      },
    });
    if (moved.count !== 1) return null;
    const v = await tx.photoVersion.create({
      data: { photoId: photo.id, label: o.label.slice(0, 80), source: HUB_EDIT, parentVersionUuid: o.base.autohdrVersionUuid, contentHash: hash, derivJson: JSON.stringify(derivJson), width: kept.width, height: kept.height, bytes: bytes.length, createdBy: by.slice(0, 120) },
      select: { id: true },
    });
    if (old) await tx.photoQcFinding.updateMany({ where: { photoId: photo.id, contentHash: old }, data: { contentHash: hash } });
    return v;
  });
  if (!version) return { ok: false, message: "The photo changed a moment ago. Close it, reopen it and try again." };
  await logJobEvent(photo.jobId, by, o.event(photo.name), { photoId: photo.id, versionId: version.id, kind: o.kind, ...(o.eventData ?? {}) });
  const { refreshVerdict } = await import("./fixPolicy");
  await refreshVerdict(photo.jobId, by).catch(() => {});
  const job = await prisma.photoJob.findUnique({ where: { id: photo.jobId }, select: { stage: true } });
  const delivered = job?.stage === "DELIVERED" || job?.stage === "DELIVERY_MISMATCH";
  const onListing = delivered || (photo.sourceKind !== "AUTOHDR" && photo.sourceKind !== BY_HAND_SOURCE);
  return {
    ok: true,
    versionId: version.id,
    hash,
    message: onListing
      ? `Saved: ${o.label}. The Aryeo listing still has the old one: press Update on Aryeo to replace it.`
      : `Saved: ${o.label}. It is the current version: the 06-Ready-for-Aryeo folder and the delivery take it.`,
  };
}

// ---- lot lines ----------------------------------------------------------------------------------

/** What a lot-lines version keeps in its derivJson: the drawing, and the picture it was drawn on. */
export type LotLinesMeta = { drawing: LotDrawing; under: { hash: string | null; versionId: string | null; width: number; height: number } };

export function lotLinesOf(derivJson: string | HubEditMeta | null | undefined): LotLinesMeta | null {
  const m = (typeof derivJson === "string" || derivJson == null ? hubMeta(derivJson as string | null) : derivJson) as HubEditMeta & { lotLines?: LotLinesMeta };
  const l = m.lotLines;
  if (!l || typeof l !== "object" || !l.drawing || !l.under) return null;
  return { drawing: cleanDrawing(l.drawing), under: l.under };
}

/**
 * The picture lot lines go on: the photo as it is now, or, when the current
 * version is itself lot lines, the picture under them (a second save
 * replaces the lines, never draws over the old ones).
 */
async function lotUnder(photo: { id: string; contentHash: string | null }): Promise<{ hash: string | null; versionId: string | null; meta: HubEditMeta | null; current: boolean }> {
  const cur = await currentHubEdit(photo);
  const ll = cur ? lotLinesOf(cur.meta) : null;
  if (cur && ll) {
    const row = ll.under.versionId ? await prisma.photoVersion.findUnique({ where: { id: ll.under.versionId }, select: { photoId: true, derivJson: true } }) : null;
    return { hash: ll.under.hash, versionId: ll.under.versionId, meta: row && row.photoId === photo.id ? hubMeta(row.derivJson) : null, current: false };
  }
  return { hash: photo.contentHash, versionId: cur?.id ?? null, meta: cur?.meta ?? null, current: true };
}

/** The full-size bytes of the picture under the lines (a hub file, or the photo's own file). */
async function underBytes(photo: PhotoRow, hash: string | null): Promise<Buffer> {
  if (isHubEditHash(hash)) {
    const b = await hubEditBytes({ id: photo.id, contentHash: hash });
    if (!b?.length) throw new Error("The hub's copy of this photo could not be read just now. Try again.");
    return b;
  }
  const { loadPhotoBytes } = await import("./qc/source");
  return loadPhotoBytes({ ...photo, contentHash: hash });
}

/** Where the editor's preview of that picture comes from (staff routes only; 2048 px). */
function underPreviewUrl(photoId: string, u: { hash: string | null; versionId: string | null; current: boolean }): string {
  const v = encodeURIComponent(u.hash ?? "");
  if (u.current) return `/api/photo-delivery/img/${photoId}/qc2048?v=${v}`;
  if (u.versionId) return `/api/photo-delivery/img/${photoId}/qc2048?v=${v}&version=${encodeURIComponent(u.versionId)}`;
  return `/api/photo-delivery/edit-source/${photoId}?size=preview&v=${v}`;
}

/** What the Lot lines tool opens on: the picture to draw on, and the last drawing for this photo (to adjust it, or to draw it again after a straighten). */
export async function loadLotLines(photoId: string): Promise<{ ok: boolean; message: string; previewUrl: string | null; drawing: LotDrawing | null; current: boolean; baseHash: string | null }> {
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { id: true, contentHash: true, status: true } });
  if (!photo || photo.status === "GONE") return { ok: false, message: "That photo is no longer in the gallery.", previewUrl: null, drawing: null, current: false, baseHash: null };
  const u = await lotUnder(photo);
  const cur = await currentHubEdit(photo);
  let drawing = cur ? lotLinesOf(cur.meta)?.drawing ?? null : null;
  const current = !!drawing;
  if (!drawing) {
    const last = await prisma.photoVersion.findFirst({ where: { photoId, source: HUB_EDIT, label: { startsWith: LOT_LINES_LABEL } }, orderBy: { createdAt: "desc" }, select: { derivJson: true } });
    drawing = last ? lotLinesOf(last.derivJson)?.drawing ?? null : null;
  }
  return { ok: true, message: "", previewUrl: u.hash ? underPreviewUrl(photo.id, u) : null, drawing, current, baseHash: photo.contentHash };
}

/** The drawing painted into the full-size picture: decoded upright in sRGB, painted, a top-quality JPEG (Straighten's server render, renderBytes). */
export async function renderLotLinesBytes(src: Buffer, drawing: LotDrawing): Promise<{ bytes: Buffer; width: number; height: number }> {
  const D = await import("./qc/derivatives");
  const meta = await D.readMeta(src);
  const r = await D.decodeRaster(src, meta, Math.max(meta.width, meta.height));
  renderLotLines({ data: r.data, width: r.width, height: r.height, channels: 3 }, drawing);
  const sharp = (await import("sharp")).default;
  const bytes = await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } }).jpeg({ quality: 93, chromaSubsampling: "4:4:4" }).toBuffer();
  return { bytes, width: r.width, height: r.height };
}

/** Save the lot lines: painted on the server at full size, the photo's new current version. */
export async function saveLotLines(input: { jobId: string; photoId: string; baseHash: string | null; drawing: unknown; by: string }): Promise<FileResult> {
  const by = (input.by || "staff").slice(0, 120);
  const drawing = cleanDrawing(input.drawing);
  const problem = drawingProblem(drawing);
  if (problem) return { ok: false, message: problem };
  const got = await photoFor(input.jobId, input.photoId, input.baseHash);
  if ("error" in got) return { ok: false, message: got.error };
  const photo = got.photo;
  const u = await lotUnder(photo);
  if (!u.hash) return { ok: false, message: "This photo has no file the hub can read yet." };
  let src: Buffer;
  try {
    src = await underBytes(photo, u.hash);
  } catch (e) {
    const reason = (e as { publicReason?: string }).publicReason ?? (e as Error).message;
    return { ok: false, message: `The full-size photo could not be read: ${reason}` };
  }
  const out = await renderLotLinesBytes(src, drawing);
  // The photo's own file stays what Restore goes back to; the settings of a straighten under the lines stay with them.
  const cur = await currentHubEdit(photo);
  const base: HubEditInfo["base"] = cur?.meta.hub?.base ?? { sourceHash: photo.contentHash, autohdrVersionUuid: photo.autohdrVersionUuid, width: out.width, height: out.height };
  const params = cleanParams(u.meta?.hub?.params ?? {});
  const lot: LotLinesMeta = { drawing, under: { hash: u.hash, versionId: u.versionId, width: out.width, height: out.height } };
  return adoptHubFile({
    photo, bytes: out.bytes, kind: "lotLines", label: lotLinesVersionLabel(by), by, params, fixed: u.meta?.hub?.fixed ?? [], base,
    from: cur?.meta.hub?.from ?? null, extra: { lotLines: lot },
    event: (name) => `lot lines added to ${name}`,
    eventData: { points: drawing.points.length, closed: drawing.closed, label: drawing.label.show ? drawing.label.text : null },
  });
}

// ---- uploads ------------------------------------------------------------------------------------

/**
 * An uploaded file as the JPEG the hub keeps and delivers: a JPEG as it is
 * (no second compression), anything else turned upright into sRGB at top
 * quality. Throws a plain-words Error.
 */
export async function toDeliveryJpeg(raw: Buffer): Promise<{ bytes: Buffer; converted: boolean; width: number; height: number }> {
  const D = await import("./qc/derivatives");
  let meta: Awaited<ReturnType<typeof D.readMeta>>;
  try {
    meta = await D.readMeta(raw);
  } catch {
    throw new Error("That file can't be read as a photo. An iPhone HEIC photo needs to be exported as JPEG first.");
  }
  if (!meta.width || !meta.height) throw new Error("That file can't be read as a photo.");
  if (Math.max(meta.width, meta.height) < MIN_LONG_EDGE) throw new Error(`That photo is only ${meta.width} × ${meta.height}: too small to deliver.`);
  if (meta.format === "jpeg") return { bytes: raw, converted: false, width: meta.width, height: meta.height };
  if (!["png", "tiff", "heif"].includes(meta.format ?? "")) throw new Error("Upload a JPEG, PNG, HEIC or TIFF photo.");
  const sharp = (await import("sharp")).default;
  try {
    let s = sharp(raw, { failOn: "none", limitInputPixels: 268_402_689 }).rotate();
    if (meta.hasAlpha) s = s.flatten({ background: "#ffffff" });
    const bytes = await s.toColourspace("srgb").jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    return { bytes, converted: true, width: meta.width, height: meta.height };
  } catch {
    throw new Error(meta.format === "heif" ? "This HEIC photo can't be read here. Export it as JPEG and upload that." : "That file can't be turned into a JPEG.");
  }
}

/** Kyle's upload, read back from the private store by its path (never a URL from the browser). */
async function readUpload(pathname: string, prefix: string): Promise<{ bytes: Buffer; pathname: string } | { error: string }> {
  const p = String(pathname ?? "");
  if (!p.startsWith(prefix) || p.includes("..") || !UPLOAD_EXT.test(p)) return { error: "That upload is not this photo's. Try again." };
  const { readDerivativeBytes, derivativeStore } = await import("./blob");
  if (!derivativeStore()) return { error: NO_STORE };
  const bytes = await readDerivativeBytes({ pathname: p, url: "" }, MAX_UPLOAD_BYTES + 1024);
  if (!bytes?.length) return { error: "The uploaded file could not be read back (or is over 120 MB). Try again." };
  return { bytes, pathname: p };
}

const shortName = (n: unknown) => String(n ?? "").replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "a file";

/** Replace a photo with Kyle's own file: its new current version; the one before stays under Versions, restorable. */
export async function replaceWithUpload(input: { jobId: string; photoId: string; baseHash: string | null; stored: { pathname: string }; fileName?: string | null; by: string }): Promise<FileResult> {
  const by = (input.by || "staff").slice(0, 120);
  const got = await photoFor(input.jobId, input.photoId, input.baseHash);
  if ("error" in got) return { ok: false, message: got.error };
  const photo = got.photo;
  const up = await readUpload(input.stored?.pathname, uploadPathPrefix(photo.jobId, photo.id));
  if ("error" in up) return { ok: false, message: up.error };
  let jpeg: Awaited<ReturnType<typeof toDeliveryJpeg>>;
  try {
    jpeg = await toDeliveryJpeg(up.bytes);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const cur = await currentHubEdit(photo);
  const base: HubEditInfo["base"] = cur?.meta.hub?.base ?? { sourceHash: photo.contentHash, autohdrVersionUuid: photo.autohdrVersionUuid, width: photo.width ?? jpeg.width, height: photo.height ?? jpeg.height };
  const fileName = shortName(input.fileName);
  return adoptHubFile({
    photo, bytes: jpeg.bytes, file: jpeg.converted ? null : { pathname: up.pathname, url: "" }, kind: "upload", label: `${UPLOAD_LABEL} by ${by}`, by,
    params: cleanParams({}), fixed: cur?.meta.hub?.fixed ?? [], base, from: "self", extra: { upload: { fileName, converted: jpeg.converted } },
    event: (name) => `${name} replaced by an upload (${fileName}); it is the current version now, the one before stays under Versions. Its findings stay as they were: check the new file and decide them`,
    eventData: { fileName },
  });
}

/** A file name for a photo added by hand: the upload's own name, as a JPEG, unique on the job. */
function addedName(fileName: string, taken: Set<string>): string {
  const stem = fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9 _().-]+/g, "").trim().slice(0, 60) || "Added photo";
  let name = `${stem}.jpg`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n}).jpg`;
  taken.add(name.toLowerCase());
  return name;
}

const DELIVERED_STAGES = new Set(["DELIVERING", "DELIVERED", "DELIVERY_MISMATCH"]);

/**
 * New photos in the gallery, by hand (a photo shot later, one edited outside
 * AutoHDR): each an ACTIVE photo at the end of the delivery order, its file
 * the hub's own (a HUB_EDIT version "Added by hand by Kyle"), counted as
 * checked (a person chose it; the free check only reads AutoHDR's photos).
 */
export async function addPhotosByHand(input: { jobId: string; files: { pathname: string; fileName?: string | null }[]; by: string }): Promise<{ ok: boolean; message: string; added: string[] }> {
  const by = (input.by || "staff").slice(0, 120);
  const files = Array.isArray(input.files) ? input.files.slice(0, MAX_ADD + 1) : [];
  if (!files.length) return { ok: false, message: "Choose at least one photo.", added: [] };
  if (files.length > MAX_ADD) return { ok: false, message: `Add at most ${MAX_ADD} photos at a time.`, added: [] };
  const job = await prisma.photoJob.findUnique({ where: { id: input.jobId }, select: { id: true, stage: true, orderJson: true } });
  if (!job) return { ok: false, message: "Photo job not found.", added: [] };
  if (DELIVERED_STAGES.has(job.stage)) return { ok: false, message: "This job is delivered (or being delivered). Add the photo on the Aryeo listing itself: the hub picks it up from there.", added: [] };
  const { derivativeStore, putDerivative } = await import("./blob");
  if (!derivativeStore()) return { ok: false, message: NO_STORE, added: [] };
  const existing = await prisma.photoAsset.findMany({ where: { jobId: job.id }, select: { name: true, sequence: true } });
  const taken = new Set(existing.map((p) => p.name.toLowerCase()));
  let seq = existing.reduce((m, p) => Math.max(m, p.sequence), -1);
  const added: { id: string; name: string }[] = [];
  const refused: string[] = [];
  for (const f of files) {
    const fileName = shortName(f.fileName);
    const up = await readUpload(f.pathname, uploadPathPrefix(job.id, "new"));
    if ("error" in up) {
      refused.push(`${fileName}: ${up.error}`);
      continue;
    }
    let jpeg: Awaited<ReturnType<typeof toDeliveryJpeg>>;
    try {
      jpeg = await toDeliveryJpeg(up.bytes);
    } catch (e) {
      refused.push(`${fileName}: ${(e as Error).message}`);
      continue;
    }
    if (jpeg.bytes.length > MAX_FILE_BYTES) {
      refused.push(`${fileName}: larger than 60 MB as a JPEG`);
      continue;
    }
    const hash = hubHashOf(jpeg.bytes);
    let file: StoredRef = { pathname: up.pathname, url: "" };
    if (jpeg.converted) {
      const put = await putDerivative(`${uploadPathPrefix(job.id, "new")}${safe(hash)}.jpg`, jpeg.bytes);
      if (!put) {
        refused.push(`${fileName}: ${NO_STORE}`);
        continue;
      }
      file = { pathname: put.pathname, url: put.url };
    }
    const name = addedName(fileName, taken);
    seq += 1;
    const info: HubEditInfo = { hash, kind: "added", from: hash, params: cleanParams({}), base: { sourceHash: hash, autohdrVersionUuid: null, width: jpeg.width, height: jpeg.height }, measured: null, fixed: [], by };
    const meta: HubEditMeta & Record<string, unknown> = { file, capturedAt: new Date().toISOString(), hub: info, upload: { fileName, converted: jpeg.converted } };
    const row = await prisma.$transaction(async (tx) => {
      const p = await tx.photoAsset.create({
        data: { jobId: job.id, name, sourceKind: BY_HAND_SOURCE, contentHash: hash, inspectedHash: hash, width: jpeg.width, height: jpeg.height, bytes: jpeg.bytes.length, format: "jpeg", sequence: seq, status: "ACTIVE" },
        select: { id: true },
      });
      const v = await tx.photoVersion.create({ data: { photoId: p.id, label: `${ADDED_LABEL} by ${by}`.slice(0, 80), source: HUB_EDIT, contentHash: hash, derivJson: JSON.stringify(meta), width: jpeg.width, height: jpeg.height, bytes: jpeg.bytes.length, createdBy: by }, select: { id: true } });
      return { id: p.id, versionId: v.id };
    }).catch((e: unknown) => ((e as { code?: string }).code === "P2002" ? null : Promise.reject(e)));
    if (!row) {
      refused.push(`${fileName}: a photo with that name was added a moment ago`);
      continue;
    }
    // Every page size kept under its hash; if this fails the image route renders them from the file.
    try {
      const kept = await keepSizes(job.id, row.id, hash, jpeg.bytes);
      await prisma.photoAsset.update({ where: { id: row.id }, data: { derivJson: JSON.stringify(kept.sizes), derivHash: hash } });
      await prisma.photoVersion.update({ where: { id: row.versionId }, data: { derivJson: JSON.stringify({ ...meta, sizes: kept.sizes, ...(kept.preview ? { preview: kept.preview } : {}), ...(kept.sharpness != null ? { sharpness: kept.sharpness } : {}) }) } });
    } catch (e) {
      console.warn("photo delivery: sizes of an added photo not kept", row.id, (e as Error).message);
    }
    added.push({ id: row.id, name });
  }
  if (added.length) {
    // At the end of a saved delivery order (without one, the suggested order places it; either way it can be moved).
    const saved = (() => {
      try {
        return job.orderJson ? (JSON.parse(job.orderJson) as string[]) : null;
      } catch {
        return null;
      }
    })();
    if (Array.isArray(saved) && saved.length) await prisma.photoJob.update({ where: { id: job.id }, data: { orderJson: JSON.stringify([...saved, ...added.map((a) => a.id)]) } });
    await logJobEvent(job.id, by, `${plural(added.length, "photo")} added to the gallery by hand (${added.map((a) => a.name).slice(0, 6).join(", ")}${added.length > 6 ? "…" : ""}): in the delivery, at the end of the order`, { photoIds: added.map((a) => a.id) });
    const { refreshVerdict } = await import("./fixPolicy");
    await refreshVerdict(job.id, by).catch(() => {});
  }
  const note = refused.length ? ` Not added: ${refused.slice(0, 3).join("; ")}${refused.length > 3 ? "…" : ""}.` : "";
  return {
    ok: added.length > 0,
    message: added.length ? `${plural(added.length, "photo")} added to the gallery, at the end of the delivery order.${note}` : `Nothing was added.${note}`,
    added: added.map((a) => a.id),
  };
}

// ---- downloads ----------------------------------------------------------------------------------

export type DownloadResult = { ok: true; bytes: Buffer; fileName: string; contentType: string } | { ok: false; status: number; message: string };

/**
 * A photo's full-size file for a person to save: "current" (what gets
 * delivered) or "original" (the photo's own file, before the hub's edits,
 * lot lines or an upload). Only what the hub already has: the listing image,
 * the Dropbox file, the hub's own copy, or a free re-download of an AutoHDR
 * photo already bought. One never bought is refused, never bought.
 */
export async function downloadPhoto(photoId: string, which: "current" | "original"): Promise<DownloadResult> {
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { ...PHOTO_SELECT, format: true } });
  if (!photo || photo.status === "GONE") return { ok: false, status: 404, message: "That photo is no longer in the gallery." };
  const { loadPhotoBytes, PhotoSourceError } = await import("./qc/source");
  let hash = photo.contentHash;
  if (which === "original" && isHubEditHash(photo.contentHash)) {
    const base = await editBaseOf(photo);
    hash = base.sourceHash;
  }
  // An AutoHDR photo the hub never bought: refused before AutoHDR is asked anything.
  if (photo.sourceKind === "AUTOHDR" && !isHubEditHash(hash) && !(await boughtFromAutohdr(photo))) {
    return { ok: false, status: 409, message: "This photo has not been bought from AutoHDR yet, so the hub has no full-size copy. Downloading it now would cost a credit, so nothing was downloaded." };
  }
  let bytes: Buffer;
  try {
    bytes = isHubEditHash(hash) ? ((await hubEditBytes({ id: photo.id, contentHash: hash })) ?? Buffer.alloc(0)) : await loadPhotoBytes({ ...photo, contentHash: hash });
    if (!bytes.length) throw new PhotoSourceError("hub file unreadable", "transient", "the hub's copy could not be read just now");
  } catch (e) {
    const reason = e instanceof PhotoSourceError ? e.publicReason : "the file could not be read just now";
    return { ok: false, status: e instanceof PhotoSourceError && e.kind === "gone" ? 404 : 503, message: `This photo can't be downloaded: ${reason}.` };
  }
  const D = await import("./qc/derivatives");
  const fmt = (await D.readMeta(bytes).catch(() => null))?.format ?? "jpeg";
  const ext = fmt === "jpeg" ? "jpg" : fmt === "heif" ? "heic" : fmt;
  const stem = photo.name.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9 _().-]+/g, "").trim().slice(0, 80) || "photo";
  return { ok: true, bytes, fileName: `${stem}${which === "original" && hash !== photo.contentHash ? "-original" : ""}.${ext}`, contentType: fmt === "jpeg" ? "image/jpeg" : `image/${fmt}` };
}

/** Did the hub already download (buy) this AutoHDR photo? Read from the intake record; AutoHDR is not asked. */
async function boughtFromAutohdr(photo: { sourceRef: string | null; sourceUrl: string | null }): Promise<boolean> {
  const [shoot, uuid] = (photo.sourceRef ?? "").split("/");
  const shootId = Number(shoot);
  if (!Number.isFinite(shootId) || !uuid) return false;
  const batch = await prisma.photoIntakeBatch.findFirst({ where: { photoshootId: shootId }, select: { photosJson: true } });
  try {
    const list = JSON.parse(batch?.photosJson ?? "[]") as { image_uuid?: string; downloaded?: boolean }[];
    return Array.isArray(list) && list.some((e) => e.image_uuid === uuid && e.downloaded === true);
  } catch {
    return false;
  }
}
