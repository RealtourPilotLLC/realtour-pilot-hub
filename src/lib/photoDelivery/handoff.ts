import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { actualFolderPaths } from "@/lib/dropboxFolders";
import { dbx, dropboxCreateFolder, dropboxDelete, dropboxListFolder, dropboxMoveFolder, dropboxUpload } from "@/lib/integrations/dropbox";
import { deliveryOrderFor } from "./delivery";
import { logJobEvent } from "./jobState";
import { photoDeliverySettings } from "./settings";

// ---------------------------------------------------------------------------
// READY FOR ARYEO: THE FINISHED PHOTOS, NUMBERED, IN ONE FOLDER (Oct 14 2026).
//
// Jordan: "when the photos are done going through QC and fixes, and then the
// final QC, that they're able to be downloaded and there's a button to open
// the listing on Aryeo so Kyle can just download them, click the Aryeo button,
// upload them to Aryeo and send them."
//
// The hub copies the finished photos into Dropbox one by one (a zip of the
// whole gallery is too big to stream from a hub function): every photo in the
// delivery order, its CURRENT version (the AI fixes included), named
// "01-Front-Exterior.jpg", "02-Living.jpg", … The deliver panel's first step
// opens the folder (Dropbox's own Download button gives one zip); the second
// opens the listing in Aryeo. Internal only: Dropbox links never go to clients.
//
// COPIED FOR CERTAIN, NO DUPLICATES (Oct 14 2026, Jordan: "the copying to
// dropbox is taking too long can we make sure its actually being copied and
// also that there are not duplicates in the final folder when getting them
// ready again"). 116 W Windsor sat at 24 of 30 for hours: Dropbox's own
// fetch (files/save_url) is a background job, the first version never asked
// how each one ended, and six had failed. Measured live the same afternoon:
// Dropbox's fetch of AutoHDR's links fails often ("download_failed") even
// though the links last six hours, and AutoHDR's byte_size is not the file's
// size (1.16 MB said, 3.08 MB served). So the hub carries the bytes itself:
//   · each photo is fetched from AutoHDR (or Aryeo) and UPLOADED to Dropbox,
//     two at a time ("too many writes" is waited out, not counted as a try); Dropbox's answer gives the stored size, which must
//     equal what was fetched, or it is done again (three tries);
//   · a run is built in a folder of its own ("06-Ready-for-Aryeo - preparing
//     <id>"), so nothing from an earlier press can mix into it, and an upload
//     overwrites, never "(1)" renames;
//   · at the end the folder is listed: every photo there at its size,
//     anything else removed, and ONLY when every photo made it is it swapped
//     in as 06-Ready-for-Aryeo. A run that could not copy them all leaves the
//     folder Kyle has untouched and says which failed;
//   · links come from ONE AutoHDR call per shoot (free: the photos were
//     downloaded once already).
// The run lives in AppSetting "photo_ready_run:<jobId>" (compare-and-swap
// writes, a short lease so the button, the progress bar and the cron never
// drive one run twice). Anyone can move it on: the press itself (after the
// answer), every progress poll, and the cron.
// ---------------------------------------------------------------------------

export const READY_FOLDER = "06-Ready-for-Aryeo";
const PREPARING = ` - preparing `;
const RUN_KEY = (jobId: string) => `photo_ready_run:${jobId}`;
const MAX_TRIES = 3;
const LEASE_MS = 40_000;

export type ReadyItem = {
  photoId: string;
  name: string;
  state: "PENDING" | "COPYING" | "DONE" | "FAILED";
  job: string | null;
  tries: number;
  /** The size AutoHDR says the file is: the copy must match it. */
  bytes: number | null;
  since: string | null;
  error: string | null;
  /** Times Dropbox asked to slow down (not counted as tries). */
  waits?: number;
};
export type ReadyRun = {
  id: string;
  state: "QUEUED" | "COPYING" | "FINISHING" | "DONE";
  folder: string;
  staging: string;
  fingerprint: string;
  by: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  items: ReadyItem[];
  note: string | null;
  lease: { token: string; until: number } | null;
};
export type ReadyProgress = { state: ReadyRun["state"]; active: boolean; total: number; done: number; failed: number; failedNames: string[]; startedAt: string; finishedAt: string | null; note: string | null; folder: string };

