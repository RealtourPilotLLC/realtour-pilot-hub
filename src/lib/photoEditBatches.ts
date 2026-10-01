import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { actualFolderPaths } from "@/lib/dropboxFolders";
import { dropboxListFolder, DropboxError } from "@/lib/integrations/dropbox";
import { finishedPhotos } from "@/lib/photoCount";
import { parseEvidence } from "@/lib/statusEvidence";

// ---------------------------------------------------------------------------
// THE AUTOHDR BATCH REGISTER (unified handoff §10, A53 / AU-21, Sep 26 2026).
//
// What AutoHDR actually is to this business: a vendor that WATCHES a Dropbox
// folder. A photographer's raws land in 01-RAW-Photos, AutoHDR merges each
// 5-bracket set and drops the finished photo into 04-Final-Photos. The hub has
// no AutoHDR API — no key, no endpoint, nothing in the registry (verified Sep
// 25, and nothing in AutoHDR's saved docs says there is one) — so "submitting a
// batch" is an UPLOAD, and the only way a batch gets submitted twice is a person
// re-uploading or re-running it.
//
// So this register does not fence an API call. Its job is the one the handoff
// names: before anybody re-runs a batch, show what was already sent and what
// already came back, so a slow vendor is never mistaken for a lost batch and
// paid for twice. It reads the SAME Dropbox lists the nightly photo count
// already makes (one more list, of 04, for the finals) and nothing else.
//
// THREE RULES:
//   · UNKNOWN IS NOT ZERO. A read that fails (429, auth, network) marks the
//     row UNKNOWN and writes no count — the photo count's own rule.
//   · "PHOTOS PRESENT" IS NOT "COMPLETE". The status engine treats any final
//     photo as the category being there; 20 of ~38 is a PARTIAL batch here.
//   · A RE-RUN IS RECORDED, NEVER SENT. recordResubmission() re-reads Dropbox
//     first and refuses while edits are still arriving or nothing is short.
//
// What the list call cannot give: Dropbox's list_folder carries size,
// content_hash and server_modified, but the shared lister (integrations/
// dropbox.ts) returns name/path/id only, and that file is not this batch's to
// change. So the fingerprint is the sorted relative paths, and firstRawAt /
// lastRawAt are when the HUB first saw raws and last saw them change — never
// Dropbox's upload time. Both are labelled that way wherever they are shown.
// ---------------------------------------------------------------------------

export const AUTOHDR = "autohdr";

/** AutoHDR's round trip, from tasks.ts VENDOR_CHASE ("Photos", 2 days). Two
 *  halves of one rule: the category chase fires at the same horizon. */
export const AUTOHDR_DELAY_DAYS = 2;
/** Finals at or above this share of the expected count read as COMPLETE. The
 *  expected count is an estimate (bracket sets ÷ 5), so exact equality would
 *  call a good batch short. Shown on the panel so a person can argue with it. */
export const PARTIAL_TOLERANCE = 0.9;
/** How recent a read must be before a re-run may be recorded against it. */
export const RESUBMIT_FRESH_MS = 10 * 60_000;

const DAY = 86_400_000;
const IMG_RE = /\.(jpe?g|png|dng|arw|raw|heic|tiff?)$/i;
const DRONE_RE = /^dji|dji[_-]|drone|mavic|air ?2|^m3[_-]/i;
// "IMG_1234 (1).JPG", "IMG_1234 copy.JPG", "IMG_1234 copy 2.JPG" — what a
// second drag of the same card into Finder leaves behind.
const COPY_RE = /^(.*?)(?: \(\d+\)| copy(?: \d+)?)(\.[a-z0-9]+)$/i;

export type BatchState = "AWAITING_RAWS" | "SUBMITTED_BY_UPLOAD" | "PARTIAL" | "COMPLETE" | "MISSING" | "UNKNOWN";

export type ListedEntry = { name: string; tag: string; path: string };

