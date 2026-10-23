import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { stagedPhotosOrdered } from "@/lib/stagingCount";
import { actualFolderPaths } from "@/lib/dropboxFolders";
import { dbx, DropboxError } from "@/lib/integrations/dropbox";
import { Aryeo } from "@/lib/integrations/aryeo";
import { photoDeliverySettings } from "./settings";
import { deliveryDueFrom, sameDayTypes } from "@/lib/tasks";
import { logJobEvent, setStage, type JobStage } from "./jobState";
import { BY_HAND_LABEL, ON_LISTING, ON_LISTING_REASON, listingImageHash, sameFile } from "./listingMatch";

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
//   5. follows the delivery the listing reports (its delivery_status) and
//      then verifies it against the QC'd set.
// Read-only toward Aryeo, Dropbox and AutoHDR. Every write is a hub row.
//
// Oct 14 2026: a third source. When the hub sent the raws itself (intake.ts),
// AutoHDR's processed photos are the gallery until they reach Aryeo, so the
// free photo check runs before Kyle pushes them. When the listing then shows
// the same photos ("<Street> (N of M).jpg", AutoHDR's gallery order), each
// row is carried over in place (adoptListing): same photo, same findings.
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
  sourceKind: "ARYEO" | "DROPBOX" | "AUTOHDR";
  sourceUrl: string | null;
  sourceRef: string | null;
  dropboxPath: string | null;
  dropboxId: string | null;
  contentHash: string;
  bytes: number | null;
  index: number;
  autohdrImageUuid?: string | null;
  autohdrVersionUuid?: string | null;
  /**
   * Oct 22 2026 (615 Cliff Ln): already on the Aryeo listing beside a split
   * job's new visit (listingMatch.ts): the row is kept as ON_LISTING
   * ("Delivered"), out of the delivery set, the checks and the push.
   */
  onListing?: boolean;
  /** A photo of the new visit Kyle put on the listing by hand: that listing image (its file name, its content hash). */
  byHand?: { name: string; contentHash: string } | null;
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

type ExpectedDeliverables = {
  minPhotos?: number;
  /** Oct 15 2026: from the Aryeo listing (room coverage, and the paid QC's P4 "beds | baths"). */
  bedrooms?: number;
  bathrooms?: number;
  maxPhotos?: number;
  droneCount?: number;
  twilightReal?: number;
  twilightVirtual?: number;
  virtualStagingCount?: number;
  /**
   * Oct 23 2026: staging is on the order but a line does not say how many
   * (stagingCount.ts). virtualStagingCount is then what the lines that do say
   * add up to (often 0); nothing guesses the rest.
   */
  virtualStagingUnknown?: boolean;
  /** Oct 14 2026: virtual decluttering ordered (photos). */
  virtualDeclutterCount?: number;
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
      deliverables: { select: { type: true, quantity: true, productTitle: true, label: true, removedFromOrderAt: true, waivedAt: true } },
      orderItems: { select: { title: true, quantity: true, isCanceled: true } },
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
  // Oct 23 2026 (Jordan): the staged photos ordered, counted the one way
  // (stagingCount.ts): the line's quantity, or a custom line's stated number.
  const staging = stagedPhotosOrdered(p.orderItems, p.deliverables);
  if (staging.ordered) {
    out.virtualStagingCount = staging.known;
    if (staging.count == null) out.virtualStagingUnknown = true;
    out.source.virtualStagingCount = `order: ${staging.lines.map((l) => `${l.title} ${l.how === "title" ? "(the number in its name)" : l.how === "quantity" ? `× ${l.quantity}` : "(no count on it)"}`).join(", ")}`.slice(0, 200);
  }
  for (const d of p.deliverables) {
    if (d.removedFromOrderAt || d.waivedAt) continue;
    const title = `${d.productTitle ?? ""} ${d.label ?? ""}`.toLowerCase();
    const q = Math.max(1, d.quantity ?? 1);
    if (/declutter/.test(title)) {
      out.virtualDeclutterCount = (out.virtualDeclutterCount ?? 0) + q;
      (out.source as Record<string, string>).virtualDeclutterCount = `deliverable: ${d.productTitle ?? "virtual declutter"}`;
    } else if (d.type === "DRONE") {
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
      // Counted above, from the order (stagingCount.ts).
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

/** What the listing says about the home (room coverage). */
export type ListingFacts = { bedrooms: number | null; bathrooms: number | null; propertyType: string | null };

/** The Aryeo listing's gallery images, in Aryeo's order, and its home facts. null = the read failed. */
export async function listingGallery(listingId: string): Promise<{ entries: GalleryEntry[]; deliveryStatus: string | null; facts?: ListingFacts } | null> {
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
          contentHash: listingImageHash(i.id, url),
          bytes: null,
          index: typeof i.index === "number" ? i.index : n,
        };
      })
      .sort((a, b) => a.index - b.index);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    const loose = l as { type?: unknown; sub_type?: unknown; property_type?: unknown };
    const kind = [loose.sub_type, loose.property_type, loose.type].find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? null;
    const facts: ListingFacts = { bedrooms: num(l.building?.bedrooms), bathrooms: num(l.building?.bathrooms), propertyType: kind ? kind.replace(/_/g, " ").toLowerCase().slice(0, 60) : null };
    return { entries, deliveryStatus: (l as { delivery_status?: string | null }).delivery_status ?? null, facts };
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
  // The delivered marks (Oct 22 2026) only when set, so every other gallery keeps its fingerprint.
  for (const e of entries) h.update(`${e.sourceKind}\u0000${e.name}\u0000${e.contentHash}${e.onListing ? `\u0000L${e.byHand?.contentHash ?? ""}` : ""}\n`);
  return h.digest("hex").slice(0, 32);
}

/**
 * THE PHOTO DEADLINE (Oct 22 2026). A photo job is due on the PHOTOS
 * turnaround (next morning, or the same day when the order bought a same-day
 * photo add-on) counted from the visit whose photos it is delivering, never
 * from the order's slowest item. 615 Cliff Ln read "Late by 8 days" and then
 * "5 days left" because the job carried the order's promise and then its
 * delivery date, both dated by the Social Influencer reel; Jordan: "they are
 * due today", and "split jobs should be treated as a normal SLA for each
 * appointment and depend on what was uploaded to Dropbox / submitted in the
 * upload portal". Pure: the caller picks the visit (photoVisitFor).
 */
export function photoDueFor(visitStart: Date | null, sameDay: boolean): Date | null {
  return visitStart ? deliveryDueFrom(visitStart, "PHOTOS", { sameDay }) : null;
}

