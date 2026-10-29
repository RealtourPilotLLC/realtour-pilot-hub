import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { photoDeliverySettings, type AryeoPushMode } from "./settings";
import { logJobEvent } from "./jobState";
import { closeMediaCheckForPhotos } from "./mediaCheck";
import { UPLOAD_HELD_PREFIX, UPLOAD_OVERRIDE_MIN } from "./holding";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";
import { isTransientProviderError } from "@/lib/cronNoise";

// ---------------------------------------------------------------------------
// THE PHOTOS INTO ARYEO, BY THE HUB (Oct 14 2026).
//
// Jordan: "Is there any way to automate the file upload and delivery on
// Aryeo? There has to be." Then: "Ok cool let's do that" (staged: a test
// listing first, then Kyle approving each delivery, then automatic).
//
// A PUSH takes the finished 06-Ready-for-Aryeo folder (numbered in delivery
// order, every fix and restore in it) to the job's Aryeo listing through the
// hub's own Aryeo login (integrations/aryeoWeb.ts):
//   SENDING     each photo from the folder to Aryeo's upload service, a few
//               per pass (resumable; 3 tries each)
//   ADDING      one group of them, in order, put on the listing
//   CHECKING    the public API must show every one on the listing (Aryeo
//               processes uploads in the background; 20 minutes at most)
//   ORDERING    the listing's order must be the delivery order (set once)
//   then, by what was approved:
//     upload    DONE: Kyle delivers in Aryeo (or presses Deliver in Aryeo)
//     deliver   DELIVERING
//   DELIVERING  the delivery checklist must pass (a person's approval: the
//               same gate as Mark as delivering; the hub's own same-day
//               approval: every item really passes), then Aryeo's own Deliver
//               Listing; the public API must then say DELIVERED, and the usual
//               delivery check runs.
// WHO STARTS ONE (Oct 15, Jordan): nothing reaches Aryeo before Kyle approves
// the job ("Approve and deliver" / "Approve and upload to Aryeo", approveJob)
// once it is Ready to review. Two exceptions, both already decided: a job a
// person marked as delivering (or Jordan's override), and a same-day order
// whose every check passes (sameDayBlocker), which approves itself.
// Never doubled: a photo already on the listing (same file name) is not sent
// again; a listing that holds OTHER photos is left for a person (or "Send
// anyway"); one run per job at a time (compare-and-swap + a short lease).
// Never stale: the run keeps the folder's fingerprint (photos, order, each
// photo's version). A fix, restore or reorder after the photos went up stops
// the delivery; sending again replaces only the photos that changed (the
// run remembers what the hub put on the listing, so it can take its own
// old ones off) and the cron does that by itself in approve and auto.
// The run lives in AppSetting "photo_aryeo_push:<jobId>".
// RE-DELIVERY (Oct 22 2026, Jordan: "Yes, it should be re-delivered if we are
// sending new photos"): photos the hub adds to a listing that was ALREADY
// delivered (a split job's later visit beside the earlier visit's delivery)
// are written down on the run (addedSinceDelivery). The delivery after them
// presses Aryeo's Deliver again (Re-deliver, with the delivery email), so the
// agent gets the "your photos are ready" email for the new photos. Only when
// new photos really went on: a duplicate-only or nothing-to-send push, a
// changed photo swapped in place, and Update on Aryeo never re-deliver. The
// intent is saved before the call and never sent twice; it goes on the job.
// ---------------------------------------------------------------------------

const KEY = (jobId: string) => `photo_aryeo_push:${jobId}`;
const LEASE_MS = 45_000;
const MAX_TRIES = 3;
const CHECK_FOR_MS = 20 * 60_000;

export type PushItem = {
  photoId: string; name: string; path: string; uuid: string | null; tries: number; error: string | null; already: boolean; rev?: string | null;
  /** Oct 21 2026: Update on Aryeo sends the hub's edited file from its private store, not 06-Ready-for-Aryeo. */
  blob?: { pathname: string } | null;
  /**
   * Oct 22 2026 (the duplicate guard): the photo is already on the listing,
   * found by its listing id, its AutoHDR photo, a content hash or its own
   * file name; `name` is then that listing image's. Never sent, never taken
   * off (the hub did not put it there).
   */
  matched?: "listing id" | "AutoHDR photo" | "content hash" | "file name" | null;
};
/** A photo the hub put on the listing: which photo, and which version of it. */
type Listed = { name: string; photoId: string; rev: string | null };
export type PushState = "PREPARING" | "SENDING" | "ADDING" | "CHECKING" | "ORDERING" | "WAITING" | "DELIVERING" | "CONFIRMING" | "DONE" | "FAILED";
export type PushRun = {
  id: string;
  listingId: string;
  state: PushState;
  /** What happens after the photos are on the listing. */
  then: "stop" | "approval" | "deliver";
  items: PushItem[];
  groupId: string | null;
  addedAt: string | null;
  ordered: boolean;
  deliveredAt: string | null;
  by: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  note: string | null;
  lease: { token: string; until: number } | null;
  /** Send even when the listing holds other photos (a person's "Send anyway"). */
  anyway?: boolean;
  /** When the add call went to Aryeo (never sent twice). */
  addSentAt?: string | null;
  /** The 06-Ready-for-Aryeo fingerprint these photos came from (readyFingerprintFor). */
  fingerprint?: string | null;
  /** What the hub has put on the listing (kept from run to run). */
  listed?: Listed[];
  /** The hub's own photos on the listing that changed or left the set: taken off first. */
  remove?: string[];
  removedAt?: string | null;
  /** A refusal the cron noted, or a sign-in that failed: tried again after this, not every five minutes. */
  retryAfter?: string | null;
  /** The person who approved it (their delivery uses the usual gate). Null: the hub's own (same-day, or a job already marked as delivering). */
  approvedBy?: string | null;
  /** Oct 21 2026: "update" = Update on Aryeo, replacing photos the hub edited on a listing (requestListingUpdate). */
  mode?: "update";
  /** Update: the listing images being replaced (taken off before the new ones go on). */
  replaceIds?: string[];
  /** Update: the listing's order before it (lower-case names), kept after. */
  keepOrder?: string[];
  /** Update: the job's run before it, as JSON text (a string, so the cron's text filters never read its state), put back when it ends. */
  prev?: string | null;
  /**
   * Oct 22 2026 (615 Cliff Ln): a split job. The listing already holds the
   * earlier visit's photos (ON_LISTING): they stay where they are, in their
   * order with the cover first, and this delivery's photos go after them.
   */
  split?: boolean;
  /** Split: the listing images already there when the run was built (lower-case names, in the listing's order). */
  keptOrder?: string[];
  /** The listing images the hub must never take off (already there, or matched by the duplicate guard): their ids. */
  keepIds?: string[];
  /** Photos on the listing twice when the run checked it (each: the images' names). Flagged for Kyle, never deleted. */
  duplicates?: string[][];
  /**
   * Oct 22 2026: the photos (ids) the hub put on the listing while it was
   * already delivered, not re-delivered yet. Carried from run to run until a
   * delivery re-delivers them (then emptied).
   */
  addedSinceDelivery?: string[];
  /** How the re-delivery of those photos ended: sent, refused by Aryeo (Deliver in Aryeo tries again), or uncertain (never sent again). The claim itself is its own record (REDELIVER_KEY). */
  redelivery?: Redelivery | null;
};
export type Redelivery = { state: "sent" | "refused" | "uncertain"; at: string; photos: number; note: string | null };
export type PushProgress = {
  state: PushState; active: boolean; total: number; sent: number; already: number; note: string | null; startedAt: string; finishedAt: string | null; deliveredAt: string | null; waitingForApproval: boolean; changed: boolean; update?: boolean;
  /** Oct 22 2026: a split job: the photos already on the listing, kept first. */
  kept?: number;
  /** Photos the duplicate guard found on the listing already (never sent). */
  matched?: number;
  /** Photos on the listing twice when it was checked (the images' names). */
  duplicates?: string[][];
  /** Oct 22 2026: new photos on an already delivered listing, and their re-delivery. Null when neither. */
  redeliver?: { pending: number; state: Redelivery["state"] | null; at: string | null; photos: number; note: string | null } | null;
};

// ---- the run record ---------------------------------------------------------------------------

async function load(jobId: string): Promise<{ run: PushRun | null; raw: string | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY(jobId) }, select: { value: true } });
  if (!row) return { run: null, raw: null };
  try {
    return { run: JSON.parse(row.value) as PushRun, raw: row.value };
  } catch {
    return { run: null, raw: row.value };
  }
}

async function save(jobId: string, run: PushRun, prevRaw: string | null): Promise<string | null> {
  const value = JSON.stringify({ ...run, updatedAt: new Date().toISOString() });
  if (prevRaw == null) {
    try {
      await prisma.appSetting.create({ data: { key: KEY(jobId), value, updatedBy: "aryeo-push" } });
      return value;
    } catch {
      return null;
    }
  }
  const r = await prisma.appSetting.updateMany({ where: { key: KEY(jobId), value: prevRaw }, data: { value, updatedBy: "aryeo-push" } });
  return r.count === 1 ? value : null;
}

const ACTIVE: PushState[] = ["PREPARING", "SENDING", "ADDING", "CHECKING", "ORDERING", "DELIVERING", "CONFIRMING"];

export function progressOf(run: PushRun): PushProgress {
  return {
    state: run.state,
    active: ACTIVE.includes(run.state),
    total: run.items.length,
    sent: run.items.filter((i) => i.uuid || i.already).length,
    already: run.items.filter((i) => i.already).length,
    note: run.note,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    deliveredAt: run.deliveredAt,
    waitingForApproval: run.state === "WAITING",
    changed: run.note === CHANGED,
    update: run.mode === "update",
    kept: run.split ? run.keptOrder?.length ?? 0 : 0,
    matched: run.items.filter((i) => i.matched).length,
    duplicates: run.duplicates ?? [],
    redeliver: run.addedSinceDelivery?.length || run.redelivery
      ? { pending: run.addedSinceDelivery?.length ?? 0, state: run.redelivery?.state ?? null, at: run.redelivery?.at ?? null, photos: run.redelivery?.photos ?? 0, note: run.redelivery?.note ?? null }
      : null,
  };
}

/**
 * The photos of this add that are NEW to a listing that was already delivered
 * (Oct 22 2026): every one the hub sends now that it had not put there before
 * (a changed photo swapped in place is not new), added to the ones still
 * waiting for a re-delivery.
 */
