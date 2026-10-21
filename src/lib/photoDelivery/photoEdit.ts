import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logJobEvent } from "./jobState";
import type { StoredRef } from "./blob";
import type { DerivMap } from "./qc/derivatives";
import { boxToEdited, boxToSource, cleanParams, editCanSettle, editLabel, isIdentity, leanLineOf, outputSize, renderStraightened, solveLean, type StraightenParams } from "./straighten";

// ---------------------------------------------------------------------------
// THE HUB'S OWN EDIT OF A PHOTO (Oct 21 2026): straighten, keystone, crop.
//
// Jordan: "Kyle needs a quick and easy way to fix image perspective, and
// cropping, etc." AutoHDR has no exact geometry tool in its API, so the
// editor (components/photoDelivery/PhotoEditor) does it in the browser with
// straighten.ts at full resolution and uploads the JPEG straight to the
// hub's PRIVATE store (/api/photo-delivery/edit-upload, a token for one path);
// a device that can't hold the full picture asks the server to render it with
// the same math (renderHubEdit). Either way saveHubEdit makes it the photo's
// current version, through the version model every other part reads:
//   · a PhotoVersion row, source HUB_EDIT, labelled "Straightened 2.3°,
//     keystone 12, cropped 3:2 by Kyle", its contentHash "hub-<sha256>", the
//     full file and a 2048 px copy kept, the settings and what it was made
//     from (so the editor reopens on the same sliders and never edits an edit:
//     every save is rendered from the photo's own file);
//   · the photo's contentHash becomes that hash and its AutoHDR version is
//     cleared, so the image route, the 06-Ready-for-Aryeo fingerprint and the
//     Aryeo push's change check all see a new version; the file itself comes
//     from the store (qc/source.ts loadPhotoBytes, handoff.ts linksFor);
//   · the findings follow it (their boxes moved onto the new picture), and the
//     geometry findings Kyle ticked are marked FIXED, with the line check run
//     again on the saved file (free, local) in the reason;
//   · Restore (versions.ts) goes back to any earlier version, and a hub edit
//     can be restored too; the findings it fixed open again when it goes.
// What it does NOT do: send anything. Before delivery the edit is what the
// folder and the push take; after it (or for a photo that lives on the Aryeo
// listing) Kyle presses Update on Aryeo (aryeoPush.ts requestListingUpdate).
// AutoHDR never sees the edit: an AI re-edit starts from AutoHDR's copy, and
// when AutoHDR's version changes (a fix, a change in its editor) that wins.
// ---------------------------------------------------------------------------

export const HUB_EDIT = "HUB_EDIT";
/** The version an Update on Aryeo put on the listing (the same pixels, now the listing's file). */
export const HUB_EDIT_LISTED = "HUB_EDIT_LISTED";
const HASH_PREFIX = "hub-";
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const FIXED_PREFIX = "Straightened in the hub";

export const isHubEditHash = (h: string | null | undefined): h is string => typeof h === "string" && h.startsWith(HASH_PREFIX);
export const hubHashOf = (bytes: Buffer) => `${HASH_PREFIX}${createHash("sha256").update(bytes).digest("hex").slice(0, 36)}`;

export type HubEditInfo = {
  hash: string;
  params: StraightenParams;
  /** What the edit was made from: the photo's own file before any hub edit. */
  base: { sourceHash: string | null; autohdrVersionUuid: string | null; width: number; height: number };
  measured: { lines: number; tilt: number | null; crooked: boolean; warped: boolean; words: string } | null;
  fixed: string[];
  by: string;
};
export type HubEditMeta = { file?: StoredRef; preview?: StoredRef; sizes?: DerivMap; sharpness?: number; capturedAt?: string; hub?: HubEditInfo };

