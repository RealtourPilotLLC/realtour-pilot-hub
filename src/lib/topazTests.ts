import "server-only";

import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { clampTopazSettings, saveTopazSettings, topazSettings, type TopazProteusParams, type TopazSettings } from "@/lib/settings";
import { blobFetchDecision, probeableUrl } from "@/lib/reviewCuts";
import {
  TopazError,
  TOPAZ_AWAITING_UPLOAD,
  TOPAZ_DEAD,
  TOPAZ_DONE,
  acceptVideoRequest,
  cancelEstimate,
  cancelVideoRequest,
  completeUpload,
  createVideoRequest,
  localCreditEstimate,
  probeVideoMetadata,
  putUploadPart,
  topazConnected,
  videoStatus,
  type TopazUploadResult,
  type TopazUploadTarget,
} from "@/lib/integrations/topaz";
import { TOPAZ_TEST_KEY, reserveTestSlot, spendGate, topazRequestFor } from "@/lib/topazJobs";
import { WHOLE_VIDEO_NOTE } from "@/lib/topazOriginal";

// ===========================================================================
// "TRY THESE SETTINGS" — a test render from Settings (Jordan, Oct 22 2026).
//
// "I just want to prevent it going forward and have more control over the
// settings." Control means being able to SEE what a setting does before every
// client video gets it. So: pick one of the last ~20 approved videos, run it
// through Topaz with the sliders that are on the screen (saved or not), and
// put the two side by side.
//
// WHAT A TEST NEVER DOES, by construction rather than by care: it files
// nothing. This module has no Dropbox import, no portal or library call, no
// Aryeo call, no SmartTask, no TopazJob write and no ReviewSubmission write —
// the drill (scripts/_drill/oct22-topaz-controls.ts) fences every one of them
// and proves a test end to end touches none. The finished file stays at Topaz
// (they keep output 7 days) and is streamed from there to the compare page;
// it is never purged early (no deleteVideoFiles here).
//
// WHAT IT COSTS, and who decides: it is money, so OWNER only (the actions
// guard it), and it goes through the SAME spend guards as a real render —
// the free estimate first, nothing spent until "Run the test (about N
// credits)" is pressed, the per-video ceiling, the day / month / credit caps
// and the concurrency cap, all counting tests and jobs together
// (topazJobs.topazTestLedger), and the slot reserved behind the same budget
// lock (reserveTestSlot). Each test keeps its exact settings and the exact
// request it sent.
//
// WHY AN AppSetting ROW AND NOT A TopazJob. One render per cut is a unique
// constraint on TopazJob.submissionId, and the cut a test uses already has
// its job. A test is its own small record under TOPAZ_TEST_KEY, written with
// compare-and-set on its whole value, leased like a job while a step runs.
// No schema change.
//
// TRIMMING. Topaz's create-request schema has no trim/start/end field and the
// Proteus filter takes no frame range (developer.topazlabs.com, checked Oct 22
// 2026), so "first 15 seconds" is not on offer: the whole video is rendered,
// and the screen says so (WHOLE_VIDEO_NOTE).
// ===========================================================================

export type TopazTestState = "estimated" | "uploading" | "processing" | "done" | "failed" | "cancelled";

/** The settings a test can vary — the preset and how the file is made. The
 *  spend limits are always the SAVED ones: a draft on screen cannot raise its
 *  own ceiling. */
export type TopazTestSettings = Pick<
  TopazSettings,
  "params" | "outputShortSide" | "neverUpscale" | "audioCodec" | "audioTransfer" | "container" | "videoEncoder" | "videoProfile" | "videoBitrate" | "dynamicCompressionLevel"
>;

type SourceFacts = { width: number; height: number; durationSec: number; frameRate: number; frameCount: number; container: string; codec: string; sizeBytes: number; audioCodec: string | null; hasAudio: boolean };
type OutputFacts = { width: number; height: number; durationSec: number; sizeBytes: number; codec: string; audioCodec: string | null; hasAudio: boolean } | null;

