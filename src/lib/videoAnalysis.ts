import "server-only";

import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  GVA_KEY, GVA_PREFIX, DAILY_CAP_DEFAULT, FPS_DEFAULT, TRIAL_DAYS,
  alignScript, backoffMs, buildReferences, chosenCover, clampDailyCap, clampFps, coverPrompt, coverSchema, hookOf, newJob,
  nextPacificMidnight, pacificDay, parseJob, parseSegments, rankCoverPicks, scriptSentences, selectSpellingFlags, spellingPrompt,
  spellingSchema, trialSummary,
  type CoverCandidate, type CoverResult, type GvaJob, type GvaKind, type NameInput, type OnScreenReading, type CoverPickRaw,
  type SpellFlag, type SpellVerdict, type TrialSummary,
} from "@/lib/videoAnalysisCore";
import {
  GEMINI_CONNECTION, GEMINI_VIDEO_MODEL, GeminiError, askAboutVideo, deleteGeminiFile, geminiFileState, geminiKey, uploadVideoToGemini, waitActive,
  type GeminiFile,
} from "@/lib/integrations/gemini";
import { finishedFileOf, type FinishedFile } from "@/lib/mediaLibraryCore";

// ---------------------------------------------------------------------------
// VIDEO ANALYSIS WITH GEMINI (Jordan, Oct 23 2026). Two jobs per video version,
// each run once (keyed on the cut and a fingerprint of its bytes):
//
//   COVERS (live from day one). When a version is approved, Gemini is asked
//   for the best-looking moments, near the hook when the caption builder's
//   Deepgram transcript says when it is spoken: the agent facing the camera,
//   eyes open, sharp, well lit, face and any title inside the profile grid's
//   middle 1080×1350. The hub grabs the real frames (lib/videoFrames, the
//   sharpest within half a second of each moment) and keeps three 1080×1920
//   JPEGs, the best pre-selected. The checked Topaz file is read when there
//   is one (a cover waits up to COVER_TOPAZ_WAIT_H for a running pass).
//
//   SPELLING (trial, Jordan only). When a version enters review, Gemini reads
//   every on-screen text twice with a confidence; lib/videoAnalysisCore decides
//   which readings are a mistake against the SCRIPT and the client's "Spell
//   these exactly" names (never Deepgram's transcript, which can mishear a
//   name: it only says when a line is spoken). At most three flags, each with
//   Right / Wrong for the owner, who decides when they are good enough for the
//   reviewers' switch. Never blocks anything.
//
// STORAGE. No new tables: each job is one AppSetting row (`gva:<kind>:<cut>`,
// the same per-row pattern as lib/videoAryeoPush), claimed and updated with a
// compare-and-set on the row's value, so two cron ticks can never run one job
// twice. `gemini_video_settings` holds the owner's settings, and
// `gemini_video_state` the day's request count and any 429 cool-down.
//
// THE FREE TIER. Google publishes the free tier's per-minute and per-day
// numbers only inside AI Studio, so the hub keeps its own ceiling: at most
// `dailyCap` model requests a Pacific day (the quota's own day), two jobs a
// tick, a pause on every 429 (Google's retryDelay when it gives one; until
// midnight Pacific when the daily quota is spent), and nothing at all until a
// key is saved. Uploads reuse the same file across tries and are deleted when
// a job ends. No backfill: only versions that came in after the key was saved.
// ---------------------------------------------------------------------------

export const SETTINGS_KEY = "gemini_video_settings";
export const STATE_KEY = "gemini_video_state";
export const REVIEWERS_KEY = "spelling_flags_reviewers";

const MAX_ATTEMPTS = 4;
const LEASE_MS = 10 * 60_000;
const COVER_TOPAZ_WAIT_H = 8;
const ID_RE = /^[a-z0-9]{10,40}$/i;

// ---- settings ----------------------------------------------------------------

export type GvaSettings = {
  /** Gemini's sampling rate, frames a second (1 to 5) */
  fps: number;
  /** model requests a Pacific day */
  dailyCap: number;
  covers: boolean;
  spelling: boolean;
  /** when the key was first saved: nothing older is ever analysed (no backfill) */
  startedAt: string | null;
};

const DEFAULT_SETTINGS: GvaSettings = { fps: FPS_DEFAULT, dailyCap: DAILY_CAP_DEFAULT, covers: true, spelling: true, startedAt: null };

async function readJson<T>(key: string): Promise<{ raw: string | null; value: T | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return { raw: null, value: null };
  try { return { raw: row.value, value: JSON.parse(row.value) as T }; } catch { return { raw: row.value, value: null }; }
}

/** Compare-and-set on one AppSetting row. raw null = create it (false if someone beat us). */
async function cas(key: string, raw: string | null, next: unknown, by: string | null = null): Promise<string | null> {
  const value = JSON.stringify(next);
  if (raw == null) {
    try {
      await prisma.appSetting.create({ data: { key, value, updatedBy: by } });
      return value;
    } catch {
      return null;
    }
  }
  const r = await prisma.appSetting.updateMany({ where: { key, value: raw }, data: { value, ...(by ? { updatedBy: by } : {}) } });
  return r.count === 1 ? value : null;
}

export async function gvaSettings(): Promise<GvaSettings> {
  const { value } = await readJson<Partial<GvaSettings>>(SETTINGS_KEY);
  const s = { ...DEFAULT_SETTINGS, ...(value ?? {}) };
  return { fps: clampFps(s.fps), dailyCap: clampDailyCap(s.dailyCap), covers: s.covers !== false, spelling: s.spelling !== false, startedAt: s.startedAt ?? null };
}

