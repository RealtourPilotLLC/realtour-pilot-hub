import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { autohdr } from "@/lib/integrations/autohdr";
import { logJobEvent } from "./jobState";

// ---------------------------------------------------------------------------
// EVERY VERSION OF A PHOTO, KEPT, COMPARED AND RESTORABLE (Oct 14 2026).
//
// The huddle's first finding: "You repeatedly said the previous image was not
// showing. Reliable before/after comparison and restoration. The restored
// version must also become the downloaded and delivered file." Why it failed:
//   · AutoHDR's download only ever returns a photo's CURRENT version, and the
//     hub kept no copy of the earlier ones (nothing to show as "before");
//   · the image route ignored which version the page asked for;
//   · nothing re-read the current version after someone changed the photo in
//     AutoHDR's own editor (Perspective Off, Crop & Tilt), so the hub, and the
//     Aryeo folder, kept the old one (finding 3).
// Now:
//   · captureVersion keeps a 2048 px copy of a version in the private store,
//     with its sharpness measured at a fixed resolution (finding 4), the
//     moment the hub sees it: before a fix, after a fix, after a restore, and
//     when AutoHDR shows a newer version than the hub knew;
//   · syncHeads re-reads every photo's current version (one free list call
//     per shoot) and adopts a change made in AutoHDR's editor;
//   · restoreVersion makes an earlier version the current one in AutoHDR
//     (free) and in the hub, so the image, the QC, the download and the
//     06-Ready-for-Aryeo folder all follow it (the folder's fingerprint is the
//     version);
//   · loadVersionTimeline fetches EVERY step AutoHDR has for a photo (the
//     capture, the first edit, the perspective step, each fix) for a
//     side-by-side diagnosis (the Gregory Drive warps): each step is made
//     current for the moment it takes to copy it (re-downloads are free), and
//     the photo's real current version is put back and checked.
// ---------------------------------------------------------------------------

/** The same hash the gallery sync gives an AutoHDR version (jobs.ts autohdrGallery). */
export const hashOfVersion = (versionUuid: string) => createHash("sha256").update(`autohdr:${versionUuid}`).digest("hex").slice(0, 40);

type PhotoRef = { id: string; jobId: string; sourceRef: string | null; autohdrImageUuid: string | null; sourceKind: string };

/** The AutoHDR shoot and image a photo lives in, or null. */
export async function autohdrRefOf(photo: PhotoRef): Promise<{ shootId: number; imageUuid: string } | null> {
  if (photo.sourceKind === "AUTOHDR" && photo.sourceRef?.includes("/")) {
    const [s, u] = photo.sourceRef.split("/");
    const n = Number(s);
    if (Number.isFinite(n) && u) return { shootId: n, imageUuid: u };
  }
  if (!photo.autohdrImageUuid) return null;
  const job = await prisma.photoJob.findUnique({ where: { id: photo.jobId }, select: { autohdrPhotoshootId: true, projectId: true } });
  if (job?.autohdrPhotoshootId) return { shootId: job.autohdrPhotoshootId, imageUuid: photo.autohdrImageUuid };
  // A hub shoot's photo carried over to its Aryeo copy keeps its AutoHDR image, not the shoot: the intake knows it.
  const batch = job ? await prisma.photoIntakeBatch.findFirst({ where: { projectId: job.projectId, photoshootId: { not: null }, photosJson: { contains: photo.autohdrImageUuid } }, select: { photoshootId: true } }) : null;
  return batch?.photoshootId ? { shootId: batch.photoshootId, imageUuid: photo.autohdrImageUuid } : null;
}

