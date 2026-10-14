import "server-only";

import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { autohdr, autohdrConfigured, AutohdrError, type AutohdrTransformJob } from "@/lib/integrations/autohdr";
import { photoDeliverySettings } from "./settings";
import { capabilityCatalog, modelCatalog } from "./catalog";
import { latestSnapshot, recordCreditSnapshot, recordLedgerEntry } from "./credits";
import { linkAutohdrShoot } from "./autohdrLink";
import { logJobEvent, setStage } from "./jobState";
import { alertOwnerAndKyle } from "./notifyOps";

// ---------------------------------------------------------------------------
// THE FIX RUNNER (docs/photo-delivery/01 §8.4, AUTOHDR_API_PLAN.md §3).
//
// Runs only what a person approved in the Fix Cart (PhotoFixBatch rows), one
// step per operation per tick, and only while the owner's switch
// `fixRunnerEnabled` is on (Jordan, Oct 14: "require explicit approval before
// any paid API test" — the switch stays OFF until he has approved the first
// live run).
//
// The money rules, from AutoHDR's own docs:
//   · POST /v1/transforms is NOT idempotent. Each operation is written as
//     SUBMITTING (with the input version and the live price) BEFORE the POST,
//     and the returned job_id is written the moment AutoHDR answers. A row
//     found in SUBMITTING later is resolved by LISTING the shoot's jobs
//     (state=all), never by sending again. Only when AutoHDR provably has no
//     such job, and only once, is it queued again.
//   · The price is charged on submit; a failed job or a no-op (succeeded with
//     no output version) is refunded. The ledger records all three.
//   · A photo AutoHDR has not been paid for yet (downloaded: false) would add
//     a first-download credit to the fix: such an operation stops and asks a
//     person instead of spending it.
//   · Before the first spend on a photo, the hub proves it is editing the
//     RIGHT photo: it downloads AutoHDR's current version (free, the photo is
//     already paid for) and compares a perceptual hash with the photo the hub
//     inspected. A mismatch stops the operation.
// Results are stored in the private Blob store (never the public one) for
// Kyle to swap into the Aryeo listing; the hub cannot upload to Aryeo.
//
// Oct 14 2026, the hub's OWN shoots (intake.ts, rows sourceKind AUTOHDR): the
// hub made the shoot and recorded each photo's id, so there is nothing to
// prove and nothing to download first. Those photos are not paid for until
// Kyle pushes them to Aryeo, so the hub never downloads them: the fix becomes
// the photo's current version in AutoHDR and goes out with the push. Only
// re-edits (no masks) run on them. Automatic batches (fixPolicy.ts) are held
// to the per-shoot maximum here as well, right before each paid call. After
// every fix, a free check (AutoHDR describe on the new version) confirms it was
// fixed properly: fixed, or still there (a person looks), or clearly damaged
// (the previous version is put back, free).
// ---------------------------------------------------------------------------

const MIN = 60_000;
const SUBMIT_LOOKUP_AFTER_MS = 2 * MIN;
const SUBMIT_GIVE_UP_MS = 10 * MIN;
const POLL_ESCALATE_MS = 45 * MIN;
const TERMINAL = ["SUCCEEDED", "NOOP", "FAILED", "VERIFIED", "REVERTED", "ESCALATED", "CANCELLED"];

type Op = Awaited<ReturnType<typeof prisma.photoFixOperation.findFirstOrThrow>>;

// ---- test hooks (drills replace the byte loaders and the blob store) ----------
type BytesLoader = (p: { sourceKind: string; sourceUrl: string | null; dropboxPath: string | null }) => Promise<Buffer>;
type BlobPut = (pathname: string, bytes: Buffer) => Promise<{ pathname: string; url: string } | null>;
let sourceLoader: BytesLoader | null = null;
let blobPut: BlobPut | null = null;
let urlFetcher: ((url: string) => Promise<Buffer>) | null = null;
export function __setFixRunnerHooksForTests(h: { source?: BytesLoader | null; put?: BlobPut | null; fetchUrl?: ((url: string) => Promise<Buffer>) | null }) {
  if ("source" in h) sourceLoader = h.source ?? null;
  if ("put" in h) blobPut = h.put ?? null;
  if ("fetchUrl" in h) urlFetcher = h.fetchUrl ?? null;
}

const ARYEO_HOSTS = /(^|\.)aryeo\.com$|(^|\.)amazonaws\.com$|(^|\.)cloudfront\.net$/i;