export async function saveGvaSettings(patch: Partial<Omit<GvaSettings, "startedAt">> & { startedAt?: string | null }, by: string | null): Promise<GvaSettings> {
  for (let i = 0; i < 5; i++) {
    const { raw, value } = await readJson<Partial<GvaSettings>>(SETTINGS_KEY);
    const cur = { ...DEFAULT_SETTINGS, ...(value ?? {}) };
    const next: GvaSettings = {
      fps: clampFps(patch.fps ?? cur.fps),
      dailyCap: clampDailyCap(patch.dailyCap ?? cur.dailyCap),
      covers: patch.covers ?? cur.covers !== false,
      spelling: patch.spelling ?? cur.spelling !== false,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : cur.startedAt ?? null,
    };
    if (await cas(SETTINGS_KEY, raw, next, by)) return next;
  }
  throw new Error("The settings changed under us. Try again.");
}

/** The key was just saved: start the clock (once). Versions before it are never analysed. */
export async function markGeminiStarted(by: string | null, now: Date = new Date()): Promise<void> {
  const s = await gvaSettings();
  if (!s.startedAt) await saveGvaSettings({ startedAt: now.toISOString() }, by);
}

export async function spellingReviewersOn(): Promise<boolean> {
  const { value } = await readJson<{ on?: boolean }>(REVIEWERS_KEY);
  return value?.on === true;
}

export async function setSpellingReviewers(on: boolean, by: string | null): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: REVIEWERS_KEY },
    create: { key: REVIEWERS_KEY, value: JSON.stringify({ on, at: new Date().toISOString(), by }), updatedBy: by },
    update: { value: JSON.stringify({ on, at: new Date().toISOString(), by }), updatedBy: by },
  });
}

// ---- the day's requests and the 429 pause ------------------------------------------

export type GvaUsage = {
  day: string; calls: number; cooldownUntil: string | null; lastCallAt: string | null;
  last429At: string | null; lastError: string | null; lastRunAt: string | null;
};

const freshUsage = (now: Date): GvaUsage => ({ day: pacificDay(now), calls: 0, cooldownUntil: null, lastCallAt: null, last429At: null, lastError: null, lastRunAt: null });

async function readUsage(now: Date): Promise<{ raw: string | null; u: GvaUsage }> {
  const { raw, value } = await readJson<GvaUsage>(STATE_KEY);
  const u = { ...freshUsage(now), ...(value ?? {}) };
  if (u.day !== pacificDay(now)) { u.day = pacificDay(now); u.calls = 0; }
  return { raw, u };
}

async function updateUsage(now: Date, fn: (u: GvaUsage) => GvaUsage | null): Promise<GvaUsage | null> {
  for (let i = 0; i < 8; i++) {
    const { raw, u } = await readUsage(now);
    const next = fn({ ...u });
    if (!next) return null;
    if (await cas(STATE_KEY, raw, next)) return next;
  }
  return null;
}

/** Take one of today's model requests, or refuse at the cap. */
export async function reserveCall(cap: number, now: Date = new Date()): Promise<boolean> {
  const r = await updateUsage(now, (u) => (u.calls >= cap ? null : { ...u, calls: u.calls + 1, lastCallAt: now.toISOString() }));
  return !!r;
}

async function noteRateLimit(err: GeminiError, attempt: number, now: Date): Promise<Date> {
  const until = err.perDay ? nextPacificMidnight(now) : new Date(now.getTime() + backoffMs(attempt, err.retryAfterMs));
  await updateUsage(now, (u) => ({ ...u, cooldownUntil: until.toISOString(), last429At: now.toISOString(), lastError: err.message }));
  return until;
}

// ---- job rows ----------------------------------------------------------------------

async function readJob(kind: GvaKind, submissionId: string): Promise<{ raw: string; job: GvaJob } | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: GVA_KEY(kind, submissionId) } }).catch(() => null);
  const job = parseJob(row?.value);
  return row && job ? { raw: row.value, job } : null;
}

async function jobsFor(kind: GvaKind, ids: readonly string[]): Promise<Map<string, GvaJob>> {
  const out = new Map<string, GvaJob>();
  const clean = [...new Set(ids.filter((x) => ID_RE.test(x)))];
  if (!clean.length) return out;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: clean.map((id) => GVA_KEY(kind, id)) } }, select: { value: true } }).catch(() => []);
  for (const r of rows) {
    const j = parseJob(r.value);
    if (j) out.set(j.submissionId, j);
  }
  return out;
}

async function allJobs(kind?: GvaKind): Promise<GvaJob[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: kind ? `${GVA_PREFIX}${kind}:` : GVA_PREFIX } }, select: { value: true } }).catch(() => []);
  return rows.map((r) => parseJob(r.value)).filter((j): j is GvaJob => !!j);
}

// ---- which version, which bytes ------------------------------------------------------

const CUT_SELECT = {
  id: true, projectId: true, kind: true, status: true, round: true, fileName: true, sizeBytes: true, contentHash: true,
  blobUrl: true, assetPath: true, finalPath: true, deliverableId: true, slot: true, decidedAt: true, createdAt: true,
  selfCheckId: true, selfCheckedAt: true,
  topazJob: { select: { id: true, state: true, finalPath: true, savedAt: true, outputCheck: true, sourceDurationSec: true } },
} as const;

type CutRow = {
  id: string; projectId: string; kind: string; status: string; round: number; fileName: string | null; sizeBytes: number | null; contentHash: string | null;
  blobUrl: string | null; assetPath: string | null; finalPath: string | null; deliverableId: string | null; slot: number; decidedAt: Date | null; createdAt: Date;
  selfCheckId: string | null; selfCheckedAt: Date | null;
  topazJob: { id: string; state: string; finalPath: string | null; savedAt: Date | null; outputCheck: string | null; sourceDurationSec: number | null } | null;
};

/**
 * What identifies THESE bytes, stable for the life of the version: the stored
 * sha256 when there is one, else the cut, its file name and size. The cut's
 * blob URL is left out on purpose: the 90-day prune clears it, and a prune is
 * not a new version.
 */
export function versionFingerprint(cut: { id: string; contentHash: string | null; fileName: string | null; sizeBytes: number | null }): string {
  return cut.contentHash ? `sha:${cut.contentHash}` : `v:${cut.id}:${cut.fileName ?? ""}:${cut.sizeBytes ?? ""}`;
}

