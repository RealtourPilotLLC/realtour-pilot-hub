import "server-only";
import { houseOverrides, mergeOverrides } from "../houseRules";

import { createHash } from "node:crypto";
import type { PhotoAsset, PhotoJob, PhotoQcRun, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { etAt, etDayKey } from "@/lib/datetime";
import {
  RULES_REGISTRY_VERSION,
  ROOM_TYPES,
  renderRulesBlock,
  rulesForPass,
  visionRulesForPhoto,
  type RoomType,
  type RuleOverride,
  type Severity,
} from "../registry";
import { photoDeliverySettings, type PhotoDeliverySettings, type QcModelSlot } from "../settings";
import { claimJob, logJobEvent, releaseJob, setStage, type JobStage } from "../jobState";
import { alertOwnerAndKyle, opsRecipients } from "../notifyOps";
import { derivativePathname, derivativeStore, readDerivativeBytes, type StoredRef } from "../blob";
import { QcCallError, runPass, type CallRecord, type QcImage } from "./claude";
import {
  UI_SIZES,
  cutCrops,
  decodeRaster,
  derivCache,
  derivKey,
  inspectionSize,
  jpegMissingEoi,
  parseDerivMap,
  readMeta,
  renderFromRaster,
  strictDecode,
  type DerivMap,
  type DerivSize,
} from "./derivatives";
import {
  CV_THRESHOLDS,
  analyzeRaster,
  clusterDust,
  cvFlags,
  duplicatePairs,
  fileIssues,
  median,
  parseCv,
  resolutionOutliers,
  severeBlurIssue,
  type CvMetrics,
  type P1bState,
  type RecurrenceGroup,
  type StoredCv,
} from "./cv";
import {
  applyArbiter,
  cvIssueDraft,
  draftToRow,
  mergeDust,
  p1bDrafts,
  p1Drafts,
  p2Drafts,
  p4Drafts,
  toSentBox,
  unavailableDraft,
  validateArbiter,
  validateP0,
  validateP1,
  validateP1b,
  validateP2,
  validateP4,
  validateSummary,
  type Box,
  type FindingDraft,
  type P1bCrop,
  type P1Ctx,
  type P4Ctx,
} from "./normalize";
import { deliveryOrder, finalFilenames, jobVerdict, photoVerdicts, qcStageFor, type JobVerdict, type OrderPhoto, type VerdictResult } from "./verdict";
import {
  ARBITER_TEXT,
  DELIVERY_SUMMARY_V1,
  MAX_CROPS_PER_CALL,
  MAX_CROPS_PER_GALLERY,
  P0_CLASSIFY_V1,
  P0_TEXT,
  P1B_DUST_V1,
  P1B_LABEL,
  P1B_TEXT,
  P1_ARBITER_V1,
  P1_PHOTO_V1,
  P1_TEXT,
  P2_GALLERY_V1,
  P2_LABEL,
  P2_OVERVIEW_MAX_TOKENS,
  P2_TEXT,
  P4_ORDER_V1,
  P4_TEXT,
  QC_LINK_TOKEN,
  SUMMARY_TEXT,
  arbiterJsonSchema,
  fmtNum,
  injectedRule,
  p0JsonSchema,
  p1bJsonSchema,
  p1JsonSchema,
  p2JsonSchema,
  p4JsonSchema,
  promptVersions,
  render,
  ruleIdEnum,
  sanitizeUntrusted,
  stripLongDashes,
  summaryJsonSchema,
  yesNo,
  type CoverageItem,
  type CoverageStatusT,
  type InjectedRule,
  type P4Output,
  type P1Output,
  type ArbiterOutput,
  type TemplateValue,
} from "./prompts";
import { PhotoSourceError, loadPhotoBytes } from "./source";

// ---------------------------------------------------------------------------
// THE QC RUN (plan §7, prompt pack 0.3; Oct 13 2026).
//
// driveQc is called by the photo-delivery cron every 5 minutes with a time
// budget. There is no queue service, so a QC run is "one bounded slice of
// work per tick, resumable": every unit of work is keyed by the photo's
// content hash (derivHash, cvHash, classifiedHash, inspectedHash, the P1b
// state in cvJson) or recorded on the run row (P2 units, P4), and is written
// in the SAME transaction as the findings it produced. A tick killed
// mid-way loses only the unit in flight; the next tick carries on, and work
// already done for a content hash is never paid for twice.
//
// One run per pass-set: the PhotoQcRun row is created when a job enters
// QC_RUNNING and is finished (DONE) when every active photo is done and the
// gallery passes have run. The order inside a run (plan §7.2):
//
//   A  prep     per photo: read the file (Dropbox or the Aryeo listing),
//               file checks, derivatives, CV metrics, dust crops
//   B1 P0       classify every photo (one warm-up call, then 4 at a time)
//   B2 P1       inspect every photo with its room's rules, sorted by room
//               type; the first call per rules prefix runs alone so the
//               prompt cache is warm for the rest (0.3)
//   B3 arbiter  every CRITICAL from P1 gets an independent Opus look
//   C1 P1b      full-resolution dust crops, prioritised by recurrence across
//               the gallery, 20 per call, 60 per gallery
//   C2 P2       gallery consistency: room clusters, then an overview
//   C3 P4       order coverage, text only
//   F  finalize gallery CV findings (exact duplicates, resolution), repeated
//               dust regrouped, stale findings superseded, verdicts, the
//               delivery order and hero, the Delivery Summary, the stage
//               move and the notifications
//
// P0 runs for EVERY photo before any P1 and the gallery-level dust clustering
// runs before P1b: P1 needs each photo's gallery position (escalation on a
// hero exterior) and the gallery blur median, and P1b needs the recurrence
// groups (pack 3.1). Per photo the chain is still the one in the brief:
// derivatives, CV, P0, P1, arbiter, P1b.
//
// SHADOW MODE (settings.qcShadow, the default): the verdict is recorded and
// the job goes to QC_REVIEW (anything at MAJOR or above) or READY. It never
// holds a job, and nobody is texted: Kyle gets one bell row per run.
// ---------------------------------------------------------------------------

type Asset = PhotoAsset;
type Trigger = "INITIAL" | "MANUAL" | "POST_FIX" | "REVISION";

const MIN = 60_000;
/** Below this much budget a new job is not started. */
const MIN_JOB_MS = 30_000;
/** A photo's prep (download, decode, CV) is only started with this much left. */
const PREP_MIN_MS = 25_000;
const PREP_CONCURRENCY = 2;
const CALL_CONCURRENCY = 4;
const ARBITER_CONCURRENCY = 2;
/** Transient failures of one unit before it is treated as permanent. */
const MAX_TRANSIENT = 3;
/** Crops cut per photo while its file is already in memory (prep). */
const PREP_CROPS = 6;
const P2_MAX_CLUSTERS = 6;
const P2_CLUSTER_FULL_SIZE_MAX = 20;
const P2_OVERVIEW_BATCH = 40;
const P2_MAX_OVERVIEW_BATCHES = 3;
const PASS_SET = ["CV", "P0", "P1", "ARBITER", "P1B", "P2", "P4", "SUMMARY"];
const QC_STAGES_FROM: JobStage[] = ["EDITED", "QC_REVIEW", "READY", "ON_HOLD", "FIXING", "REVISION_REQUESTED"];
/** P2 cluster mode compares angles of ONE space (pack 4.2): room types that
 *  are usually one space in a listing. Bedrooms and bathrooms are several
 *  rooms, so they are compared only in the overview. */
const CLUSTER_ROOMS = new Set<string>([
  "KITCHEN", "LIVING", "FAMILY", "DINING", "ENTRY_FOYER", "PRIMARY_BEDROOM", "PRIMARY_BATHROOM", "OFFICE",
  "LAUNDRY", "BASEMENT_FINISHED", "EXTERIOR_FRONT", "EXTERIOR_REAR", "TWILIGHT_EXTERIOR", "PATIO_DECK", "POOL_SPA", "AERIAL",
]);

// ---- clock (swappable in drills) -------------------------------------------------------

let nowFn: () => number = () => Date.now();
/** Drills only: drive the budget clock (e.g. advance it per stubbed call). */
export function __setQcClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}
const now = () => nowFn();

// ---- the run's own state (PhotoQcRun.summaryJson while RUNNING) -------------------------

type PassMetric = { calls: number; ms: number; costUsd: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number };

export type RunProgress = {
  ticks: number;
  wallMs: number;
  calls: number;
  byPass: Record<string, PassMetric>;
  /** Units that failed transiently: key → count (photo loads, calls). */
  transient: Record<string, number>;
  /** Arbiter attempts that ended without a verdict (finding ids). */
  arbiterTried: string[];
  p2Units: string[];
  p2Done: boolean;
  p4Done: boolean;
  coverage: P4Output | null;
};

/** PhotoQcRun.summaryJson. While RUNNING only `progress` is meaningful. */
export type QcRunSummary = {
  v: 1;
  progress: RunProgress;
  verdict?: JobVerdict;
  shadow?: boolean;
  stage?: string;
  counts?: VerdictResult["counts"];
  tickets?: { key: string; ruleId: string; title: string; severity: Severity; photoIds: string[]; holds: boolean; escalated: boolean; lowConfidence: boolean }[];
  order?: { photoId: string; position: number; filename: string }[];
  heroPhotoId?: string | null;
  /** P4's checklist, MET items included (the page's Coverage tab). */
  coverage?: CoverageItem[];
  missingDeliverables?: P4Output["missingDeliverables"];
  dataGaps?: string[];
  deliverySummary?: { lines: string[]; text: string; source: "model" | "template" };
  metrics?: { costUsd: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; calls: number; wallMs: number; ticks: number; byPass: Record<string, PassMetric> };
  notes?: string[];
};

/** PhotoQcRun.checksJson: the checks ledger (pack 0.9, registry section 22). */
export type ChecksLedger = {
  photos: Record<string, { performed: string[]; skipped: { check: string; reason: string }[] }>;
  gallery: { performed: string[]; skipped: { check: string; reason: string }[] };
};

const emptyProgress = (): RunProgress => ({ ticks: 0, wallMs: 0, calls: 0, byPass: {}, transient: {}, arbiterTried: [], p2Units: [], p2Done: false, p4Done: false, coverage: null });

// ---- job context -------------------------------------------------------------------------

type Expected = {
  minPhotos?: number;
  maxPhotos?: number;
  droneCount?: number;
  twilightReal?: number;
  twilightVirtual?: number;
  virtualStagingCount?: number;
  floorPlan?: boolean;
  bedrooms?: number;
  bathrooms?: number;
  sqft?: number;
  propertyType?: string;
  address?: string;
  city?: string;
  state?: string;
  requestedFeatures?: string[];
  specialInstructions?: string;
};

type Ctx = {
  job: PhotoJob;
  run: PhotoQcRun;
  settings: PhotoDeliverySettings;
  deadline: number;
  tickStart: number;
  leaseBy: string;
  street: string;
  fullAddress: string;
  city: string | null;
  state: string | null;
  expected: Expected | null;
  clientNotes: string;
  overrides: RuleOverride[];
  groupOrder: string[] | null;
  ingest: { fireplace: string | null; tv: string | null; grass: string | null; declutter: string | null };
  photos: Asset[];
  progress: RunProgress;
  checks: ChecksLedger;
  models: Record<string, string>;
  modelDetail: Record<string, { requested: string; used: string; fallbackFrom: string | null; mode: string }>;
  notes: string[];
  abort: Error | null;
  stoppedFor: string | null;
  done: { prepped: number; classified: number; inspected: number; arbitrated: number; p1bCalls: number; p2Units: number; p4: boolean };
  sourceLoads: Map<string, Promise<void>>;
  saveChain: Promise<void>;
};

const hashOf = (p: Pick<Asset, "id" | "contentHash">) => p.contentHash || `asset:${p.id}`;
const prepDone = (p: Asset) => p.cvHash === hashOf(p) && p.derivHash === hashOf(p);
const storedCv = (p: Asset): StoredCv | null => (prepDone(p) ? parseCv(p.cvJson) : null);
const metricsOf = (p: Asset): CvMetrics | null => storedCv(p)?.metrics ?? null;
const hasImage = (p: Asset) => !!metricsOf(p);
const classified = (p: Asset) => p.classifiedHash === hashOf(p);
const inspected = (p: Asset) => p.inspectedHash === hashOf(p);
const activeOf = (ctx: Ctx) => ctx.photos.filter((p) => p.status === "ACTIVE");
const timeLeft = (ctx: Ctx) => ctx.deadline - now();
const canStart = (ctx: Ctx, ms: number) => !ctx.abort && timeLeft(ctx) >= ms;

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s) as T;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/** Run `fn` over `items`, `limit` at a time, starting a new item only while
 *  `may()` holds. Resolves true when every item was started and finished. */
