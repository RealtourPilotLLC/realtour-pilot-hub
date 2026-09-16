import "server-only";

import { prisma } from "@/lib/prisma";
import { dbx, DropboxError } from "@/lib/integrations/dropbox";
import { actualFolderPaths } from "@/lib/dropboxFolders";
import { videoStyleFor } from "@/lib/videoStyles";
import { aryeoJobUrl } from "@/lib/aryeoUrl";
import { appBase } from "@/lib/appUrl";
import { etDayKey, etAt } from "@/lib/datetime";
import { topazSettings, type TopazSettings } from "@/lib/settings";
import {
  ARYEO_MANUAL_NOTE,
  TopazError,
  TOPAZ_AWAITING_UPLOAD,
  TOPAZ_DEAD,
  TOPAZ_DONE,
  acceptVideoRequest,
  cancelEstimate,
  cancelVideoRequest,
  completeUpload,
  createVideoRequest,
  deleteVideoFiles,
  localCreditEstimate,
  plannedOutput,
  probeVideoMetadata,
  putUploadPart,
  topazBalance,
  topazConnected,
  videoStatus,
  type TopazFilter,
  type TopazUploadResult,
  type TopazUploadTarget,
} from "@/lib/integrations/topaz";

// ===========================================================================
// THE 1080p PASS — a durable job, driven a step at a time.
//
// Jordan (Sep 16): "Once the video cut is approved, it runs through the Topaz
// Video AI API, applies a preset, and exports it at 1080p to the Dropbox
// folder. Also, it would be great if it could automatically upload to Aryeo and
// then just ping Kyle to deliver it."
//
// Half of that is buildable. The Aryeo half is not — see ARYEO_MANUAL_NOTE in
// topaz.ts: their API has no endpoint that uploads a video and none that sends
// a delivery, so this pipeline ends by handing Kyle the file, the folder and
// the right listing link, and saying plainly on screen that the last step is by
// hand. Nobody should wait for an automation that cannot exist.
//
// WHY A JOB AND NOT A REQUEST. A render is minutes long, the sources measure
// 76–465 MB, and a Vercel function is killed at 300s. So:
//   · every step is a state, written to the row before the next one starts;
//   · every step is idempotent, because a function CAN die mid-step;
//   · a lease stops two cron ticks claiming the same row;
//   · and Topaz's own /status endpoint — never our state column — is the
//     arbiter after a crash, because our column can be stale and theirs can't.
//
// WHY THE GUARDS COME FIRST. Jordan's Topaz auto top-up is ON, with a $100/
// month cap he set. A retry loop here does not throw an error at him — it buys
// credits with his card. Every guard below is enforced server-side, and the
// most important one (one render per cut, ever) is a Postgres unique
// constraint, not an if-statement. The worst-case arithmetic against the $100
// cap is written out on DEFAULT_TOPAZ in src/lib/settings.ts.
// ===========================================================================

export const TOPAZ_STATES = [
  "queued",
  "estimated",
  "uploading",
  "processing",
  "saving",
  "done",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type TopazState = (typeof TOPAZ_STATES)[number];

/** States that still owe work. */
const LIVE_STATES: TopazState[] = ["queued", "estimated", "uploading", "processing", "saving"];
/** States that are holding one of Topaz's concurrent slots. */
const IN_TOPAZ_HANDS: TopazState[] = ["uploading", "processing"];

/** How long one driver tick may hold a row. Longer than any single step so a
 *  slow upload is never stolen mid-flight; short enough that a hard-killed
 *  function's row is picked up again within the next few ticks. */
const LEASE_MS = 12 * 60_000;

/** A render Topaz has been sitting on for this long is not coming back. */
const STALL_MS = 4 * 3600_000;

/** Below this, whatever landed in Dropbox is not a property video. The real
 *  cuts measure 76–465 MB and a 1080p pass of one is tens of MB at the very
 *  least, so one megabyte is far under anything genuine and far over an empty
 *  file or an error page saved under a .mp4 name. */
const MIN_SAVED_BYTES = 1_048_576;

const streetOf = (title?: string | null) => (title || "this job").split(",")[0].trim();
const SAFE_NAME = (name: string) => name.replace(/[^\w.\- ()]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "video.mp4";

// ---------------------------------------------------------------------------
// A. THE TRIGGER — queue, never render, on the approval path.
// ---------------------------------------------------------------------------

export type QueueResult =
  | { queued: true; jobId: string }
  | { queued: false; reason: string; already?: boolean };

/**
 * Approval of a cut queues its 1080p pass. This is ONE INSERT and nothing else:
 * approveCut must stay instant, and must keep working with Topaz switched off,
 * unconfigured, out of credits or down. Every caller wraps it in try/catch
 * anyway — but it is written so there is nothing to catch.
 *
 * The unique constraint on submissionId is the spend guarantee. Re-approving,
 * a replayed cron, an owner double-clicking and two lambdas racing all arrive
 * at the same insert, and Postgres lets exactly one through. There is no
 * check-then-insert window here because there is no check.
 */
export async function queueTopazRender(submissionId: string): Promise<QueueResult> {
  try {
    const sub = await prisma.reviewSubmission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        projectId: true,
        status: true,
        blobUrl: true,
        fileName: true,
        sizeBytes: true,
        deliverable: { select: { type: true } },
      },
    });
    if (!sub) return { queued: false, reason: "That cut no longer exists." };
    if (sub.status !== "APPROVED") return { queued: false, reason: "Only an approved cut gets a 1080p pass." };
    // A folder-discovered row is a file the editor put in Dropbox themselves;
    // the hub never held those bytes, so there is nothing to send.
    if (!sub.blobUrl) return { queued: false, reason: "This cut was found in Dropbox rather than uploaded, so the hub doesn't hold the file to send." };

    const s = await topazSettings();
    if (!s.enabled) return { queued: false, reason: "The 1080p pass is switched off in Settings." };
    const type = sub.deliverable?.type ?? "VIDEO";
    if (!s.deliverableTypes.includes(type)) return { queued: false, reason: `${type} isn't set to go through the 1080p pass.` };

    const job = await prisma.topazJob.create({
      data: {
        submissionId: sub.id,
        projectId: sub.projectId,
        fileName: sub.fileName,
        sourceSizeBytes: sub.sizeBytes,
        state: "queued",
      },
      select: { id: true },
    });
    return { queued: true, jobId: job.id };
  } catch (e) {
    // P2002 = a job for this cut already exists. That is the guard working, not
    // a failure: say so and move on.
    if ((e as { code?: string } | null)?.code === "P2002") {
      return { queued: false, reason: "This cut has already been through the 1080p pass.", already: true };
    }
    console.warn("queueTopazRender failed", (e as Error).message);
    return { queued: false, reason: "Couldn't queue the 1080p pass." };
  }
}

// ---------------------------------------------------------------------------
// E. THE SPEND GUARDS.
//
// Each one is checked here, server-side, before anything can be accepted. They
// are checked TWICE per job — once before we ask Topaz for a free estimate, and
// again at the accept, because minutes pass in between and another job may have
// been accepted meanwhile.
// ---------------------------------------------------------------------------

export type SpendGate =
  | { ok: true; balance: number }
  | { ok: false; hold: true; reason: string; retryAt: Date; alert?: "low-balance" }
  | { ok: false; hold: false; reason: string };

/** Start of the current ET day / calendar month, as real instants. Counting in
 *  ET matters: a render accepted at 9pm ET is 1am UTC the next day, and a cap
 *  that rolled over at UTC midnight would hand back a day's allowance halfway
 *  through Jordan's evening. */
function etWindows(now = new Date()): { dayStart: Date; monthStart: Date; nextDay: Date; nextMonth: Date } {
  const key = etDayKey(now); // YYYY-MM-DD in ET
  const [y, m] = key.split("-").map(Number);
  const dayStart = etAt(key, 0);
  const monthStart = etAt(`${key.slice(0, 7)}-01`, 0);
  const nextDay = new Date(dayStart.getTime() + 24 * 3600_000);
  const nextMonthKey = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { dayStart, monthStart, nextDay, nextMonth: etAt(nextMonthKey, 0) };
}

/**
 * May we commit to spending on one more render right now?
 *
 * `hold: true` means "not yet, ask again at retryAt" — a cap or a busy lane.
 * `hold: false` means "never" — the job is skipped and somebody is told.
 *
 * Everything counts `acceptedAt`, the moment we committed to spend. Counting
 * createdAt would let a backlog of queued jobs look like a spent day, and
 * counting finishedAt would let twenty jobs be accepted before the first one
 * finished.
 */