/** What one raw listing says, before any state is decided. Pure. */
export function readRaws(entries: ListedEntry[], rawRoot: string) {
  const imgs = entries.filter((e) => e.tag === "file" && IMG_RE.test(e.name));
  const root = rawRoot.toLowerCase().replace(/\/+$/, "");
  const rel = imgs.map((e) => {
    const p = (e.path || e.name).toLowerCase();
    return p.startsWith(root + "/") ? p.slice(root.length + 1) : e.name.toLowerCase();
  });
  const names = imgs.map((e) => e.name.toLowerCase());
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  const all = new Set(names);
  let duplicates = 0;
  const counted = new Set<string>();
  for (const n of names) {
    // The same file name twice in the tree (a card dumped into two folders),
    // or a Finder copy of a file that is also there — the second of each is
    // a duplicate upload, and AutoHDR may have charged for it.
    const copy = COPY_RE.exec(n);
    if (copy && all.has(`${copy[1]}${copy[2]}`)) { duplicates++; continue; }
    if ((seen.get(n) ?? 0) > 1) {
      if (counted.has(n)) { duplicates++; continue; }
      counted.add(n);
    }
  }
  const drone = imgs.filter((e) => DRONE_RE.test(e.name)).length;
  const fingerprint = createHash("sha1").update([...rel].sort().join("\n")).digest("hex");
  return { raw: imgs.length, drone, duplicates, fingerprint };
}

/** Finished photos the vendor should return — duplicates never double it. */
export function expectedFinalsFor(raw: number, drone: number, duplicates: number): number {
  const unique = Math.max(0, raw - duplicates);
  return finishedPhotos(unique, Math.min(drone, unique));
}

/** The one place a batch's state is decided. Pure, so the drill and the panel
 *  can both say why. `since` is when the hub last saw the raws change. */
export function batchStateFor(input: {
  raw: number;
  expected: number;
  finals: number | null;
  since: Date | null;
  now: Date;
  prior?: string | null;
}): BatchState {
  if (input.raw <= 0) return "AWAITING_RAWS";
  // A finished batch stays finished when a later look fails: files do not
  // un-finish on a 429, and flipping it to UNKNOWN would only raise noise.
  if (input.finals === null) return input.prior === "COMPLETE" ? "COMPLETE" : "UNKNOWN";
  const need = Math.max(1, Math.ceil(input.expected * PARTIAL_TOLERANCE));
  if (input.finals >= need) return "COMPLETE";
  const pastDelay = !!input.since && input.now.getTime() - input.since.getTime() >= AUTOHDR_DELAY_DAYS * DAY;
  if (!pastDelay) return "SUBMITTED_BY_UPLOAD";
  return input.finals === 0 ? "MISSING" : "PARTIAL";
}

type ProjectForBatch = {
  id: string;
  title: string;
  addressLine: string | null;
  shootDate: Date | null;
  createdAt: Date;
  dropboxFolder: string | null;
  client: { name: string } | null;
};

const PROJECT_SELECT = {
  id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true,
  client: { select: { name: true } },
} as const;

type FinalsRead = { ok: true; count: number } | { ok: false; error: string };

async function readFinals(path: string): Promise<FinalsRead> {
  try {
    const entries = await dropboxListFolder(path, { recursive: true });
    return { ok: true, count: entries.filter((e) => e.tag === "file" && IMG_RE.test(e.name)).length };
  } catch (e) {
    // A folder that does not exist yet is a real zero: nothing came back.
    if (e instanceof DropboxError && /not_found|path_lookup/i.test(e.message)) return { ok: true, count: 0 };
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
  }
}

const latestBatch = (projectId: string) =>
  prisma.photoEditBatch.findFirst({ where: { projectId, vendorKey: AUTOHDR }, orderBy: { attempt: "desc" } });

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/**
 * Fold one fresh raw listing (and one read of 04) into the job's latest batch.
 * Called by countProjectPhotos with the raws it just listed — the same read,
 * not a second one. `rawEntries: null` means the raw read FAILED: the row is
 * marked unreadable and no count moves. A job with no raws and no row gets no
 * row (a video-only job is not a batch).
 */