/** The stored record. Server-only: it carries Topaz's presigned upload URLs. */
type TopazTestRun = {
  id: string;
  submissionId: string;
  projectId: string;
  label: string;
  fileName: string | null;
  state: TopazTestState;
  createdAt: string;
  createdBy: string | null;
  settings: TopazTestSettings;
  /** The exact filters + output block sent (the same shape as TopazJob.presetJson). */
  presetJson: string;
  source: SourceFacts;
  requestId: string | null;
  estimateCredits: number | null;
  estimateLow: number | null;
  estimateSeconds: number | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  uploadTargets: TopazUploadTarget[] | null;
  uploadParts: TopazUploadResult[];
  completeUploadAt: string | null;
  completeUploadTries: number;
  creditsCharged: number | null;
  output: OutputFacts;
  finishedAt: string | null;
  expiresAt: string | null;
  error: string | null;
  note: string | null;
  attempt: number;
  leaseUntil: string | null;
  leaseBy: string | null;
};

const LEASE_MS = 12 * 60_000;
const STALL_MS = 4 * 3600_000;
const COMPLETE_UPLOAD_GRACE_MS = 5 * 60_000;
/** Topaz keeps a finished file for 7 days. */
const TOPAZ_KEEPS_MS = 7 * 86_400_000;
const MAX_TRIES = 3;

const keyOf = (id: string) => `${TOPAZ_TEST_KEY}${id}`;
const ID_RE = /^[a-f0-9]{16}$/;
const streetOf = (title?: string | null) => (title || "this job").split(",")[0].trim();

function parse(raw: string): TopazTestRun | null {
  try {
    const t = JSON.parse(raw) as TopazTestRun;
    return t && typeof t.id === "string" && typeof t.state === "string" ? t : null;
  } catch {
    return null;
  }
}

async function read(id: string): Promise<{ raw: string; t: TopazTestRun } | null> {
  if (!ID_RE.test(id)) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: keyOf(id) }, select: { value: true } });
  const t = row ? parse(row.value) : null;
  return row && t ? { raw: row.value, t } : null;
}

/** Compare-and-set on the row's whole value. Returns the new raw value, or
 *  null when somebody else wrote first (the write did not happen). */
async function write(prevRaw: string, next: TopazTestRun, by = "topaz-test"): Promise<string | null> {
  const raw = JSON.stringify(next);
  const r = await prisma.appSetting.updateMany({ where: { key: keyOf(next.id), value: prevRaw }, data: { value: raw, updatedBy: by } });
  return r.count === 1 ? raw : null;
}

/** Only the knobs a test may vary, taken off a draft and clamped like a save. */
export function testSettingsFrom(draft: Partial<TopazSettings> | null | undefined, saved: TopazSettings): TopazTestSettings {
  const d = draft ?? {};
  const c = clampTopazSettings({
    ...saved,
    params: { ...saved.params, ...(d.params ?? {}) } as TopazProteusParams,
    ...(d.outputShortSide !== undefined ? { outputShortSide: d.outputShortSide } : {}),
    ...(d.neverUpscale !== undefined ? { neverUpscale: d.neverUpscale } : {}),
    ...(d.audioCodec !== undefined ? { audioCodec: d.audioCodec } : {}),
    ...(d.audioTransfer !== undefined ? { audioTransfer: d.audioTransfer } : {}),
    ...(d.container !== undefined ? { container: d.container } : {}),
    ...(d.videoEncoder !== undefined ? { videoEncoder: d.videoEncoder } : {}),
    ...(d.videoProfile !== undefined ? { videoProfile: d.videoProfile } : {}),
    ...(d.videoBitrate !== undefined ? { videoBitrate: d.videoBitrate } : {}),
    ...(d.dynamicCompressionLevel !== undefined ? { dynamicCompressionLevel: d.dynamicCompressionLevel } : {}),
  });
  return {
    params: c.params,
    outputShortSide: c.outputShortSide,
    neverUpscale: c.neverUpscale,
    audioCodec: c.audioCodec,
    audioTransfer: c.audioTransfer,
    container: c.container,
    videoEncoder: c.videoEncoder,
    videoProfile: c.videoProfile,
    videoBitrate: c.videoBitrate,
    dynamicCompressionLevel: c.dynamicCompressionLevel,
  };
}

// ---------------------------------------------------------------------------
// WHAT THE PAGE READS
// ---------------------------------------------------------------------------

export type TestableCut = { submissionId: string; label: string; approvedAtISO: string; fileName: string | null };