export async function spendGate(s: TopazSettings, opts: { estimateCredits?: number | null } = {}): Promise<SpendGate> {
  const { dayStart, monthStart, nextDay, nextMonth } = etWindows();
  const wanted = opts.estimateCredits ?? 0;

  // 0. THE PER-VIDEO CEILING — the single guard Jordan set against one
  //    expensive render, and until the Sep 16 review it was enforced in exactly
  //    ONE place (stepQueued), which meant the "Try again" button sitting next
  //    to the message that refused a 96-credit walkthrough quietly bought it.
  //    It belongs HERE, in the gate every path to a paid accept goes through,
  //    so no future caller can route around it.
  if (wanted > s.maxCreditsPerVideo) {
    return {
      ok: false,
      hold: false,
      reason: `This video would cost about ${Math.round(wanted)} credits and the limit per video is ${s.maxCreditsPerVideo}. Nothing was charged. Raise the limit in Settings if this one is worth it.`,
    };
  }

  // 1. NEVER MORE THAN THE PLAN'S CONCURRENCY. Counted from the rows that are
  //    actually in Topaz's hands, so a job stuck in `saving` (ours, not theirs)
  //    does not hold a slot hostage.
  const inFlight = await prisma.topazJob.count({ where: { state: { in: IN_TOPAZ_HANDS } } });
  if (inFlight >= s.maxConcurrent) {
    return { ok: false, hold: true, reason: `${inFlight} videos are already being processed — this one waits its turn.`, retryAt: new Date(Date.now() + 3 * 60_000) };
  }

  // 2. A CAP ON RENDERS PER DAY and per calendar month.
  const [today, thisMonth] = await Promise.all([
    prisma.topazJob.count({ where: { acceptedAt: { gte: dayStart } } }),
    prisma.topazJob.count({ where: { acceptedAt: { gte: monthStart } } }),
  ]);
  if (today >= s.maxRendersPerDay) {
    return { ok: false, hold: true, reason: `Today's limit of ${s.maxRendersPerDay} videos is used up — this one goes through tomorrow.`, retryAt: nextDay };
  }
  if (thisMonth >= s.maxRendersPerMonth) {
    return { ok: false, hold: true, reason: `This month's limit of ${s.maxRendersPerMonth} videos is used up — this one goes through next month, or raise the limit in Settings.`, retryAt: nextMonth };
  }

  // 3. THE CAP THAT ACTUALLY BOUNDS THE BILL: credits committed this month.
  //    The render counts above are a coarser second fence; this one is
  //    denominated in the thing that costs money.
  const spent = await prisma.topazJob.aggregate({
    where: { acceptedAt: { gte: monthStart } },
    _sum: { estimateCredits: true },
  });
  const committed = spent._sum.estimateCredits ?? 0;
  if (committed + wanted > s.maxCreditsPerMonth) {
    return {
      ok: false,
      hold: true,
      reason: `This month's credit limit (${s.maxCreditsPerMonth}) would be passed — ${Math.round(committed)} are already committed. Raise the limit in Settings if that's what you want.`,
      retryAt: nextMonth,
    };
  }

  // 4. BALANCE. Read live, every time, right before we commit. An estimate that
  //    lies shows up here as a falling balance within one job rather than at
  //    the end of the month.
  let balance: number;
  try {
    balance = (await topazBalance()).available_credits;
  } catch (e) {
    return { ok: false, hold: true, reason: `Couldn't check the Topaz balance (${(e as Error).message}) — trying again shortly.`, retryAt: new Date(Date.now() + 10 * 60_000) };
  }
  if (balance < s.minBalanceCredits || (wanted > 0 && balance < wanted)) {
    return {
      ok: false,
      hold: true,
      alert: "low-balance",
      reason: `Topaz is down to ${Math.round(balance)} credits. Videos stop going through the 1080p pass until it's topped up.`,
      retryAt: new Date(Date.now() + 60 * 60_000),
    };
  }
  return { ok: true, balance: Math.round(balance) };
}

// ---------------------------------------------------------------------------
// THE DRIVER — claim a row, advance it one step, release it.
// ---------------------------------------------------------------------------

type JobRow = Awaited<ReturnType<typeof loadJob>>;

async function loadJob(jobId: string) {
  return prisma.topazJob.findUnique({
    where: { id: jobId },
    include: {
      submission: {
        select: {
          id: true,
          blobUrl: true,
          fileName: true,
          sizeBytes: true,
          round: true,
          slot: true,
          deliverableId: true,
          assetPath: true, // part of cutKeyOf — the only thing that identifies a legacy cut
          finalPath: true,
          completedAt: true,
          deliverable: { select: { label: true, type: true, quantity: true, videoStyle: true, productTitle: true } },
        },
      },
      project: {
        select: {
          id: true,
          title: true,
          addressLine: true,
          shootDate: true,
          createdAt: true,
          dropboxFolder: true,
          clientId: true,
          aryeoListingId: true,
          aryeoOrderId: true,
          client: { select: { name: true } },
        },
      },
    },
  });
}

/** Take the lease on up to `limit` rows that are due. The claim is a
 *  compare-and-swap: two cron ticks running at once each get rows the other
 *  did not, and a row whose holder was hard-killed becomes claimable again when
 *  its lease expires. */