/** A version is IN review once it is past the upload and the editor's own check (or never had one). */
export function inReview(c: Pick<CutRow, "status" | "selfCheckId" | "selfCheckedAt">): boolean {
  if (c.status === "PENDING") return !!c.selfCheckedAt || !c.selfCheckId;
  return c.status === "CHANGES_REQUESTED" || c.status === "APPROVED";
}

let testSource: ((f: FinishedFile, cutId: string) => Promise<string | null>) | undefined;
/** Drills only: hand the analysis a local URL for a cut's file. */
export function __setVideoSourceForTests(fn: typeof testSource): void {
  testSource = fn;
}

/** A URL that carries its own permission for this file (never logged, never stored). */
async function sourceUrl(f: FinishedFile, cutId: string): Promise<string> {
  if (testSource) {
    const u = await testSource(f, cutId);
    if (!u) throw new GeminiError("The video file can't be read.", "unreachable_media", false);
    return u;
  }
  if (f.kind === "blob") {
    const { fetchableCutUrl } = await import("@/lib/reviewCuts");
    const r = await fetchableCutUrl({ blobUrl: f.url }, { ttlMs: 2 * 3600_000, purpose: "video analysis" });
    if (!r.ok) throw new GeminiError(r.message, "unreachable_media", r.reason === "mint-failed");
    return r.url;
  }
  const { dropboxTemporaryLink } = await import("@/lib/integrations/dropbox");
  try {
    return await dropboxTemporaryLink(f.path);
  } catch (e) {
    const gone = /not_found|path_lookup/i.test((e as Error).message);
    throw new GeminiError(gone ? "The video file is no longer in Dropbox." : "Dropbox couldn't hand over the video just now.", "unreachable_media", !gone);
  }
}

// ---- what the spelling check reads against -----------------------------------------------

/** The script for this exact video and the client's "Spell these exactly" names (lib/spellList), as the editor's brief builds them. */
export async function spellingInputs(cut: Pick<CutRow, "projectId" | "deliverableId" | "slot">): Promise<{ script: string | null; names: NameInput[] }> {
  const project = await prisma.project.findUnique({
    where: { id: cut.projectId },
    select: {
      id: true, title: true, addressLine: true, city: true, contentMonthId: true, reelHook: true, reelScript: true, clientId: true,
      client: { select: { id: true, name: true, company: true, aryeoTeamName: true } },
    },
  });
  if (!project) return { script: null, names: [] };
  const { outputBriefsFor } = await import("@/lib/deliverableOutputs");
  const briefs = await outputBriefsFor(project.id).catch(() => []);
  const slotKey = cut.deliverableId ? `${cut.deliverableId}:${cut.slot ?? 1}` : null;
  const brief = slotKey ? briefs.find((b) => b.key === slotKey) ?? null : null;
  const studio = [project.reelHook, project.reelScript].filter((x) => x?.trim()).join("\n") || null;
  const script = brief?.script?.text?.trim() || studio;
  const listing = !project.contentMonthId;
  const sl = await import("@/lib/spellList");
  const corrections = project.clientId ? await sl.spellCorrectionTextsFor(project.clientId).catch(() => [] as string[]) : [];
  const list = sl.buildSpellList({
    clientName: project.client?.name ?? null,
    brokerage: project.client?.company ?? null,
    team: project.client?.aryeoTeamName ?? null,
    street: listing ? sl.streetOf(project.title) ?? sl.streetOf(project.addressLine) : null,
    town: listing ? project.city?.trim() || sl.townOf(project.title) || sl.townOf(project.addressLine) : null,
    script,
    corrections,
    context: [],
  });
  return { script, names: list.entries.map((e) => ({ text: e.text, from: e.from })) };
}

/** When things are spoken, from the caption builder's transcript of THIS cut (never its words). */
async function transcriptSegments(submissionId: string) {
  const { transcriptForCut } = await import("@/lib/cutTranscripts");
  const t = await transcriptForCut(submissionId).catch(() => null);
  if (!t?.transcriptId) return [];
  const row = await prisma.contentCutTranscript.findUnique({ where: { id: t.transcriptId }, select: { segmentsJson: true } }).catch(() => null);
  return parseSegments(row?.segmentsJson);
}

// ---- the sweep: one job per new version -----------------------------------------------

/** Rows for every version that came in after the key was saved and has none yet. Never older ones. */
export async function sweepVideoAnalysis(settings: GvaSettings, now: Date = new Date()): Promise<{ spell: number; cover: number }> {
  const out = { spell: 0, cover: 0 };
  if (!settings.startedAt) return out;
  const since = new Date(settings.startedAt);
  const excl = await import("@/lib/queries").then((m) => m.syntheticClientIds()).catch(() => [] as string[]);
  const project: Prisma.ProjectWhereInput = { status: { not: "CANCELLED" }, ...(excl.length ? { clientId: { notIn: excl } } : {}) };
  const hasBytes = { OR: [{ blobUrl: { not: null } }, { assetPath: { not: null } }, { finalPath: { not: null } }] };
  const [inReviewRows, approvedRows] = await Promise.all([
    settings.spelling
      ? prisma.reviewSubmission.findMany({ where: { kind: "video", createdAt: { gte: since }, status: { in: ["PENDING", "CHANGES_REQUESTED", "APPROVED"] }, ...hasBytes, project }, orderBy: { createdAt: "desc" }, take: 40, select: CUT_SELECT })
      : Promise.resolve([] as CutRow[]),
    settings.covers
      ? prisma.reviewSubmission.findMany({ where: { kind: "video", status: "APPROVED", decidedAt: { gte: since }, ...hasBytes, project }, orderBy: { decidedAt: "desc" }, take: 40, select: CUT_SELECT })
      : Promise.resolve([] as CutRow[]),
  ]);
  const want: { kind: GvaKind; cut: CutRow }[] = [
    ...(inReviewRows as CutRow[]).filter(inReview).map((cut) => ({ kind: "spell" as const, cut })),
    ...(approvedRows as CutRow[]).map((cut) => ({ kind: "cover" as const, cut })),
  ];
  if (!want.length) return out;
  const existing = await prisma.appSetting.findMany({ where: { key: { in: want.map((w) => GVA_KEY(w.kind, w.cut.id)) } }, select: { key: true, value: true } });
  const byKey = new Map(existing.map((r) => [r.key, r.value]));
  for (const w of want) {
    const key = GVA_KEY(w.kind, w.cut.id);
    const fp = versionFingerprint(w.cut);
    const raw = byKey.get(key) ?? null;
    const cur = parseJob(raw);
    if (cur && cur.fingerprint === fp) continue;
    // A different file behind the same version (rare: a Final-folder file replaced in place) is a new run.
    if (cur && (cur.state === "RUNNING" || cur.state === "QUEUED" || cur.state === "WAITING") && cur.fingerprint !== fp && cur.leaseUntil && Date.parse(cur.leaseUntil) > now.getTime()) continue;
    if (await cas(key, raw, newJob(w.kind, w.cut.id, w.cut.projectId, fp, now))) out[w.kind]++;
  }
  return out;
}