/** The last approved videos whose bytes the hub still holds (a test has to
 *  upload them). Newest first. */
export async function recentCutsForTest(limit = 20): Promise<TestableCut[]> {
  const rows = await prisma.reviewSubmission.findMany({
    where: { status: "APPROVED", kind: "video", blobUrl: { not: null } },
    orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
    take: Math.min(50, Math.max(1, limit)),
    select: { id: true, round: true, fileName: true, decidedAt: true, createdAt: true, deliverable: { select: { label: true } }, project: { select: { title: true } } },
  });
  return rows.map((r) => ({
    submissionId: r.id,
    label: `${streetOf(r.project?.title)} · ${r.deliverable?.label ?? "Video"} · v${r.round}`,
    approvedAtISO: (r.decidedAt ?? r.createdAt).toISOString(),
    fileName: r.fileName,
  }));
}

export type TopazTestView = {
  id: string;
  submissionId: string;
  label: string;
  fileName: string | null;
  state: TopazTestState;
  says: string;
  createdAtISO: string;
  createdBy: string | null;
  settings: TopazTestSettings;
  /** The exact request sent (filters + output), pretty enough to read. */
  presetJson: string;
  source: SourceFacts & { mbit: number | null };
  output: (NonNullable<OutputFacts> & { mbit: number | null }) | null;
  estimateCredits: number | null;
  estimateLow: number | null;
  estimateSeconds: number | null;
  creditsCharged: number | null;
  finishedAtISO: string | null;
  expiresAtISO: string | null;
  expired: boolean;
  wholeVideoNote: string;
  error: string | null;
};

const mbitOf = (bytes: number, sec: number) => (sec > 0 && bytes > 0 ? Math.round(((bytes * 8) / sec / 1_000_000) * 10) / 10 : null);

function saysOf(t: TopazTestRun, now = Date.now()): string {
  switch (t.state) {
    case "estimated":
      return t.estimateCredits != null ? `Priced, not run: about ${Math.round(t.estimateCredits)} credits. Nothing is spent until you run it.` : "Priced, not run.";
    case "uploading":
      return "Sending the video to Topaz.";
    case "processing":
      return t.estimateSeconds ? `Topaz is working on it (about ${Math.max(1, Math.round(t.estimateSeconds / 60))} minutes).` : "Topaz is working on it.";
    case "done":
      return t.expiresAt && Date.parse(t.expiresAt) < now ? "Finished. Topaz has deleted its copy (it keeps finished files 7 days)." : "Finished. Compare it with the original.";
    case "failed":
      return t.error ?? "It didn't finish.";
    case "cancelled":
      return t.note ?? "Not run.";
    default:
      return t.state;
  }
}

function toView(t: TopazTestRun): TopazTestView {
  const now = Date.now();
  return {
    id: t.id,
    submissionId: t.submissionId,
    label: t.label,
    fileName: t.fileName,
    state: t.state,
    says: saysOf(t, now),
    createdAtISO: t.createdAt,
    createdBy: t.createdBy,
    settings: t.settings,
    presetJson: t.presetJson,
    source: { ...t.source, mbit: mbitOf(t.source.sizeBytes, t.source.durationSec) },
    output: t.output ? { ...t.output, mbit: mbitOf(t.output.sizeBytes, t.output.durationSec) } : null,
    estimateCredits: t.estimateCredits,
    estimateLow: t.estimateLow,
    estimateSeconds: t.estimateSeconds,
    creditsCharged: t.creditsCharged,
    finishedAtISO: t.finishedAt,
    expiresAtISO: t.expiresAt,
    expired: !!t.expiresAt && Date.parse(t.expiresAt) < now,
    wholeVideoNote: WHOLE_VIDEO_NOTE,
    error: t.error,
  };
}

/** Recent tests, newest first. */
export async function topazTestRows(limit = 12): Promise<TopazTestView[]> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: TOPAZ_TEST_KEY } },
    orderBy: { updatedAt: "desc" },
    take: 60,
    select: { value: true },
  });
  return rows
    .map((r) => parse(r.value))
    .filter((t): t is TopazTestRun => !!t)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map(toView);
}

/** One test, plus — when it finished and Topaz still has the file — a fresh
 *  link to stream it from (a free status read). Owner pages only. */