export async function claimTopazJobs(limit: number, leaseBy: string): Promise<string[]> {
  const now = new Date();
  const due = await prisma.topazJob.findMany({
    where: {
      state: { in: LIVE_STATES },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, leaseUntil: true },
    take: limit * 3, // over-fetch: some of these will be lost to another tick
  });
  const claimed: string[] = [];
  for (const row of due) {
    if (claimed.length >= limit) break;
    const won = await prisma.topazJob.updateMany({
      where: {
        id: row.id,
        state: { in: LIVE_STATES },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: { leaseUntil: new Date(Date.now() + LEASE_MS), leaseBy: leaseBy.slice(0, 60) },
    });
    if (won.count === 1) claimed.push(row.id);
  }
  return claimed;
}

async function release(jobId: string, patch: Record<string, unknown> = {}) {
  await prisma.topazJob.update({ where: { id: jobId }, data: { leaseUntil: null, leaseBy: null, ...patch } }).catch(() => {});
}

/** A held job never sleeps longer than this before re-asking. The caps park a
 *  job until "next month", which would be the right answer if nothing ever
 *  changed — but Jordan raising the limit, topping up credits, or the lane
 *  simply emptying are all things that SHOULD un-stick a waiting video without
 *  anybody remembering it is there. Re-checking costs one balance read. */
const RETRY_CEILING_MS = 6 * 3600_000;

/** How long a job may wait for something outside itself — Topaz never being
 *  connected — before it is written off rather than queued forever. A week is
 *  long enough to cover a holiday and short enough that the queue (and the
 *  source files it pins in the blob store) cannot grow silently for months. */
const WAITING_CEILING_DAYS = 7;

/** After complete-upload lands, Topaz may briefly still report a status from
 *  before it. Inside this window we do NOT hand the spend claim back on their
 *  word — we ask again in a minute. Outside it, a genuine "still awaiting
 *  upload" is believed. */
const COMPLETE_UPLOAD_GRACE_MS = 5 * 60_000;

/** Park the job until `retryAt` with a reason on the record, lease released.
 *  Conditional on the state we believed, for the same reason finishAs is: a
 *  hold written onto a row another driver has already pushed into `uploading`
 *  would sit a paid render out for up to six hours. */
async function hold(job: { id: string; state: string }, reason: string, retryAt: Date) {
  const at = new Date(Math.min(retryAt.getTime(), Date.now() + RETRY_CEILING_MS));
  await prisma.topazJob
    .updateMany({
      where: { id: job.id, state: job.state },
      data: { leaseUntil: null, leaseBy: null, nextAttemptAt: at, error: reason.slice(0, 400), errorAt: new Date() },
    })
    .catch(() => {});
}

/**
 * Move the row to a terminal state, but ONLY if it is still one of ours to
 * finish.
 *
 * The predicate is not decoration (Sep 16 review). Two drivers run — the
 * five-minute lane and the hourly sync's safety net — and they overlap once an
 * hour. A tick
 * that decides to refuse a job spends up to a minute talking to Topaz first;
 * if the lease had expired in that window and the other driver had meanwhile
 * accepted, uploaded and started the render, an unconditional write would stamp
 * "skipped" over a render Jordan had just paid for and nobody would ever be
 * told the file was missing. So the write is a compare-and-swap against the
 * state we believed, and losing it is a no-op we stay quiet about.
 */
async function finishAs(job: NonNullable<JobRow>, state: "failed" | "skipped", patch: Record<string, unknown>): Promise<boolean> {
  const r = await prisma.topazJob
    .updateMany({
      where: { id: job.id, state: job.state },
      data: { state, finishedAt: new Date(), nextAttemptAt: null, leaseUntil: null, leaseBy: null, ...patch },
    })
    .catch(() => ({ count: 0 }));
  return r.count === 1;
}

/** Stop for good, and TELL SOMEBODY. A silently failed render is worse than no
 *  render: Kyle waits for a file that is never coming. */
async function fail(job: NonNullable<JobRow>, reason: string) {
  const won = await finishAs(job, "failed", { error: reason.slice(0, 400), errorAt: new Date() });
  if (!won) return; // another tick moved this row on; its outcome is the true one
  await tellSomebody(job, `The 1080p pass couldn't finish — ${streetOf(job.project.title)}`, reason, `topaz-failed-${job.id}`);
}

/** Refuse the job before anything was spent. Also announced: an owner who was
 *  promised a 1080p file needs to know one is not coming, and why. */
async function skip(job: NonNullable<JobRow>, reason: string) {
  const won = await finishAs(job, "skipped", { skipReason: reason.slice(0, 400) });
  if (!won) return;
  await tellSomebody(job, `Skipped the 1080p pass — ${streetOf(job.project.title)}`, reason, `topaz-skipped-${job.id}`);
}

async function tellSomebody(job: NonNullable<JobRow>, title: string, body: string, dedupeKey: string) {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "topaz_problem",
      title,
      body,
      href: `/review/${job.projectId}?cut=${job.submissionId}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey,
    });
  } catch { /* the bell is best-effort; the row still carries the reason */ }
  await prisma.activity
    .create({ data: { projectId: job.projectId, type: "SYSTEM", body: `${title}: ${body}`.slice(0, 500) } })
    .catch(() => {});
}

/**
 * Advance ONE job by ONE step. Returns the state it ended in.
 *
 * Every branch either writes a new state, parks the row with a retry time, or
 * finishes it — the row is never left leased on a path out of this function,
 * and never left in a state the next tick cannot resume from.
 */
export async function advanceTopazJob(jobId: string, budget: { remainingMs: () => number } = { remainingMs: () => 240_000 }): Promise<string> {
  const job = await loadJob(jobId);
  if (!job) return "gone";
  if (!LIVE_STATES.includes(job.state as TopazState)) {
    await release(jobId);
    return job.state;
  }
  const s = await topazSettings();

  // The master switch is honoured on every tick, not just at queue time: if
  // Jordan turns the pass off mid-flight, nothing NEW is accepted. A job that
  // is already processing runs to the end — the credits are spent either way,
  // and abandoning it would throw away the file he already paid for.
  if (!s.enabled && (job.state === "queued" || job.state === "estimated")) {
    await skip(job, "The 1080p pass was switched off in Settings before this video went through.");
    return "skipped";
  }
  if (!(await topazConnected())) {
    // A job nobody ever connects Topaz for must not wait forever. It held its
    // source file alive too (pruneReviewUploads never releases the bytes a live
    // job still needs), so an unattended queue grew quietly in two places at
    // once. After WAITING_CEILING_DAYS it is refused, in words that say the
    // video is fine and only the 1080p extra was missed.
    // ...but ONLY a job that has never committed. Once acceptedAt is stamped
    // the credits are Jordan's money and the render may be finished and sitting
    // at Topaz waiting to be filed; a job like that waits as long as it takes
    // for the key to come back, because the alternative is throwing away a
    // video he has already paid for.
    const waitingDays = (Date.now() - job.createdAt.getTime()) / 86_400_000;
    if (!job.acceptedAt && waitingDays > WAITING_CEILING_DAYS) {
      await skip(
        job,
        `This waited ${Math.round(waitingDays)} days for Topaz to be connected, so it has been left out. The video itself was delivered as normal — only the 1080p pass was missed. Paste the API key on the Connections page, then press "Try again" if you still want this one done.`,
      );
      return "skipped";
    }
    await hold(job, "Topaz isn't connected — paste the API key on the Connections page and this will pick up on its own.", new Date(Date.now() + 30 * 60_000));
    return job.state;
  }

  try {
    switch (job.state as TopazState) {
      case "queued":
        return await stepQueued(job, s);
      case "estimated":
        return await stepEstimated(job, s);
      case "uploading":
        return await stepUploading(job, s, budget);
      case "processing":
        return await stepProcessing(job, s);
      case "saving":
        return await stepSaving(job, s);
      default:
        await release(jobId);
        return job.state;
    }
  } catch (e) {
    const err = e instanceof TopazError ? e : new TopazError((e as Error).message, 0, true);
    const attempt = job.attempt + 1;
    // BOUNDED RETRIES. A permanently failing job must stop and tell somebody —
    // spinning is what costs money, and a loop against a paid API is exactly
    // the failure auto top-up turns into a bill.
    if (!err.retryable || attempt >= s.maxAttempts) {
      await prisma.topazJob.update({ where: { id: jobId }, data: { attempt } }).catch(() => {});
      await fail(job, err.message);
      return "failed";
    }
    const backoffMs = Math.min(30 * 60_000, 60_000 * 2 ** (attempt - 1)); // 1m, 2m, 4m…
    await release(jobId, {
      attempt,
      nextAttemptAt: new Date(Date.now() + backoffMs),
      error: err.message.slice(0, 400),
      errorAt: new Date(),
    });
    return job.state;
  }
}

// ---- queued → estimated ----------------------------------------------------

async function stepQueued(job: NonNullable<JobRow>, s: TopazSettings): Promise<string> {
  const sub = job.submission;
  if (!sub?.blobUrl) {
    await skip(job, "The hub no longer holds this cut's file, so there is nothing to send.");
    return "skipped";
  }

  // WHAT ARE WE SENDING? Topaz's step 1 needs duration, frame rate and frame
  // count, and the hub stores none of them. We read them off the file's own
  // header (probeVideoMetadata) rather than assume anything: a made-up frame
  // count is a made-up price, and the price is what gets charged.
  let meta = {
    width: job.sourceWidth ?? 0,
    height: job.sourceHeight ?? 0,
    frameRate: job.sourceFrameRate ?? 0,
    frameCount: job.sourceFrameCount ?? 0,
    durationSec: job.sourceDurationSec ?? 0,
    container: job.sourceContainer ?? "",
    sizeBytes: job.sourceSizeBytes ?? 0,
  };
  if (!(meta.frameCount > 0 && meta.durationSec > 0 && meta.width > 0)) {
    const probed = await probeVideoMetadata(sub.blobUrl, sub.sizeBytes ?? null);
    meta = probed;
    await prisma.topazJob.update({
      where: { id: job.id },
      data: {
        sourceWidth: probed.width,
        sourceHeight: probed.height,
        sourceFrameRate: probed.frameRate,
        sourceFrameCount: probed.frameCount,
        sourceDurationSec: probed.durationSec,
        sourceContainer: probed.container,
        sourceSizeBytes: probed.sizeBytes,
      },
    });
  }

  // Topaz answers 413 over 500 MB. Real cuts measure 76–465 MB, so this is a
  // fence a real file can actually hit — say so in words Jordan can act on.
  const mb = Math.round(meta.sizeBytes / 1048576);
  if (mb > s.maxSourceMB) {
    await skip(job, `This video is ${mb} MB and Topaz won't take anything over ${s.maxSourceMB} MB. It needs to be exported smaller, or run through Topaz on the desktop.`);
    return "skipped";
  }

  const output = plannedOutput(meta, { shortSide: s.outputShortSide, neverUpscale: s.neverUpscale });

  // Guard BEFORE the pre-flight: the estimate is free, but there is no point
  // asking for one when the lane is full or the month is spent.
  const gate = await spendGate(s);
  if (!gate.ok) return await applyGate(job, gate);

  // A crash between Topaz answering and this row being written leaks ONE free,
  // unaccepted estimate — no credits, nothing to clean up, and we cannot cancel
  // an id we never learned. Never POST twice for a job that already has one.
  if (job.requestId) {
    await release(job.id, { state: "estimated", attempt: 0, nextAttemptAt: null });
    return "estimated";
  }

  const filters: TopazFilter[] = [{ model: "prob-4", ...s.params }];
  const est = await createVideoRequest({
    source: {
      resolution: { width: meta.width, height: meta.height },
      container: meta.container,
      size: meta.sizeBytes,
      duration: meta.durationSec,
      frameRate: meta.frameRate,
      frameCount: meta.frameCount,
    },
    output: {
      resolution: output,
      audioCodec: s.audioCodec,
      audioTransfer: s.audioTransfer,
      // Frame interpolation is OFF in Jordan's preset ("30 FPS original, no
      // slow motion"), so the output frame rate is simply the source's.
      frameRate: meta.frameRate,
      dynamicCompressionLevel: s.dynamicCompressionLevel,
      container: s.container,
    },
    filters,
  });

  // NO PRICE, NO SPEND. Topaz's estimate field names are not pinned down in
  // their docs, so estimateFrom() reads generously — but if it still comes back
  // empty we stop, because the alternative is committing to an unknown charge.
  if (est.credits === null) {
    await prisma.topazJob.update({ where: { id: job.id }, data: { requestId: est.requestId } }).catch(() => {});
    await cancelEstimate(est.requestId);
    await fail(job, "Topaz didn't say what this video would cost, so it wasn't sent. Nothing was charged.");
    return "failed";
  }

  // Two opinions on the price, and we plan against the higher one: Topaz's own
  // estimate, and their published Proteus rate card (1080p ≈ 8 credits/minute).
  const local = localCreditEstimate(output, meta.durationSec, meta);
  const credits = Math.max(est.credits, local);

  // Record the price BEFORE deciding anything with it, and WITHOUT releasing
  // the lease — the row stays "queued" and stays ours. (Until the Sep 16
  // review this wrote state="estimated" and dropped the lease first, then spent
  // up to a minute cancelling the estimate: in that window the other driver
  // could accept and start the very render this tick was refusing, and the
  // refusal would then stamp "skipped" over a paid job.)
  await prisma.topazJob.update({
    where: { id: job.id },
    data: {
      requestId: est.requestId,
      estimateCredits: credits,
      estimateSeconds: est.seconds,
      outputWidth: output.width,
      outputHeight: output.height,
      presetJson: JSON.stringify({ filters, output: { resolution: output, container: s.container } }),
      startedAt: job.startedAt ?? new Date(),
    },
  });

  // THE PER-VIDEO CEILING. Checked against the higher of the two estimates, and
  // checked here — after the free step, before the paid one. (It is checked
  // again inside spendGate at the accept, so no other route in can miss it.)
  if (credits > s.maxCreditsPerVideo) {
    await cancelEstimate(est.requestId);
    await skip(
      { ...job, estimateCredits: credits },
      `This video would cost about ${Math.round(credits)} credits and the limit per video is ${s.maxCreditsPerVideo}. Nothing was charged. Raise the limit in Settings if this one is worth it.`,
    );
    return "skipped";
  }

  await release(job.id, { state: "estimated", attempt: 0, error: null, errorAt: null, nextAttemptAt: null });
  return "estimated";
}

/** A gate answer becomes either a park-and-retry or a refusal. */
async function applyGate(job: NonNullable<JobRow>, gate: Exclude<SpendGate, { ok: true }>): Promise<string> {
  if (gate.hold && gate.alert === "low-balance") {
    // Never fail silently mid-delivery: a lane that has stopped for money is
    // the one thing somebody has to know about today.
    try {
      const { notifyInApp } = await import("@/lib/notify");
      await notifyInApp({
        kind: "topaz_problem",
        title: "Topaz credits are running low",
        body: gate.reason,
        href: "/connections",
        targets: [{ roles: ["OWNER"] }],
        dedupeKey: `topaz-low-balance-${etDayKey(new Date())}`,
      });
    } catch { /* best-effort */ }
  }
  if (gate.hold) {
    await hold(job, gate.reason, gate.retryAt);
    return job.state;
  }
  // A refusal before the accept leaves an estimate sitting open at Topaz. It
  // costs nothing either way, but handing it back is the tidy thing to do —
  // and it must happen BEFORE the skip, while the row is still ours.
  if (job.requestId && !job.acceptedAt) await cancelEstimate(job.requestId);
  await skip(job, gate.reason);
  return "skipped";
}