async function pool<T>(items: T[], limit: number, may: () => boolean, fn: (t: T) => Promise<void>): Promise<boolean> {
  let i = 0;
  let stopped = false;
  let firstError: unknown = null;
  const worker = async () => {
    for (;;) {
      if (firstError || i >= items.length) return;
      if (!may()) {
        stopped = true;
        return;
      }
      const t = items[i++];
      try {
        await fn(t);
      } catch (e) {
        firstError ??= e;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (firstError) throw firstError;
  return !stopped && i >= items.length;
}

// ---- persistence helpers --------------------------------------------------------------------

function summaryOf(ctx: Ctx, extra: Partial<QcRunSummary> = {}): QcRunSummary {
  return { v: 1, progress: ctx.progress, ...extra };
}

/** Serialised write of the run's JSON state (progress, ledger, models). */
function saveRun(ctx: Ctx, data: Prisma.PhotoQcRunUpdateInput = {}): Promise<void> {
  const next = ctx.saveChain.then(async () => {
    await prisma.photoQcRun.update({
      where: { id: ctx.run.id },
      data: {
        summaryJson: JSON.stringify(summaryOf(ctx)),
        checksJson: JSON.stringify(ctx.checks),
        modelsJson: JSON.stringify({ ...ctx.models, _detail: ctx.modelDetail }),
        ...data,
      },
    });
  });
  ctx.saveChain = next.catch(() => {});
  return next;
}

/** Run-state update that rides in the same transaction as the findings. */
function runStateWrite(ctx: Ctx) {
  return prisma.photoQcRun.update({
    where: { id: ctx.run.id },
    data: { summaryJson: JSON.stringify(summaryOf(ctx)), checksJson: JSON.stringify(ctx.checks), modelsJson: JSON.stringify({ ...ctx.models, _detail: ctx.modelDetail }) },
  });
}

/** Every Claude call: tokens and cost land on the run row at once (so spend
 *  is counted even if the run never finishes), metrics per pass in memory. */
function onCall(ctx: Ctx, slot: QcModelSlot) {
  return async (rec: CallRecord) => {
    ctx.progress.calls++;
    const m = (ctx.progress.byPass[rec.promptId] ??= { calls: 0, ms: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 });
    m.calls++;
    m.ms += rec.latencyMs;
    m.costUsd = Math.round((m.costUsd + rec.costUsd) * 1e6) / 1e6;
    m.tokensIn += rec.usage.inputTokens;
    m.tokensOut += rec.usage.outputTokens;
    m.cacheRead += rec.usage.cacheReadTokens;
    m.cacheWrite += rec.usage.cacheWriteTokens;
    if (rec.status >= 200 && rec.status < 300) {
      ctx.models[slot] = rec.model;
      ctx.modelDetail[slot] = { requested: rec.requestedModel, used: rec.model, fallbackFrom: rec.fallbackFrom, mode: rec.mode };
    }
    if (rec.costUsd > 0 || rec.usage.inputTokens > 0) {
      await prisma.photoQcRun.update({
        where: { id: ctx.run.id },
        data: {
          tokensIn: { increment: rec.usage.inputTokens },
          tokensOut: { increment: rec.usage.outputTokens },
          cacheRead: { increment: rec.usage.cacheReadTokens },
          cacheWrite: { increment: rec.usage.cacheWriteTokens },
          costUsd: { increment: rec.costUsd },
        },
      });
    }
  };
}

function ledgerFor(ctx: Ctx, photoId: string) {
  return (ctx.checks.photos[photoId] ??= { performed: [], skipped: [] });
}
function ledgerSkip(ctx: Ctx, photoId: string | null, check: string, reason: string) {
  const l = photoId ? ledgerFor(ctx, photoId) : ctx.checks.gallery;
  l.skipped = [...l.skipped.filter((s) => s.check !== check), { check, reason: reason.slice(0, 200) }];
  l.performed = l.performed.filter((c) => c !== check);
}
function ledgerDone(ctx: Ctx, photoId: string | null, checks: string[]) {
  const l = photoId ? ledgerFor(ctx, photoId) : ctx.checks.gallery;
  for (const c of checks) {
    if (!l.performed.includes(c)) l.performed.push(c);
    l.skipped = l.skipped.filter((s) => s.check !== c);
  }
}

/** Count a transient failure of one unit; true once it has failed too often. */
function transientExhausted(ctx: Ctx, key: string): boolean {
  ctx.progress.transient[key] = (ctx.progress.transient[key] ?? 0) + 1;
  return ctx.progress.transient[key] >= MAX_TRANSIENT;
}

async function refreshPhotos(ctx: Ctx): Promise<void> {
  ctx.photos = await prisma.photoAsset.findMany({ where: { jobId: ctx.job.id }, orderBy: [{ sequence: "asc" }, { name: "asc" }] });
}

// ---- images for the passes -------------------------------------------------------------------

/** Load the photo's file once (single-flight per tick) and put every UI size
 *  plus any requested size and crops into the in-process cache. */
async function rebuildFromSource(ctx: Ctx, p: Asset, want: { sizes?: DerivSize[]; crops?: number[] }): Promise<void> {
  const key = `${p.id}:${hashOf(p)}:${(want.sizes ?? []).join(",")}:${(want.crops ?? []).join(",")}`;
  const existing = ctx.sourceLoads.get(key);
  if (existing) return existing;
  const job = (async () => {
    const hash = hashOf(p);
    const bytes = await loadPhotoBytes(p);
    const meta = await readMeta(bytes);
    const raster = await decodeRaster(bytes, meta);
    for (const size of new Set<DerivSize>([...UI_SIZES, ...(want.sizes ?? [])])) {
      const r = await renderFromRaster(raster, size);
      derivCache.set(derivKey(p.id, hash, size), r.data);
    }
    const cv = metricsOf(p);
    if (want.crops?.length && cv) {
      const idx = want.crops.filter((i) => !!cv.dustCandidates[i]);
      const crops = await cutCrops(bytes, meta, idx.map((i) => ({ x: cv.dustCandidates[i].x, y: cv.dustCandidates[i].y })));
      idx.forEach((i, k) => crops[k] && derivCache.set(derivKey(p.id, hash, `crop:${i}`), crops[k].data));
    }
  })();
  ctx.sourceLoads.set(key, job);
  try {
    await job;
  } finally {
    ctx.sourceLoads.delete(key);
  }
}

async function jpegSize(data: Buffer): Promise<{ w: number; h: number }> {
  const sharp = (await import("sharp")).default;
  const m = await sharp(data).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0 };
}

/** A derivative for a pass: memory, then the private store, then the source. */
async function imageFor(ctx: Ctx, p: Asset, size: DerivSize, label?: string | null): Promise<QcImage> {
  const hash = hashOf(p);
  const key = derivKey(p.id, hash, size);
  let data = derivCache.get(key) ?? null;
  if (!data) {
    const ref = parseDerivMap(p.derivJson)[size];
    if (ref?.pathname && ref.url && p.derivHash === hash) {
      data = await readDerivativeBytes({ pathname: ref.pathname, url: ref.url });
      if (data) derivCache.set(key, data);
    }
  }
  if (!data) {
    await rebuildFromSource(ctx, p, { sizes: [size] });
    data = derivCache.get(key) ?? null;
  }
  if (!data) throw new PhotoSourceError(`derivative ${size} unavailable`, "transient", "the photo could not be prepared");
  // The sent size the prompt states and the boxes are measured in: the
  // recorded one when it describes this version, else read off the bytes.
  const known = p.derivHash === hash ? parseDerivMap(p.derivJson)[size] : undefined;
  const dims = known && known.w && known.h ? { w: known.w, h: known.h } : await jpegSize(data);
  return { data, w: dims.w, h: dims.h, label: label ?? null };
}

async function cropFor(ctx: Ctx, p: Asset, index: number, allWanted: number[]): Promise<Buffer> {
  const hash = hashOf(p);
  const key = derivKey(p.id, hash, `crop:${index}`);
  let data = derivCache.get(key) ?? null;
  if (!data) {
    const ref = parseDerivMap(p.derivJson) as Record<string, { pathname?: string; url?: string } | undefined>;
    const stored = ref[`crop${index}`];
    if (stored?.pathname && stored.url && p.derivHash === hash) data = await readDerivativeBytes({ pathname: stored.pathname, url: stored.url });
  }
  if (!data) {
    await rebuildFromSource(ctx, p, { crops: allWanted });
    data = derivCache.get(key) ?? null;
  }
  if (!data) throw new PhotoSourceError(`crop ${index} unavailable`, "transient", "the dust crop could not be cut");
  derivCache.set(key, data);
  return data;
}

// ---- A: prep ---------------------------------------------------------------------------------

async function persistUnavailable(ctx: Ctx, p: Asset, kind: string, reason: string, drafts: FindingDraft[]): Promise<void> {
  const hash = hashOf(p);
  const cv: StoredCv = { v: 1, metrics: null, unavailable: { kind, reason, at: new Date(now()).toISOString() }, p1b: null };
  for (const c of ["P0", "P1", "P1B"]) ledgerSkip(ctx, p.id, c, `file not available: ${reason}`);
  await prisma.$transaction([
    prisma.photoQcFinding.updateMany({ where: { jobId: ctx.job.id, photoId: p.id, contentHash: hash, status: "OPEN", source: { in: ["FILE", "CV"] } }, data: { status: "SUPERSEDED", statusReason: "re-checked" } }),
    prisma.photoQcFinding.createMany({ data: drafts.filter((d) => ruleOn(ctx, d.ruleId)).map((d) => draftToRow(d, ctx.run.id, ctx.job.id)) }),
    prisma.photoAsset.updateMany({
      where: { id: p.id, contentHash: p.contentHash },
      data: { cvJson: JSON.stringify(cv), cvHash: hash, derivJson: JSON.stringify({}), derivHash: hash, classifiedHash: hash, inspectedHash: hash, lastQcAt: new Date(now()) },
    }),
    runStateWrite(ctx),
  ]);
  await logJobEvent(ctx.job.id, "qc", `photo could not be checked: ${p.name}`, { photoId: p.id, kind, reason });
}

async function prepPhoto(ctx: Ctx, p: Asset): Promise<void> {
  const hash = hashOf(p);
  let bytes: Buffer;
  try {
    bytes = await loadPhotoBytes(p);
  } catch (e) {
    if (!(e instanceof PhotoSourceError)) throw e;
    if (e.kind === "transient" && !transientExhausted(ctx, `load:${p.id}:${hash}`)) {
      await saveRun(ctx);
      return;
    }
    const why = e.kind === "transient" ? `${e.publicReason} (after ${MAX_TRANSIENT} tries)` : e.publicReason;
    const drafts: FindingDraft[] =
      e.kind === "unsupported"
        ? [unavailableDraft({ photoId: p.id, contentHash: hash, pass: "P1_PHOTO", source: "FILE", promptId: null, model: null, reason: why, what: "The photo could not be read" })]
        : [cvIssueDraft({ ruleId: "FILE_OPENS", severity: "CRITICAL", confidence: 0.9, specificIssue: "Photo could not be loaded", explanation: `The file could not be read: ${why}.`, recommendedAction: "Check the photo at its source, then run QC again." }, { photoId: p.id, contentHash: hash })];
    await persistUnavailable(ctx, p, e.kind, why, drafts);
    return;
  }

  // Decode once; a file sharp cannot read at all is a FILE_OPENS finding.
  let meta: Awaited<ReturnType<typeof readMeta>> | null = null;
  try {
    meta = await readMeta(bytes);
  } catch (e) {
    meta = null;
    const issues = fileIssues({ meta: null, strictError: (e as Error).message.slice(0, 160), missingEoi: false, name: p.name, path: p.dropboxPath, minLongEdgePx: ctx.settings.minLongEdgePx, metrics: null });
    await persistUnavailable(ctx, p, "decode", "the file does not decode as an image", issues.map((i) => cvIssueDraft(i, { photoId: p.id, contentHash: hash })));
    return;
  }
  const strict = await strictDecode(bytes);
  let raster: Awaited<ReturnType<typeof decodeRaster>>;
  try {
    raster = await decodeRaster(bytes, meta);
  } catch (e) {
    const issues = fileIssues({ meta, strictError: strict.ok ? (e as Error).message.slice(0, 160) : strict.error, missingEoi: jpegMissingEoi(bytes), name: p.name, path: p.dropboxPath, minLongEdgePx: ctx.settings.minLongEdgePx, metrics: null });
    await persistUnavailable(ctx, p, "decode", "the image could not be decoded", issues.map((i) => cvIssueDraft(i, { photoId: p.id, contentHash: hash })));
    return;
  }

  const store = derivativeStore();
  const deriv: DerivMap & Record<string, unknown> = {};
  for (const size of UI_SIZES) {
    const r = await renderFromRaster(raster, size);
    derivCache.set(derivKey(p.id, hash, size), r.data);
    let ref: StoredRef | null = null;
    if (store) {
      try {
        ref = await store.put(derivativePathname(ctx.job.id, p.id, hash, size), r.data, "image/jpeg");
      } catch (e) {
        console.warn("photo-qc: derivative not stored", p.id, size, (e as Error).message);
      }
    }
    deriv[size] = ref ? { w: r.w, h: r.h, pathname: ref.pathname, url: ref.url, bytes: r.data.length } : { w: r.w, h: r.h };
  }
  const metrics = await analyzeRaster(raster, meta);
  const centers = metrics.dustCandidates.slice(0, PREP_CROPS);
  if (centers.length) {
    const crops = await cutCrops(bytes, meta, centers.map((c) => ({ x: c.x, y: c.y })));
    for (let i = 0; i < crops.length; i++) {
      derivCache.set(derivKey(p.id, hash, `crop:${i}`), crops[i].data);
      if (store) {
        try {
          const ref = await store.put(derivativePathname(ctx.job.id, p.id, hash, `crop-${i}`), crops[i].data, "image/jpeg");
          deriv[`crop${i}`] = { w: crops[i].w, h: crops[i].h, pathname: ref.pathname, url: ref.url };
        } catch {
          /* the crop is rebuilt from the source when needed */
        }
      }
    }
  }
  const issues = fileIssues({ meta, strictError: strict.ok ? null : strict.error, missingEoi: meta.format === "jpeg" && jpegMissingEoi(bytes), name: p.name, path: p.dropboxPath, minLongEdgePx: ctx.settings.minLongEdgePx, metrics });
  const blur = severeBlurIssue(metrics);
  if (blur) issues.push(blur);
  const drafts = issues.map((i) => cvIssueDraft(i, { photoId: p.id, contentHash: hash }));
  const cv: StoredCv = { v: 1, metrics, unavailable: null, p1b: null };
  ledgerDone(ctx, p.id, ["FILE_CHECKS", "CV"]);
  await prisma.$transaction([
    prisma.photoQcFinding.updateMany({ where: { jobId: ctx.job.id, photoId: p.id, contentHash: hash, status: "OPEN", source: { in: ["FILE", "CV"] } }, data: { status: "SUPERSEDED", statusReason: "re-checked" } }),
    prisma.photoQcFinding.createMany({ data: drafts.filter((d) => ruleOn(ctx, d.ruleId)).map((d) => draftToRow(d, ctx.run.id, ctx.job.id)) }),
    prisma.photoAsset.updateMany({
      where: { id: p.id, contentHash: p.contentHash },
      data: { width: meta.width, height: meta.height, format: meta.format, bytes: bytes.length, derivJson: JSON.stringify(deriv), derivHash: hash, cvJson: JSON.stringify(cv), cvHash: hash },
    }),
    runStateWrite(ctx),
  ]);
  ctx.done.prepped++;
}

// ---- prompt variables ---------------------------------------------------------------------------

const labelFor = (pos: number) => `ph_${String(pos).padStart(2, "0")}`;

function orderOf(ctx: Ctx): { order: Asset[]; position: Map<string, number>; label: Map<string, string>; idOfLabel: Map<string, string> } {
  const active = activeOf(ctx);
  const { order } = deliveryOrder(active as (Asset & OrderPhoto)[], { groupOrder: ctx.groupOrder, heroId: ctx.job.heroPhotoId, manualOrder: parseJson<string[] | null>(ctx.job.orderJson, null) });
  const position = new Map(order.map((p, i) => [p.id, i + 1]));
  const label = new Map(order.map((p, i) => [p.id, labelFor(i + 1)]));
  const idOfLabel = new Map(order.map((p, i) => [labelFor(i + 1), p.id]));
  return { order, position, label, idOfLabel };
}

function propertyVars(ctx: Ctx): Record<string, TemplateValue> {
  const e = ctx.expected;
  return {
    address: ctx.fullAddress,
    propertyType: e?.propertyType ? sanitizeUntrusted(e.propertyType, 80) : null,
    city: ctx.city,
    state: ctx.state,
    beds: e?.bedrooms ?? null,
    baths: e?.bathrooms ?? null,
    sqft: e?.sqft ?? null,
  };
}

function orderedFlag(ctx: Ctx, n: number | undefined): string | null {
  if (!ctx.expected) return null;
  return yesNo((n ?? 0) > 0);
}

function rulesFor(ctx: Ctx, p: Asset) {
  const roomType = ((ROOM_TYPES as readonly string[]).includes(p.roomType ?? "") ? p.roomType : "OTHER") as RoomType;
  const alt = (ROOM_TYPES as readonly string[]).includes(p.alternateRoomType ?? "") ? (p.alternateRoomType as RoomType) : null;
  const confidence = p.roomConfidence ?? 0;
  const rules = visionRulesForPhoto({ roomType, roomConfidence: confidence, alternateRoomType: alt, maxBuildPhase: ctx.settings.maxBuildPhase, overrides: ctx.overrides });
  const rooms = [roomType, ...(confidence < 0.6 && alt && alt !== roomType ? [alt] : [])].sort();
  const key = rooms.join("+");
  const injected = new Map<string, InjectedRule>(rules.map((r) => [r.id, injectedRule(r)]));
  return { rules, injected, key, block: renderRulesBlock(rules, `room_type="${key}"`) };
}

async function ignoredFindingsText(ctx: Ctx, p: Asset): Promise<string> {
  const rows = await prisma.photoQcFinding.findMany({
    where: { jobId: ctx.job.id, photoId: p.id, status: { in: ["IGNORED", "FALSE_POSITIVE", "OVERRIDDEN"] } },
    select: { ruleId: true, specificIssue: true, locationText: true, status: true, statusReason: true },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  if (!rows.length) return "none";
  return rows
    .map((r) => `- ${r.ruleId}: ${sanitizeUntrusted(r.specificIssue, 120)} (${sanitizeUntrusted(r.locationText, 80) || "no location"}); staff decision ${r.status}: ${sanitizeUntrusted(r.statusReason, 200) || "no reason given"}`)
    .join("\n");
}

type GalleryStats = { blurMedian: number | null; clusterMedianB: Map<string, number> };
function galleryStats(ctx: Ctx): GalleryStats {
  const active = activeOf(ctx).filter(hasImage);
  const blurMedian = median(active.map((p) => metricsOf(p)!.blurScore));
  const byRoom = new Map<string, number[]>();
  for (const p of active) {
    const m = metricsOf(p)!;
    const b = (m.neutralLab ?? m.labMean)[2];
    const room = p.roomType ?? "OTHER";
    byRoom.set(room, [...(byRoom.get(room) ?? []), b]);
  }
  return { blurMedian, clusterMedianB: new Map([...byRoom].map(([k, v]) => [k, median(v) ?? 0])) };
}

function p1Vars(ctx: Ctx, p: Asset, img: QcImage, pos: number, total: number, g: GalleryStats, ignored: string): Record<string, TemplateValue> {
  const m = metricsOf(p);
  const flags = m ? cvFlags(m, g.blurMedian, p.roomType) : [];
  return {
    ...propertyVars(ctx),
    photoId: labelFor(pos),
    filename: sanitizeUntrusted(p.name, 200),
    sentWidth: img.w,
    sentHeight: img.h,
    roomType: p.roomType ?? "OTHER",
    roomConfidence: fmtNum(p.roomConfidence, 2),
    alternateRoomType: p.alternateRoomType ?? "none",
    p0Description: sanitizeUntrusted(p.description, 400),
    isAerial: yesNo(p.isAerial),
    isTwilight: yesNo(p.isTwilight),
    isVirtuallyStaged: yesNo(p.isVirtuallyStaged),
    isPrimaryCandidate: yesNo(p.isPrimaryCandidate),
    galleryPosition: pos,
    galleryCount: total,
    blurScore: fmtNum(m?.blurScore, 1),
    blurMedian: fmtNum(g.blurMedian, 1),
    blurSoftThreshold: CV_THRESHOLDS.blurSoft,
    highlightClipPct: fmtNum(m?.clipHighPct, 2),
    shadowClipPct: fmtNum(m?.clipLowPct, 2),
    labL: fmtNum(m?.labMean[0], 1),
    labA: fmtNum(m?.labMean[1], 1),
    labB: fmtNum(m?.labMean[2], 1),
    clusterMedianB: fmtNum(g.clusterMedianB.get(p.roomType ?? "OTHER") ?? null, 1),
    cvFlags: flags.length ? flags.join("; ") : "none",
    clientQcProfileNotes: ctx.clientNotes || null,
    fireplaceRequested: ctx.ingest.fireplace,
    tvReplacementMode: ctx.ingest.tv,
    grassRequested: ctx.ingest.grass,
    declutterAtIngest: ctx.ingest.declutter,
    specialInstructions: ctx.expected?.specialInstructions ? sanitizeUntrusted(ctx.expected.specialInstructions) : null,
    ignoredFindings: ignored,
  };
}

/** One Claude unit with the shared failure policy: a config problem aborts the
 *  tick; a transient one is retried next tick (up to MAX_TRANSIENT); anything
 *  else is returned for the caller to file as "inspection unavailable". */
async function guarded<T>(ctx: Ctx, key: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; permanent: boolean; message: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof QcCallError && e.kind === "config") {
      ctx.abort = e;
      throw e;
    }
    const transient = (e instanceof QcCallError && e.kind === "transient") || (e instanceof PhotoSourceError && e.kind === "transient");
    const message = (e as Error).message.slice(0, 300);
    if (transient && !transientExhausted(ctx, key)) {
      console.warn("photo-qc: transient failure, retried next tick", key, message);
      return { ok: false, permanent: false, message };
    }
    if (!(e instanceof QcCallError) && !(e instanceof PhotoSourceError)) throw e;
    return { ok: false, permanent: true, message: e instanceof PhotoSourceError ? e.publicReason : message };
  }
}

// ---- B1: P0 ------------------------------------------------------------------------------------

async function classifyPhoto(ctx: Ctx, p: Asset, pos: number): Promise<void> {
  const hash = hashOf(p);
  const e = ctx.expected;
  const r = await guarded(ctx, `P0:${p.id}:${hash}`, () =>
    runPass({
      def: P0_CLASSIFY_V1,
      label: `P0 ${labelFor(pos)}`,
      schema: () => p0JsonSchema(),
      validate: (raw) => validateP0(raw),
      onCall: onCall(ctx, "P0"),
      prepare: async () => {
        const img = await imageFor(ctx, p, "qc1024");
        const text = render(P0_TEXT, {
          ...propertyVars(ctx),
          photoId: labelFor(pos),
          filename: sanitizeUntrusted(p.name, 200),
          sentWidth: img.w,
          sentHeight: img.h,
          twilightOrdered: orderedFlag(ctx, (e?.twilightReal ?? 0) + (e?.twilightVirtual ?? 0)),
          stagingOrdered: orderedFlag(ctx, e?.virtualStagingCount),
          droneOrdered: orderedFlag(ctx, e?.droneCount),
        });
        return { images: [img], text, ctx: null };
      },
    }),
  );
  if (!r.ok && !r.permanent) return;
  const outcome = r.ok ? r.value : null;
  if (outcome?.ok) {
    const v = outcome.value;
    ledgerDone(ctx, p.id, ["P0"]);
    await prisma.$transaction([
      prisma.photoAsset.updateMany({
        where: { id: p.id, contentHash: p.contentHash },
        data: {
          roomType: v.roomType,
          roomConfidence: v.roomConfidence,
          alternateRoomType: v.alternateRoomType,
          sequenceGroup: v.sequenceGroup,
          description: v.description,
          featuresJson: JSON.stringify(v.features),
          heroScore: v.heroScore,
          isAerial: v.isAerial,
          isTwilight: v.isTwilight,
          isVirtuallyStaged: v.isVirtuallyStaged,
          isPrimaryCandidate: v.isExteriorPrimaryCandidate,
          classifiedHash: hash,
        },
      }),
      runStateWrite(ctx),
    ]);
  } else {
    // Unclassified photos still get inspected with the rules every room shares.
    const why = outcome ? `${outcome.reason}: ${outcome.message}` : (r as { message: string }).message;
    ledgerSkip(ctx, p.id, "P0", `classification unavailable (${why})`);
    await prisma.$transaction([
      prisma.photoAsset.updateMany({ where: { id: p.id, contentHash: p.contentHash }, data: { roomType: "OTHER", roomConfidence: 0, alternateRoomType: null, sequenceGroup: null, classifiedHash: hash } }),
      runStateWrite(ctx),
    ]);
  }
  ctx.done.classified++;
}

// ---- B2: P1 ------------------------------------------------------------------------------------

async function inspectPhoto(ctx: Ctx, p: Asset, pos: number, total: number, g: GalleryStats): Promise<void> {
  const hash = hashOf(p);
  const { rules, injected, block } = rulesFor(ctx, p);
  const ignored = await ignoredFindingsText(ctx, p);
  let sent = { w: 0, h: 0 };
  const r = await guarded(ctx, `P1:${p.id}:${hash}`, () =>
    runPass<P1Output, P1Ctx>({
      def: P1_PHOTO_V1,
      rulesBlock: block,
      label: `P1 ${labelFor(pos)}`,
      schema: () => p1JsonSchema(ruleIdEnum(rules)),
      validate: (raw, c) => validateP1(raw, c),
      onCall: onCall(ctx, "P1"),
      prepare: async (caps) => {
        const img = await imageFor(ctx, p, inspectionSize(caps.maxLongEdge));
        sent = { w: img.w, h: img.h };
        return { images: [img], text: render(P1_TEXT, p1Vars(ctx, p, img, pos, total, g, ignored)), ctx: { w: img.w, h: img.h, rules: injected } };
      },
    }),
  );
  if (!r.ok && !r.permanent) return;
  const outcome = r.ok ? r.value : null;
  const full = { w: p.width ?? metricsOf(p)?.fullW ?? sent.w, h: p.height ?? metricsOf(p)?.fullH ?? sent.h };
  let drafts: FindingDraft[];
  if (outcome?.ok) {
    drafts = p1Drafts(outcome.value, { photoId: p.id, contentHash: hash, sent, full, model: outcome.model, coerced: outcome.coerced, callIds: outcome.callIds });
    ledgerDone(ctx, p.id, outcome.value.checksPerformed.map((c) => `P1:${c}`));
    for (const s of outcome.value.checksSkipped) ledgerSkip(ctx, p.id, `P1:${s.check}`, s.reason);
  } else {
    const why = outcome ? `${outcome.reason}: ${outcome.message}` : (r as { message: string }).message;
    drafts = [unavailableDraft({ photoId: p.id, contentHash: hash, pass: "P1_PHOTO", source: "P1", promptId: "P1_PHOTO", model: outcome?.model ?? null, reason: why, what: "Photo inspection (P1)" })];
    ledgerSkip(ctx, p.id, "P1", outcome?.reason === "refusal" ? "model refusal" : `inspection unavailable (${why})`);
  }
  await prisma.$transaction([
    prisma.photoQcFinding.updateMany({ where: { jobId: ctx.job.id, photoId: p.id, contentHash: hash, status: "OPEN", source: "P1" }, data: { status: "SUPERSEDED", statusReason: "re-inspected" } }),
    prisma.photoQcFinding.createMany({ data: drafts.filter((d) => ruleOn(ctx, d.ruleId)).map((d) => draftToRow(d, ctx.run.id, ctx.job.id)) }),
    prisma.photoAsset.updateMany({ where: { id: p.id, contentHash: p.contentHash }, data: { inspectedHash: hash, lastQcAt: new Date(now()) } }),
    runStateWrite(ctx),
  ]);
  ctx.done.inspected++;
}

// ---- B3: the arbiter --------------------------------------------------------------------------

type PendingFinding = { id: string; photoId: string | null; ruleId: string; specificIssue: string; locationText: string | null; bboxJson: string | null; explanation: string; severity: string; confidence: number; privacySensitive: boolean; isPermanentFeature: boolean; fixStrategy: string; coercedJson: string | null; rawJson: string | null; contentHash: string | null };

async function arbitrate(ctx: Ctx, f: PendingFinding, pos: Map<string, number>, total: number, g: GalleryStats): Promise<void> {
  const p = ctx.photos.find((x) => x.id === f.photoId);
  if (!p) return;
  const { block } = rulesFor(ctx, p);
  const ignored = await ignoredFindingsText(ctx, p);
  const fullBox = parseJson<Box | null>(f.bboxJson, null);
  const full = { w: p.width ?? 0, h: p.height ?? 0 };
  const r = await guarded(ctx, `ARB:${f.id}`, () =>
    runPass<ArbiterOutput, { w: number; h: number }>({
      def: P1_ARBITER_V1,
      rulesBlock: block,
      label: `arbiter ${labelFor(pos.get(p.id) ?? 0)}`,
      schema: () => arbiterJsonSchema(),
      validate: (raw, c) => validateArbiter(raw, c),
      onCall: onCall(ctx, "ARBITER"),
      prepare: async (caps) => {
        const img = await imageFor(ctx, p, inspectionSize(caps.maxLongEdge));
        const findingJson = JSON.stringify({
          ruleId: f.ruleId,
          specificIssue: f.specificIssue,
          locationText: f.locationText,
          bbox: full.w && full.h ? toSentBox(fullBox, full, { w: img.w, h: img.h }) : null,
          explanation: f.explanation,
          severity: f.severity,
          confidence: f.confidence,
          privacySensitive: f.privacySensitive,
          isPermanentFeature: f.isPermanentFeature,
        });
        const vars = { ...p1Vars(ctx, p, img, pos.get(p.id) ?? 0, total, g, ignored), findingJson };
        return { images: [img], text: render(ARBITER_TEXT, vars), ctx: { w: img.w, h: img.h } };
      },
    }),
  );
  if (!r.ok && !r.permanent) return;
  const outcome = r.ok ? r.value : null;
  if (!outcome?.ok) {
    // No verdict: the finding stays PENDING (it holds, which is the safe side)
    // and is not sent again in this run.
    ctx.progress.arbiterTried.push(f.id);
    ledgerSkip(ctx, p.id, `ARBITER:${f.id}`, outcome ? outcome.reason : (r as { message: string }).message);
    await saveRun(ctx);
    return;
  }
  const a = outcome.value;
  const applied = applyArbiter({ severity: f.severity as Severity, privacySensitive: f.privacySensitive, fixStrategy: f.fixStrategy as never }, a);
  const coerced = [...parseJson<string[]>(f.coercedJson, []), ...outcome.coerced.map((c) => `arbiter.${c}`), ...(applied.note ? [applied.note] : [])];
  const raw = { ...parseJson<Record<string, unknown>>(f.rawJson, {}), arbiter: { ...a, model: outcome.model, callIds: outcome.callIds } };
  ledgerDone(ctx, p.id, [`ARBITER:${f.id}`]);
  await prisma.$transaction([
    prisma.photoQcFinding.updateMany({
      where: { id: f.id, arbitration: "PENDING" },
      data: { arbitration: applied.arbitration, severity: applied.severity, fixStrategy: applied.fixStrategy, reeditPrompt: applied.fixStrategy === "REEDIT_PROMPT" ? undefined : null, coercedJson: JSON.stringify(coerced), rawJson: JSON.stringify(raw).slice(0, 20_000) },
    }),
    runStateWrite(ctx),
  ]);
  ctx.done.arbitrated++;
}

// ---- C1: P1b -----------------------------------------------------------------------------------

type CropPlan = P1bCrop & { photo: Asset };

/** The gallery's dust crops, prioritised by recurrence count, then contrast
 *  (pack 3.1), at most 60, packed into calls of up to 20 that never split a
 *  photo (so each call's results complete whole photos). */
function planP1b(ctx: Ctx, groups: RecurrenceGroup[]): { batches: CropPlan[][]; capped: Asset[] } {
  const groupOf = new Map<string, RecurrenceGroup>();
  for (const g of groups) for (const m of g.members) groupOf.set(`${m.photoId}:${m.index}`, g);
  const needing = activeOf(ctx).filter((p) => {
    const cv = storedCv(p);
    return !!cv?.metrics?.dustCandidates.length && cv.p1b?.hash !== hashOf(p) && inspected(p);
  });
  const all: (CropPlan & { rank: number; score: number })[] = [];
  for (const p of needing) {
    const m = metricsOf(p)!;
    m.dustCandidates.forEach((c, i) => {
      const g = groupOf.get(`${p.id}:${i}`) ?? null;
      const o = { x0: Math.max(0, Math.min(m.fullW - Math.min(512, m.fullW), Math.round(c.x - Math.min(512, m.fullW) / 2))), y0: Math.max(0, Math.min(m.fullH - Math.min(512, m.fullH), Math.round(c.y - Math.min(512, m.fullH) / 2))) };
      all.push({
        cropId: "",
        photoId: p.id,
        candidateIndex: i,
        x0: o.x0,
        y0: o.y0,
        w: Math.min(512, m.fullW),
        h: Math.min(512, m.fullH),
        fullW: m.fullW,
        fullH: m.fullH,
        depth: c.depth,
        group: g?.id ?? null,
        groupCount: g?.photoCount ?? 1,
        contentHash: hashOf(p),
        candidateBox: c.bbox,
        photo: p,
        rank: g?.photoCount ?? 1,
        score: c.score,
      });
    });
  }
  all.sort((a, b) => b.rank - a.rank || b.score - a.score || (a.photoId < b.photoId ? -1 : 1) || a.candidateIndex - b.candidateIndex);
  const chosen = all.slice(0, MAX_CROPS_PER_GALLERY);
  const capped = needing.filter((p) => !chosen.some((c) => c.photoId === p.id));
  // Group by photo in priority order, then pack whole photos into calls.
  const byPhoto = new Map<string, CropPlan[]>();
  for (const c of chosen) byPhoto.set(c.photoId, [...(byPhoto.get(c.photoId) ?? []), c]);
  const batches: CropPlan[][] = [];
  let cur: CropPlan[] = [];
  for (const crops of byPhoto.values()) {
    if (cur.length + crops.length > MAX_CROPS_PER_CALL && cur.length) {
      batches.push(cur);
      cur = [];
    }
    cur.push(...crops);
  }
  if (cur.length) batches.push(cur);
  let n = 0;
  for (const b of batches) for (const c of b) c.cropId = `c${String(++n).padStart(2, "0")}`;
  return { batches, capped };
}

async function runP1bBatch(ctx: Ctx, batch: CropPlan[], positions: Map<string, number>): Promise<void> {
  const photos = [...new Set(batch.map((c) => c.photo))];
  const key = `P1B:${photos.map((p) => `${p.id}:${hashOf(p)}`).join(",")}`;
  const r = await guarded(ctx, key, () =>
    runPass({
      def: P1B_DUST_V1,
      label: `P1b ${batch.length} crops`,
      schema: () => p1bJsonSchema(),
      validate: (raw, c) => validateP1b(raw, c),
      onCall: onCall(ctx, "P1B"),
      prepare: async () => {
        const images: QcImage[] = [];
        for (const c of batch) {
          const wanted = batch.filter((x) => x.photoId === c.photoId).map((x) => x.candidateIndex);
          const data = await cropFor(ctx, c.photo, c.candidateIndex, wanted);
          const m = metricsOf(c.photo)!;
          const cand = m.dustCandidates[c.candidateIndex];
          const label = render(P1B_LABEL, {
            n: images.length + 1,
            cropId: c.cropId,
            photoId: labelFor(positions.get(c.photoId) ?? 0),
            cropW: c.w,
            cropH: c.h,
            cropX0: c.x0,
            cropY0: c.y0,
            fullW: c.fullW,
            fullH: c.fullH,
            candX: cand.x - c.x0,
            candY: cand.y - c.y0,
            recurrenceGroupId: c.group ?? "none",
            recurrenceCount: c.groupCount,
            surfaceL: fmtNum(cand.surfaceL, 1),
            surfaceStd: fmtNum(cand.surfaceStd, 2),
            deltaL: fmtNum(cand.deltaL, 1),
          });
          images.push({ data, w: c.w, h: c.h, label });
        }
        const text = render(P1B_TEXT, { cropIdList: batch.map((c) => c.cropId).join(", ") });
        return { images, text, ctx: batch.map((c) => ({ cropId: c.cropId, w: c.w, h: c.h })) };
      },
    }),
  );
  if (!r.ok && !r.permanent) return;
  const outcome = r.ok ? r.value : null;
  let creates: FindingDraft[] = [];
  let updates: { id: string; bbox: Box | null; confidence: number; note: string }[] = [];
  const at = new Date(now()).toISOString();
  const states = new Map<string, P1bState>();
  for (const p of photos) states.set(p.id, { hash: hashOf(p), at, crops: batch.filter((c) => c.photoId === p.id).length, dust: 0, real: 0, texture: 0, uncertain: 0, skipped: null, results: [] });
  if (outcome?.ok) {
    const { drafts, logged } = p1bDrafts(outcome.value, batch, { model: outcome.model, coerced: outcome.coerced, callIds: outcome.callIds });
    for (const res of outcome.value.results) {
      const c = batch.find((x) => x.cropId === res.cropId);
      const s = c ? states.get(c.photoId) : null;
      if (!c || !s) continue;
      s.results.push({ index: c.candidateIndex, verdict: res.verdict, confidence: res.confidence, group: c.group });
      if (res.verdict === "isDust") s.dust++;
      else if (res.verdict === "isRealObject") s.real++;
      else if (res.verdict === "isTextureOrPattern") s.texture++;
      else s.uncertain++;
    }
    const p1Dust = await prisma.photoQcFinding.findMany({
      where: { jobId: ctx.job.id, photoId: { in: photos.map((p) => p.id) }, source: "P1", status: "OPEN", ruleId: { in: ["REFL_SENSOR_DUST", "REFL_LENS_DUST", "REFL_DARK_SPOTS_FLAT_SURFACES", "REFL_SMALL_DUST_OVERLOOKED"] } },
      select: { id: true, photoId: true, ruleId: true, bboxJson: true, confidence: true, contentHash: true },
    });
    const merged = mergeDust(
      p1Dust.filter((f) => photos.some((p) => p.id === f.photoId && hashOf(p) === f.contentHash)).map((f) => ({ id: f.id, photoId: f.photoId, ruleId: f.ruleId, bbox: parseJson<Box | null>(f.bboxJson, null), confidence: f.confidence })),
      drafts,
    );
    creates = merged.create;
    updates = merged.update;
    for (const l of logged) ledgerSkip(ctx, l.photoId, `P1B:${l.cropId}`, `${l.verdict}: ${l.note}`.slice(0, 200));
    for (const p of photos) ledgerDone(ctx, p.id, ["P1B"]);
  } else {
    const why = outcome ? `${outcome.reason}: ${outcome.message}` : (r as { message: string }).message;
    for (const s of states.values()) s.skipped = `dust confirmation unavailable (${why})`.slice(0, 200);
    creates = [{ ...unavailableDraft({ photoId: photos.length === 1 ? photos[0].id : null, photoIds: photos.map((p) => p.id), contentHash: photos.length === 1 ? hashOf(photos[0]) : null, pass: "P1_PHOTO", source: "P1B", promptId: "P1B_DUST", model: outcome?.model ?? null, reason: why, what: "Dust confirmation (P1b)" }), severity: "MINOR" }];
    for (const p of photos) ledgerSkip(ctx, p.id, "P1B", why);
  }
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.photoQcFinding.updateMany({ where: { jobId: ctx.job.id, photoId: { in: photos.map((p) => p.id) }, source: "P1B", status: "OPEN", contentHash: { in: photos.map(hashOf) } }, data: { status: "SUPERSEDED", statusReason: "re-checked" } }),
    prisma.photoQcFinding.createMany({ data: creates.filter((d) => ruleOn(ctx, d.ruleId)).map((d) => draftToRow(d, ctx.run.id, ctx.job.id)) }),
    ...updates.map((u) =>
      prisma.photoQcFinding.update({ where: { id: u.id }, data: { bboxJson: u.bbox ? JSON.stringify(u.bbox) : null, confidence: u.confidence, coercedJson: JSON.stringify([u.note]) } }),
    ),
    ...photos.map((p) => {
      const cv = storedCv(p)!;
      return prisma.photoAsset.updateMany({ where: { id: p.id, contentHash: p.contentHash }, data: { cvJson: JSON.stringify({ ...cv, p1b: states.get(p.id) }) } });
    }),
    runStateWrite(ctx),
  ];
  await prisma.$transaction(ops);
  ctx.done.p1bCalls++;
}

async function markP1bSkipped(ctx: Ctx, photos: Asset[], why: string): Promise<void> {
  if (!photos.length) return;
  const at = new Date(now()).toISOString();
  await prisma.$transaction([
    ...photos.map((p) => {
      const cv = storedCv(p)!;
      const state: P1bState = { hash: hashOf(p), at, crops: 0, dust: 0, real: 0, texture: 0, uncertain: 0, skipped: why, results: [] };
      ledgerSkip(ctx, p.id, "P1B", why);
      return prisma.photoAsset.updateMany({ where: { id: p.id, contentHash: p.contentHash }, data: { cvJson: JSON.stringify({ ...cv, p1b: state }) } });
    }),
    runStateWrite(ctx),
  ]);
}

// ---- C2: P2 ------------------------------------------------------------------------------------

type P2Unit = { key: string; mode: "CLUSTER" | "OVERVIEW"; label: string; photos: Asset[]; size: DerivSize };

const unitHash = (ps: Asset[]) => createHash("sha1").update(ps.map((p) => `${p.id}:${hashOf(p)}`).join(",")).digest("hex").slice(0, 10);

function planP2(ctx: Ctx, order: Asset[]): P2Unit[] {
  const withImages = order.filter(hasImage);
  if (withImages.length < 2) return [];
  const units: P2Unit[] = [];
  const byRoom = new Map<string, Asset[]>();
  for (const p of withImages) if (p.roomType && CLUSTER_ROOMS.has(p.roomType)) byRoom.set(p.roomType, [...(byRoom.get(p.roomType) ?? []), p]);
  const clusters = [...byRoom.entries()].filter(([, ps]) => ps.length >= 2).sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).slice(0, P2_MAX_CLUSTERS);
  for (const [room, ps] of clusters) {
    const photos = ps.slice(0, P2_OVERVIEW_BATCH);
    units.push({ key: `cluster:${room}:${unitHash(photos)}`, mode: "CLUSTER", label: room, photos, size: photos.length > P2_CLUSTER_FULL_SIZE_MAX ? "thumb768" : "qc1024" });
  }
  // Overview: every photo at thumb768; galleries above 40 go in batches of 40
  // that share 4 anchors (front exterior, kitchen, main living, primary bedroom).
  const anchorRooms = ["EXTERIOR_FRONT", "KITCHEN", "LIVING", "PRIMARY_BEDROOM"];
  const anchors = anchorRooms.map((r) => withImages.find((p) => p.roomType === r)).filter((p): p is Asset => !!p);
  if (withImages.length <= P2_OVERVIEW_BATCH) {
    units.push({ key: `overview:0:${unitHash(withImages)}`, mode: "OVERVIEW", label: "whole gallery", photos: withImages, size: "thumb768" });
  } else {
    const rest = withImages.filter((p) => !anchors.includes(p));
    const per = P2_OVERVIEW_BATCH - anchors.length;
    for (let i = 0, b = 0; i < rest.length && b < P2_MAX_OVERVIEW_BATCHES; i += per, b++) {
      const photos = [...anchors, ...rest.slice(i, i + per)];
      units.push({ key: `overview:${b}:${unitHash(photos)}`, mode: "OVERVIEW", label: `gallery part ${b + 1}`, photos, size: "thumb768" });
    }
  }
  return units;
}