export async function reconcilePhotoBatch(
  projectId: string,
  opts: { rawEntries: ListedEntry[] | null; readError?: string; now?: Date },
): Promise<{ state: BatchState; batchId: string } | null> {
  const now = opts.now ?? new Date();
  const p = (await prisma.project.findUnique({ where: { id: projectId }, select: PROJECT_SELECT })) as ProjectForBatch | null;
  if (!p || !p.client) return null;
  const prior = await latestBatch(projectId);

  if (opts.rawEntries === null) {
    if (!prior) return null;
    const state: BatchState = prior.state === "COMPLETE" ? "COMPLETE" : "UNKNOWN";
    await prisma.photoEditBatch.update({ where: { id: prior.id }, data: { readOk: false, state } });
    return { state, batchId: prior.id };
  }

  const paths = actualFolderPaths({ ...p, client: p.client });
  const raws = readRaws(opts.rawEntries, paths.rawPhotos);
  if (raws.raw === 0 && !prior) return null;
  // THE RAWS LEFT 01 AFTER THE BATCH WAS SENT (Sep 26 2026 review). The folder
  // listed empty, or not at all: raws moved to the right job after a mis-filed
  // upload, cleaned up once the edit was back, a shoot date corrected so the
  // folder path now points at another month. None of that un-sends the batch
  // or un-returns its finals, and 04 was not read on this pass — so nothing on
  // the row may move. Until this review the row was rewritten as "0 came back,
  // read just now" (finalsCount 0, readOk, lastReadAt now, AWAITING_RAWS) over
  // a COMPLETE 38, a zero nobody read: exactly what UNKNOWN IS NOT ZERO
  // forbids. The row stays as the last real read left it; raws that come back
  // are folded in by the next pass as usual.
  if (raws.raw === 0 && prior) return { state: prior.state as BatchState, batchId: prior.id };

  const expected = expectedFinalsFor(raws.raw, raws.drone, raws.duplicates);
  const finals = await readFinals(paths.finalPhotos);
  const changed = !prior || prior.sourceFingerprint !== raws.fingerprint;
  const firstRawAt = prior?.firstRawAt ?? (raws.raw > 0 ? now : null);
  const lastRawAt = raws.raw > 0 ? (changed ? now : prior?.lastRawAt ?? now) : prior?.lastRawAt ?? null;
  const state = batchStateFor({
    raw: raws.raw,
    expected,
    finals: finals.ok ? finals.count : null,
    since: lastRawAt,
    now,
    prior: prior?.state,
  });

  const data = {
    sourcePath: paths.rawPhotos,
    sourceFingerprint: raws.fingerprint,
    rawCount: raws.raw,
    droneCount: raws.drone,
    expectedFinals: expected,
    finalsPath: paths.finalPhotos,
    ...(finals.ok ? { finalsCount: finals.count, lastReadAt: now } : {}),
    firstRawAt,
    lastRawAt,
    readOk: finals.ok,
    state,
    duplicateUploadSuspected: raws.duplicates > 0,
  };

  let batchId: string;
  if (prior) {
    await prisma.photoEditBatch.update({ where: { id: prior.id }, data });
    batchId = prior.id;
  } else {
    try {
      batchId = (await prisma.photoEditBatch.create({
        data: { projectId, vendorKey: AUTOHDR, attempt: 1, submissionEvidence: "dropbox-upload", ...data },
        select: { id: true },
      })).id;
    } catch (e) {
      // Two sweeps met on a job's first batch: the other one wrote it.
      if (!isUnique(e)) throw e;
      const won = await latestBatch(projectId);
      if (!won) throw e;
      await prisma.photoEditBatch.update({ where: { id: won.id }, data });
      batchId = won.id;
    }
  }

  await followUpChase(p, batchId, state).catch(() => { /* the chase never breaks the count */ });
  return { state, batchId };
}

const partialChaseKey = (projectId: string, attempt: number) => `photo-batch-partial-${projectId}-a${attempt}`;

/**
 * The office already settled the photos as they stand: every owed photo line
 * is DONE, or the listing already carries photos (the status engine's Aryeo
 * read). The count is an estimate — a culled set or 3-bracket sets come back
 * "short" by design — so once a person has shipped the photos, "20 of ~38" is
 * history on the job page, not a chase or a board row.
 */
function photosSettled(job: { statusEvidence: string | null; deliverables: { status: string }[] }): boolean {
  if (job.deliverables.length > 0 && job.deliverables.every((d) => d.status === "DONE")) return true;
  const ev = parseEvidence(job.statusEvidence);
  return (ev?.aryeo?.photos ?? 0) > 0;
}
const streetOf = (title: string) => (title || "this job").split(",")[0].trim();

/**
 * ONE chase per short batch, to Kyle — "received 20 of ~38". The category
 * chase (tasks.ts chaseVendorsForMissing) cannot see this: it closes the
 * moment ANY final photo exists, because to the status engine photos are
 * "present". A COMPLETE batch closes this chase; a recorded re-run answers it.
 */