// ---- estimated → uploading -------------------------------------------------

async function stepEstimated(job: NonNullable<JobRow>, s: TopazSettings): Promise<string> {
  if (!job.requestId) {
    // Nothing to accept — go back and ask for an estimate again. Free.
    await release(job.id, { state: "queued", nextAttemptAt: null });
    return "queued";
  }

  // NO PRICE, NO SPEND — enforced here as well as in stepQueued, because THIS
  // is the step that commits.
  //
  // A row can reach this point without a price: an older row, a hand-edited
  // one, or (until the Sep 16 review) the "Try again" button on a job that
  // failed precisely because Topaz's estimate could not be read — the most
  // likely first-day failure of all, since their field names are unverified.
  // Accepting with a null estimate silences THREE guards at once: the per-video
  // ceiling has nothing to compare, the balance check reads `wanted` as 0, and
  // the monthly credit cap sums this very column — so the render would count as
  // zero credits forever and 90 unmetered long-form renders would be ~$600 of
  // top-ups against a $100 cap. Go back to the free price check instead.
  if (job.estimateCredits == null) {
    await cancelEstimate(job.requestId);
    await release(job.id, { state: "queued", requestId: null, nextAttemptAt: null });
    return "queued";
  }

  // THE SECOND GATE. Minutes have passed since the first one and other jobs may
  // have been accepted in between; this is the check that actually stands
  // between a busy morning and a surprise top-up. It re-applies the per-video
  // ceiling as well as the day/month/concurrency/balance limits.
  const gate = await spendGate(s, { estimateCredits: job.estimateCredits });
  if (!gate.ok) return await applyGate(job, gate);

  // Accepting does NOT start processing (complete-upload does), which is what
  // makes a repeat safe after a crash between the call and the write.
  let targets: TopazUploadTarget[];
  const stored = parseTargets(job.uploadUrlsJson);
  if (stored.length) targets = stored;
  else targets = await acceptVideoRequest(job.requestId);

  await release(job.id, {
    state: "uploading",
    // acceptedAt is the ledger moment for every cap: we have now committed.
    acceptedAt: job.acceptedAt ?? new Date(),
    balanceBefore: gate.balance,
    uploadUrlsJson: JSON.stringify(targets),
    attempt: 0,
    error: null,
    errorAt: null,
    nextAttemptAt: null,
  });

  // CLOSING THE LAST GAP IN THE CREDIT CAP. spendGate counts, then we accept —
  // and two drivers (the */5 lane and the hourly sync's safety net) can be
  // between those two moments at the same time, each having seen a ledger
  // without the other's job in it. So the ledger is read ONE more time now that
  // this job is IN it. Nothing has been spent yet — complete-upload has not
  // fired — so an overshoot can still be handed back cleanly and for free.
  // Without this, the month could pass the cap by roughly (drivers × jobs per
  // tick) renders; with it, it cannot pass it at all.
  const { monthStart } = etWindows();
  const after = await prisma.topazJob.aggregate({ where: { acceptedAt: { gte: monthStart } }, _sum: { estimateCredits: true } });
  if ((after._sum.estimateCredits ?? 0) > s.maxCreditsPerMonth) {
    if (job.requestId) await cancelVideoRequest(job.requestId);
    // Hand the commitment back in ONE write: acceptedAt cleared takes this job
    // straight back out of the month's ledger, so the very next gate reads a
    // true number rather than one that still counts a job we just let go.
    await release(job.id, {
      state: "estimated",
      acceptedAt: null,
      uploadUrlsJson: null,
      nextAttemptAt: new Date(Date.now() + RETRY_CEILING_MS),
      error: `This month's credit limit (${s.maxCreditsPerMonth}) is used up — this video waits, or raise the limit in Settings.`,
      errorAt: new Date(),
    });
    return "estimated";
  }
  return "uploading";
}

function parseTargets(json: string | null): TopazUploadTarget[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as TopazUploadTarget[];
    return Array.isArray(v) ? v.filter((t) => typeof t?.url === "string" && typeof t?.partNum === "number") : [];
  } catch {
    return [];
  }
}

function parseParts(json: string | null): TopazUploadResult[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as TopazUploadResult[];
    return Array.isArray(v) ? v.filter((p) => typeof p?.eTag === "string" && typeof p?.partNum === "number") : [];
  } catch {
    return [];
  }
}

// ---- uploading → processing ------------------------------------------------

/**
 * The OUTBOUND leg is the one that genuinely has to pass through us: Topaz
 * hands back a presigned URL, and only bytes satisfy it. So this step pulls
 * exactly one part's range out of the hub's store and PUTs it, records the
 * eTag, and comes back for the next part — which is what makes a 465 MB upload
 * survive a function that is killed at 300s.
 *
 * (The RETURN leg does not pass through us at all: Dropbox fetches Topaz's
 * finished file itself. See stepSaving.)
 */
async function stepUploading(job: NonNullable<JobRow>, s: TopazSettings, budget: { remainingMs: () => number }): Promise<string> {
  const sub = job.submission;
  const targets = parseTargets(job.uploadUrlsJson);
  if (!sub?.blobUrl || !targets.length) {
    await fail(job, "Lost track of where this video was being uploaded. Nothing was charged.");
    return "failed";
  }
  const total = job.sourceSizeBytes ?? sub.sizeBytes ?? 0;
  if (!total) {
    await fail(job, "Couldn't tell how big this video is, so it wasn't uploaded. Nothing was charged.");
    return "failed";
  }
  const done = parseParts(job.uploadPartsJson);
  const haveSet = new Set(done.map((p) => p.partNum));

  // Topaz gives one URL, or a numbered set. A set is split evenly by part, with
  // the last part taking the remainder — the standard multipart shape, and the
  // only reading their contract supports.
  const chunk = Math.ceil(total / targets.length);

  for (const t of targets) {
    if (haveSet.has(t.partNum)) continue;
    // Don't start a part we cannot finish: a killed function mid-PUT is a part
    // with no eTag, and the next tick would just start it again.
    if (budget.remainingMs() < 90_000) {
      await release(job.id, { nextAttemptAt: new Date(Date.now() + 5_000) });
      return "uploading";
    }
    const start = (t.partNum - 1) * chunk;
    const end = Math.min(total, start + chunk) - 1;
    if (start > end) {
      done.push({ partNum: t.partNum, eTag: "empty" });
      continue;
    }
    const res = await fetch(sub.blobUrl, {
      headers: targets.length > 1 ? { Range: `bytes=${start}-${end}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) throw new TopazError(`Couldn't read the video out of the hub's store (${res.status}).`, res.status, res.status >= 500);
    // One allocation, no copy (the view shares the ArrayBuffer). When Topaz
    // gives a single URL there is nothing to split, so the whole file is held
    // in memory for the length of the PUT — 465 MB for the biggest cut
    // measured. That is why this route asks for 3009 MB in vercel.json; the
    // default would be the one thing that reliably kills a big render.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = (job.sourceContainer ?? "mp4") === "mov" ? "video/quicktime" : "video/mp4";
    const part = await putUploadPart(t, bytes, contentType);
    done.push(part);
    haveSet.add(part.partNum);
    // Persist after EVERY part: this line is the whole resumability story.
    await prisma.topazJob.update({
      where: { id: job.id },
      data: {
        uploadPartsJson: JSON.stringify(done),
        uploadedBytes: done.length * chunk > total ? total : done.length * chunk,
        leaseUntil: new Date(Date.now() + LEASE_MS), // renew — a big file is a long hold
      },
    });
  }

  if (done.length < targets.length) {
    await release(job.id, { nextAttemptAt: new Date(Date.now() + 5_000) });
    return "uploading";
  }

  // ==== THE ONE CALL THAT SPENDS MONEY ====================================
  // Claim the right to make it with a compare-and-swap. If another invocation
  // already claimed it, we do NOT call it again — we go to `processing` and let
  // Topaz's own status endpoint tell us what really happened. This is the line
  // that makes a double-charge structurally impossible rather than unlikely.
  //
  // A HARD CEILING ON TOP OF THE CLAIM (Sep 16 review). The claim can be handed
  // back — stepProcessing does it when Topaz says the bytes are still owed —
  // and a claim that can be handed back is a claim that can be taken again. So
  // the number of times we have ever asked Topaz to start THIS render is
  // counted on the row, and past maxAttempts we stop asking and say so, rather
  // than calling a paid endpoint on a timer with auto top-up switched on.
  if (job.completeUploadTries >= s.maxAttempts) {
    await fail(job, `Topaz was asked ${job.completeUploadTries} times to start this render and never did. Nothing further will be sent.`);
    return "failed";
  }
  const claimed = await prisma.topazJob.updateMany({
    where: { id: job.id, completeUploadAt: null },
    data: { completeUploadAt: new Date(), completeUploadTries: { increment: 1 } },
  });
  if (claimed.count === 1) {
    try {
      await completeUpload(job.requestId!, done);
    } catch (e) {
      // We do NOT clear the claim on a failure. The call may well have landed —
      // a timeout says nothing about what the server did. stepProcessing asks
      // Topaz which it was and, only if Topaz says the bytes are still owed,
      // hands the claim back. Retrying blind here is how you pay twice.
      await release(job.id, {
        state: "processing",
        error: `Asked Topaz to start and didn't get a clear answer (${(e as Error).message}). Checking with them.`.slice(0, 400),
        errorAt: new Date(),
        nextAttemptAt: new Date(Date.now() + 30_000),
      });
      return "processing";
    }
  }
  // `attempt` is deliberately NOT reset here. It used to be, and that single
  // word was the loop: stepProcessing hands the spend claim back on an
  // awaiting-upload status and counts an attempt as it does so, we land here
  // again, and a reset meant the count could never reach maxAttempts. Progress
  // through the states is not evidence that the retries are behaving.
  await release(job.id, { state: "processing", error: null, errorAt: null, nextAttemptAt: new Date(Date.now() + 45_000) });
  return "processing";
}