function labMedian(ps: CvMetrics[]): [number, number, number] {
  const lab = (m: CvMetrics) => m.neutralLab ?? m.labMean;
  return [median(ps.map((m) => lab(m)[0])) ?? 0, median(ps.map((m) => lab(m)[1])) ?? 0, median(ps.map((m) => lab(m)[2])) ?? 0];
}

async function runP2Unit(ctx: Ctx, unit: P2Unit, positions: Map<string, number>, p2Rules: ReturnType<typeof rulesForPass>): Promise<void> {
  const labels = new Map(unit.photos.map((p) => [p.id, labelFor(positions.get(p.id) ?? 0)]));
  const idOf = new Map([...labels].map(([id, l]) => [l, id]));
  const injected = new Map<string, InjectedRule>(p2Rules.map((r) => [r.id, injectedRule(r)]));
  const block = renderRulesBlock(p2Rules, `scope="gallery"`);
  const metrics = unit.photos.map((p) => metricsOf(p)!);
  const med = labMedian(metrics);
  const gallery = unit.photos.map((p) => ({ id: p.id, dHash: metricsOf(p)!.dHash, contentHash: p.contentHash, w: p.width ?? 0, h: p.height ?? 0 }));
  const pairs = duplicatePairs(gallery);
  const exactPairs = new Set(pairs.filter((x) => x.exact).map((x) => [x.a, x.b].sort().join("|")));
  const dupPairs = new Set(pairs.map((x) => [labels.get(x.a)!, labels.get(x.b)!].sort().join("|")));
  const versions = await prisma.photoVersion.findMany({ where: { photoId: { in: unit.photos.map((p) => p.id) } }, select: { photoId: true, label: true }, orderBy: { createdAt: "asc" } });
  const r = await guarded(ctx, `P2:${unit.key}`, () =>
    runPass({
      def: P2_GALLERY_V1,
      rulesBlock: block,
      maxTokens: unit.mode === "OVERVIEW" ? P2_OVERVIEW_MAX_TOKENS : undefined,
      label: `P2 ${unit.mode.toLowerCase()} ${unit.label}`,
      schema: () => p2JsonSchema(ruleIdEnum(p2Rules)),
      validate: (raw, c) => validateP2(raw, c),
      onCall: onCall(ctx, "P2"),
      prepare: async () => {
        const images: QcImage[] = [];
        for (const p of unit.photos) {
          const img = await imageFor(ctx, p, unit.size);
          img.label = render(P2_LABEL, { n: images.length + 1, photoId: labels.get(p.id)!, galleryPosition: positions.get(p.id) ?? null, roomType: p.roomType ?? "OTHER", sentW: img.w, sentH: img.h });
          images.push(img);
        }
        const rows = unit.photos.map((p) => {
          const m = metricsOf(p)!;
          const lab = m.neutralLab ?? m.labMean;
          const dE = Math.hypot(lab[0] - med[0], lab[1] - med[1], lab[2] - med[2]);
          return `${labels.get(p.id)} | ${m.fullW}x${m.fullH} | ${lab[0].toFixed(1)} | ${lab[1].toFixed(1)} | ${lab[2].toFixed(1)} | ${dE.toFixed(1)} | ${m.blurScore.toFixed(0)} | ${m.clipHighPct.toFixed(2)}`;
        });
        const dupRows = pairs.map((x) => `${labels.get(x.a)} and ${labels.get(x.b)}: dHash distance ${x.distance}${x.exact ? " (exact duplicate)" : ""}`);
        const edits = unit.photos.map((p) => {
          const v = versions.filter((x) => x.photoId === p.id).map((x) => sanitizeUntrusted(x.label, 40));
          return `${labels.get(p.id)}: ${v.length ? v.join(" > ") : "unavailable"}`;
        });
        const text = render(P2_TEXT, {
          mode: unit.mode,
          clusterLabel: unit.label,
          photoCount: unit.photos.length,
          ...propertyVars(ctx),
          cvStatsRows: rows.join("\n"),
          duplicateCandidates: dupRows.length ? dupRows.join("\n") : "none",
          editContextRows: edits.join("\n"),
          clientQcProfileNotes: ctx.clientNotes || null,
        });
        return { images, text, ctx: { photoIds: new Set(labels.values()), dupPairs, rules: injected } };
      },
    }),
  );
  if (!r.ok && !r.permanent) return;
  const outcome = r.ok ? r.value : null;
  let drafts: FindingDraft[];
  if (outcome?.ok) {
    drafts = p2Drafts(outcome.value, { idOf, unit: unit.key, model: outcome.model, coerced: outcome.coerced, callIds: outcome.callIds, exactPairs, dHashOf: new Map() });
    ledgerDone(ctx, null, outcome.value.checksPerformed.map((c) => `P2:${unit.mode}:${c}`));
    for (const s of outcome.value.checksSkipped) ledgerSkip(ctx, null, `P2:${unit.mode}:${s.check}`, s.reason);
  } else {
    const why = outcome ? `${outcome.reason}: ${outcome.message}` : (r as { message: string }).message;
    drafts = [unavailableDraft({ photoId: null, photoIds: unit.photos.map((p) => p.id), contentHash: null, pass: "P2_GALLERY", source: "P2", promptId: "P2_GALLERY", model: outcome?.model ?? null, reason: why, what: `Gallery consistency (${unit.label})` })];
    ledgerSkip(ctx, null, `P2:${unit.key}`, why);
  }
  ctx.progress.p2Units.push(unit.key);
  await prisma.$transaction([
    prisma.photoQcFinding.createMany({ data: drafts.filter((d) => ruleOn(ctx, d.ruleId)).map((d) => draftToRow(d, ctx.run.id, ctx.job.id)) }),
    runStateWrite(ctx),
  ]);
  ctx.done.p2Units++;
}

