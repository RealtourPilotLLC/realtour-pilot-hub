import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { actualFolderPaths } from "@/lib/dropboxFolders";
import { dbx, DropboxError } from "@/lib/integrations/dropbox";
import { Aryeo } from "@/lib/integrations/aryeo";
import { photoDeliverySettings } from "./settings";
import { logJobEvent, setStage, type JobStage } from "./jobState";

// ---------------------------------------------------------------------------
// THE JOB SYNC (docs/photo-delivery/01 §6.1–6.3, adapted to how the business
// actually runs, Oct 13 2026).
//
// What the live data says (read-only audit, Oct 13): photographers upload
// raws to the job's 01-RAW-Photos through the hub, and the EDITED photos then
// appear on the job's Aryeo listing ("<Street> (N of M).jpg" on cdn.aryeo.com)
// before Kyle delivers it. AutoHDR's Dropbox watcher has not written a single
// final into 04-Final-Photos for the 41 batches the hub tracked. So the
// gallery the hub inspects is the ARYEO LISTING, read before delivery; the
// Dropbox finals folder is still read as a second source, in case AutoHDR is
// pointed back at it. This sync sends nothing to AutoHDR (an API-created shoot
// for photos already edited would charge twice). It:
//   1. opens a PhotoJob for every photo job shot since the feature started
//      (never a backfill of old, delivered work),
//   2. reads the listing's images (and the finals folder) and keeps one
//      PhotoAsset per image, a PhotoVersion per change,
//   3. moves EDITING → EDITED once the gallery stops changing (images arrive
//      over several minutes; a gallery has "landed" after FINALS_SETTLE_MS
//      without a change),
//   4. asks for a re-QC when the gallery changes after QC (a replaced photo),
//   5. follows the delivery the hub already detects (Project.deliveredAt, the
//      listing's delivery_status) and then verifies it against the QC'd set.
// Read-only toward Aryeo, Dropbox and AutoHDR. Every write is a hub row.
// ---------------------------------------------------------------------------

const MIN = 60_000;
// Oct 14 2026: 20 minutes proved too slow (a gallery was delivered 15 minutes
// after it reached Aryeo). QC is resumable per photo and re-runs on a gallery
// change, so starting on a still-growing gallery costs little.
const FINALS_SETTLE_MS = 6 * MIN;
const IMAGE_RE = /\.(jpe?g|png|tiff?|heic|webp)$/i;
/** Jobs shot before this are history, not queue. */
export const PHOTO_DELIVERY_EPOCH = new Date("2026-10-13T04:00:00Z");

export type FinalEntry = { name: string; path: string; id: string | null; contentHash: string | null; size: number | null; serverModified: string | null };

/** One edited photo wherever it was found: the Aryeo listing or the Dropbox finals folder. */
export type GalleryEntry = {
  name: string;
  sourceKind: "ARYEO" | "DROPBOX";
  sourceUrl: string | null;
  sourceRef: string | null;
  dropboxPath: string | null;
  dropboxId: string | null;
  contentHash: string;
  bytes: number | null;
  index: number;
};