function newOnDelivered(r: PushRun, sent: PushItem[]): string[] {
  const before = new Set((r.listed ?? []).map((l) => l.photoId));
  return [...new Set([...(r.addedSinceDelivery ?? []), ...sent.filter((i) => !i.matched && !before.has(i.photoId)).map((i) => i.photoId)])];
}

export async function pushProgress(jobId: string): Promise<PushProgress | null> {
  const { run } = await load(jobId);
  return run ? progressOf(run) : null;
}

// ---- starting one -------------------------------------------------------------------------------

const lower = (s: string) => s.toLowerCase();

/**
 * Start a push for a job. `then` defaults to what the settings' stage says.
 * `anyway` sends even when the listing already holds other photos.
 */
/**
 * The photos to send, from the finished 06-Ready-for-Aryeo folder, checked
 * against what the listing already holds. `wait` = the folder is not ready yet.
 */
type Built = { items: PushItem[]; remove: string[]; fingerprint: string; split: boolean; keptOrder: string[]; keepIds: string[]; kept: number };
async function buildItems(jobId: string, listingId: string, anyway: boolean, listed: Listed[] = []): Promise<Built | { wait: string } | { error: string }> {
  const { deliveryOrderFor } = await import("./delivery");
  const { readyFolderState, readyFingerprintFor } = await import("./handoff");
  const order = await deliveryOrderFor(jobId);
  if (!order.length) return { error: "No photos are in the delivery yet." };
  const rs = await readyFolderState(jobId, order.length);
  if (!rs || rs.preparing) return { wait: rs?.preparing ? `Getting the photos ready first: ${rs.files} of ${rs.total} copied to 06-Ready-for-Aryeo.` : "Getting the photos ready first (06-Ready-for-Aryeo)." };
  if (!rs.ready) return rs.failed ? { error: `06-Ready-for-Aryeo could not be filled (${rs.failed} photo${rs.failed === 1 ? "" : "s"} failed${rs.note ? `: ${rs.note}` : ""}). Press Get them ready again, then Send to Aryeo.` } : { wait: `Getting the photos ready first: ${rs.files} of ${order.length} in 06-Ready-for-Aryeo.` };
  // The folder must hold today's photos: a fix, restore or reorder since it was filled refills it first.
  const [fingerprint, folderRun] = await Promise.all([readyFingerprintFor(jobId), readyRunFingerprint(jobId)]);
  if (folderRun && folderRun !== fingerprint) return { wait: "The photos changed since 06-Ready-for-Aryeo was filled: bringing it up to date first." };
  const { listingGallery } = await import("./jobs");
  const listing = await listingGallery(listingId);
  if (!listing) return { wait: "The Aryeo listing could not be read just now; trying again." };
  const { keptOnListing, keptOwner, sameFile } = await import("./listingMatch");
  const [rows, kept] = await Promise.all([
    prisma.photoAsset.findMany({
      where: { id: { in: order.map((o) => o.photoId) } },
      select: { id: true, name: true, sourceKind: true, sourceRef: true, autohdrImageUuid: true, autohdrVersionUuid: true, contentHash: true },
    }),
    keptOnListing(jobId),
  ]);
  const rowById = new Map(rows.map((p) => [p.id, p]));
  const revs = new Map(rows.map((p) => [p.id, p.autohdrVersionUuid ?? p.contentHash ?? null]));
  const want = new Map(order.map((o) => [lower(o.deliveryName), { photoId: o.photoId, rev: revs.get(o.photoId) ?? null }]));
  const ours = new Map(listed.map((l) => [lower(l.name), l]));
  // THE DUPLICATE GUARD (Oct 22 2026, Jordan: "make sure there are no
  // duplicates in Aryeo"). Before anything is sent, each photo is looked for
  // on the listing: its own listing image (a photo read from the listing),
  // the listing image of the same AutoHDR photo (a row carried over), an
  // image with its current content hash, or, last, an image with its own file
  // name (Kyle's hand-added DSC07999). A photo found is never sent again, and
  // the hub never takes that image off.
  const uuids = rows.map((p) => p.autohdrImageUuid).filter((u): u is string => !!u);
  const carried = uuids.length
    ? await prisma.photoAsset.findMany({ where: { jobId, sourceKind: "ARYEO", sourceRef: { not: null }, autohdrImageUuid: { in: uuids } }, select: { id: true, autohdrImageUuid: true, sourceRef: true } })
    : [];
  const hubNames = new Set([...want.keys(), ...ours.keys()]);
  // Oct 22 2026 (615 Cliff Ln): on a split job the earlier visit's photos are
  // expected on the listing: they stay, in their order, and never need Send anyway.
  const isKept = (e: GalleryEntryLike) => !!keptOwner(kept, e);
  const claimed = new Set<GalleryEntryLike>();
  const matchOf = new Map<string, { entry: GalleryEntryLike; by: NonNullable<PushItem["matched"]> }>();
  for (const o of order) {
    const p = rowById.get(o.photoId);
    if (!p) continue;
    const free = listing.entries.filter((e) => !claimed.has(e));
    // The photo's CURRENT file only: an older version on the listing is a different file (a person decides, as before).
    const hashes = new Set([p.contentHash].filter((h): h is string => !!h));
    const carriedRefs = new Set(carried.filter((c) => c.id !== p.id && c.autohdrImageUuid === p.autohdrImageUuid).map((c) => c.sourceRef!));
    let m: { entry: GalleryEntryLike; by: NonNullable<PushItem["matched"]> } | null = null;
    // Its own listing image, only while that image is still the photo's current version (a fix or a
    // hub edit since is a different file: that one is left to a person, as before).
    const byRef = p.sourceKind === "ARYEO" && p.sourceRef ? free.find((e) => e.sourceRef === p.sourceRef && e.contentHash === p.contentHash) : undefined;
    if (byRef) m = { entry: byRef, by: "listing id" };
    const byUuid = !m && carriedRefs.size ? free.find((e) => !!e.sourceRef && carriedRefs.has(e.sourceRef)) : undefined;
    if (byUuid) m = { entry: byUuid, by: "AutoHDR photo" };
    const byHash = !m ? free.find((e) => hashes.has(e.contentHash)) : undefined;
    if (byHash) m = { entry: byHash, by: "content hash" };
    // Never against the earlier visit's own photos (two cameras can both make a DSC05123).
    const byFile = !m ? free.find((e) => !hubNames.has(lower(e.name)) && !isKept(e) && sameFile(e.name, p.name)) : undefined;
    if (byFile) m = { entry: byFile, by: "file name" };
    if (m) {
      claimed.add(m.entry);
      matchOf.set(o.photoId, m);
    }
  }
  const onListing = new Set<string>();
  const remove: string[] = [];
  const others: string[] = [];
  for (const e of listing.entries) {
    if (claimed.has(e) || isKept(e)) continue;
    const n = lower(e.name);
    const w = want.get(n);
    const mine = ours.get(n);
    // The hub's own photo under this name, but a different photo or version now: take it off, send the new one.
    if (mine && (!w || mine.photoId !== w.photoId || (mine.rev && w.rev && mine.rev !== w.rev))) remove.push(n);
    else if (w) onListing.add(n);
    else others.push(e.name);
  }
  if (others.length && !anyway) {
    return { error: `The listing already has ${others.length} photo${others.length === 1 ? "" : "s"} that ${others.length === 1 ? "is" : "are"} not from 06-Ready-for-Aryeo (${others.slice(0, 3).join(", ")}${others.length > 3 ? "…" : ""}). Remove ${others.length === 1 ? "it" : "them"} in Aryeo first, or press Send anyway to add these next to ${others.length === 1 ? "it" : "them"}.` };
  }
  const split = kept.length > 0;
  const sending = new Set(order.filter((o) => !matchOf.has(o.photoId)).map((o) => lower(o.deliveryName)));
  return {
    fingerprint,
    remove,
    split,
    // What stays ahead of this delivery on a split job: everything on the listing but the hub's own new photos, as it is ordered now.
    keptOrder: split ? listing.entries.map((e) => lower(e.name)).filter((n) => !sending.has(n)) : [],
    keepIds: [...listing.entries.filter((e) => claimed.has(e) || isKept(e)).map((e) => e.sourceRef).filter((x): x is string => !!x)],
    kept: listing.entries.filter((e) => isKept(e)).length,
    items: order.map((o) => {
      const m = matchOf.get(o.photoId);
      return m
        ? { photoId: o.photoId, name: m.entry.name, path: "", uuid: null, tries: 0, error: null, already: true, rev: revs.get(o.photoId) ?? null, matched: m.by }
        : { photoId: o.photoId, name: o.deliveryName, path: `${rs.folder}/${o.deliveryName}`, uuid: null, tries: 0, error: null, already: onListing.has(lower(o.deliveryName)), rev: revs.get(o.photoId) ?? null };
    }),
  };
}

/** A listing image as the push reads it (jobs.ts GalleryEntry). */
type GalleryEntryLike = { name: string; sourceRef: string | null; contentHash: string };

/**
 * The listing as a whole, after a push: any photo of the job on it twice
 * (two images that are the same photo: its listing id, the listing image a
 * photo added by hand was seen as, or the name this run gave it), or two
 * images with the same file name (Oct 22 2026).
 */
async function duplicatesOnListing(jobId: string, entries: GalleryEntryLike[], r: PushRun): Promise<{ key: string; names: string[] }[]> {
  const { BY_HAND_LABEL, listingDuplicates } = await import("./listingMatch");
  const rows = await prisma.photoAsset.findMany({
    where: { jobId, status: { not: "GONE" } },
    select: { id: true, sourceKind: true, sourceRef: true, versions: { where: { source: "EDITOR", label: { startsWith: BY_HAND_LABEL } }, select: { contentHash: true } } },
  });
  const byRef = new Map(rows.filter((p) => p.sourceKind === "ARYEO" && p.sourceRef).map((p) => [p.sourceRef!, p.id]));
  const byHash = new Map(rows.flatMap((p) => p.versions.filter((v) => !!v.contentHash).map((v) => [v.contentHash!, p.id] as const)));
  const byName = new Map(r.items.map((i) => [lower(i.name), i.photoId]));
  return listingDuplicates(entries, (img) => (img.sourceRef ? byRef.get(img.sourceRef) : undefined) ?? byHash.get(img.contentHash) ?? byName.get(lower(img.name)) ?? null);
}