export async function topazTestFor(id: string): Promise<{ view: TopazTestView; topazUrl: string | null; originalUrl: string } | null> {
  const got = await read(id);
  if (!got) return null;
  const view = toView(got.t);
  let topazUrl: string | null = null;
  if (got.t.state === "done" && got.t.requestId && !view.expired) {
    topazUrl = await videoStatus(got.t.requestId).then((st) => st.downloadUrl).catch(() => null);
  }
  return { view, topazUrl, originalUrl: `/api/review/cut/${got.t.submissionId}/stream` };
}

// ---------------------------------------------------------------------------
// 1. THE FREE PRICE CHECK
// ---------------------------------------------------------------------------

export async function estimateTopazTest(
  submissionId: string,
  draft: Partial<TopazSettings> | null,
  by: string | null,
): Promise<{ ok: boolean; message: string; test?: TopazTestView }> {
  if (!(await topazConnected())) return { ok: false, message: "Topaz isn't connected. Paste the API key on the Connections page first." };
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, status: true, kind: true, blobUrl: true, sizeBytes: true, fileName: true, round: true, deliverable: { select: { label: true } }, project: { select: { title: true } } },
  });
  if (!sub || sub.status !== "APPROVED" || sub.kind !== "video") return { ok: false, message: "Pick an approved video." };
  if (!sub.blobUrl) return { ok: false, message: "The hub no longer holds this video's file, so it can't be sent to Topaz. Pick a more recent one." };
  const saved = await topazSettings();
  const settings = testSettingsFrom(draft, saved);
  const s: TopazSettings = { ...saved, ...settings };

  const readable = await probeableUrl(sub.blobUrl);
  if (!readable) return { ok: false, message: "The hub can't read this video out of its own store. Pick another." };
  let meta: Awaited<ReturnType<typeof probeVideoMetadata>>;
  try {
    meta = await probeVideoMetadata(readable, sub.sizeBytes ?? null);
  } catch {
    return { ok: false, message: "Couldn't read this video's header just now. Try again, or pick another." };
  }
  const mb = Math.round(meta.sizeBytes / 1048576);
  if (mb > saved.maxSourceMB) return { ok: false, message: `This video is ${mb} MB and Topaz won't take anything over ${saved.maxSourceMB} MB. Pick a smaller one.` };

  const request = topazRequestFor(meta, s);
  let est: Awaited<ReturnType<typeof createVideoRequest>>;
  try {
    est = await createVideoRequest(request.body);
  } catch (e) {
    return { ok: false, message: `Topaz didn't give a price just now (${(e as Error).message.slice(0, 160)}). Nothing was spent.` };
  }
  if (est.credits === null) {
    await cancelEstimate(est.requestId);
    return { ok: false, message: "Topaz didn't say what this would cost, so it can't run. Nothing was spent." };
  }
  const local = localCreditEstimate(request.output.resolution, meta.durationSec, meta);
  const credits = Math.max(est.credits, local);
  // Topaz bills the LOW end of its range (their create-request reference).
  const low = (() => {
    const cost = (est.raw as { estimates?: { cost?: unknown } } | null)?.estimates?.cost;
    const nums = Array.isArray(cost) ? cost.map(Number).filter(Number.isFinite) : [];
    return nums.length ? Math.min(...nums) : null;
  })();

  // An older price check that was never run is handed back (free) and closed,
  // so the list shows the one that matters.
  const stale = await prisma.appSetting.findMany({ where: { key: { startsWith: TOPAZ_TEST_KEY } }, select: { value: true } });
  for (const row of stale) {
    const t = parse(row.value);
    if (!t || t.state !== "estimated" || t.acceptedAt) continue;
    const closed = await write(row.value, { ...t, state: "cancelled", note: "Replaced by a newer price check. Nothing was spent.", leaseUntil: null, leaseBy: null });
    if (closed && t.requestId) await cancelEstimate(t.requestId).catch(() => false);
  }

  const now = new Date();
  const id = randomBytes(8).toString("hex");
  const run: TopazTestRun = {
    id,
    submissionId: sub.id,
    projectId: sub.projectId,
    label: `${streetOf(sub.project?.title)} · ${sub.deliverable?.label ?? "Video"} · v${sub.round}`,
    fileName: sub.fileName,
    state: "estimated",
    createdAt: now.toISOString(),
    createdBy: by,
    settings,
    presetJson: request.presetJson,
    source: {
      width: meta.width,
      height: meta.height,
      durationSec: meta.durationSec,
      frameRate: meta.frameRate,
      frameCount: meta.frameCount,
      container: meta.container,
      codec: meta.codec,
      sizeBytes: meta.sizeBytes,
      audioCodec: meta.audio.codec,
      hasAudio: meta.audio.present,
    },
    requestId: est.requestId,
    estimateCredits: credits,
    estimateLow: low,
    estimateSeconds: est.seconds,
    acceptedAt: null,
    acceptedBy: null,
    uploadTargets: null,
    uploadParts: [],
    completeUploadAt: null,
    completeUploadTries: 0,
    creditsCharged: null,
    output: null,
    finishedAt: null,
    expiresAt: null,
    error: null,
    note: meta.audio.present && meta.audio.codec !== "mp4a" ? "This video's sound is not AAC, and Topaz drops sound it can't copy, so the test version may be silent. Compare the picture." : null,
    attempt: 0,
    leaseUntil: null,
    leaseBy: null,
  };
  await prisma.appSetting.create({ data: { key: keyOf(id), value: JSON.stringify(run), updatedBy: by } });
  const over = credits > saved.maxCreditsPerVideo;
  return {
    ok: true,
    message: over
      ? `Topaz prices this at about ${Math.round(credits)} credits, over your limit of ${saved.maxCreditsPerVideo} per video, so it can't run unless you raise that limit. Nothing was spent.`
      : `Topaz prices this at about ${Math.round(credits)} credits. Nothing is spent until you run it.`,
    test: toView(run),
  };
}