/**
 * The visit whose photos the job is delivering: the latest visit that has
 * started AND has photo raws uploaded on or after its ET day (an intake batch
 * that saw them; a batch whose files carry upload times counts only when one
 * of them is on or after that day, so the earlier visit's files never move the
 * clock); else the earliest visit; else the shoot date. A later visit that
 * uploaded no photos (a video-only return) leaves the photo clock where it was.
 */
export async function photoVisitFor(
  projectId: string,
  appointments: { startAt: Date | null; status: string | null }[],
  shootDate: Date | null,
  now: Date,
): Promise<Date | null> {
  const visits = appointments
    .filter((a) => a.startAt && a.startAt <= now && !/cancel/i.test(a.status ?? ""))
    .map((a) => a.startAt!)
    .sort((a, b) => a.getTime() - b.getTime());
  if (!visits.length) return shootDate && shootDate <= now ? shootDate : null;
  if (visits.length === 1) return visits[0];
  const { etDayStartUtc } = await import("@/lib/datetime");
  const batches = await prisma.photoIntakeBatch.findMany({ where: { projectId }, select: { state: true, seenAt: true, filesJson: true } });
  const uploadedSince = (floor: Date) =>
    batches.some((b) => {
      let times: number[] = [];
      try {
        times = (JSON.parse(b.filesJson ?? "[]") as { uploadedAt?: string | null }[]).map((f) => (f.uploadedAt ? Date.parse(f.uploadedAt) : NaN)).filter((t) => Number.isFinite(t));
      } catch { /* no file list: fall back to when the batch was seen */ }
      return times.length ? times.some((t) => t >= floor.getTime()) : b.state !== "FAILED" && b.seenAt >= floor;
    });
  for (let i = visits.length - 1; i > 0; i--) if (uploadedSince(etDayStartUtc(visits[i]))) return visits[i];
  return visits[0];
}

/** Whether this order bought same-day photos (the add-on outranks next morning). */
async function sameDayPhotos(projectId: string): Promise<boolean> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { deliverables: { where: { removedFromOrderAt: null, waivedAt: null }, select: { type: true, label: true, productTitle: true } }, orderItems: { select: { title: true, isCanceled: true } } },
  }).catch(() => null);
  return !!p && sameDayTypes(p.deliverables, p.orderItems).has("PHOTOS");
}