/** Sharpness at a fixed resolution: the median Laplacian variance of a 3x3 grid (robust to a different crop). */
export async function sharpnessOf(bytes: Buffer): Promise<{ sharpness: number; width: number; height: number } | null> {
  try {
    const D = await import("./qc/derivatives");
    const { lumaOf, laplacianVariance } = await import("./qc/cv");
    const meta = await D.readMeta(bytes);
    const r = await D.decodeRaster(bytes, meta, 1024);
    const l = lumaOf(r.data, r.width * r.height);
    const cells: number[] = [];
    for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) {
      cells.push(laplacianVariance(l, r.width, r.height, Math.floor((gx * r.width) / 3), Math.floor((gy * r.height) / 3), Math.floor(((gx + 1) * r.width) / 3), Math.floor(((gy + 1) * r.height) / 3)));
    }
    cells.sort((a, b) => a - b);
    return { sharpness: Math.round(cells[4] * 10) / 10, width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

/** A version's stored preview (2048 px) and measurements, from its JSON. */
export function versionMeta(derivJson: string | null): { preview?: { pathname: string; url: string }; file?: { pathname: string; url: string }; sharpness?: number; capturedAt?: string } {
  try {
    return derivJson ? (JSON.parse(derivJson) as ReturnType<typeof versionMeta>) : {};
  } catch {
    return {};
  }
}

let fetcher: ((url: string) => Promise<Buffer>) | null = null;
/** Drills only. */
export function __setVersionFetcherForTests(fn: typeof fetcher) {
  fetcher = fn;
}
async function fetchBytes(url: string): Promise<Buffer> {
  if (fetcher) return fetcher(url);
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`the photo link answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The current version's bytes, downloaded from AutoHDR (free for a photo already bought; refuses otherwise). */
async function headBytes(ref: { shootId: number; imageUuid: string }): Promise<Buffer> {
  const { boughtAutohdrUrl } = await import("./display");
  return fetchBytes(await boughtAutohdrUrl(ref.shootId, ref.imageUuid));
}

/**
 * Keep a copy of one version (the photo's CURRENT version in AutoHDR, or the
 * bytes the caller already has). Idempotent per (photo, version): a version
 * already kept with a preview is returned as is.
 */
export async function captureVersion(photo: PhotoRef, opts: { versionUuid: string; parentVersionUuid?: string | null; label: string; source: string; by: string; bytes?: Buffer | null }): Promise<{ id: string; sharpness: number | null } | null> {
  const existing = await prisma.photoVersion.findFirst({ where: { photoId: photo.id, autohdrVersionUuid: opts.versionUuid }, orderBy: { createdAt: "desc" }, select: { id: true, derivJson: true } });
  const known = versionMeta(existing?.derivJson ?? null);
  if (existing && known.preview) return { id: existing.id, sharpness: known.sharpness ?? null };
  let bytes = opts.bytes ?? null;
  if (!bytes) {
    const ref = await autohdrRefOf(photo);
    if (!ref) return null;
    bytes = await headBytes(ref);
  }
  const D = await import("./qc/derivatives");
  const { putDerivative } = await import("./blob");
  const meta = await D.readMeta(bytes);
  const preview = await D.renderFromSource(bytes, meta, "qc2048");
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40) || "x";
  const stored = await putDerivative(`photo-versions/${safe(photo.jobId)}/${safe(photo.id)}/${safe(opts.versionUuid)}.jpg`, preview.data).catch(() => null);
  const s = await sharpnessOf(bytes);
  const derivJson = JSON.stringify({ ...known, ...(stored ? { preview: stored } : {}), ...(s ? { sharpness: s.sharpness } : {}), capturedAt: new Date().toISOString() });
  if (existing) {
    await prisma.photoVersion.update({ where: { id: existing.id }, data: { derivJson, width: s?.width ?? undefined, height: s?.height ?? undefined, bytes: bytes.byteLength } });
    return { id: existing.id, sharpness: s?.sharpness ?? null };
  }
  const row = await prisma.photoVersion.create({
    data: { photoId: photo.id, label: opts.label.slice(0, 80), source: opts.source, autohdrVersionUuid: opts.versionUuid, parentVersionUuid: opts.parentVersionUuid ?? null, contentHash: photo.sourceKind === "AUTOHDR" ? hashOfVersion(opts.versionUuid) : null, derivJson, width: s?.width ?? null, height: s?.height ?? null, bytes: bytes.byteLength, createdBy: opts.by.slice(0, 120) },
    select: { id: true },
  });
  return { id: row.id, sharpness: s?.sharpness ?? null };
}

/**
 * The photo now IS this AutoHDR version, everywhere in the hub: the image
 * (its cache key), the downloads and the Aryeo folder's fingerprint. A
 * version chosen by a person or by the fix runner (checked after the fix)
 * keeps its findings and its "inspected" mark, the way a photo carried over
 * to the Aryeo listing does (jobs.ts adoptListing), so delivery is not held
 * for a check of a photo the hub just changed on purpose.
 */
export async function adoptVersion(photoId: string, versionUuid: string, sourceKind: string): Promise<void> {
  if (sourceKind !== "AUTOHDR") {
    await prisma.photoAsset.update({ where: { id: photoId }, data: { autohdrVersionUuid: versionUuid } });
    return;
  }
  const row = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { contentHash: true, inspectedHash: true, classifiedHash: true, cvHash: true } });
  const old = row?.contentHash ?? null;
  const next = hashOfVersion(versionUuid);
  if (old === next) {
    await prisma.photoAsset.update({ where: { id: photoId }, data: { autohdrVersionUuid: versionUuid } });
    return;
  }
  await prisma.$transaction([
    prisma.photoAsset.update({
      where: { id: photoId },
      data: {
        autohdrVersionUuid: versionUuid, sourceUrl: null, contentHash: next,
        ...(old && row?.inspectedHash === old ? { inspectedHash: next } : {}),
        ...(old && row?.classifiedHash === old ? { classifiedHash: next } : {}),
      },
    }),
    ...(old ? [prisma.photoQcFinding.updateMany({ where: { photoId, contentHash: old }, data: { contentHash: next } })] : []),
  ]);
}

const labelOf = (step: { label?: string; description?: string } | undefined) => (step?.label || step?.description || "AutoHDR version").slice(0, 80);

/**
 * Re-read every photo's current version from AutoHDR (free) and adopt any
 * change made outside the hub (AutoHDR's editor). Returns what changed.
 */
export async function syncHeads(jobId: string, opts: { by?: string } = {}): Promise<{ changed: { photoId: string; name: string; label: string }[]; error?: string }> {
  const out: { changed: { photoId: string; name: string; label: string }[]; error?: string } = { changed: [] };
  // A photo's history is being copied: its current version is switched for a moment, so not now.
  if (await versionProbeActive(jobId)) return out;
  const photos = await prisma.photoAsset.findMany({ where: { jobId, status: { in: ["ACTIVE", "EXCLUDED"] } }, select: { id: true, jobId: true, name: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, autohdrVersionUuid: true } });
  const byShoot = new Map<number, typeof photos>();
  for (const p of photos) {
    const ref = await autohdrRefOf(p);
    if (!ref) continue;
    (byShoot.get(ref.shootId) ?? byShoot.set(ref.shootId, []).get(ref.shootId)!).push(p);
  }
  for (const [shootId, list] of byShoot) {
    let live: Awaited<ReturnType<typeof autohdr.listPhotos>>;
    try {
      live = await autohdr.listPhotos(shootId);
    } catch (e) {
      out.error = (e as Error).message.slice(0, 160);
      continue;
    }
    const head = new Map(live.map((x) => [x.image_uuid, x.image_version_uuid]));
    for (const p of list) {
      const ref = await autohdrRefOf(p);
      const now = ref ? head.get(ref.imageUuid) : undefined;
      if (!ref || !now || now === p.autohdrVersionUuid) continue;
      // A fix in flight sets the head itself; the runner records it.
      const busy = await prisma.photoFixOperation.count({ where: { photoId: p.id, status: { in: ["SUBMITTING", "SUBMITTED"] } } });
      if (busy) continue;
      const steps = await autohdr.history(shootId, ref.imageUuid).catch(() => []);
      const step = steps.find((x) => x.image_version_uuid === now);
      await adoptVersion(p.id, now, p.sourceKind);
      await captureVersion(p, { versionUuid: now, parentVersionUuid: step?.parent_image_version_uuid ?? p.autohdrVersionUuid, label: labelOf(step), source: "EDITOR", by: opts.by ?? "AutoHDR" }).catch(() => null);
      out.changed.push({ photoId: p.id, name: p.name, label: labelOf(step) });
    }
  }
  if (out.changed.length) await logJobEvent(jobId, opts.by ?? "autohdr-sync", `AutoHDR shows a newer version of ${out.changed.length} photo${out.changed.length === 1 ? "" : "s"} (${out.changed.slice(0, 4).map((c) => `${c.name}: ${c.label}`).join("; ")}); the hub, its downloads and the Aryeo folder now use it`, { changed: out.changed });
  return out;
}

// While a photo's history is being copied its current version in AutoHDR is
// switched for a moment, so nothing else may read or edit it then: the
// Ready-for-Aryeo copy and the fix runner wait while this marker is live.
const PROBE_KEY = (jobId: string) => `photo_version_probe:${jobId}`;
const PROBE_MS = 4 * 60_000;

/** True while a photo of this job is having its history copied. */
export async function versionProbeActive(jobId: string): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: PROBE_KEY(jobId) }, select: { value: true } }).catch(() => null);
  if (!row) return false;
  try {
    return (JSON.parse(row.value) as { until: number }).until > Date.now();
  } catch {
    return false;
  }
}

async function claimProbe(jobId: string, photoId: string): Promise<boolean> {
  const value = JSON.stringify({ photoId, until: Date.now() + PROBE_MS });
  const row = await prisma.appSetting.findUnique({ where: { key: PROBE_KEY(jobId) }, select: { value: true } });
  if (!row) {
    try {
      await prisma.appSetting.create({ data: { key: PROBE_KEY(jobId), value, updatedBy: "versions" } });
      return true;
    } catch {
      return false;
    }
  }
  let live = false;
  try {
    live = (JSON.parse(row.value) as { until: number }).until > Date.now();
  } catch { /* a broken marker is a free one */ }
  if (live) return false;
  const r = await prisma.appSetting.updateMany({ where: { key: PROBE_KEY(jobId), value: row.value }, data: { value, updatedBy: "versions" } });
  return r.count === 1;
}

async function releaseProbe(jobId: string): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: PROBE_KEY(jobId) } }).catch(() => {});
}

/** Make an earlier version the current one, in AutoHDR and in the hub (free). */
export async function restoreVersion(photoId: string, versionId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { id: true, jobId: true, name: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, autohdrVersionUuid: true } });
  const v = await prisma.photoVersion.findUnique({ where: { id: versionId }, select: { id: true, photoId: true, label: true, autohdrVersionUuid: true } });
  if (!photo || !v || v.photoId !== photo.id) return { ok: false, message: "That version is not one of this photo's." };
  if (!v.autohdrVersionUuid) return { ok: false, message: "This version is not in AutoHDR, so it can't be made current from the hub. Replace the photo on the listing by hand." };
  if (v.autohdrVersionUuid === photo.autohdrVersionUuid) return { ok: true, message: "That is already the current version." };
  const ref = await autohdrRefOf(photo);
  if (!ref) return { ok: false, message: "This photo is not linked to its AutoHDR shoot." };
  const busy = await prisma.photoFixOperation.count({ where: { photoId, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
  if (busy) return { ok: false, message: "A fix is running on this photo. Wait for it to finish, then restore." };
  try {
    await autohdr.setVersion(ref.shootId, ref.imageUuid, v.autohdrVersionUuid);
  } catch (e) {
    return { ok: false, message: `AutoHDR would not switch versions: ${(e as Error).message.slice(0, 140)}` };
  }
  // Check it took: the restored version must be what downloads.
  const live = (await autohdr.listPhotos(ref.shootId).catch(() => [])).find((x) => x.image_uuid === ref.imageUuid);
  if (live && live.image_version_uuid !== v.autohdrVersionUuid) return { ok: false, message: "AutoHDR did not make that version current. Nothing was changed in the hub; try again." };
  await adoptVersion(photo.id, v.autohdrVersionUuid, photo.sourceKind);
  if (photo.sourceKind !== "AUTOHDR") {
    // The file on the Aryeo listing (or in Dropbox) is not AutoHDR's: it does
    // not change by itself. The restored version is kept full size, so the
    // Deliver panel lists it under "Replace these on the Aryeo listing" with a
    // Download named after the listing's copy.
    const kept = await keepForListing(photo, ref, v).catch(() => false);
    await logJobEvent(photo.jobId, by, `restored ${photo.name} to "${v.label}" in AutoHDR; the listing's copy still needs replacing by hand`, { photoId, versionId, versionUuid: v.autohdrVersionUuid });
    return {
      ok: true,
      message: kept
        ? `${photo.name} is back to "${v.label}". Download it from "Replace these on the Aryeo listing" in the Deliver panel and swap it in on the listing.`
        : `AutoHDR has "${v.label}" as ${photo.name}'s current version again. Download it from AutoHDR and replace it on the ${photo.sourceKind === "ARYEO" ? "Aryeo listing" : "Dropbox finals folder"}.`,
    };
  }
  await logJobEvent(photo.jobId, by, `restored ${photo.name} to "${v.label}"; the hub, its downloads and the Aryeo folder use it now`, { photoId, versionId, versionUuid: v.autohdrVersionUuid });
  return { ok: true, message: `${photo.name} is back to "${v.label}". The 06-Ready-for-Aryeo folder picks it up on the next pass (or press Get them ready again).` };
}

/** The restored version, full size, as a replacement for the listing's copy (the Deliver panel's download). */
async function keepForListing(photo: PhotoRef & { name: string }, ref: { shootId: number; imageUuid: string }, v: { id: string; label: string; autohdrVersionUuid: string | null }): Promise<boolean> {
  const bytes = await headBytes(ref);
  const { putDerivative } = await import("./blob");
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40) || "x";
  const file = await putDerivative(`photo-fixes/${safe(photo.jobId)}/${safe(photo.id)}/${safe(v.autohdrVersionUuid ?? v.id)}-restored.jpg`, bytes);
  if (!file) return false;
  const was = await prisma.photoVersion.findUnique({ where: { id: v.id }, select: { derivJson: true, width: true, height: true } });
  await prisma.photoVersion.create({
    data: { photoId: photo.id, label: `Restored: ${v.label}`.slice(0, 80), source: "FIX", autohdrVersionUuid: v.autohdrVersionUuid, derivJson: JSON.stringify({ ...versionMeta(was?.derivJson ?? null), file }), width: was?.width ?? null, height: was?.height ?? null, bytes: bytes.byteLength, createdBy: "restore" },
  });
  return true;
}