async function fetchBytes(url: string, max = 60 * 1024 * 1024): Promise<Buffer> {
  if (urlFetcher) return urlFetcher(url);
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw new Error("file too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > max) throw new Error("file too large");
  return buf;
}

async function loadSource(p: { sourceKind: string; sourceUrl: string | null; dropboxPath: string | null }): Promise<Buffer> {
  if (sourceLoader) return sourceLoader(p);
  if (p.sourceKind === "ARYEO" && p.sourceUrl) {
    const host = new URL(p.sourceUrl).hostname;
    if (!ARYEO_HOSTS.test(host)) throw new Error(`refusing to fetch a photo from ${host}`);
    return fetchBytes(p.sourceUrl);
  }
  if (p.dropboxPath) {
    const { dropboxDownload } = await import("@/lib/integrations/dropbox");
    return dropboxDownload(p.dropboxPath);
  }
  throw new Error("the photo has no readable source");
}

function privateBlobToken(): string | null {
  return (process.env.PHOTO_QC_BLOB_TOKEN || process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN || "").trim() || null;
}

async function storeResult(pathname: string, bytes: Buffer): Promise<{ pathname: string; url: string } | null> {
  if (blobPut) return blobPut(pathname, bytes);
  const token = privateBlobToken();
  if (!token) return null; // never the public store: unreleased client photos
  const { put } = await import("@vercel/blob");
  const r = await put(pathname, bytes, { access: "private", token, contentType: "image/jpeg", addRandomSuffix: false, allowOverwrite: true });
  return { pathname: r.pathname, url: r.url };
}

/** 64-bit difference hash: robust to recompression and resizing. */
export async function dHash(bytes: Buffer): Promise<bigint> {
  const { data } = await sharp(bytes).rotate().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let h = BigInt(0);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << BigInt(1)) | (data[y * 9 + x] > data[y * 9 + x + 1] ? BigInt(1) : BigInt(0));
  return h;
}
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & BigInt(1));
    x >>= BigInt(1);
  }
  return n;
}

/** Render a white-on-black PNG mask at exactly w×h from full-resolution boxes. */
export async function renderMask(w: number, h: number, boxes: [number, number, number, number][], pad: { pct: number; minPx: number }): Promise<Buffer> {
  const rects = boxes.map(([x1, y1, x2, y2]) => {
    const p = Math.max(pad.minPx, Math.round((Math.max(x2 - x1, y2 - y1) * pad.pct) / 100));
    const a = Math.max(0, Math.floor(x1 - p));
    const b = Math.max(0, Math.floor(y1 - p));
    const c = Math.min(w, Math.ceil(x2 + p));
    const d = Math.min(h, Math.ceil(y2 + p));
    return `<rect x="${a}" y="${b}" width="${Math.max(1, c - a)}" height="${Math.max(1, d - b)}" fill="#fff"/>`;
  });
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#000"/>${rects.join("")}</svg>`);
  return sharp(svg).png().toBuffer();
}

const REEDIT_SUFFIX = "Change nothing else in the photo.";

/** The hub's own shoot photo (intake.ts): its AutoHDR shoot is in sourceRef "<shoot>/<image_uuid>". */
function hubShootOf(photo: { sourceKind: string; sourceRef: string | null }): number | null {
  if (photo.sourceKind !== "AUTOHDR" || !photo.sourceRef?.includes("/")) return null;
  const n = Number(photo.sourceRef.split("/")[0]);
  return Number.isFinite(n) ? n : null;
}
function mergePrompts(prompts: string[]): string | null {
  const parts = prompts
    .map((p) => p.replace(REEDIT_SUFFIX, "").trim())
    .filter(Boolean);
  if (!parts.length) return null;
  return `${[...new Set(parts)].join(" ")} ${REEDIT_SUFFIX}`.slice(0, 1200);
}

async function escalate(op: Op, why: string, by = "fix-runner"): Promise<void> {
  await prisma.photoFixOperation.update({ where: { id: op.id }, data: { status: "ESCALATED", error: why.slice(0, 500), finishedAt: new Date() } });
  const ids = JSON.parse(op.findingIdsJson) as string[];
  await prisma.photoQcFinding.updateMany({ where: { id: { in: ids }, status: { in: ["APPROVED_FIX", "FIXING"] } }, data: { status: "OPEN", statusReason: `Fix not run: ${why}`.slice(0, 500) } });
  await logJobEvent(op.jobId, by, `fix not run (${op.transformName ?? op.strategy}): ${why}`, { operationId: op.id });
}