// ---- processing → saving ---------------------------------------------------

async function stepProcessing(job: NonNullable<JobRow>, s: TopazSettings): Promise<string> {
  if (!job.requestId) {
    await fail(job, "Lost track of this render at Topaz. Nothing more will be charged.");
    return "failed";
  }
  const st = await videoStatus(job.requestId);

  if (TOPAZ_DONE.has(st.status) && st.downloadUrl) {
    await release(job.id, {
      state: "saving",
      // The filing clock starts HERE. Measuring it from acceptedAt gave a
      // three-hour render half an hour to reach Dropbox and then re-failed it
      // instantly on every retry — a paid, finished file that could never be
      // filed (Sep 16 review).
      savingStartedAt: new Date(),
      downloadUrl: st.downloadUrl,
      creditsCharged: st.credits ?? job.creditsCharged,
      attempt: 0,
      error: null,
      errorAt: null,
      nextAttemptAt: null,
    });
    return "saving";
  }
  if (TOPAZ_DEAD.has(st.status)) {
    await fail(job, `Topaz couldn't finish this one${st.message ? ` — ${st.message}` : ""}.`);
    return "failed";
  }

  // A render Topaz has been sitting on for hours is not coming back. Checked
  // BEFORE the awaiting-upload branch, not after: that branch returns, so while
  // it sat below this check a job bouncing between the two states could never
  // reach the four-hour stop at all.
  const since = job.acceptedAt ?? job.startedAt ?? job.createdAt;
  if (Date.now() - since.getTime() > STALL_MS) {
    await cancelVideoRequest(job.requestId);
    await fail(job, `Topaz has had this video for over ${Math.round(STALL_MS / 3600_000)} hours without finishing it, so it has been cancelled.`);
    return "failed";
  }

  // Topaz says it is still waiting for the file: the complete-upload we were
  // unsure about never landed. THIS is the only place the spend claim is ever
  // handed back, and only on Topaz's own word — with two conditions on that
  // word, both added in the Sep 16 review.
  if (TOPAZ_AWAITING_UPLOAD.has(st.status)) {
    // 1. NOT WITHIN THE GRACE WINDOW. A status read seconds after
    //    complete-upload can still describe the request as it was before it;
    //    believing that would hand the claim straight back and ask Topaz to
    //    start the same render again. Wait and ask once more instead.
    if (job.completeUploadAt && Date.now() - job.completeUploadAt.getTime() < COMPLETE_UPLOAD_GRACE_MS) {
      await release(job.id, { nextAttemptAt: new Date(Date.now() + 60_000) });
      return "processing";
    }
    // 2. NOT PAST THE CEILING. `attempt` here and completeUploadTries in
    //    stepUploading are two fences around the same thing: we will ask Topaz
    //    to start a render a bounded number of times and then stop.
    const attempt = job.attempt + 1;
    if (attempt >= s.maxAttempts || job.completeUploadTries >= s.maxAttempts) {
      await fail(job, "Topaz never started this render even though the file was sent. Nothing was charged.");
      return "failed";
    }
    await release(job.id, {
      state: "uploading",
      completeUploadAt: null,
      attempt,
      nextAttemptAt: new Date(Date.now() + 30_000),
    });
    return "uploading";
  }

  await release(job.id, { nextAttemptAt: new Date(Date.now() + 60_000), error: null, errorAt: null });
  return "processing";
}

// ---- saving → done ---------------------------------------------------------

/** The enhanced file's name. It ends in " - 1080p" and it is the ONLY file left
 *  with the cut's name in 05-Final-Video once the original has been set aside —
 *  see stepSaving for why that is the shape we chose. */
export function enhancedNameFor(originalName: string, container: string): string {
  const dot = originalName.lastIndexOf(".");
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  return SAFE_NAME(`${stem} - 1080p.${container}`);
}

/**
 * WHERE THE FILE LANDS, and which one Kyle delivers.
 *
 * Both files live in the job's 05-Final-Video folder — "the Dropbox folder"
 * Jordan means — and THE ORIGINAL IS NEVER OVERWRITTEN OR DELETED. The editor's
 * approved export is the only copy of their work that exists, and a Topaz pass
 * that came out wrong must be recoverable by opening a folder, not by asking an
 * editor to re-export.
 *
 * The order matters, and it is chosen so no moment exists where the folder has
 * no deliverable file in it:
 *   1. the enhanced file is saved as "<cut name> - v<N> - 1080p.mp4";
 *   2. only once Dropbox confirms it, the original moves down into the
 *      superseded/ subfolder the repo already uses for exactly this (see
 *      reviewCuts.startDropboxCopy), renamed "(before 1080p pass)";
 *   3. any PREVIOUS round's enhanced file goes down there too.
 * Die between 1 and 2 and the folder holds both files under clearly different
 * names, and the next tick finishes the move.
 *
 * So: the file Kyle delivers is the one in 05-Final-Video whose name ends in
 * "- 1080p". After the move it is the only video left at that level, which is
 * the same rule he already follows ("deliver what's in Final"), and the ping
 * names the file and the folder outright.
 *
 * The RETURN LEG DOES NOT PASS THROUGH US. Dropbox's files/save_url fetches
 * Topaz's download link directly — the same trick startDropboxCopy already uses
 * to get an approved cut into Final — so hundreds of MB never touch a lambda.
 */
async function stepSaving(job: NonNullable<JobRow>, s: TopazSettings): Promise<string> {
  const sub = job.submission;
  const project = job.project;
  if (!sub || !project) {
    await fail(job, "This cut's job has gone from the hub, so the finished video couldn't be filed.");
    return "failed";
  }

  // An in-flight save_url from a previous tick: finish that rather than start
  // a second copy of the same file.
  if (job.dropboxJobId && !job.savedAt) {
    const state = await checkSaveJob(job.id, job.dropboxJobId);
    if (state === "pending") {
      await release(job.id, { nextAttemptAt: new Date(Date.now() + 20_000) });
      return "saving";
    }
    if (state === "failed") {
      await release(job.id, { dropboxJobId: null, downloadUrl: null, nextAttemptAt: new Date(Date.now() + 60_000), attempt: job.attempt + 1 });
      if (job.attempt + 1 >= s.maxAttempts) {
        await fail(job, "The finished video was made but Dropbox wouldn't take it. The credits were spent; the file is still at Topaz.");
        return "failed";
      }
      return "saving";
    }
    // Landed. Go straight to the tidy-up — `job` in hand is the row as it was
    // BEFORE checkSaveJob stamped savedAt, and falling through on that stale
    // copy would start a second copy of a file that is already there.
    if (job.finalPath) return await finishSaving(job, s, job.finalPath);
  }

  // A Dropbox copy that never lands must STOP, not poll every 20 seconds
  // forever. The credits are already spent by this point, so failing here
  // doesn't waste money — but a job nobody is told about is how a video quietly
  // never reaches a client. retryTopazJobAction restarts the save by hand.
  const savingSince = job.savingStartedAt ?? job.acceptedAt ?? job.createdAt;
  if (!job.savedAt && Date.now() - savingSince.getTime() > STALL_MS) {
    await fail(job, `The finished video has been waiting over ${Math.round(STALL_MS / 3600_000)} hours to reach Dropbox. It is still at Topaz — press Try again once Dropbox is responding.`);
    return "failed";
  }

  const folder = actualFolderPaths(project).finalVideo;
  // The original's own name is the truth when the hub knows it; otherwise the
  // slot label names the file exactly the way startDropboxCopy would have.
  const originalName = sub.finalPath?.split("/").pop() ?? derivedCutName(job);
  const path = `${folder}/${enhancedNameFor(originalName, s.container)}`;

  if (!job.savedAt) {
    let url = job.downloadUrl;
    if (!url) {
      // A download link can expire while we were held up; ask again rather than
      // re-render. Re-reading status is free.
      const st = await videoStatus(job.requestId!);
      url = st.downloadUrl;
      if (!url) {
        await release(job.id, { nextAttemptAt: new Date(Date.now() + 60_000) });
        return "saving";
      }
      await prisma.topazJob.update({ where: { id: job.id }, data: { downloadUrl: url } });
    }
    await dbx("files/create_folder_v2", { path: folder, autorename: false }).catch(() => {});
    type SaveUrl = { ".tag": "complete" | "async_job_id"; async_job_id?: string };
    let r: SaveUrl;
    try {
      r = await dbx<SaveUrl>("files/save_url", { path, url });
    } catch (e) {
      // Already there from an attempt we lost track of — that IS the copy.
      if (e instanceof DropboxError && /conflict/i.test(e.message)) {
        const meta = await dbx<{ size?: number }>("files/get_metadata", { path }).catch(() => null);
        if (meta) {
          await prisma.topazJob.update({ where: { id: job.id }, data: { finalPath: path, savedAt: new Date(), dropboxJobId: null } });
          return await finishSaving(job, s, path);
        }
      }
      throw e;
    }
    if (r[".tag"] !== "complete") {
      await release(job.id, { finalPath: path, dropboxJobId: r.async_job_id ?? null, nextAttemptAt: new Date(Date.now() + 20_000) });
      return "saving";
    }
    await prisma.topazJob.update({ where: { id: job.id }, data: { finalPath: path, savedAt: new Date(), dropboxJobId: null } });
  }

  return await finishSaving(job, s, job.finalPath ?? path);
}

/** Poll one in-flight save_url. */
async function checkSaveJob(jobId: string, asyncJobId: string): Promise<"complete" | "pending" | "failed"> {
  type Status = { ".tag": "in_progress" | "complete" | "failed"; failed?: { ".tag"?: string } };
  let st: Status;
  try {
    st = await dbx<Status>("files/save_url/check_job_status", { async_job_id: asyncJobId });
  } catch {
    return "pending";
  }
  if (st[".tag"] === "in_progress") return "pending";
  if (st[".tag"] === "complete") {
    await prisma.topazJob.update({ where: { id: jobId }, data: { savedAt: new Date(), dropboxJobId: null } }).catch(() => {});
    return "complete";
  }
  return "failed";
}

