import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { actualFolderPaths } from "@/lib/dropboxFolders";
import { dropboxListFolder, dropboxTemporaryLink } from "@/lib/integrations/dropbox";
import { autohdr, autohdrConfigured, AutohdrError, type AutohdrPhotoshoot } from "@/lib/integrations/autohdr";
import { photoDeliverySettings } from "./settings";
import { logJobEvent } from "./jobState";
import { alertOwnerAndKyle } from "./notifyOps";
import { shootMatchesStreet } from "./autohdrLink";

// ---------------------------------------------------------------------------
// THE HUB SENDS THE RAWS TO AUTOHDR (Oct 14 2026).
//
// Jordan: "from now on, any jobs uploaded to Dropbox and completed uploading I
// want sent to autoHDR using our current settings and then run through QC all
// automatically, and I want it to detect file uploads to Dropbox later and
// then send those for editing too." AutoHDR's own Dropbox watcher stopped and
// was never reconnected; until tonight Kyle added each shoot by hand.
//
// HOW (all from AutoHDR's published contract, docs/photo-delivery):
//   · POST /v1/photoshoots/from-urls with a Dropbox temporary link per raw
//     file; no model ids or enhancements, so the account defaults apply.
//     House models: "uploading and processing are free — credits come off
//     when you download (one per photo, re-downloads free)". Measured Oct 14:
//     Ridley Creek's 78 photos cost exactly 78 credits, at 1 a photo, so the
//     account default is a house model (creator models cost 2-5 and bill when
//     processing finishes).
//   · commit until 202 (409 files_not_landed = not fetched yet, try again;
//     409 conflict = already committed), then poll status to success.
//   · no add-files endpoint: files that arrive later become their own shoot,
//     "<folder> (more photos N)".
//
// WHEN a folder counts as uploaded: the photographer pressed Submit
// (debriefSubmittedAt) and the file list has not changed for 10 minutes; a
// folder nobody submitted waits 30 minutes; a bracket count that is not a
// multiple of 5 (still uploading?) waits 45; files added later wait 20.
//
// NEVER TWICE. Before sending, the hub looks for a shoot someone already made
// for the street (Kyle adds shoots by hand; Ridley Creek was one, Oct 13):
// one found = LINKED, nothing sent. A create whose reply was lost is looked
// up, never repeated blindly. A file is sent once (by Dropbox id and content
// hash), whatever later happens to its batch.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const SETTLE_SUBMITTED_MS = 10 * MIN;
const SETTLE_UNSUBMITTED_MS = 30 * MIN;
const SETTLE_ODD_BRACKETS_MS = 45 * MIN;
const SETTLE_LATER_MS = 20 * MIN;
const MAX_COMMIT_ATTEMPTS = 36;
const SLOW_AFTER_MS = 3 * 60 * MIN;
const PHOTO_TYPES = ["PHOTOS", "DRONE", "TWILIGHT"];
const IMG_RE = /\.(jpe?g|png|tiff?|heic|dng|arw|cr2|cr3|nef|raf|orf|rw2)$/i;
const RAW_EXT = /\.(dng|arw|cr2|cr3|nef|raf|orf|rw2)$/i;
export const DRONE_RE = /^dji|dji[_-]|drone|mavic|air ?2|^m3[_-]/i;

export type IntakeFile = { id: string | null; name: string; path: string; size: number | null; hash: string | null };

/**
 * The files AutoHDR should get from one listing. Pure. A JPEG and a raw of
 * the same frame (a camera set to RAW+JPEG, a DJI DNG) send the JPEG only;
 * two copies with one content hash send one.
 */