/**
 * Every step AutoHDR has for a photo, each kept as a preview with its
 * sharpness: for diagnosing a warp or a softening. Each missing step is made
 * current only while it is copied, then the real current version is put back
 * and checked. Free for a bought photo; refuses a photo never downloaded.
 */
export async function loadVersionTimeline(photoId: string, by: string): Promise<{ ok: boolean; message: string; loaded: number }> {
  const photo = await prisma.photoAsset.findUnique({ where: { id: photoId }, select: { id: true, jobId: true, name: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, autohdrVersionUuid: true } });
  if (!photo) return { ok: false, message: "That photo no longer exists.", loaded: 0 };
  const ref = await autohdrRefOf(photo);
  if (!ref) return { ok: false, message: "This photo is not linked to its AutoHDR shoot.", loaded: 0 };
  const busy = await prisma.photoFixOperation.count({ where: { photoId, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
  if (busy) return { ok: false, message: "A fix is running on this photo. Try again when it finishes.", loaded: 0 };
  let steps: Awaited<ReturnType<typeof autohdr.history>>;
  try {
    steps = await autohdr.history(ref.shootId, ref.imageUuid);
  } catch (e) {
    return { ok: false, message: `AutoHDR would not give this photo's history (${(e as Error).message.slice(0, 120)}). Shoots older than 7 days are closed there.`, loaded: 0 };
  }
  const kept0 = new Set((await prisma.photoVersion.findMany({ where: { photoId, autohdrVersionUuid: { not: null } }, select: { autohdrVersionUuid: true, derivJson: true } })).filter((v) => versionMeta(v.derivJson).preview).map((v) => v.autohdrVersionUuid));
  if (steps.every((s) => kept0.has(s.image_version_uuid))) return { ok: true, message: "Every version is already here.", loaded: 0 };
  // Copying a step means making it current for a moment: never while the
  // Aryeo folder is being filled or another photo's history is being read.
  const { readyProgress } = await import("./handoff");
  const ready = await readyProgress(photo.jobId).catch(() => null);
  if (ready?.active) return { ok: false, message: "The photos are being copied to 06-Ready-for-Aryeo right now. Try again when that finishes.", loaded: 0 };
  if (!(await claimProbe(photo.jobId, photoId))) return { ok: false, message: "Another photo's versions are loading on this shoot. Try again in a minute.", loaded: 0 };
  try {
    return await copySteps(photo, ref, steps, by);
  } finally {
    await releaseProbe(photo.jobId);
  }
}

async function copySteps(photo: PhotoRef & { name: string; autohdrVersionUuid: string | null }, ref: { shootId: number; imageUuid: string }, steps: Awaited<ReturnType<typeof autohdr.history>>, by: string): Promise<{ ok: boolean; message: string; loaded: number }> {
  const photoId = photo.id;
  const head = steps.find((s) => s.is_head)?.image_version_uuid ?? photo.autohdrVersionUuid;
  if (!head) return { ok: false, message: "AutoHDR did not say which version is current.", loaded: 0 };
  let loaded = 0;
  const kept = new Set((await prisma.photoVersion.findMany({ where: { photoId, autohdrVersionUuid: { not: null } }, select: { autohdrVersionUuid: true, derivJson: true } })).filter((v) => versionMeta(v.derivJson).preview).map((v) => v.autohdrVersionUuid));
  try {
    // What AutoHDR has as current right now: a download is always of that one,
    // so every step is switched to (and checked) before it is copied, the
    // real current version included once another step was switched to.
    let current = head;
    for (const step of steps) {
      if (kept.has(step.image_version_uuid)) continue;
      if (step.image_version_uuid !== current) {
        await autohdr.setVersion(ref.shootId, ref.imageUuid, step.image_version_uuid);
        const now = (await autohdr.listPhotos(ref.shootId).catch(() => [])).find((x) => x.image_uuid === ref.imageUuid)?.image_version_uuid ?? null;
        current = now ?? current;
        if (now !== step.image_version_uuid) continue; // AutoHDR did not switch: never copy the wrong one under this name
      }
      try {
        await captureVersion(photo, { versionUuid: step.image_version_uuid, parentVersionUuid: step.parent_image_version_uuid, label: labelOf(step), source: step.parent_image_version_uuid ? "HISTORY" : "ORIGINAL_FETCH", by });
        loaded++;
      } catch {
        // One step that will not copy (AutoHDR: "no viewable image") does not stop the rest.
      }
    }
  } finally {
    // The real current version goes back, and is checked.
    await autohdr.setVersion(ref.shootId, ref.imageUuid, head).catch(() => null);
    const live = (await autohdr.listPhotos(ref.shootId).catch(() => [])).find((x) => x.image_uuid === ref.imageUuid);
    if (live && live.image_version_uuid !== head) {
      await logJobEvent(photo.jobId, by, `WARNING: ${photo.name} could not be put back to its current version after loading its history; restore it in the lightbox`, { photoId, head });
      return { ok: false, message: `Loaded ${loaded} step${loaded === 1 ? "" : "s"}, but AutoHDR did not take the current version back. Restore "${head.slice(0, 8)}" in the versions strip.`, loaded };
    }
  }
  if (head !== photo.autohdrVersionUuid) await adoptVersion(photo.id, head, photo.sourceKind);
  return { ok: true, message: loaded ? `Loaded ${loaded} version${loaded === 1 ? "" : "s"} of ${photo.name}: compare them in the versions strip.` : "Every version is already here.", loaded };
}