// ---- one step for a QUEUED operation -------------------------------------------------
async function submitStep(op: Op): Promise<"submitted" | "escalated" | "held" | "waiting"> {
  const settings = await photoDeliverySettings();
  const job = await prisma.photoJob.findUnique({ where: { id: op.jobId }, select: { id: true, projectId: true, autohdrPhotoshootId: true, autohdrCreatedAt: true, stage: true } });
  const photo = await prisma.photoAsset.findUnique({ where: { id: op.photoId } });
  if (!job || !photo) {
    await escalate(op, "the job or photo no longer exists");
    return "escalated";
  }
  if (!job.autohdrPhotoshootId || !photo.autohdrImageUuid) {
    await linkAutohdrShoot(job.id).catch(() => null);
  }
  const fresh = await prisma.photoAsset.findUnique({ where: { id: op.photoId }, select: { autohdrImageUuid: true } });
  const linked = await prisma.photoJob.findUnique({ where: { id: job.id }, select: { autohdrPhotoshootId: true, autohdrCreatedAt: true } });
  if (!linked?.autohdrPhotoshootId || !fresh?.autohdrImageUuid) {
    await escalate(op, "this photo is not matched to its AutoHDR shoot, so AutoHDR cannot edit it here; fix it in AutoHDR's web app or send it to the editor");
    return "escalated";
  }
  const hubShoot = hubShootOf(photo);
  const shootId = hubShoot ?? linked.autohdrPhotoshootId;
  if (linked.autohdrCreatedAt && Date.now() - linked.autohdrCreatedAt.getTime() > 7 * 86_400_000 - 60 * MIN) {
    await escalate(op, "the AutoHDR shoot is older than 7 days and has expired there");
    return "escalated";
  }

  // The live price, never a remembered one.
  const catalog = await capabilityCatalog(true);
  const cap = catalog?.find((c) => c.name === op.transformName);
  if (!cap) {
    await escalate(op, `AutoHDR's API does not offer "${op.transformName}" right now`);
    return "escalated";
  }
  let price = typeof cap.credit_cost === "number" ? cap.credit_cost : null;
  let modelId: number | null = null;
  if (op.transformName === "style") {
    const params = op.paramsJson ? (JSON.parse(op.paramsJson) as { model_id?: number }) : {};
    modelId = typeof params.model_id === "number" ? params.model_id : null;
    const model = modelId != null ? (await modelCatalog(true))?.find((m) => m.id === modelId) : null;
    if (!model) {
      await escalate(op, "a restyle needs a model chosen from AutoHDR's list");
      return "escalated";
    }
    price = model.style_credit_cost;
  }
  if (price == null) {
    await escalate(op, "AutoHDR did not give a price for this edit");
    return "escalated";
  }
  // An automatic batch never goes past the per-shoot maximum (Jordan, Oct 14:
  // "$5-$10 MAX on QC fixes per shoot"), counted from what was really charged.
  const batchRow = await prisma.photoFixBatch.findUnique({ where: { id: op.batchId }, select: { approvedBy: true } });
  if (batchRow?.approvedBy === "auto-fix") {
    const { creditThresholds } = await import("./credits");
    const maxCredits = Math.floor(settings.fixMaxUsd / (await creditThresholds()).usdPerCredit + 1e-9);
    const charged = await prisma.photoFixOperation.aggregate({ where: { jobId: job.id, batch: { approvedBy: "auto-fix" }, chargedCredits: { not: null }, OR: [{ refunded: null }, { refunded: false }] }, _sum: { chargedCredits: true } });
    if ((charged._sum.chargedCredits ?? 0) + price > maxCredits) {
      await escalate(op, `this shoot has reached its automatic fix maximum ($${settings.fixMaxUsd})`);
      return "escalated";
    }
  }
  // Pre-flight: the live balance must cover it.
  const credits = await autohdr.credits().catch(() => null);
  const balance = credits?.credit_balance ?? (await latestSnapshot())?.balance ?? null;
  if (balance == null || balance < price) {
    if (job.stage !== "ON_HOLD") await setStage(job.id, "any", "ON_HOLD", "fix-runner", { why: `AutoHDR balance ${balance ?? "unknown"} is below the fix price ${price}`, holdReason: "CREDITS" });
    return "held";
  }

  // Is the hub's photo the one AutoHDR would edit? (and is it already paid for?)
  const remote = (await autohdr.listPhotos(shootId)).find((r) => r.image_uuid === fresh.autohdrImageUuid);
  if (!remote) {
    await escalate(op, "AutoHDR no longer lists this photo in the shoot");
    return "escalated";
  }
  const ids = JSON.parse(op.findingIdsJson) as string[];
  const findings = await prisma.photoQcFinding.findMany({ where: { id: { in: ids } }, select: { id: true, bboxJson: true, reeditPrompt: true } });
  const body: Parameters<typeof autohdr.submitTransform>[0] = {
    photoshoot_id: shootId,
    image_uuid: remote.image_uuid,
    image_version_uuid: remote.image_version_uuid, // the head: edits compound on it
    transform_name: cap.name,
    transform_version: cap.version ?? 1,
  };
  if (hubShoot != null) {
    // The hub's own shoot: the photo is the one the hub recorded; nothing to
    // download (that would pay its first download early). Re-edits only.
    if (cap.requires_mask) {
      await escalate(op, "the hub's own AutoHDR shoots are fixed with written re-edits, not marked areas");
      return "escalated";
    }
  } else {
  if (!remote.downloaded) {
    await escalate(op, "AutoHDR has not been paid for this photo yet, so the fix would also cost its first download (1 credit); approve that in AutoHDR or ask Jordan");
    return "escalated";
  }
  const dl = await autohdr.download(shootId, [{ image_uuid: remote.image_uuid }]);
  if ((dl.data.credits_charged ?? 0) > 0) {
    // Should be impossible (downloaded was true); record it honestly and stop.
    await recordLedgerEntry({ kind: "DOWNLOAD", credits: -(dl.data.credits_charged ?? 0), jobId: job.id, ref: `${shootId}:${remote.image_uuid}`, note: "unexpected charge on a re-download" });
    await escalate(op, `AutoHDR charged ${dl.data.credits_charged} credit(s) for a re-download it should give free; stopped`);
    return "escalated";
  }
  const headUrl = dl.data.downloads?.[0]?.url;
  if (!headUrl) {
    await escalate(op, "AutoHDR returned no download link");
    return "escalated";
  }
  const [headBytes, srcBytes] = await Promise.all([fetchBytes(headUrl), loadSource(photo)]);
  const [hh, hs] = await Promise.all([dHash(headBytes), dHash(srcBytes)]);
  const distance = hamming(hh, hs);
  if (distance > 12) {
    await escalate(op, `the AutoHDR photo matched to "${photo.name}" does not look like it (difference ${distance}/64); nothing was spent`);
    await prisma.photoAsset.update({ where: { id: photo.id }, data: { autohdrImageUuid: null, autohdrVersionUuid: null } });
    return "escalated";
  }
  const headMeta = await sharp(headBytes).metadata();
  const srcMeta = await sharp(srcBytes).metadata();

  if (cap.requires_mask) {
    const w = headMeta.width ?? 0;
    const h = headMeta.height ?? 0;
    const sw = photo.width ?? srcMeta.width ?? w;
    const sh = photo.height ?? srcMeta.height ?? h;
    const boxes = findings
      .map((f) => (f.bboxJson ? (JSON.parse(f.bboxJson) as [number, number, number, number]) : null))
      .filter((b): b is [number, number, number, number] => !!b)
      .map(([x1, y1, x2, y2]) => [(x1 * w) / sw, (y1 * h) / sh, (x2 * w) / sw, (y2 * h) / sh] as [number, number, number, number]);
    if (!boxes.length || !w || !h) {
      await escalate(op, "this edit needs a marked area and the issue has none");
      return "escalated";
    }
    const png = await renderMask(w, h, boxes, { pct: settings.maskPaddingPct, minPx: settings.maskPaddingMinPx });
    const uploads = await autohdr.createAssetUploads(shootId, "mask", [{ filename: `mask-${op.id}.png`, content_type: "image/png" }]);
    const up = uploads[0];
    if (!up?.url || !up.s3_url) {
      await escalate(op, "AutoHDR did not return a mask upload link");
      return "escalated";
    }
    const put = await fetch(up.url, { method: "PUT", headers: { "Content-Type": "image/png" }, body: new Uint8Array(png) as unknown as BodyInit, signal: AbortSignal.timeout(60_000) });
    if (!put.ok) {
      await escalate(op, `the mask upload failed (${put.status})`);
      return "escalated";
    }
    body.mask_url = up.s3_url;
  }
  }
  if (cap.name === "reedit" || cap.name === "autofill") {
    const prompt = mergePrompts(findings.map((f) => f.reeditPrompt ?? "").filter(Boolean));
    if (!prompt) {
      await escalate(op, "this edit needs a written instruction and the issue has none");
      return "escalated";
    }
    body.prompt = prompt;
  }
  if (modelId != null) body.model_id = modelId;
  if (op.paramsJson && cap.name !== "style") {
    const params = JSON.parse(op.paramsJson) as Record<string, unknown>;
    if (Object.keys(params).length) body.params = params;
  }

  // Intent first: SUBMITTING, with everything needed to recognise the job.
  const claimed = await prisma.photoFixOperation.updateMany({
    where: { id: op.id, status: "QUEUED" },
    data: { status: "SUBMITTING", submittedAt: new Date(), inputVersionUuid: remote.image_version_uuid, estimatedCredits: price, prompt: body.prompt ?? null, maskUrl: body.mask_url ?? null },
  });
  if (claimed.count !== 1) return "waiting";
  try {
    const r = await autohdr.submitTransform(body);
    await prisma.photoFixOperation.update({ where: { id: op.id }, data: { status: "SUBMITTED", autohdrJobId: r.data.job_id, chargedCredits: price } });
    await recordLedgerEntry({ kind: op.transformName === "style" ? "STYLE" : "TRANSFORM", credits: -price, jobId: job.id, ref: r.data.job_id, note: `${cap.name} on ${photo.name}` });
    await prisma.photoQcFinding.updateMany({ where: { id: { in: ids } }, data: { status: "FIXING" } });
    await logJobEvent(job.id, "fix-runner", `submitted ${cap.name} on ${photo.name} (${price} credit${price === 1 ? "" : "s"})`, { operationId: op.id, jobId: r.data.job_id, requestId: r.requestId });
    return "submitted";
  } catch (e) {
    const err = e as AutohdrError;
    if (err.code === "uncertain" || err.status === 0 || err.status >= 500) {
      // Maybe processed. Leave SUBMITTING: the next tick LOOKS it up.
      await prisma.photoFixOperation.update({ where: { id: op.id }, data: { error: err.message.slice(0, 500) } });
      await logJobEvent(job.id, "fix-runner", `submit outcome unknown for ${photo.name}; will look it up, never resend blindly`, { operationId: op.id });
      return "waiting";
    }
    if (err.insufficientCredits) {
      await prisma.photoFixOperation.update({ where: { id: op.id }, data: { status: "QUEUED", submittedAt: null, error: "AutoHDR is out of credits (nothing was charged)" } });
      await setStage(job.id, "any", "ON_HOLD", "fix-runner", { why: "AutoHDR is out of credits (402, nothing charged)", holdReason: "CREDITS" });
      return "held";
    }
    if (err.status === 429) {
      await prisma.photoFixOperation.update({ where: { id: op.id }, data: { status: "QUEUED", submittedAt: null, error: "AutoHDR asked us to slow down (429); will try later" } });
      return "waiting";
    }
    await prisma.photoFixOperation.update({ where: { id: op.id }, data: { status: "FAILED", error: err.message.slice(0, 500), finishedAt: new Date() } });
    await prisma.photoQcFinding.updateMany({ where: { id: { in: ids } }, data: { status: "OPEN", statusReason: `AutoHDR refused the fix: ${err.message}`.slice(0, 500) } });
    await logJobEvent(job.id, "fix-runner", `AutoHDR refused ${cap.name} on ${photo.name}: ${err.message}`, { operationId: op.id, requestId: err.requestId });
    return "escalated";
  }
}