/** Kyle hears about a photo on the listing twice (once per job and set of names); the job page says it too. */
async function flagDuplicates(jobId: string, words: string): Promise<void> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  const project = job ? await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true } }) : null;
  const street = (project?.title ?? "this listing").split(",")[0];
  const { alertOwnerAndKyle } = await import("./notifyOps");
  const { appBase } = await import("@/lib/appUrl");
  await alertOwnerAndKyle({
    kind: "photo_delivery_duplicate",
    title: `Photo twice on the listing: ${street}`.slice(0, 90),
    body: `${words}. Take the extra copy off in Aryeo; the hub never deletes there.`.slice(0, 140),
    href: `/ops/photo-delivery/${jobId}`,
    dedupeKey: `pd-duplicate-${jobId}-${createHash("sha256").update(words).digest("hex").slice(0, 12)}`,
    text: `${street}: ${words} on the Aryeo listing. Take the extra copy off in Aryeo (the hub never deletes there). ${appBase()}/ops/photo-delivery/${jobId}`,
    to: "kyle",
  });
}

/**
 * The file names the hub gave this job's photos on the listing (its push run:
 * what it put there and what it is putting there), lower case → photo id. The
 * sync reads them so the hub's own upload is never mistaken for a photo
 * already on the listing (Oct 22 2026).
 */
export async function pushedNames(jobId: string): Promise<Map<string, string>> {
  const { run } = await load(jobId);
  const out = new Map<string, string>();
  if (!run || run.mode === "update") return out;
  for (const l of run.listed ?? []) out.set(lower(l.name), l.photoId);
  for (const i of run.items) if (!i.matched) out.set(lower(i.name), i.photoId);
  return out;
}

/** The fingerprint the last 06-Ready-for-Aryeo copy was made from (null when there is no record). */
async function readyRunFingerprint(jobId: string): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: `photo_ready_run:${jobId}` }, select: { value: true } });
  try {
    return row ? ((JSON.parse(row.value) as { fingerprint?: string }).fingerprint ?? null) : null;
  } catch {
    return null;
  }
}

const CHANGED = "The photos changed after they went on the listing (a fix, a restore or a new order). Approve again to update the listing.";

/** Did the photos change since this run put them on the listing? */
async function changedSince(jobId: string, run: PushRun): Promise<boolean> {
  if (!run.fingerprint) return false;
  const { readyFingerprintFor } = await import("./handoff");
  return (await readyFingerprintFor(jobId)) !== run.fingerprint;
}

/**
 * Start a push for a job. `then` defaults to what the settings' stage says.
 * `anyway` sends even when the listing already holds other photos. When the
 * 06-Ready-for-Aryeo folder is not finished, it is made first (the push waits
 * for it): a job marked as delivering before its folder existed still goes.
 */
export async function requestPush(jobId: string, opts: { by?: string | null; then?: PushRun["then"]; anyway?: boolean; mode?: AryeoPushMode; approvedBy?: string | null } = {}): Promise<{ ok: boolean; started: boolean; message: string }> {
  const settings = await photoDeliverySettings();
  const mode = opts.mode ?? settings.aryeoPush;
  if (mode === "off") return { ok: false, started: false, message: "Sending to Aryeo is switched off (Photo Delivery settings)." };
  const { aryeoWebCredentials } = await import("@/lib/integrations/aryeoWeb");
  if (!(await aryeoWebCredentials())) return { ok: false, started: false, message: "The hub's Aryeo login is not set up yet. Jordan adds it on Connections → Aryeo hub login." };
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true, stage: true } });
  if (!job) return { ok: false, started: false, message: "That job no longer exists." };
  if (job.stage === "DELIVERED") return { ok: false, started: false, message: "This job is already delivered." };
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { aryeoListingId: true } });
  if (!project?.aryeoListingId) return { ok: false, started: false, message: "This job has no Aryeo listing linked yet, so there is nowhere to send the photos." };
  const { run, raw } = await load(jobId);
  if (run && ACTIVE.includes(run.state)) return { ok: true, started: false, message: "Already sending to Aryeo." };
  const listed = run?.listed ?? [];
  const built = await buildItems(jobId, project.aryeoListingId, opts.anyway === true, listed);
  if ("error" in built) return { ok: false, started: false, message: built.error };
  if ("wait" in built) {
    // The folder first: start it unless it is already being filled.
    const { requestReady, readyProgress } = await import("./handoff");
    const prog = await readyProgress(jobId).catch(() => null);
    if (!prog?.active) await requestReady(jobId, { force: true, by: opts.by ?? "aryeo-push" }).catch(() => null);
  }
  // A job already marked as delivering goes all the way; otherwise only what was asked.
  const then: PushRun["then"] = opts.then ?? (job.stage === "DELIVERING" ? "deliver" : "stop");
  const now = new Date().toISOString();
  const items = "items" in built ? built.items : [];
  const remove = "remove" in built ? built.remove : [];
  const all = items.length > 0 && items.every((i) => i.already) && !remove.length;
  const next: PushRun = {
    id: randomBytes(4).toString("hex"), listingId: project.aryeoListingId, state: "items" in built ? (all ? "CHECKING" : "SENDING") : "PREPARING", then, items, groupId: null,
    addedAt: all ? now : null, ordered: false, deliveredAt: null, by: opts.by ?? null, startedAt: now, updatedAt: now, finishedAt: null, note: "wait" in built ? built.wait : null, lease: null, anyway: opts.anyway === true,
    fingerprint: "fingerprint" in built ? built.fingerprint : null, listed, remove, removedAt: null, approvedBy: opts.approvedBy ?? null,
    // Photos put on the delivered listing earlier and not re-delivered yet stay owed a re-delivery (Oct 22 2026).
    addedSinceDelivery: run?.addedSinceDelivery ?? [],
    ...("items" in built ? builtExtras(built) : {}),
  };
  if (!(await save(jobId, next, raw))) return { ok: false, started: false, message: "Someone started it a moment ago." };
  const already = items.filter((i) => i.already).length;
  const tail = then === "deliver" ? ", then delivering" : then === "approval" ? ", then waiting for Deliver in Aryeo" : ", then Kyle delivers";
  if (next.state === "PREPARING") {
    await logJobEvent(jobId, opts.by ?? "aryeo-push", `sending to the Aryeo listing${tail}: getting 06-Ready-for-Aryeo ready first`);
    return { ok: true, started: true, message: "Getting the photos ready in 06-Ready-for-Aryeo first, then sending them to the Aryeo listing. The panel shows the progress." };
  }
  const swap = remove.length ? `, taking ${remove.length} old one${remove.length === 1 ? "" : "s"} off first` : "";
  const besideWords = "items" in built ? keptWords(built) : "";
  await logJobEvent(jobId, opts.by ?? "aryeo-push", `sending ${items.length - already} photo${items.length - already === 1 ? "" : "s"} to the Aryeo listing${already ? ` (${already} already there)` : ""}${swap}${tail}${besideWords}`, matchedData(items));
  return { ok: true, started: true, message: all ? "Every photo is already on the listing. Checking the order." : `Sending ${items.length - already} photo${items.length - already === 1 ? "" : "s"} to the Aryeo listing${swap}.${besideWords ? ` ${besideWords[2].toUpperCase()}${besideWords.slice(3)}.` : ""} The panel shows the progress.` };
}

/** The split-job fields of a built run (Oct 22 2026). */
function builtExtras(b: Built): Partial<PushRun> {
  return { split: b.split, keptOrder: b.keptOrder, keepIds: b.keepIds };
}

/** "; the 24 already on the listing stay first, in their order; 1 found there already by file name is not sent again" (Oct 22 2026). Empty when neither. */
function keptWords(b: Built): string {
  const matched = b.items.filter((i) => i.matched);
  const parts = [
    b.split && b.kept ? `the ${b.kept} already on the listing stay first, in their order` : null,
    matched.length ? `${matched.length} found on the listing already (${matched.slice(0, 3).map((i) => `${i.name}, by ${i.matched}`).join("; ")}${matched.length > 3 ? "; …" : ""}) ${matched.length === 1 ? "is" : "are"} not sent again` : null,
  ].filter(Boolean);
  return parts.length ? `; ${parts.join("; ")}` : "";
}

/** Which photos the duplicate guard found on the listing, for the job's history. */
function matchedData(items: PushItem[]): Record<string, unknown> | undefined {
  const m = items.filter((i) => i.matched);
  return m.length ? { matched: m.map((i) => ({ photoId: i.photoId, listingName: i.name, by: i.matched })) } : undefined;
}

// ---- Update on Aryeo (Oct 21 2026) ------------------------------------------------------------
//
// Kyle straightened or cropped a photo in the hub (photoEdit.ts) that already
// sits on the Aryeo listing: delivered, or a listing AutoHDR's own Aryeo link
// filled. One press replaces just those photos: the edited file goes up under
// the listing image's own name, the old image comes off, the listing keeps
// its order. Nothing is delivered again and no email is sent (the run stops
// at the order). It is a push run in update mode, so the usual lease, the
// progress poll and the cron move it on; when it ends the job's run from
// before is put back, so the Deliver panel is exactly as it was. Never
// automatic: only requestListingUpdate starts one, from a person's press.

const UPDATE_KEY = (jobId: string) => `photo_aryeo_update:${jobId}`;
export type ListingUpdateOutcome = { at: string; ok: boolean; note: string; photoIds: string[]; by: string | null };

/** The last Update on Aryeo of a job: when, which photos, and how it ended. */
export async function lastListingUpdate(jobId: string): Promise<ListingUpdateOutcome | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: UPDATE_KEY(jobId) }, select: { value: true } });
  try {
    return row ? (JSON.parse(row.value) as ListingUpdateOutcome) : null;
  } catch {
    return null;
  }
}

/** An edited file from the hub's private store. */
async function storedBytes(pathname: string): Promise<Buffer> {
  const { readDerivativeBytes } = await import("./blob");
  const b = await readDerivativeBytes({ pathname, url: "" }, 80 * 1024 * 1024);
  if (!b) throw new Error("the edited photo could not be read from the hub's store");
  return b;
}