// ---------------------------------------------------------------------------
// 2. THE PRESS THAT SPENDS
// ---------------------------------------------------------------------------

export async function runTopazTest(id: string, by: string | null): Promise<{ ok: boolean; message: string; test?: TopazTestView }> {
  const got = await read(id);
  if (!got) return { ok: false, message: "That test no longer exists." };
  const t = got.t;
  if (t.state !== "estimated") return { ok: false, message: t.state === "cancelled" ? "That price check was replaced. Check the price again." : "That test has already run." };
  if (!t.requestId || t.estimateCredits == null) return { ok: false, message: "That test has no price. Check the price again." };
  if (Date.now() - Date.parse(t.createdAt) > 6 * 3600_000) {
    return { ok: false, message: "That price check is more than six hours old. Check the price again so the number is current." };
  }
  if (!(await topazConnected())) return { ok: false, message: "Topaz isn't connected." };
  const s = await topazSettings();
  // The same gate a live render goes through: the per-video ceiling, the
  // caps (jobs and tests together), the concurrency, the live balance.
  const gate = await spendGate(s, { estimateCredits: t.estimateCredits });
  if (!gate.ok) return { ok: false, message: `Not now: ${gate.reason}` };
  const acceptedAt = new Date().toISOString();
  let reserved = false;
  try {
    reserved = await reserveTestSlot(keyOf(id), s, t.estimateCredits, (cur) => {
      const now = parse(cur);
      if (!now || now.state !== "estimated" || now.acceptedAt) return null;
      return JSON.stringify({ ...now, acceptedAt, acceptedBy: by });
    });
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!reserved) {
    const again = await spendGate(s, { estimateCredits: t.estimateCredits });
    return { ok: false, message: again.ok ? "Someone pressed this at the same moment, or the last slot just went. Refresh and look again. Nothing was spent." : `Not now: ${again.reason}` };
  }
  const after = await read(id);
  if (!after) return { ok: false, message: "That test no longer exists." };
  let targets: TopazUploadTarget[];
  try {
    // Accepting starts nothing and charges nothing (complete-upload does).
    targets = await acceptVideoRequest(t.requestId);
  } catch (e) {
    // Topaz refused the accept: nothing spent, so the slot goes straight back.
    await write(after.raw, { ...after.t, acceptedAt: null, acceptedBy: null, error: `Topaz wouldn't start it (${(e as Error).message.slice(0, 160)}). Nothing was spent.` });
    return { ok: false, message: `Topaz wouldn't start it (${(e as Error).message.slice(0, 160)}). Nothing was spent.` };
  }
  const next: TopazTestRun = { ...after.t, state: "uploading", uploadTargets: targets, error: null };
  const wrote = await write(after.raw, next);
  if (!wrote) return { ok: false, message: "That test changed while it was starting. Refresh and look again." };
  return {
    ok: true,
    message: `Started. The video goes to Topaz in the next minute or two and renders in about ${Math.max(1, Math.round((t.estimateSeconds ?? 1200) / 60))} minutes. This page fills in when it's done.`,
    test: toView(next),
  };
}