async function followUpChase(p: ProjectForBatch, batchId: string, state: BatchState) {
  const b = await prisma.photoEditBatch.findUnique({ where: { id: batchId } });
  if (!b) return;
  if (state === "COMPLETE") {
    await prisma.smartTask.updateMany({
      where: { dedupeKey: { startsWith: `photo-batch-partial-${p.id}-` }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date(), sourceDetail: "AutoHDR returned the rest" },
    });
    return;
  }
  if (state !== "PARTIAL") return;
  const job = await prisma.project.findUnique({
    where: { id: p.id },
    select: {
      status: true, clientId: true, statusEvidence: true,
      deliverables: { where: { removedFromOrderAt: null, waivedAt: null, type: { in: ["PHOTOS", "DRONE"] } }, select: { id: true, status: true } },
    },
  });
  // Only work that is still owed and still in production: a delivered or
  // cancelled job, or one whose photos were waived, is nobody's chase.
  if (!job || job.deliverables.length === 0 || !["SHOT", "EDITING", "REVIEW", "REVISION"].includes(job.status)) return;
  if (photosSettled(job)) return;
  const key = partialChaseKey(p.id, b.attempt);
  if (await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true } })) return;
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" }, active: true }, select: { id: true } });
  const street = streetOf(p.title);
  const got = b.finalsCount ?? 0;
  const want = b.expectedFinals ?? 0;
  try {
    await prisma.smartTask.create({
      data: {
        taskType: "comms_followup",
        title: `Chase AutoHDR — received ${got} of ~${want} — ${street}`.slice(0, 120),
        summary: `AutoHDR has returned ${got} finished photo${got === 1 ? "" : "s"} of about ${want} expected from the raws in Dropbox, ${AUTOHDR_DELAY_DAYS}+ days after the raws landed. Check AutoHDR for the rest before anyone re-runs the batch — a re-run is a second charge. The job's page shows what was sent and what came back.`.slice(0, 500),
        reasonCreated: `AutoHDR batch short: ${got} of ~${want} finished photos back`,
        source: "system",
        priority: "HIGH",
        dueAt: new Date(Date.now() + 4 * 3_600_000),
        projectId: p.id,
        clientId: job.clientId ?? null,
        propertyAddress: p.title,
        ownerId: kyle?.id ?? null,
        assignedKey: "kyle",
        dedupeKey: key,
      },
    });
  } catch (e) {
    if (!isUnique(e)) throw e; // a concurrent pass filed it — one chase either way
  }
}

/**
 * A vendor "job complete" mail, attached as evidence when its subject or body
 * names the street of EXACTLY ONE recent batch. Never overwrites a person's
 * own evidence (a recorded re-run). Returns the batch it landed on, or null.
 */
export async function attachVendorEmail(input: { gmailId: string; text: string; now?: Date }): Promise<string | null> {
  const now = input.now ?? new Date();
  const hay = input.text.toLowerCase();
  const recent = await prisma.photoEditBatch.findMany({
    where: { vendorKey: AUTOHDR, updatedAt: { gte: new Date(now.getTime() - 30 * DAY) } },
    orderBy: { attempt: "desc" },
    select: { id: true, projectId: true, attempt: true, submissionEvidence: true },
  });
  if (recent.length === 0) return null;
  // Latest attempt per job only.
  const latest = new Map<string, (typeof recent)[number]>();
  for (const b of recent) if (!latest.has(b.projectId)) latest.set(b.projectId, b);
  const projects = await prisma.project.findMany({ where: { id: { in: [...latest.keys()] } }, select: { id: true, title: true, addressLine: true } });
  const hits = projects.filter((pr) => {
    const street = (pr.addressLine || streetOf(pr.title)).trim().toLowerCase();
    return street.length >= 6 && /\d/.test(street) && hay.includes(street);
  });
  if (hits.length !== 1) return null;
  const b = latest.get(hits[0].id)!;
  if (b.submissionEvidence?.startsWith("manual:")) return b.id;
  await prisma.photoEditBatch.update({ where: { id: b.id }, data: { submissionEvidence: `vendor-email:${input.gmailId}`.slice(0, 190) } });
  return b.id;
}

export type ResubmitResult = { ok: boolean; message: string; attempt?: number };

/**
 * A person is about to re-run a batch through AutoHDR. Record it — after a
 * fresh read proves the batch is really short and nothing has landed since the
 * last look. The hub never uploads or pays anything itself; this is the ledger
 * line that stops the second person re-running the same batch tomorrow.
 *
 * Atomic: attempt+1 is unique per job, so two people pressing it at once get
 * one row and one "already recorded".
 */