/** Kyle's Update on Aryeo for photos whose current version is the hub's own edit. */
export async function requestListingUpdate(jobId: string, photoIds: string[], by: string): Promise<{ ok: boolean; started: boolean; message: string }> {
  const settings = await photoDeliverySettings();
  if (settings.aryeoPush === "off") return { ok: false, started: false, message: "The hub's Aryeo upload is switched off (Photo Delivery settings). Download the edited photo from the lightbox and replace it on the listing by hand." };
  const W = await import("@/lib/integrations/aryeoWeb");
  if (!(await W.aryeoWebCredentials())) return { ok: false, started: false, message: "The hub's Aryeo login is not set up yet. Jordan adds it on Connections → Aryeo hub login." };
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true, stage: true } });
  if (!job) return { ok: false, started: false, message: "That job no longer exists." };
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { aryeoListingId: true } });
  if (!project?.aryeoListingId) return { ok: false, started: false, message: "This job has no Aryeo listing linked, so there is nothing to update." };
  const { run, raw } = await load(jobId);
  if (run && ACTIVE.includes(run.state)) return { ok: false, started: false, message: "The hub is already working on this listing in Aryeo. Try again when it finishes." };
  const ids = [...new Set(photoIds.filter((x) => typeof x === "string"))].slice(0, 50);
  const photos = await prisma.photoAsset.findMany({ where: { id: { in: ids }, jobId }, select: { id: true, name: true, sourceKind: true, sourceRef: true, contentHash: true } });
  if (!photos.length || photos.length !== ids.length) return { ok: false, started: false, message: "Those photos are not on this job. Reload the page." };
  // The hub's own upload, not delivered yet, replaces a changed photo itself (Approve again).
  if (run && !run.deliveredAt && (run.state === "WAITING" || run.state === "DONE") && job.stage !== "DELIVERED" && photos.some((p) => run.listed?.some((l) => l.photoId === p.id))) {
    return { ok: false, started: false, message: "These photos went up with the hub's upload, which is not delivered yet: press Approve again in the Deliver panel and the upload replaces them." };
  }
  const { currentHubEdit } = await import("./photoEdit");
  const files = new Map<string, string>();
  for (const p of photos) {
    const cur = await currentHubEdit(p);
    if (!cur?.meta.file) return { ok: false, started: false, message: `${p.name} has no hub edit waiting to go on the listing. Save it in Straighten first.` };
    files.set(p.id, cur.meta.file.pathname);
  }
  let page: Awaited<ReturnType<typeof W.listingPage>>;
  try {
    page = await W.listingPage(project.aryeoListingId);
  } catch (e) {
    return { ok: false, started: false, message: `Aryeo could not be read: ${(e as Error).message.slice(0, 200)}` };
  }
  // Which listing image is each photo: its own (an Aryeo photo), else the names the hub gave it.
  const [{ readyNamesFor }, { deliveryOrderFor }] = await Promise.all([import("./handoff"), import("./delivery")]);
  const [ready, order] = await Promise.all([readyNamesFor(jobId).catch(() => new Map<string, string>()), deliveryOrderFor(jobId).catch(() => [])]);
  const fileOf = (i: { filename: string; filename_extension: string }) => `${i.filename}.${i.filename_extension}`;
  const items: PushItem[] = [];
  const replaceIds: string[] = [];
  const missing: string[] = [];
  for (const p of photos) {
    const names = [
      ...(run?.listed ?? []).filter((l) => l.photoId === p.id).map((l) => l.name),
      ...[...ready].filter(([, id]) => id === p.id).map(([n]) => n),
      ...order.filter((o) => o.photoId === p.id).map((o) => o.deliveryName),
      p.name,
    ].map(lower);
    const img = (p.sourceKind === "ARYEO" && p.sourceRef ? page.images.find((i) => i.id === p.sourceRef) : undefined) ?? page.images.find((i) => names.includes(lower(fileOf(i))));
    if (!img || replaceIds.includes(img.id)) {
      missing.push(p.name);
      continue;
    }
    replaceIds.push(img.id);
    items.push({ photoId: p.id, name: fileOf(img), path: "", uuid: null, tries: 0, error: null, already: false, rev: p.contentHash, blob: { pathname: files.get(p.id)! } });
  }
  if (missing.length) return { ok: false, started: false, message: `${missing.join(", ")} could not be found on the Aryeo listing, so nothing was sent. Download the edited photo from the lightbox and replace it on the listing by hand.` };
  const now = new Date().toISOString();
  const next: PushRun = {
    id: randomBytes(4).toString("hex"), listingId: project.aryeoListingId, state: "SENDING", then: "stop", items, groupId: null, addedAt: null, ordered: false,
    deliveredAt: run?.deliveredAt ?? null, by, startedAt: now, updatedAt: now, finishedAt: null, note: null, lease: null, anyway: true, fingerprint: null,
    listed: run?.listed ?? [], remove: [], removedAt: null, approvedBy: by, mode: "update", replaceIds, keepOrder: page.images.map((i) => lower(fileOf(i))), prev: raw,
  };
  if (!(await save(jobId, next, raw))) return { ok: false, started: false, message: "Someone started something in Aryeo a moment ago. Try again." };
  const names = items.map((i) => i.name).join(", ");
  await logJobEvent(jobId, by, `updating ${items.length} photo${items.length === 1 ? "" : "s"} on the Aryeo listing with the hub's edit (${names}); nothing is delivered again`, { photoIds: items.map((i) => i.photoId), replaceIds });
  return { ok: true, started: true, message: `Replacing ${names} on the Aryeo listing with the edited version. Nothing is delivered again and no email goes out.` };
}

/** An Update on Aryeo ended: carry the photos over to their new listing images, record it, put the job's run before it back. */
async function finishListingUpdate(jobId: string, r: PushRun, raw: string | null): Promise<PushRun | null> {
  const ok = r.state === "DONE";
  let prev: PushRun | null = null;
  try {
    prev = r.prev ? (JSON.parse(r.prev) as PushRun) : null;
  } catch {
    prev = null;
  }
  let carried = 0;
  if (ok) {
    const { listingGallery } = await import("./jobs");
    const { adoptListedEdit } = await import("./photoEdit");
    const listing = await listingGallery(r.listingId);
    const old = new Set(r.replaceIds ?? []);
    for (const it of r.items) {
      const e = listing?.entries.find((x) => lower(x.name) === lower(it.name) && (!x.sourceRef || !old.has(x.sourceRef)));
      if (!e || !it.rev) continue;
      if (await adoptListedEdit(it.photoId, it.rev, e, r.by ?? "aryeo-push").catch(() => false)) {
        carried++;
        if (prev?.listed) prev.listed = prev.listed.map((l) => (l.photoId === it.photoId ? { ...l, rev: e.contentHash } : l));
      }
    }
    if (prev?.fingerprint) prev.fingerprint = await (await import("./handoff")).readyFingerprintFor(jobId);
  }
  const now = new Date().toISOString();
  const names = r.items.map((i) => i.name).join(", ");
  const outcome: ListingUpdateOutcome = { at: now, ok, note: ok ? `Updated on the Aryeo listing: ${names}.` : `Not updated on Aryeo: ${r.note ?? "it stopped"}`, photoIds: r.items.map((i) => i.photoId), by: r.by };
  const back = prev ? JSON.stringify({ ...prev, lease: null, updatedAt: now }) : null;
  const put = back
    ? await prisma.appSetting.updateMany({ where: { key: KEY(jobId), value: raw ?? "" }, data: { value: back, updatedBy: "aryeo-push" } })
    : await prisma.appSetting.deleteMany({ where: { key: KEY(jobId), value: raw ?? "" } });
  if (put.count !== 1) return null; // someone else changed the record: theirs stands
  await prisma.appSetting.upsert({ where: { key: UPDATE_KEY(jobId) }, create: { key: UPDATE_KEY(jobId), value: JSON.stringify(outcome), updatedBy: "aryeo-push" }, update: { value: JSON.stringify(outcome), updatedBy: "aryeo-push" } });
  await logJobEvent(jobId, "aryeo-push", ok ? `updated on the Aryeo listing with the hub's edit: ${names}${carried ? "" : " (the listing images could not be matched back; the next sync reads them)"}` : `updating on the Aryeo listing stopped: ${r.note ?? "unknown"}`, { photoIds: outcome.photoIds });
  return prev;
}

/** Kyle's "Deliver in Aryeo" on a push that is waiting for it (or a finished upload-only push). */
export async function approvePushDelivery(jobId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const { run, raw } = await load(jobId);
  const job0 = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
  if (!run) return { ok: false, message: "Nothing has been sent to Aryeo for this job yet." };
  if (run.state === "CONFIRMING" || run.deliveredAt) return { ok: true, message: "Already delivered in Aryeo." };
  if (run.state !== "WAITING" && !(run.state === "DONE" && run.then === "stop")) return { ok: false, message: "The photos are not all on the listing yet. Wait for the upload to finish." };
  // Oct 23 2026 (615 Cliff Ln, Jordan pressed Deliver after a later visit's 4
  // photos were added: "This happens when I try to deliver"). Deliver on
  // photos that changed since they went up IS the approval to send the
  // changes: the push uploads only what the listing lacks (the duplicate
  // guard), then delivers by itself, re-delivering for new photos.
  if (await changedSince(jobId, run)) {
    if (!job0 || !APPROVE_FROM.has(job0.stage)) return { ok: false, message: CHANGED };
    const r = await approveJob(jobId, by, { deliver: true, anyway: !!run.anyway });
    return { ok: r.ok, message: r.ok ? `The photos changed since they went up, so the new ones are going on the listing first, then it delivers. ${r.message}`.trim() : r.message };
  }
  // Oct 22 2026: a job the sync already reads as delivered (a split job's new
  // photos uploaded onto the delivered listing) still owes the agent the
  // email for them: a re-delivery, once nothing holds the photos.
  const redeliverOnly = job0?.stage === "DELIVERED" && (run.addedSinceDelivery?.length ?? 0) > 0;
  if (job0?.stage === "DELIVERED" && !redeliverOnly) return { ok: false, message: "This job is already delivered." };
  if (redeliverOnly) {
    const { deliveryGate } = await import("./delivery");
    const open = (await deliveryGate(jobId)).checks.filter((c) => c.hold && !c.ok);
    if (open.length) return { ok: false, message: `Not yet: ${open.map((c) => c.label.toLowerCase()).join("; ")}.`.slice(0, 400) };
  } else if (job0?.stage !== "DELIVERING") {
    // A person's go-ahead: the same gate as Mark as delivering (shadow mode advises, never blocks).
    const { startDelivery } = await import("./delivery");
    const g = await startDelivery(jobId, by);
    if (!g.ok) return { ok: false, message: g.message };
  }
  const next: PushRun = { ...run, state: "DELIVERING", then: "deliver", by, note: null, finishedAt: null };
  if (!(await save(jobId, next, raw))) return { ok: false, message: "That changed a moment ago. Reload the page." };
  return { ok: true, message: redeliverOnly ? "Re-delivering in Aryeo now: the agent gets Aryeo's delivery email for the new photos." : "Delivering in Aryeo now. The listing's customers get Aryeo's usual delivery email." };
}