/**
 * Ask for one version's run by hand (the owner, or a drill on a TEST client,
 * which the sweep leaves out). Idempotent: an existing row for the same bytes
 * is left exactly as it is. Nothing is sent here; the driver does that, and
 * only with a key.
 */
export async function enqueueVideoAnalysis(kind: GvaKind, submissionId: string, now: Date = new Date()): Promise<{ queued: boolean; state: GvaJob["state"] | null }> {
  const cut = await loadCut(submissionId);
  if (!cut || cut.kind !== "video") return { queued: false, state: null };
  const fp = versionFingerprint(cut);
  const cur = await readJob(kind, submissionId);
  if (cur && cur.job.fingerprint === fp) return { queued: false, state: cur.job.state };
  const ok = await cas(GVA_KEY(kind, submissionId), cur?.raw ?? null, newJob(kind, submissionId, cut.projectId, fp, now));
  return { queued: !!ok, state: ok ? "QUEUED" : cur?.job.state ?? null };
}

// ---- the driver --------------------------------------------------------------------------

export type GvaRunResult = {
  skipped: "no_key" | "cooling_down" | "daily_cap" | null;
  swept: { spell: number; cover: number };
  ran: { kind: GvaKind; submissionId: string; outcome: string }[];
  usage: { day: string; calls: number; cap: number; cooldownUntil: string | null };
};

type Ctx = { key: string; settings: GvaSettings; deadline: number; now: () => Date };

/**
 * One tick: (1) no key, nothing; (2) one job per new version; (3) up to two
 * due jobs, spelling first (a reviewer is waiting on it), each spending at
 * most one model request, inside the daily cap and outside any 429 pause.
 */
export async function runVideoAnalysis(opts: { budgetMs?: number; maxJobs?: number; now?: () => Date; leaseBy?: string } = {}): Promise<GvaRunResult> {
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? 240_000);
  const result: GvaRunResult = { skipped: null, swept: { spell: 0, cover: 0 }, ran: [], usage: { day: pacificDay(now()), calls: 0, cap: 0, cooldownUntil: null } };
  // THE GATE: no key, no Google, no rows. Nothing below runs.
  const key = await geminiKey();
  if (!key) return { ...result, skipped: "no_key" };
  let settings = await gvaSettings();
  if (!settings.startedAt) {
    await markGeminiStarted("cron", now());
    settings = await gvaSettings();
  }
  result.usage.cap = settings.dailyCap;
  result.swept = await sweepVideoAnalysis(settings, now());
  await recoverStale(now());
  const leaseBy = opts.leaseBy ?? `gva:${randomUUID().slice(0, 8)}`;
  const ctx: Ctx = { key, settings, deadline, now };
  const maxJobs = Math.max(1, Math.min(opts.maxJobs ?? 2, 5));
  for (let i = 0; i < maxJobs; i++) {
    const { u } = await readUsage(now());
    result.usage = { day: u.day, calls: u.calls, cap: settings.dailyCap, cooldownUntil: u.cooldownUntil };
    if (u.cooldownUntil && Date.parse(u.cooldownUntil) > now().getTime()) { result.skipped = "cooling_down"; break; }
    if (u.calls >= settings.dailyCap) { result.skipped = "daily_cap"; break; }
    if (deadline - Date.now() < 90_000) break;
    const claimed = await claimNext(leaseBy, settings, now());
    if (!claimed) break;
    const outcome = await runClaimed(claimed, ctx);
    result.ran.push({ kind: claimed.job.kind, submissionId: claimed.job.submissionId, outcome });
    if (outcome === "rate_limited" || outcome === "daily_cap" || outcome === "unauthorized") break;
  }
  const { u } = await readUsage(now());
  result.usage = { day: u.day, calls: u.calls, cap: settings.dailyCap, cooldownUntil: u.cooldownUntil };
  await updateUsage(now(), (x) => ({ ...x, lastRunAt: now().toISOString() }));
  return result;
}

/** A job left RUNNING past its lease (the function was killed) goes back in line, or fails after MAX_ATTEMPTS. */
async function recoverStale(now: Date): Promise<void> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: GVA_PREFIX }, value: { contains: '"state":"RUNNING"' } }, select: { key: true, value: true } });
  for (const r of rows) {
    const j = parseJob(r.value);
    if (!j || !j.leaseUntil || Date.parse(j.leaseUntil) > now.getTime()) continue;
    const attempts = j.attempts + 1;
    const next: GvaJob = attempts >= MAX_ATTEMPTS
      ? { ...j, state: "FAILED", attempts, leaseUntil: null, leaseBy: null, finishedAt: now.toISOString(), updatedAt: now.toISOString(), error: `Stopped ${attempts} times before it finished. Not tried again.` }
      : { ...j, state: "QUEUED", attempts, leaseUntil: null, leaseBy: null, nextAttemptAt: now.toISOString(), updatedAt: now.toISOString(), error: "Interrupted before it finished. Queued again." };
    await cas(r.key, r.value, next);
  }
}

