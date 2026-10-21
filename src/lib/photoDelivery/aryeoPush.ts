import "server-only";

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { photoDeliverySettings, type AryeoPushMode } from "./settings";
import { logJobEvent } from "./jobState";
import { OWED_DELIVERABLE_WHERE } from "@/lib/tasks";

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
// ---------------------------------------------------------------------------

const KEY = (jobId: string) => `photo_aryeo_push:${jobId}`;
const LEASE_MS = 45_000;
const MAX_TRIES = 3;
const CHECK_FOR_MS = 20 * 60_000;

export type PushItem = { photoId: string; name: string; path: string; uuid: string | null; tries: number; error: string | null; already: boolean; rev?: string | null };
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
};
export type PushProgress = { state: PushState; active: boolean; total: number; sent: number; already: number; note: string | null; startedAt: string; finishedAt: string | null; deliveredAt: string | null; waitingForApproval: boolean; changed: boolean };

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
  };
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
async function buildItems(jobId: string, listingId: string, anyway: boolean, listed: Listed[] = []): Promise<{ items: PushItem[]; remove: string[]; fingerprint: string } | { wait: string } | { error: string }> {
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
  const revs = new Map((await prisma.photoAsset.findMany({ where: { id: { in: order.map((o) => o.photoId) } }, select: { id: true, autohdrVersionUuid: true, contentHash: true } })).map((p) => [p.id, p.autohdrVersionUuid ?? p.contentHash ?? null]));
  const want = new Map(order.map((o) => [lower(o.deliveryName), { photoId: o.photoId, rev: revs.get(o.photoId) ?? null }]));
  const ours = new Map(listed.map((l) => [lower(l.name), l]));
  const onListing = new Set<string>();
  const remove: string[] = [];
  const others: string[] = [];
  for (const e of listing.entries) {
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
  return {
    fingerprint,
    remove,
    items: order.map((o) => ({ photoId: o.photoId, name: o.deliveryName, path: `${rs.folder}/${o.deliveryName}`, uuid: null, tries: 0, error: null, already: onListing.has(lower(o.deliveryName)), rev: revs.get(o.photoId) ?? null })),
  };
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
  };
  if (!(await save(jobId, next, raw))) return { ok: false, started: false, message: "Someone started it a moment ago." };
  const already = items.filter((i) => i.already).length;
  const tail = then === "deliver" ? ", then delivering" : then === "approval" ? ", then waiting for Deliver in Aryeo" : ", then Kyle delivers";
  if (next.state === "PREPARING") {
    await logJobEvent(jobId, opts.by ?? "aryeo-push", `sending to the Aryeo listing${tail}: getting 06-Ready-for-Aryeo ready first`);
    return { ok: true, started: true, message: "Getting the photos ready in 06-Ready-for-Aryeo first, then sending them to the Aryeo listing. The panel shows the progress." };
  }
  const swap = remove.length ? `, taking ${remove.length} old one${remove.length === 1 ? "" : "s"} off first` : "";
  await logJobEvent(jobId, opts.by ?? "aryeo-push", `sending ${items.length - already} photo${items.length - already === 1 ? "" : "s"} to the Aryeo listing${already ? ` (${already} already there)` : ""}${swap}${tail}`);
  return { ok: true, started: true, message: all ? "Every photo is already on the listing. Checking the order." : `Sending ${items.length - already} photo${items.length - already === 1 ? "" : "s"} to the Aryeo listing${swap}. The panel shows the progress.` };
}

/** Kyle's "Deliver in Aryeo" on a push that is waiting for it (or a finished upload-only push). */
export async function approvePushDelivery(jobId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const { run, raw } = await load(jobId);
  const job0 = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
  if (!run) return { ok: false, message: "Nothing has been sent to Aryeo for this job yet." };
  if (run.state === "CONFIRMING" || run.deliveredAt) return { ok: true, message: "Already delivered in Aryeo." };
  if (run.state !== "WAITING" && !(run.state === "DONE" && run.then === "stop")) return { ok: false, message: "The photos are not all on the listing yet. Wait for the upload to finish." };
  if (await changedSince(jobId, run)) return { ok: false, message: CHANGED };
  // A person's go-ahead: the same gate as Mark as delivering (shadow mode advises, never blocks).
  if (job0?.stage !== "DELIVERING") {
    const { startDelivery } = await import("./delivery");
    const g = await startDelivery(jobId, by);
    if (!g.ok) return { ok: false, message: g.message };
  }
  const next: PushRun = { ...run, state: "DELIVERING", then: "deliver", by, note: null, finishedAt: null };
  if (!(await save(jobId, next, raw))) return { ok: false, message: "That changed a moment ago. Reload the page." };
  return { ok: true, message: "Delivering in Aryeo now. The listing's customers get Aryeo's usual delivery email." };
}

/** The stages Kyle's approval is taken from: Ready to review, or a job already past it. */
const APPROVE_FROM = new Set(["READY", "DELIVERING", "DELIVERY_MISMATCH", "REVISION_REQUESTED"]);

/**
 * Kyle's approval of a job that is Ready to review (Oct 15, Jordan: "click
 * approve and deliver or approve and upload to Aryeo"). Deliver: photos
 * already on the listing and unchanged are delivered as they are; otherwise
 * they go up first and the delivery follows by itself. Nothing is marked as
 * delivering before the photos are on the listing.
 */