// ---- C3: P4 ------------------------------------------------------------------------------------

async function runP4(ctx: Ctx, order: Asset[], labels: Map<string, string>, idOfLabel: Map<string, string>): Promise<void> {
  const e = ctx.expected;
  const active = order;
  const n = active.length;
  const aerial = active.filter((p) => p.isAerial).length;
  const twilight = active.filter((p) => p.isTwilight).length;
  const staged = active.filter((p) => p.isVirtuallyStaged).length;
  const counts = new Map<string, CoverageStatusT>();
  const countItems: P4Ctx["countItems"] = new Map();
  const lines: string[] = [];
  const addCount = (key: string, line: string, status: CoverageStatusT, label: string, sev: Severity, resp: "ADMIN" | "EDITOR" | "PHOTOGRAPHER") => {
    counts.set(key, status);
    countItems.set(key, { label, evidence: `Computed counts: ${line}.`, severityIfNotMet: sev, responsibility: resp });
    lines.push(`${key} ${line} -> ${status}`);
  };
  if (e?.minPhotos) addCount("count:photos", `delivered ${n}, required min ${e.minPhotos}`, n >= e.minPhotos ? "MET" : "NOT_MET", `Photo count (minimum ${e.minPhotos})`, "CRITICAL", "PHOTOGRAPHER");
  if (e) {
    const drone = e.droneCount ?? 0;
    addCount("count:aerial", `delivered ${aerial}, required ${drone}`, aerial >= drone ? "MET" : "NOT_MET", `Drone photos (${drone} ordered)`, "CRITICAL", "PHOTOGRAPHER");
    const tw = (e.twilightReal ?? 0) + (e.twilightVirtual ?? 0);
    addCount("count:twilight", `delivered ${twilight}, required ${tw}`, twilight >= tw ? "MET" : "NOT_MET", `Twilight photos (${tw} ordered)`, "CRITICAL", "EDITOR");
    const st = e.virtualStagingCount ?? 0;
    // The classifier cannot reliably recognise virtual staging (pack 1.2), so a
    // shortfall is UNKNOWN, never NOT_MET.
    addCount("count:staging", `delivered ${staged} recognised as staged, required ${st}`, staged >= st ? "MET" : "UNKNOWN", `Virtual staging (${st} ordered)`, "CRITICAL", "EDITOR");
  }
  const deliverables = await prisma.deliverable.findMany({ where: { projectId: ctx.job.projectId, removedFromOrderAt: null, waivedAt: null }, select: { type: true, productTitle: true, label: true, quantity: true } });
  const orderRows = deliverables.map((d) => `${sanitizeUntrusted(d.productTitle ?? d.type, 120)} | variant: ${sanitizeUntrusted(d.label, 80) || "unavailable"} | qty ${d.quantity} | is_twilight ${d.type === "TWILIGHT"}`);
  const expectations = e
    ? `minPhotos ${e.minPhotos ?? "unavailable"} | droneCount ${e.droneCount ?? 0} | twilightCount ${(e.twilightReal ?? 0) + (e.twilightVirtual ?? 0)} | floorPlanRequired ${!!e.floorPlan} | stagingCount ${e.virtualStagingCount ?? 0} | coveragePolicy: unavailable`
    : null;
  const photoRows = active.map((p) => {
    const feats = parseJson<string[]>(p.featuresJson, []).map((f) => sanitizeUntrusted(f, 48));
    return `${labels.get(p.id)} | ${p.roomType ?? "unclassified"} | alt ${p.alternateRoomType ?? "none"} | features: ${feats.length ? feats.join(", ") : "none"} | ${sanitizeUntrusted(p.description, 300) || "no description"}`;
  });
  const r = await guarded(ctx, "P4", () =>
    runPass({
      def: P4_ORDER_V1,
      label: "P4 coverage",
      schema: () => p4JsonSchema(),
      validate: (raw, c) => validateP4(raw, c),
      onCall: onCall(ctx, "P4"),
      prepare: async () => ({
        images: [],
        text: render(P4_TEXT, {
          ...propertyVars(ctx),
          orderItemsRows: orderRows.length ? orderRows.join("\n") : null,
          productExpectations: expectations,
          computedCounts: [...lines, `floorPlanStatus: unavailable`].join("\n"),
          clientRequestedFeatures: e?.requestedFeatures?.length ? sanitizeUntrusted(e.requestedFeatures.join("; ")) : null,
          specialInstructions: e?.specialInstructions ? sanitizeUntrusted(e.specialInstructions) : null,
          revisionScope: "none",
          photoLabelRows: photoRows.length ? photoRows.join("\n") : null,
        }),
        ctx: { photoIds: new Set(labels.values()), counts, countItems },
      }),
    }),
  );
  if (!r.ok && !r.permanent) return;
  const outcome = r.ok ? r.value : null;
  let drafts: FindingDraft[];
  if (outcome?.ok) {
    drafts = p4Drafts(outcome.value, { idOf: idOfLabel, model: outcome.model, coerced: outcome.coerced, callIds: outcome.callIds });
    ctx.progress.coverage = outcome.value;
    ledgerDone(ctx, null, ["P4"]);
  } else {
    const why = outcome ? `${outcome.reason}: ${outcome.message}` : (r as { message: string }).message;
    drafts = [unavailableDraft({ photoId: null, contentHash: null, pass: "P4_ORDER", source: "P4", promptId: "P4_ORDER", model: outcome?.model ?? null, reason: why, what: "Order coverage check (P4)" })];
    ledgerSkip(ctx, null, "P4", why);
  }
  ctx.progress.p4Done = true;
  await prisma.$transaction([
    prisma.photoQcFinding.createMany({ data: drafts.filter((d) => ruleOn(ctx, d.ruleId)).map((d) => draftToRow(d, ctx.run.id, ctx.job.id)) }),
    runStateWrite(ctx),
  ]);
  ctx.done.p4 = true;
}