// ---- a SUBMITTING row: look it up, never resend blindly ---------------------------------
async function resolveSubmitting(op: Op): Promise<void> {
  const job = await prisma.photoJob.findUnique({ where: { id: op.jobId }, select: { autohdrPhotoshootId: true } });
  const photo = await prisma.photoAsset.findUnique({ where: { id: op.photoId }, select: { autohdrImageUuid: true, name: true } });
  if (!job?.autohdrPhotoshootId || !photo?.autohdrImageUuid || !op.submittedAt) return;
  const age = Date.now() - op.submittedAt.getTime();
  if (age < SUBMIT_LOOKUP_AFTER_MS) return;
  const jobs = await autohdr.listTransforms(job.autohdrPhotoshootId, "all");
  const hit = jobs.find(
    (j) =>
      j.image_uuid === photo.autohdrImageUuid &&
      j.transform_name === op.transformName &&
      (!op.inputVersionUuid || j.image_version_uuid === op.inputVersionUuid) &&
      (!j.submitted_at || Date.parse(j.submitted_at) >= op.submittedAt!.getTime() - 2 * MIN),
  );
  if (hit) {
    const ids = JSON.parse(op.findingIdsJson) as string[];
    await prisma.photoFixOperation.update({ where: { id: op.id }, data: { status: "SUBMITTED", autohdrJobId: hit.job_id, chargedCredits: op.estimatedCredits, error: null } });
    await recordLedgerEntry({ kind: op.transformName === "style" ? "STYLE" : "TRANSFORM", credits: -op.estimatedCredits, jobId: op.jobId, ref: hit.job_id, note: `${op.transformName} on ${photo.name} (found by lookup)` });
    await prisma.photoQcFinding.updateMany({ where: { id: { in: ids } }, data: { status: "FIXING" } });
    await logJobEvent(op.jobId, "fix-runner", `found the lost ${op.transformName} job for ${photo.name} at AutoHDR (${hit.job_id}); not resent`, { operationId: op.id });
    return;
  }
  if (age < SUBMIT_GIVE_UP_MS) return;
  if (op.attempt < 2) {
    await prisma.photoFixOperation.update({ where: { id: op.id }, data: { status: "QUEUED", submittedAt: null, attempt: op.attempt + 1, error: "AutoHDR has no record of the submission; nothing was charged; queued once more" } });
    await logJobEvent(op.jobId, "fix-runner", `AutoHDR has no record of the ${op.transformName} submission for ${photo.name} after 10 minutes; queued once more`, { operationId: op.id });
  } else {
    await escalate(op, "the submission could not be confirmed at AutoHDR twice; check AutoHDR before trying again");
  }
}