/** List a finals folder with hashes and sizes. null = the read failed (unknown is not zero). */
export async function listFinals(folder: string): Promise<FinalEntry[] | null> {
  type Entry = { ".tag": string; name: string; path_display?: string; id?: string; content_hash?: string; size?: number; server_modified?: string };
  type Page = { entries: Entry[]; has_more?: boolean; cursor?: string };
  try {
    let res = await dbx<Page>("files/list_folder", { path: folder, recursive: false, include_non_downloadable_files: false });
    const all = [...(res.entries ?? [])];
    let guard = 0;
    while (res.has_more && res.cursor && guard++ < 40) {
      res = await dbx<Page>("files/list_folder/continue", { cursor: res.cursor });
      all.push(...(res.entries ?? []));
    }
    return all
      .filter((e) => e[".tag"] === "file" && IMAGE_RE.test(e.name) && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: e.path_display ?? `${folder}/${e.name}`, id: e.id ?? null, contentHash: e.content_hash ?? null, size: typeof e.size === "number" ? e.size : null, serverModified: e.server_modified ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  } catch (e) {
    if (e instanceof DropboxError && /not_found/i.test(e.message)) return [];
    console.warn("photo delivery: finals read failed", folder, (e as Error).message);
    return null;
  }
}

export function finalsFingerprint(entries: FinalEntry[]): string {
  const h = createHash("sha256");
  for (const e of entries) h.update(`${e.name}\u0000${e.contentHash ?? e.size ?? ""}\n`);
  return h.digest("hex").slice(0, 32);
}

type ExpectedDeliverables = {
  minPhotos?: number;
  maxPhotos?: number;
  droneCount?: number;
  twilightReal?: number;
  twilightVirtual?: number;
  virtualStagingCount?: number;
  floorPlan?: boolean;
  sqft?: number;
  propertyType?: string;
  address?: string;
  city?: string;
  state?: string;
  requestedFeatures: string[];
  specialInstructions?: string;
  source: Record<string, string>;
};

/** What was ordered, from the job's live order lines and deliverables. */
export async function expectedFor(projectId: string): Promise<ExpectedDeliverables> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      title: true, addressLine: true, city: true, state: true, squareFeet: true, photoTarget: true, removalNotes: true, shotOrderNotes: true, editSpec: true, notes: true,
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, quantity: true, productTitle: true, label: true } },
    },
  });
  const out: ExpectedDeliverables = { requestedFeatures: [], source: {} };
  if (!p) return out;
  out.address = p.addressLine ?? p.title.split(",")[0];
  if (p.city) out.city = p.city;
  if (p.state) out.state = p.state;
  if (p.squareFeet) {
    out.sqft = p.squareFeet;
    out.source.sqft = "order size band";
  }
  if (p.photoTarget) {
    out.maxPhotos = p.photoTarget;
    out.source.maxPhotos = "culling target (project)";
  }
  for (const d of p.deliverables) {
    const title = `${d.productTitle ?? ""} ${d.label ?? ""}`.toLowerCase();
    const q = Math.max(1, d.quantity ?? 1);
    if (d.type === "DRONE") {
      out.droneCount = (out.droneCount ?? 0) + (/\b(\d+)\s*(photos|images)\b/.exec(title) ? Number(/\b(\d+)\s*(photos|images)\b/.exec(title)![1]) : q);
      out.source.droneCount = `deliverable: ${d.productTitle ?? "drone"}`;
    } else if (d.type === "TWILIGHT") {
      if (/virtual/.test(title)) {
        out.twilightVirtual = (out.twilightVirtual ?? 0) + q;
        out.source.twilightVirtual = `deliverable: ${d.productTitle ?? "virtual twilight"}`;
      } else {
        out.twilightReal = (out.twilightReal ?? 0) + q;
        out.source.twilightReal = `deliverable: ${d.productTitle ?? "twilight"}`;
      }
    } else if (d.type === "VIRTUAL_STAGING") {
      out.virtualStagingCount = (out.virtualStagingCount ?? 0) + q;
      out.source.virtualStagingCount = `deliverable: ${d.productTitle ?? "virtual staging"}`;
    } else if (d.type === "FLOORPLAN") {
      out.floorPlan = true;
      out.source.floorPlan = `deliverable: ${d.productTitle ?? "floor plan"}`;
    } else if (d.type === "PHOTOS") {
      const n = /\b(\d{2,3})\s*(photos|images|pics)\b/.exec(title);
      if (n) {
        out.minPhotos = Number(n[1]);
        out.source.minPhotos = `deliverable: ${d.productTitle}`;
      }
    }
  }
  const notes = [p.removalNotes && `Remove: ${p.removalNotes}`, p.shotOrderNotes && `Shot order: ${p.shotOrderNotes}`, p.editSpec && `Edit spec: ${p.editSpec}`].filter(Boolean).join(" | ");
  if (notes) {
    out.specialInstructions = notes.slice(0, 2000);
    out.source.specialInstructions = "photographer upload notes";
  }
  return out;
}