/** The start of the latest appointment that has started (cancelled ones never count). Pure. */
export function latestStartedVisit(appointments: { startAt: Date | null; status: string | null }[], now: Date): { start: Date | null; started: number } {
  const started = appointments.filter((a) => a.startAt && a.startAt <= now && !/cancel/i.test(a.status ?? "")).map((a) => a.startAt!.getTime());
  return { start: started.length ? new Date(Math.max(...started)) : null, started: started.length };
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
    select: { id: true, shootDate: true, promisedDueAt: true, deliveryDue: true, appointments: { select: { startAt: true, status: true } } },
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
          slaDueAt: photoDueFor(await photoVisitFor(p.id, p.appointments, p.shootDate, now), await sameDayPhotos(p.id)),
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

const N_OF_M = /\((\d+) of (\d+)\)\.[a-z0-9]+$/i;
const CANCELLED_NOTE = "project cancelled: sync stopped";

/** The hub's own AutoHDR shoot(s) for a project, as gallery entries. */
async function autohdrGallery(projectId: string, sentSince: Date | null = null): Promise<GalleryEntry[]> {
  const { intakeGallery } = await import("./intake");
  const photos = await intakeGallery(projectId, { sentSince }).catch(() => []);
  const used = new Set<string>();
  return photos.map((p, n) => {
    let name = p.name.slice(0, 200);
    for (let k = 2; used.has(name.toLowerCase()); k++) name = p.name.replace(/(\.[a-z0-9]+)?$/i, ` (${k})$1`);
    used.add(name.toLowerCase());
    return {
      name,
      sourceKind: "AUTOHDR" as const,
      sourceUrl: p.url,
      sourceRef: `${p.shootId}/${p.image_uuid}`,
      dropboxPath: null,
      dropboxId: null,
      contentHash: hashOf(`autohdr:${p.image_version_uuid}`),
      bytes: null,
      index: n,
      autohdrImageUuid: p.image_uuid,
      autohdrVersionUuid: p.image_version_uuid,
    };
  });
}

/**
 * The AutoHDR photos the hub checked have reached the Aryeo listing (Kyle
 * pushed them): carry each row over in place, so its findings and checks stay
 * with it. Only when every listing name is "(N of M)" with M equal to the
 * hub's photo count (AutoHDR names them in its gallery order, verified Oct 14
 * on 2236 Gregory Dr), or every 06-Ready-for-Aryeo file is there; anything
 * else is left to the normal match. "uploading": part of the ready files are
 * on the listing so far (an upload lands over several minutes), so nothing
 * is carried over yet and the AutoHDR gallery stays the one to read.
 */
async function adoptListing(jobId: string, entries: GalleryEntry[], opts: { besideEarlierVisit?: boolean } = {}): Promise<"adopted" | "uploading" | "no"> {
  const rows = await prisma.photoAsset.findMany({ where: { jobId, sourceKind: "AUTOHDR", status: { in: ["ACTIVE", "EXCLUDED"] } }, orderBy: { sequence: "asc" }, select: { id: true, contentHash: true, inspectedHash: true, classifiedHash: true } });
  // Oct 22 2026 (hubFiles.ts): a photo Kyle added by hand goes out through
  // 06-Ready-for-Aryeo with the rest, and carries over the same way.
  const hand = await prisma.photoAsset.findMany({ where: { jobId, sourceKind: "UPLOAD", status: { in: ["ACTIVE", "EXCLUDED"] } }, select: { id: true, contentHash: true, inspectedHash: true, classifiedHash: true } });
  if (!rows.length && !hand.length) return "no";
  // A split job's earlier visit is already ARYEO rows on the job; the caller
  // passes only the listing photos that are not theirs (Oct 22 2026).
  if (!opts.besideEarlierVisit && (await prisma.photoAsset.count({ where: { jobId, sourceKind: "ARYEO" } }))) return "no";
  // Oct 14 2026 (huddle): Kyle uploads the 06-Ready-for-Aryeo files, named in
  // delivery order ("01-Front-Exterior.jpg"). When every listing image is one
  // of them, each carries over to its own AutoHDR photo, so its versions,
  // findings and AutoHDR link (Restore) stay with it after delivery.
  const ready = await (await import("./handoff")).readyNamesFor(jobId).catch(() => new Map<string, string>());
  const byId = new Map([...rows, ...hand].map((r) => [r.id, r]));
  const viaReady = entries.length > 0 && entries.every((e) => byId.has(ready.get(e.name.toLowerCase()) ?? "")) && new Set(entries.map((e) => ready.get(e.name.toLowerCase()))).size === entries.length;
  if (viaReady && entries.length < ready.size) return "uploading";
  if (!viaReady && rows.length !== entries.length) return "no";
  const slots = entries.map((e) => N_OF_M.exec(e.name));
  if (!viaReady) {
    if (slots.some((m) => !m || Number(m[2]) !== rows.length)) return "no";
    if (new Set(slots.map((m) => Number(m![1]))).size !== rows.length) return "no";
  }
  const ops = entries.flatMap((e, i) => {
    const row = viaReady ? byId.get(ready.get(e.name.toLowerCase())!)! : rows[Number(slots[i]![1]) - 1];
    const old = row.contentHash;
    return [
      prisma.photoAsset.update({
        where: { id: row.id },
        data: {
          name: e.name, sourceKind: "ARYEO", sourceUrl: e.sourceUrl, sourceRef: e.sourceRef, contentHash: e.contentHash,
          ...(row.inspectedHash && row.inspectedHash === old ? { inspectedHash: e.contentHash } : {}),
          ...(row.classifiedHash && row.classifiedHash === old ? { classifiedHash: e.contentHash } : {}),
        },
      }),
      prisma.photoQcFinding.updateMany({ where: { jobId, photoId: row.id, contentHash: old }, data: { contentHash: e.contentHash } }),
    ];
  });
  await prisma.$transaction(ops);
  await logJobEvent(jobId, "sync", `the ${entries.length} AutoHDR photos reached the Aryeo listing${viaReady ? " (the 06-Ready-for-Aryeo files)" : ""}: carried over in place (findings, versions and the AutoHDR link kept)`);
  return "adopted";
}

/**
 * Oct 15 2026: the listing's bedrooms, bathrooms and property type go into
 * the job's expected deliverables (room coverage; the paid QC's P4 read them
 * as "unavailable" because nothing ever set them). Written only when changed.
 */
async function keepListingFacts(jobId: string, expectedJson: string | null, facts: ListingFacts | undefined): Promise<void> {
  if (!facts || (facts.bedrooms == null && facts.bathrooms == null && !facts.propertyType)) return;
  let e: Record<string, unknown> = {};
  try { e = JSON.parse(expectedJson ?? "{}") as Record<string, unknown>; } catch { e = {}; }
  const next = { ...e };
  const source = { ...((e.source as Record<string, string> | undefined) ?? {}) };
  if (facts.bedrooms != null && e.bedrooms !== facts.bedrooms) { next.bedrooms = facts.bedrooms; source.bedrooms = "Aryeo listing"; }
  if (facts.bathrooms != null && e.bathrooms !== facts.bathrooms) { next.bathrooms = facts.bathrooms; source.bathrooms = "Aryeo listing"; }
  if (facts.propertyType && e.propertyType !== facts.propertyType) { next.propertyType = facts.propertyType; source.propertyType = "Aryeo listing"; }
  if (JSON.stringify(next) === JSON.stringify(e)) return;
  next.source = source;
  if (!Array.isArray(next.requestedFeatures)) next.requestedFeatures = [];
  await prisma.photoJob.update({ where: { id: jobId }, data: { expectedJson: JSON.stringify(next) } });
}

/** Oct 15 2026: findings on a photo no longer in the gallery never count (2236 Gregory Dr's replaced listing). */
export const GONE_REASON = "The photo is no longer in the gallery";

/** Read one job's gallery and keep its photo rows and stage in step. */
export async function syncJobFinals(jobId: string, now = new Date()): Promise<{ changed: boolean; count: number | null; stage: string; source: string | null }> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId } });
  if (!job) return { changed: false, count: null, stage: "missing", source: null };
  const project = await prisma.project.findUnique({
    where: { id: job.projectId },
    select: { title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, status: true, aryeoListingId: true, promisedDueAt: true, deliveryDue: true, dueOverrideAt: true, appointments: { select: { startAt: true, status: true } }, client: { select: { name: true } } },
  });
  if (!project?.client) return { changed: false, count: null, stage: job.stage, source: null };
  if (project.status === "CANCELLED") {
    // Looked at again once a day (a project can be un-cancelled); said once.
    await prisma.photoJob.update({ where: { id: jobId }, data: { nextCheckAt: new Date(now.getTime() + 24 * 60 * MIN) } });
    if (!(await prisma.photoJobEvent.count({ where: { jobId, actor: "sync", action: CANCELLED_NOTE } }))) await logJobEvent(jobId, "sync", CANCELLED_NOTE);
    return { changed: false, count: null, stage: job.stage, source: null };
  }

  // Source 1: the Aryeo listing (where the edited gallery actually appears).
  // Source 2: the Dropbox finals folder (empty today; read so the hub follows
  // the day AutoHDR delivers there again).
  const folder = actualFolderPaths({ ...project, client: project.client }).finalPhotos;
  // A SPLIT JOB (Oct 22 2026, 615 Cliff Ln): two visits, one job. The earlier
  // visit's photos are already delivered on the listing; the latest visit's
  // raws went to AutoHDR from the hub (intake batches sent on or after that
  // visit's ET day). Until this visit's photos are on the listing too, the job
  // reads THEM (the hub's AutoHDR gallery) and goes through the normal check
  // and Kyle's approval; the earlier visit's rows are set aside (GONE, never
  // deleted) and come back when the listing shows both sets.
  const visits = latestStartedVisit(project.appointments, now);
  const split = visits.started > 1;
  const { uploadFloorFor } = await import("./intake");
  const floor = split ? uploadFloorFor(project.appointments, project.shootDate, now) : null;
  const [listing, finals, hubShoot, hubNew] = await Promise.all([
    project.aryeoListingId ? listingGallery(project.aryeoListingId) : Promise.resolve(null),
    listFinals(folder),
    autohdrGallery(job.projectId),
    floor ? autohdrGallery(job.projectId, floor) : Promise.resolve([] as GalleryEntry[]),
  ]);
  // The photo deadline: the photos turnaround from the visit whose photos
  // these are (photoDueFor). Re-read every pass while the job is open; a
  // delivered job keeps the deadline it was delivered against.
  if (job.stage !== "DELIVERED") {
    const { etDateTime } = await import("@/lib/datetime");
    // Oct 22 2026 (photo audit M1): a client's revision of photos already
    // delivered has its OWN clock, the standard revision turnaround from the
    // client's request (deliveryBoard.clientRoundClock: due 48 weekday hours
    // after it). Recomputed from the original visit it read days late and set
    // off the photos-late alert. The office's due date for the job
    // (Project.dueOverrideAt) outranks the visit's turnaround, as everywhere.
    const revisionAt = job.deliveredAt ? await import("./clientAsked").then((m) => m.revisionStartOf(jobId)).catch(() => null) : null;
    let due: Date | null;
    let why: string;
    if (revisionAt) {
      const { clientRoundClock } = await import("@/lib/deliveryBoard");
      due = clientRoundClock(revisionAt).dueAt;
      why = `the revision turnaround from the client's request (${etDateTime(revisionAt)})`;
    } else if (project.dueOverrideAt) {
      due = project.dueOverrideAt;
      why = "the job's due date the office set";
    } else {
      const visit = await photoVisitFor(job.projectId, project.appointments, project.shootDate, now);
      due = photoDueFor(visit, await sameDayPhotos(job.projectId));
      why = `the photos turnaround from the ${etDateTime(visit)} visit`;
    }
    if (due && job.slaDueAt?.getTime() !== due.getTime()) {
      await prisma.photoJob.update({ where: { id: jobId }, data: { slaDueAt: due } });
      await logJobEvent(jobId, "sync", `photo deadline set to ${etDateTime(due)} ET: ${why}${job.slaDueAt ? ` (was ${etDateTime(job.slaDueAt)})` : ""}`);
    }
  }
  // WAITING ON THE LATEST VISIT (Oct 22 2026, Jordan on 615 Cliff Ln: "it
  // says delivered… we didn't even deliver the interior photos because only
  // exteriors were shot at the first appointment"). On a split job whose
  // latest visit has started, the earlier visit's delivered listing is not
  // the job's delivery while that visit's photos are still on their way (no
  // raws seen since the visit's day, or a batch not back from AutoHDR yet):
  // the earlier photos are still read as rows below, but the job stays in
  // Editing, says what it waits for, and nothing reads the listing's
  // "delivered" as the job's (handled after the gallery is written).
  let awaitingVisit = false;
  if (split && floor && hubNew.length === 0 && listing && listing.entries.length > 0) {
    const since = await prisma.photoIntakeBatch.findMany({ where: { projectId: job.projectId, seenAt: { gte: floor }, state: { not: "FAILED" } }, select: { state: true } });
    // A later visit that uploads no photos (a video-only return) is not waited
    // on forever (Oct 22 2026, Jordan: a split job's photos "depend on what was
    // uploaded to Dropbox / submitted in the upload portal"): with nothing seen
    // a day after the visit started, the earlier visit's delivery stands.
    const quietDay = !!visits.start && now.getTime() - visits.start.getTime() > 24 * 60 * MIN;
    // Oct 22 2026 (photo audit M4): a return visit that uploaded no photos (a
    // video-only return) never pulls DELIVERED photos back into Editing (nor
    // clears their delivery date): only raws seen since the visit's day do.
    const photosOut = ["DELIVERED", "DELIVERING", "DELIVERY_MISMATCH"].includes(job.stage) || !!job.deliveredAt;
    awaitingVisit = since.length === 0 ? !quietDay && !photosOut : since.some((b) => !["DONE", "LINKED"].includes(b.state));
  }
  let newVisit = false;
  // DELIVERED BESIDE THE NEW VISIT (Oct 22 2026, Jordan on 615 Cliff Ln: "show
  // all the pics together in the hub and let us know which ones are already
  // delivered and which ones are not"). While the new visit is not on the
  // listing, the listing's other images (the earlier visit's, anything else
  // already there) stay on the job as ON_LISTING rows, "Delivered", instead of
  // being set aside; a photo of this visit Kyle put on the listing by hand is
  // found by its own file name (DSC07999) and counts as delivered too. Neither
  // is sent again, checked again or counted as owed.
  let beside: GalleryEntry[] = [];
  const byHand = new Map<string, GalleryEntry>(); // this visit's AutoHDR uuid → the listing image it is
  if (hubNew.length > 0 && listing && listing.entries.length > 0) {
    const uuids = hubNew.map((e) => e.autohdrImageUuid).filter((u): u is string => !!u);
    const onListing = await prisma.photoAsset.count({ where: { jobId, sourceKind: "ARYEO", autohdrImageUuid: { in: uuids } } });
    if (onListing < hubNew.length) {
      const earlier = await prisma.photoAsset.findMany({ where: { jobId, sourceKind: "ARYEO", sourceRef: { not: null }, OR: [{ autohdrImageUuid: null }, { autohdrImageUuid: { notIn: uuids } }] }, select: { sourceRef: true } });
      if (earlier.length > 0) {
        const known = new Set(earlier.map((r) => r.sourceRef!));
        // Every listing image the hub cannot place yet is one of: this visit's
        // upload (a name the hub gave it in 06-Ready-for-Aryeo or its push, or
        // AutoHDR's "(N of M)"), a photo of this visit added by hand (its own
        // file name), or something else already on the listing (kept beside).
        const [visitRows, hubNames] = await Promise.all([
          prisma.photoAsset.findMany({ where: { jobId, sourceKind: "AUTOHDR", autohdrImageUuid: { in: uuids } }, orderBy: { sequence: "asc" }, select: { name: true, status: true, autohdrImageUuid: true } }),
          listingNamesOfHub(jobId),
        ]);
        const fresh: GalleryEntry[] = [];
        const unplaced = new Set<GalleryEntry>();
        for (const e of listing.entries) {
          if (e.sourceRef && known.has(e.sourceRef)) continue;
          if (hubNames.has(e.name.toLowerCase()) || N_OF_M.test(e.name)) {
            fresh.push(e);
            continue;
          }
          const own = visitRows.find((r) => r.status !== "GONE" && !!r.autohdrImageUuid && !byHand.has(r.autohdrImageUuid) && sameFile(e.name, r.name));
          if (own) byHand.set(own.autohdrImageUuid!, e);
          else unplaced.add(e);
        }
        const partial = fresh.length > 0 && fresh.length < hubNew.length && fresh.every((e) => Number(N_OF_M.exec(e.name)?.[2]) === hubNew.length);
        // Oct 22 2026 (615 Cliff Ln, 1:04 PM): Kyle put ONE photo he re-edited
        // by hand on the listing while the other 35 still waited for his
        // approval; that one unknown photo made the listing read as this
        // visit's delivery and the job vanished into Delivered. A photo or two
        // added by hand is not the visit: the listing counts as this visit's
        // delivery only once it holds at least as many new photos as the visit
        // has (the ones a person excluded, or already on the listing by hand,
        // do not count).
        const setAside = visitRows.filter((r) => r.status === "EXCLUDED" || r.status === ON_LISTING || (!!r.autohdrImageUuid && byHand.has(r.autohdrImageUuid))).length;
        const owed = Math.max(1, hubNew.length - setAside);
        const tooFew = fresh.length > 0 && fresh.length < owed && !partial;
        const adopted = fresh.length > 0 && !partial && !tooFew ? await adoptListing(jobId, fresh, { besideEarlierVisit: true }) : "no";
        // "adopted": this visit is on the listing now, read below as usual.
        // "no" with photos it doesn't recognise: the usual listing read.
        newVisit = fresh.length === 0 || partial || tooFew || adopted === "uploading";
        if (newVisit) beside = listing.entries.filter((e) => (!!e.sourceRef && known.has(e.sourceRef)) || unplaced.has(e)).map((e) => ({ ...e, onListing: true }));
      }
    }
  }
  if (newVisit) {
    const shootId = Number(String(hubNew.at(-1)?.sourceRef ?? "").split("/")[0]) || null;
    const shoots = new Set(hubNew.map((e) => Number(String(e.sourceRef ?? "").split("/")[0])));
    if (shootId && (!job.autohdrPhotoshootId || !shoots.has(job.autohdrPhotoshootId))) {
      const b = await prisma.photoIntakeBatch.findFirst({ where: { projectId: job.projectId, photoshootId: shootId }, select: { address: true, sentAt: true } });
      await prisma.photoJob.update({ where: { id: jobId }, data: { autohdrPhotoshootId: shootId, autohdrShootName: b?.address ?? null, autohdrLinkedAt: now, autohdrCreatedAt: b?.sentAt ?? now } });
      await logJobEvent(jobId, "sync", `linked to this visit's AutoHDR shoot ${shootId}${b?.address ? ` ("${b.address}")` : ""}`);
    }
  }
  let entries: GalleryEntry[] | null = null;
  let source: string | null = null;
  // Kyle's push from AutoHDR to Aryeo lands photo by photo: while the listing
  // holds only part of the hub's AutoHDR gallery ("(N of M)" with M = the
  // hub's count), the AutoHDR gallery is still the one to read.
  // The same while only part of the 06-Ready-for-Aryeo files are on it.
  let pushing = !newVisit && !awaitingVisit && hubShoot.length > 0 && !!listing && listing.entries.length > 0 && listing.entries.length < hubShoot.length && listing.entries.every((e) => Number(N_OF_M.exec(e.name)?.[2]) === hubShoot.length);
  if (!newVisit && !awaitingVisit && listing && listing.entries.length > 0 && !pushing) pushing = (await adoptListing(jobId, listing.entries)) === "uploading" && hubShoot.length > 0;
  if (newVisit) {
    // The listing's photos first, in its order (its cover stays the cover),
    // then this visit's; a photo of this visit already on the listing by hand
    // is marked with that listing image (Oct 22 2026).
    entries = [
      ...beside,
      ...hubNew.map((e): GalleryEntry => {
        const img = e.autohdrImageUuid ? byHand.get(e.autohdrImageUuid) : undefined;
        return img ? { ...e, onListing: true, byHand: { name: img.name, contentHash: img.contentHash } } : e;
      }),
    ];
    source = "autohdr";
  } else if (awaitingVisit && listing && listing.entries.length > 0) {
    // Waiting on the latest visit: everything on the listing is the earlier visit's, delivered (Oct 22 2026).
    entries = listing.entries.map((e) => ({ ...e, onListing: true }));
    source = "aryeo";
  } else if (listing && listing.entries.length > 0 && !pushing) {
    entries = listing.entries;
    source = "aryeo";
  } else if (pushing) {
    entries = hubShoot;
    source = "autohdr";
  } else if (finals && finals.length > 0) {
    entries = dropboxGallery(finals);
    source = "dropbox";
  } else if (hubShoot.length > 0) {
    entries = hubShoot;
    source = "autohdr";
  } else if (listing || finals) {
    entries = [];
    source = listing ? "aryeo" : "dropbox";
  }
  if (entries === null) {
    await prisma.photoJob.update({ where: { id: jobId }, data: { nextCheckAt: new Date(now.getTime() + 10 * MIN), lastError: "Couldn't read the Aryeo listing or the finals folder (will retry)." } });
    return { changed: false, count: null, stage: job.stage, source };
  }
  await keepListingFacts(jobId, job.expectedJson, listing?.facts).catch((e) => console.warn("photo delivery: listing facts", jobId, (e as Error).message));
  const fp = galleryFingerprint(entries);
  const changed = fp !== job.finalsFingerprint;

  if (changed) {
    const existing = await prisma.photoAsset.findMany({ where: { jobId }, select: { id: true, name: true, contentHash: true, status: true, sourceRef: true, sourceKind: true, excludeReason: true, autohdrImageUuid: true } });
    // Match an Aryeo image by its id first (a rename keeps the id), then by name.
    const byRef = new Map(existing.filter((e) => e.sourceRef).map((e) => [`${e.sourceKind}:${e.sourceRef}`, e]));
    const byName = new Map(existing.map((e) => [e.name, e]));
    // Oct 22 2026: a photo of the new visit on the listing by hand: its listing
    // image is found by the content hash recorded for it (or found by file name
    // this pass), so the row follows that image once the visit is delivered.
    const byHandRow = new Map<string, (typeof existing)[number]>();
    const byId = new Map(existing.map((e) => [e.id, e]));
    for (const v of await prisma.photoVersion.findMany({ where: { photo: { jobId }, source: "EDITOR", label: { startsWith: BY_HAND_LABEL } }, select: { photoId: true, contentHash: true } })) {
      const row = byId.get(v.photoId);
      if (row && v.contentHash) byHandRow.set(v.contentHash, row);
    }
    for (const [uuid, img] of byHand) {
      const row = existing.find((r) => r.sourceKind === "AUTOHDR" && r.autohdrImageUuid === uuid);
      if (row) byHandRow.set(img.contentHash, row);
    }
    // Oct 22 2026 (hubFiles.ts): a photo Kyle added to the gallery by hand
    // that the hub's push put on the listing IS that listing image now: found
    // by the name the push gave it, carried over in place (never a second row).
    const pushedHand = new Map<string, (typeof existing)[number]>();
    if (existing.some((e) => e.sourceKind === "UPLOAD")) {
      const pushed = await import("./aryeoPush").then((m) => m.pushedNames(jobId)).catch(() => new Map<string, string>());
      for (const [name, photoId] of pushed) {
        const row = byId.get(photoId);
        if (row?.sourceKind === "UPLOAD") pushedHand.set(name, row);
      }
    }
    const seen = new Set<string>();
    const revived: string[] = [];
    const handNotes: string[] = [];
    let added = 0;
    let addedToDelivery = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const prev = (e.sourceRef ? byRef.get(`${e.sourceKind}:${e.sourceRef}`) : undefined) ?? (e.sourceKind === "ARYEO" ? byHandRow.get(e.contentHash) ?? pushedHand.get(e.name.toLowerCase()) : undefined) ?? byName.get(e.name);
      if (!prev) {
        // Two Aryeo images can share a filename: keep names unique per job.
        let name = e.name;
        for (let n = 2; byName.has(name) || seen.has(name); n++) name = e.name.replace(/(\.[a-z0-9]+)?$/i, ` (${n})$1`);
        const photo = await prisma.photoAsset
          .create({
            data: { jobId, name, sourceKind: e.sourceKind, sourceUrl: e.sourceUrl, sourceRef: e.sourceRef, dropboxPath: e.dropboxPath, dropboxId: e.dropboxId, contentHash: e.contentHash, bytes: e.bytes ?? undefined, sequence: i, status: e.onListing ? ON_LISTING : "ACTIVE", ...(e.autohdrImageUuid ? { autohdrImageUuid: e.autohdrImageUuid, autohdrVersionUuid: e.autohdrVersionUuid ?? null } : {}) },
          })
          .catch((err: unknown) => ((err as { code?: string }).code === "P2002" ? null : Promise.reject(err)));
        if (photo) {
          seen.add(name);
          added++;
          if (!e.onListing) addedToDelivery++;
          await prisma.photoVersion.create({ data: { photoId: photo.id, label: e.sourceKind === "ARYEO" ? "On the Aryeo listing" : "AutoHDR edit", source: "AUTOHDR_INITIAL", dropboxPath: e.dropboxPath, contentHash: e.contentHash, bytes: e.bytes ?? undefined, ...(e.autohdrVersionUuid ? { autohdrVersionUuid: e.autohdrVersionUuid } : {}) } });
        }
      } else {
        seen.add(prev.name);
        const data: Record<string, unknown> = { sourceKind: e.sourceKind, sourceUrl: e.sourceUrl, sourceRef: e.sourceRef, dropboxPath: e.dropboxPath, dropboxId: e.dropboxId, sequence: i, bytes: e.bytes ?? undefined, ...(e.autohdrImageUuid ? { autohdrImageUuid: e.autohdrImageUuid, autohdrVersionUuid: e.autohdrVersionUuid ?? null } : {}) };
        // Oct 14 2026 (huddle finding 1): an AutoHDR photo's CURRENT version is
        // owned by the fix runner, a restore and the head sync (versions.ts),
        // never by the shoot's intake snapshot. The snapshot holds the FIRST
        // edit, so copying it back here quietly undid every fix and restore
        // whenever any other photo in the gallery changed.
        const ownsVersion = prev.sourceKind === "AUTOHDR" && e.sourceKind === "AUTOHDR";
        if (ownsVersion) {
          delete data.autohdrVersionUuid;
          delete data.sourceUrl;
        }
        // Oct 22 2026: a photo already on the listing beside the new visit is
        // ON_LISTING (Delivered); once it is part of the delivery again (the
        // visit delivered, or a hand-added copy gone from the listing) it is
        // ACTIVE again, or EXCLUDED when a person had left it out.
        let status: string | null = null;
        if (e.onListing) {
          if (prev.status === "ACTIVE" || prev.status === "GONE" || (prev.status === "EXCLUDED" && !!e.byHand)) status = ON_LISTING;
        } else if (prev.status === "GONE") status = "ACTIVE";
        else if (prev.status === ON_LISTING) status = e.sourceKind === "AUTOHDR" && prev.excludeReason ? "EXCLUDED" : "ACTIVE";
        if (status) {
          data.status = status;
          if (status === "ACTIVE") revived.push(prev.id);
        }
        // The listing image a photo of the new visit is (added by hand), recorded once: the date and the file it was seen as.
        if (e.byHand && !(await prisma.photoVersion.findFirst({ where: { photoId: prev.id, contentHash: e.byHand.contentHash }, select: { id: true } }))) {
          await prisma.photoVersion.create({ data: { photoId: prev.id, label: `${BY_HAND_LABEL}: ${e.byHand.name}`.slice(0, 200), source: "EDITOR", contentHash: e.byHand.contentHash } });
          handNotes.push(`${prev.name} is already on the Aryeo listing as ${e.byHand.name} (added by hand): shown as delivered, never sent again`);
        }
        // Oct 21 2026: the hub's own edit (straighten, crop) stays the photo while the listing still shows the file it was made from.
        const hubKeeps = !ownsVersion && !!prev.contentHash?.startsWith("hub-") && (await import("./photoEdit").then((m) => m.hubEditStillOn(prev, e.contentHash)).catch(() => false));
        if (prev.sourceKind === "UPLOAD" && e.sourceKind === "ARYEO" && prev.contentHash !== e.contentHash) {
          // Oct 22 2026: a photo added by hand, now on the listing (the hub sent it): the same file, so the same findings and checks.
          const marks = await prisma.photoAsset.findUnique({ where: { id: prev.id }, select: { inspectedHash: true, classifiedHash: true } });
          data.contentHash = e.contentHash;
          if (prev.contentHash && marks?.inspectedHash === prev.contentHash) data.inspectedHash = e.contentHash;
          if (prev.contentHash && marks?.classifiedHash === prev.contentHash) data.classifiedHash = e.contentHash;
          if (prev.contentHash) await prisma.photoQcFinding.updateMany({ where: { photoId: prev.id, contentHash: prev.contentHash }, data: { contentHash: e.contentHash } });
          await prisma.photoVersion.create({ data: { photoId: prev.id, label: "On the Aryeo listing (sent by the hub)", source: "HUB_EDIT_LISTED", contentHash: e.contentHash, bytes: e.bytes ?? undefined } });
        } else if (!ownsVersion && !hubKeeps && prev.contentHash !== e.contentHash) {
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
    // (Oct 22 2026: so is a photo kept as delivered that left the listing.)
    // (Oct 22 2026: a photo added by hand is not in any source's gallery until the hub sends it: never GONE for that.)
    const gone = existing.filter((e) => !seen.has(e.name) && e.sourceKind !== "UPLOAD" && (e.status === "ACTIVE" || e.status === ON_LISTING)).map((e) => e.id);
    if (gone.length) await prisma.photoAsset.updateMany({ where: { id: { in: gone } }, data: { status: "GONE" } });
    // A photo back in the gallery gets back the open findings it had when it left.
    if (revived.length) await prisma.photoQcFinding.updateMany({ where: { jobId, photoId: { in: revived }, status: "SUPERSEDED", statusReason: { in: [GONE_REASON, ON_LISTING_REASON] } }, data: { status: "OPEN", statusReason: null } });
    for (const line of handNotes) await logJobEvent(jobId, "sync", line);
    // Oct 15 2026: new photos on a job already linked to its AutoHDR shoot (a
    // listing replaced after delivery, "<Street> (N of M)") are matched to
    // AutoHDR's photos (a free read), so the free check can look at them.
    if (addedToDelivery > 0 && job.autohdrPhotoshootId && (await prisma.photoAsset.count({ where: { jobId, status: "ACTIVE", autohdrImageUuid: null } }))) {
      const { linkAutohdrShoot } = await import("./autohdrLink");
      await linkAutohdrShoot(jobId).catch((e) => console.warn("photo delivery: relink failed", jobId, (e as Error).message));
    }
    await prisma.photoJob.update({
      where: { id: jobId },
      data: { finalsPath: source === "dropbox" ? folder : null, finalsFingerprint: fp, finalsCount: entries.length, finalsChangedAt: now, finalsStableAt: null, lastError: null },
    });
    await logJobEvent(jobId, "sync", `gallery changed (${source}): ${entries.length} photo${entries.length === 1 ? "" : "s"}`, { added, gone: gone.length });
    // A photo already delivered on the listing is never a reason to check again (Oct 22 2026).
    if (["QC_REVIEW", "READY", "FIXING", "ON_HOLD"].includes(job.stage) && (addedToDelivery > 0 || existing.some((e) => e.sourceKind !== "AUTOHDR" && e.status !== ON_LISTING && entries!.some((x) => !x.onListing && x.name === e.name && x.contentHash !== e.contentHash)))) {
      // Oct 14 2026: with the paid QC on request only, the free photo check
      // re-runs on a QC_REVIEW or READY job whose gallery changed after its
      // last check (finalsChangedAt, autohdrCheck.ts); the paid QC only when
      // it runs by itself.
      if ((await photoDeliverySettings()).paidQcAuto) {
        await prisma.photoJob.update({ where: { id: jobId }, data: { qcRequestedAt: now } });
        await logJobEvent(jobId, "sync", "re-QC requested: the gallery changed after QC");
      }
    }
  } else if (!job.finalsStableAt && entries.length > 0) {
    await prisma.photoJob.update({ where: { id: jobId }, data: { finalsStableAt: now, lastError: null } });
  }
  // Oct 15 2026: a delivered job whose listing was replaced before the match
  // above existed (2236 Gregory Dr) is matched on its next delivered pass
  // (every 6 hours, while AutoHDR still has the shoot), so the free check
  // after delivery can look at the new photos.
  if (!changed && job.stage === "DELIVERED" && job.autohdrPhotoshootId && job.autohdrCreatedAt && now.getTime() - job.autohdrCreatedAt.getTime() < 7 * 24 * 60 * MIN && (await prisma.photoAsset.count({ where: { jobId, status: "ACTIVE", autohdrImageUuid: null } }))) {
    const { linkAutohdrShoot } = await import("./autohdrLink");
    await linkAutohdrShoot(jobId).catch((e) => console.warn("photo delivery: relink failed", jobId, (e as Error).message));
  }

  // Oct 22 2026: a photo already delivered on the listing was checked when it
  // went out; an open finding on it never counts against the new visit (set
  // aside, and given back if it joins the delivery again).
  const listedIds = (await prisma.photoAsset.findMany({ where: { jobId, status: ON_LISTING }, select: { id: true } })).map((p) => p.id);
  if (listedIds.length) {
    const r = await prisma.photoQcFinding.updateMany({ where: { jobId, status: "OPEN", photoId: { in: listedIds } }, data: { status: "SUPERSEDED", statusReason: ON_LISTING_REASON } });
    if (r.count) await logJobEvent(jobId, "sync", `${r.count} open finding${r.count === 1 ? "" : "s"} set aside: the photo${r.count === 1 ? " is" : "s are"} already delivered on the Aryeo listing`);
  }

  // A split job's new visit: out of the earlier visit's delivery, into the
  // normal flow (EDITING → EDITED → free check → Kyle's approval).
  if (newVisit && ["DELIVERING", "DELIVERY_MISMATCH", "DELIVERED"].includes(job.stage)) {
    const earlier = await prisma.photoAsset.count({ where: { jobId, status: ON_LISTING } });
    await setStage(jobId, ["DELIVERING", "DELIVERY_MISMATCH", "DELIVERED"], "EDITING", "sync", {
      why: `a new visit: ${hubNew.length} photo${hubNew.length === 1 ? "" : "s"} back from AutoHDR. The ${earlier} already on the listing stay there, shown as delivered beside these`,
      // Photo audit H3 (Oct 22 2026): the earlier visit's delivery date is kept on this line before the new visit's round clears it.
      data: job.deliveredAt ? { earlierVisitDeliveredAt: job.deliveredAt.toISOString() } : undefined,
      extra: { deliveryDiffJson: null, deliveryCheckNote: null, deliveredAt: null, deliveredBy: null },
    });
  }

  if (awaitingVisit) {
    const visitDay = visits.start ? visits.start.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : "the latest visit";
    const why = `split job: waiting for the photos from ${visitDay}; the listing's delivery is the earlier visit's`;
    const cur = (await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } }))?.stage ?? job.stage;
    if (["DELIVERING", "DELIVERY_MISMATCH", "DELIVERED"].includes(cur)) {
      await setStage(jobId, ["DELIVERING", "DELIVERY_MISMATCH", "DELIVERED"], "EDITING", "sync", { why, data: job.deliveredAt ? { earlierVisitDeliveredAt: job.deliveredAt.toISOString() } : undefined, extra: { deliveryDiffJson: null, deliveryCheckNote: null, deliveredAt: null, deliveredBy: null } });
    } else if (!(await prisma.photoJobEvent.count({ where: { jobId, action: why } }))) {
      await logJobEvent(jobId, "sync", why);
    }
    await prisma.photoJob.update({ where: { id: jobId }, data: { nextCheckAt: new Date(now.getTime() + 15 * MIN) } });
    return { changed, count: entries?.length ?? null, stage: "EDITING", source: "waiting-for-visit" };
  }

  // EDITING → EDITED once the gallery has landed and stopped changing.
  const fresh = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, finalsChangedAt: true, finalsCount: true } });
  let stage = fresh?.stage ?? job.stage;
  if (stage === "EDITING" && (fresh?.finalsCount ?? 0) > 0 && fresh?.finalsChangedAt && now.getTime() - fresh.finalsChangedAt.getTime() >= FINALS_SETTLE_MS) {
    const landed = newVisit ? hubNew.length : fresh.finalsCount;
    if (await setStage(jobId, ["EDITING"], "EDITED", "sync", { why: `${landed} edited photos ${source === "dropbox" ? "in the finals folder" : source === "autohdr" ? "back from AutoHDR" : "on the Aryeo listing"}, stable` })) stage = "EDITED";
  }

  // Delivered (Kyle pressed Deliver in Aryeo): verify against the QC'd set.
  // Only the listing's own delivery_status says so: Project.deliveredAt can be
  // the hub's guess from the status sweep, before Aryeo has delivered.
  const deliveredOnAryeo = listing?.deliveryStatus === "DELIVERED";
  // Oct 22 2026 (photo audit C1): Aryeo's "delivered" is sticky: after the
  // first delivery it says so for ever. A job reopened for a client's revision
  // (REVISION_REQUESTED, or any stage after it while the job keeps its first
  // delivery date) never takes it as the revision being delivered: 615 Cliff
  // Ln's lamp request was closed by this sync at 5:48 PM. The revision leaves
  // only by Approve and deliver again or Mark as delivering (both move it to
  // Delivering first, verified below), or Settled with the client.
  const inRevision = stage === "REVISION_REQUESTED" || (!!job.deliveredAt && stage !== "DELIVERING");
  // A new visit not on the listing yet: the listing's "delivered" is the earlier visit's.
  if (deliveredOnAryeo && !newVisit && !inRevision && !["DELIVERED", "DELIVERY_MISMATCH"].includes(stage)) {
    const from: JobStage[] = ["EDITING", "EDITED", "QC_RUNNING", "QC_REVIEW", "FIXING", "ON_HOLD", "READY", "DELIVERING", "EDIT_FAILED"];
    // Oct 22 2026 (photo audit H2): delivered in Aryeo itself (past the hub)
    // while the checklist still held the photos: Jordan and Kyle hear it once,
    // and the holds (the client's requests, the add-on work) stay OPEN on the
    // job for a person to settle; the hub never closes them for it.
    if (stage !== "DELIVERING") await alertDeliveredWithHolds(jobId, project.title).catch((e) => console.warn("photo delivery: holds alert failed", jobId, (e as Error).message));
    if (stage !== "DELIVERING") await setStage(jobId, from, "DELIVERING", "sync", { why: "delivered in Aryeo", extra: { deliveryStartedAt: now } });
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

  // Oct 15 2026: an open finding on a photo that left the gallery never counts
  // or shows (set aside, and given back if the photo returns).
  const goneIds = (await prisma.photoAsset.findMany({ where: { jobId, status: "GONE" }, select: { id: true } })).map((p) => p.id);
  if (goneIds.length) {
    const r = await prisma.photoQcFinding.updateMany({ where: { jobId, status: "OPEN", photoId: { in: goneIds } }, data: { status: "SUPERSEDED", statusReason: GONE_REASON } });
    if (r.count) await logJobEvent(jobId, "sync", `${r.count} open finding${r.count === 1 ? "" : "s"} set aside: the photo${r.count === 1 ? " is" : "s are"} no longer in the gallery`);
  }

  const next = stage === "EDITING" ? 5 * MIN : stage === "DELIVERED" ? 6 * 60 * MIN : 15 * MIN;
  await prisma.photoJob.update({ where: { id: jobId }, data: { nextCheckAt: new Date(now.getTime() + next) } });
  // A split job's new visit: the count read is that visit's (the gallery also holds the listing's photos).
  return { changed, count: newVisit ? hubNew.length : entries.length, stage, source };
}