/** Everything after the enhanced file is safely in Dropbox: set the older files
 *  aside, tidy up at Topaz, and ping Kyle. */
async function finishSaving(job: NonNullable<JobRow>, s: TopazSettings, path: string): Promise<string> {
  const sub = job.submission!;
  const folder = path.slice(0, path.lastIndexOf("/"));

  // 0. LOOK AT THE FILE BEFORE TRUSTING IT (Sep 16 review). Dropbox's "complete"
  //    tag says the transfer finished, not that what arrived is a video. Every
  //    step after this one is written on the assumption that the enhanced file
  //    is the good one — the editor's export is moved out of the folder and
  //    Kyle is told to deliver what is left — so an empty or stub file would
  //    become the only video in Final and the first person to notice would be
  //    the client. One metadata read (the same call the conflict path above
  //    already makes) is cheap insurance. A real property video is tens of MB;
  //    the floor is deliberately low and absolute rather than a ratio of the
  //    source, because a 4K source legitimately shrinks a long way at 1080p.
  let saved: { size?: number } | null = null;
  try {
    saved = await dbx<{ size?: number }>("files/get_metadata", { path });
  } catch (e) {
    // "There is no file there" is an answer. Anything else is Dropbox being
    // unreachable for a moment, and writing off a render Jordan has already
    // paid for on the strength of a 503 would be the wrong way round — ask
    // again shortly, bounded by the same four hours as every other wait here.
    if (!(e instanceof DropboxError && /not_found/i.test(e.message))) {
      const since = job.savingStartedAt ?? job.acceptedAt ?? job.createdAt;
      if (Date.now() - since.getTime() > STALL_MS) {
        await fail(job, `The 1080p file is in Dropbox but the hub hasn't been able to check on it for over ${Math.round(STALL_MS / 3600_000)} hours. The editor's original is still in the Final folder — deliver that one, and press "Try again" once Dropbox is responding.`);
        return "failed";
      }
      await release(job.id, { nextAttemptAt: new Date(Date.now() + 60_000) });
      return "saving";
    }
  }
  const savedBytes = saved?.size ?? 0;
  if (savedBytes < MIN_SAVED_BYTES) {
    // Set the stub aside rather than delete it — nothing in this pipeline
    // deletes a file, and a named file in superseded/ is evidence somebody can
    // look at. Clearing savedAt/finalPath matters too: without it a "Try again"
    // would walk straight back here and re-read a file that has moved.
    if (saved) {
      await dbx("files/create_folder_v2", { path: `${folder}/superseded`, autorename: false }).catch(() => {});
      await dbx("files/move_v2", { from_path: path, to_path: `${folder}/superseded/${path.split("/").pop()}`, autorename: true }).catch(() => {});
    }
    await prisma.topazJob.update({ where: { id: job.id }, data: { savedAt: null, finalPath: null, dropboxJobId: null, downloadUrl: null } }).catch(() => {});
    await fail(
      job,
      saved
        ? `The 1080p file reached Dropbox but arrived empty, so it hasn't been left in the Final folder. The editor's original is still there, untouched — deliver that one. Press "Try again" to have another go at the 1080p pass.`
        : `The 1080p file didn't arrive in Dropbox after all. The editor's original is still in the Final folder, untouched — deliver that one. Press "Try again" to have another go at the 1080p pass.`,
    );
    return "failed";
  }

  // 1. The editor's original goes down into superseded/, keeping its bytes and
  //    gaining a name that says what it is. Only once the hub is sure its own
  //    copy of the original has settled — moving a file Dropbox is still
  //    writing is how you lose one.
  let originalMoved = false;
  if (sub.finalPath && sub.completedAt && !sub.finalPath.includes("/superseded/")) {
    const name = sub.finalPath.split("/").pop()!;
    const dot = name.lastIndexOf(".");
    const asideName = SAFE_NAME(`${dot > 0 ? name.slice(0, dot) : name} (before 1080p pass)${dot > 0 ? name.slice(dot) : ""}`);
    const to = `${folder}/superseded/${asideName}`;
    await dbx("files/create_folder_v2", { path: `${folder}/superseded`, autorename: false }).catch(() => {});
    const moved = await dbx<{ metadata?: { path_display?: string } }>("files/move_v2", { from_path: sub.finalPath, to_path: to, autorename: true })
      .then((r) => r?.metadata?.path_display ?? to)
      .catch(() => null);
    if (moved) {
      // completedAt STAYS set — the cut is still approved-and-copied, it just
      // lives one folder down. Nulling it would make finalizeApprovedCuts
      // copy the original back in beside the enhanced file every hour.
      await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { finalPath: moved } }).catch(() => {});
      originalMoved = true;
    }
  }

  // 2. A PREVIOUS round's enhanced file for the same cut goes down too, so the
  //    folder holds exactly one file to deliver. (reviewCuts.startDropboxCopy
  //    does the same for the editor's originals; enhanced files are ours, so
  //    they are ours to tidy.)
  await supersedePriorEnhanced({ id: sub.id, projectId: job.projectId, deliverableId: sub.deliverableId, slot: sub.slot, assetPath: sub.assetPath }).catch(() => {});

  // 3. Hygiene: a client's property video has no reason to stay on Topaz's
  //    servers once it is safely filed. Best-effort, after the copy, never before.
  if (job.requestId) await deleteVideoFiles(job.requestId);

  const taskId = await pingKyle(job, path, originalMoved);

  await release(job.id, {
    state: "done",
    finalPath: path,
    savedAt: new Date(),
    finishedAt: new Date(),
    taskId,
    attempt: 0,
    error: null,
    errorAt: null,
    nextAttemptAt: null,
  });
  await prisma.activity
    .create({
      data: {
        projectId: job.projectId,
        type: "SYSTEM",
        body: `1080p pass finished — ${path.split("/").pop()} is in the Final folder${originalMoved ? "; the editor's export is in superseded/" : ""}.`,
      },
    })
    .catch(() => {});
  return "done";
}

/**
 * Move any earlier enhanced file for THIS cut into superseded/. Exported so
 * reviewCuts.startDropboxCopy can call it when a NEW round's original lands and
 * Topaz is off or failed — otherwise last round's 1080p file would sit in Final
 * beside the new export and Kyle would have two files to choose from.
 *
 * WHICH JOBS COUNT AS "THIS CUT" is decided by cutKeyOf, the same key the
 * Review Room, the approved-cut count and the Final-folder tidy already use —
 * never by matching (deliverableId, slot) directly. Those two columns do not
 * identify a cut: twelve production rows carry a NULL deliverableId (the folder
 * era, before cuts were tied to an order line) and they all sit on slot 1, so
 * one project has five different videos that a (null, 1) match would call the
 * same cut — and finishing one of them would have moved another client video's
 * finished 1080p file out from under a card that had already named its path.
 * For those legacy rows cutKeyOf falls back to the file path, which means a
 * previous ROUND of a legacy cut is treated as a different cut and is left
 * alone: leaving a file where it is, is the safe half of this trade.
 *
 * The cut's own job is always excluded — the caller is either finishing it or
 * has just re-copied its original, and in both cases it is the file to keep.
 */
export async function supersedePriorEnhanced(
  cut: { id: string; projectId: string; deliverableId: string | null; slot: number | null; assetPath: string | null },
): Promise<number> {
  const { cutKeyOf } = await import("@/lib/reviewCuts");
  const key = cutKeyOf(cut);
  const candidates = await prisma.topazJob.findMany({
    where: {
      projectId: cut.projectId,
      finalPath: { not: null },
      submissionId: { not: cut.id },
    },
    select: {
      id: true,
      finalPath: true,
      submission: { select: { id: true, deliverableId: true, slot: true, assetPath: true } },
    },
  });
  const prior = candidates.filter((p) => p.submission && cutKeyOf(p.submission) === key);
  let moved = 0;
  for (const p of prior) {
    if (!p.finalPath || p.finalPath.includes("/superseded/")) continue; // never nest superseded/superseded
    const folder = p.finalPath.slice(0, p.finalPath.lastIndexOf("/"));
    const name = p.finalPath.split("/").pop()!;
    await dbx("files/create_folder_v2", { path: `${folder}/superseded`, autorename: false }).catch(() => {});
    const to = `${folder}/superseded/${name}`;
    const ok = await dbx("files/move_v2", { from_path: p.finalPath, to_path: to, autorename: true })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      await prisma.topazJob.update({ where: { id: p.id }, data: { finalPath: to } }).catch(() => {});
      moved++;
    }
  }
  return moved;
}

/** The file name startDropboxCopy would have given this cut — used only when
 *  the hub does not know where the original landed. */
function derivedCutName(job: NonNullable<JobRow>): string {
  const sub = job.submission!;
  const base = sub.deliverable ? videoStyleFor(sub.deliverable).name : "Video";
  const ext = (sub.fileName ?? "").match(/\.(mp4|mov|m4v|webm|mkv)$/i)?.[0] ?? ".mp4";
  return SAFE_NAME(`${base.replace(/\s+—\s+/g, " - ")} - v${sub.round}${ext}`);
}