export function eligibleFiles(entries: { name: string; tag: string; path: string; id: string | null; size?: number | null; contentHash?: string | null }[]): IntakeFile[] {
  const files = entries.filter((e) => e.tag === "file" && IMG_RE.test(e.name) && (e.size == null || e.size > 20_000));
  const jpegStems = new Set(files.filter((f) => !RAW_EXT.test(f.name)).map((f) => f.path.toLowerCase().replace(/\.[a-z0-9]+$/, "")));
  const seenHash = new Set<string>();
  const out: IntakeFile[] = [];
  for (const f of files) {
    if (RAW_EXT.test(f.name) && jpegStems.has(f.path.toLowerCase().replace(/\.[a-z0-9]+$/, ""))) continue;
    if (f.contentHash) {
      if (seenHash.has(f.contentHash)) continue;
      seenHash.add(f.contentHash);
    }
    out.push({ id: f.id, name: f.name, path: f.path, size: f.size ?? null, hash: f.contentHash ?? null });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function filesFingerprint(files: IntakeFile[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.id ?? f.path}\u0000${f.size ?? ""}\u0000${f.hash ?? ""}\n`);
  return h.digest("hex").slice(0, 32);
}

/** Finished photos the files should make: bracket sets of 5, drone frames single. */
export function expectedPhotosFor(files: IntakeFile[]): number {
  const drone = files.filter((f) => DRONE_RE.test(f.name)).length;
  return Math.round((files.length - drone) / 5) + drone;
}

/** How long a batch's exact file set must stay unchanged before it is sent. Pure. */
export function settleMsFor(input: { batchNo: number; submitted: boolean; files: IntakeFile[] }): number {
  if (input.batchNo > 1) return SETTLE_LATER_MS;
  const nonDrone = input.files.filter((f) => !DRONE_RE.test(f.name)).length;
  const base = input.submitted ? SETTLE_SUBMITTED_MS : SETTLE_UNSUBMITTED_MS;
  return nonDrone % 5 === 0 ? base : Math.max(base, SETTLE_ODD_BRACKETS_MS);
}

/** Unique file names inside one shoot (AutoHDR dedupes on the filename). */
function shootFilenames(files: IntakeFile[], rawRoot: string): string[] {
  const used = new Set<string>();
  const root = rawRoot.toLowerCase().replace(/\/+$/, "");
  return files.map((f) => {
    let name = f.name;
    if (used.has(name.toLowerCase())) {
      const rel = f.path.toLowerCase().startsWith(root + "/") ? f.path.slice(root.length + 1) : f.path;
      name = rel.replace(/[\\/]+/g, "_");
    }
    for (let n = 2; used.has(name.toLowerCase()); n++) name = f.name.replace(/(\.[a-z0-9]+)$/i, `_${n}$1`);
    used.add(name.toLowerCase());
    return name;
  });
}

const parseFiles = (json: string | null | undefined): IntakeFile[] => {
  try {
    const a = JSON.parse(json ?? "[]") as IntakeFile[];
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

type Project = {
  id: string;
  title: string;
  addressLine: string | null;
  shootDate: Date | null;
  createdAt: Date;
  dropboxFolder: string | null;
  debriefSubmittedAt: Date | null;
  uploadedAt: Date | null;
  deliveredAt: Date | null;
  client: { name: string };
};

const streetOf = (p: { addressLine: string | null; title: string }) => (p.addressLine || p.title).split(",")[0].trim();

async function jobIdFor(projectId: string): Promise<string | null> {
  return (await prisma.photoJob.findUnique({ where: { projectId }, select: { id: true } }))?.id ?? null;
}

async function note(projectId: string, action: string, data?: Record<string, unknown>) {
  const jobId = await jobIdFor(projectId);
  if (jobId) await logJobEvent(jobId, "autohdr-intake", action, data ?? null);
}

export type IntakeSummary = {
  skipped?: string;
  watched: number;
  waiting: number;
  sent: string[];
  linked: string[];
  committed: number;
  done: string[];
  failed: string[];
  errors: string[];
};

// Every batch sent and finished (or linked, or failed): the raws folder is
// only listed again for files added later, hourly, then every 6 hours once
// the last batch is 2 days old. The time sits on the newest batch's nextCheckAt.
const SETTLED = ["DONE", "LINKED", "FAILED"];
const RELIST_MS = 60 * MIN;
const RELIST_LATE_MS = 6 * 60 * MIN;

/**
 * One bounded pass: move in-flight batches on, then look for new uploads.
 * The cron passes `listShoots` so the link step and this one share one list.
 */
export async function driveIntake(opts: { budgetMs: number; now?: Date; listShoots?: () => Promise<AutohdrPhotoshoot[]> }): Promise<IntakeSummary> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const out: IntakeSummary = { watched: 0, waiting: 0, sent: [], linked: [], committed: 0, done: [], failed: [], errors: [] };
  const settings = await photoDeliverySettings();
  if (!settings.enabled || !settings.autoSubmit) return { ...out, skipped: "sending to AutoHDR is switched off" };
  if (!(await autohdrConfigured())) return { ...out, skipped: "AutoHDR API not connected" };
  const left = () => opts.budgetMs - (Date.now() - started);

  // 1. In flight: commit, poll, look up.
  const live = await prisma.photoIntakeBatch.findMany({
    where: { state: { in: ["LANDING", "PROCESSING", "UNCERTAIN", "SENDING"] }, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
    orderBy: { updatedAt: "asc" },
    select: { id: true, state: true, address: true },
    take: 20,
  });
  let shoots: AutohdrPhotoshoot[] | null = null;
  const listShoots = async () => (shoots ??= opts.listShoots ? await opts.listShoots() : await autohdr.listPhotoshoots());
  for (const b of live) {
    if (left() < 15_000) break;
    try {
      if (b.state === "LANDING") {
        if (await tryCommit(b.id, now)) out.committed++;
      } else if (b.state === "PROCESSING") {
        const r = await pollProcessing(b.id, now);
        if (r === "done") out.done.push(b.address ?? b.id);
        if (r === "failed") out.failed.push(b.address ?? b.id);
      } else {
        await resolveUncertain(b.id, now, await listShoots());
      }
    } catch (e) {
      out.errors.push(`${b.address ?? b.id}: ${(e as Error).message.slice(0, 160)}`);
      await prisma.photoIntakeBatch.update({ where: { id: b.id }, data: { lastError: (e as Error).message.slice(0, 300), nextCheckAt: new Date(now.getTime() + 5 * MIN) } }).catch(() => {});
    }
  }

  // 2. New and later uploads.
  const since = new Date(Math.max(Date.parse(settings.autoSubmitFrom), now.getTime() - 10 * 86_400_000));
  const projects: Project[] = await prisma.project.findMany({
    where: {
      shootDate: { gte: since, lte: now },
      status: { not: "CANCELLED" },
      OR: [{ debriefSubmittedAt: { not: null } }, { uploadedAt: { not: null } }],
      deliverables: { some: { removedFromOrderAt: null, waivedAt: null, type: { in: PHOTO_TYPES as never[] } } },
    },
    orderBy: { shootDate: "asc" },
    select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, debriefSubmittedAt: true, uploadedAt: true, deliveredAt: true, client: { select: { name: true } } },
    take: 60,
  });
  const batchRows = await prisma.photoIntakeBatch.findMany({ where: { projectId: { in: projects.map((p) => p.id) } }, orderBy: { batchNo: "asc" }, select: { id: true, projectId: true, state: true, nextCheckAt: true, doneAt: true, seenAt: true } });
  let sentThisPass = 0;
  for (const p of projects) {
    if (left() < 20_000) break;
    const mine = batchRows.filter((b) => b.projectId === p.id);
    const last = mine.at(-1);
    const settled = !!last && mine.every((b) => SETTLED.includes(b.state));
    if (settled && last.nextCheckAt && last.nextCheckAt > now) continue;
    out.watched++;
    try {
      const r = await watchProject(p, now, { canSend: sentThisPass < 2 && left() > 60_000, listShoots });
      if (r === "waiting") out.waiting++;
      if (r === "sent") { sentThisPass++; out.sent.push(streetOf(p)); }
      if (r === "linked") out.linked.push(streetOf(p));
      if (settled && r === "nothing") {
        const age = now.getTime() - (last.doneAt ?? last.seenAt).getTime();
        await prisma.photoIntakeBatch.update({ where: { id: last.id }, data: { nextCheckAt: new Date(now.getTime() + (age > 48 * 60 * MIN ? RELIST_LATE_MS : RELIST_MS)) } });
      }
    } catch (e) {
      out.errors.push(`${streetOf(p)}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  return out;
}

type WatchResult = "nothing" | "waiting" | "sent" | "linked" | "error";

async function watchProject(p: Project, now: Date, ctx: { canSend: boolean; listShoots: () => Promise<AutohdrPhotoshoot[]> }): Promise<WatchResult> {
  const batches = await prisma.photoIntakeBatch.findMany({ where: { projectId: p.id }, orderBy: { batchNo: "asc" }, select: { id: true, batchNo: true, state: true, fingerprint: true, seenAt: true, filesJson: true } });
  // A delivered job's first upload was edited some other way: never sent (a
  // job can be delivered in Aryeo before the project row says so).
  if (!batches.some((b) => b.state !== "WAITING")) {
    const job = await prisma.photoJob.findUnique({ where: { projectId: p.id }, select: { stage: true } });
    if (p.deliveredAt || (job && ["DELIVERED", "DELIVERING"].includes(job.stage))) {
      if (batches.length) await prisma.photoIntakeBatch.deleteMany({ where: { projectId: p.id, state: "WAITING" } });
      return "nothing";
    }
  }
  const rawPath = actualFolderPaths(p).rawPhotos;
  const entries = await dropboxListFolder(rawPath, { recursive: true }).catch(() => null);
  if (!entries) return "error"; // unreadable is not empty
  const all = eligibleFiles(entries);
  // A file belongs to the first batch that listed it (any state but WAITING).
  const claimed = batches.filter((b) => b.state !== "WAITING").flatMap((b) => parseFiles(b.filesJson));
  const claimedIds = new Set(claimed.map((f) => f.id).filter(Boolean));
  const claimedHashes = new Set(claimed.map((f) => f.hash).filter(Boolean));
  const fresh = all.filter((f) => !(f.id && claimedIds.has(f.id)) && !(f.hash && claimedHashes.has(f.hash)));
  const waiting = batches.find((b) => b.state === "WAITING") ?? null;
  if (!fresh.length) {
    if (waiting) await prisma.photoIntakeBatch.delete({ where: { id: waiting.id } }).catch(() => {});
    return "nothing";
  }
  const fp = filesFingerprint(fresh);
  if (!waiting) {
    const batchNo = (batches.at(-1)?.batchNo ?? 0) + 1;
    await prisma.photoIntakeBatch
      .create({ data: { projectId: p.id, batchNo, rawPath, filesJson: JSON.stringify(fresh), fileCount: fresh.length, fingerprint: fp, expectedPhotos: expectedPhotosFor(fresh), seenAt: now } })
      .catch((e: unknown) => ((e as { code?: string }).code === "P2002" ? null : Promise.reject(e)));
    await note(p.id, `raws seen for AutoHDR batch ${batchNo}: ${fresh.length} files (waiting for the upload to settle)`);
    return "waiting";
  }
  if (waiting.fingerprint !== fp) {
    await prisma.photoIntakeBatch.update({ where: { id: waiting.id }, data: { filesJson: JSON.stringify(fresh), fileCount: fresh.length, fingerprint: fp, expectedPhotos: expectedPhotosFor(fresh), seenAt: now, rawPath } });
    return "waiting";
  }
  const settle = settleMsFor({ batchNo: waiting.batchNo, submitted: !!p.debriefSubmittedAt, files: fresh });
  if (now.getTime() - waiting.seenAt.getTime() < settle) return "waiting";
  if (!ctx.canSend) return "waiting";
  return sendBatch(waiting.id, p, fresh, now, ctx.listShoots);
}

async function sendBatch(batchId: string, p: Project, files: IntakeFile[], now: Date, listShoots: () => Promise<AutohdrPhotoshoot[]>): Promise<WatchResult> {
  const batch = await prisma.photoIntakeBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.state !== "WAITING") return "nothing";
  const folderName = actualFolderPaths(p).listing.split("/").filter(Boolean).pop() ?? streetOf(p);
  const street = streetOf(p);
  const ours = new Set((await prisma.photoIntakeBatch.findMany({ where: { projectId: p.id, photoshootId: { not: null } }, select: { photoshootId: true } })).map((b) => b.photoshootId));
  const lastSent = (await prisma.photoIntakeBatch.findFirst({ where: { projectId: p.id, sentAt: { not: null } }, orderBy: { sentAt: "desc" }, select: { sentAt: true } }))?.sentAt ?? null;

  // Someone already made a shoot for this street: never edit (or pay) twice.
  const after = batch.batchNo === 1 ? (p.shootDate ? p.shootDate.getTime() - 12 * 60 * MIN : 0) : (lastSent?.getTime() ?? 0);
  const existing = (await listShoots()).filter((s) => !ours.has(s.photoshoot_id) && shootMatchesStreet(s.address, street) && (!s.created_at || Date.parse(s.created_at) >= after));
  if (existing.length) {
    const s = existing[0];
    await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { state: "LINKED", photoshootId: s.photoshoot_id, address: s.address ?? null, lastError: null } });
    if (batch.batchNo === 1) {
      const jobId = await jobIdFor(p.id);
      if (jobId) await prisma.photoJob.updateMany({ where: { id: jobId, autohdrPhotoshootId: null }, data: { autohdrPhotoshootId: s.photoshoot_id, autohdrShootName: s.address ?? null, autohdrLinkedAt: now, autohdrCreatedAt: s.created_at ? new Date(s.created_at) : null } });
    }
    await note(p.id, `not sent to AutoHDR: a shoot for this street is already there ("${s.address ?? s.photoshoot_id}")`, { photoshootId: s.photoshoot_id, files: files.length });
    return "linked";
  }

  // Links first (nothing is claimed until they all exist): 4 hours each.
  const names = shootFilenames(files, batch.rawPath);
  const links: string[] = new Array(files.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, files.length) }, async () => {
      while (next < files.length) {
        const i = next++;
        links[i] = await dropboxTemporaryLink(files[i].path);
      }
    }),
  );
  const address = batch.batchNo === 1 ? folderName : `${folderName} (more photos ${batch.batchNo})`;
  const balance = await autohdr.credits().then((c) => c.credit_balance).catch(() => null);
  // The claim: only one writer sends this exact file set.
  const claim = await prisma.photoIntakeBatch.updateMany({ where: { id: batchId, state: "WAITING", fingerprint: batch.fingerprint }, data: { state: "SENDING", sentAt: now, address, balanceAtSend: balance, lastError: null, nextCheckAt: new Date(now.getTime() + 10 * MIN) } });
  if (claim.count !== 1) return "nothing";
  let created: { job_id: string; photoshoot_id: number };
  try {
    created = await autohdr.createFromUrls({ address, files: files.map((_, i) => ({ download_url: links[i], filename: names[i], kind: "raw" as const })) });
  } catch (e) {
    const err = e as AutohdrError;
    if (err instanceof AutohdrError && err.code === "uncertain") {
      await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { state: "UNCERTAIN", lastError: err.message.slice(0, 300), nextCheckAt: new Date(now.getTime() + 2 * MIN) } });
      await note(p.id, "AutoHDR create: the reply was lost; looking it up before anything is sent again");
      return "error";
    }
    await failBatch(batchId, p.id, address, `AutoHDR refused the shoot: ${(e as Error).message.slice(0, 240)}`);
    return "error";
  }
  await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { state: "LANDING", photoshootId: created.photoshoot_id, ingestJobId: created.job_id, nextCheckAt: now } });
  if (batch.batchNo === 1) {
    const jobId = await jobIdFor(p.id);
    if (jobId) await prisma.photoJob.update({ where: { id: jobId }, data: { autohdrPhotoshootId: created.photoshoot_id, autohdrShootName: address, autohdrLinkedAt: now, autohdrCreatedAt: now } });
  }
  await note(p.id, `sent to AutoHDR: "${address}", ${files.length} files (about ${expectedPhotosFor(files)} photos), shoot ${created.photoshoot_id}`, { photoshootId: created.photoshoot_id, files: files.length, balance });
  await alertOwnerAndKyle({
    kind: "photo_autohdr_sent",
    title: `Sent to AutoHDR: ${street}`.slice(0, 90),
    body: `${files.length} raw files, about ${expectedPhotosFor(files)} photos${batch.batchNo > 1 ? ` (files added after the first upload, batch ${batch.batchNo})` : ""}.`,
    href: `/ops/photo-delivery`,
    dedupeKey: `pd-intake-sent-${batchId}`,
    text: `The hub sent ${address} to AutoHDR automatically (${files.length} raw files, about ${expectedPhotosFor(files)} photos${batch.batchNo > 1 ? `; these are files added after the first upload` : ""}). Please don't add this folder to AutoHDR again. The edits are usually ready in 30 to 60 minutes, then the hub checks them. ${appBase()}/ops/photo-delivery`,
    to: "both",
  }).catch(() => null);
  // Commit right away when the files have landed (usually within seconds).
  for (let i = 0; i < 6; i++) {
    if (await tryCommit(batchId, now)) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return "sent";
}