const OPEN_STAGES: JobStage[] = ["EDITING", "EDITED", "QC_RUNNING", "QC_REVIEW", "FIXING", "ON_HOLD", "READY", "DELIVERING", "DELIVERY_MISMATCH", "REVISION_REQUESTED", "EDIT_FAILED"];
const PHOTO_TYPES = ["PHOTOS", "DRONE", "TWILIGHT"] as const;

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);

/** The Aryeo listing's gallery images, in Aryeo's order. null = the read failed. */
export async function listingGallery(listingId: string): Promise<{ entries: GalleryEntry[]; deliveryStatus: string | null } | null> {
  try {
    const l = await Aryeo.listing(listingId);
    const images = (l.images ?? []).filter((i) => i.display_in_gallery !== false && (i.original_url || i.large_url));
    const entries = images
      .map((i, n) => {
        const url = i.original_url ?? i.large_url ?? "";
        // Aryeo image objects carry no hash or timestamp: the id plus the
        // original URL changes whenever a photo is replaced.
        return {
          name: (i.filename || `Photo ${n + 1}.jpg`).slice(0, 200),
          sourceKind: "ARYEO" as const,
          sourceUrl: url,
          sourceRef: i.id ?? null,
          dropboxPath: null,
          dropboxId: null,
          contentHash: hashOf(`aryeo:${i.id ?? ""}:${url}`),
          bytes: null,
          index: typeof i.index === "number" ? i.index : n,
        };
      })
      .sort((a, b) => a.index - b.index);
    return { entries, deliveryStatus: (l as { delivery_status?: string | null }).delivery_status ?? null };
  } catch (e) {
    console.warn("photo delivery: listing read failed", listingId, (e as Error).message);
    return null;
  }
}

function dropboxGallery(entries: FinalEntry[]): GalleryEntry[] {
  return entries.map((e, n) => ({
    name: e.name,
    sourceKind: "DROPBOX" as const,
    sourceUrl: null,
    sourceRef: null,
    dropboxPath: e.path,
    dropboxId: e.id,
    contentHash: e.contentHash ?? hashOf(`dropbox:${e.path}:${e.size ?? ""}:${e.serverModified ?? ""}`),
    bytes: e.size,
    index: n,
  }));
}

export function galleryFingerprint(entries: GalleryEntry[]): string {
  const h = createHash("sha256");
  for (const e of entries) h.update(`${e.sourceKind}\u0000${e.name}\u0000${e.contentHash}\n`);
  return h.digest("hex").slice(0, 32);
}