// ---------------------------------------------------------------------------
// F. THE PING TO KYLE.
//
// Everything he needs to finish the job by hand, in one card: the street, the
// file's name, where it is in Dropbox, and a direct link to the RIGHT Aryeo
// record (aryeoJobUrl prefers the listing and falls back to the order — an
// order-only job has no listing to open). Plus the plain truth about why this
// step is manual, so it never reads as something the hub forgot to do.
//
// Channel and etiquette are the house's, not invented here: a SmartTask on his
// queue, plus notifyInApp addressed to him by roster id rather than broadcast
// by role — addressing a PERSON is what lets his own preferences decide the
// channel, and it is also what stops the same row reaching three people.
//
// WHERE THIS ACTUALLY LANDS, stated honestly (Sep 16 review — the comment here
// used to claim Slack or a text). `topaz_ready` and `topaz_problem` are not in
// notifyPrefs' KIND_TO_EVENT, so both are BELL-ONLY, exactly like every other
// system alert in the hub ("Dropbox copy keeps failing", the cron warnings).
// That is deliberate rather than an oversight: the five switches on the
// notifications card each name a real thing a person opted into, and they carry
// an `appliesTo` contract that greys a switch out for anyone no emitter
// addresses — so folding "your 1080p file is ready" into "Job pings — footage
// landed, a revision, a review verdict" would put a live switch in front of
// Kyle that governs two unrelated things. Nothing is lost by the bell: the work
// itself arrives as a card on his queue, which is where he works, and the card
// is the thing he ticks. If Jordan later wants this to chase somebody, it wants
// its own switch on that card, not a borrowed one.
// ---------------------------------------------------------------------------
async function pingKyle(job: NonNullable<JobRow>, path: string, originalMoved: boolean): Promise<string | null> {
  const project = job.project;
  const street = streetOf(project.title);
  const fileName = path.split("/").pop() ?? "the video";
  const folder = path.slice(0, path.lastIndexOf("/"));
  const aryeo = aryeoJobUrl(project);

  const kyle = await prisma.teamMember
    .findFirst({ where: { name: { contains: "Kyle", mode: "insensitive" }, active: true }, select: { id: true } })
    .catch(() => null);

  // Jordan, Sep 16: "it just triggers a notification to kyle and says Video for
  // [Address] is ready to upload. With a download link for the video and a link
  // to that listing on the aryeo listing page." Zillow Showcase listings won't
  // take a linked video — the bytes have to be uploaded — so Kyle needs the
  // FILE, not just its folder. /api/topaz/download/<id> mints a fresh Dropbox
  // link on each press, because a pasted one expires in four hours and this
  // card can sit overnight.
  const downloadUrl = `${appBase()}/api/topaz/download/${job.id}`;

  const lines = [
    `The 1080p version of ${street} is ready to upload.`,
    ``,
    `Download it: ${downloadUrl}`,
    ``,
    `It's also in Dropbox, in this job's Final Video folder:`,
    `  ${fileName}`,
    `  ${folder}`,
    ``,
    originalMoved
      ? `That is the only video left in that folder — the editor's original is safe in the "superseded" subfolder underneath, in case it's ever needed.`
      : `Deliver the file whose name ends in "- 1080p". The editor's original is still beside it.`,
    ``,
    `Upload it to Aryeo and deliver (or re-deliver) the listing.`,
    aryeo ? `Aryeo: ${aryeo}` : `This job has no Aryeo listing or order on it, so it has to be found by address in Aryeo.`,
    ``,
    ARYEO_MANUAL_NOTE,
    ``,
    `Press Complete on this card once it's delivered — that's what tells the hub this one is finished.`,
  ];

  const data = {
    taskType: "internal_instruction", // the type Open Loops + /tasks triage read
    title: `Upload the 1080p video to Aryeo — ${street}`.slice(0, 120),
    summary: `${fileName} is ready to upload to Aryeo. Download it: ${downloadUrl} — it is also in this job's Final Video folder on Dropbox. ${ARYEO_MANUAL_NOTE}`.slice(0, 500),
    description: lines.join("\n"),
    reasonCreated: "The approved cut finished its 1080p pass",
    source: "system",
    sourceDetail: aryeo ?? path,
    priority: "HIGH" as const,
    assignedKey: "kyle",
    ownerId: kyle?.id ?? null,
    projectId: job.projectId,
    clientId: project.clientId,
    propertyAddress: project.title,
    deliverableType: "Video",
    dedupeKey: `topaz-deliver-${job.id}`,
  };

  let taskId: string | null = null;
  try {
    const row = await prisma.smartTask.upsert({
      where: { dedupeKey: data.dedupeKey },
      create: data,
      // One job, one card. A re-run of this step must refresh the card, never
      // reopen one Kyle has already ticked off.
      update: { title: data.title, summary: data.summary, description: data.description, sourceDetail: data.sourceDetail },
      select: { id: true },
    });
    taskId = row.id;
  } catch { /* the bell below still reaches him */ }

  try {
    const { notifyInApp } = await import("@/lib/notify");
    const href = taskId ? `/tasks?task=${taskId}` : `/projects/${job.projectId}`;
    await notifyInApp({
      kind: "topaz_ready",
      title: `1080p video ready to upload — ${street}`,
      body: `${fileName} is in the job's Final Video folder. Aryeo can't be uploaded to automatically — this one's by hand.`,
      href,
      // Kyle by roster id rather than by role, so one person gets one row and
      // his own preferences get the chance to decide the channel. Today that
      // decision is "the bell", because this kind is unclassified — see the
      // block above pingKyle for why that is deliberate and what it costs
      // (nothing: the work itself arrives as a card on his queue).
      targets: kyle
        ? [{ roles: ["ADMIN"], userKey: `tm:${kyle.id}`, href }, { roles: ["OWNER"], href }]
        : [{ roles: ["ADMIN"], href }, { roles: ["OWNER"], href }],
      dedupeKey: `topaz-ready-${job.id}`,
    });
  } catch { /* bell is best-effort */ }
  return taskId;
}

// ---------------------------------------------------------------------------
// THE CRON ENTRY POINT.
// ---------------------------------------------------------------------------

export type DriveResult = {
  skipped?: string;
  claimed: number;
  advanced: Record<string, number>;
  swept?: number;
};

/** One driver tick: sweep expired leases, claim what is due, advance each one
 *  step. Safe to run from two crons at once — the lease is the only thing that
 *  decides who works on what. */
export async function driveTopazJobs(opts: { max?: number; budgetMs?: number; leaseBy?: string } = {}): Promise<DriveResult> {
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? 240_000;
  const budget = { remainingMs: () => Math.max(0, budgetMs - (Date.now() - startedAt)) };

  const s = await topazSettings().catch(() => null);
  if (!s) return { claimed: 0, advanced: {}, skipped: "settings unreadable" };

  // A job whose driver was hard-killed mid-step: the lease has expired, so the
  // row is claimable again. Nothing to do here but count it — claimTopazJobs
  // picks it up in the same tick.
  const swept = await prisma.topazJob.count({
    where: { state: { in: LIVE_STATES }, leaseUntil: { lt: new Date() } },
  });

  const ids = await claimTopazJobs(opts.max ?? 4, opts.leaseBy ?? `tick-${new Date().toISOString()}`);
  const advanced: Record<string, number> = {};
  for (const id of ids) {
    if (budget.remainingMs() < 30_000) {
      await release(id); // hand it back rather than half-do it
      continue;
    }
    const state = await advanceTopazJob(id, budget).catch((e) => {
      console.warn("advanceTopazJob threw", (e as Error).message);
      return "error";
    });
    advanced[state] = (advanced[state] ?? 0) + 1;
  }
  return { claimed: ids.length, advanced, swept };
}

// ---------------------------------------------------------------------------
// OWNER CONTROLS + READS (G) — the interface the Topaz UI is built against.
// ---------------------------------------------------------------------------

/** Stop a job that is stuck or that Jordan has changed his mind about. Cancels
 *  at Topaz too, because the point is to stop paying for it. */
export async function cancelTopazJob(jobId: string, by?: string | null): Promise<{ ok: boolean; message: string }> {
  const job = await prisma.topazJob.findUnique({ where: { id: jobId }, select: { id: true, state: true, requestId: true } });
  if (!job) return { ok: false, message: "That 1080p job no longer exists." };
  if (!LIVE_STATES.includes(job.state as TopazState)) return { ok: false, message: "That one has already finished." };
  if (job.requestId) await cancelVideoRequest(job.requestId);
  await prisma.topazJob.update({
    where: { id: jobId },
    data: { state: "cancelled", finishedAt: new Date(), leaseUntil: null, leaseBy: null, nextAttemptAt: null, error: by ? `Stopped by ${by}.` : "Stopped by hand." },
  });
  return { ok: true, message: "Stopped. Nothing more will be charged for that video." };
}

/**
 * Put a failed or skipped job back in the queue.
 *
 * DELIBERATELY NOT AUTOMATIC, and deliberately not a fresh job: it reuses the
 * same row, so the one-render-per-cut constraint still holds.
 *
 * WHAT THIS BUTTON MUST NOT BE (Sep 16 review). It used to send anything that
 * already had a Topaz request straight to `estimated`, which skipped the free
 * price check and the per-video ceiling entirely — so the button sitting
 * directly under "this would cost about 96 credits and the limit is 20" bought
 * the 96-credit render on one click, from anyone with admin access, with no
 * price on the button and no confirmation. And a job that failed because the
 * price could not be read at all retried with no price, which put it past the
 * balance check and out of the monthly credit total as well.
 *
 * So there are exactly two resumptions, and the line between them is whether
 * money has been committed:
 *   · complete-upload already claimed → the credits are spent, and the only
 *     honest thing to do is ask Topaz what became of that render;
 *   · anything else → nothing has been spent, so it goes ALL THE WAY BACK to
 *     the start. The free estimate runs again and every guard applies again.
 *     Trying again is free by construction, not by promise.
 */