// ---- the check after a fix (free) -----------------------------------------------------------
/** What an add-on edit should have done, for the check after it (they carry no written prompt). */
const ADDON_INSTRUCTION: Record<string, string> = {
  twilight: "Turn the photo into a twilight shot: a dusk or sunset sky with warm lights glowing in the windows",
  single_angle_staging: "Virtually stage the room with realistic furniture and decor",
  declutter: "Remove the general clutter and small loose items (not the furniture)",
  style: "Re-render the photo with the twilight look: a dusk sky with lights on",
};
type FixCheck = { verdict: "fixed" | "not-fixed" | "damaged" | "unchecked"; note: string };
export async function checkFix(input: { shootId: number; imageUuid: string; output: string; prompt: string }): Promise<FixCheck> {
  const { describePhoto, jsonFrom } = await import("./fixPolicy");
  const instruction = input.prompt.replace(REEDIT_SUFFIX, "").trim() || "the requested fix";
  const prompt = [
    `This real estate photo was just edited with this instruction: "${instruction}"`,
    "Check whether it was fixed properly. Answer ONLY with JSON:",
    '{"fixed": true or false, "left": "what is still there, or empty", "damaged": true or false, "damage": "what is clearly broken, or empty"}',
    "fixed = the thing the instruction names is gone or corrected. Judge ONLY what the instruction names: other objects in the photo that it does not mention do not count, and neither do reflections or shadows of something that was removed.",
    "damaged = the edit clearly broke the photo (warped or smeared walls, melted or half-erased objects, missing windows or furniture, strange artifacts). Small imperfections are not damage.",
  ].join("\n");
  try {
    const j = jsonFrom<{ fixed?: boolean; left?: string; damaged?: boolean; damage?: string }>(await describePhoto(input.shootId, input.imageUuid, prompt, input.output));
    if (!j || typeof j.fixed !== "boolean") return { verdict: "unchecked", note: "" };
    if (j.damaged === true) return { verdict: "damaged", note: String(j.damage ?? "").slice(0, 200) };
    return j.fixed ? { verdict: "fixed", note: "" } : { verdict: "not-fixed", note: String(j.left ?? "").slice(0, 200) };
  } catch {
    return { verdict: "unchecked", note: "" };
  }
}