/**
 * ONE CALL, FROM A SCRIPT (Jordan, Oct 22 2026: "I want to set it and forget
 * it … I'll choose the house setting with one or two test renders after
 * merging"). The free price check and the paid run in a single call, for a
 * submission id and a set of settings, with no UI:
 *
 *   // scripts/topaz-try.ts, run with:
 *   //   NODE_OPTIONS=--conditions=react-server npx tsx scripts/topaz-try.ts
 *   import { startTopazTest } from "@/lib/topazTests";
 *   import { topazStartingPoint } from "@/lib/topazPresets";
 *   import { DEFAULT_TOPAZ_PARAMS as d } from "@/lib/settings";
 *   (async () => console.log(await startTopazTest("<submissionId>",
 *     { params: { ...d, ...topazStartingPoint("gentle", d) } }, "Jordan", { maxCredits: 12 })))();
 *
 * `settings` is a partial draft, clamped exactly as a Settings-page draft is;
 * the spend limits are always the SAVED ones. `maxCredits` (optional) refuses
 * to run when the price check comes back dearer — the estimate is free and is
 * handed back. Every guard a live render goes through still applies. The run
 * then proceeds on the 1080p lane's cron (every minute); `topazTestFor(id)`
 * reads where it is, and the compare page is /settings/topaz-test/<id>.
 * Nothing is ever filed to Dropbox, Aryeo or a portal. The owner-only server
 * action is app/settings/topazTestActions.startTopazTestAction.
 */
export async function startTopazTest(
  submissionId: string,
  settings: Partial<TopazSettings> | null,
  by: string | null,
  opts: { maxCredits?: number } = {},
): Promise<{ ok: boolean; message: string; test?: TopazTestView; compareHref?: string }> {
  const est = await estimateTopazTest(submissionId, settings, by);
  if (!est.ok || !est.test) return est;
  const credits = est.test.estimateCredits ?? Infinity;
  if (typeof opts.maxCredits === "number" && credits > opts.maxCredits) {
    const got = await read(est.test.id);
    if (got) {
      const closed = await write(got.raw, { ...got.t, state: "cancelled", note: `Priced at about ${Math.round(credits)} credits, over the ${opts.maxCredits} this call allowed, so it was not run. Nothing was spent.` });
      if (closed && got.t.requestId) await cancelEstimate(got.t.requestId).catch(() => false);
    }
    return { ok: false, message: `Topaz priced this at about ${Math.round(credits)} credits, over the ${opts.maxCredits} allowed, so it was not run. Nothing was spent.`, test: est.test };
  }
  const run = await runTopazTest(est.test.id, by);
  return run.ok ? { ...run, compareHref: `/settings/topaz-test/${est.test.id}` } : { ...run, test: run.test ?? est.test };
}

/** Use a test's exact settings for every video from now on. */
export async function applyTopazTestSettings(id: string, by: string | null): Promise<{ ok: boolean; message: string; settings?: TopazSettings }> {
  const got = await read(id);
  if (!got) return { ok: false, message: "That test no longer exists." };
  const saved = await saveTopazSettings({ ...got.t.settings }, by);
  return { ok: true, message: "Saved. Every video that goes through Topaz from now on uses these settings.", settings: saved };
}

// ---------------------------------------------------------------------------
// 3. THE DRIVER — one step per tick, from the 1080p lane's own cron.
// ---------------------------------------------------------------------------