/** The stages Kyle's approval is taken from: Ready to review, or a job already past it. */
const APPROVE_FROM = new Set(["READY", "DELIVERING", "DELIVERY_MISMATCH", "REVISION_REQUESTED"]);

// Oct 22 2026 (photo audit H2): the refusal's prefix and the reason's length
// live in holding.ts (browser-safe), shared with the page.
export { UPLOAD_HELD_PREFIX, UPLOAD_OVERRIDE_MIN };

/**
 * Kyle's approval of a job that is Ready to review (Oct 15, Jordan: "click
 * approve and deliver or approve and upload to Aryeo"). Deliver: photos
 * already on the listing and unchanged are delivered as they are; otherwise
 * they go up first and the delivery follows by itself. Nothing is marked as
 * delivering before the photos are on the listing.
 */
export async function approveJob(jobId: string, by: string, opts: { deliver: boolean; anyway?: boolean; holdReason?: string | null }): Promise<{ ok: boolean; started: boolean; message: string }> {
  const settings = await photoDeliverySettings();
  if (settings.aryeoPush === "off") return { ok: false, started: false, message: "The hub's Aryeo upload is switched off (Photo Delivery settings)." };
  const { run } = await load(jobId);
  if (run && ACTIVE.includes(run.state)) return { ok: true, started: false, message: "Already working in Aryeo." };
  // Audit C22 (Oct 20 2026): only a job that is Ready to review (or already
  // past it) is approved. A stale page can no longer push a job that is still
  // editing, in QC or waiting on a decision onto the listing.
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
  if (!job) return { ok: false, started: false, message: "That job no longer exists." };
  if (!APPROVE_FROM.has(job.stage)) return { ok: false, started: false, message: "This job is not ready to review yet. Reload the page." };
  // Oct 22 2026 (photo audit H2): Approve and upload ran no checklist, and its
  // finish line sent Kyle to deliver in Aryeo, past every hold (58 Recreation
  // Dr went out with "Lot Lines needed" open). It now checks the same holds as
  // Approve and deliver. Kyle can still put the photos up past them with a
  // typed reason (kept on the job's activity); the delivery itself still waits
  // for the checklist (Deliver in Aryeo goes through startDelivery).
  let pastHolds: { holds: string; reason: string } | null = null;
  if (!opts.deliver && job.stage !== "DELIVERING") {
    const { deliveryGate } = await import("./delivery");
    const gate = await deliveryGate(jobId);
    if (!gate.canDeliver) {
      if (!gate.overrideAllowed) return { ok: false, started: false, message: gate.blockedForOverride ?? "This gallery cannot go on the listing yet." };
      const open = gate.checks.filter((c) => !c.ok && !c.advisory && (c.hold || !gate.advisory)).map((c) => c.label.replace(/\.$/, "").toLowerCase());
      const holds = open.join("; ").slice(0, 300) || "the checklist has open items";
      const reason = (opts.holdReason ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      if (reason.length < UPLOAD_OVERRIDE_MIN) {
        return { ok: false, started: false, message: `${UPLOAD_HELD_PREFIX} the checklist still holds these photos (${holds}). Settle them first, or write why they can go on the listing now (they are not delivered until the checklist is clear).`.slice(0, 600) };
      }
      pastHolds = { holds, reason };
    }
  }
  if (opts.deliver) {
    if (job.stage !== "DELIVERING") {
      const { deliveryGate } = await import("./delivery");
      const gate = await deliveryGate(jobId);
      if (!gate.canDeliver) return { ok: false, started: false, message: gate.blockedForOverride ?? `Not yet: the checklist has open items (${gate.checks.filter((c) => !c.ok && !c.advisory).map((c) => c.label.toLowerCase()).join("; ")}).`.slice(0, 400) };
    }
    if (run && !run.deliveredAt && (run.state === "WAITING" || run.state === "DONE") && !(await changedSince(jobId, run))) {
      const r = await approvePushDelivery(jobId, by);
      if (r.ok) await closeMediaCheckForPhotos(jobId, { by, reason: "Photos approved in Photo Delivery", human: true });
      return { ok: r.ok, started: r.ok, message: r.message };
    }
  }
  const r = await requestPush(jobId, { by, then: opts.deliver ? "deliver" : "stop", anyway: opts.anyway, approvedBy: by });
  if (r.started) {
    await logJobEvent(
      jobId,
      by,
      opts.deliver ? "approved: deliver" : pastHolds ? `approved: upload to Aryeo past open holds (${pastHolds.holds}): ${pastHolds.reason}` : "approved: upload to Aryeo",
      pastHolds ? { uploadPastHolds: true, ...pastHolds } : null,
    );
    // Kyle checked the photos here: the shoot's media check closes with them (audit C11, Oct 21 2026).
    await closeMediaCheckForPhotos(jobId, { by, reason: "Photos approved in Photo Delivery", human: true });
  }
  return r;
}

/**
 * A same-day order (the client paid for the photos today) approves itself:
 * null when every check passes, else why not. Checked before the upload and
 * the checklist again before the delivery (the DELIVERING step).
 */
export async function sameDayBlocker(jobId: string): Promise<string | null> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, projectId: true } });
  if (!job || job.stage !== "READY") return "not ready to review";
  const project = await prisma.project.findUnique({
    where: { id: job.projectId },
    // Owed lines only (audit C3, Oct 20 2026): a same-day line pulled from the
    // order no longer lets the job approve itself.
    select: { deliverables: { where: OWED_DELIVERABLE_WHERE, select: { label: true, productTitle: true } }, orderItems: { where: { isCanceled: false }, select: { title: true } } },
  });
  const { sameDayAddOns } = await import("@/lib/tasks");
  if (!project || !sameDayAddOns(project.deliverables, project.orderItems).photos) return "not a same-day order";
  // A CLIENT'S OPEN ASK HOLDS IT (Oct 19 2026, lib/clientAsks). Jordan: "I
  // don't want it to deliver before Kyle was able to confirm that the lot
  // lines look correct." A text or email ask about the photos waits for Kyle's
  // Confirmed; his own Approve is never blocked (the job page shows the asks).
  // A read that fails holds too: Kyle can always approve it himself.
  const holding = await import("@/lib/clientAsks").then((m) => m.openAsksHolding(job.projectId, "photo")).catch(() => null);
  if (holding === null) return "the client's open asks could not be read";
  if (holding.length) return `${holding.length} client ask${holding.length === 1 ? "" : "s"} to confirm first`;
  const flagged = await openPhotoFlags(job.projectId);
  if (flagged) return flagged;
  const busy =await prisma.photoFixOperation.count({ where: { jobId, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
  if (busy) return "fixes still running";
  const { deliveryGate } = await import("./delivery");
  const gate = await deliveryGate(jobId);
  // Oct 22 2026 (addOns.ts): lot lines or staging on the order: always Kyle's approval, never the hub's.
  const personal = gate.checks.filter((c) => c.personOnly && !c.advisory);
  if (personal.length) return `${addOnWords(personal)} on the order: Kyle approves it`;
  if (!gate.passed) return "the checklist has open items";
  return null;
}

/**
 * A photo someone flagged for a fix (the lightbox's Flag, lib/imageFlags)
 * holds the hub's OWN delivery (audit C10, Oct 20 2026): the flags were a
 * second fix list Photo Delivery never read, so a same-day order could go out
 * with "Sign in the yard" still open. Kyle's own approval is not blocked by it.
 * Answers why it holds, or null. A read that fails holds.
 */
async function openPhotoFlags(projectId: string): Promise<string | null> {
  const n = await prisma.imageFlag.count({ where: { projectId, status: "OPEN" } }).catch(() => null);
  if (n === null) return "the photo flags could not be read";
  return n ? `${n} flagged photo${n === 1 ? "" : "s"} to fix first` : null;
}

/** Same-day orders, for the job page: is this one, and will the hub approve it by itself. */
export async function isSameDayJob(jobId: string): Promise<boolean> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  if (!job) return false;
  const project = await prisma.project.findUnique({
    where: { id: job.projectId },
    select: { deliverables: { where: OWED_DELIVERABLE_WHERE, select: { label: true, productTitle: true } }, orderItems: { where: { isCanceled: false }, select: { title: true } } },
  });
  const { sameDayAddOns } = await import("@/lib/tasks");
  return !!project && sameDayAddOns(project.deliverables, project.orderItems).photos;
}

// ---- moving one on ------------------------------------------------------------------------------

let downloader: ((path: string) => Promise<Buffer>) | null = null;
/** Drills only. */
export function __setPushDownloaderForTests(fn: typeof downloader) {
  downloader = fn;
}
async function download(path: string): Promise<Buffer> {
  if (downloader) return downloader(path);
  const { dropboxDownload } = await import("@/lib/integrations/dropbox");
  return dropboxDownload(path);
}

const fail = (r: PushRun, note: string): PushRun => ({ ...r, state: "FAILED", note: note.slice(0, 400), finishedAt: new Date().toISOString(), lease: null });
/**
 * Aryeo's bad minute: its own "try again later" answer, or the connection
 * dropping on the way there (fetch failed, a timeout). The run waits and the
 * next pass carries on; never a refusal, a sign-in or a changed Aryeo
 * (Oct 29 2026, 825 State St: Kyle's approved delivery stopped for good on
 * one "fetch failed" and sat in Delivering, never delivered).
 */
const badMinute = (e: unknown): boolean => e instanceof Error && (e.name === "AryeoWebError" ? (e as Error & { kind?: string }).kind === "transient" : isTransientProviderError(e));
/** A step that ended on a bad minute: its note is saved and the pass ends there (the next cron pass carries on), never tried again in a tight loop. */
const waitingOnAryeo = new WeakSet<PushRun>();

/** "lot lines", "lot lines and virtual staging": the person-only add-on lines of a checklist (Oct 22 2026). */
function addOnWords(lines: { label: string; addOn?: { need: string } }[]): string {
  const words = [...new Set(lines.map((c) => (c.addOn?.need ?? c.label).replace(/\s+(needed|added)$/i, "").toLowerCase()))];
  return words.length ? words.join(" and ") : "add-on work";
}

/** The re-delivery claim of one run (Oct 22 2026): written before the call, so a pass that stops mid-call is never followed by a second email. */
const REDELIVER_KEY = (jobId: string, runId: string) => `photo_redeliver:${jobId}:${runId}`;
type RedeliverClaim = { state: "sending" | "sent" | "refused"; at: string; photos: number };

/**
 * RE-DELIVER a listing that was already delivered, for the new photos the hub
 * put on it (Oct 22 2026). The same Deliver the hub presses for a first
 * delivery, as Aryeo's Re-deliver (delivery email, the listing's customers).
 * Never twice: a claim record ("sending") is written BEFORE the call and
 * marked "sent" after it; a claim found still "sending" means a pass stopped
 * mid-call, so the email may have gone and it is never sent again
 * ("uncertain", on the job). Aryeo's own clear no leaves the run waiting for
 * Kyle's Deliver in Aryeo (which tries again). Returns the run to save when
 * this step is not finished (refused); null to go on to the check.
 */
async function redeliver(jobId: string, r: PushRun, timezone: string | null, W: typeof import("@/lib/integrations/aryeoWeb")): Promise<PushRun | null> {
  const n = r.addedSinceDelivery?.length ?? 0;
  const by = r.approvedBy ?? r.by ?? "aryeo-push";
  const words = `${n} new photo${n === 1 ? "" : "s"}`;
  const key = REDELIVER_KEY(jobId, r.id);
  const now = () => new Date().toISOString();
  const prior = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  let p: RedeliverClaim | null = null;
  try {
    p = prior ? (JSON.parse(prior.value) as RedeliverClaim) : null;
  } catch {
    p = null;
  }
  if (p?.state === "sent") {
    // Sent by a pass that stopped before saving the run: never again.
    r.redelivery = { state: "sent", at: p.at, photos: p.photos, note: null };
    r.addedSinceDelivery = [];
    return null;
  }
  if (prior && p?.state !== "refused") {
    // A pass claimed it and stopped before it knew the answer: the email may have gone.
    r.redelivery = { state: "uncertain", at: now(), photos: n, note: "The hub stopped while re-delivering; the email may have gone, so it is not sent again." };
    r.addedSinceDelivery = [];
    await logJobEvent(jobId, "aryeo-push", `re-delivering in Aryeo for ${words} did not finish cleanly: the email may have gone, so the hub does not send it again. Check the listing in Aryeo`);
    return null;
  }
  // Written down first, before anything reaches Aryeo (a refusal before is taken over: nothing went then).
  const claim: RedeliverClaim = { state: "sending", at: now(), photos: n };
  const claimed = prior
    ? (await prisma.appSetting.updateMany({ where: { key, value: prior.value }, data: { value: JSON.stringify(claim), updatedBy: "aryeo-push" } })).count === 1
    : await prisma.appSetting.create({ data: { key, value: JSON.stringify(claim), updatedBy: "aryeo-push" } }).then(() => true, () => false);
  if (!claimed) return r; // another pass claimed it a moment ago: the next step reads what it did
  const settle = (state: RedeliverClaim["state"]) => prisma.appSetting.updateMany({ where: { key }, data: { value: JSON.stringify({ ...claim, state, at: now() }), updatedBy: "aryeo-push" } }).catch(() => null);
  try {
    const sent = await W.deliverListing(r.listingId, { fulfillOrders: true, timezone, redeliver: true });
    await settle("sent");
    r.redelivery = { state: "sent", at: now(), photos: n, note: null };
    r.addedSinceDelivery = [];
    await logJobEvent(jobId, by, `re-delivered in Aryeo: ${words} on the listing; ${sent.recipients.length ? sent.recipients.join(", ") : "the listing's customers"} get${sent.recipients.length === 1 ? "s" : ""} Aryeo's delivery email`, { redelivered: n, recipients: sent.recipients });
    return null;
  } catch (e) {
    const err = e as Error & { kind?: string };
    if (err.name === "AryeoWebError" && (err.kind === "refused" || err.kind === "not-connected")) {
      // Aryeo's clear no (or no login): nothing went. Kyle presses Deliver in Aryeo to try again.
      await settle("refused");
      r.redelivery = { state: "refused", at: now(), photos: n, note: err.message.slice(0, 300) };
      r.state = "WAITING";
      r.note = `The new photos are on the listing, but Aryeo would not re-deliver it (${err.message.slice(0, 160)}). Press Deliver in Aryeo to try again, or Re-deliver it in Aryeo.`.slice(0, 400);
      await logJobEvent(jobId, "aryeo-push", `not re-delivered in Aryeo: ${err.message.slice(0, 200)}`);
      return r;
    }
    if (err.name === "AryeoWebError" && err.kind === "sign-in") {
      const { markError } = await import("@/lib/integrations/connections");
      await markError(W.ARYEO_WEB_PROVIDER, err.message).catch(() => {});
    }
    // No clear answer: the email may have gone. Never sent again by the hub (the claim stays "sending").
    r.redelivery = { state: "uncertain", at: now(), photos: n, note: err.message.slice(0, 300) };
    r.addedSinceDelivery = [];
    await logJobEvent(jobId, "aryeo-push", `re-delivering in Aryeo for ${words} got no clear answer (${err.message.slice(0, 160)}): the email may have gone, so the hub does not send it again. Check the listing in Aryeo`);
    return null;
  }
}

async function step(jobId: string, r0: PushRun): Promise<PushRun | null> {
  const r: PushRun = JSON.parse(JSON.stringify(r0));
  const W = await import("@/lib/integrations/aryeoWeb");
  try {
    if (r.state === "PREPARING") {
      // Move the folder on too (the cron's ready step also does), then look.
      const { advanceReady } = await import("./handoff");
      await advanceReady(jobId, { budgetMs: 20_000 }).catch(() => null);
      const built = await buildItems(jobId, r.listingId, r.anyway === true, r.listed ?? []);
      if ("error" in built) return fail(r, built.error);
      if ("wait" in built) {
        if (Date.now() - Date.parse(r.startedAt) > 45 * 60_000) return fail(r, `06-Ready-for-Aryeo was not ready after 45 minutes (${built.wait}). Press Get them ready again, then Send to Aryeo.`);
        if (built.wait === r.note) return null;
        r.note = built.wait;
        return r;
      }
      r.items = built.items;
      r.remove = built.remove;
      r.fingerprint = built.fingerprint;
      Object.assign(r, builtExtras(built));
      r.note = null;
      const all = r.items.every((i) => i.already) && !r.remove.length;
      r.state = all ? "CHECKING" : "SENDING";
      if (all) r.addedAt = new Date().toISOString();
      return r;
    }
    if (r.state === "SENDING") {
      const batch = r.items.filter((i) => !i.already && !i.uuid && i.tries < MAX_TRIES).slice(0, 3);
      if (!batch.length) {
        const stuck = r.items.filter((i) => !i.already && !i.uuid);
        if (stuck.length) return fail(r, `${stuck.length} photo${stuck.length === 1 ? "" : "s"} could not be sent to Aryeo (${stuck.slice(0, 3).map((i) => `${i.name}: ${i.error ?? "failed"}`).join("; ")}). Nothing was added to the listing. Press Send to Aryeo to try again.`);
        r.state = "ADDING";
        return r;
      }
      for (const it of batch) {
        try {
          const bytes = it.blob ? await storedBytes(it.blob.pathname) : await download(it.path);
          if (bytes.length < 1024) throw new Error(`the file in 06-Ready-for-Aryeo is only ${bytes.length} bytes`);
          it.uuid = await W.uploadcareUpload(new Uint8Array(bytes), it.name);
          it.error = null;
        } catch (e) {
          it.tries++;
          it.error = (e as Error).message.slice(0, 200);
          if (e instanceof W.AryeoWebError && (e.kind === "changed" || e.kind === "refused") && it.tries >= 1) it.tries = MAX_TRIES;
        }
      }
      return r;
    }
    if (r.state === "ADDING") {
      // 0. The hub's own photos that changed or left the set come off first (read, then delete what is still there).
      // Oct 22 2026 (photo audit H7): never in Update on Aryeo. There the old
      // listing image stays until the new one is attached AND read back on the
      // listing (CHECKING below), so a failed upload never leaves a delivered
      // listing without the photo.
      if (r.mode !== "update" && r.remove?.length && !r.removedAt) {
        const gone = new Set(r.remove ?? []);
        // Oct 22 2026: never an image that was already on the listing (an earlier visit's, a photo added by hand).
        const keep = new Set(r.keepIds ?? []);
        const page = await W.listingPage(r.listingId);
        const ids = page.images.filter((i) => !keep.has(i.id) && gone.has(lower(`${i.filename}.${i.filename_extension}`))).map((i) => i.id);
        if (ids.length) await W.deleteImages(r.listingId, ids);
        r.removedAt = new Date().toISOString();
        return r;
      }
      const ours = r.items.filter((i) => !i.already && i.uuid);
      if (!ours.length) {
        r.addedAt = r.addedAt ?? new Date().toISOString();
        r.state = "CHECKING";
        return r;
      }
      // 1. Write the intent down first (saved before anything reaches Aryeo).
      if (!r.addSentAt) {
        r.groupId = r.groupId ?? (await W.uploadcareGroup(ours.map((i) => i.uuid!)));
        r.addSentAt = new Date().toISOString();
        return r;
      }
      // 2. A pass that died after sending: look before sending again (Oct 14,
      //    Bob Kelley: the photos were added twice when the add was re-sent).
      if (Date.now() - Date.parse(r.addSentAt) > 90_000) {
        const { listingGallery } = await import("./jobs");
        const listing = await listingGallery(r.listingId);
        // Update on Aryeo: the old image (still there, same name) is not the new one (photo audit H7).
        const replaced = new Set(r.replaceIds ?? []);
        const names = new Set((listing?.entries ?? []).filter((e) => !e.sourceRef || !replaced.has(e.sourceRef)).map((e) => lower(e.name)));
        if (!listing || ours.some((i) => names.has(lower(i.name)))) {
          r.addedAt = r.addedAt ?? r.addSentAt;
          r.state = "CHECKING";
          if (r.mode !== "update" && String(listing?.deliveryStatus ?? "").toUpperCase() === "DELIVERED") r.addedSinceDelivery = newOnDelivered(r, ours);
          return r;
        }
      }
      // 3. Send it once. Whatever happens after Aryeo received it, the check decides; never re-sent.
      const page = await W.listingPage(r.listingId);
      try {
        await W.attachImages(r.listingId, r.groupId!, { agreesToMediaLicense: page.requiresMediaLicense });
      } catch (e) {
        if (!badMinute(e)) throw e;
      }
      r.addedAt = new Date().toISOString();
      r.state = "CHECKING";
      // Oct 22 2026: new photos on a listing already delivered: its delivery after this re-delivers it.
      if (r.mode !== "update" && page.delivered) r.addedSinceDelivery = newOnDelivered(r, ours);
      return r;
    }
    if (r.state === "CHECKING") {
      const { listingGallery } = await import("./jobs");
      const listing = await listingGallery(r.listingId);
      if (!listing) return null; // Aryeo's API had a bad minute: next pass
      // Update on Aryeo: the new image under the old name, and the old one gone (its id, since the name is the same).
      const old = new Set(r.replaceIds ?? []);
      const names = new Set(listing.entries.filter((e) => !e.sourceRef || !old.has(e.sourceRef)).map((e) => lower(e.name)));
      const wanted = new Set(r.items.map((i) => lower(i.name)));
      const missing = r.items.filter((i) => !names.has(lower(i.name)));
      const lingering = [...(r.remove ?? []).filter((n) => !wanted.has(n) && names.has(n)), ...listing.entries.filter((e) => e.sourceRef && old.has(e.sourceRef)).map((e) => lower(e.name))];
      // Oct 22 2026 (photo audit H7): Update on Aryeo takes the old image off
      // only now, once every new one is read back on the listing (once; the
      // next pass looks again, and 20 minutes later says what is still there).
      if (r.mode === "update" && !missing.length && lingering.length && !r.removedAt) {
        const stale = listing.entries.filter((e) => e.sourceRef && old.has(e.sourceRef)).map((e) => e.sourceRef!);
        if (stale.length) await W.deleteImages(r.listingId, stale);
        r.removedAt = new Date().toISOString();
        return r;
      }
      if (!missing.length && !lingering.length) {
        r.state = "ORDERING";
        r.note = null;
        // A photo the duplicate guard found already there is not the hub's: never listed as its own (so never taken off).
        r.listed = r.items.filter((i) => !i.matched).map((i) => ({ name: i.name, photoId: i.photoId, rev: i.rev ?? null }));
        // NO PHOTO TWICE (Oct 22 2026): once everything is on, the listing is
        // looked at as a whole. A duplicate is said on the job and flagged for
        // Kyle; the hub never deletes it (and does not deliver by itself).
        if (r.mode !== "update") {
          const dups = await duplicatesOnListing(jobId, listing.entries, r);
          r.duplicates = dups.map((d) => d.names);
          const { duplicateWords } = await import("./listingMatch");
          if (dups.length) {
            const words = duplicateWords(dups);
            await logJobEvent(jobId, "aryeo-push", `checked the listing: ${dups.length === 1 ? "a photo is" : `${dups.length} photos are`} on it twice (${words}). Flagged for Kyle; nothing was deleted`, { duplicates: r.duplicates });
            await flagDuplicates(jobId, words).catch(() => {});
          } else {
            await logJobEvent(jobId, "aryeo-push", `checked the listing: ${listing.entries.length} photo${listing.entries.length === 1 ? "" : "s"} on it, no photo twice`);
          }
        }
        return r;
      }
      if (r.addedAt && Date.now() - Date.parse(r.addedAt) > CHECK_FOR_MS) {
        if (!missing.length) return fail(r, `Aryeo still shows ${lingering.length} old photo${lingering.length === 1 ? "" : "s"} on the listing after 20 minutes (${lingering.slice(0, 3).join(", ")}). Remove ${lingering.length === 1 ? "it" : "them"} in Aryeo.`);
        return fail(r, `Aryeo shows ${r.items.length - missing.length} of ${r.items.length} photos on the listing after 20 minutes (missing ${missing.slice(0, 3).map((i) => i.name).join(", ")}${missing.length > 3 ? "…" : ""}). Look at the listing in Aryeo.`);
      }
      r.note = `Aryeo is processing the photos: ${r.items.length - missing.length} of ${r.items.length} on the listing.`;
      return r.note === r0.note ? null : r;
    }
    if (r.state === "ORDERING") {
      const { listingGallery } = await import("./jobs");
      const listing = await listingGallery(r.listingId);
      if (!listing) return null;
      // Oct 22 2026 (615 Cliff Ln): on a split job the listing's photos stay
      // first in their own order (the cover stays the cover) and this
      // delivery's follow in the order Kyle set; nothing new goes ahead of them.
      const sent = r.items.filter((i) => !i.matched).map((i) => lower(i.name));
      const sentSet = new Set(sent);
      const before = r.split ? [...(r.keptOrder ?? []).filter((n) => !sentSet.has(n)), ...listing.entries.map((e) => lower(e.name)).filter((n) => !sentSet.has(n) && !(r.keptOrder ?? []).includes(n))] : [];
      const wantOrder = r.keepOrder?.length ? r.keepOrder : r.split ? [...before, ...sent] : r.items.map((i) => lower(i.name));
      const ours = listing.entries.map((e) => lower(e.name)).filter((n) => wantOrder.includes(n));
      const inOrder = ours.join("\n") === wantOrder.join("\n") && listing.entries.slice(0, wantOrder.length).every((e, k) => lower(e.name) === wantOrder[k]);
      if (!inOrder && !r.ordered) {
        const page = await W.listingPage(r.listingId);
        const fileOf = (img: { filename: string; filename_extension: string }) => lower(`${img.filename}.${img.filename_extension}`);
        // A split job: every image already there keeps its exact place among the others (by id, so two with one name never swap), the new ones after.
        const keptPos = new Map(page.images.filter((i) => !sentSet.has(fileOf(i))).map((i, k) => [i.id, k]));
        const rank = (img: { id: string; filename: string; filename_extension: string }) => {
          if (r.split && !r.keepOrder?.length) return keptPos.get(img.id) ?? keptPos.size + sent.indexOf(fileOf(img));
          const k = wantOrder.indexOf(fileOf(img));
          return k < 0 ? wantOrder.length : k;
        };
        const sorted = [...page.images].sort((a, b) => rank(a) - rank(b));
        if (sorted.some((i) => rank(i) < wantOrder.length)) await W.reorderImages(r.listingId, sorted);
        r.ordered = true;
        return r;
      }
      if (!inOrder) r.note = "The photos are on the listing, but Aryeo kept a different order. Check the order in Aryeo before delivering.";
      r.state = r.then === "deliver" ? "DELIVERING" : r.then === "approval" ? "WAITING" : "DONE";
      // A photo on the listing twice: the client never gets it that way by
      // itself. Kyle takes the extra copy off in Aryeo, then presses Deliver
      // in Aryeo (his press delivers as it is).
      if (r.duplicates?.length) {
        r.note = `${r.duplicates.length === 1 ? "A photo is" : `${r.duplicates.length} photos are`} on the listing twice (${(await import("./listingMatch")).duplicateWords(r.duplicates.map((names) => ({ key: "", names })))}). Take the extra copy off in Aryeo (the hub never deletes there)${r.state === "DELIVERING" ? ", then press Deliver in Aryeo" : ""}.`;
        if (r.state === "DELIVERING") r.state = "WAITING";
      }
      if (r.state === "DONE") r.finishedAt = new Date().toISOString();
      return r;
    }
    if (r.state === "DELIVERING") {
      // The same gate as Mark as delivering: a held or failing job is not delivered by the hub.
      const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, projectId: true } });
      if (job?.stage === "ON_HOLD") {
        r.state = "WAITING";
        r.note = "Not delivered: the job is on hold. Release the hold, then press Deliver in Aryeo.";
        return r;
      }
      if (await changedSince(jobId, r)) {
        r.state = "WAITING";
        r.note = CHANGED;
        return r;
      }
      if (job && job.stage !== "DELIVERING" && job.stage !== "DELIVERED") {
        // The hub delivers by itself (a same-day order) only on a checklist
        // that really passes: shadow mode's "advisory" never lets an open
        // critical, major or privacy issue reach a client automatically.
        // Kyle's approval goes through the usual gate (startDelivery), the
        // same as Mark as delivering; Jordan's override has already decided.
        const { startDelivery, deliveryGate } = await import("./delivery");
        const gate = await deliveryGate(jobId);
        if (!r.approvedBy && !gate.passed) {
          r.state = "WAITING";
          const open = gate.checks.filter((c) => !c.ok && !c.advisory);
          // Oct 22 2026: lot lines or staging on the order: Kyle approves it, even with every check passing.
          const personal = gate.checks.filter((c) => c.personOnly && !c.advisory && c.ok);
          r.note = open.length
            ? `Not delivered by itself: the checklist has open items (${open.map((c) => c.label.toLowerCase()).join("; ")}). Look at them, then press Deliver in Aryeo or Mark as delivering.`.slice(0, 400)
            : `Not delivered by itself: the order has ${addOnWords(personal)}, so Kyle approves the delivery. Look at the photos, then press Deliver in Aryeo.`.slice(0, 400);
          return r;
        }
        // Audit C3 (Oct 20 2026): the upload takes several passes, so a client
        // ask that came in while the photos went up holds the hub's own
        // delivery too (the same rule as sameDayBlocker). A failed read holds.
        if (!r.approvedBy) {
          const holding = await import("@/lib/clientAsks").then((m) => m.openAsksHolding(job.projectId, "photo")).catch(() => null);
          if (!holding || holding.length) {
            r.state = "WAITING";
            r.note = holding
              ? `Not delivered by itself: ${holding.length} client ask${holding.length === 1 ? "" : "s"} to confirm first. Confirm, then press Deliver in Aryeo or Mark as delivering.`
              : "Not delivered by itself: the client's open asks could not be read. Look at the job, then press Deliver in Aryeo or Mark as delivering.";
            return r;
          }
          const flagged = await openPhotoFlags(job.projectId);
          if (flagged) {
            r.state = "WAITING";
            r.note = `Not delivered by itself: ${flagged}. Fix them, then press Deliver in Aryeo or Mark as delivering.`;
            return r;
          }
        }
        const g = await startDelivery(jobId, r.approvedBy ?? r.by ?? "aryeo-push");
        if (!g.ok) {
          r.state = "WAITING";
          r.note = `Not delivered: ${g.message}`;
          return r;
        }
      }
      const page = await W.listingPage(r.listingId);
      if (!page.delivered) await W.deliverListing(r.listingId, { fulfillOrders: page.fulfillByDefault, timezone: page.timezone });
      else if (r.mode !== "update" && (r.addedSinceDelivery?.length ?? 0) > 0) {
        // RE-DELIVER (Oct 22 2026): new photos went on a listing already delivered.
        const next = await redeliver(jobId, r, page.timezone, W);
        if (next) return next;
      }
      r.deliveredAt = new Date().toISOString();
      r.state = "CONFIRMING";
      return r;
    }
    if (r.state === "CONFIRMING") {
      const { verifyDelivery } = await import("./delivery");
      const v = await verifyDelivery(jobId, "aryeo-push");
      if (v.ok) {
        r.state = "DONE";
        r.finishedAt = new Date().toISOString();
        r.note = null;
        return r;
      }
      if (v.waiting && r.deliveredAt && Date.now() - Date.parse(r.deliveredAt) < 10 * 60_000) return null;
      return fail(r, `Delivered in Aryeo, but the check afterwards says: ${v.message}`);
    }
    return null;
  } catch (e) {
    const err = e as Error & { kind?: string };
    // A refused sign-in or a changed Aryeo stops the run with Aryeo's words; a
    // bad minute waits. Every step is safe to run again: Deliver reads the
    // listing first and never delivers twice, and an add already sent is
    // looked for on the listing before anything is sent again.
    if (badMinute(err)) {
      r.note = err.name === "AryeoWebError" ? err.message : `Aryeo could not be reached (${err.message.slice(0, 120)}). The hub tries again in a few minutes.`;
      waitingOnAryeo.add(r);
      return r;
    }
    if (err.name === "AryeoWebError" && (err.kind === "sign-in" || err.kind === "not-connected")) {
      const { markError } = await import("@/lib/integrations/connections");
      await markError(W.ARYEO_WEB_PROVIDER, err.message).catch(() => {});
      // Not this job's fault: the cron tries it again once the login works
      // (Oct 15: 1934 W Godfrey Ave sat stopped all night after one bad sign-in).
      return { ...fail(r, err.message), retryAfter: new Date(Date.now() + 30 * 60_000).toISOString() };
    }
    return fail(r, err.message);
  }
}