// ---- a SUBMITTED row: poll the job ---------------------------------------------------------
async function pollStep(op: Op): Promise<"done" | "waiting"> {
  if (!op.autohdrJobId) return "waiting";
  let j: AutohdrTransformJob;
  try {
    j = await autohdr.getTransform(op.autohdrJobId);
  } catch (e) {
    await prisma.photoFixOperation.update({ where: { id: op.id }, data: { error: (e as Error).message.slice(0, 300) } });
    return "waiting";
  }
  const ids = JSON.parse(op.findingIdsJson) as string[];
  const photo = await prisma.photoAsset.findUnique({ where: { id: op.photoId } });
  const jobRow = await prisma.photoJob.findUnique({ where: { id: op.jobId }, select: { autohdrPhotoshootId: true } });
  const hubShoot = photo ? hubShootOf(photo) : null;
  const job = { autohdrPhotoshootId: hubShoot ?? jobRow?.autohdrPhotoshootId ?? null };
  if (!photo || !job.autohdrPhotoshootId) return "waiting";
  if (j.status === "queued" || j.status === "running") {
    if (op.submittedAt && Date.now() - op.submittedAt.getTime() > POLL_ESCALATE_MS) {
      await logJobEvent(op.jobId, "fix-runner", `${op.transformName} on ${photo.name} still ${j.status} after 45 minutes; still watching`, { operationId: op.id });
    }
    return "waiting";
  }
  const charged = op.chargedCredits ?? op.estimatedCredits;
  if (j.status === "failed" || (j.status === "succeeded" && !j.output_image_version_uuid)) {
    const noop = j.status === "succeeded";
    await prisma.photoFixOperation.update({
      where: { id: op.id },
      data: { status: noop ? "NOOP" : "FAILED", refunded: true, finishedAt: new Date(), error: noop ? "AutoHDR found nothing to change" : `${j.failure_code ?? "failed"}: ${j.failure_message ?? ""}`.slice(0, 500) },
    });
    if (charged) await recordLedgerEntry({ kind: "REFUND", credits: charged, jobId: op.jobId, ref: op.autohdrJobId, note: noop ? "no-op refund" : "failed-job refund" });
    await prisma.photoQcFinding.updateMany({
      where: { id: { in: ids } },
      data: { status: "OPEN", statusReason: noop ? "AutoHDR ran the fix and changed nothing (refunded)." : `AutoHDR's fix failed (${j.failure_code ?? "failed"}, refunded).` },
    });
    await logJobEvent(op.jobId, "fix-runner", `${op.transformName} on ${photo.name}: ${noop ? "no change (refunded)" : `failed: ${j.failure_code ?? ""} (refunded)`}`, { operationId: op.id });
    return "done";
  }
  // Succeeded with a new version.
  const output = j.output_image_version_uuid!;
  if (op.transformName === "style" || (op.inputVersionUuid && j.image_version_uuid !== op.inputVersionUuid)) {
    // AutoHDR: a style result (or a redo) does not become head on its own.
    await autohdr.setVersion(job.autohdrPhotoshootId, j.image_uuid, output);
  }
  let stored: { pathname: string; url: string } | null = null;
  if (hubShoot == null) try {
    const dl = await autohdr.download(job.autohdrPhotoshootId, [{ image_uuid: j.image_uuid }]);
    if ((dl.data.credits_charged ?? 0) > 0) await recordLedgerEntry({ kind: "DOWNLOAD", credits: -(dl.data.credits_charged ?? 0), jobId: op.jobId, ref: op.autohdrJobId, note: "download of the fixed version" });
    const url = dl.data.downloads?.[0]?.url;
    if (url) stored = await storeResult(`photo-fixes/${op.jobId}/${op.photoId}/${output}.jpg`, await fetchBytes(url));
  } catch (e) {
    await logJobEvent(op.jobId, "fix-runner", `the fixed ${photo.name} could not be saved yet (${(e as Error).message}); AutoHDR keeps it for 7 days`, { operationId: op.id });
  }
  // The check after the fix (free): was it fixed properly?
  const check = await checkFix({ shootId: job.autohdrPhotoshootId, imageUuid: j.image_uuid, output, prompt: op.prompt || ADDON_INSTRUCTION[op.transformName ?? ""] || "" });
  const where = hubShoot != null ? "It is the current version in AutoHDR and goes out with the push to Aryeo." : "Replace this photo on the Aryeo listing.";
  if (check.verdict === "damaged" && j.image_version_uuid) {
    // Clearly broken: put the previous version back (free) and say so.
    await autohdr.setVersion(job.autohdrPhotoshootId, j.image_uuid, j.image_version_uuid).catch(() => null);
    await prisma.$transaction([
      prisma.photoFixOperation.update({ where: { id: op.id }, data: { status: "REVERTED", outputVersionUuid: output, finishedAt: new Date(), verificationJson: JSON.stringify(check) } }),
      prisma.photoQcFinding.updateMany({ where: { id: { in: ids } }, data: { status: "OPEN", statusReason: `The AI fix damaged the photo (${check.note || "see AutoHDR"}), so the previous version was put back.`.slice(0, 500) } }),
    ]);
    await logJobEvent(op.jobId, "fix-runner", `${op.transformName} on ${photo.name}: the check after the fix found damage; previous version put back`, { operationId: op.id, check });
    return "done";
  }
  const fixedIds = check.verdict === "not-fixed" ? [] : ids;
  await prisma.$transaction([
    prisma.photoVersion.create({
      data: { photoId: op.photoId, label: `AutoHDR ${op.transformName}`, source: "FIX", autohdrVersionUuid: output, parentVersionUuid: j.image_version_uuid, derivJson: stored ? JSON.stringify({ file: stored }) : null, createdBy: "fix-runner" },
    }),
    // A hub photo's stored link points at the old version: the next view fetches the fixed one (free).
    prisma.photoAsset.update({ where: { id: op.photoId }, data: { autohdrVersionUuid: output, ...(hubShoot != null ? { sourceUrl: null } : {}) } }),
    prisma.photoFixOperation.update({ where: { id: op.id }, data: { status: check.verdict === "fixed" ? "VERIFIED" : "SUCCEEDED", outputVersionUuid: output, finishedAt: new Date(), error: hubShoot != null || stored ? null : "fixed in AutoHDR; file not stored in the hub yet", verificationJson: JSON.stringify(check) } }),
    prisma.photoQcFinding.updateMany({ where: { id: { in: fixedIds } }, data: { status: "FIXED", statusReason: `${check.verdict === "fixed" ? "Fixed and checked." : "Fixed (the check afterwards could not run)."} ${where}` } }),
    prisma.photoQcFinding.updateMany({ where: { id: { in: check.verdict === "not-fixed" ? ids : [] } }, data: { status: "OPEN", statusReason: `Still there after the AI fix${check.note ? `: ${check.note}` : ""}. A person should look.`.slice(0, 500) } }),
  ]);
  await logJobEvent(op.jobId, "fix-runner", `${op.transformName} on ${photo.name}: ${check.verdict === "fixed" ? "fixed and checked" : check.verdict === "not-fixed" ? "the check after the fix says it is still there" : "done (not checked)"} (new version ${output.slice(0, 8)})`, { operationId: op.id, check });
  return "done";
}