export function hubMeta(json: string | null | undefined): HubEditMeta {
  try {
    const o = json ? (JSON.parse(json) as HubEditMeta) : {};
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

type PhotoRow = {
  id: string; jobId: string; name: string; status: string; sourceKind: string; sourceUrl: string | null; sourceRef: string | null; dropboxPath: string | null;
  contentHash: string | null; autohdrImageUuid: string | null; autohdrVersionUuid: string | null; width: number | null; height: number | null;
  inspectedHash: string | null; classifiedHash: string | null; derivJson: string | null; derivHash: string | null;
};
const PHOTO_SELECT = {
  id: true, jobId: true, name: true, status: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true, contentHash: true, autohdrImageUuid: true,
  autohdrVersionUuid: true, width: true, height: true, inspectedHash: true, classifiedHash: true, derivJson: true, derivHash: true,
} as const;

/** The hub edit a photo shows now, or null. */
export async function currentHubEdit(photo: { id: string; contentHash: string | null }): Promise<{ id: string; label: string; parentVersionUuid: string | null; meta: HubEditMeta } | null> {
  if (!isHubEditHash(photo.contentHash)) return null;
  const row = await prisma.photoVersion.findFirst({ where: { photoId: photo.id, source: HUB_EDIT, contentHash: photo.contentHash }, orderBy: { createdAt: "desc" }, select: { id: true, label: true, parentVersionUuid: true, derivJson: true } });
  return row ? { id: row.id, label: row.label, parentVersionUuid: row.parentVersionUuid, meta: hubMeta(row.derivJson) } : null;
}

/**
 * The AutoHDR version a photo's current hub edit was made from, also once
 * Update on Aryeo put it on the listing (versions.ts syncHeads: AutoHDR still
 * showing that version is no change). Null: the photo is not a hub edit.
 */
export async function hubEditAutohdrBase(photo: { id: string; contentHash: string | null }): Promise<string | null> {
  if (isHubEditHash(photo.contentHash)) {
    const cur = await currentHubEdit(photo);
    return cur?.meta.hub?.base.autohdrVersionUuid ?? cur?.parentVersionUuid ?? null;
  }
  // On the listing now (Update on Aryeo, or the push carried over in place): the newest hub edit's.
  const last = await prisma.photoVersion.findFirst({ where: { photoId: photo.id, source: { in: [HUB_EDIT, HUB_EDIT_LISTED] } }, orderBy: { createdAt: "desc" }, select: { parentVersionUuid: true } });
  return last?.parentVersionUuid ?? null;
}

/** jobs.ts sync: the listing (or Dropbox) still shows the very file the current hub edit was made from, so the edit stays the photo. */
export async function hubEditStillOn(photo: { id: string; contentHash: string | null }, sourceHash: string): Promise<boolean> {
  const cur = await currentHubEdit(photo);
  return !!cur?.meta.hub && cur.meta.hub.base.sourceHash === sourceHash;
}

/** The full file of a photo's current hub edit, from the private store (null: not a hub edit, or unreadable). */
export async function hubEditBytes(photo: { id: string; contentHash: string | null }): Promise<Buffer | null> {
  const cur = await currentHubEdit(photo);
  if (!cur?.meta.file) return null;
  const { readDerivativeBytes } = await import("./blob");
  return readDerivativeBytes({ pathname: cur.meta.file.pathname, url: "" }, MAX_FILE_BYTES + 1024);
}

/** Where an edit starts: the photo's own file (the hash before any hub edit), the AutoHDR version under it, and the settings in use. */
export async function editBaseOf(photo: { id: string; contentHash: string | null; autohdrVersionUuid: string | null }): Promise<{ sourceHash: string | null; autohdrVersionUuid: string | null; params: StraightenParams | null; hubVersionId: string | null }> {
  const cur = await currentHubEdit(photo);
  if (!cur?.meta.hub) return { sourceHash: isHubEditHash(photo.contentHash) ? null : photo.contentHash, autohdrVersionUuid: photo.autohdrVersionUuid, params: null, hubVersionId: null };
  return { sourceHash: cur.meta.hub.base.sourceHash, autohdrVersionUuid: cur.meta.hub.base.autohdrVersionUuid, params: cur.meta.hub.params, hubVersionId: cur.id };
}

/** The photo's own full-size file (never a hub edit): what every edit is rendered from. */
export async function editBaseBytes(photo: PhotoRow): Promise<Buffer> {
  const { loadPhotoBytes } = await import("./qc/source");
  return loadPhotoBytes({ ...photo, contentHash: null });
}

// ---- Auto --------------------------------------------------------------------------------------

/**
 * The measured lean of the photo's own file, as a turn and a keystone: the
 * line check's lines (qc/cv verticalLineFits), solved by straighten.solveLean.
 * Free: a kept copy, the listing image, a Dropbox file or a bought AutoHDR photo.
 */
export async function measureLean(photoId: string): Promise<{ ok: boolean; message: string; rotate: number; keystone: number; lines: number; words: string | null }> {
  const none = { rotate: 0, keystone: 0, lines: 0, words: null };
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: PHOTO_SELECT });
  if (!photo) return { ok: false, message: "That photo no longer exists.", ...none };
  const base = await editBaseOf(photo);
  const { freeBytesOf } = await import("./geometry");
  const got = await freeBytesOf({ ...photo, contentHash: base.sourceHash, autohdrVersionUuid: base.autohdrVersionUuid });
  if ("skipped" in got) return { ok: false, message: `The photo could not be measured: ${got.skipped}.`, ...none };
  const D = await import("./qc/derivatives");
  const { lumaOf, verticalLineFits, lineGeometry, geometryWords } = await import("./qc/cv");
  const meta = await D.readMeta(got.bytes);
  const r = await D.decodeRaster(got.bytes, meta, 1024);
  const l = lumaOf(r.data, r.width * r.height);
  const fits = verticalLineFits(l, r.width, r.height);
  const solved = solveLean(fits.map((f) => leanLineOf(f, r.height)), r.width);
  const words = geometryWords(lineGeometry(l, r.width, r.height));
  if (solved.used < 3) return { ok: false, message: `Too few straight vertical lines to measure (${solved.used}). Use the sliders and the grid.`, ...none, words };
  return { ok: true, message: `Measured ${solved.used} vertical lines: turn ${solved.rotate.toFixed(1)}°, keystone ${solved.keystone}.`, rotate: solved.rotate, keystone: solved.keystone, lines: solved.used, words };
}