/** Move a job's push on, up to `budgetMs`. One driver at a time (lease). */
export async function advancePush(jobId: string, opts: { budgetMs?: number } = {}): Promise<PushProgress | null> {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 25_000;
  const token = randomBytes(6).toString("hex");
  let { run, raw } = await load(jobId);
  if (!run || !(ACTIVE.includes(run.state))) return run ? progressOf(run) : null;
  if (run.lease && run.lease.until > Date.now() && run.lease.token !== token) return progressOf(run);
  const leased = await save(jobId, { ...run, lease: { token, until: Date.now() + LEASE_MS } }, raw);
  if (!leased) return progressOf(run);
  raw = leased;
  run = JSON.parse(leased) as PushRun;
  while (Date.now() - t0 < budget && ACTIVE.includes(run.state)) {
    const before = run.state;
    const next = await step(jobId, run);
    if (!next) break; // waiting on Aryeo: the next pass looks again
    // Update on Aryeo ended: the photos carried over, the job's run before it put back.
    if (run.mode === "update" && (next.state === "DONE" || next.state === "FAILED")) {
      const ended = await finishListingUpdate(jobId, next, raw);
      return ended ? progressOf(ended) : null;
    }
    next.lease = ACTIVE.includes(next.state) ? { token, until: Date.now() + LEASE_MS } : null;
    const saved = await save(jobId, next, raw);
    if (!saved) break; // someone else took it over
    raw = saved;
    run = JSON.parse(saved) as PushRun;
    if (waitingOnAryeo.has(next)) break;
    if (before !== run.state) {
      if (run.state === "FAILED") await logJobEvent(jobId, "aryeo-push", `sending to Aryeo stopped: ${run.note}`);
      else if (run.state === "WAITING") await logJobEvent(jobId, "aryeo-push", `all ${run.items.length} photos are on the Aryeo listing${run.note ? ` (${run.note})` : ""}; waiting for Deliver in Aryeo`);
      else if (run.state === "DONE" && run.deliveredAt) await logJobEvent(jobId, "aryeo-push", run.redelivery?.state === "sent" ? "re-delivered in Aryeo by the hub and checked" : `delivered in Aryeo by the hub and checked`);
      // Oct 22 2026 (photo audit H2): never "deliver in Aryeo" (that skips every hold): the hub's own Deliver in Aryeo checks them first.
      else if (run.state === "DONE") await logJobEvent(jobId, "aryeo-push", `all ${run.items.length} photos are on the Aryeo listing, in order; not delivered yet: press Deliver in Aryeo on this job once nothing holds the photos (the hub checks the holds first)`);
    }
  }
  if (run.lease?.token === token) {
    const end = await save(jobId, { ...run, lease: null }, raw);
    if (end) run = JSON.parse(end) as PushRun;
  }
  return progressOf(run);
}