// ---- F: finalize ---------------------------------------------------------------------------------

const GALLERY_CV_RULES = ["GAL_NO_DUPLICATES", "GAL_RESOLUTION_CONSISTENCY"];

function galleryCvDrafts(active: Asset[], labels: Map<string, string>): FindingDraft[] {
  const withImages = active.filter(hasImage);
  const gallery = withImages.map((p) => ({ id: p.id, dHash: metricsOf(p)!.dHash, contentHash: p.contentHash, w: p.width ?? metricsOf(p)!.fullW, h: p.height ?? metricsOf(p)!.fullH }));
  const out: FindingDraft[] = [];
  const base = { pass: "P2_GALLERY" as const, source: "CV" as const, locationText: null, bbox: null, isPermanentFeature: false, privacySensitive: false, reeditPrompt: null, arbitration: "NOT_REQUIRED" as const, contentHash: null, promptId: null, promptVersion: null, model: null, coerced: [] as string[], postFixable: true, reshootMayBeNeeded: false };
  for (const d of duplicatePairs(gallery).filter((x) => x.exact)) {
    const [a, b] = [d.a, d.b];
    out.push({
      ...base,
      photoId: b,
      photoIds: [a, b],
      ruleId: "GAL_NO_DUPLICATES",
      groupKey: `duplicate-${[labels.get(a), labels.get(b)].join("-")}`.replace(/_/g, "").toLowerCase(),
      specificIssue: "Exact duplicate photo",
      explanation: `${labels.get(a)} and ${labels.get(b)} are the same frame (difference hash distance ${d.distance}${d.distance === 0 ? ", identical file" : ""}).`,
      severity: "MAJOR",
      confidence: 0.95,
      responsibility: "ADMIN",
      recommendedAction: `Exclude ${labels.get(b)} and keep ${labels.get(a)}.`,
      fixStrategy: "ADMIN_ACTION",
      raw: { cv: d },
    });
  }
  for (const o of resolutionOutliers(gallery)) {
    out.push({
      ...base,
      photoId: o.id,
      photoIds: [o.id],
      ruleId: "GAL_RESOLUTION_CONSISTENCY",
      groupKey: "resolution-mismatch",
      specificIssue: `Long edge ${o.long} px, gallery is ${o.mode} px`,
      explanation: `${labels.get(o.id)} is ${o.long} px on the long edge while most of the gallery is ${o.mode} px.`,
      severity: "MAJOR",
      confidence: 0.95,
      responsibility: "ADMIN",
      recommendedAction: "Re-export the photo at the gallery's size.",
      fixStrategy: "ADMIN_ACTION",
      raw: { cv: o },
    });
  }
  return out;
}