async function finishBatches(jobIds: Set<string>): Promise<void> {
  for (const jobId of jobIds) {
    const batches = await prisma.photoFixBatch.findMany({ where: { jobId, status: { in: ["PENDING", "RUNNING"] } }, include: { operations: true } });
    for (const b of batches) {
      if (!b.operations.every((o) => TERMINAL.includes(o.status))) continue;
      const ok = b.operations.filter((o) => o.status === "SUCCEEDED" || o.status === "VERIFIED").length;
      const charged = b.operations.reduce((s, o) => s + (o.refunded ? 0 : o.chargedCredits ?? 0), 0);
      const auto = b.approvedBy === "auto-fix";
      const hubPhotos = await prisma.photoAsset.count({ where: { id: { in: b.operations.map((o) => o.photoId) }, sourceKind: "AUTOHDR" } });
      const status = ok === b.operations.length ? "DONE" : ok > 0 ? "PARTIAL" : "FAILED";
      const done = await prisma.photoFixBatch.updateMany({ where: { id: b.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status } });
      if (done.count !== 1) continue;
      const open = await prisma.photoQcFinding.count({ where: { jobId, status: "OPEN", severity: { in: ["CRITICAL", "MAJOR"] } } });
      await setStage(jobId, ["FIXING"], open ? "QC_REVIEW" : "READY", "fix-runner", { why: `fix batch ${status.toLowerCase()}: ${ok} of ${b.operations.length} applied` });
      const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
      const project = job ? await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true } }) : null;
      const street = (project?.title ?? "a listing").split(",")[0];
      const next = hubPhotos ? "They are the current versions in AutoHDR: look them over there, then push the shoot to Aryeo as usual." : "Replace the fixed photos on the Aryeo listing.";
      await alertOwnerAndKyle({
        kind: "photo_fixes_done",
        title: `${auto ? "Automatic fixes" : "Fixes"} done: ${street}`.slice(0, 90),
        body: `${ok} of ${b.operations.length} photos fixed (${charged} credit${charged === 1 ? "" : "s"}). ${next}`.slice(0, 200),
        href: `/ops/photo-delivery/${jobId}`,
        dedupeKey: `pd-fixes-${b.id}`,
        text: `${auto ? "Automatic fixes" : "Fixes"} done on ${street}: ${ok} of ${b.operations.length} photos fixed (${charged} credit${charged === 1 ? "" : "s"})${open ? `, ${open} issue${open === 1 ? "" : "s"} still need a call` : ""}. ${next} ${appBase()}/ops/photo-delivery/${jobId}`,
        to: auto ? "both" : "kyle",
      });
    }
  }
}

