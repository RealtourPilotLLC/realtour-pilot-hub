import "server-only";

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { photoDeliverySettings, type AryeoPushMode } from "./settings";
import { logJobEvent } from "./jobState";

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
//   then, by the settings' stage:
//     upload    DONE: Kyle delivers in Aryeo
//     approve   WAITING: Kyle presses "Deliver in Aryeo" on the job page
//     auto      DELIVERING by itself
//   DELIVERING  the delivery checklist must pass (the same gate as Mark as
//               delivering), then Aryeo's own Deliver Listing; the public API
//               must then say DELIVERED, and the usual delivery check runs.
// Never doubled: a photo already on the listing (same file name) is not sent
// again; a listing that holds OTHER photos is left for a person (or "Send
// anyway"); one run per job at a time (compare-and-swap + a short lease).
// The run lives in AppSetting "photo_aryeo_push:<jobId>".
// ---------------------------------------------------------------------------

const KEY = (jobId: string) => `photo_aryeo_push:${jobId}`;
const LEASE_MS = 45_000;
const MAX_TRIES = 3;
const CHECK_FOR_MS = 20 * 60_000;

export type PushItem = { photoId: string; name: string; path: string; uuid: string | null; tries: number; error: string | null; already: boolean };
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
};
export type PushProgress = { state: PushState; active: boolean; total: number; sent: number; already: number; note: string | null; startedAt: string; finishedAt: string | null; deliveredAt: string | null; waitingForApproval: boolean };

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
async function buildItems(jobId: string, listingId: string, anyway: boolean): Promise<{ items: PushItem[] } | { wait: string } | { error: string }> {
  const { deliveryOrderFor } = await import("./delivery");
  const { readyFolderState } = await import("./handoff");
  const order = await deliveryOrderFor(jobId);
  if (!order.length) return { error: "No photos are in the delivery yet." };
  const rs = await readyFolderState(jobId, order.length);
  if (!rs || rs.preparing) return { wait: rs?.preparing ? `Getting the photos ready first: ${rs.files} of ${rs.total} copied to 06-Ready-for-Aryeo.` : "Getting the photos ready first (06-Ready-for-Aryeo)." };
  if (!rs.ready) return rs.failed ? { error: `06-Ready-for-Aryeo could not be filled (${rs.failed} photo${rs.failed === 1 ? "" : "s"} failed${rs.note ? `: ${rs.note}` : ""}). Press Get them ready again, then Send to Aryeo.` } : { wait: `Getting the photos ready first: ${rs.files} of ${order.length} in 06-Ready-for-Aryeo.` };
  const { listingGallery } = await import("./jobs");
  const listing = await listingGallery(listingId);
  if (!listing) return { wait: "The Aryeo listing could not be read just now; trying again." };
  const want = new Set(order.map((o) => lower(o.deliveryName)));
  const onListing = new Set(listing.entries.map((e) => lower(e.name)));
  const others = listing.entries.filter((e) => !want.has(lower(e.name)));
  if (others.length && !anyway) {
    return { error: `The listing already has ${others.length} photo${others.length === 1 ? "" : "s"} that ${others.length === 1 ? "is" : "are"} not from 06-Ready-for-Aryeo (${others.slice(0, 3).map((e) => e.name).join(", ")}${others.length > 3 ? "…" : ""}). Remove ${others.length === 1 ? "it" : "them"} in Aryeo first, or press Send anyway to add these next to ${others.length === 1 ? "it" : "them"}.` };
  }
  return { items: order.map((o) => ({ photoId: o.photoId, name: o.deliveryName, path: `${rs.folder}/${o.deliveryName}`, uuid: null, tries: 0, error: null, already: onListing.has(lower(o.deliveryName)) })) };
}

/**
 * Start a push for a job. `then` defaults to what the settings' stage says.
 * `anyway` sends even when the listing already holds other photos. When the
 * 06-Ready-for-Aryeo folder is not finished, it is made first (the push waits
 * for it): a job marked as delivering before its folder existed still goes.
 */
export async function requestPush(jobId: string, opts: { by?: string | null; then?: PushRun["then"]; anyway?: boolean; mode?: AryeoPushMode } = {}): Promise<{ ok: boolean; started: boolean; message: string }> {
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
  const built = await buildItems(jobId, project.aryeoListingId, opts.anyway === true);
  if ("error" in built) return { ok: false, started: false, message: built.error };
  if ("wait" in built) {
    // The folder first: start it unless it is already being filled.
    const { requestReady, readyProgress } = await import("./handoff");
    const prog = await readyProgress(jobId).catch(() => null);
    if (!prog?.active) await requestReady(jobId, { force: true, by: opts.by ?? "aryeo-push" }).catch(() => null);
  }
  const then: PushRun["then"] = opts.then ?? (mode === "auto" ? "deliver" : mode === "approve" ? "approval" : "stop");
  const now = new Date().toISOString();
  const items = "items" in built ? built.items : [];
  const all = items.length > 0 && items.every((i) => i.already);
  const next: PushRun = {
    id: randomBytes(4).toString("hex"), listingId: project.aryeoListingId, state: "items" in built ? (all ? "CHECKING" : "SENDING") : "PREPARING", then, items, groupId: null,
    addedAt: all ? now : null, ordered: false, deliveredAt: null, by: opts.by ?? null, startedAt: now, updatedAt: now, finishedAt: null, note: "wait" in built ? built.wait : null, lease: null, anyway: opts.anyway === true,
  };
  if (!(await save(jobId, next, raw))) return { ok: false, started: false, message: "Someone started it a moment ago." };
  const already = items.filter((i) => i.already).length;
  const tail = then === "deliver" ? ", then delivering" : then === "approval" ? ", then waiting for Deliver in Aryeo" : "";
  if (next.state === "PREPARING") {
    await logJobEvent(jobId, opts.by ?? "aryeo-push", `sending to the Aryeo listing${tail}: getting 06-Ready-for-Aryeo ready first`);
    return { ok: true, started: true, message: "Getting the photos ready in 06-Ready-for-Aryeo first, then sending them to the Aryeo listing. The panel shows the progress." };
  }
  await logJobEvent(jobId, opts.by ?? "aryeo-push", `sending ${items.length - already} photo${items.length - already === 1 ? "" : "s"} to the Aryeo listing${already ? ` (${already} already there)` : ""}${tail}`);
  return { ok: true, started: true, message: all ? "Every photo is already on the listing. Checking the order." : `Sending ${items.length - already} photos to the Aryeo listing. The panel shows the progress.` };
}