type Claimed = { key: string; raw: string; job: GvaJob };

async function claimNext(leaseBy: string, settings: GvaSettings, now: Date): Promise<Claimed | null> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: GVA_PREFIX }, OR: [{ value: { contains: '"state":"QUEUED"' } }, { value: { contains: '"state":"WAITING"' } }] },
    select: { key: true, value: true },
  });
  const due = rows
    .map((r) => ({ key: r.key, raw: r.value, job: parseJob(r.value) }))
    .filter((r): r is Claimed => !!r.job && (r.job.state === "QUEUED" || r.job.state === "WAITING") && (!r.job.nextAttemptAt || Date.parse(r.job.nextAttemptAt) <= now.getTime()))
    .sort((a, b) => (a.job.kind === b.job.kind ? a.job.createdAt.localeCompare(b.job.createdAt) : a.job.kind === "spell" ? -1 : 1));
  for (const r of due) {
    // A switched-off half: its waiting jobs end here, said so, and nothing is sent.
    if ((r.job.kind === "spell" && !settings.spelling) || (r.job.kind === "cover" && !settings.covers)) {
      await cas(r.key, r.raw, { ...r.job, state: "SKIPPED", finishedAt: now.toISOString(), updatedAt: now.toISOString(), error: r.job.kind === "spell" ? "The spelling check is switched off." : "Covers are switched off." });
      continue;
    }
    const job: GvaJob = { ...r.job, state: "RUNNING", leaseBy, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(), startedAt: r.job.startedAt ?? now.toISOString(), updatedAt: now.toISOString() };
    const raw = await cas(r.key, r.raw, job);
    if (raw) return { key: r.key, raw, job };
  }
  return null;
}

/** Holds the job's current row so every write is a compare-and-set on what this run last wrote. */
class JobHandle {
  constructor(public key: string, public raw: string, public job: GvaJob) {}
  async save(patch: Partial<GvaJob>): Promise<boolean> {
    const next = { ...this.job, ...patch, updatedAt: new Date().toISOString() };
    const raw = await cas(this.key, this.raw, next);
    if (!raw) return false;
    this.raw = raw;
    this.job = next;
    return true;
  }
}

async function runClaimed(c: Claimed, ctx: Ctx): Promise<string> {
  const h = new JobHandle(c.key, c.raw, c.job);
  try {
    return c.job.kind === "spell" ? await runSpell(h, ctx) : await runCover(h, ctx);
  } catch (e) {
    return handleFailure(h, ctx, e);
  }
}

const done = (h: JobHandle, ctx: Ctx, patch: Partial<GvaJob>) =>
  h.save({ ...patch, state: "DONE", leaseUntil: null, leaseBy: null, nextAttemptAt: null, finishedAt: ctx.now().toISOString(), error: null });
const ended = (h: JobHandle, ctx: Ctx, state: "SKIPPED" | "FAILED", error: string) =>
  h.save({ state, leaseUntil: null, leaseBy: null, nextAttemptAt: null, finishedAt: ctx.now().toISOString(), error });
const later = (h: JobHandle, at: Date, error: string | null, patch: Partial<GvaJob> = {}) =>
  h.save({ ...patch, state: patch.state ?? "QUEUED", leaseUntil: null, leaseBy: null, nextAttemptAt: at.toISOString(), error });

async function loadCut(id: string): Promise<CutRow | null> {
  return (await prisma.reviewSubmission.findUnique({ where: { id }, select: CUT_SELECT })) as CutRow | null;
}

/**
 * The uploaded copy: reused while Google still holds it (waited on again if it
 * is still being read), else streamed up again. The copy is written onto the
 * job BEFORE waiting for Google to finish reading it, so a tick that runs out
 * of time resumes from the same upload instead of sending the video twice.
 */
async function ensureUploaded(h: JobHandle, ctx: Ctx, url: string, fileName: string | null): Promise<GeminiFile> {
  const within = () => Math.max(15_000, Math.min(120_000, ctx.deadline - Date.now() - 100_000));
  const f = h.job.file;
  if (f && Date.now() - Date.parse(f.at) < 40 * 3600_000) {
    const state = await geminiFileState(ctx.key, f);
    if (state === "ACTIVE") return f;
    if (state === "PROCESSING") {
      await waitActive(ctx.key, f, within());
      return f;
    }
  }
  const file = await uploadVideoToGemini(ctx.key, { sourceUrl: url, fileName, displayName: `rtp-${h.job.kind}-${h.job.submissionId}`, waitForActive: false });
  await h.save({ file: { ...file, at: new Date().toISOString() } });
  await waitActive(ctx.key, file, within());
  return file;
}

/** One model request, inside the cap; refused at the cap (the job waits, nothing is sent). */
async function spendOne(h: JobHandle, ctx: Ctx): Promise<boolean> {
  if (ctx.deadline - Date.now() < 45_000) {
    await later(h, new Date(ctx.now().getTime() + 60_000), null);
    return false;
  }
  if (await reserveCall(ctx.settings.dailyCap, ctx.now())) return true;
  await later(h, nextPacificMidnight(ctx.now()), "Waiting: today's request limit is reached. It continues after midnight Pacific.");
  return false;
}