/** Commit a created shoot. True once AutoHDR has started processing. */
export async function tryCommit(batchId: string, now: Date): Promise<boolean> {
  const b = await prisma.photoIntakeBatch.findUnique({ where: { id: batchId } });
  if (!b || b.state !== "LANDING" || !b.photoshootId || !b.ingestJobId) return false;
  try {
    await autohdr.commit(b.photoshootId, b.ingestJobId);
  } catch (e) {
    const err = e as AutohdrError;
    if (err instanceof AutohdrError && err.status === 409 && err.code === "files_not_landed") {
      const attempts = b.commitAttempts + 1;
      if (attempts >= MAX_COMMIT_ATTEMPTS) {
        await failBatch(batchId, b.projectId, b.address, `AutoHDR never finished fetching the files (${attempts} tries)`);
        return false;
      }
      await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { commitAttempts: attempts, nextCheckAt: new Date(now.getTime() + MIN), lastError: "files still landing at AutoHDR" } });
      return false;
    }
    if (!(err instanceof AutohdrError && err.status === 409)) {
      // 404/410/400: the shoot cannot start. A network failure: look again next pass.
      if (err instanceof AutohdrError && (err.code === "uncertain" || err.status === 0 || err.status >= 500)) {
        await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { commitAttempts: b.commitAttempts + 1, nextCheckAt: new Date(now.getTime() + 2 * MIN), lastError: err.message.slice(0, 300) } });
        return false;
      }
      await failBatch(batchId, b.projectId, b.address, `AutoHDR would not start the shoot: ${(e as Error).message.slice(0, 240)}`);
      return false;
    }
    // 409 conflict: already committed.
  }
  await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { state: "PROCESSING", committedAt: now, commitAttempts: b.commitAttempts + 1, lastError: null, nextCheckAt: new Date(now.getTime() + 5 * MIN) } });
  await note(b.projectId, `AutoHDR is editing "${b.address}" (shoot ${b.photoshootId})`);
  return true;
}