export async function recordResubmission(projectId: string, actor: string, reason: string): Promise<ResubmitResult> {
  const why = (reason ?? "").trim();
  if (why.length < 3) return { ok: false, message: "Say why it is being re-run — it goes on the record." };
  const before = await latestBatch(projectId);
  if (!before) return { ok: false, message: "No AutoHDR batch is recorded for this job yet — nothing to re-run against." };

  // THE FRESH READ. The same path the nightly sweep takes, now.
  const { countProjectPhotos } = await import("@/lib/photoCount");
  await countProjectPhotos(projectId);
  const after = await latestBatch(projectId);
  if (!after || after.id !== before.id) return { ok: false, message: "The batch changed while it was being checked — reload and look again." };
  const fresh = after.readOk && !!after.lastReadAt && Date.now() - after.lastReadAt.getTime() <= RESUBMIT_FRESH_MS;
  if (!fresh) return { ok: false, message: "Dropbox could not be read just now, so nothing was recorded. Try again in a minute." };
  if ((after.finalsCount ?? 0) > (before.finalsCount ?? 0)) {
    return { ok: false, message: `Edits are still arriving (${before.finalsCount ?? 0} → ${after.finalsCount} since the last look). Give AutoHDR time before re-running.` };
  }
  if (after.state !== "PARTIAL" && after.state !== "MISSING") {
    const words: Record<string, string> = {
      COMPLETE: `AutoHDR has returned ${after.finalsCount} of ~${after.expectedFinals} — that is complete. Nothing to re-run.`,
      SUBMITTED_BY_UPLOAD: `The raws are still inside AutoHDR's ${AUTOHDR_DELAY_DAYS}-day window. Nothing is late yet.`,
      AWAITING_RAWS: "There are no raws in the folder to re-run.",
      UNKNOWN: "The batch could not be read, so a shortfall is not proven.",
    };
    return { ok: false, message: words[after.state] ?? "Nothing is short on this batch." };
  }

  const now = new Date();
  try {
    await prisma.$transaction([
      prisma.photoEditBatch.create({
        data: {
          projectId,
          vendorKey: AUTOHDR,
          attempt: after.attempt + 1,
          sourcePath: after.sourcePath,
          sourceFingerprint: after.sourceFingerprint,
          rawCount: after.rawCount,
          droneCount: after.droneCount,
          expectedFinals: after.expectedFinals,
          finalsPath: after.finalsPath,
          finalsCount: after.finalsCount,
          firstRawAt: after.firstRawAt,
          // The re-run restarts the vendor's clock.
          lastRawAt: now,
          lastReadAt: after.lastReadAt,
          readOk: true,
          state: "SUBMITTED_BY_UPLOAD",
          submissionEvidence: `manual:${actor}`.slice(0, 190),
          duplicateUploadSuspected: after.duplicateUploadSuspected,
          resubmittedAt: now,
          resubmittedBy: actor,
          resubmitReason: why.slice(0, 500),
        },
      }),
      // The short batch's chase is answered by the re-run.
      prisma.smartTask.updateMany({
        where: { dedupeKey: partialChaseKey(projectId, after.attempt), status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "COMPLETED", completedAt: now, sourceDetail: "Re-run recorded" },
      }),
    ]);
  } catch (e) {
    if (isUnique(e)) return { ok: false, message: "Someone already recorded a re-run for this batch." };
    throw e;
  }
  return { ok: true, message: `Re-run recorded as attempt ${after.attempt + 1}. The register will watch for the finals.`, attempt: after.attempt + 1 };
}

export type BatchView = {
  id: string;
  attempt: number;
  state: BatchState;
  rawCount: number | null;
  droneCount: number | null;
  expectedFinals: number | null;
  finalsCount: number | null;
  readOk: boolean;
  lastReadAt: Date | null;
  firstRawAt: Date | null;
  lastRawAt: Date | null;
  submissionEvidence: string | null;
  duplicateUploadSuspected: boolean;
  resubmittedAt: Date | null;
  resubmittedBy: string | null;
  resubmitReason: string | null;
};

/** Every attempt on a job, newest first — the panel's history. */
export async function batchesForProject(projectId: string): Promise<BatchView[]> {
  const rows = await prisma.photoEditBatch.findMany({ where: { projectId, vendorKey: AUTOHDR }, orderBy: { attempt: "desc" } });
  return rows.map((r) => ({ ...r, state: r.state as BatchState }));
}

/** Batches that need a person, for the exceptions board. Latest attempt per
 *  job on jobs still in production. */