type Photo = { id: string; sourceKind: string; sourceUrl: string | null; sourceRef: string | null; dropboxPath: string | null; contentHash: string | null; autohdrVersionUuid: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `xs`, `n` at a time. */
async function pool<T>(xs: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) await fn(xs[i++]);
  }));
}

// ---- the run record ---------------------------------------------------------------------------

async function load(jobId: string): Promise<{ run: ReadyRun | null; raw: string | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: RUN_KEY(jobId) }, select: { value: true } });
  if (!row) return { run: null, raw: null };
  try {
    return { run: JSON.parse(row.value) as ReadyRun, raw: row.value };
  } catch {
    return { run: null, raw: row.value };
  }
}

/** Compare-and-swap: false when someone else wrote the run since `prevRaw` was read. */
async function save(jobId: string, run: ReadyRun, prevRaw: string | null): Promise<string | null> {
  const value = JSON.stringify({ ...run, updatedAt: new Date().toISOString() });
  if (prevRaw == null) {
    try {
      await prisma.appSetting.create({ data: { key: RUN_KEY(jobId), value, updatedBy: "ready-for-aryeo" } });
      return value;
    } catch {
      return null;
    }
  }
  const r = await prisma.appSetting.updateMany({ where: { key: RUN_KEY(jobId), value: prevRaw }, data: { value, updatedBy: "ready-for-aryeo" } });
  return r.count === 1 ? value : null;
}

// ---- what goes in the folder -------------------------------------------------------------------

export async function readyFolderFor(jobId: string): Promise<string | null> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  if (!job) return null;
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } } } });
  if (!project?.client) return null;
  return `${actualFolderPaths({ ...project, client: project.client }).listing}/${READY_FOLDER}`;
}

async function currentSet(jobId: string) {
  const folder = await readyFolderFor(jobId);
  const order = folder ? await deliveryOrderFor(jobId) : [];
  const photos = new Map((await prisma.photoAsset.findMany({ where: { id: { in: order.map((o) => o.photoId) } }, select: { id: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true, contentHash: true, autohdrVersionUuid: true } })).map((p) => [p.id, p as Photo]));
  const fingerprint = createHash("sha256").update(order.map((o) => `${o.deliveryName}:${photos.get(o.photoId)?.autohdrVersionUuid ?? photos.get(o.photoId)?.contentHash ?? ""}`).join("\n")).digest("hex").slice(0, 24);
  return { folder, order, photos, fingerprint };
}

/** Links for the photos to copy: one free AutoHDR call per shoot (re-downloads), Aryeo's own link, or a Dropbox path. */
async function linksFor(items: ReadyItem[]): Promise<Map<string, { url?: string; dropboxPath?: string; bytes?: number | null; error?: string }>> {
  const out = new Map<string, { url?: string; dropboxPath?: string; bytes?: number | null; error?: string }>();
  const photos = await prisma.photoAsset.findMany({ where: { id: { in: items.map((i) => i.photoId) } }, select: { id: true, sourceKind: true, sourceUrl: true, sourceRef: true, dropboxPath: true } });
  const byShoot = new Map<number, { photoId: string; uuid: string }[]>();
  for (const p of photos) {
    if (p.sourceKind === "DROPBOX" && p.dropboxPath) out.set(p.id, { dropboxPath: p.dropboxPath });
    else if (p.sourceKind === "ARYEO" && p.sourceUrl) out.set(p.id, { url: p.sourceUrl });
    else if (p.sourceKind === "AUTOHDR") {
      const [shoot, uuid] = (p.sourceRef ?? "").split("/");
      const n = Number(shoot);
      if (!Number.isFinite(n) || !uuid) { out.set(p.id, { error: "not an AutoHDR photo of the hub" }); continue; }
      (byShoot.get(n) ?? byShoot.set(n, []).get(n)!).push({ photoId: p.id, uuid });
    } else out.set(p.id, { error: "no copy of this photo to take" });
  }
  if (byShoot.size) {
    // One free call per shoot (re-downloads of photos already bought): display.ts.
    const { freshAutohdrUrls } = await import("./display");
    for (const [shoot, list] of byShoot) {
      const got = await freshAutohdrUrls(shoot, list.map((x) => x.uuid));
      for (const x of list) {
        const g = got.get(x.uuid);
        out.set(x.photoId, !g ? { error: "AutoHDR gave no link" } : "error" in g ? { error: g.error } : { url: g.url, bytes: g.bytes });
      }
    }
  }
  return out;
}