/** Open a PhotoJob for each photo job shot since the epoch that is not delivered yet. */
export async function openNewJobs(now = new Date(), max = 40): Promise<number> {
  const settings = await photoDeliverySettings();
  const since = settings.qcFrom ? new Date(settings.qcFrom) : PHOTO_DELIVERY_EPOCH;
  const projects = await prisma.project.findMany({
    where: {
      shootDate: { gte: new Date(since.getTime() - 3 * 86_400_000), lte: new Date(now.getTime() + 60 * MIN) },
      status: { in: ["SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] },
      deliveredAt: null,
      aryeoMissingAt: null,
      deliverables: { some: { removedFromOrderAt: null, waivedAt: null, type: { in: [...PHOTO_TYPES] } } },
    },
    orderBy: { shootDate: "asc" },
    select: { id: true, shootDate: true, promisedDueAt: true, deliveryDue: true },
    take: 200,
  });
  if (!projects.length) return 0;
  const existing = new Set((await prisma.photoJob.findMany({ where: { projectId: { in: projects.map((p) => p.id) } }, select: { projectId: true } })).map((j) => j.projectId));
  let opened = 0;
  for (const p of projects) {
    if (opened >= max) break;
    if (existing.has(p.id)) continue;
    if (p.shootDate && p.shootDate > now) continue; // not shot yet
    try {
      const job = await prisma.photoJob.create({
        data: {
          projectId: p.id,
          stage: "EDITING",
          slaDueAt: p.promisedDueAt ?? p.deliveryDue ?? null,
          expectedJson: JSON.stringify(await expectedFor(p.id)),
          nextCheckAt: now,
        },
      });
      await logJobEvent(job.id, "sync", "photo job opened (shot, waiting for the edited gallery)");
      opened++;
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e; // another tick opened it
    }
  }
  return opened;
}

/** Read one job's gallery and keep its photo rows and stage in step. */
export async function syncJobFinals(jobId: string, now = new Date()): Promise<{ changed: boolean; count: number | null; stage: string; source: string | null }> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId } });
  if (!job) return { changed: false, count: null, stage: "missing", source: null };
  const project = await prisma.project.findUnique({
    where: { id: job.projectId },
    select: { title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, status: true, deliveredAt: true, aryeoListingId: true, client: { select: { name: true } } },
  });
  if (!project?.client) return { changed: false, count: null, stage: job.stage, source: null };
  if (project.status === "CANCELLED") {
    await prisma.photoJob.update({ where: { id: jobId }, data: { nextCheckAt: null } });
    await logJobEvent(jobId, "sync", "project cancelled: sync stopped");
    return { changed: false, count: null, stage: job.stage, source: null };
  }

  // Source 1: the Aryeo listing (where the edited gallery actually appears).
  // Source 2: the Dropbox finals folder (empty today; read so the hub follows
  // the day AutoHDR delivers there again).
  const folder = actualFolderPaths({ ...project, client: project.client }).finalPhotos;
  const [listing, finals] = await Promise.all([
    project.aryeoListingId ? listingGallery(project.aryeoListingId) : Promise.resolve(null),
    listFinals(folder),
  ]);
  let entries: GalleryEntry[] | null = null;
  let source: string | null = null;
  if (listing && listing.entries.length > 0) {
    entries = listing.entries;
    source = "aryeo";
  } else if (finals && finals.length > 0) {
    entries = dropboxGallery(finals);
    source = "dropbox";
  } else if (listing || finals) {
    entries = [];
    source = listing ? "aryeo" : "dropbox";
  }
  if (entries === null) {
    await prisma.photoJob.update({ where: { id: jobId }, data: { nextCheckAt: new Date(now.getTime() + 10 * MIN), lastError: "Couldn't read the Aryeo listing or the finals folder (will retry)." } });
    return { changed: false, count: null, stage: job.stage, source };
  }
  const fp = galleryFingerprint(entries);
  const changed = fp !== job.finalsFingerprint;

  if (changed) {
    const existing = await prisma.photoAsset.findMany({ where: { jobId }, select: { id: true, name: true, contentHash: true, status: true, sourceRef: true, sourceKind: true } });
    // Match an Aryeo image by its id first (a rename keeps the id), then by name.
    const byRef = new Map(existing.filter((e) => e.sourceRef).map((e) => [`${e.sourceKind}:${e.sourceRef}`, e]));
    const byName = new Map(existing.map((e) => [e.name, e]));
    const seen = new Set<string>();
    let added = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const prev = (e.sourceRef ? byRef.get(`${e.sourceKind}:${e.sourceRef}`) : undefined) ?? byName.get(e.name);
      if (!prev) {
        // Two Aryeo images can share a filename: keep names unique per job.
        let name = e.name;
        for (let n = 2; byName.has(name) || seen.has(name); n++) name = e.name.replace(/(\.[a-z0-9]+)?$/i, ` (${n})$1`);
        const photo = await prisma.photoAsset
          .create({
            data: { jobId, name, sourceKind: e.sourceKind, sourceUrl: e.sourceUrl, sourceRef: e.sourceRef, dropboxPath: e.dropboxPath, dropboxId: e.dropboxId, contentHash: e.contentHash, bytes: e.bytes ?? undefined, sequence: i, status: "ACTIVE" },
          })
          .catch((err: unknown) => ((err as { code?: string }).code === "P2002" ? null : Promise.reject(err)));
        if (photo) {
          seen.add(name);
          added++;
          await prisma.photoVersion.create({ data: { photoId: photo.id, label: e.sourceKind === "ARYEO" ? "On the Aryeo listing" : "AutoHDR edit", source: "AUTOHDR_INITIAL", dropboxPath: e.dropboxPath, contentHash: e.contentHash, bytes: e.bytes ?? undefined } });
        }
      } else {
        seen.add(prev.name);
        const data: Record<string, unknown> = { sourceKind: e.sourceKind, sourceUrl: e.sourceUrl, sourceRef: e.sourceRef, dropboxPath: e.dropboxPath, dropboxId: e.dropboxId, sequence: i, bytes: e.bytes ?? undefined };
        if (prev.status === "GONE") data.status = "ACTIVE";
        if (prev.contentHash !== e.contentHash) {
          data.contentHash = e.contentHash;
          // Replaced outside the hub's fix flow (an editor's manual fix, a
          // re-import in Aryeo): a new version, and the old findings no longer
          // describe this photo (the QC engine supersedes them on re-run).
          const known = await prisma.photoVersion.findFirst({ where: { photoId: prev.id, contentHash: e.contentHash }, select: { id: true } });
          if (!known) await prisma.photoVersion.create({ data: { photoId: prev.id, label: "Replaced", source: "EDITOR", dropboxPath: e.dropboxPath, contentHash: e.contentHash, bytes: e.bytes ?? undefined } });
        }
        await prisma.photoAsset.update({ where: { id: prev.id }, data });
      }
    }
    // EXCLUDED is a person's decision and survives; anything else no longer
    // in the gallery is GONE.
    const gone = existing.filter((e) => !seen.has(e.name) && e.status === "ACTIVE").map((e) => e.id);
    if (gone.length) await prisma.photoAsset.updateMany({ where: { id: { in: gone } }, data: { status: "GONE" } });
    await prisma.photoJob.update({
      where: { id: jobId },
      data: { finalsPath: source === "dropbox" ? folder : null, finalsFingerprint: fp, finalsCount: entries.length, finalsChangedAt: now, finalsStableAt: null, lastError: null },
    });
    await logJobEvent(jobId, "sync", `gallery changed (${source}): ${entries.length} photo${entries.length === 1 ? "" : "s"}`, { added, gone: gone.length });
    if (["QC_REVIEW", "READY", "FIXING", "ON_HOLD"].includes(job.stage) && (added > 0 || existing.some((e) => entries!.some((x) => x.name === e.name && x.contentHash !== e.contentHash)))) {
      await prisma.photoJob.update({ where: { id: jobId }, data: { qcRequestedAt: now } });
      await logJobEvent(jobId, "sync", "re-QC requested: the gallery changed after QC");
    }
  } else if (!job.finalsStableAt && entries.length > 0) {
    await prisma.photoJob.update({ where: { id: jobId }, data: { finalsStableAt: now, lastError: null } });
  }

  // EDITING → EDITED once the gallery has landed and stopped changing.
  const fresh = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, finalsChangedAt: true, finalsCount: true } });
  let stage = fresh?.stage ?? job.stage;
  if (stage === "EDITING" && (fresh?.finalsCount ?? 0) > 0 && fresh?.finalsChangedAt && now.getTime() - fresh.finalsChangedAt.getTime() >= FINALS_SETTLE_MS) {
    if (await setStage(jobId, ["EDITING"], "EDITED", "sync", { why: `${fresh.finalsCount} edited photos on the ${source === "dropbox" ? "finals folder" : "Aryeo listing"}, stable` })) stage = "EDITED";
  }

  // Delivered (Kyle pressed Deliver in Aryeo): verify against the QC'd set.
  const deliveredOnAryeo = listing?.deliveryStatus === "DELIVERED";
  if ((project.deliveredAt || deliveredOnAryeo) && !["DELIVERED", "DELIVERY_MISMATCH"].includes(stage)) {
    const from: JobStage[] = ["EDITING", "EDITED", "QC_RUNNING", "QC_REVIEW", "FIXING", "ON_HOLD", "READY", "DELIVERING", "REVISION_REQUESTED", "EDIT_FAILED"];
    if (stage !== "DELIVERING") await setStage(jobId, from, "DELIVERING", "sync", { why: "delivered in Aryeo", extra: { deliveryStartedAt: project.deliveredAt ?? now } });
    try {
      const { verifyDelivery } = await import("./delivery");
      const v = await verifyDelivery(jobId, "sync");
      stage = v.ok ? "DELIVERED" : v.waiting ? "DELIVERING" : "DELIVERY_MISMATCH";
    } catch (e) {
      console.warn("photo delivery: verify failed", jobId, (e as Error).message);
      stage = "DELIVERING";
    }
  }

  // Cut-off uploads (Oct 14 2026: two half-gray photos on a delivered
  // listing): once the gallery has stopped changing, check every listing
  // photo ends like a complete JPEG. Once per gallery version; alerts Kyle
  // and Jordan. Not while files are still arriving (a pass that changed it).
  if (source === "aryeo" && entries.length > 0 && !changed) {
    const { checkGalleryIntegrity } = await import("./integrity");
    await checkGalleryIntegrity(jobId, fp, { delivered: stage === "DELIVERED" || stage === "DELIVERING" });
  }

  const next = stage === "EDITING" ? 5 * MIN : stage === "DELIVERED" ? 6 * 60 * MIN : 15 * MIN;
  await prisma.photoJob.update({ where: { id: jobId }, data: { nextCheckAt: new Date(now.getTime() + next) } });
  return { changed, count: entries.length, stage, source };
}