/** Spots P1b confirmed in 3+ photos of one recurrence group become one
 *  spot-specific ticket (groupKey sensor-dust-repeated-rgN), where the
 *  registry's REFL_SENSOR_DUST escalation ("the same spot recurs in 3 or more
 *  photos") makes it CRITICAL. Persisted on the rows (and logged in coerced)
 *  so a reader of the rows sees what the verdict saw. */
async function regroupRecurringDust(ctx: Ctx, groups: RecurrenceGroup[]): Promise<Prisma.PrismaPromise<unknown>[]> {
  const rows = await prisma.photoQcFinding.findMany({ where: { jobId: ctx.job.id, source: "P1B", ruleId: "REFL_SENSOR_DUST", status: { in: ["OPEN", "APPROVED_FIX", "FIXING"] } }, select: { id: true, photoId: true, rawJson: true, groupKey: true, severity: true, coercedJson: true } });
  const groupOfCandidate = new Map<string, RecurrenceGroup>();
  for (const g of groups) for (const m of g.members) groupOfCandidate.set(`${m.photoId}:${m.index}`, g);
  const confirmed = new Map<string, Set<string>>();
  const rowGroup = new Map<string, RecurrenceGroup | null>();
  for (const r of rows) {
    const idx = parseJson<{ crop?: { candidateIndex?: number } }>(r.rawJson, {}).crop?.candidateIndex;
    const g = typeof idx === "number" && r.photoId ? groupOfCandidate.get(`${r.photoId}:${idx}`) ?? null : null;
    rowGroup.set(r.id, g);
    if (g && r.photoId) confirmed.set(g.id, (confirmed.get(g.id) ?? new Set()).add(r.photoId));
  }
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const r of rows) {
    const g = rowGroup.get(r.id) ?? null;
    const count = g ? confirmed.get(g.id)?.size ?? 0 : 0;
    const recurring = !!g && count >= CV_THRESHOLDS.recurrenceMinPhotos;
    const groupKey = recurring ? `sensor-dust-repeated-${g!.id}` : "sensor-dust";
    const severity: Severity = recurring ? "CRITICAL" : "MAJOR";
    if (groupKey === r.groupKey && severity === r.severity) continue;
    const coerced = parseJson<string[]>(r.coercedJson, []).filter((c) => !c.startsWith("escalated:"));
    if (recurring) coerced.push(`escalated: the same spot recurs in ${count} photos (REFL_SENSOR_DUST escalateTo)`);
    ops.push(prisma.photoQcFinding.update({ where: { id: r.id }, data: { groupKey, severity, specificIssue: recurring ? `Sensor dust spot repeated in ${count} photos` : "Sensor dust spot", coercedJson: coerced.length ? JSON.stringify(coerced) : null } }));
  }
  return ops;
}

function statusLine(v: JobVerdict): string {
  return v === "PASS" ? "QC PASSED" : v === "PASS_WITH_MINOR" ? "QC PASSED WITH NOTES" : v === "HOLD" ? "QC HOLD" : "QC NEEDS DECISION";
}

async function deliverySummary(ctx: Ctx, verdict: VerdictResult, allFindings: { status: string }[], positions: Map<string, number>, photoCount: number): Promise<{ lines: string[]; text: string; source: "model" | "template" }> {
  const link = `${appBase()}/ops/photo-delivery/${ctx.job.id}`;
  const status = statusLine(verdict.verdict);
  const all = [...verdict.groups];
  const found = { critical: all.filter((g) => g.severity === "CRITICAL").length, major: all.filter((g) => g.severity === "MAJOR").length, minor: all.filter((g) => g.severity === "MINOR").length };
  const fixed = allFindings.filter((f) => f.status === "FIXED").length;
  const ignored = allFindings.filter((f) => ["IGNORED", "FALSE_POSITIVE", "OVERRIDDEN"].includes(f.status)).length;
  const open = verdict.groups.filter((g) => g.unresolvedIds.length);
  const openRows = open.slice(0, 12).map((g) => {
    const pos = g.photoIds.map((id) => positions.get(id)).filter((n): n is number => !!n).sort((a, b) => a - b);
    return `${g.severity} | ${stripLongDashes(g.title)} | ${pos.length ? `photos ${pos.join(", ")}` : "order"}`;
  });
  const template = (): string[] => {
    const lines = [
      `${status}: ${ctx.street}. ${photoCount} photos checked.`,
      `Found ${found.critical} critical, ${found.major} major, ${found.minor} minor. Fixed ${fixed}, ignored ${ignored}, open ${open.length}.`,
      `AutoHDR credits spent: ${ctx.job.creditsSpent}.`,
    ];
    const crit = open.filter((g) => g.severity === "CRITICAL").map((g) => g.title);
    const maj = open.filter((g) => g.severity === "MAJOR").map((g) => g.title);
    if (crit.length) lines.push(`Open critical: ${crit.join("; ")}`.slice(0, 160));
    if (maj.length) lines.push(`Open major: ${maj.join("; ")}`.slice(0, 160));
    lines.push(`Report: ${QC_LINK_TOKEN}`);
    return lines.map(stripLongDashes);
  };
  let lines: string[] | null = null;
  let source: "model" | "template" = "template";
  if (canStart(ctx, DELIVERY_SUMMARY_V1.startMinMs)) {
    try {
      const outcome = await runPass({
        def: DELIVERY_SUMMARY_V1,
        label: "summary",
        schema: () => summaryJsonSchema(),
        validate: (raw, c) => validateSummary(raw, c),
        onCall: onCall(ctx, "SUMMARY"),
        prepare: async () => ({
          images: [],
          text: render(SUMMARY_TEXT, {
            status,
            address: ctx.street,
            photoCount,
            foundCritical: found.critical,
            foundMajor: found.major,
            foundMinor: found.minor,
            fixedCount: fixed,
            ignoredCount: ignored,
            openCount: open.length,
            creditsSpent: ctx.job.creditsSpent,
            pendingApprovalFixes: 0,
            pendingApprovalCredits: 0,
            openItemRows: openRows.length ? openRows.join("\n") : "none",
          }),
          ctx: { status, photoCount },
        }),
      });
      if (outcome.ok) {
        lines = outcome.value.lines;
        source = "model";
      }
    } catch (e) {
      if (e instanceof QcCallError && e.kind === "config") throw e;
      console.warn("photo-qc: summary fell back to the template", (e as Error).message);
    }
  }
  const final = (lines ?? template()).map((l) => l.replace(QC_LINK_TOKEN, link));
  return { lines: final, text: final.join("\n"), source };
}

/** Bell rows only (no Slack, no text): the shadow-mode notice for Kyle and
 *  READY_TO_DELIVER for both. Same row shape and dedupe slots as
 *  alertOwnerAndKyle (owner slot 0, Kyle slot 1), so the two never collide. */
export async function bellOnly(a: { kind: string; title: string; body?: string; href: string; dedupeKey: string; to: "kyle" | "both" }): Promise<number> {
  const { ownerId, kyleId } = await opsRecipients();
  const people: { id: string; role: "OWNER" | "ADMIN"; slot: number }[] = [];
  if (ownerId && a.to === "both") people.push({ id: ownerId, role: "OWNER", slot: 0 });
  if (kyleId && kyleId !== ownerId) people.push({ id: kyleId, role: "ADMIN", slot: 1 });
  let n = 0;
  const { logDelivery } = await import("@/lib/notify");
  for (const p of people) {
    const row = await prisma.notification
      .create({ data: { kind: a.kind, title: stripLongDashes(a.title).slice(0, 90), body: a.body ? stripLongDashes(a.body).slice(0, 140) : null, href: a.href, audience: JSON.stringify([p.role]), userKey: `tm:${p.id}`, dedupeKey: `${a.dedupeKey}-${p.slot}` }, select: { id: true } })
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code === "P2002") return null;
        throw e;
      });
    if (!row) continue;
    n++;
    await logDelivery({ notificationId: row.id, teamMemberId: p.id, kind: a.kind, channel: "bell", status: "sent" }).catch(() => {});
  }
  return n;
}

async function notifyFinished(ctx: Ctx, v: VerdictResult, shadow: boolean, photoCount: number): Promise<string> {
  const href = `/ops/photo-delivery/${ctx.job.id}`;
  const link = `${appBase()}${href}`;
  const open = v.groups.filter((g) => g.unresolvedIds.length);
  const n = open.length;
  const issues = `${n} issue${n === 1 ? "" : "s"}`;
  if (shadow) {
    const sent = await bellOnly({ kind: "photo_qc_shadow", title: `${ctx.street}: AI QC finished (shadow): ${issues} to check`, href, dedupeKey: `photo-qc-shadow-${ctx.run.id}`, to: "kyle" });
    return sent ? "shadow bell for Kyle" : "shadow bell not sent (already sent, or no delivery owner)";
  }
  if (v.verdict === "HOLD") {
    const top = v.holding[0];
    const what = top ? `${top.title.toLowerCase()}` : "a critical issue";
    const r = await alertOwnerAndKyle({ kind: "QC_HOLD", title: `On hold: ${ctx.street}`, body: `QC found ${what}.`, href, dedupeKey: `photo-qc-hold-${ctx.run.id}`, text: `${ctx.street} is on hold: ${what}. Review: ${link}` });
    return `QC_HOLD announced to ${r.announced}`;
  }
  if (v.verdict === "NEEDS_DECISION") {
    const majors = open.filter((g) => g.severity === "MAJOR").length;
    const r = await alertOwnerAndKyle({ kind: "QC_DECISION_NEEDED", title: `Needs a decision: ${ctx.street}`, body: `${issues} need a decision.`, href, dedupeKey: `photo-qc-decision-${ctx.run.id}`, text: `${ctx.street}: ${issues} need a decision (${majors} major). Review: ${link}` });
    return `QC_DECISION_NEEDED announced to ${r.announced}`;
  }
  const sent = await bellOnly({ kind: "READY_TO_DELIVER", title: `Ready to deliver: ${ctx.street}`, body: `${ctx.street} passed QC (${photoCount} photos).`, href, dedupeKey: `photo-qc-ready-${ctx.run.id}`, to: "both" });
  return `READY_TO_DELIVER bell to ${sent}`;
}

async function finalize(ctx: Ctx): Promise<void> {
  await refreshPhotos(ctx);
  const active = activeOf(ctx);
  const { order, position, label } = orderOf(ctx);
  const groups = clusterDust(active.filter(hasImage).map((p) => ({ id: p.id, fullW: metricsOf(p)!.fullW, fullH: metricsOf(p)!.fullH, candidates: metricsOf(p)!.dustCandidates })));
  const galleryDrafts = galleryCvDrafts(active, label);
  const dustOps = await regroupRecurringDust(ctx, groups);
  const activeIds = new Set(active.map((p) => p.id));
  const stale = ctx.photos.filter((p) => p.status === "ACTIVE" || p.status === "EXCLUDED");
  await prisma.$transaction([
    // A photo whose file changed since a finding was made: that finding is history.
    ...stale.map((p) =>
      prisma.photoQcFinding.updateMany({ where: { jobId: ctx.job.id, photoId: p.id, status: "OPEN", contentHash: { not: null }, NOT: { contentHash: hashOf(p) } }, data: { status: "SUPERSEDED", statusReason: "the photo changed" } }),
    ),
    prisma.photoQcFinding.updateMany({ where: { jobId: ctx.job.id, status: "OPEN", photoId: { in: ctx.photos.filter((p) => p.status === "GONE").map((p) => p.id) } }, data: { status: "SUPERSEDED", statusReason: "the photo was removed" } }),
    // Gallery-level findings are re-derived by every run.
    prisma.photoQcFinding.updateMany({ where: { jobId: ctx.job.id, status: "OPEN", qcRunId: { not: ctx.run.id }, source: { in: ["P2", "P4"] } }, data: { status: "SUPERSEDED", statusReason: `re-checked in run ${ctx.run.id}` } }),
    prisma.photoQcFinding.updateMany({ where: { jobId: ctx.job.id, status: "OPEN", source: "CV", ruleId: { in: GALLERY_CV_RULES } }, data: { status: "SUPERSEDED", statusReason: `re-checked in run ${ctx.run.id}` } }),
    prisma.photoQcFinding.createMany({ data: galleryDrafts.filter((d) => ruleOn(ctx, d.ruleId)).map((d) => draftToRow(d, ctx.run.id, ctx.job.id)) }),
    ...dustOps,
  ]);
  ledgerDone(ctx, null, ["GALLERY_CV"]);

  const findings = await prisma.photoQcFinding.findMany({
    where: { jobId: ctx.job.id, status: { not: "SUPERSEDED" } },
    select: { id: true, ruleId: true, groupKey: true, photoId: true, photoIdsJson: true, severity: true, confidence: true, status: true, arbitration: true, privacySensitive: true, specificIssue: true, source: true },
  });
  const excluded = ctx.photos.filter((p) => p.status !== "ACTIVE").map((p) => p.id);
  const opts = { floor: ctx.settings.displayConfidenceFloor, overrides: ctx.overrides, excludedPhotoIds: excluded };
  const verdict = jobVerdict(findings, opts);
  const perPhoto = photoVerdicts(findings, [...activeIds], opts);
  const shadow = ctx.settings.qcShadow;
  const target = qcStageFor(verdict, shadow);
  const filenames = finalFilenames(order);
  const heroId = order[0]?.id ?? null;
  const summaryLines = await deliverySummary(ctx, verdict, findings, position, active.length);
  const cost = await prisma.photoQcRun.findUnique({ where: { id: ctx.run.id }, select: { costUsd: true, tokensIn: true, tokensOut: true, cacheRead: true, cacheWrite: true } });
  ctx.progress.wallMs += now() - ctx.tickStart;
  ctx.tickStart = now();
  const summary: QcRunSummary = summaryOf(ctx, {
    verdict: verdict.verdict,
    shadow,
    stage: target,
    counts: verdict.counts,
    tickets: [...verdict.groups, ...verdict.lowConfidence].slice(0, 80).map((g) => ({ key: g.key, ruleId: g.ruleId, title: g.title, severity: g.severity, photoIds: g.photoIds, holds: g.holds, escalated: g.escalated, lowConfidence: g.lowConfidence })),
    order: filenames.map((f, i) => ({ photoId: f.photoId, position: i + 1, filename: f.filename })),
    heroPhotoId: heroId,
    coverage: ctx.progress.coverage?.coverage ?? [],
    missingDeliverables: ctx.progress.coverage?.missingDeliverables ?? [],
    dataGaps: ctx.progress.coverage?.dataGaps ?? [],
    deliverySummary: summaryLines,
    metrics: { costUsd: cost?.costUsd ?? 0, tokensIn: cost?.tokensIn ?? 0, tokensOut: cost?.tokensOut ?? 0, cacheRead: cost?.cacheRead ?? 0, cacheWrite: cost?.cacheWrite ?? 0, calls: ctx.progress.calls, wallMs: ctx.progress.wallMs, ticks: ctx.progress.ticks, byPass: ctx.progress.byPass },
    notes: ctx.notes,
  });
  const heroValid = !!ctx.job.heroPhotoId && activeIds.has(ctx.job.heroPhotoId);
  await prisma.$transaction([
    ...[...activeIds].map((id) => prisma.photoAsset.update({ where: { id }, data: { verdict: perPhoto[id] ?? "PASS", lastQcAt: new Date(now()) } })),
    prisma.photoQcRun.update({
      where: { id: ctx.run.id },
      data: { status: "DONE", verdict: verdict.verdict, finishedAt: new Date(now()), photoCount: active.length, summaryJson: JSON.stringify(summary), checksJson: JSON.stringify(ctx.checks), modelsJson: JSON.stringify({ ...ctx.models, _detail: ctx.modelDetail }), error: null },
    }),
  ]);
  const extra = { qcVerdict: verdict.verdict, qcShadow: shadow, lastQcRunId: ctx.run.id, lastError: null, ...(heroValid ? {} : { heroPhotoId: heroId }) };
  const moved = await setStage(ctx.job.id, ["QC_RUNNING"], target, "qc", {
    why: `AI QC ${shadow ? "(shadow) " : ""}verdict ${verdict.verdict}`,
    data: { runId: ctx.run.id, verdict: verdict.verdict, counts: verdict.counts, costUsd: cost?.costUsd ?? 0 },
    holdReason: target === "ON_HOLD" ? "CRITICAL" : undefined,
    holdNote: target === "ON_HOLD" ? verdict.holding.map((g) => g.title).join("; ").slice(0, 400) : undefined,
    extra,
  });
  if (!moved) {
    await prisma.photoJob.update({ where: { id: ctx.job.id }, data: extra });
    const now2 = await prisma.photoJob.findUnique({ where: { id: ctx.job.id }, select: { stage: true } });
    await logJobEvent(ctx.job.id, "qc", `AI QC finished (verdict ${verdict.verdict}); the job is now ${now2?.stage ?? "unknown"}, so its stage was left alone`, { runId: ctx.run.id });
  }
  const told = await notifyFinished(ctx, verdict, shadow, active.length).catch((e) => `notification failed: ${(e as Error).message}`);
  await logJobEvent(ctx.job.id, "qc", `AI QC run finished: ${verdict.verdict}${shadow ? " (shadow)" : ""}`, {
    runId: ctx.run.id,
    tickets: verdict.groups.filter((g) => g.unresolvedIds.length).length,
    lowConfidence: verdict.counts.lowConfidence,
    costUsd: cost?.costUsd ?? 0,
    calls: ctx.progress.calls,
    notified: told,
  });
}