/** One try failed: copy it again, or give up after three. Dropbox's "too many writes" (several
 *  uploads into one folder at once) is a wait, not a failure: it does not use up a try. */
function retry(it: ReadyItem, error: string) {
  if (/too_many_write_operations|too_many_requests|\b429\b|retry_after/i.test(error) && (it.waits ?? 0) < 12) {
    it.waits = (it.waits ?? 0) + 1;
    it.error = "Dropbox asked to slow down; trying again";
    it.state = "PENDING";
    return;
  }
  it.tries++;
  it.error = error.slice(0, 160);
  it.job = null;
  it.since = null;
  it.state = it.tries >= MAX_TRIES ? "FAILED" : "PENDING";
}

/** Delete "06-Ready-for-Aryeo - preparing …" folders other than `keep` (earlier presses, superseded). */
async function sweepPreparing(folder: string, keep: string | null) {
  const parent = folder.slice(0, folder.lastIndexOf("/"));
  const entries = await dropboxListFolder(parent).catch(() => []);
  for (const e of entries) {
    // Dropbox paths are case-insensitive: compare that way.
    if (e.tag !== "folder" || !e.name.toLowerCase().startsWith(`${READY_FOLDER}${PREPARING}`.toLowerCase())) continue;
    if (keep && e.path.toLowerCase() === keep.toLowerCase()) continue;
    await dropboxDelete(e.path).catch(() => {});
  }
}

// ---- moving a run on ---------------------------------------------------------------------------