async function runSpell(h: JobHandle, ctx: Ctx): Promise<string> {
  const cut = await loadCut(h.job.submissionId);
  if (!cut) { await ended(h, ctx, "SKIPPED", "The version was removed."); return "skipped"; }
  if (versionFingerprint(cut) !== h.job.fingerprint) { await ended(h, ctx, "SKIPPED", "The file changed under this version."); return "skipped"; }
  const file = finishedFileOf({ fileName: cut.fileName, blobUrl: cut.blobUrl, assetPath: cut.assetPath, finalPath: cut.finalPath, topaz: null });
  if (!file) { await ended(h, ctx, "FAILED", "No file is attached to this version."); return "failed"; }
  const inputs = await spellingInputs(cut);
  if (!inputs.script && !inputs.names.length) {
    await done(h, ctx, { spell: { flags: [], read: 0, dropped: { unclear: 0, unknown: 0, overCap: 0, notOverlay: 0 }, nothingToCheck: true } });
    return "nothing_to_check";
  }
  const segments = await transcriptSegments(cut.id);
  const timing = segments.length ? alignScript(scriptSentences(inputs.script), segments) : [];
  const url = await sourceUrl(file, cut.id);
  const gfile = await ensureUploaded(h, ctx, url, cut.fileName);
  if (!(await spendOne(h, ctx))) return h.job.error ? "daily_cap" : "later";
  const ask = await askAboutVideo<{ texts?: OnScreenReading[] }>(ctx.key, {
    file: gfile, fps: ctx.settings.fps, schema: spellingSchema as unknown as Record<string, unknown>,
    prompt: spellingPrompt({ script: inputs.script, names: inputs.names.map((n) => n.text), timing }),
    timeoutMs: ctx.deadline - Date.now() - 10_000,
  });
  const spell = selectSpellingFlags(Array.isArray(ask.data?.texts) ? ask.data.texts : [], buildReferences(inputs));
  await deleteGeminiFile(ctx.key, gfile.name);
  await done(h, ctx, { spell, file: null, usage: ask.usage, model: GEMINI_VIDEO_MODEL, fps: ctx.settings.fps, timing: segments.length ? "deepgram" : "none" });
  return spell.flags.length ? `flagged_${spell.flags.length}` : "clean";
}

async function runCover(h: JobHandle, ctx: Ctx): Promise<string> {
  const cut = await loadCut(h.job.submissionId);
  if (!cut) { await ended(h, ctx, "SKIPPED", "The version was removed."); return "skipped"; }
  if (cut.status !== "APPROVED") { await ended(h, ctx, "SKIPPED", "The version is no longer approved."); return "skipped"; }
  if (versionFingerprint(cut) !== h.job.fingerprint) { await ended(h, ctx, "SKIPPED", "The file changed under this version."); return "skipped"; }
  // The checked Topaz file when there is one: wait for a pass that is still running (up to COVER_TOPAZ_WAIT_H).
  const tj = cut.topazJob;
  if (tj) {
    const { laneStillOwesWork } = await import("@/lib/readyToSend");
    const since = (cut.decidedAt ?? cut.createdAt).getTime();
    if (laneStillOwesWork(tj.state) && ctx.now().getTime() - since < COVER_TOPAZ_WAIT_H * 3600_000) {
      await later(h, new Date(ctx.now().getTime() + 10 * 60_000), null, { state: "WAITING", waitReason: "Waiting for the Topaz pass to finish." });
      return "waiting_topaz";
    }
  }
  const file = finishedFileOf({ fileName: cut.fileName, blobUrl: cut.blobUrl, assetPath: cut.assetPath, finalPath: cut.finalPath, topaz: tj });
  if (!file) { await ended(h, ctx, "FAILED", "No file is attached to this version."); return "failed"; }
  const url = await sourceUrl(file, cut.id);
  let picks = h.job.picks ?? null;
  if (!picks) {
    const inputs = await spellingInputs(cut).catch(() => ({ script: null, names: [] as NameInput[] }));
    const hook = hookOf(inputs.script);
    const segments = hook ? await transcriptSegments(cut.id) : [];
    const hookWindow = hook && segments.length ? alignScript([hook], segments)[0] ?? null : null;
    const gfile = await ensureUploaded(h, ctx, url, file.fileName);
    if (!(await spendOne(h, ctx))) return h.job.error ? "daily_cap" : "later";
    const ask = await askAboutVideo<{ moments?: CoverPickRaw[] }>(ctx.key, {
      file: gfile, fps: ctx.settings.fps, schema: coverSchema as unknown as Record<string, unknown>,
      prompt: coverPrompt({ hook, hookWindow: hookWindow ? { start: hookWindow.start, end: hookWindow.end } : null }),
      timeoutMs: ctx.deadline - Date.now() - 40_000,
    });
    // The real length bounds the moments (and the "close to the best" fill-ins) to the video.
    const duration = tj?.sourceDurationSec ?? (await import("@/lib/videoFrames").then((m) => m.probeDurationSec(url)).catch(() => null));
    picks = rankCoverPicks(ask.data?.moments ?? [], duration);
    await deleteGeminiFile(ctx.key, gfile.name);
    // Kept on the row: if the frame grab fails, a retry never asks Gemini again.
    await h.save({ picks, file: null, usage: ask.usage, model: GEMINI_VIDEO_MODEL, fps: ctx.settings.fps, timing: hookWindow ? "deepgram" : "none" });
  }
  if (!picks.length) { await ended(h, ctx, "FAILED", "Gemini found no moment it could use as a cover."); return "failed"; }
  const { grabCovers } = await import("@/lib/videoFrames");
  const grabbed = await grabCovers({ source: url, picks: picks.map((p) => ({ t: p.t, faceX: p.faceX, faceY: p.faceY, hasFace: p.person })) });
  const { coverStore, coverPathname } = await import("@/lib/videoCoverStore");
  const store = coverStore();
  const candidates: CoverCandidate[] = [];
  for (let n = 0; n < grabbed.covers.length; n++) {
    const g = grabbed.covers[n];
    const p = picks.find((x) => x.t === g.t) ?? picks[n];
    const ref = await store.put(await coverPathname(cut.projectId, cut.id, n, store), g.bytes);
    candidates.push({ n, t: g.t, frameT: g.frameT, score: p?.score ?? 0, why: p?.why ?? "", sharpness: g.sharpness, inGrid: p?.inGrid ?? true, ref, width: g.width, height: g.height });
  }
  await done(h, ctx, { cover: { candidates, best: 0, pick: null, source: file.kind === "dropbox" && file.source === "topaz" ? "topaz" : "editor" } });
  return `covers_${candidates.length}`;
}