/** One tick: move every approved operation one step. */
export async function driveFixes(opts: { budgetMs: number; leaseBy: string }): Promise<{ skipped?: string; submitted: number; polled: number; resolved: number; held: number; escalated: number }> {
  const out = { submitted: 0, polled: 0, resolved: 0, held: 0, escalated: 0 };
  const settings = await photoDeliverySettings();
  const pending = await prisma.photoFixOperation.count({ where: { status: { in: ["QUEUED", "SUBMITTING", "SUBMITTED"] } } });
  if (!pending) return { ...out };
  if (!(await autohdrConfigured())) return { skipped: "AutoHDR API not connected", ...out };
  const started = Date.now();
  const touched = new Set<string>();
  let spent = false;

  // In flight first (they already cost credits): poll, and resolve lost submissions.
  const inflight = await prisma.photoFixOperation.findMany({ where: { status: { in: ["SUBMITTED", "SUBMITTING"] } }, orderBy: { updatedAt: "asc" }, take: 40 });
  for (const op of inflight) {
    if (Date.now() - started > opts.budgetMs) break;
    touched.add(op.jobId);
    if (op.status === "SUBMITTING") {
      await resolveSubmitting(op).catch((e) => console.warn("fix lookup failed", op.id, (e as Error).message));
      out.resolved++;
    } else {
      const r = await pollStep(op).catch(() => "waiting" as const);
      if (r === "done") spent = true;
      out.polled++;
    }
  }

  // New submissions only while the owner's switch is on.
  if (settings.fixRunnerEnabled) {
    const queued = await prisma.photoFixOperation.findMany({ where: { status: "QUEUED" }, orderBy: [{ createdAt: "asc" }, { seq: "asc" }], take: 40 });
    const busyPhotos = new Set((await prisma.photoFixOperation.findMany({ where: { status: { in: ["SUBMITTING", "SUBMITTED"] } }, select: { photoId: true } })).map((o) => o.photoId));
    const heldJobs = new Set<string>();
    for (const op of queued) {
      if (Date.now() - started > opts.budgetMs) break;
      // One operation per photo at a time, in order: each builds on the last.
      if (busyPhotos.has(op.photoId) || heldJobs.has(op.jobId)) continue;
      const earlier = await prisma.photoFixOperation.count({ where: { photoId: op.photoId, batchId: op.batchId, seq: { lt: op.seq }, status: { notIn: TERMINAL } } });
      if (earlier) continue;
      touched.add(op.jobId);
      await prisma.photoFixBatch.updateMany({ where: { id: op.batchId, status: "PENDING" }, data: { status: "RUNNING" } });
      try {
        const r = await submitStep(op);
        if (r === "submitted") {
          out.submitted++;
          spent = true;
          busyPhotos.add(op.photoId);
        } else if (r === "held") {
          out.held++;
          heldJobs.add(op.jobId);
        } else if (r === "escalated") out.escalated++;
      } catch (e) {
        // An error BEFORE the claim leaves the row QUEUED; after the claim the
        // row is SUBMITTING and is looked up next tick. Either way nothing is
        // resent blindly.
        console.warn("fix submit step failed", op.id, (e as Error).message);
        await logJobEvent(op.jobId, "fix-runner", `fix step error: ${(e as Error).message}`.slice(0, 300), { operationId: op.id });
      }
    }
  }
  await finishBatches(touched);
  if (spent) await recordCreditSnapshot({ trigger: "after-spend" }).catch(() => null);
  return settings.fixRunnerEnabled ? out : { skipped: "new fixes are switched off (fixRunnerEnabled)", ...out };
}