/**
 * Cron: a job that already has a run starts again only when its photos
 * changed since they went up (and nothing was delivered), or when the cron's
 * own refusal is an hour old. A failure a person has to look at stays put.
 */
async function startAgain(jobId: string, run: PushRun): Promise<boolean> {
  if (ACTIVE.includes(run.state) || run.deliveredAt) return false;
  if (run.state === "FAILED") return !!run.retryAfter && Date.parse(run.retryAfter) < Date.now();
  // The hub's own same-day run follows a change by itself; a person's approval
  // covered the photos as they were, so a change waits for Kyle to approve again.
  return !run.approvedBy && run.by === "aryeo-push" && (run.state === "DONE" || run.state === "WAITING") && (await changedSince(jobId, run));
}

/** The cron could not start a push (the listing holds other photos, no listing yet…): say why once, look again in an hour. */
async function noteRefusal(jobId: string, message: string): Promise<void> {
  const { run, raw } = await load(jobId);
  if (run && ACTIVE.includes(run.state)) return;
  const now = new Date().toISOString();
  const next: PushRun = {
    id: randomBytes(4).toString("hex"), listingId: run?.listingId ?? "", state: "FAILED", then: run?.then ?? "stop", items: run?.items ?? [], groupId: null, addedAt: null, ordered: false,
    deliveredAt: null, by: "aryeo-push", startedAt: now, updatedAt: now, finishedAt: now, note: message.slice(0, 400), lease: null,
    fingerprint: run?.fingerprint ?? null, listed: run?.listed ?? [], retryAfter: new Date(Date.now() + 60 * 60_000).toISOString(), approvedBy: run?.approvedBy ?? null, anyway: run?.anyway,
    addedSinceDelivery: run?.addedSinceDelivery ?? [],
  };
  if (!(await save(jobId, next, raw))) return;
  if (run?.note !== next.note) await logJobEvent(jobId, "aryeo-push", `not sent to Aryeo: ${next.note}`);
}