// ---- the server's render (a device that cannot hold the full picture) ------------------------

/** The edit rendered here, with the browser's math, from the photo's own file: a high-quality JPEG. */
export async function renderHubEdit(photoId: string, raw: Partial<StraightenParams>): Promise<{ bytes: Buffer; width: number; height: number; baseWidth: number; baseHeight: number }> {
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: PHOTO_SELECT });
  if (!photo) throw new Error("That photo no longer exists.");
  const p = cleanParams(raw);
  const src = await editBaseBytes(photo);
  return renderBytes(src, p);
}

/** Decode (oriented, sRGB), transform, encode. Exported for the drill. */
export async function renderBytes(src: Buffer, p: StraightenParams): Promise<{ bytes: Buffer; width: number; height: number; baseWidth: number; baseHeight: number }> {
  const D = await import("./qc/derivatives");
  const meta = await D.readMeta(src);
  const r = await D.decodeRaster(src, meta, Math.max(meta.width, meta.height));
  const out = renderStraightened({ data: r.data, width: r.width, height: r.height, channels: 3 }, p);
  const sharp = (await import("sharp")).default;
  const bytes = await sharp(Buffer.from(out.data.buffer, out.data.byteOffset, out.data.byteLength), { raw: { width: out.width, height: out.height, channels: 3 } })
    .jpeg({ quality: 93, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return { bytes, width: out.width, height: out.height, baseWidth: r.width, baseHeight: r.height };
}

// ---- saving -------------------------------------------------------------------------------------

export type SaveResult = { ok: true; message: string; versionId: string; hash: string } | { ok: false; message: string };

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40) || "x";
/** Where a browser upload of an edit must land (the upload route hands out a token for this path only). */
export const editUploadPrefix = (jobId: string, photoId: string) => `photo-edits/${safe(jobId)}/${safe(photoId)}/`;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Make an edited file the photo's current version. `stored` is where the
 * browser uploaded it (its path is checked, its bytes read back); without it
 * the bytes are put in the store here. `baseHash` is the version the editor
 * was opened on: a photo that changed meanwhile is not overwritten.
 */
export async function saveHubEdit(input: { jobId: string; photoId: string; baseHash: string | null; baseSize: { width: number; height: number }; params: Partial<StraightenParams>; by: string; fixFindingIds?: string[]; bytes?: Buffer | null; stored?: { pathname: string } | null }): Promise<SaveResult> {
  const by = (input.by || "staff").slice(0, 120);
  const p = cleanParams(input.params);
  const photo = await prisma.photoAsset.findUnique({ where: { id: input.photoId }, select: PHOTO_SELECT });
  if (!photo || photo.jobId !== input.jobId) return { ok: false, message: "That photo is not on this job. Reload the page." };
  if (photo.status === "GONE") return { ok: false, message: "That photo is no longer in the gallery." };
  if ((photo.contentHash ?? null) !== (input.baseHash ?? null)) return { ok: false, message: "The photo changed while it was open (a fix, a restore or someone else's edit). Close the editor, reopen it and save again." };
  const busy = await prisma.photoFixOperation.count({ where: { photoId: photo.id, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
  if (busy) return { ok: false, message: "An AI fix is running on this photo. Save after it finishes (the fix starts from AutoHDR's copy, so straighten after it)." };
  const base = await editBaseOf(photo);
  if (isIdentity(p)) {
    if (!base.hubVersionId) return { ok: false, message: "Nothing to save: the photo is not turned, keystoned or cropped." };
    // Everything back to zero on an edited photo: that is the photo's own file again.
    const r = await unadoptHubEdit(photo.id, by);
    return r.ok ? { ok: true, message: `${photo.name} is back to its own file (the edit is kept under Versions).`, versionId: base.hubVersionId, hash: photo.contentHash ?? "" } : { ok: false, message: r.message };
  }

  // 1. The file.
  const { putDerivative, readDerivativeBytes, derivativePathname, derivativeStore } = await import("./blob");
  if (!derivativeStore()) return { ok: false, message: "The hub's private photo storage is not set up, so an edited photo can't be kept. Ask Jordan." };
  let bytes = input.bytes ?? null;
  let file: StoredRef | null = null;
  if (input.stored) {
    const pathname = String(input.stored.pathname ?? "");
    if (!pathname.startsWith(editUploadPrefix(photo.jobId, photo.id)) || pathname.includes("..") || !/\.jpe?g$/i.test(pathname)) return { ok: false, message: "That upload is not this photo's. Try saving again." };
    // Read back by path (the store's own address for it), never a URL from the browser.
    bytes = await readDerivativeBytes({ pathname, url: "" }, MAX_FILE_BYTES + 1024);
    if (!bytes) return { ok: false, message: "The uploaded photo could not be read back. Try saving again." };
    file = { pathname, url: "" };
  }
  if (!bytes) return { ok: false, message: "No edited photo came with the save." };
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, message: "The edited photo is larger than 60 MB." };
  const D = await import("./qc/derivatives");
  let meta: Awaited<ReturnType<typeof D.readMeta>>;
  try {
    meta = await D.readMeta(bytes);
  } catch {
    return { ok: false, message: "The edited photo is not a readable image." };
  }
  if (meta.format !== "jpeg" || !meta.width || !meta.height) return { ok: false, message: "The edited photo must be a JPEG." };
  // The file must be what these settings make of a picture this size (a stray or stale upload is refused).
  const baseW = Math.round(Number(input.baseSize?.width) || 0), baseH = Math.round(Number(input.baseSize?.height) || 0);
  if (baseW < 16 || baseH < 16) return { ok: false, message: "The photo's size did not come with the save. Try again." };
  const expect = outputSize(baseW, baseH, p.crop);
  if (Math.abs(expect.width - meta.width) > 2 || Math.abs(expect.height - meta.height) > 2) return { ok: false, message: `The saved file is ${meta.width} × ${meta.height}, not the ${expect.width} × ${expect.height} these settings make. Try again.` };
  const hash = hubHashOf(bytes);
  if (hash === photo.contentHash) return { ok: true, message: "That edit is already the current version.", versionId: base.hubVersionId ?? "", hash };
  if (!file) {
    const put = await putDerivative(`${editUploadPrefix(photo.jobId, photo.id)}${safe(hash)}.jpg`, bytes);
    if (!put) return { ok: false, message: "The hub's private photo storage is not set up, so an edited photo can't be kept. Ask Jordan." };
    file = { pathname: put.pathname, url: put.url };
  }

  // 2. Every size the page shows, kept under the new hash (the image route reads them at once), the sharpness and the line check again.
  const raster = await D.decodeRaster(bytes, meta);
  const sizes: DerivMap = {};
  for (const s of D.UI_SIZES) {
    const r = await D.renderFromRaster(raster, s);
    const ref = await putDerivative(derivativePathname(photo.jobId, photo.id, hash, s), r.data);
    sizes[s] = { w: r.w, h: r.h, bytes: r.data.length, ...(ref ? { pathname: ref.pathname, url: ref.url } : {}) };
  }
  const preview = sizes.qc2048?.pathname ? { pathname: sizes.qc2048.pathname, url: sizes.qc2048.url ?? "" } : undefined;
  const { sharpnessOf } = await import("./versions");
  const sharp = await sharpnessOf(bytes);
  let measured: HubEditInfo["measured"] = null;
  try {
    const { lumaOf, lineGeometry, geometryWords } = await import("./qc/cv");
    const r = await D.decodeRaster(bytes, meta, 1024);
    const g = lineGeometry(lumaOf(r.data, r.width * r.height), r.width, r.height);
    measured = { lines: g.verticalLines, tilt: g.tiltDeg, crooked: g.crooked, warped: g.warped, words: geometryWords(g) };
  } catch {
    measured = null;
  }

  // 3. The findings: ticked geometry ones fixed; every box moved onto the new picture.
  const want = new Set((input.fixFindingIds ?? []).filter((x) => typeof x === "string"));
  const findings = await prisma.photoQcFinding.findMany({ where: { photoId: photo.id, status: { not: "SUPERSEDED" } }, select: { id: true, ruleId: true, status: true, bboxJson: true, contentHash: true } });
  const fixable = findings.filter((f) => want.has(f.id) && f.status === "OPEN" && editCanSettle(f.ruleId));
  const label = editLabel(p, by);
  const reason = `${FIXED_PREFIX} by ${by} (${label.replace(/ by .*$/, "")}).${measured ? ` Measured after: ${measured.words}.` : ""}`.slice(0, 500);
  const prevParams = base.params;
  const boxUpdates: { id: string; bboxJson: string | null }[] = [];
  for (const f of findings) {
    if (!f.bboxJson) continue;
    let box: [number, number, number, number] | null = null;
    try {
      box = JSON.parse(f.bboxJson) as [number, number, number, number];
    } catch {
      continue;
    }
    if (!Array.isArray(box) || box.length !== 4) continue;
    // A box on an earlier hub edit goes back to the photo's own file first.
    if (prevParams) box = boxToSource(box, prevParams, baseW, baseH);
    const moved = box ? boxToEdited(box, p, baseW, baseH) : null;
    boxUpdates.push({ id: f.id, bboxJson: moved ? JSON.stringify(moved) : null });
  }

  const info: HubEditInfo = {
    hash, params: p, by, measured, fixed: fixable.map((f) => f.id),
    base: { sourceHash: base.sourceHash, autohdrVersionUuid: base.autohdrVersionUuid, width: baseW, height: baseH },
  };
  const derivJson: HubEditMeta = { file, ...(preview ? { preview } : {}), sizes, ...(sharp ? { sharpness: sharp.sharpness } : {}), capturedAt: new Date().toISOString(), hub: info };
  const old = photo.contentHash;
  const version = await prisma.$transaction(async (tx) => {
    // Compare-and-swap on the version the editor was opened on.
    const moved = await tx.photoAsset.updateMany({
      where: { id: photo.id, contentHash: old },
      data: {
        contentHash: hash, autohdrVersionUuid: null, width: meta.width, height: meta.height, bytes: bytes!.length, derivJson: JSON.stringify(sizes), derivHash: hash,
        ...(old && photo.inspectedHash === old ? { inspectedHash: hash } : {}),
        ...(old && photo.classifiedHash === old ? { classifiedHash: hash } : {}),
      },
    });
    if (moved.count !== 1) return null;
    const v = await tx.photoVersion.create({
      data: { photoId: photo.id, label, source: HUB_EDIT, parentVersionUuid: base.autohdrVersionUuid, contentHash: hash, derivJson: JSON.stringify(derivJson), width: meta.width, height: meta.height, bytes: bytes!.length, createdBy: by },
      select: { id: true },
    });
    if (old) await tx.photoQcFinding.updateMany({ where: { photoId: photo.id, contentHash: old }, data: { contentHash: hash } });
    for (const b of boxUpdates) await tx.photoQcFinding.update({ where: { id: b.id }, data: { bboxJson: b.bboxJson } });
    if (fixable.length) await tx.photoQcFinding.updateMany({ where: { id: { in: fixable.map((f) => f.id) }, status: "OPEN" }, data: { status: "FIXED", statusReason: reason, decidedBy: by, decidedAt: new Date() } });
    return v;
  });
  if (!version) return { ok: false, message: "The photo changed while it was open. Close the editor, reopen it and save again." };
  // The findings the edit it replaces had fixed and this one did not: open again.
  if (base.hubVersionId) await reopenFixedBy(base.hubVersionId, new Set(fixable.map((f) => f.id)));
  await logJobEvent(photo.jobId, by, `${photo.name}: ${label.replace(/ by .*$/, "").toLowerCase()} in the hub; it is the current version now${fixable.length ? `, ${plural(fixable.length, "geometry issue")} marked fixed` : ""}${measured ? ` (measured after: ${measured.words})` : ""}`, { photoId: photo.id, versionId: version.id, params: p, fixed: info.fixed });
  const { refreshVerdict } = await import("./fixPolicy");
  await refreshVerdict(photo.jobId, by).catch(() => {});
  const job = await prisma.photoJob.findUnique({ where: { id: photo.jobId }, select: { stage: true } });
  const onListing = photo.sourceKind !== "AUTOHDR" || job?.stage === "DELIVERED" || job?.stage === "DELIVERY_MISMATCH";
  return {
    ok: true,
    versionId: version.id,
    hash,
    message: onListing
      ? `Saved: ${label}. The Aryeo listing still has the old one: press Update on Aryeo to replace it.`
      : `Saved: ${label}. It is the current version: the 06-Ready-for-Aryeo folder and the delivery take it.`,
  };
}

/** Findings a hub edit fixed that are still marked so: open again (the edit is no longer the photo). */
async function reopenFixedBy(versionId: string, keep: Set<string> = new Set()): Promise<number> {
  const row = await prisma.photoVersion.findUnique({ where: { id: versionId }, select: { derivJson: true } });
  const ids = (hubMeta(row?.derivJson).hub?.fixed ?? []).filter((id) => !keep.has(id));
  if (!ids.length) return 0;
  const r = await prisma.photoQcFinding.updateMany({ where: { id: { in: ids }, status: "FIXED", statusReason: { startsWith: FIXED_PREFIX } }, data: { status: "OPEN", statusReason: "Open again: the straightened version is no longer the current one.", decidedBy: null, decidedAt: null } });
  return r.count;
}

/** Move a photo's boxes from one picture to another through the hub edits' settings (null params: the photo's own file). */
async function moveBoxes(photoId: string, from: StraightenParams | null, to: StraightenParams | null, W: number, H: number): Promise<void> {
  if (!from && !to) return;
  const findings = await prisma.photoQcFinding.findMany({ where: { photoId, status: { not: "SUPERSEDED" }, bboxJson: { not: null } }, select: { id: true, bboxJson: true } });
  for (const f of findings) {
    let box: [number, number, number, number] | null = null;
    try {
      box = JSON.parse(f.bboxJson!) as [number, number, number, number];
    } catch {
      continue;
    }
    if (from && box) box = boxToSource(box, from, W, H);
    if (to && box) box = boxToEdited(box, to, W, H);
    await prisma.photoQcFinding.update({ where: { id: f.id }, data: { bboxJson: box ? JSON.stringify(box) : null } });
  }
}

/**
 * The photo's own file again (Restore of the version the edit was made from,
 * all sliders back to zero, or AutoHDR's version changing under it). The
 * edit stays under Versions; the findings it fixed open again.
 */
export async function unadoptHubEdit(photoId: string, by: string, opts: { quiet?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: PHOTO_SELECT });
  if (!photo) return { ok: false, message: "That photo no longer exists." };
  const cur = await currentHubEdit(photo);
  if (!cur?.meta.hub) return { ok: true, message: "The photo is already its own file." };
  const h = cur.meta.hub;
  const to = h.base.sourceHash;
  const old = photo.contentHash!;
  const moved = await prisma.photoAsset.updateMany({
    where: { id: photo.id, contentHash: old },
    data: {
      contentHash: to, autohdrVersionUuid: h.base.autohdrVersionUuid, width: h.base.width, height: h.base.height, derivJson: null, derivHash: null,
      ...(photo.inspectedHash === old ? { inspectedHash: to } : {}),
      ...(photo.classifiedHash === old ? { classifiedHash: to } : {}),
    },
  });
  if (moved.count !== 1) return { ok: false, message: "The photo changed a moment ago. Reload the page." };
  await prisma.photoQcFinding.updateMany({ where: { photoId: photo.id, contentHash: old }, data: { contentHash: to } });
  await moveBoxes(photo.id, h.params, null, h.base.width, h.base.height);
  const reopened = await reopenFixedBy(cur.id);
  if (!opts.quiet) await logJobEvent(photo.jobId, by, `${photo.name}: back to its own file (the hub edit "${cur.label}" is kept under Versions)${reopened ? `; ${plural(reopened, "issue")} it had fixed open again` : ""}`, { photoId, versionId: cur.id });
  const { refreshVerdict } = await import("./fixPolicy");
  await refreshVerdict(photo.jobId, by).catch(() => {});
  return { ok: true, message: `${photo.name} is back to its own file.${reopened ? ` ${plural(reopened, "issue")} it had fixed ${reopened === 1 ? "is" : "are"} open again.` : ""}` };
}

/**
 * Restore for a version with no AutoHDR copy (versions.ts restoreVersion):
 * a hub edit (made current again), or the photo's own file under the current
 * hub edit. Null: not one of these, the caller says what it says today.
 */
export async function restoreHubVersion(photoId: string, versionId: string, by: string): Promise<{ ok: boolean; message: string } | null> {
  const [photo, v] = await Promise.all([
    prisma.photoAsset.findUnique({ where: { id: photoId }, select: PHOTO_SELECT }),
    prisma.photoVersion.findUnique({ where: { id: versionId }, select: { id: true, photoId: true, label: true, source: true, contentHash: true, derivJson: true, width: true, height: true } }),
  ]);
  if (!photo || !v || v.photoId !== photo.id) return null;
  const cur = await currentHubEdit(photo);
  if (v.source !== HUB_EDIT) {
    // The photo's own file under the edit (still where it was: the listing, Dropbox).
    if (cur?.meta.hub && v.contentHash && v.contentHash === cur.meta.hub.base.sourceHash) return unadoptHubEdit(photoId, by);
    return null;
  }
  const m = hubMeta(v.derivJson);
  if (!m.hub || !m.file) return { ok: false, message: "This edit's file was not kept, so it can't be made current. Open Straighten and save it again." };
  if (photo.contentHash === m.hub.hash) return { ok: true, message: "That is already the current version." };
  // Only onto the file it was made from: anything else and Straighten makes it again.
  const ownHash = cur?.meta.hub ? cur.meta.hub.base.sourceHash : photo.contentHash;
  if ((ownHash ?? null) !== (m.hub.base.sourceHash ?? null)) {
    return { ok: false, message: "The photo's own file changed since this edit was made (a fix or a new version), so the edit no longer matches it. Open Straighten and make it again." };
  }
  const busy = await prisma.photoFixOperation.count({ where: { photoId, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
  if (busy) return { ok: false, message: "A fix is running on this photo. Wait for it to finish, then restore." };
  const old = photo.contentHash;
  const moved = await prisma.photoAsset.updateMany({
    where: { id: photo.id, contentHash: old },
    data: {
      contentHash: m.hub.hash, autohdrVersionUuid: null, width: v.width ?? undefined, height: v.height ?? undefined, derivJson: m.sizes ? JSON.stringify(m.sizes) : null, derivHash: m.sizes ? m.hub.hash : null,
      ...(old && photo.inspectedHash === old ? { inspectedHash: m.hub.hash } : {}),
      ...(old && photo.classifiedHash === old ? { classifiedHash: m.hub.hash } : {}),
    },
  });
  if (moved.count !== 1) return { ok: false, message: "The photo changed a moment ago. Reload the page." };
  if (old) await prisma.photoQcFinding.updateMany({ where: { photoId, contentHash: old }, data: { contentHash: m.hub.hash } });
  await moveBoxes(photoId, cur?.meta.hub?.params ?? null, m.hub.params, m.hub.base.width, m.hub.base.height);
  if (cur) await reopenFixedBy(cur.id, new Set(m.hub.fixed));
  if (m.hub.fixed.length) await prisma.photoQcFinding.updateMany({ where: { id: { in: m.hub.fixed }, status: "OPEN" }, data: { status: "FIXED", statusReason: `${FIXED_PREFIX} by ${m.hub.by} (restored by ${by}).`.slice(0, 500), decidedBy: by, decidedAt: new Date() } });
  await logJobEvent(photo.jobId, by, `restored ${photo.name} to the hub edit "${v.label}"`, { photoId, versionId });
  const { refreshVerdict } = await import("./fixPolicy");
  await refreshVerdict(photo.jobId, by).catch(() => {});
  return { ok: true, message: `${photo.name} is back to "${v.label}".${photo.sourceKind !== "AUTOHDR" ? " Press Update on Aryeo to put it on the listing." : ""}` };
}

/**
 * After Update on Aryeo replaced the listing's copy (aryeoPush.ts): the photo
 * now IS that listing image, which holds the edit. Carried over in place, the
 * way a photo reaching the listing is (jobs.ts adoptListing): same findings,
 * same checks, a version row that says where it is.
 */
export async function adoptListedEdit(photoId: string, expectHash: string, entry: { sourceRef: string | null; sourceUrl: string | null; contentHash: string }, by: string): Promise<boolean> {
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: PHOTO_SELECT });
  if (!photo || photo.contentHash !== expectHash) return false;
  const cur = await currentHubEdit(photo);
  const next = entry.contentHash;
  const moved = await prisma.photoAsset.updateMany({
    where: { id: photo.id, contentHash: expectHash },
    data: {
      sourceKind: "ARYEO", sourceRef: entry.sourceRef, sourceUrl: entry.sourceUrl, contentHash: next,
      ...(photo.derivHash === expectHash ? { derivHash: next } : {}),
      ...(photo.inspectedHash === expectHash ? { inspectedHash: next } : {}),
      ...(photo.classifiedHash === expectHash ? { classifiedHash: next } : {}),
    },
  });
  if (moved.count !== 1) return false;
  await prisma.photoQcFinding.updateMany({ where: { photoId, contentHash: expectHash }, data: { contentHash: next } });
  const m = cur?.meta ?? {};
  await prisma.photoVersion.create({
    data: { photoId, label: `${(cur?.label ?? "Hub edit").replace(/ by .*$/, "")} (on the Aryeo listing)`.slice(0, 80), source: HUB_EDIT_LISTED, contentHash: next, parentVersionUuid: cur?.meta.hub?.base.autohdrVersionUuid ?? null, derivJson: JSON.stringify({ file: m.file, preview: m.preview, sharpness: m.sharpness, capturedAt: new Date().toISOString(), listedFrom: cur?.id ?? null }), width: photo.width, height: photo.height, createdBy: by.slice(0, 120) },
  });
  return true;
}

// ---- an AI re-edit with Kyle's own words --------------------------------------------------------

/** What one AI re-edit costs (credits, AutoHDR's live price), and whether this job can run one. */
export async function reeditQuote(jobId: string): Promise<{ credits: number | null; blocker: string | null }> {
  const { transformPrice, buildFixCart } = await import("./fixes");
  const [credits, cart] = await Promise.all([transformPrice("reedit"), buildFixCart(jobId).catch(() => null)]);
  const blocker = !cart ? "The fix list could not be read just now." : cart.blockers[0] ?? (credits == null ? "AutoHDR's price list could not be read, so the cost is unknown." : null);
  return { credits, blocker };
}

/**
 * Kyle's own instruction for one photo ("remove the wooden sidewalk
 * forms"): written down as a finding of his, then approved as a one-line fix
 * batch through the usual approval (his credit cap, the shoot's fix budget,
 * the balance). The fix runner sends it to AutoHDR's reedit like any other.
 * `expectCredits` is the price he was shown: a different price is refused.
 */
export async function requestCustomReedit(input: { jobId: string; photoId: string; prompt: string; by: string; role: string; expectCredits: number }): Promise<{ ok: boolean; message: string }> {
  const prompt = String(input.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (prompt.length < 8) return { ok: false, message: "Write what to change (at least a few words)." };
  const photo = await prisma.photoAsset.findUnique({ where: { id: input.photoId }, select: { id: true, jobId: true, name: true, status: true, contentHash: true } });
  if (!photo || photo.jobId !== input.jobId || photo.status === "GONE") return { ok: false, message: "That photo is not on this job. Reload the page." };
  const quote = await reeditQuote(input.jobId);
  if (quote.blocker) return { ok: false, message: quote.blocker };
  if (quote.credits !== input.expectCredits) return { ok: false, message: `AutoHDR's price changed to ${plural(quote.credits ?? 0, "credit")}. Press it again to accept the new price.` };
  const job = await prisma.photoJob.findUnique({ where: { id: input.jobId }, select: { lastQcRunId: true } });
  const by = (input.by || "staff").slice(0, 120);
  const f = await prisma.photoQcFinding.create({
    data: {
      qcRunId: job?.lastQcRunId ?? "manual", jobId: input.jobId, photoId: photo.id, ruleId: "OTHER_DEFECT", groupKey: "STAFF_REEDIT", pass: "P1_PHOTO", source: "STAFF",
      specificIssue: `Re-edit asked by ${by}: ${prompt}`.slice(0, 500), explanation: "Written in the photo's lightbox; sent to AutoHDR as an AI re-edit.", severity: "MINOR", confidence: 1,
      responsibility: "EDITOR", postFixable: true, fixStrategy: "REEDIT_PROMPT", reeditPrompt: prompt, arbitration: "NOT_REQUIRED", contentHash: photo.contentHash, model: "staff",
    },
    select: { id: true },
  });
  const { approveFixBatch } = await import("./fixes");
  const r = await approveFixBatch({ jobId: input.jobId, findingIds: [f.id], mode: "SELECTED", by, role: input.role });
  if (!r.ok) {
    // Nothing was approved or spent: the instruction is not left behind as an open issue.
    await prisma.photoQcFinding.delete({ where: { id: f.id } }).catch(() => {});
    return { ok: false, message: r.message };
  }
  await logJobEvent(input.jobId, by, `asked for an AI re-edit of ${photo.name}: "${prompt}" (${plural(r.estimatedCredits, "credit")})`, { photoId: photo.id, findingId: f.id, batchId: r.batchId });
  const hub = isHubEditHash(photo.contentHash);
  return { ok: true, message: `Sent to AutoHDR as an AI re-edit (${plural(r.estimatedCredits, "credit")}). The new version shows up here when it is back${hub ? "; it starts from AutoHDR's copy, so straighten it again after" : ""}.` };
}