/** One step. Returns the changed run, or null when it is only waiting on Dropbox. */
async function step(jobId: string, run: ReadyRun): Promise<ReadyRun | null> {
  const r: ReadyRun = JSON.parse(JSON.stringify(run));
  if (r.state === "QUEUED") {
    await sweepPreparing(r.folder, null);
    await dropboxDelete(r.staging).catch(() => {});
    await dropboxCreateFolder(r.staging).catch(() => {});
    r.state = "COPYING";
    return r;
  }
  if (r.state === "COPYING") {
    // A photo's history is being copied (its current version is switched for a moment): wait.
    const { versionProbeActive } = await import("./versions");
    if (await versionProbeActive(jobId)) return null;
    // The hub fetches each photo and uploads it: confirmed on the spot, at its size.
    const batch = r.items.filter((i) => i.state === "PENDING" || i.state === "COPYING").slice(0, 6);
    if (!batch.length) { r.state = "FINISHING"; return r; }
    const links = await linksFor(batch);
    // Two at a time: Dropbox locks a folder per write, more just queues "too many writes".
    if (batch.some((i) => (i.waits ?? 0) > 0)) await sleep(1_200);
    await pool(batch, 2, async (it) => {
      const l = links.get(it.photoId);
      const path = `${r.staging}/${it.name}`;
      if (!l || l.error) { retry(it, l?.error ?? "no link"); return; }
      try {
        if (l.dropboxPath) {
          await dbx("files/copy_v2", { from_path: l.dropboxPath, to_path: path, autorename: false });
          it.state = "DONE"; it.error = null;
          return;
        }
        const res = await fetch(l.url!, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`the photo link answered ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length < 1024) throw new Error(`the photo came back ${bytes.length} bytes`);
        const up = await dropboxUpload(path, bytes, { overwrite: true, autorename: false });
        if (up.size != null && up.size !== bytes.length) throw new Error(`Dropbox stored ${up.size} bytes of ${bytes.length}`);
        it.bytes = bytes.length;
        it.state = "DONE"; it.error = null; it.job = null;
      } catch (e) {
        retry(it, (e as Error).message);
      }
    });
    if (!r.items.some((i) => i.state === "PENDING" || i.state === "COPYING")) r.state = "FINISHING";
    return r;
  }
  if (r.state === "FINISHING") {
    // 3. Check the folder itself: every photo there, at its size; nothing else.
    const files = (await dropboxListFolder(r.staging)).filter((e) => e.tag === "file");
    const want = new Map(r.items.map((i) => [i.name.toLowerCase(), i]));
    for (const f of files) {
      if (!want.has(f.name.toLowerCase())) await dropboxDelete(f.path).catch(() => {});
    }
    const have = new Map(files.map((f) => [f.name.toLowerCase(), f]));
    let reset = false;
    for (const it of r.items) {
      if (it.state !== "DONE") continue;
      const f = have.get(it.name.toLowerCase());
      if (!f) { retry(it, "not in the folder after the copy"); reset ||= (it.state as ReadyItem["state"]) === "PENDING"; continue; }
      if (it.bytes && f.size != null && f.size !== it.bytes) {
        await dropboxDelete(f.path).catch(() => {});
        retry(it, `copied at ${f.size} bytes, expected ${it.bytes}`);
        reset ||= (it.state as ReadyItem["state"]) === "PENDING";
      }
    }
    if (reset) { r.state = "COPYING"; return r; }
    const failedNow = r.items.filter((i) => i.state === "FAILED");
    if (failedNow.length) {
      // Never swap in a short folder: what Kyle has stays as it is.
      await dropboxDelete(r.staging).catch(() => {});
      await logJobEvent(jobId, "ready-for-aryeo", `Could not get all ${r.items.length} photos ready: ${failedNow.length} failed (${failedNow.slice(0, 5).map((i) => `${i.name}: ${i.error ?? "?"}`).join("; ")}). The folder was left as it was.`, { fingerprint: r.fingerprint, failed: failedNow.map((i) => i.name), run: r.id, swapped: false });
      r.state = "DONE";
      r.finishedAt = new Date().toISOString();
      r.note = `${failedNow.length} of ${r.items.length} could not be copied (${failedNow.slice(0, 3).map((i) => i.name).join(", ")}), so the folder was not replaced. Press Get them ready again.`;
      return r;
    }
    // 4. Swap it in: the old folder out, this one renamed in.
    await dropboxDelete(r.folder).catch(() => {});
    let moved = await dropboxMoveFolder(r.staging, r.folder).catch(() => false);
    if (!moved) {
      await dropboxDelete(r.folder).catch(() => {});
      moved = await dropboxMoveFolder(r.staging, r.folder).catch(() => false);
    }
    if (!moved) { r.note = "Dropbox would not swap the folder in yet; trying again."; return r; }
    await sweepPreparing(r.folder, null);
    const done = r.items.filter((i) => i.state === "DONE").length;
    const failed: ReadyItem[] = [];
    await prisma.photoJob.update({ where: { id: jobId }, data: { deliveryPath: r.folder, deliveryStagedAt: new Date() } });
    await logJobEvent(jobId, "ready-for-aryeo", `${done} of ${r.items.length} photo${r.items.length === 1 ? "" : "s"} in ${READY_FOLDER}, numbered in delivery order, each one checked in the folder${failed.length ? ` (${failed.length} could not be copied: ${failed.slice(0, 5).map((i) => i.name).join(", ")})` : ""}${r.by ? ` (asked by ${r.by})` : ""}`, { fingerprint: r.fingerprint, staged: done, failed: failed.map((i) => i.name), run: r.id });
    r.state = "DONE";
    r.finishedAt = new Date().toISOString();
    r.note = failed.length ? `${failed.length} could not be copied: ${failed.map((i) => i.name).join(", ")}. Press Get them ready again to try them again.` : null;
    return r;
  }
  return null;
}

/**
 * Start (or restart) getting a job's photos ready. Returns at once; the run
 * is moved on by advanceReady. Without `force`, a run that is already going
 * or already done for the same photos and versions is left as it is.
 */
/**
 * The names the last finished Ready run gave each photo ("01-Front-Exterior.jpg"
 * → photo id), lower-cased: what Kyle uploads to Aryeo, so the sync can carry
 * each AutoHDR photo over to its listing copy in place (jobs.ts adoptListing).
 */
export async function readyNamesFor(jobId: string): Promise<Map<string, string>> {
  const { run } = await load(jobId);
  if (!run || run.state !== "DONE") return new Map();
  return new Map(run.items.filter((i) => i.state === "DONE").map((i) => [i.name.toLowerCase(), i.photoId]));
}

/** The fingerprint a Ready run copies (photos, order and each photo's version): drills and diagnostics. */
export async function readyFingerprintFor(jobId: string): Promise<string> {
  return (await currentSet(jobId)).fingerprint;
}

export async function requestReady(jobId: string, opts: { force?: boolean; by?: string | null } = {}): Promise<{ ok: boolean; started: boolean; message: string; total: number }> {
  // Oct 14 2026 (huddle finding 3): a change made in AutoHDR's own editor
  // (Perspective Off, Crop & Tilt, a restore there) is read first, so the
  // folder gets the version AutoHDR shows, not the one the hub last saw.
  const { syncHeads } = await import("./versions");
  await syncHeads(jobId, { by: opts.by ?? "ready-for-aryeo" }).catch(() => null);
  const cur = await currentSet(jobId);
  if (!cur.folder) return { ok: false, started: false, message: "This job has no Dropbox folder.", total: 0 };
  if (!cur.order.length) return { ok: false, started: false, message: "No photos in the delivery yet.", total: 0 };
  const { run, raw } = await load(jobId);
  // Same photos and versions: leave it. A run that could not copy them all is
  // retried by a person's press, never by the cron every five minutes.
  if (run && !opts.force && run.fingerprint === cur.fingerprint) {
    if (run.state !== "DONE") return { ok: true, started: false, message: "Already getting them ready.", total: run.items.length };
    return { ok: true, started: false, message: run.items.some((i) => i.state === "FAILED") ? "The last try could not copy them all. Press Get them ready again." : "Already up to date.", total: run.items.length };
  }
  const id = randomBytes(4).toString("hex");
  const now = new Date().toISOString();
  const next: ReadyRun = {
    id, state: "QUEUED", folder: cur.folder, staging: `${cur.folder}${PREPARING}${id}`, fingerprint: cur.fingerprint, by: opts.by ?? null,
    startedAt: now, updatedAt: now, finishedAt: null, note: null, lease: null,
    items: cur.order.map((o) => ({ photoId: o.photoId, name: o.deliveryName, state: "PENDING", job: null, tries: 0, bytes: null, since: null, error: null })),
  };
  // A press while another run holds the lease takes over: the old run's
  // folder is swept away by this one, and its writes fail the swap check.
  const saved = await save(jobId, next, raw);
  if (!saved) return { ok: false, started: false, message: "Someone pressed it a moment ago. It is already getting ready.", total: cur.order.length };
  return { ok: true, started: true, message: `Getting the ${cur.order.length} photos ready for Aryeo.`, total: cur.order.length };
}

/** Move a job's run on, up to `budgetMs`. Safe to call from anywhere: one driver at a time. */
export async function advanceReady(jobId: string, opts: { budgetMs?: number } = {}): Promise<ReadyProgress | null> {
  const budget = opts.budgetMs ?? 20_000;
  const t0 = Date.now();
  const token = randomBytes(6).toString("hex");
  let { run, raw } = await load(jobId);
  if (!run || run.state === "DONE") return run ? progressOf(run) : null;
  if (run.lease && run.lease.until > Date.now() && run.lease.token !== token) return progressOf(run); // someone else is on it
  const leased = await save(jobId, { ...run, lease: { token, until: Date.now() + LEASE_MS } }, raw);
  if (!leased) return progressOf(run);
  raw = leased;
  run = JSON.parse(leased) as ReadyRun;
  try {
    // At least one step, however small the budget (a progress poll gives a few seconds).
    for (let first = true; first || Date.now() - t0 < budget; first = false) {
      const next = await step(jobId, run!).catch((e) => {
        console.warn("ready-for-aryeo: step failed", jobId, (e as Error).message.slice(0, 160));
        return null;
      });
      if (next) {
        next.lease = next.state === "DONE" ? null : { token, until: Date.now() + LEASE_MS };
        const s = await save(jobId, next, raw);
        if (!s) return progressOf(next); // a new press replaced this run
        raw = s;
        run = JSON.parse(s) as ReadyRun;
        if (run.state === "DONE") break;
        continue;
      }
      await sleep(1_500); // waiting on Dropbox
      const fresh = await load(jobId);
      if (fresh.raw !== raw) break; // replaced while waiting
    }
  } finally {
    const end = await load(jobId);
    if (end.run && end.run.lease?.token === token) await save(jobId, { ...end.run, lease: null }, end.raw);
  }
  const final = await load(jobId);
  return final.run ? progressOf(final.run) : null;
}

function progressOf(run: ReadyRun): ReadyProgress {
  const failed = run.items.filter((i) => i.state === "FAILED");
  return {
    state: run.state,
    active: run.state !== "DONE",
    total: run.items.length,
    done: run.items.filter((i) => i.state === "DONE").length,
    failed: failed.length,
    failedNames: failed.map((i) => i.name),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    note: run.note,
    folder: run.folder,
  };
}

export async function readyProgress(jobId: string): Promise<ReadyProgress | null> {
  const { run } = await load(jobId);
  return run ? progressOf(run) : null;
}

/** For callers that want it done in one go (the drills, a script): start, then drive. */
export async function stageForAryeo(jobId: string, opts: { force?: boolean; by?: string; budgetMs?: number } = {}): Promise<{ ok: boolean; message: string; staged: number; folder: string | null }> {
  const req = await requestReady(jobId, { force: opts.force, by: opts.by });
  if (!req.ok) return { ok: false, message: req.message, staged: 0, folder: null };
  if (!req.started) {
    const p = await readyProgress(jobId);
    if (p?.active) await advanceReady(jobId, { budgetMs: opts.budgetMs ?? 45_000 });
    return { ok: true, message: req.message, staged: 0, folder: p?.folder ?? null };
  }
  const p = await advanceReady(jobId, { budgetMs: opts.budgetMs ?? 45_000 });
  return { ok: !!p && p.done > 0, message: p?.active ? `${p.done} of ${p.total} copied so far.` : p?.failed ? p.note ?? "Some could not be copied." : `${p?.done ?? 0} photos ready in ${READY_FOLDER}.`, staged: p?.done ?? 0, folder: p?.folder ?? null };
}

/** How the folder is doing, for the deliver panel. */
export async function readyFolderState(jobId: string, expected: number): Promise<{ folder: string; files: number; ready: boolean; stagedAt: string | null; preparing: boolean; total: number; failed: number; note: string | null } | null> {
  const [job, prog] = await Promise.all([prisma.photoJob.findUnique({ where: { id: jobId }, select: { deliveryPath: true, deliveryStagedAt: true } }), readyProgress(jobId)]);
  if (prog?.active) return { folder: prog.folder, files: prog.done, ready: false, stagedAt: job?.deliveryStagedAt?.toISOString() ?? null, preparing: true, total: prog.total, failed: prog.failed, note: prog.note };
  if (!job?.deliveryPath || !job.deliveryPath.endsWith(READY_FOLDER)) return prog ? { folder: prog.folder, files: 0, ready: false, stagedAt: null, preparing: false, total: prog.total, failed: prog.failed, note: prog.note } : null;
  // Done: count what is really in the folder (one list call), so a file removed by hand shows.
  const files = await dropboxListFolder(job.deliveryPath).then((es) => es.filter((e) => e.tag === "file").length).catch(() => prog?.done ?? 0);
  const total = prog?.total ?? expected;
  return { folder: job.deliveryPath, files, ready: expected > 0 && files >= expected && (prog ? prog.failed === 0 : true), stagedAt: job.deliveryStagedAt?.toISOString() ?? null, preparing: false, total, failed: prog?.failed ?? 0, note: prog?.note ?? null };
}

/** Cron: start runs for hub shoots that are done with QC and fixes (and after a change), and move every run on. */
export async function stageReadyJobs(opts: { max?: number; budgetMs?: number } = {}): Promise<{ started: string[]; moved: string[]; skipped?: string }> {
  const settings = await photoDeliverySettings();
  if (!settings.enabled || !settings.showAutohdrPhotos) return { started: [], moved: [], skipped: "showing AutoHDR photos is switched off" };
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 120_000;
  const started: string[] = [];
  const jobs = await prisma.photoJob.findMany({
    where: { stage: { in: ["QC_REVIEW", "READY"] }, photos: { some: { status: "ACTIVE", sourceKind: "AUTOHDR" } }, stageChangedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    select: { id: true },
    take: 10,
  });
  for (const j of jobs) {
    if (started.length >= (opts.max ?? 2)) break;
    // Done = nothing queued or running, the second look finished, and the photos downloaded.
    const busy = await prisma.photoFixOperation.count({ where: { jobId: j.id, status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
    const looking = await prisma.photoQcFinding.count({ where: { jobId: j.id, status: "OPEN", source: "AHDR", arbitration: "NOT_REQUIRED" } });
    const notShown = await prisma.photoAsset.count({ where: { jobId: j.id, status: "ACTIVE", sourceKind: "AUTOHDR", sourceUrl: null } });
    const planned = settings.autoFix ? await prisma.photoJobEvent.count({ where: { jobId: j.id, actor: "auto-fix" } }) : 1;
    if (busy || looking || !planned || (notShown > 0 && !(await anyDownloaded(j.id)))) continue;
    const r = await requestReady(j.id).catch(() => null);
    if (r?.started) started.push(j.id);
  }
  // Every run still going, oldest first.
  const live = await prisma.appSetting.findMany({ where: { key: { startsWith: "photo_ready_run:" }, NOT: { value: { contains: '"state":"DONE"' } } }, select: { key: true }, orderBy: { updatedAt: "asc" }, take: 10 });
  const moved: string[] = [];
  for (const row of live) {
    const left = budget - (Date.now() - t0);
    if (left < 5_000) break;
    const jobId = row.key.slice("photo_ready_run:".length);
    // A share of the time each, so every shoot moves on in one pass.
    await advanceReady(jobId, { budgetMs: Math.min(left, Math.max(8_000, Math.floor(budget / Math.max(1, live.length)))) }).catch(() => null);
    moved.push(jobId);
  }
  return { started, moved };
}

async function anyDownloaded(jobId: string): Promise<boolean> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  const b = job ? await prisma.photoIntakeBatch.findFirst({ where: { projectId: job.projectId, state: "DONE" }, select: { photosJson: true } }) : null;
  return !!b?.photosJson?.includes('"downloaded":true');
}