/** The job event alertDeliveredWithHolds writes (once per set of open holds). */
export const DELIVERED_WITH_HOLDS_ACTION = "delivered in Aryeo with holds still open";

/**
 * Oct 22 2026 (photo audit H2): the listing was delivered in Aryeo (not by the
 * hub's checked delivery) while hold lines were open on the checklist (what the
 * client asked, the add-on work, the wrap-up). 11 of 23 holding asks in two
 * weeks were then closed by the hub, not a person; 58 Recreation Dr went out
 * with "Lot Lines needed" open. Now: one alert to Jordan and Kyle (the bell
 * and their Slack DM, alertOwnerAndKyle; deduped per job and per set of holds)
 * and one line on the job's activity. The holds stay open. Returns how many.
 */
export async function alertDeliveredWithHolds(jobId: string, title: string | null): Promise<number> {
  const { deliveryGate } = await import("./delivery");
  const gate = await deliveryGate(jobId, { sync: false });
  const open = gate.checks.filter((c) => c.hold && !c.ok && !c.advisory);
  if (!open.length) return 0;
  const keys = open.map((c) => c.key).sort().join("|");
  const words = open.map((c) => c.label.replace(/\.$/, "")).join("; ");
  const street = (title ?? "A job").split(",")[0];
  if (!(await prisma.photoJobEvent.count({ where: { jobId, action: { startsWith: DELIVERED_WITH_HOLDS_ACTION }, dataJson: { contains: JSON.stringify(keys) } } }))) {
    await logJobEvent(jobId, "sync", `${DELIVERED_WITH_HOLDS_ACTION}: ${words}. They stay open until a person settles each one`, { keys });
  }
  const { alertOwnerAndKyle } = await import("./notifyOps");
  const { appBase } = await import("@/lib/appUrl");
  await alertOwnerAndKyle({
    kind: "photo_delivered_with_holds",
    title: `${street}: delivered in Aryeo with ${open.length} hold${open.length === 1 ? "" : "s"} open`,
    body: words.slice(0, 140),
    href: `/ops/photo-delivery/${jobId}`,
    dedupeKey: `pd-delivered-holds-${jobId}-${createHash("sha256").update(keys).digest("hex").slice(0, 12)}`,
    text: `${street}: the photos were delivered in Aryeo while the checklist still held them (${words}). Nothing was closed: settle each one on the job. ${appBase()}/ops/photo-delivery/${jobId}`,
    to: "both",
  });
  return open.length;
}

/**
 * The file names the hub gave this job's photos on their way to the listing
 * (06-Ready-for-Aryeo and the push), lower case: a listing image with one of
 * them is the hub's upload, never something already there (Oct 22 2026).
 */
async function listingNamesOfHub(jobId: string): Promise<Set<string>> {
  const [ready, pushed] = await Promise.all([
    import("./handoff").then((m) => m.readyNamesFor(jobId)).catch(() => new Map<string, string>()),
    import("./aryeoPush").then((m) => m.pushedNames(jobId)).catch(() => new Map<string, string>()),
  ]);
  return new Set([...ready.keys(), ...pushed.keys()]);
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