async function handleFailure(h: JobHandle, ctx: Ctx, e: unknown): Promise<string> {
  const now = ctx.now();
  const err = e instanceof GeminiError
    ? e
    : new GeminiError(e instanceof Error ? e.message.slice(0, 300) : String(e), "provider_error", !/isn't installed/.test(String((e as Error)?.message ?? "")));
  if (err.kind === "rate_limited") {
    const until = await noteRateLimit(err, h.job.rateLimited + 1, now);
    await later(h, until, err.message, { rateLimited: h.job.rateLimited + 1 });
    return "rate_limited";
  }
  if (err.kind === "unauthorized") {
    // The key stopped working: mark it, so no further call is made until it is fixed on Connections.
    const { markError } = await import("@/lib/integrations/connections");
    await markError(GEMINI_CONNECTION, err.message).catch(() => {});
    await later(h, new Date(now.getTime() + 3600_000), err.message);
    return "unauthorized";
  }
  const attempts = h.job.attempts + 1;
  if (err.retryable && attempts < MAX_ATTEMPTS) {
    await later(h, new Date(now.getTime() + backoffMs(attempts)), err.message, { attempts });
    return "retry";
  }
  if (h.job.file?.name) await deleteGeminiFile(ctx.key, h.job.file.name);
  await h.save({ state: "FAILED", attempts, leaseUntil: null, leaseBy: null, nextAttemptAt: null, finishedAt: now.toISOString(), error: err.message, file: null });
  return "failed";
}

// ---- reads for the screens --------------------------------------------------------------

/** Covers made for these versions (done ones only). */
export async function coversFor(submissionIds: readonly string[]): Promise<Map<string, CoverResult>> {
  const jobs = await jobsFor("cover", submissionIds);
  const out = new Map<string, CoverResult>();
  for (const [id, j] of jobs) if (j.state === "DONE" && j.cover?.candidates.length) out.set(id, j.cover);
  return out;
}

export type StaffCoverChip = { src: string; downloadHref: string; count: number; picked: boolean };

/** The staff thumbnail and download for each version that has covers (Media library, Ready to send). */
export async function staffCoverChips(submissionIds: readonly string[]): Promise<Map<string, StaffCoverChip>> {
  const covers = await coversFor(submissionIds);
  const out = new Map<string, StaffCoverChip>();
  for (const [id, c] of covers) {
    const chosen = chosenCover(c);
    if (!chosen) continue;
    const base = `/api/video-cover/${id}`;
    out.set(id, { src: `${base}?n=${chosen.n}`, downloadHref: `${base}?n=${chosen.n}&dl=1`, count: c.candidates.length, picked: !!c.pick });
  }
  return out;
}

/** The JPEG for cover n of a version (n null = the chosen one). */
export async function coverBytes(submissionId: string, n: number | null): Promise<{ bytes: Buffer; n: number } | null> {
  const c = (await coversFor([submissionId])).get(submissionId);
  if (!c) return null;
  const cand = n == null ? chosenCover(c) : c.candidates.find((x) => x.n === n) ?? null;
  if (!cand) return null;
  const { readCover } = await import("@/lib/videoCoverStore");
  const bytes = await readCover(cand.ref);
  return bytes ? { bytes, n: cand.n } : null;
}

/** Record a pick (the client's in the portal, or staff on their behalf). Compare-and-set; only on a finished set. */
export async function pickCover(submissionId: string, n: number, by: string): Promise<{ ok: boolean; message: string }> {
  for (let i = 0; i < 5; i++) {
    const cur = await readJob("cover", submissionId);
    if (!cur || cur.job.state !== "DONE" || !cur.job.cover) return { ok: false, message: "The covers for this video aren't ready." };
    if (!cur.job.cover.candidates.some((c) => c.n === n)) return { ok: false, message: "That cover isn't one of the choices." };
    const next: GvaJob = { ...cur.job, cover: { ...cur.job.cover, pick: { n, by, at: new Date().toISOString() } }, updatedAt: new Date().toISOString() };
    if (await cas(GVA_KEY("cover", submissionId), cur.raw, next)) return { ok: true, message: "Cover chosen." };
  }
  return { ok: false, message: "Something changed while saving. Try again." };
}

export type SpellingView = {
  state: GvaJob["state"];
  flags: SpellFlag[];
  error: string | null;
  finishedAt: string | null;
  nothingToCheck: boolean;
};

export async function spellingFor(submissionId: string): Promise<SpellingView | null> {
  const r = await readJob("spell", submissionId);
  if (!r) return null;
  const j = r.job;
  return { state: j.state, flags: j.spell?.flags ?? [], error: j.error, finishedAt: j.finishedAt, nothingToCheck: !!j.spell?.nothingToCheck };
}

/** Right (a real mistake) / Wrong (a false alarm), or null to clear. Owner only: the caller checks. */
export async function recordSpellingVerdict(submissionId: string, flagId: string, verdict: SpellVerdict | null, by: string): Promise<{ ok: boolean; message: string }> {
  for (let i = 0; i < 5; i++) {
    const cur = await readJob("spell", submissionId);
    if (!cur || !cur.job.spell) return { ok: false, message: "That flag is no longer there." };
    if (!cur.job.spell.flags.some((f) => f.id === flagId)) return { ok: false, message: "That flag is no longer there." };
    const at = new Date().toISOString();
    const flags = cur.job.spell.flags.map((f) => (f.id === flagId ? { ...f, verdict, verdictBy: verdict ? by : null, verdictAt: verdict ? at : null } : f));
    const next: GvaJob = { ...cur.job, spell: { ...cur.job.spell, flags }, updatedAt: at };
    if (await cas(GVA_KEY("spell", submissionId), cur.raw, next)) return { ok: true, message: verdict ? (verdict === "RIGHT" ? "Marked right." : "Marked wrong.") : "Cleared." };
  }
  return { ok: false, message: "Something changed while saving. Try again." };
}

export type TrialView = {
  summary: TrialSummary;
  startedAt: string | null;
  endsAt: string | null;
  open: { submissionId: string; projectId: string; href: string; flagId: string; line: string }[];
  checked: number;
  reviewersOn: boolean;
};

/** Jordan's trial summary: every flag so far, how many he marked right and wrong, and the ones still to mark. */
export async function spellingTrial(): Promise<TrialView> {
  const [jobs, settings, reviewersOn] = await Promise.all([allJobs("spell"), gvaSettings(), spellingReviewersOn()]);
  const flags = jobs.flatMap((j) => (j.spell?.flags ?? []).map((f) => ({ j, f })));
  const startedAt = settings.startedAt;
  return {
    summary: trialSummary(flags.map((x) => x.f)),
    startedAt,
    endsAt: startedAt ? new Date(Date.parse(startedAt) + TRIAL_DAYS * 86_400_000).toISOString() : null,
    open: flags
      .filter((x) => !x.f.verdict)
      .sort((a, b) => (b.j.finishedAt ?? "").localeCompare(a.j.finishedAt ?? ""))
      .slice(0, 12)
      .map((x) => ({ submissionId: x.j.submissionId, projectId: x.j.projectId, href: `/review/${x.j.projectId}?cut=${x.j.submissionId}`, flagId: x.f.id, line: x.f.line })),
    checked: jobs.filter((j) => j.state === "DONE").length,
    reviewersOn,
  };
}

// ---- the Connections card ------------------------------------------------------------------

export type GeminiCardData = {
  key: Awaited<ReturnType<typeof import("@/lib/integrations/gemini").geminiKeyStatus>>;
  settings: GvaSettings;
  usage: { day: string; calls: number; cap: number; cooldownUntil: string | null; lastRunAt: string | null; lastError: string | null };
  counts: { queued: number; waiting: number; done: number; failed: number; covers: number };
  recentErrors: { kind: GvaKind; href: string; error: string }[];
  trial: TrialView;
};

export async function geminiCardData(now: Date = new Date()): Promise<GeminiCardData> {
  const { geminiKeyStatus } = await import("@/lib/integrations/gemini");
  const [key, settings, { u }, jobs, trial] = await Promise.all([geminiKeyStatus(), gvaSettings(), readUsage(now), allJobs(), spellingTrial()]);
  const count = (s: GvaJob["state"]) => jobs.filter((j) => j.state === s).length;
  return {
    key,
    settings,
    usage: { day: u.day, calls: u.calls, cap: settings.dailyCap, cooldownUntil: u.cooldownUntil && Date.parse(u.cooldownUntil) > now.getTime() ? u.cooldownUntil : null, lastRunAt: u.lastRunAt, lastError: u.lastError },
    counts: { queued: count("QUEUED") + count("RUNNING"), waiting: count("WAITING"), done: count("DONE"), failed: count("FAILED"), covers: jobs.filter((j) => j.kind === "cover" && j.state === "DONE").length },
    recentErrors: jobs
      .filter((j) => j.state === "FAILED" && j.error)
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
      .slice(0, 3)
      .map((j) => ({ kind: j.kind, href: `/review/${j.projectId}?cut=${j.submissionId}`, error: j.error! })),
    trial,
  };
}

// ---- the client's portal ------------------------------------------------------------------------

export type KitCovers = {
  options: { n: number; src: string; downloadHref: string }[];
  /** the cover shown as chosen: theirs, else ours */
  selected: number;
  /** our pre-selected best */
  best: number;
  pickedByClient: boolean;
  canPick: boolean;
};

/**
 * The covers offered in a video's Posting Kit: only for the file the client is
 * handed (the entitlement's cut), each through the portal's own cover door with
 * a media token over the VIDEO id (the download door's machinery).
 */
export async function kitCoversFor(
  viewer: import("@/lib/portal").PortalViewer,
  videoId: string,
  e: { file: { kind: string; submissionId: string | null } | null },
): Promise<KitCovers | null> {
  if (!e.file || e.file.kind !== "cut" || !e.file.submissionId) return null;
  const c = (await coversFor([e.file.submissionId])).get(e.file.submissionId);
  if (!c) return null;
  const { mediaToken, mediaScopeOf } = await import("@/lib/portalMedia");
  const { can } = await import("@/lib/portalAccess");
  const base = `/api/portal/cover/${videoId}?m=${encodeURIComponent(mediaToken(videoId, mediaScopeOf(viewer)))}`;
  const chosen = chosenCover(c)!;
  return {
    options: c.candidates.map((x) => ({ n: x.n, src: `${base}&n=${x.n}`, downloadHref: `${base}&n=${x.n}&dl=1` })),
    selected: chosen.n,
    best: c.best,
    pickedByClient: !!c.pick,
    canPick: can(viewer, "suggest"),
  };
}

/** The client picks another cover for one of their videos (ownership and the entitled file proven here). */
export async function pickCoverForViewer(viewer: import("@/lib/portal").PortalViewer, videoId: string, n: number): Promise<{ ok: boolean; message: string }> {
  if (!Number.isInteger(n) || n < 0 || n > 5) return { ok: false, message: "That cover isn't one of the choices." };
  const { videoForEnrollment } = await import("@/lib/contentVideos");
  const v = await videoForEnrollment(viewer.enrollment, videoId);
  if (!v) return { ok: false, message: "That video isn't on your page." };
  const { videoEntitlement } = await import("@/lib/cutEntitlement");
  const e = await videoEntitlement(v);
  if (!e.file || e.file.kind !== "cut" || !e.file.submissionId) return { ok: false, message: "The covers open with the download." };
  const a = viewer.actor;
  const by = a.kind === "CLIENT" ? `client:${a.clientUserId}` : a.kind === "STAFF" ? `staff:${a.staffUserId}` : "link";
  return pickCover(e.file.submissionId, n, by);
}