async function pollProcessing(batchId: string, now: Date): Promise<"waiting" | "done" | "failed"> {
  const b = await prisma.photoIntakeBatch.findUnique({ where: { id: batchId } });
  if (!b || b.state !== "PROCESSING" || !b.photoshootId) return "waiting";
  const st = await autohdr.photoshootStatus(b.photoshootId);
  if (st.awaiting_files) {
    await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { state: "LANDING", nextCheckAt: now } });
    return "waiting";
  }
  if (st.status === "success") {
    const photos = await autohdr.listPhotos(b.photoshootId);
    await prisma.photoIntakeBatch.update({
      where: { id: batchId },
      data: { state: "DONE", doneAt: now, imageCount: photos.length, photosJson: JSON.stringify(photos.map((p) => ({ image_uuid: p.image_uuid, image_version_uuid: p.image_version_uuid, name: p.name ?? null }))), lastError: null, nextCheckAt: null },
    });
    // Ask the job sync to read the new gallery now.
    const jobId = await jobIdFor(b.projectId);
    if (jobId) await prisma.photoJob.update({ where: { id: jobId }, data: { nextCheckAt: now } });
    await note(b.projectId, `AutoHDR finished "${b.address}": ${photos.length} edited photos`, { photoshootId: b.photoshootId, pipeline: st.pipeline ?? null });
    await checkCreatorBilling(b, photos.length);
    // Bring the photos over so the hub can show them (the delivery credit).
    const { downloadForDisplay } = await import("./display");
    await downloadForDisplay({ batchId: batchId, max: 1 }).catch((e) => console.warn("display download failed", batchId, (e as Error).message));
    return "done";
  }
  if (st.status === "failure") {
    // AutoHDR: "a very slow shoot can be flagged failed and then recover" (re-poll once).
    if (b.failedPolls < 1) {
      await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { failedPolls: 1, nextCheckAt: new Date(now.getTime() + 6 * MIN), lastError: "AutoHDR reported a failure; checking once more" } });
      return "waiting";
    }
    await failBatch(batchId, b.projectId, b.address, "AutoHDR reported the edit failed");
    return "failed";
  }
  if (b.committedAt && now.getTime() - b.committedAt.getTime() > SLOW_AFTER_MS && !b.lastError?.startsWith("slow")) {
    await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { lastError: "slow: still editing after 3 hours" } });
    await alertOwnerAndKyle({ kind: "photo_autohdr_slow", title: `AutoHDR still editing: ${b.address ?? "a shoot"}`.slice(0, 90), href: "/ops/photo-delivery", dedupeKey: `pd-intake-slow-${batchId}`, text: `AutoHDR has been editing ${b.address ?? "a shoot"} for over 3 hours (usually 30 to 60 minutes). Check it in AutoHDR. ${appBase()}/ops/photo-delivery`, to: "both" }).catch(() => null);
  }
  await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { nextCheckAt: new Date(now.getTime() + 5 * MIN) } });
  return "waiting";
}