/** Cron: start pushes the settings' stage allows, and move every running one on. */
export async function drivePushes(opts: { budgetMs?: number } = {}): Promise<{ started: string[]; moved: string[]; skipped?: string }> {
  const settings = await photoDeliverySettings();
  if (settings.aryeoPush === "off") return { started: [], moved: [], skipped: "sending to Aryeo is switched off" };
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 40_000;
  const started: string[] = [];
  {
    // What the cron may start by itself (Oct 15, Jordan: everything else waits
    // for Kyle's approval): a job a person already marked as delivering (or
    // Jordan's same-day override), and a same-day order whose every check passes.
    const { READY_FOLDER } = await import("./handoff");
    const jobs = await prisma.photoJob.findMany({
      where: {
        stageChangedAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
        OR: [
          { stage: "DELIVERING", photos: { some: { status: "ACTIVE", sourceKind: "AUTOHDR" } } },
          ...(settings.sameDayAutoDeliver ? [{ stage: "READY" as const, deliveryPath: { endsWith: READY_FOLDER }, deliveryStagedAt: { not: null } }] : []),
        ],
      },
      orderBy: { stageChangedAt: "desc" },
      select: { id: true, stage: true },
      take: 15,
    });
    const { aryeoWebCredentials } = await import("@/lib/integrations/aryeoWeb");
    const connected = !!(await aryeoWebCredentials().catch(() => null));
    for (const j of connected ? jobs : []) {
      if (started.length >= 1 || Date.now() - t0 > budget / 2) break;
      const cur = (await load(j.id)).run;
      if (cur && !(await startAgain(j.id, cur))) continue;
      if (j.stage === "READY" && (await sameDayBlocker(j.id))) continue; // waits for Kyle's approval
      const r = await requestPush(j.id, { by: "aryeo-push", then: "deliver", approvedBy: cur?.approvedBy ?? null }).catch(() => null);
      if (r?.started) {
        started.push(j.id);
        if (j.stage === "READY" && !cur) {
          await logJobEvent(j.id, "aryeo-push", "same-day order, every check passes: approved by the hub, uploading and delivering");
          await closeMediaCheckForPhotos(j.id, { by: "the hub", reason: "Photos approved in Photo Delivery (same-day order, every check passed)", human: false });
        }
      } else if (r && !r.ok) await noteRefusal(j.id, r.message);
    }
    // A run a person approved that stopped on the hub's Aryeo login: again once its wait is over.
    const retry = await prisma.appSetting.findMany({ where: { key: { startsWith: "photo_aryeo_push:" }, value: { contains: '"state":"FAILED"' }, AND: [{ value: { contains: '"retryAfter":"' } }, { value: { contains: '"approvedBy":"' } }] }, select: { key: true }, take: 10 });
    for (const row of connected ? retry : []) {
      if (started.length >= 2 || Date.now() - t0 > budget / 2) break;
      const jobId = row.key.slice("photo_aryeo_push:".length);
      const cur = (await load(jobId)).run;
      if (!cur || !cur.approvedBy || !(await startAgain(jobId, cur))) continue;
      const r = await requestPush(jobId, { by: cur.approvedBy, then: cur.then, anyway: cur.anyway, approvedBy: cur.approvedBy }).catch(() => null);
      if (r?.started) started.push(jobId);
      else if (r && !r.ok) await noteRefusal(jobId, r.message);
    }
  }
  // Only runs still going (finished ones stay as the job's record and must never crowd these out).
  const live = await prisma.appSetting.findMany({
    where: { key: { startsWith: "photo_aryeo_push:" }, NOT: [{ value: { contains: '"state":"DONE"' } }, { value: { contains: '"state":"FAILED"' } }, { value: { contains: '"state":"WAITING"' } }] },
    select: { key: true, value: true },
    orderBy: { updatedAt: "asc" },
    take: 20,
  });
  const moved: string[] = [];
  for (const row of live) {
    let st: PushState | null = null;
    try { st = (JSON.parse(row.value) as PushRun).state; } catch { st = null; }
    if (!st || !ACTIVE.includes(st)) continue;
    const left = budget - (Date.now() - t0);
    if (left < 6_000) break;
    const jobId = row.key.slice("photo_aryeo_push:".length);
    await advancePush(jobId, { budgetMs: Math.min(left, 25_000) }).catch(() => null);
    moved.push(jobId);
  }
  return { started, moved };
}