export async function retryTopazJob(jobId: string): Promise<{ ok: boolean; message: string }> {
  const job = await prisma.topazJob.findUnique({ where: { id: jobId }, select: { id: true, state: true, requestId: true, completeUploadAt: true, acceptedAt: true } });
  if (!job) return { ok: false, message: "That 1080p job no longer exists." };
  if (LIVE_STATES.includes(job.state as TopazState)) return { ok: false, message: "That one is already on its way." };
  if (job.state === "done") return { ok: false, message: "That video already went through." };

  if (job.completeUploadAt) {
    await prisma.topazJob.update({
      where: { id: jobId },
      data: { state: "processing", attempt: 0, error: null, errorAt: null, skipReason: null, nextAttemptAt: null, finishedAt: null, leaseUntil: null, leaseBy: null },
    });
    return { ok: true, message: "Back in the queue — that one was already paid for, so we'll ask Topaz what happened to it rather than start again." };
  }

  // Hand the old request back first, so the one we stop tracking isn't left
  // holding anything at Topaz. WHICH cancel matters: an ACCEPTED request can be
  // holding a reservation — their balance endpoint reports reserved_credits
  // alongside available ones — and an abandoned reservation is headroom Jordan
  // paid for and cannot use. An estimate that was never accepted holds nothing,
  // and its own cancel is the right call for it. Both are free and both are
  // best-effort: if neither lands, the request expires unaccepted on Topaz's
  // side and nothing is charged either way.
  if (job.requestId) {
    if (job.acceptedAt) await cancelVideoRequest(job.requestId);
    else await cancelEstimate(job.requestId);
  }
  await prisma.topazJob.update({
    where: { id: jobId },
    data: {
      state: "queued",
      // Back to a clean sheet: a new request id, a new price, a new decision.
      requestId: null,
      estimateCredits: null,
      estimateSeconds: null,
      acceptedAt: null, // this job leaves the month's ledger until it re-commits
      uploadUrlsJson: null,
      uploadPartsJson: null,
      uploadedBytes: null,
      // Safe to zero ONLY on this branch: we are here because complete-upload
      // was never claimed, so the count belongs to a request we are abandoning
      // rather than to any render that could still be running.
      completeUploadAt: null,
      completeUploadTries: 0,
      attempt: 0,
      error: null,
      errorAt: null,
      skipReason: null,
      nextAttemptAt: null,
      finishedAt: null,
      leaseUntil: null,
      leaseBy: null,
    },
  });
  return { ok: true, message: "Back in the queue. It starts again from the free price check, so every limit you've set still applies to it." };
}

/** Kyle's one tap after he has uploaded it to Aryeo: closes the card and closes
 *  the loop in the hub. */
export async function markTopazDelivered(jobId: string, by?: string | null): Promise<{ ok: boolean; message: string }> {
  const job = await prisma.topazJob.findUnique({ where: { id: jobId }, select: { id: true, taskId: true, projectId: true, deliveredAt: true, finalPath: true } });
  if (!job) return { ok: false, message: "That 1080p job no longer exists." };
  if (job.deliveredAt) return { ok: true, message: "Already marked delivered." };
  await prisma.topazJob.update({ where: { id: jobId }, data: { deliveredAt: new Date(), deliveredBy: by ?? null } });
  if (job.taskId) {
    await prisma.smartTask
      .updateMany({ where: { id: job.taskId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: new Date() } })
      .catch(() => {});
  }
  await prisma.activity
    .create({ data: { projectId: job.projectId, type: "SYSTEM", body: `1080p video uploaded to Aryeo and delivered${by ? ` by ${by}` : ""} — ${job.finalPath?.split("/").pop() ?? "video"}.` } })
    .catch(() => {});
  return { ok: true, message: "Marked delivered." };
}

export type TopazJobView = {
  id: string;
  submissionId: string;
  projectId: string;
  street: string;
  fileName: string | null;
  state: TopazState | string;
  /** One sentence a non-technical owner can read without asking anybody. */
  says: string;
  estimateCredits: number | null;
  creditsCharged: number | null;
  sourceLabel: string | null;
  outputLabel: string | null;
  durationSec: number | null;
  finalPath: string | null;
  error: string | null;
  skipReason: string | null;
  deliveredAt: Date | null;
  taskId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  nextAttemptAt: Date | null;
};

/** Plain English for every state. No jargon, and always what happens next. */
export function topazSays(j: {
  state: string;
  error?: string | null;
  skipReason?: string | null;
  deliveredAt?: Date | null;
  estimateCredits?: number | null;
}): string {
  switch (j.state) {
    case "queued":
      // `error` on a queued row is always a WAIT reason — a cap, a busy lane, a
      // balance we couldn't read — never a failure. Frame it that way.
      return j.error ? `Waiting — ${j.error}` : "Waiting its turn.";
    case "estimated":
      return j.estimateCredits
        ? `Ready to send — about ${Math.round(j.estimateCredits)} credits.`
        : "Ready to send.";
    case "uploading":
      return "Sending the video to Topaz.";
    case "processing":
      return "Topaz is working on it.";
    case "saving":
      return "Putting the finished video into Dropbox.";
    case "done":
      return j.deliveredAt ? "Done and delivered in Aryeo." : "Done — waiting for Kyle to upload it to Aryeo.";
    case "failed":
      return j.error ?? "It didn't finish.";
    case "skipped":
      return j.skipReason ?? "This one was left out.";
    case "cancelled":
      return j.error ?? "Stopped by hand.";
    default:
      return j.state;
  }
}

const res = (w?: number | null, h?: number | null) => (w && h ? `${w}×${h}` : null);

export async function topazJobRows(opts: { limit?: number; projectId?: string; states?: string[] } = {}): Promise<TopazJobView[]> {
  const rows = await prisma.topazJob.findMany({
    where: {
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.states?.length ? { state: { in: opts.states } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
    include: { project: { select: { title: true } } },
  });
  return rows.map(toView);
}

type JobWithProject = Awaited<ReturnType<typeof prisma.topazJob.findMany>>[number] & { project?: { title: string | null } | null };

function toView(j: JobWithProject): TopazJobView {
  return {
    id: j.id,
    submissionId: j.submissionId,
    projectId: j.projectId,
    street: streetOf(j.project?.title),
    fileName: j.finalPath?.split("/").pop() ?? j.fileName,
    state: j.state,
    says: topazSays(j),
    estimateCredits: j.estimateCredits,
    creditsCharged: j.creditsCharged,
    sourceLabel: res(j.sourceWidth, j.sourceHeight),
    outputLabel: res(j.outputWidth, j.outputHeight),
    durationSec: j.sourceDurationSec,
    finalPath: j.finalPath,
    error: j.error,
    skipReason: j.skipReason,
    deliveredAt: j.deliveredAt,
    taskId: j.taskId,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
    nextAttemptAt: j.nextAttemptAt,
  };
}

/** The 1080p pass for one cut — what the Review Room and /edit show beside it. */
export async function topazJobForSubmission(submissionId: string): Promise<TopazJobView | null> {
  const j = await prisma.topazJob.findUnique({
    where: { submissionId },
    include: { project: { select: { title: true } } },
  });
  return j ? toView(j) : null;
}

export type TopazDashboard = {
  connected: boolean;
  enabled: boolean;
  /** null when Topaz couldn't be reached — the card should say so, not show 0. */
  balance: TopazBalanceView | null;
  balanceError: string | null;
  today: { renders: number; cap: number };
  month: { renders: number; cap: number; credits: number; creditCap: number };
  inFlight: number;
  concurrencyCap: number;
  waitingOnKyle: number;
  recentFailures: number;
  settings: TopazSettings;
  /** The sentence that must appear wherever this pipeline is explained. */
  aryeoNote: string;
};
export type TopazBalanceView = { available: number; reserved: number; total: number };

/** Everything Jordan needs to answer "is this working and what is it costing
 *  me" without asking anybody. */
export async function topazDashboard(): Promise<TopazDashboard> {
  const s = await topazSettings();
  const connected = await topazConnected();
  const { dayStart, monthStart } = etWindows();

  let balance: TopazBalanceView | null = null;
  let balanceError: string | null = null;
  if (connected) {
    try {
      const b = await topazBalance();
      balance = { available: Math.round(b.available_credits), reserved: Math.round(b.reserved_credits), total: Math.round(b.total_credits) };
    } catch (e) {
      balanceError = (e as Error).message;
    }
  }

  const [today, monthRenders, monthCredits, inFlight, waitingOnKyle, recentFailures] = await Promise.all([
    prisma.topazJob.count({ where: { acceptedAt: { gte: dayStart } } }),
    prisma.topazJob.count({ where: { acceptedAt: { gte: monthStart } } }),
    // WHAT THIS MONTH HAS COST, per job and then added up — never two whole-
    // column sums with one picked over the other. It was `sum(creditsCharged)
    // ?? sum(estimateCredits)`, which meant the moment ONE job came back with a
    // real charge, every job that hadn't dropped silently out of the total and
    // the number under-reported what Jordan had spent. Each job answers for
    // itself: what Topaz charged if it has said, otherwise what we committed.
    prisma.topazJob.findMany({ where: { acceptedAt: { gte: monthStart } }, select: { creditsCharged: true, estimateCredits: true } }),
    prisma.topazJob.count({ where: { state: { in: LIVE_STATES } } }),
    prisma.topazJob.count({ where: { state: "done", deliveredAt: null } }),
    prisma.topazJob.count({ where: { state: "failed", errorAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } } }),
  ]);

  return {
    connected,
    enabled: s.enabled,
    balance,
    balanceError,
    today: { renders: today, cap: s.maxRendersPerDay },
    month: {
      renders: monthRenders,
      cap: s.maxRendersPerMonth,
      // What it really cost when Topaz said, and what we committed when it
      // didn't — never a number we invented.
      credits: Math.round(monthCredits.reduce((n, j) => n + (j.creditsCharged ?? j.estimateCredits ?? 0), 0)),
      creditCap: s.maxCreditsPerMonth,
    },
    inFlight,
    concurrencyCap: s.maxConcurrent,
    waitingOnKyle,
    recentFailures,
    settings: s,
    aryeoNote: ARYEO_MANUAL_NOTE,
  };
}