// ---- one job's tick ------------------------------------------------------------------------------

async function triggerFor(job: PhotoJob, lastRunAt: Date | null): Promise<Trigger> {
  const ev = await prisma.photoJobEvent.findFirst({
    where: { jobId: job.id, action: { startsWith: "QC requested (" }, ...(lastRunAt ? { at: { gt: lastRunAt } } : {}) },
    orderBy: { at: "desc" },
    select: { dataJson: true },
  });
  const t = parseJson<{ trigger?: string }>(ev?.dataJson, {}).trigger;
  if (t === "INITIAL" || t === "MANUAL" || t === "POST_FIX" || t === "REVISION") return t;
  return lastRunAt ? (job.stage === "REVISION_REQUESTED" ? "REVISION" : "MANUAL") : "INITIAL";
}

/** The run this tick works on: the job's RUNNING run, or a new one (which
 *  moves the job into QC_RUNNING). null = the job cannot start QC now. */
async function runForJob(job: PhotoJob, settings: PhotoDeliverySettings): Promise<{ run: PhotoQcRun; created: boolean } | null> {
  const running = await prisma.photoQcRun.findFirst({ where: { jobId: job.id, status: "RUNNING" }, orderBy: { startedAt: "desc" } });
  // SHADOW AUDIT AFTER DELIVERY (Oct 14 2026, first live night: Ridley Creek's
  // 76 photos reached Aryeo and were delivered 15 minutes later, before QC
  // could look). In shadow mode a delivered gallery is still inspected, so
  // the calibration data exists and a real issue can become a revision; its
  // stage is never touched (finalize leaves a moved job's stage alone).
  const postDelivery = settings.qcShadow && (job.stage === "DELIVERED" || job.stage === "DELIVERING");
  if (running && (job.stage === "QC_RUNNING" || postDelivery)) return { run: running, created: false };
  if (running) {
    // The job left QC_RUNNING by hand mid-run: that run is closed as partial.
    await prisma.photoQcRun.update({ where: { id: running.id }, data: { status: "PARTIAL", finishedAt: new Date(now()), error: `job moved to ${job.stage} before the run finished` } });
  }
  const last = await prisma.photoQcRun.findFirst({ where: { jobId: job.id }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  const trigger = await triggerFor(job, last?.startedAt ?? null);
  const photoCount = await prisma.photoAsset.count({ where: { jobId: job.id, status: "ACTIVE" } });
  const run = await prisma.photoQcRun.create({
    data: {
      jobId: job.id,
      trigger,
      status: "RUNNING",
      // Same clock as qcRequestedAt, so "requested after the last run" compares like with like.
      startedAt: new Date(now()),
      shadow: settings.qcShadow,
      passesJson: JSON.stringify(PASS_SET),
      rulesVersion: RULES_REGISTRY_VERSION,
      promptVersionsJson: JSON.stringify(promptVersions()),
      modelsJson: JSON.stringify({}),
      photoCount,
      summaryJson: JSON.stringify({ v: 1, progress: emptyProgress() }),
      checksJson: JSON.stringify({ photos: {}, gallery: { performed: [], skipped: [] } }),
    },
  });
  if (postDelivery) {
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id } });
    await logJobEvent(job.id, "qc", `AI QC run opened after delivery (shadow audit, ${trigger}); the stage stays ${job.stage}`, { runId: run.id });
    return { run, created: true };
  }
  if (job.stage !== "QC_RUNNING") {
    const from: JobStage[] = trigger === "POST_FIX" ? QC_STAGES_FROM : QC_STAGES_FROM.filter((s) => s !== "FIXING");
    const moved = await setStage(job.id, from, "QC_RUNNING", "qc", { why: `AI QC started (${trigger}${settings.qcShadow ? ", shadow" : ""})`, data: { runId: run.id }, extra: { lastQcRunId: run.id } });
    if (!moved) {
      await prisma.photoQcRun.delete({ where: { id: run.id } }).catch(() => {});
      return null;
    }
  } else {
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id } });
    await logJobEvent(job.id, "qc", `AI QC run opened (${trigger})`, { runId: run.id });
  }
  return { run, created: true };
}

/** A check switched off (house-wide or for this client) is never written, whichever pass found it. */
function ruleOn(ctx: Ctx, ruleId: string): boolean {
  return !ctx.overrides.some((o) => o.ruleId === ruleId && o.disabled);
}

async function loadCtx(job: PhotoJob, run: PhotoQcRun, settings: PhotoDeliverySettings, deadline: number, leaseBy: string): Promise<Ctx> {
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true, addressLine: true, city: true, state: true, clientId: true } });
  const profile = project?.clientId ? await prisma.clientQcProfile.findUnique({ where: { clientId: project.clientId } }) : null;
  const expected = parseJson<Expected | null>(job.expectedJson, null);
  const street = sanitizeUntrusted(expected?.address || project?.addressLine || (project?.title ?? "").split(",")[0] || "This job", 120);
  const city = expected?.city ?? project?.city ?? null;
  const state = expected?.state ?? project?.state ?? null;
  const ingestRaw = parseJson<Record<string, unknown>>(profile?.autohdrJson, {});
  const str = (v: unknown) => (typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "string" && v.trim() ? sanitizeUntrusted(v, 40) : null);
  const summary = parseJson<QcRunSummary | null>(run.summaryJson, null);
  const checks = parseJson<ChecksLedger>(run.checksJson, { photos: {}, gallery: { performed: [], skipped: [] } });
  const models = parseJson<Record<string, unknown>>(run.modelsJson, {});
  const ctx: Ctx = {
    job,
    run,
    settings,
    deadline,
    tickStart: now(),
    leaseBy,
    street,
    fullAddress: [street, city, state].filter(Boolean).join(", "),
    city,
    state,
    expected,
    clientNotes: sanitizeUntrusted(profile?.notes),
    // Oct 14 2026: the house-wide switched-off checks (houseRules.ts) first; a client's own entry wins.
    overrides: mergeOverrides(await houseOverrides(), parseJson<RuleOverride[]>(profile?.ruleOverridesJson, []).filter((o) => o && typeof o.ruleId === "string")),
    groupOrder: parseJson<string[] | null>(profile?.sequenceJson, null),
    ingest: { fireplace: str(ingestRaw.fireplace), tv: str(ingestRaw.tvMode ?? ingestRaw.tv), grass: str(ingestRaw.grass), declutter: str(ingestRaw.declutter) },
    photos: [],
    progress: { ...emptyProgress(), ...(summary?.progress ?? {}) },
    checks: { photos: checks.photos ?? {}, gallery: checks.gallery ?? { performed: [], skipped: [] } },
    models: Object.fromEntries(Object.entries(models).filter((e): e is [string, string] => typeof e[1] === "string")),
    modelDetail: (models._detail as Ctx["modelDetail"]) ?? {},
    notes: [],
    abort: null,
    stoppedFor: null,
    done: { prepped: 0, classified: 0, inspected: 0, arbitrated: 0, p1bCalls: 0, p2Units: 0, p4: false },
    sourceLoads: new Map(),
    saveChain: Promise.resolve(),
  };
  ctx.progress.ticks++;
  await refreshPhotos(ctx);
  return ctx;
}

export type JobTickResult = { jobId: string; runId: string | null; outcome: "finished" | "paused" | "skipped" | "error"; detail: string; calls: number; costUsd: number };

async function tickJob(ctx: Ctx): Promise<JobTickResult["outcome"]> {
  // A: prep every active photo that lacks derivatives and CV for its hash.
  const toPrep = activeOf(ctx).filter((p) => !prepDone(p));
  if (toPrep.length) {
    const all = await pool(toPrep, PREP_CONCURRENCY, () => canStart(ctx, PREP_MIN_MS), async (p) => {
      try {
        await prepPhoto(ctx, p);
      } catch (e) {
        if (e instanceof QcCallError && e.kind === "config") throw e;
        // An unexpected failure on one photo (a sharp error on a strange
        // file) must not stall the gallery: retried twice, then filed.
        const message = (e as Error).message.slice(0, 200);
        console.warn("photo-qc: prep failed", p.id, message);
        if (!transientExhausted(ctx, `prep:${p.id}:${hashOf(p)}`)) return void (await saveRun(ctx));
        await persistUnavailable(ctx, p, "error", `the photo could not be processed (${message})`, [
          unavailableDraft({ photoId: p.id, contentHash: hashOf(p), pass: "P1_PHOTO", source: "FILE", promptId: null, model: null, reason: message, what: "The photo could not be processed" }),
        ]);
      }
    });
    await refreshPhotos(ctx);
    if (!all || activeOf(ctx).some((p) => !prepDone(p))) return "paused";
  }

  // B1: P0 for every photo with an image.
  const toClassify = activeOf(ctx).filter((p) => hasImage(p) && !classified(p));
  if (toClassify.length) {
    const seq = new Map(activeOf(ctx).map((p, i) => [p.id, i + 1]));
    const [first, ...rest] = toClassify;
    if (!canStart(ctx, P0_CLASSIFY_V1.startMinMs)) return "paused";
    await classifyPhoto(ctx, first, seq.get(first.id) ?? 1);
    await pool(rest, CALL_CONCURRENCY, () => canStart(ctx, P0_CLASSIFY_V1.startMinMs), (p) => classifyPhoto(ctx, p, seq.get(p.id) ?? 1));
    await refreshPhotos(ctx);
    if (activeOf(ctx).some((p) => hasImage(p) && !classified(p))) return "paused";
  }

  // B2: P1, sorted by rules prefix; the first call of each prefix runs alone.
  const { order, position, label, idOfLabel } = orderOf(ctx);
  const total = order.length;
  const g = galleryStats(ctx);
  const toInspect = activeOf(ctx).filter((p) => hasImage(p) && classified(p) && !inspected(p));
  if (toInspect.length) {
    const byKey = new Map<string, Asset[]>();
    for (const p of toInspect) {
      const k = rulesFor(ctx, p).key;
      byKey.set(k, [...(byKey.get(k) ?? []), p]);
    }
    const keys = [...byKey.keys()].sort();
    const firsts = keys.map((k) => byKey.get(k)![0]);
    const rest = keys.flatMap((k) => byKey.get(k)!.slice(1));
    const may = () => canStart(ctx, P1_PHOTO_V1.startMinMs);
    await pool(firsts, CALL_CONCURRENCY, may, (p) => inspectPhoto(ctx, p, position.get(p.id) ?? 0, total, g));
    await pool(rest, CALL_CONCURRENCY, may, (p) => inspectPhoto(ctx, p, position.get(p.id) ?? 0, total, g));
    await refreshPhotos(ctx);
    if (activeOf(ctx).some((p) => hasImage(p) && !inspected(p))) return "paused";
  }

  // B3: the arbiter for every CRITICAL P1 finding still PENDING.
  const current = new Map(activeOf(ctx).map((p) => [p.id, hashOf(p)]));
  const pending = (
    await prisma.photoQcFinding.findMany({
      where: { jobId: ctx.job.id, source: "P1", arbitration: "PENDING", status: "OPEN" },
      select: { id: true, photoId: true, ruleId: true, specificIssue: true, locationText: true, bboxJson: true, explanation: true, severity: true, confidence: true, privacySensitive: true, isPermanentFeature: true, fixStrategy: true, coercedJson: true, rawJson: true, contentHash: true },
    })
  ).filter((f) => f.photoId && current.get(f.photoId) === f.contentHash && !ctx.progress.arbiterTried.includes(f.id));
  if (pending.length) {
    const all = await pool(pending, ARBITER_CONCURRENCY, () => canStart(ctx, P1_ARBITER_V1.startMinMs), (f) => arbitrate(ctx, f, position, total, g));
    if (!all) return "paused";
    const stillPending = await prisma.photoQcFinding.findMany({ where: { id: { in: pending.map((f) => f.id) }, arbitration: "PENDING" }, select: { id: true } });
    if (stillPending.some((f) => !ctx.progress.arbiterTried.includes(f.id))) return "paused";
  }

  // C1: P1b over the gallery's dust candidates.
  await refreshPhotos(ctx);
  const dustGroups = clusterDust(activeOf(ctx).filter(hasImage).map((p) => ({ id: p.id, fullW: metricsOf(p)!.fullW, fullH: metricsOf(p)!.fullH, candidates: metricsOf(p)!.dustCandidates })));
  const plan = planP1b(ctx, dustGroups);
  if (plan.capped.length) await markP1bSkipped(ctx, plan.capped, `gallery crop cap (${MAX_CROPS_PER_GALLERY}) reached`);
  if (plan.batches.length) {
    const all = await pool(plan.batches, 2, () => canStart(ctx, P1B_DUST_V1.startMinMs), (b) => runP1bBatch(ctx, b, position));
    await refreshPhotos(ctx);
    if (!all || planP1b(ctx, dustGroups).batches.length) return "paused";
  }

  // C2: P2 (phase-gated rules; CRITICAL-capable ones always run, plan §7.2).
  if (!ctx.progress.p2Done) {
    const p2Rules = rulesForPass({ pass: "P2_GALLERY", maxBuildPhase: ctx.settings.maxBuildPhase, detectors: ["VISION_GALLERY"], overrides: ctx.overrides })
      .filter((r) => r.groupKey !== "SENSOR_DUST" && r.groupKey !== "DUPLICATE_PHOTOS")
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const units = p2Rules.length ? planP2(ctx, order).filter((u) => !ctx.progress.p2Units.includes(u.key)) : [];
    if (!p2Rules.length) ledgerSkip(ctx, null, "P2", "no gallery rules at this build phase");
    for (const u of units) {
      if (!canStart(ctx, P2_GALLERY_V1.startMinMs)) return "paused";
      await runP2Unit(ctx, u, position, p2Rules);
      if (ctx.abort) throw ctx.abort;
    }
    if (planP2(ctx, order).some((u) => !ctx.progress.p2Units.includes(u.key)) && p2Rules.length) return "paused";
    ctx.progress.p2Done = true;
    await saveRun(ctx);
  }

  // C3: P4.
  if (!ctx.progress.p4Done) {
    if (!canStart(ctx, P4_ORDER_V1.startMinMs)) return "paused";
    await runP4(ctx, order, label, idOfLabel);
    if (!ctx.progress.p4Done) return "paused";
  }

  await finalize(ctx);
  return "finished";
}