export async function approveJob(jobId: string, by: string, opts: { deliver: boolean; anyway?: boolean }): Promise<{ ok: boolean; started: boolean; message: string }> {
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
  if (opts.deliver) {
    if (job.stage !== "DELIVERING") {
      const { deliveryGate } = await import("./delivery");
      const gate = await deliveryGate(jobId);
      if (!gate.canDeliver) return { ok: false, started: false, message: gate.blockedForOverride ?? `Not yet: the checklist has open items (${gate.checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join("; ")}).`.slice(0, 400) };
    }
    if (run && !run.deliveredAt && (run.state === "WAITING" || run.state === "DONE") && !(await changedSince(jobId, run))) {
      const r = await approvePushDelivery(jobId, by);
      return { ok: r.ok, started: r.ok, message: r.message };
    }
  }
  const r = await requestPush(jobId, { by, then: opts.deliver ? "deliver" : "stop", anyway: opts.anyway, approvedBy: by });
  if (r.started) await logJobEvent(jobId, by, opts.deliver ? "approved: deliver" : "approved: upload to Aryeo");
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
          const bytes = await download(it.path);
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
      if (r.remove?.length && !r.removedAt) {
        const gone = new Set(r.remove);
        const page = await W.listingPage(r.listingId);
        const ids = page.images.filter((i) => gone.has(lower(`${i.filename}.${i.filename_extension}`))).map((i) => i.id);
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
        const names = new Set((listing?.entries ?? []).map((e) => lower(e.name)));
        if (!listing || ours.some((i) => names.has(lower(i.name)))) {
          r.addedAt = r.addedAt ?? r.addSentAt;
          r.state = "CHECKING";
          return r;
        }
      }
      // 3. Send it once. Whatever happens after Aryeo received it, the check decides; never re-sent.
      const page = await W.listingPage(r.listingId);
      try {
        await W.attachImages(r.listingId, r.groupId!, { agreesToMediaLicense: page.requiresMediaLicense });
      } catch (e) {
        if ((e as Error & { kind?: string }).kind !== "transient") throw e;
      }
      r.addedAt = new Date().toISOString();
      r.state = "CHECKING";
      return r;
    }
    if (r.state === "CHECKING") {
      const { listingGallery } = await import("./jobs");
      const listing = await listingGallery(r.listingId);
      if (!listing) return null; // Aryeo's API had a bad minute: next pass
      const names = new Set(listing.entries.map((e) => lower(e.name)));
      const wanted = new Set(r.items.map((i) => lower(i.name)));
      const missing = r.items.filter((i) => !names.has(lower(i.name)));
      const lingering = (r.remove ?? []).filter((n) => !wanted.has(n) && names.has(n));
      if (!missing.length && !lingering.length) {
        r.state = "ORDERING";
        r.note = null;
        r.listed = r.items.map((i) => ({ name: i.name, photoId: i.photoId, rev: i.rev ?? null }));
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
      const wantOrder = r.items.map((i) => lower(i.name));
      const ours = listing.entries.map((e) => lower(e.name)).filter((n) => wantOrder.includes(n));
      const inOrder = ours.join("\n") === wantOrder.join("\n") && listing.entries.slice(0, wantOrder.length).every((e, k) => lower(e.name) === wantOrder[k]);
      if (!inOrder && !r.ordered) {
        const page = await W.listingPage(r.listingId);
        const rank = (img: { filename: string; filename_extension: string }) => {
          const k = wantOrder.indexOf(lower(`${img.filename}.${img.filename_extension}`));
          return k < 0 ? wantOrder.length : k;
        };
        const sorted = [...page.images].sort((a, b) => rank(a) - rank(b));
        if (sorted.some((i) => rank(i) < wantOrder.length)) await W.reorderImages(r.listingId, sorted);
        r.ordered = true;
        return r;
      }
      if (!inOrder) r.note = "The photos are on the listing, but Aryeo kept a different order. Check the order in Aryeo before delivering.";
      r.state = r.then === "deliver" ? "DELIVERING" : r.then === "approval" ? "WAITING" : "DONE";
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
          r.note = `Not delivered by itself: the checklist has open items (${gate.checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join("; ")}). Look at them, then press Deliver in Aryeo or Mark as delivering.`.slice(0, 400);
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
    // A refused sign-in or a changed Aryeo stops the run with Aryeo's words; a bad minute waits.
    if (err.name === "AryeoWebError" && err.kind === "transient") {
      r.note = err.message;
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
    next.lease = ACTIVE.includes(next.state) ? { token, until: Date.now() + LEASE_MS } : null;
    const saved = await save(jobId, next, raw);
    if (!saved) break; // someone else took it over
    raw = saved;
    run = JSON.parse(saved) as PushRun;
    if (before !== run.state) {
      if (run.state === "FAILED") await logJobEvent(jobId, "aryeo-push", `sending to Aryeo stopped: ${run.note}`);
      else if (run.state === "WAITING") await logJobEvent(jobId, "aryeo-push", `all ${run.items.length} photos are on the Aryeo listing${run.note ? ` (${run.note})` : ""}; waiting for Deliver in Aryeo`);
      else if (run.state === "DONE" && run.deliveredAt) await logJobEvent(jobId, "aryeo-push", `delivered in Aryeo by the hub and checked`);
      else if (run.state === "DONE") await logJobEvent(jobId, "aryeo-push", `all ${run.items.length} photos are on the Aryeo listing, in order; deliver in Aryeo`);
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
        if (j.stage === "READY" && !cur) await logJobEvent(j.id, "aryeo-push", "same-day order, every check passes: approved by the hub, uploading and delivering");
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