/** One sync pass: open new jobs, then refresh the jobs that are due. */
export async function syncPhotoJobs(opts: { budgetMs: number; now?: Date }): Promise<{ opened: number; synced: number; changed: number; errors: number; stoppedEarly: boolean }> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const settings = await photoDeliverySettings();
  if (!settings.enabled) return { opened: 0, synced: 0, changed: 0, errors: 0, stoppedEarly: false };
  const opened = await openNewJobs(now);
  const due = await prisma.photoJob.findMany({
    where: { stage: { in: OPEN_STAGES }, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
    orderBy: [{ nextCheckAt: "asc" }],
    select: { id: true },
    take: 60,
  });
  // Delivered in the last 7 days: a slow check (every 6 hours), so a photo
  // replaced in Aryeo (a revision) and a cut-off upload are still seen.
  const delivered = await prisma.photoJob.findMany({
    where: { stage: "DELIVERED", stageChangedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) }, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
    orderBy: [{ nextCheckAt: "asc" }],
    select: { id: true },
    take: 10,
  });
  due.push(...delivered);
  let synced = 0, changed = 0, errors = 0;
  let stoppedEarly = false;
  for (const j of due) {
    if (Date.now() - started > opts.budgetMs) {
      stoppedEarly = true;
      break;
    }
    try {
      const r = await syncJobFinals(j.id, now);
      synced++;
      if (r.changed) changed++;
    } catch (e) {
      errors++;
      console.warn("photo delivery: sync failed", j.id, (e as Error).message);
      await prisma.photoJob.update({ where: { id: j.id }, data: { lastError: (e as Error).message.slice(0, 300), nextCheckAt: new Date(now.getTime() + 15 * MIN) } }).catch(() => {});
    }
  }
  return { opened, synced, changed, errors, stoppedEarly };
}