async function processJob(jobId: string, settings: PhotoDeliverySettings, deadline: number, leaseBy: string): Promise<JobTickResult> {
  const leaseMs = Math.max(4 * MIN, deadline - now() + 4 * MIN);
  if (!(await claimJob(jobId, leaseBy, leaseMs))) return { jobId, runId: null, outcome: "skipped", detail: "another worker holds the job", calls: 0, costUsd: 0 };
  let ctx: Ctx | null = null;
  try {
    const job = await prisma.photoJob.findUnique({ where: { id: jobId } });
    if (!job) return { jobId, runId: null, outcome: "skipped", detail: "job not found", calls: 0, costUsd: 0 };
    const got = await runForJob(job, settings);
    if (!got) return { jobId, runId: null, outcome: "skipped", detail: `the job could not enter QC from ${job.stage}`, calls: 0, costUsd: 0 };
    const fresh = await prisma.photoJob.findUnique({ where: { id: jobId } });
    ctx = await loadCtx(fresh ?? job, got.run, settings, deadline, leaseBy);
    const startCalls = ctx.progress.calls;
    const outcome = await tickJob(ctx);
    if (outcome !== "finished") {
      ctx.progress.wallMs += now() - ctx.tickStart;
      await saveRun(ctx);
      const d = ctx.done;
      await logJobEvent(jobId, "qc", "AI QC paused until the next tick (time budget)", { runId: ctx.run.id, prepped: d.prepped, classified: d.classified, inspected: d.inspected, arbitrated: d.arbitrated, p1bCalls: d.p1bCalls, p2Units: d.p2Units, p4: d.p4 });
    }
    const cost = await prisma.photoQcRun.findUnique({ where: { id: ctx.run.id }, select: { costUsd: true } });
    return { jobId, runId: ctx.run.id, outcome, detail: outcome, calls: ctx.progress.calls - startCalls, costUsd: cost?.costUsd ?? 0 };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    console.warn("photo-qc: tick failed", jobId, msg);
    if (ctx) {
      ctx.progress.wallMs += now() - ctx.tickStart;
      await saveRun(ctx, { error: msg }).catch(() => {});
    }
    await prisma.photoJob.update({ where: { id: jobId }, data: { lastError: `AI QC: ${msg}`.slice(0, 300) } }).catch(() => {});
    await logJobEvent(jobId, "qc", `AI QC tick failed: ${msg}`, { runId: ctx?.run.id ?? null });
    return { jobId, runId: ctx?.run.id ?? null, outcome: "error", detail: msg, calls: 0, costUsd: 0 };
  } finally {
    await releaseJob(jobId, leaseBy);
  }
}

// ---- spend guardrail ------------------------------------------------------------------------------

/** This calendar month's QC spend (ET), summed over the runs it started. */
export async function monthQcSpendUsd(at = new Date(now())): Promise<{ usd: number; monthKey: string; since: Date }> {
  const monthKey = etDayKey(at).slice(0, 7);
  const since = etAt(`${monthKey}-01`, 0);
  const agg = await prisma.photoQcRun.aggregate({ where: { startedAt: { gte: since } }, _sum: { costUsd: true } });
  return { usd: Math.round((agg._sum.costUsd ?? 0) * 100) / 100, monthKey, since };
}

// ---- the public surface -----------------------------------------------------------------------------

export type DriveSummary = {
  ok: boolean;
  skipped?: string;
  budgetPaused?: { spentUsd: number; budgetUsd: number };
  jobs: JobTickResult[];
  ms: number;
};

const REQUESTABLE: JobStage[] = ["EDITED", "QC_REVIEW", "READY", "ON_HOLD", "FIXING", "REVISION_REQUESTED", "QC_RUNNING"];

/**
 * Ask for QC on a job: sets qcRequestedAt and logs who and why. The cron's
 * next driveQc picks it up. `reinspect` clears the per-photo markers so every
 * pass runs again even for unchanged files (after raising maxBuildPhase, say);
 * without it, photos whose content hash was already inspected are reused and
 * only the gallery passes and the verdict are redone.
 */
export async function requestQc(jobId: string, trigger: "INITIAL" | "MANUAL" | "POST_FIX", by: string, opts: { reinspect?: boolean } = {}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const who = String(by ?? "").trim().slice(0, 120) || "staff";
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, holdReason: true } });
  if (!job) return { ok: false, message: "Photo job not found." };
  if (!REQUESTABLE.includes(job.stage as JobStage)) {
    return { ok: false, message: job.stage === "EDITING" || job.stage === "EDIT_FAILED" ? "The edited photos have not landed yet, so there is nothing to check." : "This job is past QC. Open a revision to check it again." };
  }
  if (job.stage === "ON_HOLD" && job.holdReason !== "CRITICAL") return { ok: false, message: "This job is on hold for another reason. Release the hold first." };
  await prisma.photoJob.update({ where: { id: jobId }, data: { qcRequestedAt: new Date(now()) } });
  if (opts.reinspect) {
    await prisma.photoAsset.updateMany({ where: { jobId, status: "ACTIVE" }, data: { classifiedHash: null, inspectedHash: null, cvHash: null } });
  }
  await logJobEvent(jobId, who, `QC requested (${trigger})${opts.reinspect ? ", every photo re-inspected" : ""}`, { trigger, by: who, reinspect: !!opts.reinspect });
  const s = await photoDeliverySettings();
  return { ok: true, message: s.qcEnabled ? "QC requested. It starts on the next pass (within about 5 minutes)." : "QC requested. It will run once AI QC is switched on in Photo Delivery settings." };
}

/** Jobs that need a QC tick, oldest first: runs to resume, landed galleries,
 *  and explicit requests newer than the job's last run. */
async function jobsToDrive(settings: PhotoDeliverySettings, take: number): Promise<string[]> {
  const resume = await prisma.photoJob.findMany({ where: { stage: "QC_RUNNING" }, orderBy: { stageChangedAt: "asc" }, select: { id: true }, take });
  const since = settings.qcFrom ? new Date(settings.qcFrom) : null;
  // Oct 14 2026 (Jordan: QC should be free): with paidQcAuto off, a landed
  // gallery and the after-delivery audits wait for the free photo check
  // (autohdrCheck.ts); this engine runs only on request ("Run QC").
  const landed = !settings.paidQcAuto ? [] : await prisma.photoJob.findMany({
    where: { stage: "EDITED", photos: { some: { status: "ACTIVE" } }, ...(since ? { OR: [{ finalsChangedAt: { gte: since } }, { finalsChangedAt: null, stageChangedAt: { gte: since } }] } : {}) },
    orderBy: { stageChangedAt: "asc" },
    select: { id: true },
    take,
  });
  const requested = await prisma.photoJob.findMany({
    where: { qcRequestedAt: { not: null }, stage: { in: ["EDITED", "QC_REVIEW", "READY", "ON_HOLD", "FIXING", "REVISION_REQUESTED"] } },
    orderBy: { qcRequestedAt: "asc" },
    select: { id: true, qcRequestedAt: true, stage: true, holdReason: true, qcRuns: { orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } } },
    take: take * 4,
  });
  const wanted = requested
    .filter((j) => j.stage !== "ON_HOLD" || j.holdReason === "CRITICAL")
    .filter((j) => !j.qcRuns[0] || (j.qcRequestedAt && j.qcRequestedAt > j.qcRuns[0].startedAt))
    .map((j) => j.id);
  // Shadow audits last: galleries delivered in the last 3 days with no QC run
  // yet, and audits already under way (see runForJob).
  // With paidQcAuto off, an audit already under way still finishes (its
  // money is spent); no new one starts.
  const audits = settings.qcShadow
    ? await prisma.photoJob.findMany({
        where: {
          stage: { in: ["DELIVERED", "DELIVERING"] },
          stageChangedAt: { gte: new Date(now() - 3 * 86_400_000) },
          photos: { some: { status: "ACTIVE" } },
          OR: settings.paidQcAuto ? [{ qcRuns: { none: {} } }, { qcRuns: { some: { status: "RUNNING" } } }] : [{ qcRuns: { some: { status: "RUNNING", trigger: { not: "AUTOHDR_CHECK" } } } }],
          ...(since ? { stageChangedAt: { gte: since > new Date(now() - 3 * 86_400_000) ? since : new Date(now() - 3 * 86_400_000) } } : {}),
        },
        orderBy: { stageChangedAt: "asc" },
        select: { id: true },
        take,
      })
    : [];
  return [...new Set([...resume.map((j) => j.id), ...landed.map((j) => j.id), ...wanted, ...audits.map((j) => j.id)])].slice(0, take);
}

/**
 * One bounded slice of QC work, safe to call every 5 minutes. Starts no new
 * job with less than 30 s of budget left, and no Claude call without the
 * pass's own minimum left (a call in flight finishes; see each PromptDef's
 * timeoutMs), so the caller's step cap should be budgetMs plus about 3 min.
 */
export async function driveQc(opts: { budgetMs: number; leaseBy: string; maxJobs?: number }): Promise<DriveSummary> {
  const start = now();
  const deadline = start + Math.max(0, opts.budgetMs);
  const settings = await photoDeliverySettings();
  if (!settings.qcEnabled) return { ok: true, skipped: "AI QC is switched off", jobs: [], ms: 0 };
  const maxJobs = Math.max(1, opts.maxJobs ?? 2);
  const ids = await jobsToDrive(settings, maxJobs * 3);
  const results: JobTickResult[] = [];
  for (const id of ids) {
    if (results.filter((r) => r.outcome !== "skipped").length >= maxJobs) break;
    if (deadline - now() < MIN_JOB_MS) break;
    const spend = await monthQcSpendUsd();
    if (spend.usd >= settings.monthlyQcBudgetUsd) {
      await alertOwnerAndKyle({
        kind: "photo_qc_budget",
        title: "AI photo QC paused: monthly budget reached",
        body: `This month's AI QC spend is $${spend.usd.toFixed(2)} of $${settings.monthlyQcBudgetUsd.toFixed(0)}.`,
        href: "/ops/photo-delivery",
        dedupeKey: `photo-qc-budget-${spend.monthKey}`,
        text: `AI photo QC is paused: this month's spend ($${spend.usd.toFixed(2)}) reached the $${settings.monthlyQcBudgetUsd.toFixed(0)} budget. Raise it in Photo Delivery settings to resume: ${appBase()}/ops/photo-delivery`,
        to: "owner",
      }).catch(() => ({ announced: 0 }));
      console.warn(`photo-qc: monthly budget reached ($${spend.usd} of $${settings.monthlyQcBudgetUsd}); no job started`);
      return { ok: true, budgetPaused: { spentUsd: spend.usd, budgetUsd: settings.monthlyQcBudgetUsd }, jobs: results, ms: now() - start };
    }
    results.push(await processJob(id, settings, deadline, opts.leaseBy));
  }
  return { ok: results.every((r) => r.outcome !== "error"), jobs: results, ms: now() - start };
}