/**
 * Safety net: house models charge nothing until a download. If the balance
 * fell by about the photo count while AutoHDR was editing, the account
 * default may be a creator model (billed when processing finishes). Jordan
 * hears about it once; Kyle's own downloads can cause the same drop, so this
 * is a question, not a verdict.
 */
async function checkCreatorBilling(b: { id: string; address: string | null; balanceAtSend: number | null }, photos: number) {
  if (b.balanceAtSend == null || photos < 5) return;
  const now = await autohdr.credits().then((c) => c.credit_balance).catch(() => null);
  if (now == null) return;
  const drop = b.balanceAtSend - now;
  if (drop < Math.round(photos * 0.9)) return;
  await alertOwnerAndKyle({
    kind: "photo_autohdr_billing",
    title: "AutoHDR credits fell while a shoot was editing",
    href: "/ops/photo-delivery/credits",
    dedupeKey: `pd-intake-billing-${b.id}`,
    text: `AutoHDR credits fell by ${drop} while ${b.address ?? "a shoot"} (${photos} photos) was editing, before anything was downloaded. If the account's default look is a creator model, editing itself is billed. Check the default look in AutoHDR. ${appBase()}/ops/photo-delivery/credits`,
    to: "owner",
  }).catch(() => null);
}

/** A create whose reply never arrived: find the shoot it made, or allow a new send. */
async function resolveUncertain(batchId: string, now: Date, shoots: AutohdrPhotoshoot[]) {
  const b = await prisma.photoIntakeBatch.findUnique({ where: { id: batchId } });
  if (!b || !["UNCERTAIN", "SENDING"].includes(b.state)) return;
  // A SENDING row older than 10 minutes was cut off mid-send (killed tick).
  if (b.state === "SENDING" && b.sentAt && now.getTime() - b.sentAt.getTime() < 10 * MIN) return;
  const sentAt = b.sentAt?.getTime() ?? 0;
  const found = shoots.find((s) => s.address === b.address && (!s.created_at || Date.parse(s.created_at) >= sentAt - 2 * MIN));
  if (found) {
    const st = await autohdr.photoshootStatus(found.photoshoot_id).catch(() => null);
    if (st?.awaiting_files) {
      // Without the reply's job id the hub cannot commit it.
      await failBatch(batchId, b.projectId, b.address, `AutoHDR made the shoot "${b.address}" but its reply was lost, so it was never started. Open it in AutoHDR and start it.`, found.photoshoot_id);
      return;
    }
    await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { state: "PROCESSING", photoshootId: found.photoshoot_id, committedAt: now, lastError: null, nextCheckAt: now } });
    await note(b.projectId, `found the AutoHDR shoot after a lost reply (shoot ${found.photoshoot_id})`);
    return;
  }
  if (now.getTime() - sentAt > 15 * MIN) {
    // Nothing was created: the files may be sent again (creating is free).
    await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { state: "WAITING", sentAt: null, lastError: "the earlier send never reached AutoHDR", seenAt: new Date(now.getTime() - 60 * MIN) } });
    return;
  }
  await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { nextCheckAt: new Date(now.getTime() + 3 * MIN) } });
}