export async function driveTopazTests(opts: { budget: { remainingMs: () => number }; leaseBy: string; max?: number }): Promise<Record<string, number>> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: TOPAZ_TEST_KEY } },
    orderBy: { updatedAt: "asc" },
    take: 60,
    select: { value: true },
  });
  const due = rows.map((r) => ({ raw: r.value, t: parse(r.value) })).filter((r): r is { raw: string; t: TopazTestRun } =>
    !!r.t && (r.t.state === "uploading" || r.t.state === "processing") && (!r.t.leaseUntil || Date.parse(r.t.leaseUntil) < Date.now()),
  );
  const out: Record<string, number> = {};
  for (const r of due.slice(0, opts.max ?? 2)) {
    if (opts.budget.remainingMs() < 45_000) break;
    const claimed: TopazTestRun = { ...r.t, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), leaseBy: opts.leaseBy.slice(0, 60) };
    const raw = await write(r.raw, claimed);
    if (!raw) continue; // another tick has it
    let state: string;
    try {
      state = await advance(raw, claimed, opts.budget);
    } catch (e) {
      state = await bounded(claimed, e);
    }
    out[state] = (out[state] ?? 0) + 1;
  }
  return out;
}

/** A step threw: retry a few times, then stop and say why. Never spins. */
async function bounded(t: TopazTestRun, e: unknown): Promise<string> {
  const err = e instanceof TopazError ? e : new TopazError((e as Error)?.message ?? "unknown", 0, true);
  const attempt = t.attempt + 1;
  const done = !err.retryable || attempt >= MAX_TRIES;
  const cur = await read(t.id);
  if (!cur) return "gone";
  await write(cur.raw, {
    ...cur.t,
    attempt,
    leaseUntil: done ? null : new Date(Date.now() + Math.min(10, 2 ** attempt) * 60_000).toISOString(),
    leaseBy: done ? null : "backoff",
    ...(done ? { state: "failed" as const, error: `It didn't finish: ${err.message.slice(0, 240)}`, finishedAt: new Date().toISOString() } : { error: err.message.slice(0, 240) }),
  });
  return done ? "failed" : t.state;
}

async function advance(raw: string, t: TopazTestRun, budget: { remainingMs: () => number }): Promise<string> {
  if (t.state === "uploading") return await stepUpload(raw, t, budget);
  if (t.state === "processing") return await stepPoll(raw, t);
  return t.state;
}

const released = (t: TopazTestRun): TopazTestRun => ({ ...t, leaseUntil: null, leaseBy: null });