/** Kyle's "Deliver in Aryeo" on a push that is waiting for it (or a finished upload-only push). */
export async function approvePushDelivery(jobId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const { run, raw } = await load(jobId);
  if (!run) return { ok: false, message: "Nothing has been sent to Aryeo for this job yet." };
  if (run.state === "CONFIRMING" || run.deliveredAt) return { ok: true, message: "Already delivered in Aryeo." };
  if (run.state !== "WAITING" && !(run.state === "DONE" && run.then === "stop")) return { ok: false, message: "The photos are not all on the listing yet. Wait for the upload to finish." };
  const next: PushRun = { ...run, state: "DELIVERING", then: "deliver", by, note: null, finishedAt: null };
  if (!(await save(jobId, next, raw))) return { ok: false, message: "That changed a moment ago. Reload the page." };
  return { ok: true, message: "Delivering in Aryeo now. The listing's customers get Aryeo's usual delivery email." };
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
      const built = await buildItems(jobId, r.listingId, r.anyway === true);
      if ("error" in built) return fail(r, built.error);
      if ("wait" in built) {
        if (Date.now() - Date.parse(r.startedAt) > 45 * 60_000) return fail(r, `06-Ready-for-Aryeo was not ready after 45 minutes (${built.wait}). Press Get them ready again, then Send to Aryeo.`);
        if (built.wait === r.note) return null;
        r.note = built.wait;
        return r;
      }
      r.items = built.items;
      r.note = null;
      const all = r.items.every((i) => i.already);
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
      const uuids = r.items.filter((i) => !i.already && i.uuid).map((i) => i.uuid!);
      if (uuids.length) {
        r.groupId = r.groupId ?? (await W.uploadcareGroup(uuids));
        const page = await W.listingPage(r.listingId);
        await W.attachImages(r.listingId, r.groupId, { agreesToMediaLicense: page.requiresMediaLicense });
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
      const missing = r.items.filter((i) => !names.has(lower(i.name)));
      if (!missing.length) {
        r.state = "ORDERING";
        r.note = null;
        return r;
      }
      if (r.addedAt && Date.now() - Date.parse(r.addedAt) > CHECK_FOR_MS) {
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
      const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true } });
      if (job?.stage === "ON_HOLD") {
        r.state = "WAITING";
        r.note = "Not delivered: the job is on hold. Release the hold, then press Deliver in Aryeo.";
        return r;
      }
      if (job && job.stage !== "DELIVERING" && job.stage !== "DELIVERED") {
        const { startDelivery } = await import("./delivery");
        const g = await startDelivery(jobId, r.by ?? "aryeo-push");
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

/** Cron: start pushes the settings' stage allows, and move every running one on. */
export async function drivePushes(opts: { budgetMs?: number } = {}): Promise<{ started: string[]; moved: string[]; skipped?: string }> {
  const settings = await photoDeliverySettings();
  if (settings.aryeoPush === "off") return { started: [], moved: [], skipped: "sending to Aryeo is switched off" };
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 40_000;
  const started: string[] = [];
  if (settings.aryeoPush === "approve" || settings.aryeoPush === "auto") {
    // Jobs whose 06-Ready-for-Aryeo folder is in place and not sent yet (one new push per pass;
    // requestPush checks the folder is complete and not being refilled).
    const { READY_FOLDER } = await import("./handoff");
    // Also a job someone marked as delivering before its folder existed (a same-day override).
    const jobs = await prisma.photoJob.findMany({
      where: {
        stageChangedAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
        OR: [
          { stage: { in: ["READY", "QC_REVIEW"] }, deliveryPath: { endsWith: READY_FOLDER }, deliveryStagedAt: { not: null } },
          { stage: "DELIVERING", photos: { some: { status: "ACTIVE", sourceKind: "AUTOHDR" } } },
        ],
      },
      orderBy: { stageChangedAt: "desc" },
      select: { id: true },
      take: 15,
    });
    for (const j of jobs) {
      if (started.length >= 1 || Date.now() - t0 > budget / 2) break;
      if ((await load(j.id)).run) continue;
      const r = await requestPush(j.id, { by: "aryeo-push" }).catch(() => null);
      if (r?.started) started.push(j.id);
    }
  }
  const live = await prisma.appSetting.findMany({ where: { key: { startsWith: "photo_aryeo_push:" } }, select: { key: true, value: true }, orderBy: { updatedAt: "asc" }, take: 20 });
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