async function failBatch(batchId: string, projectId: string, address: string | null, why: string, photoshootId?: number) {
  await prisma.photoIntakeBatch.update({ where: { id: batchId }, data: { state: "FAILED", lastError: why.slice(0, 300), nextCheckAt: null, ...(photoshootId ? { photoshootId } : {}) } });
  await note(projectId, `AutoHDR batch failed: ${why}`);
  await alertOwnerAndKyle({
    kind: "photo_autohdr_failed",
    title: `AutoHDR problem: ${(address ?? "a shoot").slice(0, 70)}`,
    body: why.slice(0, 140),
    href: "/ops/photo-delivery",
    dedupeKey: `pd-intake-failed-${batchId}`,
    text: `${address ?? "A shoot"}: ${why}. Nothing was sent twice. Add it to AutoHDR by hand if it is urgent. ${appBase()}/ops/photo-delivery`,
    to: "both",
  }).catch(() => null);
}

/** The hub-sent AutoHDR gallery for a job, as the job sync reads it (DONE batches, in order). */
export async function intakeGallery(projectId: string): Promise<{ shootId: number; image_uuid: string; image_version_uuid: string; name: string; url: string | null }[]> {
  const done = await prisma.photoIntakeBatch.findMany({ where: { projectId, state: "DONE", photosJson: { not: null } }, orderBy: { batchNo: "asc" }, select: { photoshootId: true, photosJson: true } });
  const out: { shootId: number; image_uuid: string; image_version_uuid: string; name: string; url: string | null }[] = [];
  for (const b of done) {
    try {
      const photos = JSON.parse(b.photosJson ?? "[]") as { image_uuid: string; image_version_uuid: string; name: string | null; url?: string | null }[];
      for (const p of photos) out.push({ shootId: b.photoshootId!, image_uuid: p.image_uuid, image_version_uuid: p.image_version_uuid, name: p.name || `${p.image_uuid}.jpg`, url: p.url ?? null });
    } catch {
      /* a row we cannot read adds nothing */
    }
  }
  return out;
}

/** Batches for the pages (newest first). */
export async function intakeBatchesFor(projectId: string) {
  return prisma.photoIntakeBatch.findMany({ where: { projectId }, orderBy: { batchNo: "desc" }, select: { batchNo: true, state: true, fileCount: true, expectedPhotos: true, address: true, photoshootId: true, sentAt: true, doneAt: true, imageCount: true, lastError: true } });
}