async function stepUpload(raw: string, t: TopazTestRun, budget: { remainingMs: () => number }): Promise<string> {
  const targets = t.uploadTargets ?? [];
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: t.submissionId }, select: { blobUrl: true } });
  if (!sub?.blobUrl || !targets.length || !t.requestId) {
    await write(raw, { ...released(t), state: "failed", error: "The hub no longer holds this video's file, so the test couldn't be sent. Nothing was charged.", finishedAt: new Date().toISOString() });
    return "failed";
  }
  const total = t.source.sizeBytes;
  const chunk = Math.ceil(total / targets.length);
  const parts = [...t.uploadParts];
  const have = new Set(parts.map((p) => p.partNum));
  let cur = { raw, t };
  for (const target of targets) {
    if (have.has(target.partNum)) continue;
    if (budget.remainingMs() < 90_000) {
      await write(cur.raw, released(cur.t));
      return "uploading";
    }
    const start = (target.partNum - 1) * chunk;
    const end = Math.min(total, start + chunk) - 1;
    const decision = blobFetchDecision(sub.blobUrl);
    if (!decision.ok) throw new TopazError("The hub can't read this video out of its own store.", 0, false);
    const res = await fetch(sub.blobUrl, {
      headers: { ...(targets.length > 1 ? { Range: `bytes=${start}-${end}` } : {}), ...(decision.authorization ? { authorization: decision.authorization } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) throw new TopazError(`Couldn't read the video out of the hub's store (${res.status}).`, res.status, res.status >= 500);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const part = await putUploadPart(target, bytes, t.source.container === "mov" ? "video/quicktime" : "video/mp4");
    parts.push(part);
    have.add(part.partNum);
    const next: TopazTestRun = { ...cur.t, uploadParts: [...parts], leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() };
    const w = await write(cur.raw, next);
    if (!w) return "uploading"; // lost the row; the holder carries on
    cur = { raw: w, t: next };
  }
  // ==== THE ONE CALL THAT SPENDS: claimed first, never made twice ==========
  if (cur.t.completeUploadTries >= MAX_TRIES) {
    await write(cur.raw, { ...released(cur.t), state: "failed", error: `Topaz was asked ${cur.t.completeUploadTries} times to start this test and never did.`, finishedAt: new Date().toISOString() });
    return "failed";
  }
  if (!cur.t.completeUploadAt) {
    const claim: TopazTestRun = { ...cur.t, completeUploadAt: new Date().toISOString(), completeUploadTries: cur.t.completeUploadTries + 1 };
    const w = await write(cur.raw, claim);
    if (!w) return "uploading";
    cur = { raw: w, t: claim };
    try {
      await completeUpload(t.requestId, parts);
    } catch (e) {
      // Not cleared on a failure: the call may have landed. Topaz's status
      // decides, in the polling step.
      await write(cur.raw, { ...released(cur.t), state: "processing", error: `Asked Topaz to start and didn't get a clear answer (${(e as Error).message.slice(0, 120)}). Checking with them.` });
      return "processing";
    }
  }
  await write(cur.raw, { ...released(cur.t), state: "processing", error: null });
  return "processing";
}

async function stepPoll(raw: string, t: TopazTestRun): Promise<string> {
  if (!t.requestId) {
    await write(raw, { ...released(t), state: "failed", error: "Lost track of this test at Topaz.", finishedAt: new Date().toISOString() });
    return "failed";
  }
  const st = await videoStatus(t.requestId);
  if (TOPAZ_DONE.has(st.status) && st.downloadUrl) {
    // What came back, read off its own header (free; a few range reads).
    const out = await Promise.race([
      probeVideoMetadata(st.downloadUrl).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 25_000)),
    ]);
    const finished = new Date();
    await write(raw, {
      ...released(t),
      state: "done",
      uploadTargets: null, // the presigned URLs are spent; nothing needs them now
      creditsCharged: st.credits ?? t.estimateLow ?? t.estimateCredits,
      output: out
        ? { width: out.width, height: out.height, durationSec: out.durationSec, sizeBytes: out.sizeBytes, codec: out.codec, audioCodec: out.audio.codec, hasAudio: out.audio.present }
        : null,
      finishedAt: finished.toISOString(),
      expiresAt: new Date(finished.getTime() + TOPAZ_KEEPS_MS).toISOString(),
      attempt: 0,
      error: null,
    });
    return "done";
  }
  if (TOPAZ_DEAD.has(st.status)) {
    await write(raw, { ...released(t), state: "failed", error: `Topaz couldn't finish the test${st.message ? `: ${st.message}` : "."}`, finishedAt: new Date().toISOString() });
    return "failed";
  }
  const since = Date.parse(t.acceptedAt ?? t.createdAt);
  if (Date.now() - since > STALL_MS) {
    await cancelVideoRequest(t.requestId);
    await write(raw, { ...released(t), state: "failed", error: "Topaz had this test for over 4 hours without finishing it, so it was cancelled.", finishedAt: new Date().toISOString() });
    return "failed";
  }
  if (TOPAZ_AWAITING_UPLOAD.has(st.status)) {
    // The start never landed. Inside the grace window Topaz may still be
    // describing the request as it was; past it, believe it — a bounded
    // number of times (completeUploadTries).
    if (t.completeUploadAt && Date.now() - Date.parse(t.completeUploadAt) < COMPLETE_UPLOAD_GRACE_MS) {
      await write(raw, { ...released(t), leaseUntil: new Date(Date.now() + 60_000).toISOString(), leaseBy: "wait" });
      return "processing";
    }
    if (t.completeUploadTries >= MAX_TRIES) {
      await write(raw, { ...released(t), state: "failed", error: "Topaz never started this test even though the file was sent. Nothing was charged.", finishedAt: new Date().toISOString() });
      return "failed";
    }
    await write(raw, { ...released(t), state: "uploading", completeUploadAt: null });
    return "uploading";
  }
  // Still working: ask again in a minute.
  await write(raw, { ...released(t), leaseUntil: new Date(Date.now() + 60_000).toISOString(), leaseBy: "wait", error: null });
  return "processing";
}