export async function batchesNeedingAttention(opts: { now?: Date; take?: number; excludeClientIds?: string[] } = {}) {
  const excludedProjectIds = opts.excludeClientIds?.length
    ? (await prisma.project.findMany({ where: { clientId: { in: opts.excludeClientIds } }, select: { id: true } })).map((p) => p.id)
    : [];
  const rows = await prisma.photoEditBatch.findMany({
    where: {
      vendorKey: AUTOHDR,
      ...(excludedProjectIds.length ? { projectId: { notIn: excludedProjectIds } } : {}),
      OR: [{ state: { in: ["PARTIAL", "MISSING"] } }, { duplicateUploadSuspected: true }],
      updatedAt: { gte: new Date((opts.now ?? new Date()).getTime() - 30 * DAY) },
    },
    orderBy: { attempt: "desc" },
    take: opts.take ?? 200,
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.projectId)) latest.set(r.projectId, r);
  // A newer attempt that is NOT in the list supersedes an older one that is.
  const newer = latest.size
    ? await prisma.photoEditBatch.groupBy({ by: ["projectId"], where: { projectId: { in: [...latest.keys()] }, vendorKey: AUTOHDR }, _max: { attempt: true } })
    : [];
  const maxOf = new Map(newer.map((g) => [g.projectId, g._max.attempt ?? 0]));
  const live = [...latest.values()].filter((r) => (maxOf.get(r.projectId) ?? r.attempt) === r.attempt);
  const projects = live.length
    ? await prisma.project.findMany({
        where: { id: { in: live.map((r) => r.projectId) }, status: { notIn: ["DELIVERED", "CANCELLED", "ON_HOLD"] }, ...(opts.excludeClientIds?.length ? { clientId: { notIn: opts.excludeClientIds } } : {}) },
        select: {
          id: true, title: true, statusEvidence: true,
          deliverables: { where: { removedFromOrderAt: null, waivedAt: null, type: { in: ["PHOTOS", "DRONE"] } }, select: { status: true } },
        },
      })
    : [];
  // A short count on photos a person already shipped is not an exception; a
  // doubled upload still is (it may be a double charge either way).
  const settled = new Set(projects.filter((p) => photosSettled(p)).map((p) => p.id));
  const titleOf = new Map(projects.map((p) => [p.id, p.title]));
  return live
    .filter((r) => titleOf.has(r.projectId) && (r.duplicateUploadSuspected || !settled.has(r.projectId)))
    .map((r) => ({ ...r, state: r.state as BatchState, title: titleOf.get(r.projectId)! }));
}

/**
 * The exceptions board's "photo-batch" rows (opsExceptions.ts), built here so
 * the board only has to ask. Kyle owns them: chasing AutoHDR is his routine.
 */
export async function photoBatchExceptionRows(opts: { now: Date; cap: number; excludeClientIds?: string[] }) {
  const rows = await batchesNeedingAttention({ now: opts.now, excludeClientIds: opts.excludeClientIds });
  const ageDays = (d: Date | null) => (d ? Math.max(0, Math.floor((opts.now.getTime() - d.getTime()) / DAY)) : 0);
  const built = rows.map((b) => {
    const street = streetOf(b.title);
    const got = b.finalsCount ?? 0;
    const want = b.expectedFinals ?? 0;
    const short = b.state === "PARTIAL" || b.state === "MISSING";
    return {
      id: `photo-batch:${b.projectId}`,
      kind: "photo-batch" as const,
      severity: (b.state === "MISSING" ? "high" : "medium") as "high" | "medium",
      title: street,
      why: short
        ? b.state === "MISSING"
          ? `AutoHDR has returned none of ~${want} photos, ${AUTOHDR_DELAY_DAYS}+ days after the raws landed`
          : `AutoHDR has returned ${got} of ~${want} photos, ${AUTOHDR_DELAY_DAYS}+ days after the raws landed`
        : "The raw folder looks like it holds the same files twice — AutoHDR may have charged twice",
      owner: "Kyle",
      nextAction: short
        ? "Check AutoHDR for the rest before anyone re-runs the batch — the job page shows what was sent and what came back"
        : "Open the raw folder, remove the duplicate upload, and check AutoHDR's bill for a double charge",
      href: `/projects/${b.projectId}#photo-batch`,
      ageDays: ageDays(b.lastRawAt ?? b.firstRawAt),
    };
  });
  const ordered = built.sort((a, b) => (a.severity === b.severity ? b.ageDays - a.ageDays : a.severity === "high" ? -1 : 1));
  return {
    rows: ordered.slice(0, opts.cap),
    total: { all: built.length, high: built.filter((r) => r.severity === "high").length },
  };
}
